// The altimate CLI as both halves of the plugin call it.
import type { EngineInterface } from 'claude-code'

/**
 * The oldest altimate-code release the plugin is made for: the first with the dbt Power User tools the
 * cost check, health, comments, runs, CTE timing, SQL graph, to-model, defer and docs
 * coverage features call (`dbt_cost_estimate`, `dbt_health`, `dbt_run_results`, `dbt_cte_profile`,
 * `dbt_sql_graph`, `dbt_map_relations`, `dbt_defer_state`, `docs_share_comments`, `dbt_docs_coverage`), on top of the column answer 0.12.11 added.
 * Stated in README.md and CHANGELOG.md too.
 */
export const MIN_ALTIMATE_CODE = '0.12.12'

// `altimate` is the name the standalone installer and npm v0.7.1+ put on PATH;
// older npm installs only have `altimate-code`.
const CLI_NAMES = ['altimate', 'altimate-code'] as const

/** A binary that is not there at all. */
export const NOT_FOUND = /ENOENT|not found|no such file/i
// A command that cannot start (not there, or refused) rejects; only that moves on to the next name, so a
// timeout never reruns a command that may have taken effect.
export const MISSING_BINARY = new RegExp(`${NOT_FOUND.source}|(cannot|could not|failed to) (start|spawn|run)`, 'i')

/** Runs the altimate CLI under the first name that is installed; 90 s unless the caller says otherwise. */
export async function runAltimate($: EngineInterface, args: string[], timeoutMs = 90_000, env?: Record<string, string>) {
  let lastError: unknown = null
  for (const bin of CLI_NAMES) {
    try {
      return await $.process.run([bin, ...args], { timeoutMs, ...(env && { env }) })
    } catch (error) {
      if (!MISSING_BINARY.test(String(error))) throw error
      lastError = error
    }
  }
  throw lastError ?? new Error('altimate CLI not found')
}

const SEMVER = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/

/** The version a `--version` output names ("0.12.11", "altimate-code 0.12.11", "v0.13.0-beta.2"), or null; the last one when it names several. Read stdout first: stderr carries runtime notes. */
export function parseVersion(text: string): string | null {
  // The last one printed: a wrapper may name its own runtime (node v22.1.0) before the CLI's version.
  const found = [...text.matchAll(new RegExp(SEMVER.source, 'g'))].pop()
  return found ? found[0] : null
}

/** A build from source or a branch (0.0.0-main-202611191200, 0.0.0--202611190701): no release to compare with. */
export const isPreviewBuild = (version: string) => /^0\.0\.0-/.test(version)

/** Orders two versions as semver does: a prerelease is older than its release, and prerelease parts compare one by one. */
export function compareVersions(a: string, b: string): number {
  const split = (version: string) => {
    const [, major, minor, patch, pre] = SEMVER.exec(version) ?? []
    return { core: [Number(major), Number(minor), Number(patch)], pre: pre ? pre.split('.') : [] }
  }
  const left = split(a)
  const right = split(b)
  for (let i = 0; i < 3; i++) if (left.core[i] !== right.core[i]) return left.core[i]! < right.core[i]! ? -1 : 1
  if (!left.pre.length || !right.pre.length) return left.pre.length === right.pre.length ? 0 : left.pre.length ? -1 : 1
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i]
    const y = right.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const numbers = /^\d+$/.test(x) && /^\d+$/.test(y)
    // A number is older than a word; two numbers compare as numbers.
    if (/^\d+$/.test(x) !== /^\d+$/.test(y)) return /^\d+$/.test(x) ? -1 : 1
    return (numbers ? Number(x) < Number(y) : x < y) ? -1 : 1
  }
  return 0
}

const INSTALL = 'npm i -g @altimateai/altimate-code'

/**
 * What to tell the person about the altimate-code on PATH, or null when it is current, a preview build, or
 * cannot be told: the line names the version, the binary that runs and where it is, and the install command.
 * The binary is the one runAltimate runs: the first name that starts, so one that starts and fails is not passed over.
 * It never throws.
 */
