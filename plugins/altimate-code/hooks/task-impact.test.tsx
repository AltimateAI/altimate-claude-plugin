import { expect, mock, test } from 'claude-code/testing'

import { MIN_ALTIMATE_CODE } from './altimate-cli'
import { DOWN, UP, embedded } from './impact-report.test'
import { nothingToReport } from './inert-features'
import { TUVA_MEDICAL_CLAIM_SQL, TUVA_MODEL_LEVEL, TUVA_PAID_AMOUNT } from './tuva-answer.fixture'

const ROOT = '/repo'
const MANIFEST = `${ROOT}/target/manifest.json`
// The manifest copies carry the session's id: read from the copy the task start made.
let RUNS: string[][] = []
const tag = () => RUNS.map(one => (one[0] === 'cp' ? /\/\.altimate-manifest-before\.([^/]+)\.json$/.exec(one[2] ?? '')?.[1] : undefined)).find(Boolean) ?? ''
const snapshot = () => `${ROOT}/target/.altimate-manifest-before.${tag()}.json`
const frozen = () => `${ROOT}/target/.altimate-task-manifest.${tag()}.json`
const TASK_FILE = `${ROOT}/target/.altimate-lineage/last-task.json`
const REPORT = `${ROOT}/target/.altimate-lineage/report.html`
const MODEL = `${ROOT}/models/fct_orders.sql`
const STAGING = `${ROOT}/models/stg_payments.sql`
const MACRO = `${ROOT}/macros/cents.sql`
const SNAPSHOT_SQL = `${ROOT}/snapshots/orders_snap.sql`

const BAND = {
  plugin: 'altimate-code',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const ORDERS_SQL = 'select\n  order_id,\n  sum(amount) as revenue\nfrom {{ ref("int_orders") }}\ngroup by 1\n'
const PAYMENTS_SQL = 'select\n  payment_id,\n  amount_cents / 100 as amount\nfrom {{ source("raw", "payments") }}\nwhere status = \'ok\'\n'

type Options = {
  /** What `uname -s` prints; null when it cannot start (Windows). */
  uname?: string | null
  /** Exit code per opener command; a command missing here cannot start. */
  openers?: Record<string, number>
  /** Files git sees as changed against HEAD, project-relative. */
  gitChanged?: () => string[]
  /** HEAD's text per project-relative path. */
  head?: Record<string, string>
  noManifest?: boolean
  /** More files from the start, by absolute path (a project below that the session start already sees). */
  extra?: Record<string, string>
  /** Other paths that exist, such as Windows' explorer.exe under /mnt/c. */
  present?: string[]
  /** target/manifest.json has gone since the start. */
  manifestGone?: () => boolean
  /** The CLI answers with an error. */
  cliFails?: boolean
  /** What impact_analysis adds to its answer. */
  impact?: (args: Record<string, any>) => Record<string, unknown>
  /** The conversation's first launch (`usage().startedAt`) and its prompts so far. */
  conversation?: () => number
  turns?: () => number
  /** The CLI's whole answer for a call, in place of the usual one. */
  answer?: (args: Record<string, any>) => Answer | undefined | Promise<Answer | undefined>
}
type Answer = { status: string; output: string; metadata: Record<string, unknown> }

/**
 * A dbt project at /repo in a git repo, its files held in memory (edits apply to them), altimate-code
 * over MCP answering impact_analysis with a column answer per direction, and an opener per platform.
 */
async function start($: any, on: any, options: Options = {}) {
  const clock = mock.clock(on)
  const files: Record<string, string> = {
    [`${ROOT}/dbt_project.yml`]: "name: 'shop'\nmodel-paths: ['models']\n",
    [MODEL]: ORDERS_SQL,
    [STAGING]: PAYMENTS_SQL,
    [MACRO]: '{% macro cents(x) %}{{ x }} / 100{% endmacro %}',
    [SNAPSHOT_SQL]: '{% snapshot orders_snap %}select id, status from orders{% endsnapshot %}',
    ...options.extra,
  }
  const runs: string[][] = []
  const tools: Record<string, any>[] = []
  const writes = new Map<string, string>()
  const logs: string[] = []
  const toasts: string[] = []
  const copies = new Set<string>()
  const dialogs: number[] = []
  const mcpAsked: Record<string, any>[] = []
  const toolsAtDialog = () => tools.length
  on('command.register', () => ({ value: { command: 'x' } }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', (_: unknown, e: { answer: string }) => ({ text: e.answer }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT }))
  on('ui.open', () => ({ value: {} }))
  on('ui.toast', (_: unknown, e: { text: string }) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_: unknown, e: { text: string }) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('ui.render', ($$: any, e: any) => {
    const { Box } = $$.ui.resolve(e)
    return <Box key="engine" />
  })
  on('fs.exists', (_: unknown, e: { path: string }) => ({
    value: e.path in files || (e.path === MANIFEST && !options.noManifest && !options.manifestGone?.()) || writes.has(e.path) || copies.has(e.path) || !!options.present?.includes(e.path),
  }))
  on('fs.stat', (_: unknown, e: { path: string }) => {
    if (e.path === MANIFEST && options.noManifest) throw new Error('ENOENT')
    return { value: { kind: 'file', size: 50 * 1024 * 1024, mtimeMs: 1, isLink: false } }
  })
  // What sits directly in a folder of the held files: a manifest over 4 MiB leaves the names to the SQL files.
  on('fs.list', (_: unknown, e: { path: string }) => {
    const names = new Map<string, 'file' | 'dir'>()
    for (const path of Object.keys(files)) {
      if (!path.startsWith(`${e.path}/`)) continue
      const [head, ...rest] = path.slice(e.path.length + 1).split('/')
      names.set(head!, rest.length ? 'dir' : 'file')
    }
    return { value: [...names].map(([name, kind]) => ({ name, kind, size: 1, mtimeMs: 1, isLink: false })) }
  })
  on('fs.read', (_: unknown, e: { path: string }) => {
    if (e.path === MANIFEST) throw new Error('over 4 MiB')
    if (e.path in files) return { value: files[e.path] }
    if (writes.has(e.path)) return { value: writes.get(e.path) }
    throw new Error(`ENOENT ${e.path}`)
  })
  on('fs.write', (_: unknown, e: { path: string; text: string }) => {
    writes.set(e.path, e.text)
    return { value: undefined }
  })
  on('tool.list', () => ({ value: [] }))
  on('mcp.connect', () => ({ value: { isConnected: true, server: 'plugin:altimate-code:altimate-code' } }))
  // impact_analysis's answer, over MCP or the CLI: impactFirst's own call (no direction) gets the older column reach shape.
  const impactBody = (args: Record<string, any>) => {
    tools.push(args)
    const body = !args.direction
      ? { severity: 'LOW', direct_count: 4, transitive_count: 2, column_reach: { models: [], exposures: [] } }
      : !args.column
        ? { severity: 'LOW', direct_count: 4, transitive_count: 2 }
        : { severity: 'LOW', direct_count: 4, transitive_count: 2, column_answer: args.direction === 'upstream' ? UP : DOWN }
    return { ...body, ...options.impact?.(args) }
  }
  on('mcp.call', (_: unknown, e: { tool: string; args: Record<string, any> }) => {
    if (e.tool !== 'impact_analysis') return { value: { content: [], isError: true } }
    if (e.args.direction) mcpAsked.push(e.args)
    return { value: { content: [{ type: 'text', text: JSON.stringify({ ...impactBody(e.args), report: 'Impact' }) }], isError: false } }
  })
  on('session.id', () => ({ value: 'a1b2c3d4-0000-4000-8000-000000000001' }))
  on('session.usage', () => ({ value: { startedAt: options.conversation?.() ?? 1_000 } }))
  on('session.turns', () => ({ value: options.turns?.() ?? 1 }))
  on('process.run', async (_: unknown, e: { argv: readonly string[] }) => {
    const argv = [...e.argv]
    const inert = nothingToReport(argv)
    if (inert) return { value: inert }
    runs.push(argv)
    const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '' } })
    const [bin] = argv
    if (bin === 'altimate' && argv[2] === 'report-event') return ok()
    if (bin === 'altimate') {
      const args = JSON.parse(String(argv[argv.indexOf('--args') + 1] ?? '{}'))
      if (options.cliFails) return { value: { exitCode: 1, stdout: JSON.stringify({ status: 'error', output: 'no', metadata: {} }), stderr: '' } }
      const own = await options.answer?.(args)
      if (own) {
        tools.push(args)
        return ok(JSON.stringify(own))
      }
      return ok(JSON.stringify({ status: 'ok', output: 'Impact', metadata: impactBody(args) }))
    }
    if (bin === 'mkdir') return ok()
    if (bin === 'cp') {
      copies.add(argv[2]!)
      return ok()
    }
    if (bin === 'mv') {
      copies.delete(argv[2]!)
      copies.add(argv[3]!)
      return ok()
    }
    if (bin === 'rm') {
      writes.delete(argv[2]!)
      return ok()
    }
    if (bin === 'git') {
      const sub = argv[3]
      if (sub === 'rev-parse') return ok(`${ROOT}\n`)
      if (sub === 'diff') return ok((options.gitChanged?.() ?? []).join('\n'))
      if (sub === 'ls-files') return ok('')
      if (sub === 'show') {
        const path = argv[4]!.replace(/^HEAD:/, '')
        return path in (options.head ?? {}) ? ok(options.head![path]) : { value: { exitCode: 128, stdout: '', stderr: 'no such path' } }
      }
    }
    if (bin === 'uname') {
      if (options.uname === null) throw new Error('ENOENT: uname not found')
      return ok(`${options.uname ?? 'Linux'}\n`)
    }
    if (bin === 'wslpath') return ok('\\\\wsl.localhost\\dev\\repo\\target\\.altimate-lineage\\report.html\n')
    const code = options.openers?.[bin!]
    if (code === undefined) throw new Error(`ENOENT: ${bin} not found`)
    return { value: { exitCode: code, stdout: '', stderr: '' } }
  })
  // The tool beneath the plugin: an Edit applies to the files.
  on('tool.call', (_: unknown, e: any) => {
    if (e.tool === 'ExitPlanMode') dialogs.push(toolsAtDialog())
    if (e.tool === 'Edit' && e.file_path in files) files[e.file_path] = files[e.file_path]!.replace(e.old_string, e.new_string)
    if (e.tool === 'Write') files[e.file_path] = e.content
    return { result: { ok: true } }
  })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.settle()
  const turn = async (id: string, work: () => Promise<void>) => {
    await $.turn.start({ text: 'change it', turnId: id })
    await clock.settle()
    await work()
    await clock.settle()
    await $.turn.complete({ answer: 'Done.', durationMs: 5, isAborted: false, reason: 'answer', turnId: id } as any)
    await clock.settle()
  }
  RUNS = runs
  return { clock, files, runs, tools, writes, logs, toasts, copies, dialogs, mcpAsked, turn }
}

