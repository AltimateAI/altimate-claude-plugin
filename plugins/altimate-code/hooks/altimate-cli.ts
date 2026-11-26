// The altimate CLI as both halves of the plugin call it.

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
export const CLI_NAMES = ['altimate', 'altimate-code'] as const

/** A binary that is not there at all. */
export const NOT_FOUND = /ENOENT|not found|no such file/i
// A command that cannot start (not there, or refused) rejects; only that moves on to the next name, so a
// timeout never reruns a command that may have taken effect.
export const MISSING_BINARY = new RegExp(`${NOT_FOUND.source}|(cannot|could not|failed to) (start|spawn|run)`, 'i')

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
export function fileUriPath(uri: string): string {
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
   * nobody: a caller sets it either for a tool the plugin runs on its own (README, "How it works",
   * item 4, lists them) or once the user has pressed or typed the command that does it; the skill asks
   * before it adds `--allow-write` itself.
   */
  write?: boolean
  /** Variables set for the CLI process (CLI route only, so a call that sets them never goes over MCP). */
  env?: Record<string, string>
}
