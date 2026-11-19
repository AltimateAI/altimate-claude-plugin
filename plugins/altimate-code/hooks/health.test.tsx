import { expect, mock, test as engineTest } from 'claude-code/testing'

import { PHASE_TIMEOUT_MS } from './tool-chain'
import { GATE_WAIT_MS, bandText, canonical, configPathProblem, filesWrittenBy, isGitPush, modelsOfFiles, newIssues, pairKey, pushRefusal, reportText, simpleCommands, toolArgs } from './features/health'

// These tests are about the health check's own lines: the dbt helpers (their doctor and compile lines) are left off.
const test = ((name: string, ...rest: any[]) => {
  const body = rest[rest.length - 1]
  if (typeof body !== 'function' || body.length === 0) return (engineTest as any)(name, ...rest)
  const given = rest.length === 2 ? rest[0] : {}
  return (engineTest as any)(name, { ...given, options: { dbt_mods: false, ...given.options } }, body)
}) as typeof engineTest

const ROOT = '/repo'
const STG = `${ROOT}/models/staging/stg_orders.sql`
const STG_YML = `${ROOT}/models/staging/_staging.yml`
const FCT = `${ROOT}/models/marts/fct_orders.sql`
const NOTES = `${ROOT}/README.md`

const BAND = {
  plugin: 'altimate-code',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const insight = (id: string, file: string, name: string, message = `${name} found`, properties = '') => ({
  uniqueId: `model.shop.${id}`,
  path: file.replace(`${ROOT}/`, ''),
  name,
  severity: 'WARNING',
  message,
  recommendation: `Fix ${name}`,
  file,
  properties,
})

// What the project already has before Claude changes anything.
const OLD_STG = insight('stg_orders', STG, 'Missing documentation', undefined, STG_YML)
const OLD_FCT = insight('fct_orders', FCT, 'Missing tests')
// What a change adds.
const NEW_STG = insight('stg_orders', STG, 'Hard coded references', 'stg_orders reads raw.orders directly', STG_YML)
const NEW_FCT = insight('fct_orders', FCT, 'Model fanout', 'fct_orders has 4 direct children')
// A model of a dependency package: it has no files in the project.
const DEP = { ...insight('base', '', 'Missing tests'), uniqueId: 'model.dep.base', path: 'models/base.sql' }

type Options = {
  /** The tool's answer per run (the last repeats). */
  runs: (ReturnType<typeof insight>[] | { fail: string } | { stale: string } | { truncated: true } | { missing: true } | { refused: true })[]
  /** Holds the run with this index (from 0) until released. */
  hold?: { at: number; until: Promise<void> }
  /** Folders that hold a dbt_project.yml (default: the repo). */
  projects?: string[]
  /** Folders the engine resolves to another real folder (a symlink); any other folder is unknown to it. */
  realFolders?: Record<string, string>
  /** Holds the first folder lookup until released. */
  holdStat?: Promise<void>
  /** Called with the number of each folder lookup (from 1). */
  onStat?: (n: number) => Promise<void> | void
  /** The folder the session's shell is in (default: the engine does not say). */
  cwd?: string
  /** Holds the folder lookup while it returns a promise. */
  holdCwd?: () => Promise<void> | undefined
  /** Called when the Bash command itself runs, between the gate and the after-phase. */
  onCall?: () => Promise<void> | void
  /** Called at each project lookup; a promise it returns holds the lookup. */
  onExists?: () => Promise<void> | void
}

async function start($: any, on: any, options: Options, session: { isInteractive?: boolean } = {}) {
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
  if (options.cwd || options.holdCwd)
    on('session.cwd', async () => {
      await options.holdCwd?.()
      return { value: options.cwd }
    })
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
  const projects = options.projects ?? [ROOT]
  on('fs.exists', async (_: unknown, e: { path: string }) => {
    await options.onExists?.()
    return { value: projects.some(p => e.path === `${p}/dbt_project.yml`) }
  })
  let statHeld = false
  let stats = 0
  on('fs.stat', async (_: unknown, e: { path: string }) => {
    await options.onStat?.(++stats)
    if (options.holdStat && !statHeld) {
      statHeld = true
      await options.holdStat
    }
    const real = options.realFolders?.[e.path]
    if (real === undefined) throw new Error('ENOENT')
    return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: true, realPath: real } }
  })
  on('fs.read', () => ({ value: '' }))
  on('tool.list', () => ({ value: [] }))
  on('mcp.connect', () => ({ value: { isConnected: false, reason: 'not_connected', message: 'off' } }))
  on('tool.call', async () => {
    await options.onCall?.()
    return { result: { ok: true } }
  })
  let run = 0
  on('process.run', async (_: unknown, e: { argv: readonly string[] }) => {
    const [, command, , tool = ''] = e.argv
    if (command !== 'tool') return { value: { exitCode: 1, stdout: '', stderr: 'not this test' } }
    const args = JSON.parse(String(e.argv[e.argv.indexOf('--args') + 1] ?? '{}'))
    const index = run++
    calls.push({ tool, args, argv: e.argv })
    if (options.hold?.at === index) await options.hold.until
    const answer = options.runs[Math.min(index, options.runs.length - 1)]!
    if ('missing' in answer) return { deny: 'spawn ENOENT' }
    if ('refused' in answer) return { deny: 'failed to spawn: operation not permitted' }
    const metadata =
      'fail' in answer ? { success: false, insights: [] } : 'truncated' in answer ? { success: true, insights: [], truncated: true, total: 9999 } : 'stale' in answer ? { success: true, insights: [OLD_STG], stale_manifest: { message: answer.stale } } : { success: true, insights: answer }
    const output = 'fail' in answer ? answer.fail : ''
    return { value: { exitCode: 0, stdout: JSON.stringify({ status: 'ok', output, metadata }), stderr: '' } }
  })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: session.isInteractive ?? true })
  await clock.settle()
  return { clock, calls, toasts, statuses }
}