export async function altimateCodeNotice($: EngineInterface): Promise<string | null> {
  try {
    for (const bin of CLI_NAMES) {
      let answer: { exitCode?: number; stdout?: string; stderr?: string }
      try {
        answer = await $.process.run([bin, '--version'], { timeoutMs: 10_000 })
      } catch (error) {
        if (!MISSING_BINARY.test(String(error))) return null
        continue
      }
      const version = answer.exitCode === 0 ? (parseVersion(answer.stdout ?? '') ?? parseVersion(answer.stderr ?? '')) : null
      if (!version || isPreviewBuild(version) || compareVersions(version, MIN_ALTIMATE_CODE) >= 0) return null
      const where = await $.process.run(['which', bin], { timeoutMs: 5_000 }).then(one => one.stdout.trim().split('\n')[0] ?? '').catch(() => '')
      return `${bin} ${version} found${where ? ` at ${where}` : ''}; this plugin needs ≥ ${MIN_ALTIMATE_CODE}: ${INSTALL}`
    }
    return `altimate-code is not installed; this plugin needs ≥ ${MIN_ALTIMATE_CODE}: ${INSTALL}`
  } catch {
    return null
  }
}

// The CLI pretty-prints its JSON, so read the whole text first, then fall back
// to the last line for a CLI that logs before printing one compact line.
export function parseJson<T>(text: string): T | null {
  const body = text.trim()
  for (const candidate of [body, body.split('\n').pop() ?? '']) {
    try {
      return JSON.parse(candidate) as T
    } catch {}
  }
  return null
}

// A press has a short budget, so a press only schedules its work; the work then
// runs on the clock, outside the press. Nothing awaits it, so a failure is caught here: work still
// running when its session ends (a reload, /clear) finds the engine gone, and that is no error to raise.
export function later($: EngineInterface, work: () => Promise<unknown>) {
  $.clock.after(0, () => {
    work().catch(error => {
      try {
        $.ui.log(`scheduled work failed: ${String(error)}`, { to: 'debug' })
      } catch {}
    })
  })
}

// The plugin's own MCP server, by its key in .mcp.json.
const SERVER_KEY = 'altimate-code'
const TOOL_TIMEOUT_MS = 60_000

/** Resolves with the work's value, or null once `ms` pass or it fails. */
export function within<T>($: EngineInterface, ms: number, work: Promise<T>): Promise<T | null> {
  return new Promise(resolve => {
    let settled = false
    const settle = (value: T | null) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    // The work's rejection is handled first, so a deadline that throws leaves none unhandled.
    work.then(settle, () => settle(null))
    $.clock.after(ms, () => settle(null))
  })
}

let serverName: string | null = null
let connectFailedAt = -Infinity
const CONNECT_RETRY_MS = 60_000

/** The plugin's MCP server as $.mcp.call names it, or null when it is not connected (CLI mode); a failure is retried after a minute. */
async function mcpServer($: EngineInterface): Promise<string | null> {
  if (serverName) return serverName
  const now = await $.clock.now()
  if (now - connectFailedAt < CONNECT_RETRY_MS) return null
  const connected = await $.mcp.connect(SERVER_KEY).catch(() => null)
  serverName = connected?.isConnected ? connected.server : null
  if (!serverName) connectFailedAt = now
  return serverName
}

export function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  const blocks = Array.isArray(content) ? content : Array.isArray((content as any)?.content) ? (content as any).content : []
  return blocks
    .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
    .map((block: any) => block.text)
    .join('\n')
}

/**
 * The file a `<persisted-output>` preview says holds the whole answer: null when the text is no such
 * preview, undefined when it is one but names no file.
 */
export function persistedPath(text: string): string | null | undefined {
  if (!/^\s*(?:<|&lt;)persisted-output(?:>|&gt;)/.test(text)) return null
  return /Full output saved to: ([^\n]+?)\s*$/m.exec(text)?.[1]
}

/** A file:// URI as a filesystem path; a Windows drive path keeps no leading slash. */
function fileUriPath(uri: string): string {
  const path = decodeURIComponent(new URL(uri).pathname)
  return /^\/[A-Za-z]:/.test(path) ? path.slice(1) : path
}

export type RunToolOptions = {
  /** Straight to the CLI, whose --json carries the whole metadata. */
  cliOnly?: boolean
  /** A deadline on the engine's clock: nothing starts once it has passed, and the CLI is stopped at it. */
  until?: number
  /**
   * The tool needs write permission (it starts the dbt adapter, or changes something): the call goes
   * through the CLI with `--allow-write`, since the plugin's MCP server runs read-only. runTool asks
   * nobody: a caller sets it only once the user has said yes to this write (README, "How it works",
   * item 4), as the skill does before it adds `--allow-write`.
   */
  write?: boolean
  /** Variables set for the CLI process (CLI route only, so a call that sets them never goes over MCP). */
  env?: Record<string, string>
}

