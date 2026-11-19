import { expect, mock, test } from 'claude-code/testing'

import { nothingToReport } from './inert-features'

const ROOT = '/work/acme_secret_project'
const MODEL = 'fct_orders'
const SESSION = 'a1b2c3d4-0000-4000-8000-000000000001'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

// What the CLI is allowed to receive: the flags of each action and the shape of each value.
const ALLOWED: Record<string, RegExp> = {
  '--session': /^claude:[A-Za-z0-9_-]{1,128}$/,
  '--plugin-version': /^(\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?|unknown)$/,
  '--install-id': UUID,
  '--os': /^(macos|linux|windows|wsl|unknown)$/,
  '--feature': /^(lineage|dbt_show|profile_ctes|scan_cost|comments|sql_graph|health|runs|to_model|cost_gate|health_push_gate)$/,
  '--outcome': /^(opened|failed|held|allowed)$/,
}

type Options = {
  /** The environment the plugin reads; unset means nothing is set. */
  env?: Record<string, string>
  /** What the store holds at the start; shared across sessions when the same object is passed. */
  store?: Map<string, unknown>
  /** How `altimate tool report-event` answers, in place of success. */
  event?: (argv: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }> | { exitCode: number; stdout: string; stderr: string }
  /** The manifest's version. */
  version?: string
  platform?: string
  /** `$.ui.open` fails. */
  openFails?: boolean
  /** Every read of the install id from the store waits for this. */
  holdStore?: Promise<void>
  /** The team comments the CLI lists. */
  comments?: unknown[]
}

/** A dbt project, the CLI answering every other feature with nothing to report, and each usage event recorded. */
async function start($: any, on: any, options: Options = {}) {
  const clock = mock.clock(on)
  mock.env(on, options.env ?? {})
  const store = options.store ?? new Map<string, unknown>()
  const events: string[][] = []
  const toasts: string[] = []
  const logs: { text: string; to?: string }[] = []
  on('store.get', async (_: unknown, e: { key: string }) => {
    if (e.key === 'usage.installId') await options.holdStore
    return { value: store.get(e.key) }
  })
  on('store.set', (_: unknown, e: { key: string; value: unknown }) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('session.id', () => ({ value: SESSION }))
  on('session.info', () => ({ value: { platform: options.platform ?? 'macos', isHosted: false } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT }))
  on('session.cwd', () => ({ value: ROOT }))
  on('command.register', (_: unknown, e: { name: string }) => ({ value: { command: e.name } }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', (_: unknown, e: { answer: string }) => ({ text: e.answer }))
  on('session.end', () => ({ sessionId: 'test' }))
  on('ui.open', () => {
    if (options.openFails) throw new Error('no room for a pane')
    return { value: {} }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_: unknown, e: { text: string }) => {
    // The dbt doctor's own toast at session start (no dbt here) is not this test's.
    if (!e.text.startsWith('⚕ dbt doctor')) toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_: unknown, e: { text: string; to?: string }) => {
    logs.push(e)
    return { value: undefined }
  })
  on('ui.render', ($$: any, e: any) => {
    const { Box } = $$.ui.resolve(e)
    return <Box key="engine" />
  })
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: e.path === `${ROOT}/dbt_project.yml` }))
  on('fs.stat', () => {
    throw new Error('ENOENT')
  })
  on('fs.list', () => ({ value: [] }))
  on('fs.read', (_: unknown, e: { path: string }) => {
    if (e.path.endsWith('/.claude-plugin/plugin.json')) return { value: JSON.stringify({ name: 'altimate-code', version: options.version ?? '1.8.2' }) }
    if (e.path === `${ROOT}/dbt_project.yml`) return { value: "name: 'acme_secret_project'\n" }
    if (e.path === `${ROOT}/models/${MODEL}.sql`) return { value: 'select order_id, secret_column from raw.orders' }
    throw new Error('ENOENT ' + e.path)
  })
  on('tool.list', () => ({ value: [] }))
  on('mcp.connect', () => ({ value: { isConnected: false, reason: 'not_connected', message: 'off' } }))
  on('tool.call', () => ({ result: { ok: true } }))
  on('process.run', async (_: unknown, e: { argv: readonly string[] }) => {
    const argv = [...e.argv]
    if (argv[1] === 'tool' && argv[2] === 'report-event') {
      events.push(argv)
      return { value: options.event ? await options.event(argv) : { exitCode: 0, stdout: '', stderr: '' } }
    }
    if (argv[3] === 'dbt_map_relations')
      return { value: { exitCode: 0, stdout: JSON.stringify({ status: 'ok', output: '', metadata: { mappings: [{ raw: 'raw.orders', replaceWith: "{{ source('raw', 'orders') }}", match: 'exact' }] } }), stderr: '' } }
    if (argv[3] === 'docs_share_comments' && options.comments)
      return { value: { exitCode: 0, stdout: JSON.stringify({ status: 'ok', output: '', metadata: { success: true, threads: options.comments } }), stderr: '' } }
    const inert = nothingToReport(argv)
    if (inert) return { value: inert }
    return { value: { exitCode: 1, stdout: '', stderr: 'not this test' } }
  })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.settle()
  const usage = () => events.filter(argv => argv[3]?.startsWith('plugin_'))
  const flag = (argv: string[], name: string) => argv[argv.indexOf(name) + 1]
  return { clock, store, events, usage, flag, toasts, logs }
}

