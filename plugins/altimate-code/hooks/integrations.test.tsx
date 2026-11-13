import { expect, mock, test as kitTest } from 'claude-code/testing'

// These tests are about this half of the plugin: the dbt helpers, which run the project's own dbt, are
// off here and tested in dbt-mods.test.tsx.
const test = (name: string, body: Parameters<typeof kitTest>[1]) => kitTest(name, { options: { dbt_mods: false } }, body as any)

const PANE = {
  plugin: 'altimate-code',
  component: 'Pane',
  requestId: 'altimate-integrations',
  props: {
    title: 'Altimate integrations',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const provider = (id: string, name: string, state: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  state,
  source: null,
  account: null,
  syncable: true,
  sync: 'local',
  updatedAt: null,
  expiresAt: null,
  note: null,
  ...extra,
})

const STATUS = {
  workspace: { name: 'Acme', tenant: 'acme' },
  providers: [
    provider('github', 'GitHub', 'rejected', { account: 'octo', note: 'Token rejected, update it' }),
    provider('jira', 'Jira', 'not_found'),
    provider('linear', 'Linear', 'available', { source: { kind: 'mcp-remote', label: 'Claude MCP (linear)' }, syncable: false }),
  ],
}

const field = (name: string, label: string, secret: boolean, extra: Record<string, unknown> = {}) => ({
  name,
  label,
  secret,
  required: true,
  value: null,
  hasValue: false,
  masked: null,
  ...extra,
})

/** The timeout the plugin gave each command, by the command's arguments. */
const timeouts: Record<string, unknown> = {}
/** Answers each `altimate integrations …` call the way the CLI does, and remembers the calls. */
function fakeCli(on: any, answers: { connect: { exitCode: number; body: Record<string, unknown> }; sync?: Record<string, unknown>; status?: unknown; discardFails?: boolean }) {
  const calls: string[][] = []
  let secretSet = false
  on('process.run', (_: unknown, e: { readonly argv: readonly string[] }) => {
    const args = e.argv.slice(2)
    calls.push(args)
    timeouts[args.join(' ')] = (e as any).init?.timeoutMs
    const reply = (body: unknown, exitCode = 0) => ({ value: { exitCode, stdout: JSON.stringify(body), stderr: '' } })
    switch (args[0]) {
      case 'status':
      case 'detect':
        return reply(answers.status ?? STATUS)
      case 'fields':
        return reply({
          provider: 'jira',
          variant: 'cloud',
          variants: ['cloud', 'server'],
          fields: [
            field('jiraDomain', 'Site', false, { value: 'acme', hasValue: true }),
            field('jiraEmail', 'Email', false),
            field('jiraApiToken', 'API token', true, secretSet ? { hasValue: true, masked: '••••a1b2' } : {}),
          ],
          tokenUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens',
        })
      case 'set-secret':
        secretSet = true
        return reply({ provider: 'jira', field: 'jiraApiToken', masked: '••••a1b2' })
      case 'set':
        return reply({ provider: 'jira', field: args[2] })
      case 'open-token-page':
        return reply({ provider: 'jira', variant: 'cloud', tokenUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens' })
      case 'discard':
        if (answers.discardFails) return reply({ message: 'store locked' }, 1)
        secretSet = false
        return reply({ provider: 'jira', status: 'discarded' })
      case 'connect':
      case 'update':
        // A refused secret is not kept: the form shows it as not set again.
        if (answers.connect.exitCode !== 0) secretSet = false
        return reply(answers.connect.body, answers.connect.exitCode)
      case 'sync':
        return reply(answers.sync ?? {})
      default:
        return reply({})
    }
  })
  return calls
}

test('rows offer Add credentials or Update, never a browser sign-in', async ($, on) => {
  const clock = mock.clock(on)
  on('command.register', () => ({ value: { command: 'integrations' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  fakeCli(on, { connect: { exitCode: 0, body: {} } })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ key: 'github-update' })).toBeDefined()
    expect(await ui.find({ key: 'jira-add' })).toBeDefined()
    expect(await ui.find({ key: 'linear-add' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Token rejected · Update/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /browser|Reconnect/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('the form shows a secret as a masked tail and keeps the form open on a refusal', async ($, on) => {
  const clock = mock.clock(on)
  on('command.register', () => ({ value: { command: 'integrations' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const calls = fakeCli(on, { connect: { exitCode: 1, body: { status: 'rejected', sync: 'local', message: 'Jira rejected the credentials (401)' } } })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'jira-add' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /API token: not set/ })).toBeDefined()
  expect((await ui.find({ key: 'jira-jiraDomain' }))?.text).toContain('acme')

  await ui.press({ key: 'jira-jiraApiToken-paste' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /API token: ✓ ••••a1b2/ })).toBeDefined()
  expect(calls.some(args => args[0] === 'set-secret' && args.includes('--from-clipboard'))).toBe(true)

  await ui.press({ key: 'jira-jiraApiToken-create' })
  await clock.settle()
  // The press is what opens the browser, so the CLI is asked to open it.
  expect(calls.some(args => args[0] === 'open-token-page' && args.includes('--open'))).toBe(true)

  await ui.press({ key: 'jira-submit' })
  await clock.settle()
  expect(calls.some(args => args[0] === 'connect' && args[1] === 'jira' && !args.includes('--local-only'))).toBe(true)
  expect(await ui.find({ type: 'Text', text: /Jira rejected the credentials \(401\)/ })).toBeDefined()
  expect(await ui.find({ key: 'jira-submit' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /API token: not set/ })).toBeDefined()

  await ui.press({ key: 'jira-keep-local' })
  await clock.settle()
  expect(calls.some(args => args[0] === 'connect' && args.includes('--local-only'))).toBe(true)

  const before = calls.filter(args => args[0] === 'discard').length
  await ui.press({ key: 'jira-cancel' })
  await clock.settle()
  expect(calls.filter(args => args[0] === 'discard').length).toBe(before + 1)
  expect(calls.filter(args => args[0] === 'discard').every(args => args[1] === 'jira')).toBe(true)
  await ui.unmount()
})

/** A CLI that answers `status`/`detect` with the given providers and everything else with `reply`. */
function cliWith(on: any, providers: unknown[], reply: (args: string[]) => { exitCode: number; stdout: string; stderr?: string } | undefined) {
  const calls: string[][] = []
  on('process.run', (_: unknown, e: { readonly argv: readonly string[] }) => {
    const args = e.argv.slice(2)
    calls.push(args)
    timeouts[args.join(' ')] = (e as any).init?.timeoutMs
    const custom = reply(args)
    if (custom) return { value: { stderr: '', ...custom } }
    return { value: { exitCode: 0, stdout: JSON.stringify({ workspace: { name: 'Acme', tenant: 'acme', linked: true, id: 1, signedIn: true }, providers }), stderr: '' } }
  })
  return calls
}

test('a synced row cannot be blocked, and a hand-made one is only replaced by adding credentials', async ($, on) => {
  const clock = mock.clock(on)
  on('command.register', () => ({ value: { command: 'integrations' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  cliWith(
    on,
    [
      provider('github', 'GitHub', 'connected', { sync: 'synced' }),
      provider('jira', 'Jira', 'rejected', { sync: 'synced', managed: false }),
      provider('linear', 'Linear', 'connected', { sync: 'blocked' }),
    ],
    () => undefined,
  )
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'github-block' })).toBeUndefined()
  expect(await ui.find({ key: 'github-off' })).toBeDefined()
  expect(await ui.find({ key: 'jira-add' })).toBeDefined()
  expect(await ui.find({ key: 'jira-update' })).toBeUndefined()
  expect(await ui.find({ key: 'jira-off' })).toBeUndefined()
  expect(await ui.find({ key: 'linear-allow' })).toBeDefined()
  await ui.unmount()
})

test('a row showing a newer hand-made connection still offers Update and Disconnect for the one this tool made', async ($, on) => {
  const clock = mock.clock(on)
  on('command.register', () => ({ value: { command: 'integrations' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  cliWith(
    on,
    [
      provider('github', 'GitHub', 'connected', { sync: 'synced' }),
      provider('jira', 'Jira', 'connected', { sync: 'synced', managed: false }),
      provider('linear', 'Linear', 'not_found', { sync: 'local' }),
    ],
    () => undefined,
  )
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'github-update' })).toBeDefined()
  expect(await ui.find({ key: 'github-off' })).toBeDefined()
  expect(await ui.find({ key: 'jira-update' })).toBeUndefined()
  expect(await ui.find({ key: 'jira-off' })).toBeUndefined()
  await ui.unmount()
})

test('Keep local shows the notes the CLI returned', async ($, on) => {
  const clock = mock.clock(on)
  on('command.register', () => ({ value: { command: 'integrations' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  fakeCli(on, { connect: { exitCode: 0, body: { status: 'connected', sync: 'local', message: 'Could not detach it from the linked workspace: boom' } } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'jira-add' })
  await clock.settle()
  await ui.press({ key: 'jira-keep-local' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /kept local · Could not detach it from the linked workspace: boom/ })).toBeDefined()
  await ui.unmount()
})

test('a failed action shows the reason the CLI printed on stdout, and a disconnect says what it removed', async ($, on) => {
  const clock = mock.clock(on)
  on('command.register', () => ({ value: { command: 'integrations' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  let disconnect: { exitCode: number; stdout: string } = { exitCode: 1, stdout: JSON.stringify({ status: 'failed', message: 'Sign in to Altimate to remove it' }) }
  cliWith(on, [provider('github', 'GitHub', 'connected', { sync: 'synced' })], args => (args[0] === 'disconnect' ? disconnect : undefined))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'github-off' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /Sign in to Altimate to remove it/ })).toBeDefined()

  disconnect = { exitCode: 0, stdout: JSON.stringify({ provider: 'github', status: 'disconnected', removed: true, removedFromWorkspace: 1 }) }
  await ui.press({ key: 'github-off' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /GitHub disconnected · removed from your Altimate workspace/ })).toBeDefined()

  disconnect = { exitCode: 0, stdout: JSON.stringify({ provider: 'github', status: 'disconnected', removed: true, removedFromWorkspace: 1, detached: false, message: 'Could not detach it from the linked workspace: boom' }) }
  await ui.press({ key: 'github-off' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /removed from your Altimate workspace · Could not detach it from the linked workspace: boom/ })).toBeDefined()
  await ui.unmount()
})

test('a sync with a failed provider shows its reason, and a timeout is not reported as a missing CLI', async ($, on) => {
  const clock = mock.clock(on)
  on('command.register', () => ({ value: { command: 'integrations' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  cliWith(on, [provider('github', 'GitHub', 'detected')], args =>
    args[0] === 'sync'
      ? { exitCode: 1, stdout: JSON.stringify({ results: [{ id: 'github', result: 'failed', reason: 'connection test failed', steps: [] }] }) }
      : undefined,
  )
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'sync-everything' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /GitHub: connection test failed/ })).toBeDefined()
  await ui.unmount()
})

test('Sync all makes one call per provider with the per-provider timeout, and a failing provider does not stop the rest', async ($, on) => {
  const clock = mock.clock(on)
  on('command.register', () => ({ value: { command: 'integrations' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const calls = cliWith(on, [provider('github', 'GitHub', 'detected')], args => {
    if (args[0] !== 'sync') return undefined
    if (args[1] === 'jira') return { exitCode: 1, stdout: JSON.stringify({ results: [{ id: 'jira', result: 'failed', reason: 'connection test failed', steps: [] }] }) }
    return { exitCode: 0, stdout: JSON.stringify({ results: [{ id: args[1], result: 'synced', steps: [] }] }) }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'sync-everything' })
  await clock.settle()
  expect(calls.filter(args => args[0] === 'sync')).toEqual([
    ['sync', 'github', '--keep-synced', '--json'],
    ['sync', 'jira', '--keep-synced', '--json'],
    ['sync', 'linear', '--keep-synced', '--json'],
  ])
  expect(calls.some(args => args.includes('--all'))).toBe(false)
  for (const id of ['github', 'jira', 'linear']) expect(timeouts[`sync ${id} --keep-synced --json`]).toBe(300_000)
  expect(await ui.find({ type: 'Text', text: /GitHub synced · Jira: connection test failed · Linear synced/ })).toBeDefined()
  await ui.unmount()
})

test('the band connects what was found, after dropping what an earlier form left behind', async ($, on) => {
  const clock = mock.clock(on)
  on('command.register', () => ({ value: { command: 'integrations' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const found = { ...STATUS, providers: [provider('github', 'GitHub', 'detected', { source: { kind: 'cli', label: 'gh CLI' } }), STATUS.providers[1], STATUS.providers[2]] }
  const cli = fakeCli(on, { status: found, connect: { exitCode: 0, body: { status: 'connected', sync: 'local' } } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const band = await $.ui.mount({ plugin: 'altimate-code', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false } } as any)
  await band.press({ key: 'keep-local' })
  await clock.settle()
  const order = cli.map(args => args[0]).filter(verb => verb === 'discard' || verb === 'connect')
  expect(order).toEqual(['discard', 'connect'])
  expect(cli).toContainEqual(['discard', 'github', '--json'])
  await band.unmount()
})

test('the band does not connect when dropping earlier input fails', async ($, on) => {
  const clock = mock.clock(on)
  on('command.register', () => ({ value: { command: 'integrations' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const found = { ...STATUS, providers: [provider('github', 'GitHub', 'detected', { source: { kind: 'cli', label: 'gh CLI' } }), STATUS.providers[1], STATUS.providers[2]] }
  const cli = fakeCli(on, { status: found, discardFails: true, connect: { exitCode: 0, body: { status: 'connected', sync: 'local' } } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const band = await $.ui.mount({ plugin: 'altimate-code', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false } } as any)
  await band.press({ key: 'keep-local' })
  await clock.settle()
  expect(cli.some(args => args[0] === 'connect')).toBe(false)
  await band.unmount()
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: /GitHub: could not clear earlier input: store locked/ })).toBeDefined()
  await pane.unmount()
})

test('a credential found here is offered next to a hand-made connection', async ($, on) => {
  const clock = mock.clock(on)
  on('command.register', () => ({ value: { command: 'integrations' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  cliWith(
    on,
    [
      provider('github', 'GitHub', 'connected', { sync: 'synced', managed: false, found: { source: { kind: 'cli', label: 'gh CLI' }, account: 'octo' } }),
      provider('jira', 'Jira', 'not_found'),
      provider('linear', 'Linear', 'not_found'),
    ],
    () => undefined,
  )
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'github-use' })).toBeDefined()
  expect(await ui.find({ key: 'github-local' })).toBeDefined()
  expect(await ui.find({ key: 'github-off' })).toBeUndefined()
  await ui.unmount()
})

test('a session without a person at the prompt does not scan the machine', async ($, on) => {
  const clock = mock.clock(on)
  on('command.register', () => ({ value: { command: 'integrations' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const cli = fakeCli(on, { connect: { exitCode: 0, body: {} } })
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await clock.settle()
  expect(cli).toEqual([])
})

test('a status refresh that times out does not tell the user to install the CLI', async ($, on) => {
  const clock = mock.clock(on)
  on('command.register', () => ({ value: { command: 'integrations' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', () => ({ deny: 'timed out while the command was still running' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Could not run altimate/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /not found: install it/ })).toBeUndefined()
  await ui.unmount()
})

test('connecting a found credential kept local shows the notes the CLI returned', async ($, on) => {
  const clock = mock.clock(on)
  on('command.register', () => ({ value: { command: 'integrations' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const found = { ...STATUS, providers: [provider('github', 'GitHub', 'detected', { account: 'octo' }), STATUS.providers[1], STATUS.providers[2]] }
  const cli = fakeCli(on, { status: found, connect: { exitCode: 0, body: { status: 'connected', sync: 'local', message: 'Sync is blocked for this provider, kept local.' } } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'github-local' })
  await clock.settle()
  expect(cli).toContainEqual(['connect', 'github', '--local-only', '--json'])
  expect(await ui.find({ type: 'Text', text: /GitHub connected · kept local · Sync is blocked for this provider, kept local\./ })).toBeDefined()
  await ui.unmount()
})

test('a connect that is not linked to a workspace says so', async ($, on) => {
  const clock = mock.clock(on)
  on('command.register', () => ({ value: { command: 'integrations' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  fakeCli(on, { connect: { exitCode: 0, body: { status: 'connected', sync: 'synced', account: null, message: 'Not linked to a workspace: run altimate link' } } })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'jira-add' })
  await clock.settle()
  await ui.press({ key: 'jira-submit' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /Jira saved · Not linked to a workspace: run altimate link/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /synced to your Altimate workspace/ })).toBeUndefined()
  await ui.unmount()
})

test('a sync the CLI skipped shows its reason, not synced', async ($, on) => {
  const clock = mock.clock(on)
  on('command.register', () => ({ value: { command: 'integrations' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  fakeCli(on, {
    connect: { exitCode: 0, body: {} },
    sync: { workspace: { name: 'Acme', tenant: 'acme' }, results: [{ id: 'github', result: 'skipped', reason: 'Not linked to a workspace', steps: [] }] },
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'sync-everything' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /GitHub: Not linked to a workspace/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /synced to your Altimate workspace/ })).toBeUndefined()
  await ui.unmount()
})

test('an unlinked folder offers Link workspace; choosing one links, then syncs', async ($, on) => {
  const clock = mock.clock(on)
  on('command.register', () => ({ value: { command: 'integrations' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const calls: string[][] = []
  let linked = false
  on('process.run', (_: unknown, e: { readonly argv: readonly string[] }) => {
    const argv = e.argv.slice(1)
    calls.push(argv)
    const reply = (body: unknown) => ({ value: { exitCode: 0, stdout: JSON.stringify(body), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv[0] === 'workspace') return reply({ ok: true, workspaces: [{ id: 7, name: 'Analytics' }, { id: 9, name: 'Finance' }] })
    if (argv[0] === 'link') {
      linked = true
      return reply({})
    }
    if (argv[1] === 'sync') return reply({ results: [{ id: 'github', result: 'synced', steps: [{ label: 'Attached to workspace', ok: true }] }] })
    return reply({ ...STATUS, workspace: { name: linked ? 'Analytics' : 'acme', tenant: 'acme', linked, id: linked ? 7 : null } })
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Workspace: not linked/ })).toBeDefined()
  await ui.press({ key: 'link-workspace' })
  await clock.settle()
  expect(calls).toContainEqual(['workspace', 'list', '--json'])
  expect(await ui.find({ key: 'link-9' })).toBeDefined()
  expect(await ui.find({ key: 'link-cancel' })).toBeDefined()

  await ui.press({ key: 'link-7' })
  await clock.settle()
  const run = calls.filter(argv => argv[0] === 'link' || argv[1] === 'sync')
  expect(run).toEqual([
    ['link', '--workspace', '7', '-y'],
    ['integrations', 'sync', 'github', '--keep-synced', '--json'],
    ['integrations', 'sync', 'jira', '--keep-synced', '--json'],
    ['integrations', 'sync', 'linear', '--keep-synced', '--json'],
  ])
  expect(await ui.find({ type: 'Text', text: /Linked to Analytics · GitHub synced/ })).toBeDefined()
  expect(await ui.find({ key: 'link-workspace' })).toBeUndefined()
  await ui.unmount()
})

test('a timed-out command is not rerun against the second binary', async ($, on) => {
  const clock = mock.clock(on)
  on('command.register', () => ({ value: { command: 'integrations' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const bins: string[] = []
  on('process.run', (_: unknown, e: { readonly argv: readonly string[] }) => {
    bins.push(String(e.argv[0]))
    return { deny: 'timed out while the command was still running' }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(new Set(bins)).toEqual(new Set(['altimate']))
})

test('signed out: the band and pane offer Sign in to sync and no sync control; the click runs the browser sign-in', async ($, on) => {
  const clock = mock.clock(on)
  on('command.register', () => ({ value: { command: 'integrations' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const calls: string[][] = []
  let signedIn = false
  on('process.run', (_: unknown, e: { readonly argv: readonly string[] }) => {
    calls.push([...e.argv])
    const reply = (body: unknown) => ({ value: { exitCode: 0, stdout: JSON.stringify(body), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv[1] === 'auth') {
      signedIn = true
      return reply({})
    }
    return reply({
      workspace: { name: signedIn ? 'Acme' : 'not signed in', tenant: signedIn ? 'acme' : '', linked: signedIn, id: null, signedIn },
      providers: [
        provider('github', 'GitHub', 'detected', { source: { kind: 'cli', label: 'gh CLI' } }),
        provider('jira', 'Jira', 'connected', { sync: 'local' }),
        provider('linear', 'Linear', 'not_found'),
      ],
    })
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const band = await $.ui.mount({ plugin: 'altimate-code', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false } } as any)
  expect(await band.find({ key: 'sign-in' })).toBeDefined()
  expect(await band.find({ key: 'keep-local' })).toBeDefined()
  expect(await band.find({ key: 'connect-all' })).toBeUndefined()
  await band.unmount()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Workspace: not signed in/ })).toBeDefined()
  expect(await ui.find({ key: 'link-workspace' })).toBeUndefined()
  expect(await ui.find({ key: 'sync-everything' })).toBeUndefined()
  expect(await ui.find({ key: 'jira-sync' })).toBeUndefined()
  expect(await ui.find({ key: 'github-use' })).toBeUndefined()
  expect(await ui.find({ key: 'github-local' })).toBeDefined()
  expect(calls.some(argv => argv[1] === 'auth')).toBe(false)

  await ui.press({ key: 'sign-in' })
  await clock.settle()
  expect(calls).toContainEqual(['altimate', 'auth', 'login', '-p', 'altimate-backend', '--method', 'Altimate LLM Gateway'])
  expect(await ui.find({ key: 'sign-in' })).toBeUndefined()
  expect(await ui.find({ key: 'sync-everything' })).toBeDefined()
  await ui.unmount()
})
