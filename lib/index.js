/**
 * dsh-utils host plugin.
 *
 * Mounts two Typert Remote services:
 *
 * 1. `opencodeUsage` — fetch the opencode usage report (rolling/weekly/monthly
 *    percent) for the active model provider. The API key is NEVER baked into
 *    this package: per call it is resolved from the live model configuration
 *    (`llm-pi-ai` settings namespace `providers.<provider>.apiKeyEnv` — the
 *    same configuration the model route itself uses), then through the
 *    harness credential seam, then the environment variable of that name.
 *    An explicit `apiKey` / `endpoint` plugin-config override exists for
 *    unusual deployments.
 *
 * 2. `workspaceFiles` — workspace file management for the web GUI: list
 *    registered workspaces, list directories, read / write / delete files,
 *    and search file names. Every operation is gated: the root must be a
 *    registered workspace (or a directory inside one) and relative paths are
 *    traversal-guarded (symlink-safe), so the browser can only ever touch
 *    files under registered workspace roots. The gate/path-safety pattern
 *    follows the dsh-web-ui panel (BSD-3-Clause, zhu1090093659).
 *
 * The client half ships in the same package (`./client`); the web server
 * serves it under /plugins/dsh-utils/client.js.
 */
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { cp, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, delimiter, dirname, join, relative } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { Agent, fetch as undiciFetch } from 'undici'

/** Stable Cordis plugin name (the Loader entry and client bundle id). */
export const name = 'dsh-utils'

/** Services required before load: the Typert registry. */
export const inject = ['typert']

/** The default opencode usage endpoint. */
export const USAGE_ENDPOINT = 'https://opencode.ai/zen/go/v1/usage'

/** Settings namespace owned by the llm-pi-ai model route. */
export const LLM_PI_AI_NS = settingsNamespace('llm-pi-ai')

/** Preview text ceiling. */
export const TEXT_CAP_CHARS = 200_000

/** Filename-search caps (results and scanned entries). */
const SEARCH_HIT_CAP = 200
const SEARCH_SCAN_CAP = 20_000

/** Directories skipped by search / never listed in the tree. */
const SEARCH_SKIP_DIRS = new Set(['.git', 'node_modules'])
const TREE_SKIP_DIRS = new Set(['.git'])

/** Image preview cap (data URL payload budget). */
export const IMAGE_CAP_BYTES = 8 << 20

/** Image extensions previewed as data URLs. */
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif'])

/** Whether a relative path points at a previewable image. */
function isImagePath(rel) {
  const dot = rel.lastIndexOf('.')
  if (dot <= 0) return false
  return IMAGE_EXTS.has(rel.slice(dot + 1).toLowerCase())
}

/** Mime type for an image read, from the extension with magic-byte fallback. */
function imageMime(rel, data) {
  const ext = rel.split('.').pop()?.toLowerCase() ?? ''
  const byExt = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', avif: 'image/avif', bmp: 'image/bmp',
  }
  if (byExt[ext]) return byExt[ext]
  if (data.length >= 3 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e) return 'image/png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8) return 'image/jpeg'
  return 'application/octet-stream'
}

/** Fetch attempts and backoff for the usage endpoint. */
const USAGE_ATTEMPTS = 3
const USAGE_TIMEOUT_MS = 30_000

/**
 * Keep-alive agent for the usage endpoint. The machine's DNS is proxied
 * (fake-ip), where establishing a fresh TCP connection is slow (~10s) while
 * pooled connections answer in ~350ms; undici's default 4s keep-alive would
 * re-pay that cost on every poll, so hold the pool open and allow generous
 * connect/header/body timeouts.
 */
const usageAgent = new Agent({
  keepAliveTimeout: 600_000,
  keepAliveMaxTimeout: 3_600_000,
  connect: { timeout: 30_000 },
  headersTimeout: 30_000,
  bodyTimeout: 30_000,
})

/**
 * Passthrough wire codec. The strict Typert registry only requires
 * `codec.schema.parse` to be a function; payloads are validated structurally
 * in the client before display, so the wire schemas stay open.
 */
const passSchema = { parse: (value) => value }

/** One JSON parameter descriptor (passthrough codec). */
function jsonParam(name, acceptsUndefined = false) {
  return {
    name,
    wire: name,
    source: 'json',
    ...acceptsUndefined ? { acceptsUndefined: true } : {},
    codec: { mode: 'strict', typeSymbol: `dsh-utils#${name}`, schema: passSchema },
  }
}

