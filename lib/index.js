/**
 * dsh-utils host plugin.
 *
 * Mounts the `workspaceFiles` Typert Remote service — workspace file
 * management for the web GUI: list registered workspaces, list directories,
 * read / write / delete files, move files (drag & drop), open a terminal on
 * the host at a workspace directory, and search file names. Every operation
 * is gated: the root must be a registered workspace (or a directory inside
 * one) and relative paths are traversal-guarded (symlink-safe), so the
 * browser can only ever touch files under registered workspace roots. The
 * gate/path-safety pattern follows the dsh-web-ui panel (BSD-3-Clause,
 * zhu1090093659).
 *
 * The opencode usage badge lives in the separate `opencode-usage-badge`
 * package; it is not part of this one.
 *
 * The client half ships in the same package (`./client`); the web server
 * serves it under /plugins/dsh-utils/client.js.
 */
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { cp, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, delimiter, dirname, join, relative } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

/** Stable Cordis plugin name (the Loader entry and client bundle id). */
export const name = 'dsh-utils'

/** Services required before load: the Typert registry. */
export const inject = ['typert']

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
 * Build the launch candidates that open `dir` in VS Code (the `code` /
 * `code-insiders` CLI). On Windows those CLIs are `.cmd` scripts, so the
 * candidates are marked `shell: true` and the exit-based spawner below
 * detects a missing installation (the wrapper exits non-zero).
 * @param dir - absolute directory to open.
 * @returns `[{ label, file, args, cwd, shell? }...]` best-first.
 */
export function vscodeCandidates(dir) {
  if (process.platform === 'win32') {
    return [
      { label: 'VS Code', file: 'code', args: [dir], cwd: dir, shell: true },
      { label: 'VS Code Insiders', file: 'code-insiders', args: [dir], cwd: dir, shell: true },
    ]
  }
  const found = []
  for (const name of ['code', 'code-insiders']) {
    const file = resolveExecutable(name)
    if (file !== null) found.push({ label: name === 'code' ? 'VS Code' : 'VS Code Insiders', file, args: [dir], cwd: dir })
  }
  return found
}

/**
 * Spawn one candidate detached (own console on Windows) and resolve once it
 * is up; rejects on spawn failure so callers can fall through. Candidates
 * with `shell: true` (Windows `.cmd` launchers like VS Code's `code.cmd`)
 * spawn even when the underlying command is missing — the wrapper then exits
 * non-zero, so for those candidates success is decided by the exit code
 * (with a short grace period for launchers that outlive the spawn).
 */
function spawnDetached(candidate) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      fn(value)
    }
    let child
    try {
      child = spawn(candidate.file, candidate.args, {
        cwd: candidate.cwd,
        detached: true,
        stdio: 'ignore',
        ...(candidate.shell === true ? { shell: true } : {}),
      })
    } catch (error) {
      reject(error)
      return
    }
    child.once('error', (error) => finish(reject, error))
    if (candidate.shell === true) {
      child.once('exit', (code) => {
        if (code === 0) finish(resolve)
        else finish(reject, new Error(`exited with code ${code}`))
      })
      child.once('spawn', () => {
        setTimeout(() => {
          if (!settled && child.exitCode === null) {
            child.unref()
            finish(resolve)
          }
        }, 500)
      })
    } else {
      child.once('spawn', () => {
        child.unref()
        finish(resolve)
      })
    }
  })
}

/**
 * Open the first candidate that launches, trying them in order.
 * @param candidates - ordered launch candidates.
 * @param spawnImpl - injectable spawner for tests (defaults to spawnDetached).
 * @returns the label of the candidate that launched.
 * @throws PanelError('launch-failed') when no candidate could be launched.
 */
export async function launchFirst(candidates, spawnImpl = spawnDetached) {
  let lastError = null
  for (const candidate of candidates) {
    try {
      await spawnImpl(candidate)
      return candidate.label
    } catch (error) {
      lastError = error
    }
  }
  const detail = lastError !== null ? `: ${String(lastError.message || lastError)}` : ' (no launcher found)'
  throw new PanelError('launch-failed', `cannot open: ${detail}`)
}

