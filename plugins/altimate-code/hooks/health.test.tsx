import { expect, mock, test } from 'claude-code/testing'

import { bandText, isGitPush, modelNamesInYaml, modelsOfFile, newIssues, pairKey, pushRefusal, reportText, toolArgs } from './features/health'

const ROOT = '/repo'
const STG = `${ROOT}/models/staging/stg_orders.sql`
const FCT = `${ROOT}/models/marts/fct_orders.sql`
const NOTES = `${ROOT}/README.md`

const BAND = {
  plugin: 'altimate-code',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const insight = (id: string, path: string, name: string, message = `${name} found`) => ({
  uniqueId: `model.shop.${id}`,
  path,
  name,
  severity: 'WARNING',
  message,
  recommendation: `Fix ${name}`,
})

// What the project already has before Claude changes anything.
const OLD_STG = insight('stg_orders', 'models/staging/stg_orders.sql', 'Missing documentation')
const OLD_FCT = insight('fct_orders', 'models/marts/fct_orders.sql', 'Missing tests')
// What a change adds.
const NEW_STG = insight('stg_orders', 'models/staging/stg_orders.sql', 'Hard coded references', 'stg_orders reads raw.orders directly')
const NEW_FCT = insight('fct_orders', 'models/marts/fct_orders.sql', 'Model fanout', 'fct_orders has 4 direct children')

type Options = {
  /** The tool's insights, per run (the last repeats). */
  runs: ReturnType<typeof insight>[][]
  /** What the CLI prints instead of an answer. */
  cliStdout?: string
  yaml?: Record<string, string>
}

async function start($: any, on: any, options: Options) {
  const clock = mock.clock(on)
  const calls: { tool: string; args: Record<string, unknown>; argv: readonly string[] }[] = []
  const toasts: string[] = []
  const statuses: string[] = []
  on('command.register', () => ({ value: { command: 'health' } }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('session.end', () => ({ sessionId: 'test' }))
  on('turn.complete', (_: unknown, e: { answer: string }) => ({ text: e.answer }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT }))
  on('ui.toast', (_: unknown, e: { text: string }) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_: unknown, e: { text?: string }) => {
    statuses.push(String(e.text ?? ''))
    return { value: undefined }
  })
  on('ui.render', ($$: any, e: any) => {
    const { Box } = $$.ui.resolve(e)
    return <Box key="engine" />
  })
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: e.path === `${ROOT}/dbt_project.yml` }))
  on('fs.read', (_: unknown, e: { path: string }) => ({ value: options.yaml?.[e.path] ?? '' }))
  on('tool.list', () => ({ value: [] }))
  on('mcp.connect', () => ({ value: { isConnected: false, reason: 'not_connected', message: 'off' } }))
  on('tool.call', () => ({ result: { ok: true } }))
  let run = 0
  on('process.run', (_: unknown, e: { argv: readonly string[] }) => {
    const [, command, , tool = ''] = e.argv
    if (command !== 'tool') return { value: { exitCode: 1, stdout: '', stderr: 'not this test' } }
    const args = JSON.parse(String(e.argv[e.argv.indexOf('--args') + 1] ?? '{}'))
    calls.push({ tool, args, argv: e.argv })
    if (options.cliStdout !== undefined) return { value: { exitCode: 0, stdout: options.cliStdout, stderr: '' } }
    const insights = options.runs[Math.min(run++, options.runs.length - 1)]
    return { value: { exitCode: 0, stdout: JSON.stringify({ status: 'ok', output: '', metadata: { success: true, insights } }), stderr: '' } }
  })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.settle()
  return { clock, calls, toasts, statuses }
}

async function endTurn($: any, clock: any, id: string) {
  await $.turn.complete({ answer: 'Done.', durationMs: 5, isAborted: false, reason: 'answer', turnId: id } as any)
  await clock.settle()
}

const edit = (file: string) => ({ tool: 'Edit' as const, file_path: file, old_string: 'a', new_string: 'b' })

test('a baseline run at session start; a changed model with a new insight shows in the band, not the ones the project already had', async ($, on) => {
  const { clock, calls, toasts, statuses } = await start($, on, { runs: [[OLD_STG, OLD_FCT], [OLD_STG, OLD_FCT, NEW_STG, NEW_FCT]] })
  expect(calls.map(c => c.tool)).toEqual(['dbt_health'])
  // The check starts the dbt adapter, so it asks for write permission.
  expect(calls[0]!.argv).toContain('--allow-write')

  await $.tool.call(edit(STG))
  await endTurn($, clock, 't1')

  expect(calls).toHaveLength(2)
  // fct_orders has a new insight too, but Claude did not change it.
  expect(toasts).toEqual(['◆ 1 new health issue · stg_orders: hard coded references · /health'])
  expect(statuses.at(-1)).toContain('1 health issue')
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: '1 new health issue · stg_orders: hard coded references · /health' })).toBeDefined()
  await band.unmount()
})

test('two changed models give "2 new health issues" with the first model named', async ($, on) => {
  const { clock } = await start($, on, { runs: [[OLD_STG], [OLD_STG, NEW_STG, NEW_FCT]] })
  await $.tool.call(edit(STG))
  await $.tool.call(edit(FCT))
  await endTurn($, clock, 't1')
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /2 new health issues · stg_orders: hard coded references \(\+1 more model\) · \/health/ })).toBeDefined()
  await band.unmount()
})

