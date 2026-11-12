// Decisions on the person's own skill and knowledge requests to their Altimate workspace, as Claude Code toasts.
//
// The session-start hook already tells Claude (the model) about these decisions; this tells the person directly.
// altimate-code keeps the state: `workspace review decisions --json --unseen --mark-seen --host claude-ui` answers the
// decisions this host has not toasted yet and marks them toasted, so each one is toasted once, whatever the model was
// told. A CLI without that command answers an error, and the session stops asking.
import type { EngineInterface } from 'claude-code'
import { parseJson, runAltimate } from './altimate-cli'

/** What `workspace review decisions --json` answers. */
export type ReviewDecision = {
  kind: 'skill' | 'knowledge'
  public_id: string
  name: string
  status: string
  reason?: string
  reviewer?: string
  at: string
}
type DecisionsAnswer =
  | { ok: true; decisions: ReviewDecision[]; waiting?: number }
  | { ok: false; status?: string; error?: string }

/** The host name altimate-code keeps this toast's seen state under: apart from the session-start context's. */
export const HOST = 'claude-ui'
/** How often a running session asks again: decisions arrive while people work. */
export const POLL_MS = 15 * 60_000
/** A check spawns the CLI, which asks the server once: bounded so a slow server never holds anything. */
export const CHECK_TIMEOUT_MS = 20_000
/** Toasts per check; the rest are counted in the last one. */
export const MAX_TOASTS = 3
/** Answers that mean nothing will change in this session: stop asking. */
const FINAL = new Set(['signed_out', 'not_linked', 'unsupported', 'off'])

/** One toast's text for a decision. Server text was made printable by altimate-code. */
export function decisionText(d: ReviewDecision): string {
  const what = d.kind === 'skill' ? 'skill' : 'knowledge base'
  const by = d.reviewer ? ` by ${d.reviewer}` : ''
  const why = d.reason ? ` — ${d.reason}` : ''
  if (d.status === 'active') return `◆ altimate · Your ${what} "${d.name}" was approved${by}. It now reaches the workspace.`
  if (d.status === 'rejected') return `◆ altimate · Your ${what} "${d.name}" was rejected${by}${why}`
  if (d.status === 'retired') return `◆ altimate · Your ${what} "${d.name}" was removed from the workspace${by}${why}`
  return `◆ altimate · Your ${what} "${d.name}" is now ${d.status}${by}${why}`
}

/** The toasts for one check: up to `MAX_TOASTS`, the last naming how many more there are. */
export function toastsFor(decisions: readonly ReviewDecision[]): string[] {
  if (decisions.length <= MAX_TOASTS) return decisions.map(decisionText)
  const shown = decisions.slice(0, MAX_TOASTS - 1).map(decisionText)
  const more = decisions.length - shown.length
  return [...shown, `◆ altimate · ${more} more decisions on your skill and knowledge requests · /altimate-code:rules lists them`]
}

/** Ask once; toast what is new. Answers whether to keep asking in this session. */
export async function checkOnce($: EngineInterface, cwd: string): Promise<boolean> {
  let result: { exitCode: number; stdout: string }
  try {
    result = await runAltimate(
      $,
      ['workspace', 'review', 'decisions', '--json', '--unseen', '--mark-seen', '--host', HOST, '--directory', cwd],
      CHECK_TIMEOUT_MS,
    )
  } catch (error) {
    // No CLI at all, or it did not answer in time: try again next time.
    $.ui.log(`review-notices · check failed: ${String(error)}`, { to: 'debug' })
    return !/not found|ENOENT/i.test(String(error))
  }
  const answer = parseJson<DecisionsAnswer>(result.stdout)
  // A CLI without the command (an older release) answers no JSON: nothing to ask in this session.
  if (!answer || typeof answer.ok !== 'boolean') return false
  if (!answer.ok) return !FINAL.has(answer.status ?? '')
  for (const text of toastsFor(answer.decisions ?? [])) $.ui.toast(text, { timeoutMs: 10_000 })
  return true
}

/** At session start and then every `POLL_MS`, for an interactive session only. */
export function startReviewNotices($: EngineInterface, cwd: string) {
  const tick = async () => {
    if (await checkOnce($, cwd)) $.clock.after(POLL_MS, () => void tick().catch(() => {}))
  }
  // Off the start's path: the first check runs once the session is up.
  $.clock.after(0, () => void tick().catch(() => {}))
}