const directional = (tools: Record<string, any>[]) => tools.filter(one => one.direction)

test('a task start copies the manifest aside, never reading it, in target/ itself so altimate-code finds the project above it', async ($, on) => {
  const { runs, turn } = await start($, on)
  await turn('t1', async () => {})
  expect(runs).toContainEqual(['cp', MANIFEST, snapshot()])
  // altimate-code takes the folder above the manifest's as the project (a seed's CSV header): a copy one folder
  // deeper traced nothing through a `select *` from a seed.
  expect(snapshot().replace(/\/[^/]+$/, '')).toBe(`${ROOT}/target`)
})

test("each session's manifest copies carry its id, so another session's task never replaces them; a task's end clears copies a day old", async ($, on) => {
  mock.env(on, {})
  const { runs, turn, tools, clock } = await start($, on)
  await turn('t1', async () => {
    await $.tool.call({ tool: 'Edit', file_path: MODEL, old_string: 'sum(amount) as revenue', new_string: 'sum(amount) * 2 as revenue' })
  })
  await clock.settle()
  // The id in the copies' names is the one the usage events carry.
  const event = runs.find(one => one.includes('report-event'))!
  const id = event[event.indexOf('--session') + 1]!.replace(/^claude:/, '')
  expect(tag()).toBe(id.replace(/[^A-Za-z0-9_-]/g, '_'))
  expect(tag().length).toBeGreaterThan(0)
  expect(runs).toContainEqual(['mv', '-f', snapshot(), frozen()])
  expect(directional(tools).every(one => one.manifest_path === frozen())).toBe(true)
  const clear = runs.findIndex(one => one[0] === 'find')
  expect(runs[clear]).toEqual(['find', `${ROOT}/target`, '-maxdepth', '1', '-name', '.altimate-*manifest*.json', '-mmin', '+1440', '-delete'])
  // Copies an older version kept below target/.altimate-lineage go too.
  expect(runs[clear + 1]).toEqual(['find', `${ROOT}/target/.altimate-lineage`, '-maxdepth', '1', '-name', '*manifest*.json', '-mmin', '+1440', '-delete'])
  expect(clear).toBeLessThan(runs.findIndex(one => one[0] === 'mv'))
})

test('an edited model is traced downstream at the task end for the band; the report waits until it is asked for', async ($, on) => {
  const { tools, writes, turn, clock, logs, mcpAsked } = await start($, on)
  await turn('t1', async () => {
    await $.tool.call({ tool: 'Edit', file_path: MODEL, old_string: 'sum(amount) as revenue', new_string: 'sum(amount) - sum(refunds) as revenue' })
    // A second edit of the same file: the original stays the one from before the first.
    await $.tool.call({ tool: 'Edit', file_path: MODEL, old_string: 'order_id,', new_string: 'order_id ,' })
  })
  expect(directional(tools)).toEqual([{ manifest_path: frozen(), model: 'fct_orders', column: 'revenue', change_type: 'modify', direction: 'downstream' }])
  expect(writes.has(REPORT)).toBe(false)
  // One log line: the transcript draws a newline in a log as a replacement glyph.
  expect(logs).toContain('◆ Lineage after this task · 1 model changed · fct_orders · 6 downstream models at model level · revenue  reaches 4 columns in 3 models (2 end columns) · 3 more may change · ⚠ Lower bound: 1 model could not be read')

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: '◆ Lineage after this task · 1 model changed' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: 'fct_orders · 6 downstream models at model level' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: '  revenue  reaches 4 columns in 3 models (2 end columns) · 3 more may change' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: '⚠ Lower bound: 1 model could not be read' })).toBeDefined()
  expect(await band.find({ key: 'lineage-open' })).toBeDefined()

  // The press: upstream is asked for now, and the page written.
  await band.press({ key: 'lineage-report-open' })
  await clock.settle()
  expect(directional(tools).map(one => one.direction)).toEqual(['downstream', 'upstream'])
  expect(directional(tools)[1]!.manifest_path).toBe(frozen())
  const report = embedded(writes.get(REPORT)!)
  expect(report.changes).toEqual([
    { model: 'fct_orders', file: 'models/fct_orders.sql', columns: [{ name: 'revenue', before: 'sum(amount) as revenue', after: 'sum(amount) - sum(refunds) as revenue' }] },
  ])
  expect(report.focuses[0].down.hops.length).toBe(3)
  expect(report.focuses[0].up.hops.length).toBe(2)
  expect(report.movedOn).toEqual([])

  // A second ask rewrites the page from what it has, asking nothing again.
  await band.press({ key: 'lineage-report-open' })
  await clock.settle()
  expect(directional(tools).length).toBe(2)
  // Never over MCP, whose call can raise a permission dialog.
  expect(mcpAsked).toEqual([])

  await band.press({ key: 'lineage-summary-dismiss' })
  await clock.settle()
  expect(await band.find({ key: 'lineage-report-open' })).toBeUndefined()
  await band.unmount()
})

test('once the session has moved on, /lineage-report still builds that task, from its own manifest, and says what changed since', async ($, on) => {
  const { tools, writes, files, turn, clock, copies } = await start($, on, { openers: { 'xdg-open': 0 } })
  await turn('t1', async () => {
    await $.tool.call({ tool: 'Edit', file_path: MODEL, old_string: 'sum(amount) as revenue', new_string: 'sum(amount) * 2 as revenue' })
  })
  // A later turn changes no model: its own copy goes down, the task's stays, and the band is gone.
  await turn('t2', async () => {
    files[MODEL] = files[MODEL]!.replace('order_id,', 'order_id as id,')
  })
  expect(copies.has(snapshot())).toBe(true)
  expect(copies.has(frozen())).toBe(true)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ key: 'lineage-report-open' })).toBeUndefined()
  await band.unmount()
  const before = directional(tools).length
  const out: any = await $.command.run({ command: 'lineage-report', args: '' } as any)
  await clock.settle()
  expect(out.text).toMatch(/^Opened the column impact report for the task that finished at .* UTC: /)
  expect(directional(tools).slice(before).map(one => [one.direction, one.manifest_path])).toEqual([['upstream', frozen()]])
  const report = embedded(writes.get(REPORT)!)
  expect(report.changes[0].columns[0].after).toBe('sum(amount) * 2 as revenue')
  expect(report.movedOn).toEqual(['models/fct_orders.sql'])
})