/**
 * Runs one altimate-code data tool: through the plugin's MCP server when it is connected (no
 * permission prompt, structured content when the build sends it), else `altimate tool run --json`.
 * `cliOnly` goes straight to the CLI, whose --json carries the whole metadata; a structured result
 * the server left out for size is fetched that way too.
 */
export async function runTool($: EngineInterface, name: string, args: Record<string, unknown>, options: RunToolOptions = {}) {
  const { until, write = false } = options
  const cliOnly = options.cliOnly === true || write || options.env !== undefined
  // With a deadline, nothing starts once it has passed, and the CLI is stopped at it.
  const left = async () => {
    const ms = until === undefined ? TOOL_TIMEOUT_MS : until - (await $.clock.now())
    if (ms <= 0) throw new Error('out of time')
    return ms
  }
  const server = cliOnly ? null : await mcpServer($)
  if (server) {
    const ms = await left()
    try {
      // The engine's MCP call has no timeout of its own: one that never answers is given up on, so a
      // shared trace does not hold every later edit of that column, and the CLI is tried instead.
      const result = await within($, ms, $.mcp.call(server, name, args))
      if (!result) throw new Error('altimate-code did not answer over MCP')
      let text = textOf(result.content)
      // A long result comes back as a preview plus a link to the full text.
      const link = result.content.find((block: any) => block?.type === 'resource_link' && String(block.uri).startsWith('file://')) as
        | { uri: string }
        | undefined
      // Claude Code (2.1.319) swaps an answer of about 49 KB or more for a preview that names the file it
      // saved the whole answer to, with no link block: the answer is that file.
      const saved = link ? null : persistedPath(text)
      if (!link && saved === undefined) throw new Error('a cut-off preview with no file named')
      // An unreadable link or file leaves only the preview: fetch the whole answer through the CLI instead.
      const full = link ? await $.fs.read(fileUriPath(link.uri)).catch(() => null) : saved ? await $.fs.read(saved).catch(() => null) : text
      if (full === null) throw new Error('the full result could not be read')
      text = full
      // Claude Code hands a tool's structured content over as one JSON text block in place of the
      // text; the structured content carries the text report as `report`.
      const structured = (result.structuredContent ?? (text.trim().startsWith('{') ? parseJson(text) : null)) as any
      if (structured?.truncated !== true) {
        return { metadata: structured, text: typeof structured?.report === 'string' ? structured.report : text, ok: !result.isError }
      }
    } catch {
      // Fall through to the CLI: the server may have gone away mid-session, so the next call reconnects.
      serverName = null
    }
  }
  const argv = ['tool', 'run', name, '--args', JSON.stringify(args), '--json', ...(write ? ['--allow-write'] : [])]
  const result = await runAltimate($, argv, await left(), options.env)
  if ((result as { isStdoutTruncated?: boolean }).isStdoutTruncated) {
    return { metadata: null as any, text: `${name}'s answer was larger than the 4 MiB a plugin can read`, ok: false }
  }
  const data = parseJson<{ status?: string; output?: string; metadata?: unknown }>(result.stdout)
  // Anything but the CLI's answer object (an altimate-code that exits before a pipe drains cuts it off) is a
  // failure to report and ask again, not "no such model".
  if (result.exitCode === 0 && (!data || typeof data !== 'object' || typeof data.status !== 'string')) {
    return { metadata: null as any, text: 'the answer could not be read', ok: false }
  }
  // A crash, or a failure the CLI prints as plain text, has no answer object: its first line is what to show.
  // An answer cut off mid-JSON is no message, so only what the CLI printed to stderr is shown for it.
  const out = result.stdout.trim()
  const said = data && typeof data === 'object' ? '' : ((out.startsWith('{') ? '' : out) || String(result.stderr ?? '').trim()).split('\n')[0]!.slice(0, 500)
  return { metadata: (data?.metadata ?? null) as any, text: data?.output ?? said, ok: result.exitCode === 0 && data?.status !== 'error' }
}
