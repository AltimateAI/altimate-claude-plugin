import { expect, mock, test } from 'claude-code/testing'

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

/** Answers each `altimate integrations …` call the way the CLI does, and remembers the calls. */
function fakeCli(on: any, answers: { connect: { exitCode: number; body: Record<string, unknown> } }) {
  const calls: string[][] = []
  let secretSet = false
  on('process.run', (_: unknown, e: { argv: string[] }) => {
    const args = e.argv.slice(2)
    calls.push(args)
    const reply = (body: unknown, exitCode = 0) => ({ value: { exitCode, stdout: JSON.stringify(body), stderr: '' } })
    switch (args[0]) {
      case 'status':
      case 'detect':
        return reply(STATUS)
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
      case 'connect':
      case 'update':
        return reply(answers.connect.body, answers.connect.exitCode)
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
  expect(calls.some(args => args[0] === 'open-token-page')).toBe(true)

  await ui.press({ key: 'jira-submit' })
  await clock.settle()
  expect(calls.some(args => args[0] === 'connect' && args[1] === 'jira' && !args.includes('--local-only'))).toBe(true)
  expect(await ui.find({ type: 'Text', text: /Jira rejected the credentials \(401\)/ })).toBeDefined()
  expect(await ui.find({ key: 'jira-submit' })).toBeDefined()

  await ui.press({ key: 'jira-keep-local' })
  await clock.settle()
  expect(calls.some(args => args[0] === 'connect' && args.includes('--local-only'))).toBe(true)
  await ui.unmount()
})