const run = async ($: any, clock: any, command: string, args = '') => {
  const answer = await $.command.run({ command, args } as any)
  await clock.settle()
  return answer
}

test('a first session start sends exactly one plugin_session_start with the plugin version, the OS and a new install id', async ($, on) => {
  const { usage, flag, store } = await start($, on)
  const events = usage()
  expect(events).toHaveLength(1)
  const [argv] = events
  expect(argv!.slice(0, 4)).toEqual(['altimate', 'tool', 'report-event', 'plugin_session_start'])
  expect(flag(argv!, '--session')).toBe(`claude:${SESSION}`)
  expect(flag(argv!, '--plugin-version')).toBe('1.8.2')
  expect(flag(argv!, '--os')).toBe('macos')
  expect(flag(argv!, '--install-id')).toMatch(UUID)
  // The install id is the one kept in the plugin's store.
  expect(store.get('usage.installId')).toBe(flag(argv!, '--install-id'))
})

test("the install id stays the same across sessions on the machine: the next session's start sends the one kept", async ($, on) => {
  const store = new Map<string, unknown>()
  const first = await start($, on, { store })
  const id = first.flag(first.usage()[0]!, '--install-id')
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await first.clock.settle()
  const starts = first.usage().filter(argv => argv[3] === 'plugin_session_start')
  expect(starts).toHaveLength(2)
  expect(starts.map(argv => first.flag(argv, '--install-id'))).toEqual([id, id])
  expect([...store.keys()].filter(key => key === 'usage.installId')).toHaveLength(1)
})

test('an install id kept from an earlier run is sent as it is', async ($, on) => {
  const kept = '0f3c2a1e-6b7d-4c8e-9f10-1a2b3c4d5e6f'
  const { usage, flag } = await start($, on, { store: new Map([['usage.installId', kept]]) })
  expect(flag(usage()[0]!, '--install-id')).toBe(kept)
})

for (const broken of ['/Users/someone/project', '0f3c2a1e-6b7d-0c8e-9f10-1a2b3c4d5e6f', 42]) {
  test(`an install id in the store that the CLI would refuse (${JSON.stringify(broken)}) is replaced with a fresh UUID`, async ($, on) => {
    const store = new Map<string, unknown>([['usage.installId', broken]])
    const { usage, flag } = await start($, on, { store })
    const id = flag(usage()[0]!, '--install-id')
    expect(id).toMatch(UUID)
    expect(store.get('usage.installId')).toBe(id)
  })
}

for (const [version, sent] of [
  ['1.8.2+build.7', '1.8.2+build.7'],
  ['1.8.2-rc.1', '1.8.2-rc.1'],
  ['1.8.2-01', 'unknown'],
  ['1.8.2-foo..bar', 'unknown'],
] as const) {
  test(`the manifest version ${version} is sent as ${sent}, as the CLI reads a version`, async ($, on) => {
    const { usage, flag } = await start($, on, { version })
    expect(flag(usage()[0]!, '--plugin-version')).toBe(sent)
  })
}