test('a later task that changes a model takes over: its report, its manifest', async ($, on) => {
  const { writes, tools, turn } = await start($, on, { openers: { 'xdg-open': 0 } })
  await turn('t1', async () => {
    await $.tool.call({ tool: 'Edit', file_path: MODEL, old_string: 'sum(amount) as revenue', new_string: 'sum(amount) * 2 as revenue' })
  })
  await $.command.run({ command: 'lineage-report', args: '' } as any)
  expect(embedded(writes.get(REPORT)!).changes[0].model).toBe('fct_orders')
  await turn('t2', async () => {
    await $.tool.call({ tool: 'Edit', file_path: STAGING, old_string: 'amount_cents / 100 as amount', new_string: 'amount_cents / 100.0 as amount' })
  })
  // The last report is gone until the new one is asked for.
  expect(writes.has(REPORT)).toBe(false)
  await $.command.run({ command: 'lineage-report', args: '' } as any)
  expect(embedded(writes.get(REPORT)!).changes.map((one: any) => one.model)).toEqual(['stg_payments'])
  expect(directional(tools).filter(one => one.model === 'stg_payments').every(one => one.manifest_path === frozen())).toBe(true)
})

test("the band comes back with its conversation from Claude Code's session list, unless a prompt came since, it was dismissed, or the conversation is another", async ($, on) => {
  let conversation = 1_000
  let turns = 1
  const { writes, turn, clock } = await start($, on, { conversation: () => conversation, turns: () => turns })
  await turn('t1', async () => {
    await $.tool.call({ tool: 'Edit', file_path: MODEL, old_string: 'sum(amount) as revenue', new_string: 'sum(amount) * 2 as revenue' })
  })
  const saved = JSON.parse(writes.get(TASK_FILE)!)
  expect(saved).toMatchObject({ conversation: 1_000, turns: 1, view: { state: 'ready' } })
  const lines = async () => {
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const found = await band.find({ type: 'Text', text: '◆ Lineage after this task · 1 model changed' })
    const open = await band.find({ key: 'lineage-report-open' })
    await band.unmount()
    return !!found && !!open
  }
  expect(await lines()).toBe(true)
  // The session list moves the conversation to a new process: the plugin starts over under a new session id.
  const back = async () => {
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    await clock.settle()
  }
  await back()
  expect(await lines()).toBe(true)
  // Another conversation in the same project, or this one after another prompt: no band.
  conversation = 2_000
  await back()
  expect(await lines()).toBe(false)
  conversation = 1_000
  turns = 2
  await back()
  expect(await lines()).toBe(false)
  // Dismissed, it stays gone; the task itself stays saved for /lineage-report.
  turns = 1
  await back()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'lineage-summary-dismiss' })
  await clock.settle()
  await band.unmount()
  await back()
  expect(await lines()).toBe(false)
  expect(JSON.parse(writes.get(TASK_FILE)!)).toMatchObject({ version: 1, changes: [{ model: 'fct_orders' }] })
  expect(JSON.parse(writes.get(TASK_FILE)!).view).toBeUndefined()
})

test('after a restart, /lineage-report rebuilds the last task from what was saved, both ways', async ($, on) => {
  const { tools, writes, files, turn, clock } = await start($, on, { openers: { 'xdg-open': 0 } })
  await turn('t1', async () => {
    await $.tool.call({ tool: 'Edit', file_path: MODEL, old_string: 'sum(amount) as revenue', new_string: 'sum(amount) * 2 as revenue' })
  })
  const saved = JSON.parse(writes.get(TASK_FILE)!)
  expect(saved.changes[0]).toMatchObject({ model: 'fct_orders', file: 'models/fct_orders.sql' })
  expect(saved.manifests).toEqual({ [ROOT]: frozen() })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.settle()
  const before = directional(tools).length
  // A commit in between moves HEAD but not the task, and the file is as the task left it.
  const out: any = await $.command.run({ command: 'lineage-report', args: '' } as any)
  expect(directional(tools).slice(before).map(one => `${one.direction}:${one.manifest_path === frozen()}`).sort()).toEqual(['downstream:true', 'upstream:true'])
  expect(out.text).toContain(`: ${REPORT}`)
  expect(embedded(writes.get(REPORT)!).movedOn).toEqual([])
  expect(files[MODEL]).toContain('* 2 as revenue')
})

test("when the task's copy of the manifest is gone it reads the project's and says so; with neither it asks for a compile", async ($, on) => {
  let gone = false
  const { copies, writes, turn, toasts, clock } = await start($, on, { openers: { 'xdg-open': 0 }, manifestGone: () => gone })
  await turn('t1', async () => {
    await $.tool.call({ tool: 'Edit', file_path: MODEL, old_string: 'sum(amount) as revenue', new_string: 'sum(amount) * 2 as revenue' })
  })
  copies.delete(frozen())
  await $.command.run({ command: 'lineage-report', args: '' } as any)
  expect(embedded(writes.get(REPORT)!).manifest).toBe("target/manifest.json as it is now, as the copy from the task's start is gone")
  gone = true
  const out: any = await $.command.run({ command: 'lineage-report', args: '' } as any)
  expect(out.text).toBe('The manifest this task was read from is gone. Run `dbt compile` and ask again.')
  await clock.settle()
  expect(toasts).toContain(out.text)
})

test('a plan going up for approval: the models it names, at the model level, without holding the dialog', async ($, on) => {
  const impact = (args: Record<string, any>) => (args.column ? {} : { test_count: 12, exposures: [], exposures_declared: 0 })
  const { tools, logs, dialogs, clock, turn, mcpAsked } = await start($, on, { impact })
  await $.turn.start({ text: 'plan it', turnId: 'p1' })
  await clock.settle()
  const plan = 'Round revenue in `fct_orders` (models/fct_orders.sql); check `stg_payments` and nothing_like_a_model.'
  await $.tool.call({ tool: 'ExitPlanMode', plan, planFilePath: '/plans/p.md' } as any)
  // The dialog opened before any lookup ran.
  expect(dialogs).toEqual([0])
  await clock.settle()
  expect(directional(tools).map(one => [one.model, one.column, one.manifest_path])).toEqual([
    ['model.shop.fct_orders', undefined, MANIFEST],
    ['model.shop.stg_payments', undefined, MANIFEST],
  ])
  expect(logs).toContain('◆ Before this plan · it names 2 dbt models · model level, nothing has changed yet · fct_orders · 6 downstream models · 12 tests · no exposures declared · stg_payments · 6 downstream models · 12 tests · no exposures declared')
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: 'fct_orders · 6 downstream models · 12 tests · no exposures declared' })).toBeDefined()
  expect(mcpAsked).toEqual([])
  // No report for a plan: nothing has changed.
  expect(await band.find({ key: 'lineage-report-open' })).toBeUndefined()
  expect(await band.find({ key: 'lineage-open' })).toBeDefined()

  // Approved, the task runs in the same turn: its summary takes the band.
  await $.tool.call({ tool: 'Edit', file_path: MODEL, old_string: 'sum(amount) as revenue', new_string: 'round(sum(amount), 2) as revenue' })
  await clock.settle()
  await $.turn.complete({ answer: 'Done.', durationMs: 5, isAborted: false, reason: 'answer', turnId: 'p1' } as any)
  await clock.settle()
  expect(await band.find({ type: 'Text', text: '◆ Lineage after this task · 1 model changed' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /Before this plan/ })).toBeUndefined()
  await band.unmount()
  await turn('t2', async () => {})
})