async function endTurn($: any, clock: any, id: string) {
  await $.turn.complete({ answer: 'Done.', durationMs: 5, isAborted: false, reason: 'answer', turnId: id } as any)
  await clock.settle()
}

const edit = (file: string) => ({ tool: 'Edit' as const, file_path: file, old_string: 'a', new_string: 'b' })
const command = (text: string) => ({ tool: 'Bash' as const, command: text }) as any

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

test('a model inside an installed package with its own dbt_project.yml is not a model file: no check runs', async ($, on) => {
  const { clock, calls } = await start($, on, { runs: [[OLD_STG], [OLD_STG, NEW_STG]], projects: [ROOT, `${ROOT}/dbt_packages/dep`] })
  await $.tool.call(edit(`${ROOT}/dbt_packages/dep/models/x.sql`))
  await endTurn($, clock, 't1')
  expect(calls).toHaveLength(1)
})

test('a model of a project nested in the session\'s own is not counted as checked: no second check runs', async ($, on) => {
  const { clock, calls } = await start($, on, { runs: [[OLD_STG], [OLD_STG, NEW_STG]], projects: [ROOT, `${ROOT}/nested`] })
  await $.tool.call(edit(`${ROOT}/nested/models/x.sql`))
  await endTurn($, clock, 't1')
  expect(calls).toHaveLength(1)
})

test('an edit spelled by the real path of the session\'s symlinked project is still an edit of its own project', async ($, on) => {
  const real = '/private/shop'
  const file = `${real}/models/staging/stg_orders.sql`
  const stg = { ...NEW_STG, file, properties: '' }
  const old = { ...OLD_STG, file, properties: '' }
  const { clock, toasts } = await start($, on, {
    runs: [[old], [old, stg]],
    projects: [ROOT, real],
    realFolders: { [ROOT]: real, [real]: real },
  })
  await $.tool.call(edit(file))
  await endTurn($, clock, 't1')
  expect(toasts).toEqual(['◆ 1 new health issue · stg_orders: hard coded references · /health'])
})

test('README, dbt_project.yml, profiles, CI and dbt_packages files are not model files: no check runs', async ($, on) => {
  const { clock, calls, toasts } = await start($, on, { runs: [[OLD_STG], [OLD_STG, NEW_STG]] })
  for (const file of [NOTES, `${ROOT}/dbt_project.yml`, `${ROOT}/profiles.yml`, `${ROOT}/.github/workflows/ci.yml`, `${ROOT}/dbt_packages/dep/models/x.sql`, `${ROOT}/target/compiled/x.sql`])
    await $.tool.call(edit(file))
  await endTurn($, clock, 't1')
  expect(calls).toHaveLength(1)
  expect(toasts).toEqual([])
})

test('a .sql file outside any dbt project is not a model file', async ($, on) => {
  const { clock, calls } = await start($, on, { runs: [[OLD_STG]] })
  await $.tool.call(edit('/elsewhere/query.sql'))
  await endTurn($, clock, 't1')
  expect(calls).toHaveLength(1)
})

test('an insight the baseline already had is not new', async ($, on) => {
  const { clock, toasts } = await start($, on, { runs: [[OLD_STG], [OLD_STG]] })
  await $.tool.call(edit(STG))
  await endTurn($, clock, 't1')
  expect(toasts).toEqual([])
})

test('a changed properties file checks the models it documents, and a dependency package model is never a changed model', async ($, on) => {
  const { clock, toasts } = await start($, on, { runs: [[], [NEW_STG, DEP]] })
  await $.tool.call(edit(STG_YML))
  await endTurn($, clock, 't1')
  expect(toasts).toEqual(['◆ 1 new health issue · stg_orders: hard coded references · /health'])
})

test('a model dropped from a schema file that still documents others is held for its new issues', async ($, on) => {
  const dropped = insight('fct_orders', FCT, 'Missing documentation')
  const { clock, toasts } = await start($, on, { runs: [[OLD_STG], [OLD_STG, dropped]] })
  await $.tool.call(edit(STG_YML))
  await endTurn($, clock, 't1')
  expect(toasts).toEqual(['◆ 1 new health issue · fct_orders: missing documentation · /health'])
})

test('a model file Bash writes counts like one Claude edited; a command naming no model file starts no check', async ($, on) => {
  const { clock, calls, toasts } = await start($, on, { runs: [[], [NEW_STG]] })
  await $.tool.call(command('ls -la && git status'))
  await endTurn($, clock, 't0')
  expect(calls).toHaveLength(1)
  await $.tool.call(command(`sed -i 's/a/b/' ${STG}`))
  await endTurn($, clock, 't1')
  expect(calls).toHaveLength(2)
  expect(toasts).toEqual(['◆ 1 new health issue · stg_orders: hard coded references · /health'])
})

test('edits made while a check runs are checked by the next one, not dropped', async ($, on) => {
  let release!: () => void
  const until = new Promise<void>(resolve => (release = resolve))
  // Run 0 is the baseline; run 1 (turn 1's check) is held; run 2 follows for turn 2's edit.
  const { clock, calls, toasts } = await start($, on, { runs: [[], [], [NEW_FCT]], hold: { at: 1, until } })
  await $.tool.call(edit(STG))
  await endTurn($, clock, 't1')
  expect(calls).toHaveLength(2)

  await $.tool.call(edit(FCT))
  await endTurn($, clock, 't2')
  // Turn 1's check is still running: no second run starts beside it.
  expect(calls).toHaveLength(2)

  release()
  await clock.settle()
  expect(calls).toHaveLength(3)
  expect(toasts).toEqual(['◆ 1 new health issue · fct_orders: model fanout · /health'])
})