test('the OS is sent as Claude Code names it, and anything else as unknown; an unreadable version as unknown', async ($, on) => {
  const { usage, flag } = await start($, on, { platform: 'wsl', version: 'not a version' })
  expect(flag(usage()[0]!, '--os')).toBe('wsl')
  expect(flag(usage()[0]!, '--plugin-version')).toBe('unknown')
})

test('each panel and command sends one plugin_feature_used with its name when opened', async ($, on) => {
  const { clock, usage, flag } = await start($, on)
  const commands: [string, string, string][] = [
    ['lineage', MODEL, 'lineage'],
    ['dbt-show', MODEL, 'dbt_show'],
    ['profile-ctes', MODEL, 'profile_ctes'],
    ['scan-cost', '', 'scan_cost'],
    ['comments', '', 'comments'],
    ['sql-graph', MODEL, 'sql_graph'],
    ['health', '', 'health'],
    ['runs', '', 'runs'],
    ['to-model', `fct_new models/${MODEL}.sql`, 'to_model'],
  ]
  for (const [command, args, feature] of commands) {
    const before = usage().length
    await run($, clock, command, args)
    const sent = usage().slice(before)
    expect({ command, sent: sent.map(argv => [argv[3], flag(argv, '--feature'), flag(argv, '--outcome')]) }).toEqual({ command, sent: [['plugin_feature_used', feature, 'opened']] })
  }
})

test('a panel that cannot open sends failed, not opened', async ($, on) => {
  const { clock, usage, flag } = await start($, on, { openFails: true })
  for (const [command, args, feature] of [
    ['lineage', '', 'lineage'],
    ['dbt-show', '', 'dbt_show'],
    ['comments', '', 'comments'],
    ['runs', '', 'runs'],
    ['sql-graph', MODEL, 'sql_graph'],
    ['profile-ctes', MODEL, 'profile_ctes'],
    ['to-model', `fct_new models/${MODEL}.sql`, 'to_model'],
  ] as const) {
    const before = usage().length
    await run($, clock, command, args)
    expect(usage().slice(before).map(argv => [flag(argv, '--feature'), flag(argv, '--outcome')])).toEqual([[feature, 'failed']])
  }
})

test('no event carries a project, model or column name, SQL or a path: only the allowed flags, each value of its shape', async ($, on) => {
  const { clock, usage } = await start($, on)
  for (const [command, args] of [
    ['lineage', `${MODEL}.secret_column`],
    ['dbt-show', 'select secret_column from raw.orders'],
    ['sql-graph', MODEL],
    ['to-model', `fct_new models/${MODEL}.sql`],
    ['health', ''],
  ])
    await run($, clock, command!, args)
  const events = usage()
  expect(events.length).toBeGreaterThan(5)
  for (const argv of events) {
    expect(argv.slice(0, 3)).toEqual(['altimate', 'tool', 'report-event'])
    const flags = argv.slice(4)
    expect(flags.length % 2).toBe(0)
    for (let i = 0; i < flags.length; i += 2) {
      const [name, value] = [flags[i]!, flags[i + 1]!]
      expect(Object.keys(ALLOWED)).toContain(name)
      expect(value).toMatch(ALLOWED[name]!)
    }
    expect(argv.join(' ')).not.toMatch(/acme|secret|fct_orders|orders|select|\/work|models/)
  }
})

for (const [name, env] of [
  ['ALTIMATE_TELEMETRY_DISABLED=true', { ALTIMATE_TELEMETRY_DISABLED: 'true' }],
  ['ALTIMATE_TELEMETRY_DISABLED=1', { ALTIMATE_TELEMETRY_DISABLED: '1' }],
  ['ALTIMATE_TELEMETRY_DISABLED=TRUE', { ALTIMATE_TELEMETRY_DISABLED: 'TRUE' }],
  ['OPENCODE_DISABLE_TELEMETRY=1', { OPENCODE_DISABLE_TELEMETRY: '1' }],
] as const) {
  test(`with ${name} no event is sent, no CLI is started for one, and no install id is made`, async ($, on) => {
    const { clock, events, store } = await start($, on, { env })
    for (const [command, args] of [
      ['lineage', MODEL],
      ['runs', ''],
      ['health', ''],
      ['scan-cost', ''],
    ])
      await run($, clock, command!, args)
    expect(events).toEqual([])
    expect(store.has('usage.installId')).toBe(false)
  })
}

