import { expect, mock, test } from 'claude-code/testing'

import { effective, rewriteDeferCommand, runsInProject, statusText } from './defer'

const on = { stateDir: '/work/prod-state' }

test('dbt build -s x gets --defer --state right after the subcommand', () => {
  expect(rewriteDeferCommand('dbt build -s x', on)).toBe('dbt build --defer --state /work/prod-state -s x')
})

test('each dbt invocation in cd a && dbt run is rewritten, the rest of the line is left as it is', () => {
  expect(rewriteDeferCommand('cd a && dbt run', on)).toBe('cd a && dbt run --defer --state /work/prod-state')
  expect(rewriteDeferCommand('dbt run && dbt test | tee log', on)).toBe('dbt run --defer --state /work/prod-state && dbt test --defer --state /work/prod-state | tee log')
})

test('uv run dbt test is rewritten after the subcommand, and --favor-state follows the setting', () => {
  expect(rewriteDeferCommand('uv run dbt test', { ...on, favorState: true })).toBe('uv run dbt test --defer --state /work/prod-state --favor-state')
})

test('a command with --state, --defer or --no-defer already is not changed', () => {
  expect(rewriteDeferCommand('dbt build --state ./old', on)).toBe('dbt build --state ./old')
  expect(rewriteDeferCommand('dbt build --no-defer', on)).toBe('dbt build --no-defer')
  expect(rewriteDeferCommand('DBT_STATE=./old dbt build', on)).toBe('DBT_STATE=./old dbt build')
})

test('defer off or no dbt command: no rewrite', () => {
  expect(rewriteDeferCommand('dbt build', {})).toBe('dbt build')
  expect(rewriteDeferCommand('dbt build', { stateDir: null })).toBe('dbt build')
  expect(rewriteDeferCommand('ls -la && echo dbt', on)).toBe('ls -la && echo dbt')
})

test('commands that do not defer are left without --defer, and the target goes to every command that takes one', () => {
  const both = { ...on, target: 'qa', defaultTarget: 'dev' }
  expect(rewriteDeferCommand('dbt ls -s x', on)).toBe('dbt ls --defer --state /work/prod-state -s x')
  expect(rewriteDeferCommand('dbt deps', both)).toBe('dbt deps')
  expect(rewriteDeferCommand('dbt source freshness', both)).toBe('dbt source --target qa freshness')
  expect(rewriteDeferCommand('dbt debug', both)).toBe('dbt debug --target qa')
  expect(rewriteDeferCommand('dbt retry', both)).toBe('dbt retry')
})

test('an inline DBT_TARGET keeps the target of that command only', () => {
  const options = { target: 'qa', defaultTarget: 'dev' }
  expect(rewriteDeferCommand('DBT_TARGET=ci dbt run', options)).toBe('DBT_TARGET=ci dbt run')
  expect(rewriteDeferCommand('DBT_TARGET=ci dbt run && dbt test', options)).toBe('DBT_TARGET=ci dbt run && dbt test --target qa')
})

test('a command for another project, by cd or --project-dir, is not rewritten', () => {
  expect(runsInProject('dbt run', '/repo/a', '/repo/a')).toBe(true)
  expect(runsInProject('cd models && dbt run', '/repo/a', '/repo/a')).toBe(true)
  expect(runsInProject('cd a && dbt run', '/repo', '/repo/a')).toBe(true)
  expect(runsInProject('cd ../b && dbt run', '/repo/a', '/repo/a')).toBe(false)
  expect(runsInProject('dbt run && cd ../b && dbt test', '/repo/a', '/repo/a')).toBe(false)
  expect(runsInProject('dbt run --project-dir ../b', '/repo/a', '/repo/a')).toBe(false)
  expect(runsInProject('DBT_PROJECT_DIR=../b dbt run', '/repo/a', '/repo/a')).toBe(false)
  expect(runsInProject('dbt run', '/repo', '/repo/a')).toBe(false)
  expect(runsInProject('cd ~/other && dbt run', '/repo/a', '/repo/a')).toBe(false)
  expect(runsInProject('ls', '/repo/a', '/repo/a')).toBe(false)
  expect(runsInProject('{ cd ../b; dbt run; }', '/repo/a', '/repo/a')).toBe(false)
  expect(runsInProject('if cd ../b; then dbt run; fi', '/repo/a', '/repo/a')).toBe(false)
  expect(runsInProject('cd -P ../b && dbt run', '/repo/a', '/repo/a')).toBe(false)
  expect(runsInProject('cd ~/x && dbt run --project-dir /repo/a', '/repo/a', '/repo/a')).toBe(false)
  expect(runsInProject('pushd ../b && dbt run', '/repo/a', '/repo/a')).toBe(false)
  expect(runsInProject('uv run --directory ../b dbt run', '/repo/a', '/repo/a')).toBe(false)
  // The project named with --project-dir is this one when it resolves to it.
  expect(runsInProject('dbt run --project-dir a', '/repo', '/repo/a')).toBe(true)
  expect(runsInProject('dbt run --project-dir b', '/repo', '/repo/a')).toBe(false)
  expect(runsInProject('cd a && dbt run --project-dir .', '/repo', '/repo/a')).toBe(true)
  expect(runsInProject('dbt run --project-dir ./models/..', '/repo/a', '/repo/a')).toBe(true)
})

