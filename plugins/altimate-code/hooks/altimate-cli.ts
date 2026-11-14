// The altimate CLI as both halves of the plugin call it.
import type { EngineInterface } from 'claude-code'

// `altimate` is the name the standalone installer and npm v0.7.1+ put on PATH;
// older npm installs only have `altimate-code`.
const CLI_NAMES = ['altimate', 'altimate-code'] as const

// A command that cannot start rejects; only that moves on to the next name, so a timeout never
// reruns a command that may have taken effect.
export const MISSING_BINARY = /ENOENT|not found|no such file|(cannot|could not|failed to) (start|spawn|run)/i

/** Runs the altimate CLI under the first name that is installed; 90 s unless the caller says otherwise. */
export async function runAltimate($: EngineInterface, args: string[], timeoutMs = 90_000) {
  let lastError: unknown = null
  for (const bin of CLI_NAMES) {
    try {
      return await $.process.run([bin, ...args], { timeoutMs })
    } catch (error) {
      if (!MISSING_BINARY.test(String(error))) throw error
      lastError = error
    }
  }
  throw lastError ?? new Error('altimate CLI not found')
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
    $.clock.after(ms, () => settle(null))
    work.then(settle, () => settle(null))
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
   * through the CLI with `--allow-write`, since the plugin's MCP server runs read-only.
   */
  write?: boolean
}

/**
 * Runs one altimate-code data tool: through the plugin's MCP server when it is connected (no
 * permission prompt, structured content when the build sends it), else `altimate tool run --json`.
 * `cliOnly` goes straight to the CLI, whose --json carries the whole metadata; a structured result
 * the server left out for size is fetched that way too.
 */
export async function runTool($: EngineInterface, name: string, args: Record<string, unknown>, options: RunToolOptions = {}) {
  const { until, write = false } = options
  const cliOnly = options.cliOnly === true || write
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
  const result = await runAltimate($, argv, await left())
  if ((result as { isStdoutTruncated?: boolean }).isStdoutTruncated) {
    return { metadata: null as any, text: `${name}'s answer was larger than the 4 MiB a plugin can read`, ok: false }
  }
  const data = parseJson<{ status?: string; output?: string; metadata?: unknown }>(result.stdout)
  // Anything but the CLI's answer object (an altimate-code that exits before a pipe drains cuts it off) is a
  // failure to report and ask again, not "no such model".
  if (result.exitCode === 0 && (!data || typeof data !== 'object' || typeof data.status !== 'string')) {
    return { metadata: null as any, text: 'the answer could not be read', ok: false }
  }
  return { metadata: (data?.metadata ?? null) as any, text: data?.output ?? '', ok: result.exitCode === 0 && data?.status !== 'error' }
}