test('ALTIMATE_TELEMETRY_DISABLED set to something else (false, 0) leaves usage on, as the CLI reads it', async ($, on) => {
  const { usage } = await start($, on, { env: { ALTIMATE_TELEMETRY_DISABLED: 'false', OPENCODE_DISABLE_TELEMETRY: '0' } })
  expect(usage()).toHaveLength(1)
})

test('an altimate-code without the new actions refuses them: nothing is shown, no toast, nothing logged outside the debug log', async ($, on) => {
  const refused = { exitCode: 1, stdout: '', stderr: 'the action must be one of summary_shown, open_pressed, command_run, built, build_failed, no_browser' }
  const { clock, usage, toasts, logs } = await start($, on, { event: () => refused })
  const answer: any = await run($, clock, 'runs')
  expect(answer.text).toBe('The dbt runs are open.')
  expect(usage().map(argv => argv[3])).toEqual(['plugin_session_start', 'plugin_feature_used'])
  expect(toasts).toEqual([])
  expect(logs.filter(log => log.to !== 'debug' && /report-event|usage|plugin_/.test(log.text))).toEqual([])
})

test('an altimate-code without report-event at all, or none on PATH, is silent too', async ($, on) => {
  const { clock, usage, toasts } = await start($, on, {
    event: argv => {
      if (argv[0] === 'altimate') throw new Error('spawn altimate ENOENT')
      return { exitCode: 1, stdout: '', stderr: 'Unknown argument: report-event' }
    },
  })
  await run($, clock, 'health')
  // Both names are tried, as for every CLI call; neither answer is shown.
  expect(usage().length).toBeGreaterThan(0)
  expect(toasts).toEqual([])
})

test('an event never holds a hook: a CLI that never answers leaves the session start and the command answering at once', async ($, on) => {
  const never = new Promise<never>(() => {})
  const { clock, usage } = await start($, on, { event: () => never })
  const answer: any = await run($, clock, 'runs')
  expect(answer.text).toBe('The dbt runs are open.')
  expect(usage().map(argv => argv[3])).toEqual(['plugin_session_start', 'plugin_feature_used'])
})

test('a command that stops before its panel opens (a bad argument) sends nothing: only a panel that opens, or fails to, is counted', async ($, on) => {
  const { clock, usage } = await start($, on)
  const before = usage().length
  await run($, clock, 'to-model', 'not-a-name!')
  await run($, clock, 'sql-graph', '')
  await run($, clock, 'profile-ctes', '')
  expect(usage().slice(before)).toEqual([])
})

test('events sent together on a first run share one install id: the second waits for the first one to be made', async ($, on) => {
  let release!: () => void
  const holdStore = new Promise<void>(resolve => (release = resolve))
  const store = new Map<string, unknown>()
  const { clock, usage, flag } = await start($, on, { store, holdStore })
  // The session start's event is still waiting on the store; a command sends another meanwhile.
  await run($, clock, 'runs')
  release()
  await clock.settle()
  const ids = usage().map(argv => flag(argv, '--install-id'))
  expect(usage().map(argv => argv[3])).toEqual(['plugin_session_start', 'plugin_feature_used'])
  expect(new Set(ids).size).toBe(1)
  expect(store.get('usage.installId')).toBe(ids[0])
})

test("the comments band's Open button sends comments opened, as /comments does", async ($, on) => {
  const thread = {
    share_id: 7,
    share_name: 'Finance review',
    group_id: 11,
    file_path: `models/${MODEL}.sql`,
    highlight: 'secret_column',
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
    messages: [{ id: 100, author: 'Ada', text: 'Is this net of refunds?' }],
  }
  const { clock, usage, flag } = await start($, on, { comments: [thread] })
  const band = await $.ui.mount({
    plugin: 'altimate-code',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
    surface: 'terminal',
  } as any)
  const before = usage().length
  await band.press({ key: 'comments-open' })
  await clock.settle()
  await band.unmount()
  expect(usage().slice(before).map(argv => [flag(argv, '--feature'), flag(argv, '--outcome')])).toEqual([['comments', 'opened']])
})