/** Open a terminal window in `dir` (convenience over launchFirst). */
export async function launchTerminal(dir, spawnImpl = spawnDetached) {
  return launchFirst(terminalCandidates(dir), spawnImpl)
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
    id: 'dsh-utils#workspaceFiles/createDir',
    service: 'workspaceFiles',
    namespace: 'workspaceFiles',
    method: 'createDir',
    invocation: { kind: 'direct' },
    parameters: [jsonParam('root'), jsonParam('rel')],
    cancellation: { parameter: 'signal' },
    result: { mode: 'strict', typeSymbol: 'dsh-utils#CreateDirResult', schema: passSchema },
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
    id: 'dsh-utils#workspaceFiles/openInVscode',
    service: 'workspaceFiles',
    namespace: 'workspaceFiles',
    method: 'openInVscode',
    invocation: { kind: 'direct' },
    parameters: [jsonParam('root'), jsonParam('rel')],
    cancellation: { parameter: 'signal' },
    result: { mode: 'strict', typeSymbol: 'dsh-utils#VscodeOpen', schema: passSchema },
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
    { kind: 'method', name: 'createDir', signature: 'createDir(root: string, rel: string, signal?: AbortSignal): Promise<CreateDirResult>' },
    { kind: 'method', name: 'delete', signature: 'delete(root: string, rel: string, signal?: AbortSignal): Promise<DeleteResult>' },
    { kind: 'method', name: 'move', signature: 'move(root: string, from: string, to: string, signal?: AbortSignal): Promise<MoveResult>' },
    { kind: 'method', name: 'openTerminal', signature: 'openTerminal(root: string, rel: string, signal?: AbortSignal): Promise<TerminalOpen>' },
    { kind: 'method', name: 'openInVscode', signature: 'openInVscode(root: string, rel: string, signal?: AbortSignal): Promise<VscodeOpen>' },
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
    services: [WORKSPACE_FILES_SERVICE],
    events: [],
    objects: [],
  },
  invocations: [...WORKSPACE_FILES_INVOCATIONS],
}

/** The workspaceFiles Remote service: gated file operations under registered workspaces. */
export class WorkspaceFilesRuntime extends TypertRemoteService {
  /**
   * Register the service under the `workspaceFiles` key (the wire namespace).
   * @param ctx - owning cordis context.
   * @param options - `launch` / `launchVscode` override the terminal and
   *   editor launchers (tests).
   */
  constructor(ctx, options = {}) {
    super(ctx, 'workspaceFiles')
    this.launch = options.launch ?? ((dir) => launchTerminal(dir))
    this.launchVscode = options.launchVscode ?? ((dir) => launchFirst(vscodeCandidates(dir)))
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
   * Create a directory (right-click "new folder"). Refuses the root itself,
   * .git paths, and existing names (create-conflict).
   * @param root - workspace root.
   * @param rel - relative path of the new directory (never '').
   * @returns `{ ok: true, path }` with the resulting relative path.
   */
  async createDir(root, rel, signal) {
    const canonical = await gateRoot(this.ctx, root)
    if (rel === '') throw new PanelError('path-outside-root', 'refusing to create the root')
    if (isGitPath(rel)) throw new PanelError('path-outside-root', 'refusing to touch .git')
    const abs = await resolveInsideRoot(canonical, rel)
    try {
      await stat(abs)
      throw new PanelError('create-conflict', `"${rel}" already exists`)
    } catch (error) {
      if (error instanceof PanelError) throw error
    }
    try {
      await mkdir(abs, { recursive: true })
    } catch {
      throw new PanelError('write-failed', `cannot create directory ${rel}`)
    }
    return { ok: true, path: rel }
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

  /**
   * Open a directory in VS Code on the host (the right-click "open in VS
   * Code" action). Launches the `code` CLI (falling back to `code-insiders`)
   * with the workspace-gated directory.
   * @param root - workspace root.
   * @param rel - relative directory ('' = the workspace root itself).
   * @returns `{ ok: true, editor }` when a VS Code CLI launched.
   */
  async openInVscode(root, rel, signal) {
    const canonical = await gateRoot(this.ctx, root)
    if (isGitPath(rel)) throw new PanelError('path-outside-root', 'refusing to touch .git')
    const abs = await resolveInsideRoot(canonical, rel)
    let info
    try {
      info = await stat(abs)
    } catch {
      throw new PanelError('not-found', `cannot open in VS Code: ${rel}`)
    }
    if (!info.isDirectory()) throw new PanelError('not-directory', `${rel} is not a directory`)
    let editor
    try {
      editor = await this.launchVscode(abs)
    } catch (error) {
      if (error instanceof PanelError) throw error
      throw new PanelError('launch-failed', `cannot open in VS Code: ${String(error && error.message ? error.message : error)}`)
    }
    return { ok: true, editor }
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
 * Mount the workspaceFiles service and the host manifest.
 * @param ctx - host cordis context.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx, config) {
  new WorkspaceFilesRuntime(ctx)
  ctx.effect(() => {
    const dispose = ctx.typert.register(TYPERT_MANIFEST)
    return () => {
      void dispose()
    }
  }, 'dsh-utils: typert manifest')
}