test('a Windows session folder, with either slash, is the project it names', () => {
  expect(runsInProject('dbt run', 'C:\\repo', 'C:/repo')).toBe(true)
  expect(runsInProject('cd models && dbt run', 'C:/repo', 'C:\\repo')).toBe(true)
  expect(runsInProject('cd C:\\other && dbt run', 'C:/repo', 'C:/repo')).toBe(false)
  expect(runsInProject('cd a && dbt run', 'C:\\repo', 'C:/repo/a')).toBe(true)
})

test('a path with spaces is quoted', () => {
  expect(rewriteDeferCommand('dbt run', { stateDir: "/my state/o'k" })).toBe(`dbt run --defer --state '/my state/o'\\''k'`)
})

test('the session target is added when it differs from the default and the command names none', () => {
  const options = { target: 'prod', defaultTarget: 'dev' }
  expect(rewriteDeferCommand('dbt run -s x', options)).toBe('dbt run --target prod -s x')
  expect(rewriteDeferCommand('dbt run -t qa', options)).toBe('dbt run -t qa')
  expect(rewriteDeferCommand('dbt run', { target: 'dev', defaultTarget: 'dev' })).toBe('dbt run')
  expect(rewriteDeferCommand('dbt run', { ...on, ...options })).toBe('dbt run --defer --state /work/prod-state --target prod')
})

test('the override decides, and the status text shows target and defer', () => {
  const state: any = { projectDir: '/p', enabled: true, favorState: false, mode: 'local', stateDir: '/work/prod', reason: null, override: null, defaultTarget: 'dev', targets: ['dev', 'prod'], target: null, failedAt: null }
  expect(statusText(state)).toBe('dbt dev · defer prod')
  expect(effective(state).stateDir).toBe('/work/prod')
  expect(effective({ ...state, override: false }).stateDir).toBeNull()
  expect(statusText({ ...state, override: false, target: 'prod' })).toBe('dbt prod')
  expect(statusText({ ...state, projectDir: null })).toBeNull()
})

const ROOT = '/repo'

/** A dbt project at /repo whose defer setting the CLI reports as `answer`; Bash commands are recorded. */
function start($: any, on: any, answer: Record<string, unknown>, fail: { times: number } = { times: 0 }) {
  const bash: string[] = []
  const statuses: (string | undefined)[] = []
  const reads: string[] = []
  const clock = mock.clock(on)
  on('command.register', (_: unknown, e: any) => ({ value: { command: e.name } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT }))
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: e.path === `${ROOT}/dbt_project.yml` }))
  on('process.run', (_: unknown, e: { readonly argv: readonly string[] }) => {
    if (!e.argv.includes('dbt_defer_state')) return { value: { exitCode: 0, stdout: '{}', stderr: '' } }
    reads.push(e.argv.join(' '))
    if (fail.times-- > 0) return { value: { exitCode: 1, stdout: '', stderr: 'not ready' } }
    return {
    value: { exitCode: 0, stdout: JSON.stringify({ status: 'success', output: '', metadata: { success: true, ...answer } }), stderr: '' },
  }
  })
  on('ui.status', (_: unknown, e: any) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('tool.call', (_: unknown, e: any) => {
    bash.push(e.command)
    return { result: { ok: true } }
  })
  return { bash, statuses, reads, clock }
}