test('edits made before the baseline lands are checked once it has', async ($, on) => {
  let release!: () => void
  const until = new Promise<void>(resolve => (release = resolve))
  const { clock, calls, toasts } = await start($, on, { runs: [[], [NEW_STG]], hold: { at: 0, until } })
  expect(calls).toHaveLength(1)
  await $.tool.call(edit(STG))
  await endTurn($, clock, 't1')
  // The baseline is still running: nothing else starts beside it.
  expect(calls).toHaveLength(1)
  release()
  await clock.settle()
  expect(calls).toHaveLength(2)
  expect(toasts).toEqual(['◆ 1 new health issue · stg_orders: hard coded references · /health'])
})

test('a failed check is not read as a clean one: it is told, and the next change asks again', async ($, on) => {
  const { clock, calls, toasts } = await start($, on, {
    runs: [{ fail: "DataPilot isn't installed in python3. Install the `altimate-datapilot-cli` package" }, [OLD_STG], [OLD_STG, NEW_STG]],
  })
  expect(toasts).toEqual(["◆ Project health: DataPilot isn't installed in python3. Install the `altimate-datapilot-cli` package"])

  // The baseline failed: a change asks for it again, which now answers after the edit; the old issues of
  // the edited model cannot be told from the new, so the next check reports all of them.
  await $.tool.call(edit(STG))
  await endTurn($, clock, 't1')
  expect(calls).toHaveLength(3)
  expect(toasts).toHaveLength(2)
  expect(toasts[1]).toBe('◆ 2 new health issues · stg_orders: missing documentation · /health')
})

test('a model folder file named like a dbt root file is a properties file; a path spelled with ./ or .. is the same file', async ($, on) => {
  const { clock, calls } = await start($, on, { runs: [[OLD_STG], [OLD_STG, NEW_STG]] })
  await $.tool.call(edit(`${ROOT}/models/staging/../staging/./profiles.yml`))
  await endTurn($, clock, 't1')
  expect(calls).toHaveLength(2)
  await $.tool.call(edit(`${ROOT}/profiles.yml`))
  await endTurn($, clock, 't2')
  expect(calls).toHaveLength(2)
})

test('a relative spelling of the model file still matches the model the tool names', async ($, on) => {
  const { clock } = await start($, on, { runs: [[], [NEW_STG]] })
  await $.tool.call(edit('./models/./staging/stg_orders.sql'))
  await endTurn($, clock, 't1')
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /1 new health issue/ })).toBeDefined()
  await band.unmount()
})

test('the same problem at every turn is told once', async ($, on) => {
  const { clock, toasts } = await start($, on, { runs: [{ fail: "the dbt adapter didn't start" }] })
  await $.tool.call(edit(STG))
  await endTurn($, clock, 't1')
  await $.tool.call(edit(FCT))
  await endTurn($, clock, 't2')
  expect(toasts).toEqual(["◆ Project health: the dbt adapter didn't start"])
})

test('an altimate-code without the dbt_health tool toasts nothing at session start or at a turn; /health says what to install', async ($, on) => {
  const { clock, toasts } = await start($, on, { runs: [{ fail: 'Error: unknown tool: dbt_health' }] })
  await $.tool.call(edit(STG))
  await endTurn($, clock, 't1')
  expect(toasts).toEqual([])
  const shown: any = await $.command.run({ command: 'health' } as any)
  expect(String(shown?.text)).toBe('Project health needs an altimate-code release with the dbt_health tool: npm i -g @altimateai/altimate-code')
})

test('no altimate-code on PATH toasts nothing at session start or at a turn; /health says what to install', async ($, on) => {
  const { clock, toasts } = await start($, on, { runs: [{ missing: true }] })
  await $.tool.call(edit(STG))
  await endTurn($, clock, 't1')
  expect(toasts).toEqual([])
  const shown: any = await $.command.run({ command: 'health' } as any)
  expect(String(shown?.text)).toBe('Project health needs the altimate-code CLI on your PATH: npm i -g @altimateai/altimate-code')
})

test('an altimate-code that is there but refused to start is not called missing: its own words are told', async ($, on) => {
  const { toasts } = await start($, on, { runs: [{ refused: true }] })
  expect(toasts.join('\n')).toContain('Project health could not run')
  expect(toasts.join('\n')).not.toContain('on your PATH')
})

test('/health shows the issues Claude introduced, and retries a first check that failed', async ($, on) => {
  const { clock, calls } = await start($, on, { runs: [{ fail: "the dbt adapter didn't start" }, [OLD_STG], [OLD_STG, NEW_STG]] })
  const retried: any = await $.command.run({ command: 'health' } as any)
  await clock.settle()
  // Asking again ran the baseline again; it answered, and nothing has changed yet.
  expect(calls).toHaveLength(2)
  expect(String(retried?.text)).toContain('No new health issues')

  await $.tool.call(edit(STG))
  await endTurn($, clock, 't1')
  const shown: any = await $.command.run({ command: 'health' } as any)
  expect(String(shown?.text)).toContain('1 new health issue · stg_orders: hard coded references')
  expect(String(shown?.text)).toContain('stg_orders reads raw.orders directly')
})

test('a session in no dbt project starts no check at session start, at a turn, at /health or at a push', async ($, on) => {
  const { clock, calls, toasts } = await start($, on, { runs: [[OLD_STG]], projects: [] })
  expect(calls).toHaveLength(0)
  await endTurn($, clock, 't1')
  const shown: any = await $.command.run({ command: 'health' } as any)
  await $.tool.call(command('git push'))
  await clock.settle()
  expect(calls).toHaveLength(0)
  expect(toasts).toEqual([])
  expect(String(shown?.text)).toContain('none open')
})

