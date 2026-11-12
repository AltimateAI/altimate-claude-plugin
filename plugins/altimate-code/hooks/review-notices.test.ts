import { expect, mock, test } from 'claude-code/testing'
import { MAX_NAME, MAX_REASON, POLL_MS, decisionText, toastsFor, type ReviewDecision } from './review-notices'

const decision = (over: Partial<ReviewDecision> = {}): ReviewDecision => ({
  kind: 'skill',
  public_id: 'c-1',
  name: 'deploy',
  status: 'active',
  reviewer: 'Olive',
  at: '2026-11-12T00:00:00Z',
  ...over,
})

/** A session with altimate-code's `workspace review decisions` answering `answers` in turn. */
async function session($: any, on: any, answers: Array<{ exitCode?: number; body?: unknown; stdout?: string }>, interactive = true) {
  const clock = mock.clock(on)
  const calls: string[][] = []
  const toasts: string[] = []
  on('command.register', () => ({ value: { command: 'integrations' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('ui.toast', (_: unknown, e: { text: string }) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('process.run', (_: unknown, e: { readonly argv: readonly string[] }) => {
    const args = e.argv.slice(1)
    if (args[0] === 'workspace' && args[1] === 'review') {
      calls.push(args)
      const next = answers.shift() ?? { body: { ok: true, decisions: [] } }
      return { value: { exitCode: next.exitCode ?? 0, stdout: next.stdout ?? JSON.stringify(next.body), stderr: '' } }
    }
    return { value: { exitCode: 0, stdout: '{}', stderr: '' } }
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: interactive })
  await clock.settle()
  return { clock, calls, toasts }
}

test('a decision reads as what happened to the person\'s own item', () => {
  expect(decisionText(decision())).toBe('◆ altimate · Your skill "deploy" was approved by Olive. It now reaches the workspace.')
  expect(decisionText(decision({ kind: 'knowledge', status: 'rejected', reason: 'Too broad' }))).toBe(
    '◆ altimate · Your knowledge base "deploy" was rejected by Olive — Too broad',
  )
  expect(decisionText(decision({ status: 'retired', reason: 'Duplicate' }))).toBe(
    '◆ altimate · Your skill "deploy" was removed from the workspace by Olive — Duplicate',
  )
})

test('many decisions toast the first ones and count the rest', () => {
  const many = Array.from({ length: 5 }, (_, i) => decision({ public_id: `c-${i}`, name: `s${i}` }))
  const toasts = toastsFor(many)
  expect(toasts).toHaveLength(3)
  expect(toasts[2]).toBe('◆ altimate · 3 more decisions on your skill and knowledge requests · /altimate-code:rules lists them')
})

test('an interactive session asks for decisions not toasted yet, for its folder, and toasts each', async ($, on) => {
  const { calls, toasts } = await session($, on, [
    {
      body: {
        ok: true,
        decisions: [decision({ key: 'skill:c-1:active' }), decision({ key: 'skill:c-2:rejected', public_id: 'c-2', status: 'rejected', reason: 'No' })],
      },
    },
  ])
  expect(calls[0]).toEqual(['workspace', 'review', 'decisions', '--json', '--unseen', '--claim', '--host', 'claude-ui', '--directory', '/repo'])
  expect(toasts).toEqual([
    '◆ altimate · Your skill "deploy" was approved by Olive. It now reaches the workspace.',
    '◆ altimate · Your skill "deploy" was rejected by Olive — No',
  ])
  // Acknowledged once toasted, so they are not handed out again.
  expect(calls[1]).toEqual(['workspace', 'review', 'decisions', '--json', '--host', 'claude-ui', '--directory', '/repo', '--ack', 'skill:c-1:active', 'skill:c-2:rejected'])
})

test('nothing toasted, nothing acknowledged', async ($, on) => {
  const { calls } = await session($, on, [{ body: { ok: true, decisions: [] } }])
  expect(calls).toHaveLength(1)
})

test('long names and reasons are cut', () => {
  const text = decisionText(decision({ name: 'n'.repeat(300), status: 'rejected', reason: 'r'.repeat(500) }))
  expect(text).toContain(`"${'n'.repeat(MAX_NAME - 1)}…"`)
  expect(text).toContain(` — ${'r'.repeat(MAX_REASON - 1)}…`)
  expect(text.length).toBeLessThan(MAX_NAME + MAX_REASON + 80)
})

test('a running session asks again later', async ($, on) => {
  const { clock, calls, toasts } = await session($, on, [{ body: { ok: true, decisions: [] } }, { body: { ok: true, decisions: [decision()] } }])
  expect(calls).toHaveLength(1)
  await clock.advance(POLL_MS)
  await clock.settle()
  // Asked again; the decision had no key (an older CLI), so there is nothing to acknowledge.
  expect(calls).toHaveLength(2)
  expect(toasts).toHaveLength(1)
})

test('a CLI without the command, or a project that is not linked, is not asked again', async ($, on) => {
  const old = await session($, on, [{ exitCode: 1, stdout: 'Unknown argument: decisions' }])
  await old.clock.advance(POLL_MS)
  await old.clock.settle()
  expect(old.calls).toHaveLength(1)
  expect(old.toasts).toEqual([])
})

test('not linked stops the checks for the session', async ($, on) => {
  const { clock, calls } = await session($, on, [{ body: { ok: false, status: 'not_linked' } }])
  await clock.advance(POLL_MS)
  await clock.settle()
  expect(calls).toHaveLength(1)
})

test('a session nobody watches (-p, the SDK) asks nothing', async ($, on) => {
  const { calls } = await session($, on, [], false)
  expect(calls).toEqual([])
})
