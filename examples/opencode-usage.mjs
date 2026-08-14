#!/usr/bin/env node
/**
 * opencode-usage.mjs — 查询 opencode go 用量（rolling / weekly / monthly）的独立脚本
 *
 * 从 dsh-utils 插件（https://github.com/jifeilong9/dsh-utils）中单独提取，
 * 无任何依赖，Node.js 18+ 直接运行（使用内置 fetch）。
 *
 * 用法：
 *   node opencode-usage.mjs --key <你的 key>
 *   OPENCODE_GO_API_KEY=<你的 key> node opencode-usage.mjs
 *   OPENCODE_GO_API_KEY=<你的 key> node opencode-usage.mjs --json   # 输出原始 JSON
 *   node opencode-usage.mjs --endpoint <自定义地址> --key <key>
 *
 * 也可以作为库使用：
 *   import { fetchUsageReport, formatReport } from './opencode-usage.mjs'
 *   const usage = await fetchUsageReport(apiKey)   // { rolling, weekly, monthly }
 *   console.log(formatReport(usage))
 *
 * 返回值结构（三个时间窗一致）：
 *   {
 *     rolling: { status: 'ok', percent: number, resetsAt: 'ISO 时间字符串' },
 *     weekly:  { status: 'ok', percent: number, resetsAt: 'ISO 时间字符串' },
 *     monthly: { status: 'ok', percent: number, resetsAt: 'ISO 时间字符串' },
 *   }
 */

/** 默认用量查询端点（opencode go）。 */
export const USAGE_ENDPOINT = 'https://opencode.ai/zen/go/v1/usage'

/** 请求重试次数与单次超时。 */
export const USAGE_ATTEMPTS = 3
export const USAGE_TIMEOUT_MS = 30_000

/**
 * 拉取用量报告：Bearer 鉴权，失败自动重试（500ms 起步的线性退避），
 * 并严格校验三个时间窗都带有 percent / resetsAt，防止返回空结构。
 * @param {string} apiKey - 鉴权 key。
 * @param {string} [endpoint] - 端点覆盖，默认 USAGE_ENDPOINT。
 * @param {AbortSignal} [signal] - 调用方取消信号（可选）。
 * @returns {Promise<{rolling: object, weekly: object, monthly: object}>}
 */
export async function fetchUsageReport(apiKey, endpoint = USAGE_ENDPOINT, signal) {
  let lastError
  for (let attempt = 0; attempt < USAGE_ATTEMPTS; attempt += 1) {
    const timeoutSignal = AbortSignal.timeout(USAGE_TIMEOUT_MS)
    const combined = signal !== undefined ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    try {
      const response = await fetch(endpoint, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: combined,
      })
      if (!response.ok) {
        throw new Error(`opencode usage endpoint responded HTTP ${response.status}`)
      }
      const body = await response.json()
      const usage = body != null && typeof body === 'object' ? body.usage : undefined
      if (usage == null || typeof usage !== 'object') {
        throw new Error('opencode usage endpoint returned no usage object')
      }
      // 端点偶尔返回空/残缺结构，当作请求失败处理（重试），而不是显示无意义的值。
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

/** 从 resetsAt 计算剩余时间的中文描述（相对 now）。 */
export function countdownText(resetsAt, now = Date.now()) {
  const target = Date.parse(resetsAt)
  if (!Number.isFinite(target)) return null
  const minutes = Math.floor(Math.max(0, target - now) / 60000)
  if (minutes <= 0) return '即将重置'
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  if (days > 0) return `${days}天${hours}小时`
  if (hours > 0) return `${hours}小时${mins}分`
  return `${mins}分钟`
}

/** 一行报告（百分比 + 重置时间 + 倒计时）。 */
export function lineOf(usage, key) {
  const entry = usage?.[key]
  if (entry == null) return `${key.padEnd(7)} ?`
  const countdown = countdownText(entry.resetsAt)
  const when = countdown === null ? '未知重置时间' : `重置于 ${entry.resetsAt}（${countdown}后）`
  return `${key.padEnd(7)} ${String(entry.percent).padStart(6)}%   ${when}`
}

/** 人类可读的完整报告。 */
export function formatReport(usage) {
  return [
    'opencode go 用量报告',
    lineOf(usage, 'rolling'),
    lineOf(usage, 'weekly'),
    lineOf(usage, 'monthly'),
  ].join('\n')
}

/** 极简参数解析：--key <v> / --key=<v>、--endpoint <v>、--json、-h/--help。 */
export function parseArgs(argv) {
  const args = { key: undefined, endpoint: undefined, json: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i]
    const eq = raw.indexOf('=')
    const name = eq === -1 ? raw : raw.slice(0, eq)
    const inline = eq === -1 ? undefined : raw.slice(eq + 1)
    const value = (flag) => inline !== undefined ? inline : (i + 1 < argv.length ? argv[++i] : undefined)
    switch (name) {
      case '--key': args.key = value(); break
      case '--endpoint': args.endpoint = value(); break
      case '--json': args.json = true; break
      case '-h': case '--help': args.help = true; break
      default: break
    }
  }
  return args
}

const HELP = `opencode-usage.mjs — 查询 opencode go 用量

用法:
  node opencode-usage.mjs --key <key> [--endpoint <url>] [--json]
  OPENCODE_GO_API_KEY=<key> node opencode-usage.mjs

选项:
  --key <key>       鉴权 key（也可用环境变量 OPENCODE_GO_API_KEY / OPENCODE_API_KEY）
  --endpoint <url>  覆盖默认端点 ${USAGE_ENDPOINT}
  --json            输出原始 JSON（{ rolling, weekly, monthly }）
  -h, --help        显示本帮助
`

/** CLI 入口。返回进程退出码。 */
export async function main(argv = process.argv.slice(2), env = process.env, out = console) {
  const args = parseArgs(argv)
  if (args.help) {
    out.log(HELP)
    return 0
  }
  const apiKey = args.key || env.OPENCODE_GO_API_KEY || env.OPENCODE_API_KEY
  if (apiKey == null || apiKey === '') {
    out.error('缺少 API key：请用 --key <key> 或设置环境变量 OPENCODE_GO_API_KEY')
    out.log(HELP)
    return 2
  }
  const endpoint = args.endpoint || USAGE_ENDPOINT
  try {
    const usage = await fetchUsageReport(apiKey, endpoint)
    if (args.json) {
      out.log(JSON.stringify(usage, null, 2))
    } else {
      out.log(formatReport(usage))
    }
    return 0
  } catch (error) {
    out.error(`查询失败: ${error && error.message ? error.message : String(error)}`)
    return 1
  }
}

// 直接以脚本方式运行时执行 CLI（作为模块 import 时不触发）。
import { pathToFileURL } from 'node:url'
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main()
}