test('a session with nobody at the prompt starts no check while the push gate is off, at session start or at a turn', async ($, on) => {
  const { clock, calls } = await start($, on, { runs: [[OLD_STG]] }, { isInteractive: false })
  await endTurn($, clock, 't1')
  expect(calls).toHaveLength(0)
})

test('a baseline that failed is not asked for again at every turn, only by a change or /health', async ($, on) => {
  const { clock, calls } = await start($, on, { runs: [{ fail: "the dbt adapter didn't start" }, [OLD_STG]] })
  expect(calls).toHaveLength(1)
  await endTurn($, clock, 't1')
  await endTurn($, clock, 't2')
  expect(calls).toHaveLength(1)
  await $.command.run({ command: 'health' } as any)
  await clock.settle()
  expect(calls).toHaveLength(2)
})

test('a recheck that fails keeps the issues found before, and the change it did not cover is asked for again by the next change', async ($, on) => {
  const { clock, calls, toasts } = await start($, on, { runs: [[], [NEW_STG], { fail: 'dbt timed out' }, [NEW_STG]] })
  await $.tool.call(edit(STG))
  await endTurn($, clock, 't1')
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /1 new health issue/ })).toBeDefined()
  await band.unmount()

  await $.tool.call(edit(STG))
  await endTurn($, clock, 't2')
  expect(calls).toHaveLength(3)
  expect(toasts.at(-1)).toBe('◆ Project health: dbt timed out')
  // Not asked for again at the next turn's end without a new change.
  await endTurn($, clock, 't3')
  expect(calls).toHaveLength(3)
  const again = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await again.find({ type: 'Text', text: /1 new health issue/ })).toBeDefined()
  await again.unmount()

  await $.tool.call(edit(STG))
  await endTurn($, clock, 't4')
  expect(calls).toHaveLength(4)
})

test('git push goes through by default (the setting is off), with new issues open', async ($, on) => {
  const { clock } = await start($, on, { runs: [[], [NEW_STG]] })
  await $.tool.call(edit(STG))
  await endTurn($, clock, 't1')
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /1 new health issue/ })).toBeDefined()
  await band.unmount()
  const allowed: any = await $.tool.call(command('git push origin main'))
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

test('with the push gate on, a check that failed holds git push, and the push asks for it again', { options: { healthBlocksPush: true } }, async ($, on) => {
  const { clock, calls } = await start($, on, { runs: [[], { fail: 'dbt could not parse' }, [NEW_STG]] })
  await $.tool.call(edit(STG))
  await endTurn($, clock, 't1')
  expect(calls).toHaveLength(2)
  // The retry at the push runs the check again and finds the issue.
  const denied: any = await $.tool.call(command('git push'))
  expect(calls).toHaveLength(3)
  expect(denied?.deny).toContain('1 new project health issue')
})

test('with the push gate on, a check that cannot run keeps holding git push, and says why', { options: { healthBlocksPush: true } }, async ($, on) => {
  const { clock } = await start($, on, { runs: [[], { fail: 'dbt could not parse' }] })
  await $.tool.call(edit(STG))
  await endTurn($, clock, 't1')
  const denied: any = await $.tool.call(command('git push'))
  expect(denied?.deny).toContain('could not run (Project health: dbt could not parse)')
})

test('with the push gate on, a push with no model changed this session goes through', { options: { healthBlocksPush: true } }, async ($, on) => {
  await start($, on, { runs: [[OLD_STG]] })
  const allowed: any = await $.tool.call(command('git push'))
  expect(allowed?.deny).toBeUndefined()
})

test('with the push gate on, a push before the baseline lands, with no model changed, is not held for it', { options: { healthBlocksPush: true } }, async ($, on) => {
  const never = new Promise<void>(() => {})
  await start($, on, { runs: [[OLD_STG]], hold: { at: 0, until: never } })
  const allowed: any = await $.tool.call(command('git push'))
  expect(allowed?.deny).toBeUndefined()
})

test('with the push gate on, a push whose folder lookups outlast the gate is held, not let through', { options: { healthBlocksPush: true } }, async ($, on) => {
  let slow = false
  const never = new Promise<void>(() => {})
  const { clock } = await start($, on, { runs: [[]], onExists: () => (slow ? never : undefined) })
  await $.tool.call(edit(STG))
  await endTurn($, clock, 't1')
  slow = true
  const pending = $.tool.call(command("sed -i 's/a/b/' fresh/models/x.sql && git push"))
  await clock.advance(GATE_WAIT_MS + 100)
  const denied: any = await pending
  expect(denied?.deny).toContain('could not be read in time')
})

test('with the push gate on, a command that edits a model and pushes is held: the edit is not checked before it runs', { options: { healthBlocksPush: true } }, async ($, on) => {
  await start($, on, { runs: [[]] })
  const denied: any = await $.tool.call(command(`sed -i 's/a/b/' models/staging/stg_orders.sql && git push`))
  expect(denied?.deny).toContain('Run them as separate commands')
  const unrelated: any = await $.tool.call(command(`sed -i 's/a/b/' README.md && git push`))
  expect(unrelated?.deny).toBeUndefined()
})

test('with the push gate on, stale insights (dbt could not parse) are a failed check, not a clean one', { options: { healthBlocksPush: true } }, async ($, on) => {
  const { clock, toasts } = await start($, on, { runs: [[], { stale: 'dbt could not parse the project' }] })
  await $.tool.call(edit(STG))
  await endTurn($, clock, 't1')
  expect(toasts.at(-1)).toContain('dbt could not parse the project')
  const denied: any = await $.tool.call(command('git push'))
  expect(denied?.deny).toContain('dbt could not parse the project')
})