test('a failed upstream trace is asked again next time, and the band keeps its numbers', async ($, on) => {
  let up = false
  const { tools, writes, turn, clock } = await start($, on, { openers: { 'xdg-open': 0 }, impact: args => (args.direction === 'upstream' && !up ? { column_answer: null } : {}) })
  await turn('t1', async () => {
    await $.tool.call({ tool: 'Edit', file_path: MODEL, old_string: 'sum(amount) as revenue', new_string: 'sum(amount) * 2 as revenue' })
  })
  await $.command.run({ command: 'lineage-report', args: '' } as any)
  expect(embedded(writes.get(REPORT)!).focuses[0].up.error).toBe('This direction could not be traced.')
  up = true
  await $.command.run({ command: 'lineage-report', args: '' } as any)
  await clock.settle()
  expect(embedded(writes.get(REPORT)!).focuses[0].up.error).toBeNull()
  expect(directional(tools).map(one => one.direction)).toEqual(['downstream', 'upstream', 'downstream', 'upstream'])
})

test('with an altimate-code from before the column answer, the band and the report say to update it, not that the trace failed', async ($, on) => {
  const reachOnly = { column_answer: undefined, column_reach: { models: [{ name: 'rpt_orders', columns: ['revenue'] }], exposures: [] } }
  const { writes, turn } = await start($, on, { openers: { 'xdg-open': 0 }, impact: () => reachOnly })
  await turn('t1', async () => {
    await $.tool.call({ tool: 'Edit', file_path: MODEL, old_string: 'sum(amount) as revenue', new_string: 'sum(amount) * 2 as revenue' })
  })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: `  revenue  no column answer: update altimate-code to ${MIN_ALTIMATE_CODE} or later` })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /could not be traced/ })).toBeUndefined()
  await band.unmount()
  await $.command.run({ command: 'lineage-report', args: '' } as any)
  const focus = embedded(writes.get(REPORT)!).focuses[0]
  const update = `This altimate-code gives no column answer: update it to ${MIN_ALTIMATE_CODE} or later to trace the column.`
  expect([focus.down.error, focus.up.error]).toEqual([update, update])
  expect(focus.modelLevel).toBe(6)
})

test('a plan that names no model, or a subagent\'s, shows nothing; a new turn clears a plan\'s band; a plan file is the fallback', async ($, on) => {
  const { tools, logs, clock, files } = await start($, on)
  await $.turn.start({ text: 'plan it', turnId: 'p1' })
  await clock.settle()
  await $.tool.call({ tool: 'ExitPlanMode', plan: 'Tidy up the README.', planFilePath: '/plans/p.md' } as any)
  await clock.settle()
  await $.tool.call({ tool: 'ExitPlanMode', plan: 'Change `fct_orders`.', planFilePath: '/plans/p.md', agentId: 'a1' } as any)
  await clock.settle()
  expect(directional(tools)).toEqual([])
  expect(logs.filter(one => one.includes('Before this plan'))).toEqual([])

  files['/plans/q.md'] = 'Change `fct_orders`.'
  await $.tool.call({ tool: 'ExitPlanMode', planFilePath: '/plans/q.md' } as any)
  await clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /Before this plan · it names 1 dbt model/ })).toBeDefined()
  await $.turn.start({ text: 'never mind', turnId: 'p2' })
  await clock.settle()
  expect(await band.find({ type: 'Text', text: /Before this plan/ })).toBeUndefined()
  await band.unmount()
})

test('model files changed outside the edit tools are found through git, and only what changed this task', async ($, on) => {
  let changed: string[] = ['models/fct_orders.sql']
  const opts = { gitChanged: () => changed, head: { 'models/stg_payments.sql': PAYMENTS_SQL, 'macros/cents.sql': 'x', 'snapshots/orders_snap.sql': 'x' } }
  const { tools, files, turn } = await start($, on, opts)
  await turn('t1', async () => {
    // A sed in Bash: git sees the file, HEAD has its text before. fct_orders was already dirty
    // before the task and is untouched by it; a macro is not a model, and impact_analysis takes no snapshot.
    files[STAGING] = PAYMENTS_SQL.replace('amount_cents / 100 as amount', 'amount_cents / 100.0 as amount')
    files[MACRO] = 'changed'
    files[SNAPSHOT_SQL] = '{% snapshot orders_snap %}select id, upper(status) as status from orders{% endsnapshot %}'
    changed = ['models/fct_orders.sql', 'models/stg_payments.sql', 'macros/cents.sql', 'snapshots/orders_snap.sql']
  })
  expect(directional(tools).map(one => `${one.model}.${one.column}:${one.direction}`)).toEqual(['stg_payments.amount:downstream'])
})

test('a change to no output column falls back to the model-level count', async ($, on) => {
  const { tools, writes, turn } = await start($, on)
  await turn('t1', async () => {
    await $.tool.call({ tool: 'Edit', file_path: STAGING, old_string: "status = 'ok'", new_string: "status in ('ok', 'settled')" })
  })
  expect(directional(tools)).toEqual([{ manifest_path: frozen(), model: 'stg_payments', change_type: 'modify', direction: 'downstream' }])
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: 'stg_payments · 6 downstream models at model level' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: '  values may change downstream; the model-level count stands' })).toBeDefined()
  await band.unmount()
  await $.command.run({ command: 'lineage-report', args: '' } as any)
  expect(embedded(writes.get(REPORT)!).focuses[0]).toMatchObject({ model: 'stg_payments', column: null, modelLevel: 6 })
})

test('a task that changes no model shows nothing, and the next task clears the last summary', async ($, on) => {
  const { tools, turn } = await start($, on)
  await turn('t1', async () => {
    await $.tool.call({ tool: 'Edit', file_path: MODEL, old_string: 'sum(amount) as revenue', new_string: 'sum(amount) * 2 as revenue' })
  })
  await turn('t2', async () => {})
  expect(directional(tools).length).toBe(1)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ key: 'lineage-report-open' })).toBeUndefined()
  await band.unmount()
})

test('Open report on WSL falls back to explorer.exe, whose exit 1 is success; /lineage-report opens the last report', async ($, on) => {
  mock.env(on, { WSL_DISTRO_NAME: 'dev' })
  const { runs, turn, clock } = await start($, on, { openers: { 'explorer.exe': 1 } })
  await turn('t1', async () => {
    await $.tool.call({ tool: 'Edit', file_path: MODEL, old_string: 'sum(amount) as revenue', new_string: 'sum(amount) * 2 as revenue' })
  })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'lineage-report-open' })
  await clock.settle()
  expect(runs).toContainEqual(['wslview', REPORT])
  expect(runs).toContainEqual(['wslpath', '-w', REPORT])
  expect(runs).toContainEqual(['explorer.exe', '\\\\wsl.localhost\\dev\\repo\\target\\.altimate-lineage\\report.html'])
  // Opened: no fallback path is shown.
  expect(await band.find({ type: 'Text', text: /No browser opened/ })).toBeUndefined()
  await band.unmount()

  const out: any = await $.command.run({ command: 'lineage-report', args: '' } as any)
  expect(out.text).toMatch(/^Opened the column impact report for the task that finished at .* UTC: /)
  expect(out.text).toContain(REPORT)
})

test('on WSL with no wslview and no explorer.exe on PATH, Windows\' own explorer.exe opens the report', async ($, on) => {
  // The kernel release names Microsoft; WSL_DISTRO_NAME is unset.
  const { runs, turn, clock } = await start($, on, { uname: 'Linux 6.6.87.2-microsoft-standard-WSL2', openers: { '/mnt/c/Windows/explorer.exe': 1 }, present: ['/mnt/c/Windows/explorer.exe'] })
  await turn('t1', async () => {
    await $.tool.call({ tool: 'Edit', file_path: MODEL, old_string: 'sum(amount) as revenue', new_string: 'sum(amount) * 2 as revenue' })
  })
  const out: any = await $.command.run({ command: 'lineage-report', args: '' } as any)
  await clock.settle()
  const win = '\\\\wsl.localhost\\dev\\repo\\target\\.altimate-lineage\\report.html'
  const tried = runs.filter(one => ['wslview', 'explorer.exe', '/mnt/c/Windows/explorer.exe', 'xdg-open'].includes(one[0]!))
  expect(tried).toEqual([['wslview', REPORT], ['explorer.exe', win], ['/mnt/c/Windows/explorer.exe', win]])
  expect(out.text).toMatch(/^Opened the column impact report for the task that finished at .* UTC: /)
  expect(out.text).toContain(REPORT)
})