/** A domain error that crosses the wire as `{ ok:false, error }` with its code in the message. */
export class PanelError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`)
    this.name = 'PanelError'
    this.code = code
  }
}

/** Normalize a path for prefix comparison (forward slashes; case-insensitive on win32). */
function normalizeForPrefix(value) {
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** Whether `child` lives inside (or equals) `root`; separator- and case-robust. */
export function isPathInside(root, child) {
  if (root === '' || child === '') return false
  const normRoot = normalizeForPrefix(root)
  const normChild = normalizeForPrefix(child)
  if (normChild === normRoot) return true
  return normChild.startsWith(`${normRoot}/`)
}

/** True when the relative path is, or passes through, a .git component. */
function isGitPath(rel) {
  return rel.split('/').some((part) => part.toLowerCase() === '.git')
}

/**
 * Remove a path into the OS recycle bin on Windows (via the VisualBasic
 * FileSystem API over PowerShell), or permanently on other platforms.
 * @param abs - absolute path to remove.
 * @param isDirectory - whether the path is a directory.
 * @throws PanelError when removal fails.
 */
export async function recycleRemove(abs, isDirectory) {
  if (process.platform === 'win32') {
    const escaped = abs.replace(/'/g, "''")
    const method = isDirectory ? 'DeleteDirectory' : 'DeleteFile'
    const script =
      `Add-Type -AssemblyName Microsoft.VisualBasic; ` +
      `[Microsoft.VisualBasic.FileIO.FileSystem]::${method}('${escaped}', 'OnlyErrorDialogs', 'SendToRecycleBin')`
    const result = spawnSync('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
      encoding: 'utf8',
      timeout: 20_000,
      windowsHide: true,
    })
    if (result.error !== undefined) {
      throw new PanelError('write-failed', `recycle bin unavailable: ${result.error.message}`)
    }
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || '').trim().slice(0, 200)
      throw new PanelError('write-failed', `recycle bin refused: ${detail || `exit ${result.status}`}`)
    }
    return
  }
  await rm(abs, { recursive: true, force: true })
}

/**
 * Resolve a command name through PATH (plus the WindowsApps alias directory
 * that store-installed terminal emulators like Windows Terminal live in).
 * @param name - bare executable name, e.g. `wt` or `gnome-terminal`.
 * @returns an absolute path, or null when the command is not found.
 */
function resolveExecutable(name) {
  const names = process.platform === 'win32' ? [name, `${name}.exe`, `${name}.cmd`, `${name}.bat`] : [name]
  const dirs = (process.env.PATH || '').split(delimiter).filter((dir) => dir !== '')
  if (process.platform === 'win32' && process.env.LOCALAPPDATA !== undefined) {
    dirs.push(join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps'))
  }
  for (const dir of dirs) {
    for (const candidate of names) {
      try {
        if (existsSync(join(dir, candidate))) return join(dir, candidate)
      } catch {
        // unreadable dir entry: keep scanning
      }
    }
  }
  return null
}

/** Double-quote a string for a POSIX shell command line. */
function shQuote(value) {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * Build the ordered candidates that open a terminal window in `dir`.
 * Pure and exported so tests can inspect it without launching anything.
 * @param dir - absolute directory to open.
 * @returns `[{ label, file, args, cwd }...]` best-first; never empty on
 *   win32 (legacy console fallback always applies) but may be empty on
 *   other platforms when no terminal emulator is installed.
 */
export function terminalCandidates(dir) {
  if (process.platform === 'win32') {
    // Windows Terminal first: it is an app-execution alias (a reparse point)
    // that PATH-based existence checks cannot see, so it is attempted by bare
    // name and the spawn-failure fallback chain below moves on to cmd when it
    // is not installed / not resolvable from this process' PATH.
    return [
      { label: 'Windows Terminal', file: 'wt.exe', args: ['-d', dir], cwd: dir },
      // Legacy console: `start` a new cmd /k window; its working directory is
      // inherited from cwd, so no path quoting is needed.
      { label: 'cmd', file: process.env.ComSpec || 'cmd.exe', args: ['/c', 'start', '', 'cmd', '/k'], cwd: dir },
    ]
  }
  if (process.platform === 'darwin') {
    return [{
      label: 'Terminal.app',
      file: 'osascript',
      args: ['-e', `tell application "Terminal" to do script "cd ${shQuote(dir)}"`],
      cwd: dir,
    }]
  }
  const found = []
  const candidates = [
    ['gnome-terminal', ['--working-directory=' + dir]],
    ['konsole', ['--workdir', dir]],
    ['xfce4-terminal', ['--working-directory=' + dir]],
    ['alacritty', ['--working-directory', dir]],
    ['kitty', ['-d', dir]],
    ['x-terminal-emulator', ['-e', 'bash']],
    ['xterm', ['-e', 'bash']],
  ]
  for (const [name, args] of candidates) {
    const file = resolveExecutable(name)
    if (file !== null) found.push({ label: name, file, args, cwd: dir })
  }
  return found
}

/**
 * Spawn one candidate detached (own console on Windows) and resolve once it
 * is up; rejects on spawn failure so callers can fall through.
 */
function spawnDetached(candidate) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(candidate.file, candidate.args, { cwd: candidate.cwd, detached: true, stdio: 'ignore' })
    } catch (error) {
      reject(error)
      return
    }
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

/**
 * Open a terminal window in `dir`, trying candidates in order.
 * @param dir - absolute directory to open.
 * @param spawnImpl - injectable spawner for tests (defaults to spawnDetached).
 * @param candidates - injectable candidate list for tests (defaults to
 *   terminalCandidates(dir)).
 * @returns the label of the terminal that launched.
 * @throws PanelError('launch-failed') when no candidate could be launched.
 */
export async function launchTerminal(dir, spawnImpl = spawnDetached, candidates = terminalCandidates(dir)) {
  let lastError = null
  for (const candidate of candidates) {
    try {
      await spawnImpl(candidate)
      return candidate.label
    } catch (error) {
      lastError = error
    }
  }
  const detail = lastError !== null ? `: ${String(lastError.message || lastError)}` : ' (no terminal emulator found)'
  throw new PanelError('launch-failed', `cannot open a terminal${detail}`)
}

/** Case-insensitive alpha compare (dirs first, then files). */
function compareEntries(a, b) {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
  const an = a.name.toLowerCase()
  const bn = b.name.toLowerCase()
  return an < bn ? -1 : an > bn ? 1 : 0
}

/**
 * Canonicalize the requested project root and require it to be a registered
 * workspace path (or a subdirectory of one) — the security boundary of every
 * workspaceFiles operation.
 * @param ctx - owning cordis context (workspace service optional).
 * @param root - the root the client reports.
 * @returns the canonical root.
 */
export async function gateRoot(ctx, root) {
  if (typeof root !== 'string' || root === '') {
    throw new PanelError('workspace-unknown', 'empty project root')
  }
  let canonical
  try {
    canonical = await realpath(root)
  } catch {
    throw new PanelError('workspace-unknown', 'path does not resolve on disk')
  }
  const registry = ctx.get('workspaceRegistry')
  const workspaces = registry !== undefined && typeof registry.list === 'function' ? registry.list() : []
  for (const workspace of workspaces) {
    if (isPathInside(workspace.path, canonical)) return canonical
  }
  throw new PanelError('workspace-unknown', 'path is not inside a registered workspace')
}

/**
 * Resolve a relative path against the canonical root, realpath-checking the
 * existing ancestors so a symlink cannot smuggle the operation outside the
 * root. A path that does not yet exist is verified through its nearest
 * existing ancestor.
 * @param root - canonical workspace root.
 * @param rel - relative path ('' = root).
 * @returns the absolute path.
 */
export async function resolveInsideRoot(root, rel) {
  if (typeof rel !== 'string' || rel.includes('\0')) {
    throw new PanelError('path-outside-root', 'invalid path')
  }
  const abs = join(root, rel)
  if (!isPathInside(root, abs)) {
    throw new PanelError('path-outside-root', `path escapes root: ${rel}`)
  }
  let probe = abs
  for (let hop = 0; hop < 32; hop += 1) {
    let real
    try {
      real = await realpath(probe)
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
      if (code !== 'ENOENT') return abs
      const parent = dirname(probe)
      if (parent === probe) return abs
      probe = parent
      continue
    }
    if (!isPathInside(root, real)) {
      throw new PanelError('path-outside-root', `path resolves outside root: ${rel}`)
    }
    return abs
  }
  throw new PanelError('path-outside-root', 'path cannot be resolved')
}

// ── opencodeUsage remote ────────────────────────────────────────────────────

/** The opencodeUsage Remote namespace's strict invocation descriptors. */
export const OPENCODE_USAGE_INVOCATIONS = [
  {
    id: 'dsh-utils#opencodeUsage/usage',
    service: 'opencodeUsage',
    namespace: 'opencodeUsage',
    method: 'usage',
    invocation: { kind: 'direct' },
    parameters: [jsonParam('provider')],
    cancellation: { parameter: 'signal' },
    result: { mode: 'strict', typeSymbol: 'dsh-utils#UsageReport', schema: passSchema },
  },
]

/** The opencodeUsage service member of the host manifest. */
const OPENCODE_USAGE_SERVICE = {
  key: 'opencodeUsage',
  exportName: 'OpencodeUsageRuntime',
  description: 'Read the opencode usage report (rolling/weekly/monthly percent) for one model provider.',
  tags: [],
  members: [
    {
      kind: 'method',
      name: 'usage',
      signature: 'usage(provider: string, signal?: AbortSignal): Promise<UsageReport>',
    },
  ],
  types: [],
}

/**
 * Read the API-key reference a model provider declares in the `llm-pi-ai`
 * settings namespace — the same `providers.<provider>.apiKeyEnv` the model
 * route itself uses. Nothing opencode-specific is baked in: any provider
 * entry with an `apiKeyEnv` works.
 * @param ctx - owning cordis context.
 * @param providerId - the model provider id the client reports.
 * @returns the credential reference name, or undefined when the provider
 *   declares none.
 */
export function providerApiKeyReference(ctx, providerId) {
  const settings = ctx.get('settings')
  if (settings === undefined) return undefined
  try {
    const section = settings.get(LLM_PI_AI_NS)
    if (section == null || typeof section !== 'object') return undefined
    const providers = section.providers
    if (providers == null || typeof providers !== 'object') return undefined
    const entry = providers[providerId]
    if (entry == null || typeof entry !== 'object') return undefined
    if (typeof entry.apiKeyEnv === 'string' && entry.apiKeyEnv.length > 0) return entry.apiKeyEnv
  } catch {
    // the llm-pi-ai namespace is not registered — treat as no reference
  }
  return undefined
}

/**
 * Resolve the API key for one provider, per call: plugin-config override,
 * then the provider's declared `apiKeyEnv` reference through the harness
 * credential seam, then the environment variable of that name.
 * @param ctx - owning cordis context (services are optional).
 * @param config - resolved plugin configuration.
 * @param providerId - the model provider id the client reports.
 * @returns the bearer key.
 * @throws when no key can be resolved, naming the exact configuration to fix.
 */
export async function resolveApiKey(ctx, config, providerId) {
  if (config?.apiKey != null && typeof config.apiKey === 'string' && config.apiKey.length > 0) {
    return config.apiKey
  }
  const reference = providerApiKeyReference(ctx, providerId)
  if (reference === undefined) {
    throw new Error(
      `dsh-utils: provider "${providerId}" declares no apiKeyEnv under llm-pi-ai.providers in the settings document — add it there (the web Models page writes it) or set the plugin config apiKey`,
    )
  }
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    try {
      const hit = await credentials.resolve(credentialRef(reference))
      if (hit != null && typeof hit.value === 'string' && hit.value.length > 0) return hit.value
    } catch {
      // fall through to the ambient environment
    }
  }
  const ambient = process.env[reference]
  if (typeof ambient === 'string' && ambient.length > 0) return ambient
  throw new Error(
    `dsh-utils: no value for "${reference}" (llm-pi-ai.providers.${providerId}.apiKeyEnv) — store it through the harness credentials (the web Models page) or set the environment variable`,
  )
}

/**
 * Fetch the usage report from the opencode usage endpoint, retrying transient
 * connect failures. On proxied/fake-ip networks the first TCP connection is
 * slow and frequently times out, while the retry on the pooled connection
 * answers in hundreds of milliseconds.
 * @param apiKey - bearer key.
 * @param endpoint - the usage endpoint (config override or the default).
 * @param signal - caller lifetime; an abort rejects the fetch immediately.
 * @returns the `usage` object (`{ rolling, weekly, monthly }`).
 */
export async function fetchUsageReport(apiKey, endpoint, signal) {
  let lastError
  for (let attempt = 0; attempt < USAGE_ATTEMPTS; attempt += 1) {
    const timeoutSignal = AbortSignal.timeout(USAGE_TIMEOUT_MS)
    const combined = signal !== undefined ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    try {
      const response = await undiciFetch(endpoint, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: combined,
        dispatcher: usageAgent,
      })
      if (!response.ok) {
        throw new Error(`opencode usage endpoint responded HTTP ${response.status}`)
      }
      const body = await response.json()
      const usage = body != null && typeof body === 'object' ? body.usage : undefined
      if (usage == null || typeof usage !== 'object') {
        throw new Error('opencode usage endpoint returned no usage object')
      }
      // The endpoint occasionally answers with an empty/incomplete usage
      // structure; treat it like a failed fetch (retry / stale fallback)
      // instead of surfacing meaningless "?" values to the badge.
      for (const key of ['rolling', 'weekly', 'monthly']) {
        const entry = usage[key]
        if (entry == null || typeof entry !== 'object' || typeof entry.percent !== 'number' || typeof entry.resetsAt !== 'string') {
          throw new Error(`opencode usage endpoint returned an incomplete "${key}" window`)
        }
      }
      return usage
    } catch (error) {
      if (signal !== undefined && signal.aborted === true) throw error
      lastError = error
      if (attempt < USAGE_ATTEMPTS - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
      }
    }
  }
  throw lastError
}

/** The opencodeUsage Remote service: one usage report per provider. */
export class OpencodeUsageRuntime extends TypertRemoteService {
  /**
   * Register the service under the `opencodeUsage` key (the wire namespace).
   * @param ctx - owning cordis context.
   * @param config - resolved plugin configuration.
   */
  constructor(ctx, config) {
    super(ctx, 'opencodeUsage')
    this.config = config ?? {}
    /** Last successful report per provider; served stale when the fetch fails. */
    this.lastOk = undefined
  }

  /**
   * Read the current usage report for one model provider.
   * @param provider - the model provider id the client reports.
   * @param signal - caller lifetime; an abort rejects the fetch.
   * @returns the `{ rolling, weekly, monthly }` usage report (with `stale:
   *   true` when the fetch failed and the last successful report is served).
   */
  async usage(provider, signal) {
    const apiKey = await resolveApiKey(this.ctx, this.config, provider)
    const endpoint = this.config?.endpoint != null && typeof this.config.endpoint === 'string' && this.config.endpoint.length > 0
      ? this.config.endpoint
      : USAGE_ENDPOINT
    try {
      const usage = await fetchUsageReport(apiKey, endpoint, signal)
      this.lastOk = { provider, usage }
      return usage
    } catch (error) {
      if (this.lastOk !== undefined && this.lastOk.provider === provider) {
        return { ...this.lastOk.usage, stale: true }
      }
      throw error
    }
  }
}

// ── workspaceFiles remote ────────────────────────────────────────────────────

/** The workspaceFiles Remote namespace's strict invocation descriptors. */
export const WORKSPACE_FILES_INVOCATIONS = [
  {
    id: 'dsh-utils#workspaceFiles/workspaces',
    service: 'workspaceFiles',
    namespace: 'workspaceFiles',
    method: 'workspaces',
    invocation: { kind: 'direct' },
    parameters: [],
    cancellation: { parameter: 'signal' },
    result: { mode: 'strict', typeSymbol: 'dsh-utils#WorkspaceList', schema: passSchema },
  },
  {
    id: 'dsh-utils#workspaceFiles/list',
    service: 'workspaceFiles',
    namespace: 'workspaceFiles',
    method: 'list',
    invocation: { kind: 'direct' },
    parameters: [jsonParam('root'), jsonParam('rel')],
    cancellation: { parameter: 'signal' },
    result: { mode: 'strict', typeSymbol: 'dsh-utils#DirListing', schema: passSchema },
  },
  {
    id: 'dsh-utils#workspaceFiles/read',
    service: 'workspaceFiles',
    namespace: 'workspaceFiles',
    method: 'read',
    invocation: { kind: 'direct' },
    parameters: [jsonParam('root'), jsonParam('rel')],
    cancellation: { parameter: 'signal' },
    result: { mode: 'strict', typeSymbol: 'dsh-utils#FileRead', schema: passSchema },
  },
  {
    id: 'dsh-utils#workspaceFiles/write',
    service: 'workspaceFiles',
    namespace: 'workspaceFiles',
    method: 'write',
    invocation: { kind: 'direct' },
    parameters: [jsonParam('root'), jsonParam('rel'), jsonParam('content'), jsonParam('baseMtime', true)],
    cancellation: { parameter: 'signal' },
    result: { mode: 'strict', typeSymbol: 'dsh-utils#WriteResult', schema: passSchema },
  },
  {
    id: 'dsh-utils#workspaceFiles/delete',
    service: 'workspaceFiles',
    namespace: 'workspaceFiles',
    method: 'delete',
    invocation: { kind: 'direct' },
    parameters: [jsonParam('root'), jsonParam('rel')],
    cancellation: { parameter: 'signal' },
    result: { mode: 'strict', typeSymbol: 'dsh-utils#DeleteResult', schema: passSchema },
  },
  {
    id: 'dsh-utils#workspaceFiles/move',
    service: 'workspaceFiles',
    namespace: 'workspaceFiles',
    method: 'move',
    invocation: { kind: 'direct' },
    parameters: [jsonParam('root'), jsonParam('from'), jsonParam('to')],
    cancellation: { parameter: 'signal' },
    result: { mode: 'strict', typeSymbol: 'dsh-utils#MoveResult', schema: passSchema },
  },
  {
    id: 'dsh-utils#workspaceFiles/openTerminal',
    service: 'workspaceFiles',
    namespace: 'workspaceFiles',
    method: 'openTerminal',
    invocation: { kind: 'direct' },
    parameters: [jsonParam('root'), jsonParam('rel')],
    cancellation: { parameter: 'signal' },
    result: { mode: 'strict', typeSymbol: 'dsh-utils#TerminalOpen', schema: passSchema },
  },
  {
    id: 'dsh-utils#workspaceFiles/search',
    service: 'workspaceFiles',
    namespace: 'workspaceFiles',
    method: 'search',
    invocation: { kind: 'direct' },
    parameters: [jsonParam('root'), jsonParam('query')],
    cancellation: { parameter: 'signal' },
    result: { mode: 'strict', typeSymbol: 'dsh-utils#SearchView', schema: passSchema },
  },
]

/** The workspaceFiles service member of the host manifest. */
const WORKSPACE_FILES_SERVICE = {
  key: 'workspaceFiles',
  exportName: 'WorkspaceFilesRuntime',
  description: 'Workspace-gated file management for the web GUI: workspaces, directory listing, read/write/move/delete, filename search.',
  tags: [],
  members: [
    { kind: 'method', name: 'workspaces', signature: 'workspaces(signal?: AbortSignal): Promise<WorkspaceList>' },
    { kind: 'method', name: 'list', signature: 'list(root: string, rel: string, signal?: AbortSignal): Promise<DirListing>' },
    { kind: 'method', name: 'read', signature: 'read(root: string, rel: string, signal?: AbortSignal): Promise<FileRead>' },
    { kind: 'method', name: 'write', signature: 'write(root: string, rel: string, content: string, baseMtime?: number, signal?: AbortSignal): Promise<WriteResult>' },
    { kind: 'method', name: 'delete', signature: 'delete(root: string, rel: string, signal?: AbortSignal): Promise<DeleteResult>' },
    { kind: 'method', name: 'move', signature: 'move(root: string, from: string, to: string, signal?: AbortSignal): Promise<MoveResult>' },
    { kind: 'method', name: 'openTerminal', signature: 'openTerminal(root: string, rel: string, signal?: AbortSignal): Promise<TerminalOpen>' },
    { kind: 'method', name: 'search', signature: 'search(root: string, query: string, signal?: AbortSignal): Promise<SearchView>' },
  ],
  types: [],
}

/** The single host manifest for this package (one package face per package). */
export const TYPERT_MANIFEST = {
  package: 'dsh-utils',
  face: 'host',
  schemas: [],
  model: {
    services: [OPENCODE_USAGE_SERVICE, WORKSPACE_FILES_SERVICE],
    events: [],
    objects: [],
  },
  invocations: [...OPENCODE_USAGE_INVOCATIONS, ...WORKSPACE_FILES_INVOCATIONS],
}

/** The workspaceFiles Remote service: gated file operations under registered workspaces. */
export class WorkspaceFilesRuntime extends TypertRemoteService {
  /**
   * Register the service under the `workspaceFiles` key (the wire namespace).
   * @param ctx - owning cordis context.
   * @param options - `launch` overrides the terminal launcher (tests).
   */
  constructor(ctx, options = {}) {
    super(ctx, 'workspaceFiles')
    this.launch = options.launch ?? launchTerminal
  }

  /** List registered workspaces (id/path/title). */
  async workspaces(signal) {
    const registry = this.ctx.get('workspaceRegistry')
    const records = registry !== undefined && typeof registry.list === 'function' ? registry.list() : []
    return {
      workspaces: records.map((record) => ({ id: record.id, path: record.path, title: record.title })),
    }
  }

  /** List one directory (rel '' = root). Sorted dirs-first alpha; .git hidden. */
  async list(root, rel, signal) {
    const canonical = await gateRoot(this.ctx, root)
    const abs = await resolveInsideRoot(canonical, rel)
    let dirents
    try {
      dirents = await readdir(abs, { withFileTypes: true })
    } catch {
      throw new PanelError('not-found', `cannot list ${rel === '' ? '(root)' : rel}`)
    }
    const entries = []
    for (const entry of dirents) {
      if (entry.isDirectory()) {
        if (TREE_SKIP_DIRS.has(entry.name)) continue
        entries.push({ name: entry.name, path: rel === '' ? entry.name : `${rel}/${entry.name}`, isDir: true, size: 0, mtime: 0 })
      } else {
        const path = rel === '' ? entry.name : `${rel}/${entry.name}`
        try {
          const info = await stat(join(abs, entry.name))
          entries.push({ name: entry.name, path, isDir: false, size: info.size, mtime: info.mtimeMs })
        } catch {
          entries.push({ name: entry.name, path, isDir: false, size: 0, mtime: 0 })
        }
      }
    }
    entries.sort(compareEntries)
    return { root: canonical, entries }
  }

  /**
   * Read one file for preview: images come back as data URLs (capped), all
   * other files as utf-8 text capped at TEXT_CAP_CHARS.
   */
  async read(root, rel, signal) {
    const canonical = await gateRoot(this.ctx, root)
    if (isGitPath(rel)) throw new PanelError('path-outside-root', 'refusing to read .git')
    const abs = await resolveInsideRoot(canonical, rel)
    let data
    let info
    try {
      data = await readFile(abs)
      info = await stat(abs)
    } catch {
      throw new PanelError('not-found', `cannot read ${rel}`)
    }
    if (info.isDirectory()) throw new PanelError('is-directory', `${rel} is a directory`)
    if (isImagePath(rel)) {
      if (data.length > IMAGE_CAP_BYTES) {
        throw new PanelError('read-failed', 'image exceeds the preview cap')
      }
      return {
        content: `data:${imageMime(rel, data)};base64,${data.toString('base64')}`,
        isImage: true,
        size: data.length,
        mtime: info.mtimeMs,
      }
    }
    const text = data.toString('utf8')
    const truncated = text.length > TEXT_CAP_CHARS
    return {
      content: truncated ? text.slice(0, TEXT_CAP_CHARS) : text,
      truncated,
      size: data.length,
      mtime: info.mtimeMs,
    }
  }

  /** Write text content back, refusing when the file moved on disk (mtime conflict). */
  async write(root, rel, content, baseMtime, signal) {
    const canonical = await gateRoot(this.ctx, root)
    if (isGitPath(rel)) throw new PanelError('path-outside-root', 'refusing to touch .git')
    const abs = await resolveInsideRoot(canonical, rel)
    try {
      let current
      try {
        current = await stat(abs)
      } catch {
        current = { mtimeMs: 0 }
      }
      if (baseMtime != null && Number(current.mtimeMs) !== 0 && Math.abs(Number(current.mtimeMs) - baseMtime) > 1) {
        throw new PanelError('write-conflict', 'file changed on disk since it was loaded')
      }
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, content, 'utf8')
      const info = await stat(abs)
      return { mtime: info.mtimeMs }
    } catch (error) {
      if (error instanceof PanelError) throw error
      throw new PanelError('write-failed', `cannot write ${rel}`)
    }
  }

  /**
   * Delete a path into the OS recycle bin (permanent removal on non-Windows);
   * refuses the root and .git.
   */
  async delete(root, rel, signal) {
    const canonical = await gateRoot(this.ctx, root)
    if (rel === '') throw new PanelError('path-outside-root', 'refusing to delete the root')
    if (isGitPath(rel)) throw new PanelError('path-outside-root', 'refusing to touch .git')
    const abs = await resolveInsideRoot(canonical, rel)
    let info
    try {
      info = await stat(abs)
    } catch {
      throw new PanelError('not-found', `cannot delete ${rel}`)
    }
    await recycleRemove(abs, info.isDirectory())
    return { ok: true }
  }

  /**
   * Move a path into another directory of the same workspace (drag & drop).
   * @param root - workspace root.
   * @param from - relative source path ('' = the root itself, refused).
   * @param to - relative destination DIRECTORY ('' = root, i.e. dragging an
   *   item out of a subfolder onto the empty tree area).
   * @returns the resulting relative path.
   */
  async move(root, from, to, signal) {
    const canonical = await gateRoot(this.ctx, root)
    // Moving the root itself is refused; moving INTO the root (to === '') is a
    // legitimate "drag out of a folder" operation.
    if (from === '') throw new PanelError('path-outside-root', 'refusing to move the root')
    if (isGitPath(from) || isGitPath(to)) throw new PanelError('path-outside-root', 'refusing to touch .git')
    const fromAbs = await resolveInsideRoot(canonical, from)
    const toAbs = await resolveInsideRoot(canonical, to)
    if (to !== '') {
      let toInfo
      try {
        toInfo = await stat(toAbs)
      } catch {
        throw new PanelError('not-found', `destination "${to}" does not exist`)
      }
      if (!toInfo.isDirectory()) throw new PanelError('move-invalid', 'destination is not a directory')
    }
    const target = join(toAbs, basename(fromAbs))
    if (target === fromAbs) throw new PanelError('move-invalid', 'source and destination are the same')
    if (isPathInside(fromAbs, target)) {
      throw new PanelError('move-invalid', 'destination is inside the source')
    }
    try {
      await stat(target)
      throw new PanelError('move-conflict', `"${basename(fromAbs)}" already exists at the destination`)
    } catch (error) {
      if (error instanceof PanelError) throw error
    }
    try {
      await rename(fromAbs, target)
    } catch {
      // cross-device or locked: copy then remove
      try {
        await cp(fromAbs, target, { recursive: true, force: false })
        await rm(fromAbs, { recursive: true, force: true })
      } catch (copyError) {
        throw new PanelError('write-failed', `cannot move ${from}: ${String(copyError && copyError.message ? copyError.message : copyError)}`)
      }
    }
    return { ok: true, path: relative(canonical, target).replaceAll('\\', '/') }
  }

  /**
   * Open a terminal window on the host at a workspace directory (the
   * right-click "open in terminal" action). Windows: Windows Terminal when
   * present, legacy console otherwise; macOS: Terminal.app; Linux: the first
   * available of gnome-terminal / konsole / xfce4-terminal / alacritty /
   * kitty / x-terminal-emulator / xterm.
   * @param root - workspace root.
   * @param rel - relative directory ('' = the workspace root itself).
   * @returns `{ ok: true, terminal }` when a terminal was launched.
   */
  async openTerminal(root, rel, signal) {
    const canonical = await gateRoot(this.ctx, root)
    if (isGitPath(rel)) throw new PanelError('path-outside-root', 'refusing to touch .git')
    const abs = await resolveInsideRoot(canonical, rel)
    let info
    try {
      info = await stat(abs)
    } catch {
      throw new PanelError('not-found', `cannot open a terminal for ${rel}`)
    }
    if (!info.isDirectory()) throw new PanelError('not-directory', `${rel} is not a directory`)
    let terminal
    try {
      terminal = await this.launch(abs)
    } catch (error) {
      if (error instanceof PanelError) throw error
      throw new PanelError('launch-failed', `cannot open a terminal: ${String(error && error.message ? error.message : error)}`)
    }
    return { ok: true, terminal }
  }

  /** Recursive filename search (case-insensitive substring), pruned at noise dirs. */
  async search(root, query, signal) {
    const canonical = await gateRoot(this.ctx, root)
    const needle = query.trim().toLowerCase()
    if (needle === '') return { query, hits: [], truncated: false }
    const hits = []
    let scanned = 0
    let truncated = false
    const walk = async (rel, depth) => {
      if (truncated) return
      let abs
      try {
        abs = await resolveInsideRoot(canonical, rel)
      } catch {
        return
      }
      let dirents
      try {
        dirents = await readdir(abs, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of dirents) {
        if (scanned >= SEARCH_SCAN_CAP) {
          truncated = true
          return
        }
        scanned += 1
        const path = rel === '' ? entry.name : `${rel}/${entry.name}`
        if (entry.isDirectory()) {
          if (SEARCH_SKIP_DIRS.has(entry.name)) continue
          if (depth < 24 && !truncated) await walk(path, depth + 1)
          continue
        }
        if (entry.name.toLowerCase().includes(needle)) {
          if (hits.length >= SEARCH_HIT_CAP) {
            truncated = true
            return
          }
          hits.push({ path, name: entry.name, isDir: false })
        }
      }
    }
    try {
      await walk('', 0)
    } catch {
      throw new PanelError('search-failed', 'search walk failed')
    }
    const rank = (hit) => {
      const name = hit.name.toLowerCase()
      if (name === needle) return 0
      if (name.startsWith(needle)) return 1
      return 2
    }
    hits.sort((a, b) => rank(a) - rank(b) || a.path.length - b.path.length || (a.path < b.path ? -1 : 1))
    return { query, hits, truncated }
  }
}

/**
 * Mount both services and the single host manifest.
 * @param ctx - host cordis context.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx, config) {
  new OpencodeUsageRuntime(ctx, config)
  new WorkspaceFilesRuntime(ctx)
  ctx.effect(() => {
    const dispose = ctx.typert.register(TYPERT_MANIFEST)
    return () => {
      void dispose()
    }
  }, 'dsh-utils: typert manifest')
}