test('with the push gate on, a result the engine cut at its size limit is a failed check, not a clean one', { options: { healthBlocksPush: true } }, async ($, on) => {
  const { clock, toasts } = await start($, on, { runs: [[], { truncated: true }] })
  await $.tool.call(edit(STG))
  await endTurn($, clock, 't1')
  expect(toasts.at(-1)).toContain('too many health insights')
  const denied: any = await $.tool.call(command('git push'))
  expect(denied?.deny).toContain('too many health insights')
})

test('the configured config path is passed to the tool, empty means the defaults', () => {
  expect(toolArgs('datapilot.yml')).toEqual({ config_path: 'datapilot.yml' })
  expect(toolArgs('  datapilot.yml ')).toEqual({ config_path: 'datapilot.yml' })
  expect(toolArgs('')).toEqual({})
  expect(toolArgs(undefined)).toEqual({})
  expect(configPathProblem('datapilot.yml')).toBeNull()
  expect(configPathProblem('')).toBeNull()
  for (const bad of ['/etc/hosts', 'C:\\x.yml', '../x.yml', 'a/../../x.yml']) expect(configPathProblem(bad)).toContain('inside the dbt project')
})

test('a comment never hides the push that follows it, and a push inside a comment is not a push', () => {
  expect(isGitPush("# Push this branch's commits\ngit push origin HEAD")).toBe(true)
  expect(isGitPush("git add -A # don't forget\ngit push")).toBe(true)
  expect(isGitPush('echo x # ; git push')).toBe(false)
  expect(isGitPush('git status # git push')).toBe(false)
  expect(isGitPush('echo a#b && git push')).toBe(true)
  expect(isGitPush('echo ${#arr[@]}; git push')).toBe(true)
  expect(isGitPush('echo $# ${#x}; git push')).toBe(true)
})

test('an unnamed YAML file edited before the baseline lands does not empty the baseline', async ($, on) => {
  let release!: () => void
  const until = new Promise<void>(resolve => (release = resolve))
  const { clock, toasts } = await start($, on, { runs: [[OLD_STG, OLD_FCT]], hold: { at: 0, until } })
  await $.tool.call(edit(`${ROOT}/models/_sources.yml`))
  await endTurn($, clock, 't1')
  release()
  await clock.settle()
  expect(toasts).toEqual([])
})

test('a config path outside the project runs no check and says so', { options: { healthConfigPath: '/etc/hosts' } }, async ($, on) => {
  const { calls, toasts } = await start($, on, { runs: [[]] })
  expect(calls).toHaveLength(0)
  expect(toasts.join('\n')).toContain('inside the dbt project')
})

test('with the push gate on, a push while a re-check is still running is held', { options: { healthBlocksPush: true } }, async ($, on) => {
  let release!: () => void
  const until = new Promise<void>(resolve => (release = resolve))
  const { clock } = await start($, on, { runs: [[], [NEW_STG]], hold: { at: 1, until } })
  await $.tool.call(edit(STG))
  await endTurn($, clock, 't1')
  const pending = $.tool.call(command('git push'))
  await clock.advance(GATE_WAIT_MS + 100)
  const denied: any = await pending
  expect(denied?.deny).toContain('could not be read in time')
  release()
})

test('a relative file a Bash command writes is read from the shell folder an earlier cd left, not the session root', async ($, on) => {
  const { clock, calls, toasts } = await start($, on, { runs: [[], [NEW_STG]], cwd: `${ROOT}/models/staging` })
  await $.tool.call(command(`sed -i 's/a/b/' stg_orders.sql`))
  await endTurn($, clock, 't1')
  expect(calls).toHaveLength(2)
  expect(toasts).toEqual(['◆ 1 new health issue · stg_orders: hard coded references · /health'])
})

test('a cd in the same Bash command is read from the folder the command started in, not the one it left the shell in', async ($, on) => {
  const options: Options = { runs: [[], [NEW_STG]], cwd: ROOT, onCall: () => (options.cwd = `${ROOT}/models/staging`) }
  const { clock, calls, toasts } = await start($, on, options)
  await $.tool.call(command(`cd models/staging && sed -i 's/a/b/' stg_orders.sql`))
  await endTurn($, clock, 't1')
  expect(calls).toHaveLength(2)
  expect(toasts).toEqual(['◆ 1 new health issue · stg_orders: hard coded references · /health'])
})

test('with the push gate on, an edit-and-push written from the folder an earlier cd left is held', { options: { healthBlocksPush: true } }, async ($, on) => {
  await start($, on, { runs: [[]], cwd: `${ROOT}/models/staging` })
  const denied: any = await $.tool.call(command(`sed -i 's/a/b/' stg_orders.sql && git push`))
  expect(denied?.deny).toContain('Run them as separate commands')
})

test('with the push gate on, a write from a dbt-internal folder the shell is in is no model edit', { options: { healthBlocksPush: true } }, async ($, on) => {
  await start($, on, { runs: [[]], cwd: `${ROOT}/target` })
  const allowed: any = await $.tool.call(command(`sed -i 's/a/b/' x.sql && git push`))
  expect(allowed?.deny).toBeUndefined()
})

test('with the push gate on, a push whose shell-folder lookup stalls is held, not let through', { options: { healthBlocksPush: true } }, async ($, on) => {
  let stall = false
  const never = new Promise<void>(() => {})
  const { clock } = await start($, on, { runs: [[], [NEW_STG]], holdCwd: () => (stall ? never : undefined) })
  await $.tool.call(edit(STG))
  await endTurn($, clock, 't1')
  stall = true
  const pending = $.tool.call(command('cd /repo && git push'))
  await clock.advance(GATE_WAIT_MS + 100)
  const denied: any = await pending
  expect(denied?.deny).toContain('could not be read in time')
})