test('on WSL with no Windows opener at all, xdg-open is the last try', async ($, on) => {
  const { runs, turn } = await start($, on, { uname: 'Linux 6.6.87.2-microsoft-standard-WSL2', openers: { 'xdg-open': 0 } })
  await turn('t1', async () => {
    await $.tool.call({ tool: 'Edit', file_path: MODEL, old_string: 'sum(amount) as revenue', new_string: 'sum(amount) * 2 as revenue' })
  })
  const out: any = await $.command.run({ command: 'lineage-report', args: '' } as any)
  const tried = runs.filter(one => ['wslview', 'explorer.exe', '/mnt/c/Windows/explorer.exe', 'xdg-open'].includes(one[0]!)).map(one => one[0])
  expect(tried).toEqual(['wslview', 'explorer.exe', 'xdg-open'])
  expect(out.text).toMatch(/^Opened the column impact report for the task that finished at .* UTC: /)
  expect(out.text).toContain(REPORT)
})

test('when no browser opens, the band shows the report path as a link', async ($, on) => {
  const { runs, turn, clock } = await start($, on, { uname: 'Linux', openers: { 'xdg-open': 3 } })
  await turn('t1', async () => {
    await $.tool.call({ tool: 'Edit', file_path: MODEL, old_string: 'sum(amount) as revenue', new_string: 'sum(amount) * 2 as revenue' })
  })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'lineage-report-open' })
  await clock.settle()
  expect(runs).toContainEqual(['xdg-open', REPORT])
  expect(await band.find({ type: 'Text', text: /No browser opened/ })).toBeDefined()
  expect(await band.find({ type: 'Link' })).toBeDefined()
  await band.unmount()
})

test('each step of the report sends one usage event through the CLI, with the action and the session only', async ($, on) => {
  mock.env(on, {})
  const { runs, turn, clock } = await start($, on, { uname: 'Linux', openers: { 'xdg-open': 3 } })
  await turn('t1', async () => {
    await $.tool.call({ tool: 'Edit', file_path: MODEL, old_string: 'sum(amount) as revenue', new_string: 'sum(amount) * 2 as revenue' })
  })
  await clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'lineage-report-open' })
  await clock.settle()
  await $.command.run({ command: 'lineage-report', args: '' } as any)
  await clock.settle()
  await band.unmount()
  const events = runs.filter(argv => argv[2] === 'report-event')
  expect(events.map(argv => argv[3]).sort()).toEqual(['command_run', 'no_browser', 'no_browser', 'open_pressed', 'summary_shown'])
  for (const argv of events) {
    expect(argv.slice(0, 3)).toEqual(['altimate', 'tool', 'report-event'])
    expect(argv).toHaveLength(6)
    expect(argv[4]).toBe('--session')
    expect(argv[5]).toMatch(/^claude:[A-Za-z0-9_-]+$/)
  }
})

test('with ALTIMATE_TELEMETRY_DISABLED the report works as before and no usage event is sent: no CLI is started for one', async ($, on) => {
  mock.env(on, { ALTIMATE_TELEMETRY_DISABLED: 'true' })
  const { runs, turn, clock } = await start($, on, { uname: 'Linux', openers: { 'xdg-open': 3 } })
  await turn('t1', async () => {
    await $.tool.call({ tool: 'Edit', file_path: MODEL, old_string: 'sum(amount) as revenue', new_string: 'sum(amount) * 2 as revenue' })
  })
  await clock.settle()
  await $.command.run({ command: 'lineage-report', args: '' } as any)
  await clock.settle()
  expect(runs.some(argv => argv.includes('xdg-open'))).toBe(true)
  expect(runs.filter(argv => argv[2] === 'report-event')).toEqual([])
})

test("the summary's Open lineage button is a person opening the lineage pane: one plugin_feature_used lineage opened", async ($, on) => {
  mock.env(on, {})
  mock.store(on)
  const { runs, turn, clock } = await start($, on, { uname: 'Linux', openers: { 'xdg-open': 3 } })
  await turn('t1', async () => {
    await $.tool.call({ tool: 'Edit', file_path: MODEL, old_string: 'sum(amount) as revenue', new_string: 'sum(amount) * 2 as revenue' })
  })
  await clock.settle()
  const used = () => runs.filter(argv => argv[3] === 'plugin_feature_used').map(argv => [argv[argv.indexOf('--feature') + 1], argv[argv.indexOf('--outcome') + 1]])
  // The pane following the edit Claude made is not a person opening it.
  expect(used()).toEqual([])
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'lineage-open' })
  await clock.settle()
  await band.unmount()
  expect(used()).toEqual([['lineage', 'opened']])
})

test('macOS opens with open; /lineage-report before any report says so', async ($, on) => {
  const { runs, turn } = await start($, on, { uname: 'Darwin', openers: { open: 0 } })
  const none: any = await $.command.run({ command: 'lineage-report', args: '' } as any)
  expect(none.text).toBe('No column impact report yet: one can be built after a task changes a dbt model.')
  await turn('t1', async () => {
    await $.tool.call({ tool: 'Edit', file_path: MODEL, old_string: 'sum(amount) as revenue', new_string: 'sum(amount) * 2 as revenue' })
  })
  await $.command.run({ command: 'lineage-report', args: '' } as any)
  expect(runs).toContainEqual(['open', REPORT])
})

const COLUMN_REPORT = `${ROOT}/target/.altimate-lineage/column-report.html`

test('/lineage-report model.column opens that column\'s report, upstream first, with no task behind it, and leaves the task\'s report alone', async ($, on) => {
  const { tools, writes, runs, toasts, clock } = await start($, on, { openers: { 'xdg-open': 0 } })
  const out: any = await $.command.run({ command: 'lineage-report', args: ' fct_orders.revenue ' } as any)
  await clock.settle()
  expect(out.text).toBe(`Opened the column lineage report for fct_orders.revenue: ${COLUMN_REPORT}`)
  expect(toasts).toContain('Tracing fct_orders.revenue both ways…')
  expect(directional(tools).map(one => [one.direction, one.model, one.column, one.manifest_path]).sort()).toEqual([
    ['downstream', 'fct_orders', 'revenue', MANIFEST],
    ['upstream', 'fct_orders', 'revenue', MANIFEST],
  ])
  expect(runs).toContainEqual(['xdg-open', COLUMN_REPORT])
  const report = embedded(writes.get(COLUMN_REPORT)!)
  expect(report.lookup).toEqual({ model: 'fct_orders', column: 'revenue' })
  expect(report.title).toBe('Column lineage · fct_orders.revenue')
  expect(report.changes).toEqual([])
  expect(report.focuses[0].upstream.length).toBeGreaterThan(0)
  expect(writes.has(REPORT)).toBe(false)
  // Without an argument it is still the last task's report, and there is none.
  const none: any = await $.command.run({ command: 'lineage-report', args: '' } as any)
  expect(none.text).toBe('No column impact report yet: one can be built after a task changes a dbt model.')
})

