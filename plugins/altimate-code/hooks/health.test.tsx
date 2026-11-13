import { expect, mock, test } from 'claude-code/testing'

import { bandText, filesWrittenBy, isGitPush, modelsOfFiles, newIssues, pairKey, pushRefusal, reportText, simpleCommands, toolArgs } from './features/health'

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
  runs: (ReturnType<typeof insight>[] | { fail: string } | { stale: string })[]
  /** Holds the run with this index (from 0) until released. */
  hold?: { at: number; until: Promise<void> }
  /** Folders that hold a dbt_project.yml (default: the repo). */
  projects?: string[]
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
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: projects.some(p => e.path === `${p}/dbt_project.yml`) }))
  on('fs.read', () => ({ value: '' }))
  on('tool.list', () => ({ value: [] }))
  on('mcp.connect', () => ({ value: { isConnected: false, reason: 'not_connected', message: 'off' } }))
  on('tool.call', () => ({ result: { ok: true } }))
  let run = 0
  on('process.run', async (_: unknown, e: { argv: readonly string[] }) => {
    const [, command, , tool = ''] = e.argv
    if (command !== 'tool') return { value: { exitCode: 1, stdout: '', stderr: 'not this test' } }
    const args = JSON.parse(String(e.argv[e.argv.indexOf('--args') + 1] ?? '{}'))
    const index = run++
    calls.push({ tool, args, argv: e.argv })
    if (options.hold?.at === index) await options.hold.until
    const answer = options.runs[Math.min(index, options.runs.length - 1)]!
    const metadata =
      'fail' in answer ? { success: false, insights: [] } : 'stale' in answer ? { success: true, insights: [OLD_STG], stale_manifest: { message: answer.stale } } : { success: true, insights: answer }
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

test('the configured config path is passed to the tool, empty means the defaults', () => {
  expect(toolArgs('datapilot.yml')).toEqual({ config_path: 'datapilot.yml' })
  expect(toolArgs('  datapilot.yml ')).toEqual({ config_path: 'datapilot.yml' })
  expect(toolArgs('')).toEqual({})
  expect(toolArgs(undefined)).toEqual({})
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
  expect(isGitPush('echo "`git push`"')).toBe(true)
  expect(isGitPush('echo "$(git push)"')).toBe(true)
  expect(isGitPush("cat <<'EOF'\ngit push\nEOF")).toBe(false)
  expect(isGitPush('cat <<EOF\ngit push\nEOF')).toBe(false)
  expect(isGitPush('cat <<EOF\n$(git push)\nEOF')).toBe(true)
  expect(isGitPush("cat <<'EOF'\nnote\nEOF\ngit push")).toBe(true)
  expect(isGitPush('cat <<-EOF\n\tgit push\n\tEOF\ngit status')).toBe(false)
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