test('git push is found by its command words, not by its text', () => {
  for (const line of [
    'git push',
    'git push origin main',
    'git -C sub push origin x',
    'git -C "my project" push',
    'git --git-dir .git push',
    'git --git-dir=.git push',
    'GIT_SSH=ssh git push --force',
    'git add . && git push',
    'git add .; git push',
    'sudo git push',
    'command git push',
    'env X=1 git push',
    'time git push',
    '/usr/bin/git push',
    '(git push)',
    '{ git push; }',
    'git push&',
    'bash -c "git push"',
    "sh -c 'git add . && git push'",
    'echo $(git push)',
    'git commit -m x\ngit push',
    'git \\\npush',
    'bash -lc "git push"',
    'sudo -u bob git push',
    'nice -n 10 git push',
    'env -u X git push',
    'echo "$(git push)"',
  ])
    expect([line, isGitPush(line)]).toEqual([line, true])
  for (const line of [
    'git status',
    'git pushd',
    'git commit -m "fix; git push later"',
    'echo git push',
    'echo "example; git push origin main"',
    "echo 'git push'",
    'git log --oneline -- push',
    'grep -r push .',
  ])
    expect([line, isGitPush(line)]).toEqual([line, false])
})

test('simple commands split on operators outside quotes, and an unclosed quote still ends', () => {
  expect(simpleCommands('a b && c "d e"; f | g')).toEqual([['a', 'b'], ['c', 'd e'], ['f'], ['g']])
  expect(simpleCommands("a 'b c")).toEqual([['a', 'b c']])
})

test('the model files a Bash command writes, not the ones it only reads', () => {
  expect(filesWrittenBy(`sed -i 's/a/b/' models/x.sql && cat > models/y.yml`)).toEqual(['models/x.sql', 'models/y.yml'])
  expect(filesWrittenBy('echo hi >models/z.sql')).toEqual(['models/z.sql'])
  expect(filesWrittenBy('echo hi >> models/z.sql; mv models/a.sql models/b.sql')).toEqual(['models/z.sql', 'models/a.sql', 'models/b.sql'])
  expect(filesWrittenBy('printf x | tee models/t.sql')).toEqual(['models/t.sql'])
  expect(filesWrittenBy('git checkout -- models/c.sql')).toEqual(['models/c.sql'])
  expect(filesWrittenBy('perl -pi -e s/a/b/ models/p.sql')).toEqual(['models/p.sql'])
  for (const line of ['cat models/x.sql', 'git diff models/x.sql', 'grep foo models/x.yml', 'sed -n 1,5p models/x.sql', 'ls -la', 'git status'])
    expect([line, filesWrittenBy(line)]).toEqual([line, []])
})

test('shell syntax: a redirect without spaces, bash -c, cd before the edit, backticks in quotes, heredoc bodies', () => {
  expect(filesWrittenBy('echo x>models/x.sql')).toEqual(['models/x.sql'])
  expect(filesWrittenBy('echo x 2>models/e.sql')).toEqual(['models/e.sql'])
  expect(filesWrittenBy(`bash -c "sed -i s/a/b/ models/x.sql"`)).toEqual(['models/x.sql'])
  expect(filesWrittenBy('cd models && sed -i s/a/b/ x.sql')).toEqual(['models/x.sql'])
  expect(filesWrittenBy('cd /repo/models/staging; echo x > y.sql')).toEqual(['/repo/models/staging/y.sql'])
  expect(filesWrittenBy('echo x > /dev/null 2>&1')).toEqual([])
  expect(isGitPush('2>/dev/null git push origin main')).toBe(true)
  expect(isGitPush('>out.log git push')).toBe(true)
  expect(isGitPush('2>/dev/null git status')).toBe(false)
  expect(isGitPush('echo "`git push`"')).toBe(true)
  expect(isGitPush('echo "$(git push)"')).toBe(true)
  expect(isGitPush("cat <<'EOF'\ngit push\nEOF")).toBe(false)
  expect(isGitPush('cat <<EOF\ngit push\nEOF')).toBe(false)
  expect(isGitPush('cat <<EOF\n$(git push)\nEOF')).toBe(true)
  expect(isGitPush("cat <<'EOF'\nnote\nEOF\ngit push")).toBe(true)
  expect(isGitPush('cat <<-EOF\n\tgit push\n\tEOF\ngit status')).toBe(false)
  // A commit message with an unbalanced paren, then the push.
  expect(isGitPush('git commit -m "$(cat <<\'EOF\'\nfix: handle (a\nEOF\n)" && git push')).toBe(true)
  expect(isGitPush('git commit -m "$(cat <<\'EOF\'\n1) use `git push`\nEOF\n)"')).toBe(false)
  // A here-string and a shift are not heredocs.
  expect(isGitPush('grep y <<< "x"\ngit push')).toBe(true)
  expect(isGitPush('echo $((1<<2))\ngit push')).toBe(true)
  // A shell reads its heredoc as its script.
  expect(isGitPush("bash <<'EOF'\ngit push\nEOF")).toBe(true)
  expect(filesWrittenBy("sh <<'EOF'\nsed -i s/a/b/ models/x.sql\nEOF")).toEqual(['models/x.sql'])
  // The heredoc belongs to the command it follows, whatever comes after it on the line.
  expect(isGitPush('bash <<EOF && echo ok\ngit push\nEOF')).toBe(true)
  expect(isGitPush('bash <<EOF | tee log\ngit push\nEOF')).toBe(true)
  expect(isGitPush('cat <<EOF; bash\ngit push\nEOF')).toBe(false)
  expect(filesWrittenBy("sh <<'EOF' && echo done\nsed -i s/a/b/ models/x.sql\nEOF")).toEqual(['models/x.sql'])
  // A shift with names or spaces is not a heredoc: nothing closes it.
  expect(isGitPush('x=$((a<<b))\ngit push')).toBe(true)
  expect(isGitPush('echo $((x << y))\ngit push')).toBe(true)
  expect(isGitPush('((n<<k))\ngit push')).toBe(true)
  // Delimiters that are not names, and CRLF line ends.
  expect(isGitPush("cat <<1\nit's\n1\ngit push")).toBe(true)
  expect(isGitPush('cat <<EOF\r\ngit push\r\nEOF\r\ngit status')).toBe(false)
})

