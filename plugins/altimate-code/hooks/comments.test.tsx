import { expect, mock, test } from 'claude-code/testing'

import { contextBlock, groupByModel, placeThread, projectName, relativePath, threadsOnFile, toThread } from './features/comments'

const ROOT = '/repo'
const FILE = `${ROOT}/models/orders.sql`
const SQL = 'select\n  id,\n  sum(amount) as revenue\nfrom payments\ngroup by 1\n'

const RAW = {
  share_id: 7,
  share_name: 'Finance review',
  group_id: 11,
  file_path: 'models/orders.sql',
  highlight: 'sum(amount)',
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
  messages: [
    { id: 100, author: 'Ada Lovelace', text: 'Is this net of refunds?' },
    { id: 101, author: 'Grace Hopper', text: 'No, gross.' },
  ],
}

const PANE = {
  plugin: 'altimate-code',
  component: 'Pane',
  requestId: 'altimate-comments',
  props: { title: 'Team comments', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

/** A dbt project at /repo whose CLI answers docs_share_comments from `threads`; each tool call is recorded. */
async function start($: any, on: any, options: { threads?: unknown[]; noTool?: boolean; failPost?: boolean } = {}) {
  const clock = mock.clock(on)
  const cli: { args: Record<string, unknown>; write: boolean }[] = []
  on('command.register', () => ({ value: { command: 'comments' } }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('session.end', () => ({ sessionId: 'test' }))
  on('turn.complete', (_: unknown, e: { answer: string }) => ({ text: e.answer }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT }))
  on('ui.open', () => ({ value: {} }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: e.path === `${ROOT}/dbt_project.yml` }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 10, mtimeMs: 1, isLink: false } }))
  on('fs.read', (_: unknown, e: { path: string }) => {
    if (e.path === `${ROOT}/dbt_project.yml`) return { value: "name: 'jaffle_shop'\nversion: '1.0'\n" }
    if (e.path === FILE) return { value: SQL }
    throw new Error('ENOENT')
  })
  on('process.run', (_: unknown, e: { argv: readonly string[] }) => {
    const [, command, , tool] = e.argv
    if (command !== 'tool') return { value: { exitCode: 1, stdout: '', stderr: 'not this test' } }
    if (options.noTool) return { value: { exitCode: 1, stdout: JSON.stringify({ status: 'error', output: 'Unknown tool: docs_share_comments', metadata: {} }), stderr: '' } }
    const args = JSON.parse(String(e.argv[e.argv.indexOf('--args') + 1] ?? '{}'))
    cli.push({ args: { tool, ...args }, write: e.argv.includes('--allow-write') })
    if (args.action === 'list') {
      return { value: { exitCode: 0, stdout: JSON.stringify({ status: 'ok', output: '', metadata: { success: true, threads: options.threads ?? [RAW] } }), stderr: '' } }
    }
    if (options.failPost) return { value: { exitCode: 0, stdout: JSON.stringify({ status: 'ok', output: 'posting needs write permission', metadata: { success: false } }), stderr: '' } }
    return { value: { exitCode: 0, stdout: JSON.stringify({ status: 'ok', output: 'done', metadata: { success: true } }), stderr: '' } }
  })
  on('tool.call', () => ({ result: { ok: true } }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.settle()
  return { clock, cli }
}

test('a thread is placed on the line holding its highlighted text, else on its stored range', () => {
  const thread = toThread(RAW)!
  // The model was edited since the comment: the stored range (line 1) is stale, the highlight is on line 3.
  expect(placeThread(thread, SQL)).toBe(3)
  expect(placeThread(thread, 'select 1')).toBe(1)
  expect(placeThread({ ...thread, highlight: undefined, range: undefined }, SQL)).toBeNull()
})

test('threads are matched to a file by project-relative path and grouped by model', () => {
  const a = toThread(RAW)!
  const b = toThread({ ...RAW, group_id: 12, file_path: 'models/customers.sql' })!
  expect(relativePath(ROOT, FILE)).toBe('models/orders.sql')
  expect(threadsOnFile([a, b], ROOT, FILE)).toEqual([a])
  expect(groupByModel([a, b]).map(g => g.label)).toEqual(['models/customers.sql', 'models/orders.sql'])
  expect(toThread({ group_id: 1 })).toBeNull()
  expect(projectName("name: 'jaffle_shop'\n")).toBe('jaffle_shop')
})

test('the context block names each thread line, target and message, and caps a long review', () => {
  const thread = toThread(RAW)!
  const block = contextBlock('models/orders.sql', [thread], SQL)
  expect(block).toContain('Open team comments on models/orders.sql')
  expect(block).toContain('line 3, model, on “sum(amount)”')
  expect(block).toContain('Ada Lovelace: Is this net of refunds?')
  const many = Array.from({ length: 10 }, (_, i) => ({ ...thread, groupId: i }))
  expect(contextBlock('models/orders.sql', many, SQL)).toContain('and 2 more open threads')
})

test('reading a model with open threads adds the thread lines to Claude’s context', async ($, on) => {
  const { clock, cli } = await start($, on)
  expect(cli).toEqual([{ args: { tool: 'docs_share_comments', action: 'list', project: 'jaffle_shop' }, write: false }])
  const result: any = await $.tool.call({ tool: 'Read', file_path: FILE })
  await clock.settle()
  expect(result.context?.[0]).toContain('line 3, model, on “sum(amount)”')
  expect(result.context?.[0]).toContain('Grace Hopper: No, gross.')

  // A model with no threads adds nothing.
  const other: any = await $.tool.call({ tool: 'Read', file_path: `${ROOT}/models/customers.sql` })
  expect(other.context ?? []).toEqual([])
})

test('the list is fetched again every commentsPollSeconds', async ($, on) => {
  const { clock, cli } = await start($, on)
  await clock.advance(900_000)
  await clock.settle()
  expect(cli.filter(c => c.args.action === 'list').length).toBeGreaterThanOrEqual(2)
})

test('the pane shows threads by model; Reply and Resolve go through the CLI with write permission', async ($, on) => {
  const { clock, cli } = await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: 'models/orders.sql' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Is this net of refunds\?/ })).toBeDefined()

  await ui.press({ key: '7:11-resolve' })
  await clock.settle()
  const resolved = cli.find(c => c.args.action === 'resolve')
  expect(resolved).toEqual({ args: { tool: 'docs_share_comments', share_id: 7, group_id: 11, action: 'resolve' }, write: true })
  await ui.unmount()
})

test('a CLI without the tool shows one line naming the version needed, and no error loop', async ($, on) => {
  const { clock, cli } = await start($, on, { noTool: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /newer altimate-code than 0\.12\.10/ })).toBeDefined()
  await clock.advance(900_000)
  await clock.settle()
  expect(cli).toEqual([])
  await ui.unmount()
})

test('a refused post keeps the threads and shows why', async ($, on) => {
  const { clock } = await start($, on, { failPost: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await clock.settle()
  await ui.press({ key: '7:11-resolve' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /posting needs write permission/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Is this net of refunds\?/ })).toBeDefined()
  await ui.unmount()
})