const DEFER = { enabled: true, favorState: true, mode: 'local', stateDir: '/work/prod-state', defaultTarget: 'dev', targets: ['dev', 'prod'] }

test('through the plugin, Claude’s dbt commands run with --defer --state when the project setting is on', async ($, on) => {
  const seen = start($, on, DEFER)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'dbt build -s x' })
  await $.tool.call({ tool: 'Bash', command: 'dbt build --state ./mine' })
  expect(seen.bash).toEqual(['dbt build --defer --state /work/prod-state --favor-state -s x', 'dbt build --state ./mine'])
  expect(seen.statuses.at(-1)).toContain('dbt dev · defer prod-state')
})

test('/defer off stops the rewrite for the session, /defer on brings it back, /target adds --target', async ($, on) => {
  const seen = start($, on, DEFER)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const run = (command: string, args: string) => $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })

  expect((await run('defer', 'off')).text).toContain('Defer off')
  await $.tool.call({ tool: 'Bash', command: 'dbt run' })
  expect((await run('defer', 'on')).text).toContain('Defer on')
  expect((await run('target', 'prod')).text).toContain('--target prod')
  await $.tool.call({ tool: 'Bash', command: 'dbt run' })
  expect((await run('target', 'nope')).text).toContain('No target "nope"')
  expect((await run('defer', 'status')).text).toContain('state: /work/prod-state (favor state)')
  expect(seen.bash).toEqual(['dbt run', 'dbt run --defer --state /work/prod-state --favor-state --target prod'])
})

test('with defer off in the project nothing is rewritten and /defer on says why it cannot', async ($, on) => {
  const seen = start($, on, { enabled: false, mode: 'none', defaultTarget: 'dev', targets: ['dev'] })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'dbt run' })
  const reply = await $.command.run({ command: 'defer', args: 'on', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  expect(reply.text).toContain('cannot be turned on')
  expect(seen.bash).toEqual(['dbt run'])
})

test('a configured but switched-off setting can be turned on for the session', async ($, on) => {
  const seen = start($, on, { ...DEFER, enabled: false })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'dbt run' })
  const run = (command: string, args: string) => $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  expect((await run('defer', 'on')).text).toContain('Defer on')
  await $.tool.call({ tool: 'Bash', command: 'dbt run' })
  expect(seen.bash).toEqual(['dbt run', 'dbt run --defer --state /work/prod-state --favor-state'])
})

test('a dbt command for another project is left as it is', async ($, on) => {
  const seen = start($, on, DEFER)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'cd ../other && dbt run' })
  await $.tool.call({ tool: 'Bash', command: 'dbt run --project-dir ../other' })
  await $.tool.call({ tool: 'Bash', command: 'cd models && dbt run' })
  expect(seen.bash).toEqual(['cd ../other && dbt run', 'dbt run --project-dir ../other', 'cd models && dbt run --defer --state /work/prod-state --favor-state'])
})

test('the setting is read once, on the first dbt command, and a command without dbt reads nothing', async ($, on) => {
  const seen = start($, on, DEFER)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(seen.reads).toEqual([])
  await $.tool.call({ tool: 'Bash', command: 'dbt run' })
  await $.tool.call({ tool: 'Bash', command: 'dbt test' })
  expect(seen.reads.length).toBe(1)
})

test('a read that failed is tried again after a minute, not for the rest of the session', async ($, on) => {
  const seen = start($, on, DEFER, { times: 1 })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'dbt run' })
  await $.tool.call({ tool: 'Bash', command: 'dbt run' })
  await seen.clock.advance(61_000)
  await $.tool.call({ tool: 'Bash', command: 'dbt run' })
  expect(seen.bash).toEqual(['dbt run', 'dbt run', 'dbt run --defer --state /work/prod-state --favor-state'])
  expect(seen.reads.length).toBe(2)
})

test('a new session clears the status line and the overrides of the one before', async ($, on) => {
  const seen = start($, on, DEFER)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'target', args: 'prod', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  expect(seen.statuses.at(-1)).toContain('dbt prod')
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  expect(String(seen.statuses.at(-1))).not.toContain('dbt prod')
  await $.tool.call({ tool: 'Bash', command: 'dbt run' })
  expect(seen.bash.at(-1)).toBe('dbt run --defer --state /work/prod-state --favor-state')
})