test('the hooks module loads in the sandbox Claude Code runs it in (no node: import) and runs a baseline', async ($, on) => {
  const { calls } = await start($, on, { runs: [[OLD_STG]] })
  expect(calls.map(c => c.tool)).toEqual(['dbt_health'])
})

test('canonical resolves a symlinked folder through the engine, and a deleted file through its nearest existing folder', async () => {
  const folders: Record<string, string> = { '/alias': '/private/real', '/alias/models': '/private/real/models' }
  const engine = {
    fs: {
      stat: async (path: string) => {
        if (!(path in folders)) throw new Error('ENOENT')
        return { realPath: folders[path] }
      },
    },
  }
  const real = await canonical(engine as any, ['/alias/models/x.sql', '/alias/models/sub/gone.sql', '/other/a.sql', '/alias/./models/../models/y.sql'])
  expect(real('/alias/models/x.sql')).toBe('/private/real/models/x.sql')
  expect(real('/alias/models/sub/gone.sql')).toBe('/private/real/models/sub/gone.sql')
  expect(real('/other/a.sql')).toBe('/other/a.sql')
  expect(real('/alias/./models/../models/y.sql')).toBe('/private/real/models/y.sql')
  // A path it was not asked about keeps its own spelling.
  expect(real('/alias/models/z.sql')).toBe('/alias/models/z.sql')
})

test('a model edited through a symlinked folder, edited or deleted, shows its new issue in the band', async ($, on) => {
  const real = '/private/shop'
  const file = `${real}/models/staging/stg_orders.sql`
  const stg = { ...NEW_STG, file, properties: '' }
  const old = { ...OLD_STG, file, properties: '' }
  const { clock, toasts } = await start($, on, {
    runs: [[old], [old, stg]],
    realFolders: { [`${ROOT}/models/staging`]: `${real}/models/staging` },
  })
  await $.tool.call(edit(STG))
  await endTurn($, clock, 't1')
  expect(toasts).toEqual(['◆ 1 new health issue · stg_orders: hard coded references · /health'])
})

test('an edit that lands while the folders resolve is counted as an edit of its model, not folded into the baseline', async ($, on) => {
  let release!: () => void
  const holdStat = new Promise<void>(resolve => (release = resolve))
  const real = '/private/shop'
  const file = `${real}/models/staging/stg_orders.sql`
  const both = [{ ...OLD_STG, file, properties: '' }, { ...NEW_STG, file, properties: '' }]
  const { clock, toasts } = await start($, on, { runs: [both], realFolders: { [`${ROOT}/models/staging`]: `${real}/models/staging` }, holdStat })
  await $.tool.call(edit(STG))
  release()
  await clock.settle()
  await endTurn($, clock, 't1')
  expect(toasts).toEqual(['◆ 2 new health issues · stg_orders: missing documentation · /health'])
})

test('a check of the session before a restart does not write its answer into the new session while the folders resolve', async ($, on) => {
  let releaseStat!: () => void
  const holdStat = new Promise<void>(resolve => (releaseStat = resolve))
  let releaseRun!: () => void
  const until = new Promise<void>(resolve => (releaseRun = resolve))
  const real = '/private/shop'
  const file = `${real}/models/staging/stg_orders.sql`
  const old = { ...OLD_STG, file, properties: '' }
  const added = { ...NEW_STG, file, properties: '' }
  const { clock, toasts } = await start($, on, {
    // The first answer is for the session before the restart; the new session's baseline is the project as it is.
    runs: [[old, added], [old], [old, added]],
    realFolders: { [`${ROOT}/models/staging`]: `${real}/models/staging` },
    holdStat,
    hold: { at: 1, until },
  })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  releaseStat()
  await clock.settle()
  releaseRun()
  await clock.settle()
  // The old session's answer did not become the new baseline: this edit's new issue is new.
  await $.tool.call(edit(STG))
  await endTurn($, clock, 't1')
  expect(toasts).toEqual(['◆ 1 new health issue · stg_orders: hard coded references · /health'])
})

test('an edit that keeps landing while the folders resolve is never folded into the baseline, however many tries it takes', async ($, on) => {
  const real = '/private/shop'
  const file = `${real}/models/staging/stg_orders.sql`
  const both = [{ ...OLD_STG, file, properties: '' }, { ...NEW_STG, file, properties: '' }]
  // Each folder lookup waits for the test, which lands an edit during it: three late edits of other files
  // use up the tries, and the model's own file lands during the last one.
  const held: (() => void)[] = []
  let gate = true
  const started = start($, on, {
    runs: [both],
    realFolders: { [`${ROOT}/models/staging`]: `${real}/models/staging` },
    onStat: () => (gate ? new Promise<void>(resolve => held.push(resolve)) : undefined),
  })
  const files = [`${ROOT}/models/staging/late1.sql`, `${ROOT}/models/staging/late2.sql`, `${ROOT}/models/staging/late3.sql`, STG]
  for (const file of files) {
    while (held.length === 0) await new Promise(resolve => (globalThis as any).setTimeout(resolve, 5))
    gate = false
    await $.tool.call(edit(file))
    gate = true
    held.splice(0).forEach(release => release())
  }
  gate = false
  const { clock, statuses } = await started
  await clock.settle()
  expect(statuses.at(-1)).toContain('2 health issues')
})