test('a turn that changed no model file runs no check; other files are ignored', async ($, on) => {
  const { clock, calls, toasts } = await start($, on, { runs: [[OLD_STG], [OLD_STG, NEW_STG]] })
  await $.tool.call(edit(NOTES))
  await endTurn($, clock, 't1')
  expect(calls).toHaveLength(1)
  expect(toasts).toEqual([])
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /health issue/ })).toBeUndefined()
  await band.unmount()
})

test('an insight the baseline already had is not new', async ($, on) => {
  const { clock, toasts } = await start($, on, { runs: [[OLD_STG], [OLD_STG]] })
  await $.tool.call(edit(STG))
  await endTurn($, clock, 't1')
  expect(toasts).toEqual([])
})

test('a changed properties file checks the models it lists', async ($, on) => {
  const yml = `${ROOT}/models/staging/_staging.yml`
  const { clock, toasts } = await start($, on, {
    runs: [[], [NEW_STG]],
    yaml: { [yml]: 'version: 2\nmodels:\n  - name: stg_orders\n    description: orders\n' },
  })
  await $.tool.call(edit(yml))
  await endTurn($, clock, 't1')
  expect(toasts).toEqual(['◆ 1 new health issue · stg_orders: hard coded references · /health'])
})

test('git push goes through by default (the setting is off), with new issues open', async ($, on) => {
  const { clock } = await start($, on, { runs: [[], [NEW_STG]] })
  await $.tool.call(edit(STG))
  await endTurn($, clock, 't1')
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /1 new health issue/ })).toBeDefined()
  await band.unmount()
  const allowed: any = await $.tool.call({ tool: 'Bash', command: 'git push origin main' } as any)
  expect(allowed?.deny).toBeUndefined()
})

test('with healthBlocksPush on, git push is refused while new issues exist and the refusal lists them; nothing else is', () => {
  const denied = pushRefusal(true, 'git add -A && git push origin feat/x', [NEW_STG, NEW_FCT])
  expect(denied?.deny).toContain('git push is held: the models changed this session have 2 new project health issues.')
  expect(denied?.deny).toContain('- stg_orders: hard coded references (warning) stg_orders reads raw.orders directly')
  expect(denied?.deny).toContain('- fct_orders: model fanout (warning) fct_orders has 4 direct children')
  expect(pushRefusal('true', 'git push', [NEW_STG])?.deny).toContain('1 new project health issue.')
  // Setting off, no issues, or not a push.
  expect(pushRefusal(false, 'git push', [NEW_STG])).toBeNull()
  expect(pushRefusal(true, 'git push', [])).toBeNull()
  expect(pushRefusal(true, 'git status', [NEW_STG])).toBeNull()
})

test('the configured config path is passed to the tool, empty means the defaults', () => {
  expect(toolArgs('datapilot.yml')).toEqual({ config_path: 'datapilot.yml' })
  expect(toolArgs('  datapilot.yml ')).toEqual({ config_path: 'datapilot.yml' })
  expect(toolArgs('')).toEqual({})
  expect(toolArgs(undefined)).toEqual({})
})

test('a CLI without the tool, or a tool that refuses, is said once and never blocks a push', async ($, on) => {
  const { clock, toasts } = await start($, on, {
    runs: [[]],
    cliStdout: JSON.stringify({ status: 'error', output: 'DataPilot isn\'t installed in python3. Install the `altimate-datapilot-cli` package', metadata: { success: false, insights: [] } }),
  })
  await $.tool.call(edit(STG))
  await endTurn($, clock, 't1')
  await $.tool.call(edit(STG))
  await endTurn($, clock, 't2')
  expect(toasts).toEqual([])
  const push: any = await $.tool.call({ tool: 'Bash', command: 'git push' } as any)
  expect(push?.deny).toBeUndefined()
})

test('the pure helpers', () => {
  expect(isGitPush('git push')).toBe(true)
  expect(isGitPush('git -C sub push origin x')).toBe(true)
  expect(isGitPush('GIT_SSH=ssh git push --force')).toBe(true)
  expect(isGitPush('git add . && git push')).toBe(true)
  expect(isGitPush('git pushd')).toBe(false)
  expect(isGitPush('echo git push')).toBe(false)
  expect(isGitPush('git status')).toBe(false)

  expect(pairKey(NEW_STG)).toBe('model.shop.stg_orders\u0000Hard coded references')
  expect([...modelsOfFile(STG, [OLD_STG, OLD_FCT])]).toEqual(['model.shop.stg_orders'])
  expect([...modelsOfFile('/elsewhere/other.sql', [OLD_STG])]).toEqual([])
  expect(newIssues([OLD_STG, NEW_STG, NEW_FCT], [pairKey(OLD_STG)], new Set(['model.shop.stg_orders']))).toEqual([NEW_STG])
  expect(modelNamesInYaml('version: 2\nmodels:\n  - name: a\n  - name: "b"\nsources:\n  - name: c\n')).toEqual(['a', 'b'])
  expect(bandText([NEW_STG])).toBe('1 new health issue · stg_orders: hard coded references · /health')
  expect(reportText([NEW_STG])).toBe('- stg_orders: hard coded references (warning) stg_orders reads raw.orders directly → Fix Hard coded references')
})