test('/lineage-report with a model the manifest lacks, a column the model lacks, or no model.column says so plainly and opens nothing', async ($, on) => {
  const { runs, writes, tools } = await start($, on, {
    openers: { 'xdg-open': 0 },
    answer: args =>
      args.model === 'nope'
        ? { status: 'ok', output: 'Model "nope" not found in manifest. Available models: fct_orders, int_orders', metadata: { success: false } }
        : args.column === 'nothing'
          ? { status: 'ok', output: 'Impact', metadata: { success: true, model: 'fct_orders', column_answer_error: 'fct_orders has no column nothing; its columns are order_id, revenue' } }
          : undefined,
  })
  const model: any = await $.command.run({ command: 'lineage-report', args: 'nope.revenue' } as any)
  expect(model.text).toBe('Model "nope" not found in manifest. Available models: fct_orders, int_orders')
  const column: any = await $.command.run({ command: 'lineage-report', args: 'fct_orders.nothing' } as any)
  expect(column.text).toBe('fct_orders has no column nothing; its columns are order_id, revenue')
  const asked = tools.length
  for (const args of ['revenue', 'fct_orders.', '.revenue', 'fct orders.revenue']) {
    const usage: any = await $.command.run({ command: 'lineage-report', args } as any)
    expect(usage.text).toMatch(/^Usage: \/lineage-report for the last task's report, or \/lineage-report <model>\.<column>/)
  }
  expect(tools.length).toBe(asked)
  expect(runs.some(argv => argv[0] === 'xdg-open')).toBe(false)
  expect(writes.has(COLUMN_REPORT)).toBe(false)
})

test('/lineage-report takes a unique id as the model, the column after the last dot, and names the model as the CLI does', async ($, on) => {
  const { tools, writes } = await start($, on, { openers: { 'xdg-open': 0 }, impact: () => ({ model: 'fct_orders' }) })
  const out: any = await $.command.run({ command: 'lineage-report', args: 'model.shop.fct_orders.revenue' } as any)
  expect(out.text).toBe(`Opened the column lineage report for fct_orders.revenue: ${COLUMN_REPORT}`)
  expect(directional(tools).every(one => one.model === 'model.shop.fct_orders' && one.column === 'revenue')).toBe(true)
  expect(embedded(writes.get(COLUMN_REPORT)!).lookup).toEqual({ model: 'fct_orders', column: 'revenue' })
})

// What the engine answers for a column its manifest has no trace of: a well-formed answer that reaches nothing.
const NOT_IN_MANIFEST = (column: string) => ({
  version: 1,
  focus: { model: 'model.shop.stg_payments', column },
  direction: 'downstream',
  counts: { columns: 0, models: 0, ends: 0, hops: 0, may_carry_models: 0, model_level: 2 },
  nodes: [],
  columns: [],
})
// The manifest from before the task knows `amount`, with two models reading it, and nothing called `total`.
const PRE_TASK_ENGINE = (args: Record<string, any>) => (args.column === 'amount' ? {} : args.column ? { column_answer: NOT_IN_MANIFEST(args.column) } : {})
const SECOND_HOP = { ...DOWN, focus: { model: 'model.shop.stg_payments', column: 'amount' }, counts: { columns: 2, models: 2, hops: 1, ends: 2, may_carry_models: 0, model_level: 2 }, columns: [DOWN.columns[0]!, DOWN.columns[1]!, DOWN.columns[2]!], nodes: DOWN.nodes.slice(0, 3), edges: [], unresolved: [], may_carry: [], flags: [] }

test('a renamed column is never shown as reaching 0 columns in 0 models: the old name is traced in the pre-task manifest, and the new one, which it lacks, is said to be unknown', async ($, on) => {
  const { tools, turn, logs } = await start($, on, {
    impact: args => (args.column === 'amount' ? { column_answer: SECOND_HOP } : PRE_TASK_ENGINE(args)),
  })
  await turn('t1', async () => {
    await $.tool.call({ tool: 'Edit', file_path: STAGING, old_string: 'amount_cents / 100 as amount', new_string: 'amount_cents / 100 as total' })
  })
  expect(directional(tools).map(one => [one.column ?? null, one.manifest_path])).toEqual(
    expect.arrayContaining([
      ['amount', frozen()],
      ['total', frozen()],
    ]),
  )
  const line = logs.find(one => one.startsWith('◆ Lineage after this task'))!
  expect(line).not.toMatch(/reaches 0 columns in 0 models/)
  expect(line).toContain('amount  reaches 2 columns in 2 models')
  expect(line).toContain('total  not in the manifest from before the task (new in it?): its reach is unknown, not zero')
})

test('a column the queried manifest does not know is not shown as 0, even when the engine answers with an empty reach for it', async ($, on) => {
  const { turn, logs, writes, clock } = await start($, on, { impact: args => (args.column ? { column_answer: NOT_IN_MANIFEST(args.column) } : {}) })
  await turn('t1', async () => {
    await $.tool.call({ tool: 'Edit', file_path: MODEL, old_string: 'sum(amount) as revenue', new_string: 'sum(amount) * 2 as revenue' })
  })
  const line = logs.find(one => one.startsWith('◆ Lineage after this task'))!
  expect(line).not.toMatch(/reaches 0 columns/)
  expect(line).toContain('revenue  could not be traced')
  // The column was there before the task: the report does not call it new.
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'lineage-report-open' })
  await clock.settle()
  const impact = JSON.stringify(embedded(writes.get(REPORT)!).focuses[0].impact)
  expect(impact).toContain('could not be traced')
  expect(impact).not.toContain('not in the manifest from before the task')
  await band.unmount()
})

test('/lineage-report <model>.<column> on a package repo asks for the package\'s model by its unique_id, and for a name only integration_tests has as it is', async ($, on) => {
  const RUNNER = `${ROOT}/integration_tests`
  const THEIRS = `${RUNNER}/target/manifest.json`
  const { tools } = await start($, on, {
    noManifest: true,
    present: [THEIRS],
    openers: { 'xdg-open': 0 },
    extra: { [`${RUNNER}/dbt_project.yml`]: "name: 'shop_tests'\n", [`${RUNNER}/packages.yml`]: 'packages:\n  - local: ../\n' },
    // The package has no model named only_tests: the CLI says so for its unique_id.
    answer: args => (args.model === 'model.shop.only_tests' ? { status: 'ok', output: 'Model "model.shop.only_tests" not found in manifest.', metadata: { success: false } } : undefined),
  })
  await $.command.run({ command: 'lineage-report', args: 'fct_orders.revenue' } as any)
  expect(tools.filter(one => one.direction).map(one => one.model)).toEqual(['model.shop.fct_orders', 'model.shop.fct_orders'])
  tools.length = 0
  await $.command.run({ command: 'lineage-report', args: 'only_tests.revenue' } as any)
  expect(tools.filter(one => one.direction && one.model === 'only_tests').length).toBe(2)
})

test('/lineage-report on a column the manifest answers without reaching is a plain error, never a report that it reaches 0', async ($, on) => {
  const { runs, writes } = await start($, on, { openers: { 'xdg-open': 0 }, impact: args => (args.column ? { model: 'fct_orders', column_answer: NOT_IN_MANIFEST(args.column) } : {}) })
  const shown: any = await $.command.run({ command: 'lineage-report', args: 'fct_orders.fresh' } as any)
  expect(shown.text).toBe('fct_orders has no column fresh in target/manifest.json. Run `dbt parse` or `dbt compile` if it was just added, then ask again.')
  expect(runs.some(argv => argv[0] === 'xdg-open')).toBe(false)
  expect(writes.has(COLUMN_REPORT)).toBe(false)
})

test('a column found in the manifest with nothing downstream still says it reaches 0', async ($, on) => {
  const own = { ...NOT_IN_MANIFEST('revenue'), counts: { columns: 0, models: 0, ends: 0, hops: 0, may_carry_models: 0, model_level: 0 }, columns: [DOWN.columns[0]!], nodes: [DOWN.nodes[0]!] }
  const { turn, logs } = await start($, on, { impact: args => (args.column ? { column_answer: own } : {}) })
  await turn('t1', async () => {
    await $.tool.call({ tool: 'Edit', file_path: MODEL, old_string: 'sum(amount) as revenue', new_string: 'sum(amount) * 2 as revenue' })
  })
  expect(logs.find(one => one.startsWith('◆ Lineage after this task'))).toContain('revenue  reaches 0 columns in 0 models')
})

// Captured from altimate-code 0.12.11 for a model read by two models in a parse-only manifest (no compiled SQL).
const PARSE_ONLY_ANSWER = {
  "version": 1,
  "focus": {
    "model": "model.shop.stg_orders",
    "column": "amount"
  },
  "direction": "downstream",
  "inputs": {
    "manifest": {
      "generated_at": "2026-11-19T04:55:18.168655Z",
      "older_than_sql": false
    },
    "sql": "compiled_code",
    "catalog": null,
    "engine": "altimate-core 0.9.0",
    "workarounds": [
      "relations keyed database.schema.name",
      "ephemeral parents expanded",
      "parent columns = documented + own lineage targets + SELECT list",
      "aggregate FILTER clause dropped before analysis",
      "WITH nested inside a CTE reported unresolved",
      "reads with zero traced columns reported unresolved"
    ]
  },
  "counts": {
    "columns": 0,
    "models": 0,
    "hops": 0,
    "contracts": 0,
    "ends": 0,
    "may_carry_models": 2,
    "not_traced_models": 0,
    "model_level": 2
  },
  "nodes": [
    {
      "id": "model.shop.stg_orders",
      "name": "stg_orders",
      "folder": "model",
      "materialized": "view",
      "contract": false,
      "tests": 0,
      "exposures": []
    },
    {
      "id": "model.shop.order_report",
      "name": "order_report",
      "folder": "model",
      "materialized": "view",
      "contract": false,
      "tests": 0,
      "exposures": []
    },
    {
      "id": "model.shop.order_totals",
      "name": "order_totals",
      "folder": "model",
      "materialized": "view",
      "contract": false,
      "tests": 0,
      "exposures": []
    }
  ],
  "columns": [
    {
      "model": 0,
      "column": "amount",
      "hop": 0,
      "end": false,
      "how": null,
      "how_from": null
    }
  ],
  "edges": [],
  "also_reads": [],
  "unresolved": [
    {
      "model": 1,
      "reason": "no compiled SQL: run `dbt compile`",
      "code": "unresolved"
    },
    {
      "model": 2,
      "reason": "no compiled SQL: run `dbt compile`",
      "code": "unresolved"
    }
  ],
  "may_carry": [
    {
      "id": "model.shop.order_report",
      "name": "order_report",
      "reason": "unresolved"
    },
    {
      "id": "model.shop.order_totals",
      "name": "order_totals",
      "reason": "unresolved"
    }
  ],
  "flags": [],
  "consumers": {
    "declared": 0,
    "exposures": []
  },
  "truncated": false,
  "next": null
}