test('the status line part a previous process left is cleared at session start, drawn or not', async ($, on) => {
  const { clock, statuses } = await start($, on, { runs: [[OLD_STG]] })
  const before = statuses.length
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(statuses.length).toBeGreaterThan(before)
})

test('a deleted model in a folder that is gone too still matches through its nearest existing folder', async ($, on) => {
  const real = '/private/shop'
  const file = `${real}/models/gone/stg_orders.sql`
  const stg = { ...NEW_STG, file, properties: '' }
  const old = { ...OLD_STG, file, properties: '' }
  const { clock, toasts } = await start($, on, { runs: [[old], [old, stg]], realFolders: { [`${ROOT}/models`]: `${real}/models` } })
  await $.tool.call(edit(`${ROOT}/models/gone/stg_orders.sql`))
  await endTurn($, clock, 't1')
  expect(toasts).toEqual(['◆ 1 new health issue · stg_orders: hard coded references · /health'])
})

test('a leading input redirect does not hide git push', () => {
  for (const line of ['< in.txt git push', '<in.txt git push origin main', '<<< "x" git push', '&> /dev/null git push', '0< in git push', '<> f git push'])
    expect([line, isGitPush(line)]).toEqual([line, true])
  expect(isGitPush('< in.txt git status')).toBe(false)
  expect(isGitPush('"0"<input git push')).toBe(false)
  expect(isGitPush('\\0<input git push')).toBe(false)
  expect(filesWrittenBy('touch marker <models/input.sql')).toEqual([])
  expect(filesWrittenBy('touch marker < models/input.sql')).toEqual([])
})

test('models match by their own files, so a model of another package is never matched', () => {
  expect([...modelsOfFiles([STG], [OLD_STG, OLD_FCT, DEP])]).toEqual(['model.shop.stg_orders'])
  expect([...modelsOfFiles([STG_YML], [OLD_STG, OLD_FCT])]).toEqual(['model.shop.stg_orders'])
  expect([...modelsOfFiles(['/elsewhere/other.sql'], [OLD_STG, DEP])]).toEqual([])
})

test('new issues are the pairs the baseline lacks, on the given models', () => {
  expect(pairKey(NEW_STG)).toBe('model.shop.stg_orders\u0000Hard coded references')
  expect(newIssues([OLD_STG, NEW_STG, NEW_FCT], [pairKey(OLD_STG)], new Set(['model.shop.stg_orders']))).toEqual([NEW_STG])
})

test('the band line and the report', () => {
  expect(bandText([NEW_STG])).toBe('1 new health issue · stg_orders: hard coded references · /health')
  expect(bandText([])).toBe('')
  expect(reportText([NEW_STG])).toBe('- stg_orders: hard coded references (warning) stg_orders reads raw.orders directly → Fix Hard coded references')
})

test('the push gate waits for less than the tool chain gives a phase, so a held push is never given up on', () => {
  expect(GATE_WAIT_MS).toBeLessThan(PHASE_TIMEOUT_MS)
})

test('a Bash call that finishes while another is running leaves the other its own start folder', async ($, on) => {
  let inner = false
  const options: Options = {
    runs: [[], [NEW_STG]],
    cwd: `${ROOT}/models`,
    onCall: async () => {
      if (inner) return
      inner = true
      await $.tool.call({ ...command('ls'), tool_use_id: 'b' })
    },
  }
  const { clock, calls, toasts } = await start($, on, options)
  await $.tool.call({ ...command(`cd staging && sed -i 's/a/b/' stg_orders.sql`), tool_use_id: 'a' })
  await endTurn($, clock, 't1')
  expect(calls).toHaveLength(2)
  expect(toasts).toEqual(['◆ 1 new health issue · stg_orders: hard coded references · /health'])
})

let stall = false

test('a command with its own cd whose start folder could not be read in time is read from the session root', async ($, on) => {
  const never = new Promise<void>(() => {})
  const { clock, calls, toasts } = await start($, on, { runs: [[], [NEW_STG]], cwd: `${ROOT}/models/staging`, holdCwd: () => (stall ? never : undefined) })
  stall = true
  const pending = $.tool.call(command(`cd models/staging && sed -i 's/a/b/' stg_orders.sql`))
  await clock.advance(GATE_WAIT_MS + 100)
  await pending
  stall = false
  await endTurn($, clock, 't1')
  expect(calls).toHaveLength(2)
  expect(toasts).toEqual(['◆ 1 new health issue · stg_orders: hard coded references · /health'])
})

test('a YAML file no insight names, edited after the baseline, counts every model as edited', async ($, on) => {
  const { clock, calls, toasts } = await start($, on, { runs: [[OLD_STG, OLD_FCT], [OLD_STG, OLD_FCT, NEW_FCT]] })
  await $.tool.call(edit(`${ROOT}/models/_sources.yml`))
  await endTurn($, clock, 't1')
  expect(calls).toHaveLength(2)
  expect(toasts).toEqual(['◆ 1 new health issue · fct_orders: model fanout · /health'])
})

test('with the push gate on, a session opened above its dbt project holds nothing', { options: { healthBlocksPush: true } }, async ($, on) => {
  await start($, on, { runs: [[]], projects: [`${ROOT}/dbt`] })
  const allowed: any = await $.tool.call(command(`cd dbt && echo x > models/a.sql && git push`))
  expect(allowed?.deny).toBeUndefined()
})