test('a column whose downstream models have no compiled SQL is not shown as reaching 0: the band, the log and the report say it is not traced', async ($, on) => {
  const { turn, logs, writes, clock } = await start($, on, { impact: args => (args.column ? { column_answer: PARSE_ONLY_ANSWER } : {}) })
  await turn('t1', async () => {
    await $.tool.call({ tool: 'Edit', file_path: MODEL, old_string: 'sum(amount) as revenue', new_string: 'sum(amount) * 2 as revenue' })
  })
  const line = logs.find(one => one.startsWith('◆ Lineage after this task'))!
  expect(line).not.toMatch(/reaches 0/)
  expect(line).toContain('revenue  not traced: 2 downstream models have no compiled SQL (run `dbt compile`)')
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: '  revenue  not traced: 2 downstream models have no compiled SQL (run `dbt compile`)' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: '  revenue  reaches 0 columns in 0 models (0 end columns) · 2 more may change' })).toBeUndefined()
  await band.press({ key: 'lineage-report-open' })
  await clock.settle()
  const report = embedded(writes.get(REPORT)!)
  expect(report.focuses[0].reach).toBeNull()
  expect(JSON.stringify(report.focuses[0].impact)).toContain('The reach of')
  expect(JSON.stringify(report.focuses[0].impact)).toContain('no compiled SQL')
  // The downstream section carries the reason, so the page never says no model carries the value.
  expect(report.focuses[0].down).toEqual({ hops: [], truncated: false, error: 'The reach is unknown: 2 downstream models have no compiled SQL (run `dbt compile`).' })
  await band.unmount()
})

test('with no manifest copied at the task start, a column added in the task is asked of the project\'s manifest as it is now', async ($, on) => {
  const { tools, turn } = await start($, on, { noManifest: true })
  await turn('t1', async () => {
    await $.tool.call({ tool: 'Edit', file_path: STAGING, old_string: 'amount_cents / 100 as amount', new_string: 'amount_cents / 100 as total' })
  })
  expect(directional(tools).some(one => one.column === 'total' && one.manifest_path === MANIFEST)).toBe(true)
})

test('a report on a task that added a column is built once: opening it again asks the CLI nothing more', async ($, on) => {
  const { tools, turn, clock } = await start($, on, { openers: { 'xdg-open': 0 }, impact: args => (args.column === 'amount' ? { column_answer: SECOND_HOP } : PRE_TASK_ENGINE(args)) })
  await turn('t1', async () => {
    await $.tool.call({ tool: 'Edit', file_path: STAGING, old_string: 'amount_cents / 100 as amount', new_string: 'amount_cents / 100 as total' })
  })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'lineage-report-open' })
  await clock.settle()
  const asked = directional(tools).length
  await band.press({ key: 'lineage-report-open' })
  await clock.settle()
  expect(directional(tools).length).toBe(asked)
  await band.unmount()
})

test('a column the SQL from before the task did not name but the manifest has (a select * spelled out) is traced by name, with its real reach', async ($, on) => {
  const { tools, turn, logs } = await start($, on, { impact: args => (args.column === 'amount' ? { column_answer: SECOND_HOP } : {}) })
  await turn('t1', async () => {
    await $.tool.call({ tool: 'Write', file_path: STAGING, content: 'select *\nfrom {{ source("raw", "payments") }}\n' })
  })
  const before = directional(tools).length
  await turn('t2', async () => {
    await $.tool.call({ tool: 'Write', file_path: STAGING, content: 'select\n  payment_id,\n  amount_cents / 100 as amount\nfrom {{ source("raw", "payments") }}\n' })
  })
  expect(directional(tools).slice(before).some(one => one.column === 'amount')).toBe(true)
  const line = logs.filter(one => one.startsWith('◆ Lineage after this task')).pop()!
  expect(line).toContain('amount  reaches 2 columns in 2 models')
  expect(line).not.toMatch(/not in the manifest from before the task/)
})

test('a model the task created, which the manifest from before it lacks, has its columns called new with an unknown reach, not an altimate-code to update', async ($, on) => {
  const NEW_MODEL = `${ROOT}/models/marts/region_revenue.sql`
  const { turn, logs } = await start($, on, {
    answer: args => (args.model === 'region_revenue' ? { status: 'ok', output: 'Model "region_revenue" not found in manifest. Available models: fct_orders, int_orders', metadata: { success: false, truncated: false } } : undefined),
  })
  await turn('t1', async () => {
    await $.tool.call({ tool: 'Write', file_path: NEW_MODEL, content: 'select\n  region,\n  sum(revenue) as revenue\nfrom {{ ref("fct_orders") }}\ngroup by 1\n' })
  })
  const line = logs.find(one => one.startsWith('◆ Lineage after this task'))!
  expect(line).toContain('region_revenue')
  expect(line).toContain('region  not in the manifest from before the task (new in it?): its reach is unknown, not zero')
  expect(line).not.toContain('update altimate-code')
})

test('a value change names the columns the manifest has that reach downstream; one that reaches nothing is left out, never shown as 0', async ($, on) => {
  const answerFor = (column: string, reach: number) => ({
    status: 'ok',
    output: 'Impact',
    metadata: {
      model_level: 2,
      column_answer: {
        version: 1, focus: { model: 'model.shop.fct_orders', column }, direction: 'downstream',
        nodes: [{ id: 'model.shop.fct_orders', name: 'fct_orders' }, { id: 'model.shop.rpt', name: 'rpt' }],
        columns: [{ model: 0, column, hop: 0 }, ...(reach ? [{ model: 1, column, hop: 1, end: true }] : [])],
        counts: { columns: reach, models: reach ? 1 : 0, ends: reach, hops: reach ? 1 : 0, may_carry_models: 0, model_level: 2 },
        unresolved: [], may_carry: [],
      },
    },
  })
  const { turn, clock } = await start($, on, {
    answer: args => (args.direction === 'downstream' && args.column ? answerFor(args.column, args.column === 'total_amount' ? 1 : 0) : undefined),
  })
  const sql = (expr: string) => `{% set cols %}\npaid_amount,\nunits,\n${expr} as total_amount\n{% endset %}\nselect {{ cols }} from {{ ref('x') }}`
  await turn('t1', async () => {
    await $.tool.call({ tool: 'Write', file_path: MODEL, content: sql('paid_amount + units') })
  })
  await turn('t2', async () => {
    await $.tool.call({ tool: 'Edit', file_path: MODEL, old_string: 'paid_amount + units as', new_string: 'paid_amount + units * 2 as' })
  })
  await clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /values may change in total_amount → reaches 1 column in 1 model/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /values may change in (paid_amount|units)/ })).toBeUndefined()
  expect(await band.find({ type: 'Text', text: /reaches 0 column/ })).toBeUndefined()
  await band.unmount()
})

test('value changes in two models: each model keeps up to three traced, so a second model\'s is not dropped by the first\'s', async ($, on) => {
  const answerFor = (model: string, column: string) => ({
    status: 'ok',
    output: 'Impact',
    metadata: {
      model_level: 2,
      column_answer: {
        version: 1, focus: { model: `model.shop.${model}`, column }, direction: 'downstream',
        nodes: [{ id: `model.shop.${model}`, name: model }, { id: 'model.shop.rpt', name: 'rpt' }],
        columns: [{ model: 0, column, hop: 0 }, { model: 1, column, hop: 1, end: true }],
        counts: { columns: 1, models: 1, ends: 1, hops: 1, may_carry_models: 0, model_level: 2 },
        unresolved: [], may_carry: [],
      },
    },
  })
  const { turn, logs } = await start($, on, { answer: args => (args.direction === 'downstream' && args.column ? answerFor(args.model, args.column) : undefined) })
  const sql = (expr: string) => `{% set cols %}\npaid_amount,\nunits,\n${expr} as total_amount\n{% endset %}\nselect {{ cols }} from {{ ref('x') }}`
  const other = (expr: string) => `{% set cols %}\n${expr} as fee\n{% endset %}\nselect {{ cols }} from {{ ref('y') }}`
  await turn('t1', async () => {
    await $.tool.call({ tool: 'Write', file_path: MODEL, content: sql('paid_amount + units') })
    await $.tool.call({ tool: 'Write', file_path: STAGING, content: other('base_fee') })
  })
  await turn('t2', async () => {
    await $.tool.call({ tool: 'Edit', file_path: MODEL, old_string: 'paid_amount + units as', new_string: 'paid_amount * 2 + units * 3 + discount as' })
    await $.tool.call({ tool: 'Edit', file_path: STAGING, old_string: 'base_fee as', new_string: 'base_fee * 2 as' })
  })
  const line = logs.filter(one => one.startsWith('◆ Lineage after this task')).at(-1)!
  // Three for fct_orders (its four names capped), two for stg_payments.
  expect(line.match(/values may change in \w+ → reaches/g)?.length).toBe(5)
  expect(line).toMatch(/stg_payments .*values may change in (base_fee|fee) → reaches 1 column/)
})

test('a value change on Tuva: the band says tracing until the trace answers, never that the model-level count stands, then the reach impact-first gave', async ($, on) => {
  const CLAIM = `${ROOT}/models/core/final/core__medical_claim.sql`
  let release!: () => void
  const held = new Promise<void>(resolve => (release = resolve))
  const ok = (metadata: Record<string, unknown>) => ({ status: 'ok', output: 'Impact', metadata })
  const { files, clock } = await start($, on, {
    answer: async args => {
      if (args.model !== 'core__medical_claim' || !args.direction) return undefined
      if (!args.column) return ok(TUVA_MODEL_LEVEL)
      if (args.column !== 'paid_amount') return ok({ ...TUVA_MODEL_LEVEL, column_answer_error: `no column ${args.column}` })
      await held
      return ok(TUVA_PAID_AMOUNT)
    },
  })
  files[CLAIM] = TUVA_MEDICAL_CLAIM_SQL
  await $.turn.start({ text: 'treat negative paid_amount as 0', turnId: 't1' })
  await clock.settle()
  await $.tool.call({ tool: 'Edit', file_path: CLAIM, old_string: '    , med.paid_amount\n', new_string: '    , case when med.paid_amount < 0 then 0 else med.paid_amount end as paid_amount\n' })
  await clock.settle()
  await $.turn.complete({ answer: 'Done.', durationMs: 5, isAborted: false, reason: 'answer', turnId: 't1' } as any)
  await clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  // While paid_amount is traced: no line that reads as the answer.
  expect(await band.find({ type: 'Text', text: /model-level count stands/ })).toBeUndefined()
  expect(await band.find({ type: 'Text', text: '  tracing…' })).toBeDefined()
  release()
  await clock.settle()
  expect(await band.find({ type: 'Text', text: 'core__medical_claim · 97 downstream models at model level' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /^  values may change in paid_amount → reaches 124 columns in 13 models/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /model-level count stands/ })).toBeUndefined()
  await band.unmount()
})

test('a package repo with no manifest of its own: the band reads the manifest integration_tests writes, its copy beside it', async ($, on) => {
  const RUNNER = `${ROOT}/integration_tests`
  const THEIRS = `${RUNNER}/target/manifest.json`
  const { turn, runs, tools } = await start($, on, {
    noManifest: true,
    present: [THEIRS],
    extra: { [`${RUNNER}/dbt_project.yml`]: "name: 'shop_tests'\n", [`${RUNNER}/packages.yml`]: 'packages:\n  - local: ../\n' },
  })
  await turn('t1', async () => {
    await $.tool.call({ tool: 'Edit', file_path: MODEL, old_string: 'sum(amount) as revenue', new_string: 'sum(amount) * 2 as revenue' })
  })
  const copy = runs.find(one => one[0] === 'cp')
  expect(copy?.slice(1, 2)).toEqual([THEIRS])
  expect(copy?.[2]?.startsWith(`${RUNNER}/target/.altimate-manifest-before.`)).toBe(true)
  const asked = tools.filter(one => one.direction === 'downstream' && one.column === 'revenue')
  expect(asked.length).toBeGreaterThan(0)
  expect(asked.every(one => String(one.manifest_path).startsWith(`${RUNNER}/target/.altimate-task-manifest.`))).toBe(true)
  // integration_tests' manifest holds its own models too: the package's is asked for by its unique_id.
  expect(asked.every(one => one.model === 'model.shop.fct_orders')).toBe(true)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /revenue\s+reaches/ })).toBeDefined()
  await band.unmount()
})

test('a task that changes a package model and an integration_tests model copies their one manifest once, and both read it', async ($, on) => {
  const RUNNER = `${ROOT}/integration_tests`
  const THEIRS = `${RUNNER}/target/manifest.json`
  const TEST_MODEL = `${RUNNER}/models/orders_check.sql`
  const { turn, runs, tools, copies } = await start($, on, {
    noManifest: true,
    present: [THEIRS],
    extra: {
      [`${RUNNER}/dbt_project.yml`]: "name: 'shop_tests'\nmodel-paths: ['models']\n",
      [`${RUNNER}/packages.yml`]: 'packages:\n  - local: ../\n',
      [TEST_MODEL]: 'select\n  order_id,\n  revenue as checked\nfrom {{ ref("fct_orders") }}\n',
    },
  })
  await turn('t1', async () => {
    await $.tool.call({ tool: 'Edit', file_path: MODEL, old_string: 'sum(amount) as revenue', new_string: 'sum(amount) * 2 as revenue' })
    await $.tool.call({ tool: 'Edit', file_path: TEST_MODEL, old_string: 'revenue as checked', new_string: 'revenue * 2 as checked' })
  })
  expect(runs.filter(one => one[0] === 'cp').map(one => one[1])).toEqual([THEIRS])
  const asked = tools.filter(one => one.direction === 'downstream' && (one.column === 'revenue' || one.column === 'checked'))
  expect(new Set(asked.map(one => one.column))).toEqual(new Set(['revenue', 'checked']))
  const paths = new Set(asked.map(one => String(one.manifest_path)))
  expect(paths.size).toBe(1)
  const [frozen] = [...paths]
  expect(frozen!.startsWith(`${RUNNER}/target/.altimate-task-manifest.`)).toBe(true)
  expect(copies.has(frozen!)).toBe(true)
})

test('a task that changes four output columns traces three and says one more changed', async ($, on) => {
  const NEW_MODEL = `${ROOT}/models/marts/monthly_region_revenue.sql`
  const { turn, logs } = await start($, on, {
    answer: args => (args.model === 'monthly_region_revenue' ? { status: 'ok', output: 'Model "monthly_region_revenue" not found in manifest.', metadata: { success: false, truncated: false } } : undefined),
  })
  await turn('t1', async () => {
    await $.tool.call({ tool: 'Write', file_path: NEW_MODEL, content: 'select\n  region,\n  order_month,\n  count(*) as orders,\n  sum(amount) as revenue\nfrom {{ ref("fct_orders") }}\ngroup by 1, 2\n' })
  })
  const line = logs.find(one => one.startsWith('◆ Lineage after this task'))!
  expect(line.match(/new in it\?/g)?.length).toBe(3)
  expect(line).toContain('+ 1 more changed column, not traced here (/lineage-report monthly_region_revenue.<column> traces one)')
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: '  + 1 more changed column, not traced here (/lineage-report monthly_region_revenue.<column> traces one)' })).toBeDefined()
  await band.unmount()
})
