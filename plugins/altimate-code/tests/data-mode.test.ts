import { expect, test } from 'claude-code/testing'
import { register } from '../hooks/data-workspace.mjs'

const SQL = 'mcp__plugin_altimate-code_altimate-code__sql_execute'
const CONTEXT = 'mcp__plugin_altimate-code_altimate-code__workspace_context'
const USER = { kind: 'composer' }

// Direct event harness also exercises rejections and trusted origins, which the
// test engine stamps itself when a test invokes $.command.run as another plugin.
function fixture() {
  const handlers = []
  register((event, matcher, handler) => {
    handlers.push({ event, matcher: typeof matcher === 'function' ? {} : matcher, fn: handler ?? matcher })
  })
  const commands = []
  const processes = []
  const toolCalls = []
  let toolNames = [SQL, CONTEXT]
  let context = { workspace: { id: 35, name: 'Growth', token: 'receipt' }, summary: 'Company metrics', memory: { status: 'loaded', memories: [] } }
  let process = async (argv, options) => ({ exitCode: 0, stderr: '', stdout: JSON.stringify(argv.includes('list')
    ? { ok: true, workspaces: [{ id: 35, name: 'Growth' }] }
    : { ok: true, ...context, message: 'Saved in this project and published to the workspace.' }) })
  let call = async () => ({ text: JSON.stringify(context) })
  const $ = {
    command: { register: async spec => { commands.push(spec.name) } },
    session: { cwd: async () => '/project' },
    process: { run: async (argv, options) => { processes.push({ argv, options }); return process(argv, options) } },
    tool: { list: async () => toolNames.map(name => ({ name })), call: async args => { toolCalls.push(args); return call(args) } },
    ui: { invalidate: () => {}, open: async () => ({ isPlaced: false }) },
  }
  const run = async (event, input, next = async e => e) => {
    const handler = handlers.find(item => item.event === event && Object.entries(item.matcher).every(([key, value]) => input[key] === value))
    if (!handler) throw new Error('Missing handler: ' + event)
    return handler.fn($, input, next)
  }
  const command = (command, args = '', origin = USER) => run('command.run', { command, args, origin })
  const start = () => run('session.start', {})
  return { $, run, command, start, commands, processes, toolCalls,
    tools: names => { toolNames = names }, process: fn => { process = fn }, call: fn => { call = fn } }
}

test('data mode is off by default and leaves prompts unchanged', async () => {
  const f = fixture()
  await f.start()
  const input = { text: 'Count orders', context: ['existing'], attachments: [{ type: 'image' }], origin: USER }
  expect(await f.run('prompt.submit', input)).toBe(input)
  expect(f.toolCalls.length).toBe(0)
  expect(f.processes.length).toBe(0)
  expect(f.commands).toEqual(['altimate-data', 'altimate-query', 'altimate-mode', 'altimate-workspace', 'altimate-remember'])
})

test('opt-in adds bounded context without changing user text, attachments, origin or existing context', async () => {
  const f = fixture()
  await f.start()
  await f.command('altimate-mode', 'on')
  f.call(async () => ({ text: JSON.stringify({ summary: 'x'.repeat(25000) }) }))
  const input = { text: 'Count orders', context: ['existing'], attachments: [{ type: 'image' }], origin: USER, wait: true }
  const actual = await f.run('prompt.submit', input)
  expect(actual.text).toBe(input.text)
  expect(actual.attachments).toBe(input.attachments)
  expect(actual.origin).toBe(input.origin)
  expect(actual.wait).toBe(true)
  expect(actual.context[0]).toBe('existing')
  expect(actual.context[1]).toContain('Claude remains the reasoning model')
  expect(actual.context[2].length).toBeLessThan(12100)
  expect(f.toolCalls).toEqual([{ tool: CONTEXT }])
  expect(f.processes.length).toBe(0)
})

test('notification, peer, scheduled and plugin prompts never fetch or inject workspace context', async () => {
  const f = fixture()
  await f.start()
  await f.command('altimate-mode', 'on')
  for (const kind of ['task-notification', 'peer', 'scheduled-trigger', 'plugin', 'unclassified']) {
    const input = { text: 'Count orders', origin: { kind } }
    expect(await f.run('prompt.submit', input)).toBe(input)
  }
  expect(f.toolCalls.length).toBe(0)
})

test('mode refuses absent MCP and does not invoke a fallback CLI model', async () => {
  const f = fixture()
  await f.start()
  f.tools([])
  expect((await f.command('altimate-mode', 'on')).text).toContain('unavailable')
  expect((await f.command('altimate-mode', 'status')).text).toContain('OFF')
  expect(f.processes.length).toBe(0)
})

test('denied workspace context reports unknown rather than retaining a prior workspace', async () => {
  const f = fixture()
  await f.start()
  await f.command('altimate-mode', 'on')
  await f.run('prompt.submit', { text: 'data', origin: USER })
  f.call(async () => ({ deny: 'Permission denied' }))
  const result = await f.run('prompt.submit', { text: 'data', origin: USER })
  expect(result.context[1]).toContain('Permission denied')
  expect((await f.command('altimate-remember', 'rule hello')).text).toContain('Nothing was saved')
})

test('clear, resume and off reset mode and receipts', async () => {
  const f = fixture()
  await f.start()
  for (const reset of [() => f.command('clear'), () => f.run('session.end', { reason: 'resume' }), () => f.command('altimate-mode', 'off')]) {
    await f.command('altimate-mode', 'on')
    await f.run('prompt.submit', { text: 'data', origin: USER })
    await reset()
    const input = { text: 'hello', origin: USER }
    expect(await f.run('prompt.submit', input)).toBe(input)
    expect((await f.command('altimate-remember', 'rule hello')).text).toContain('Nothing was saved')
  }
})

test('late context completion after resume cannot inject or restore a workspace receipt', async () => {
  const f = fixture()
  await f.start()
  await f.command('altimate-mode', 'on')
  let finish
  let entered
  const started = new Promise(resolve => { entered = resolve })
  f.call(async () => { entered(); return await new Promise(resolve => { finish = resolve }) })
  const input = { text: 'data', origin: USER }
  const pending = f.run('prompt.submit', input)
  await started
  await f.run('session.end', { reason: 'resume' })
  finish({ text: JSON.stringify({ workspace: { id: 35, token: 'old' } }) })
  expect(await pending).toBe(input)
  expect((await f.command('altimate-remember', 'rule hello')).text).toContain('Nothing was saved')
})

test('workspace linking passes an id as argv, disables backfill and cannot replace an existing link', async () => {
  const f = fixture()
  await f.start()
  await f.command('altimate-workspace', 'link 35')
  expect(f.processes[0].argv).toEqual(['altimate-code', 'link', '--workspace', '35', '--directory', '/project'])
  expect(f.processes[0].options.env.ALTIMATE_DISABLE_MEMORY).toBe('1')
  expect(f.processes[0].argv.includes('--yes')).toBe(false)
  const count = f.processes.length
  await f.command('altimate-workspace', 'link 35; touch /tmp/no')
  await f.command('altimate-workspace', 'link 36', { kind: 'plugin', name: 'other' })
  expect(f.processes.length).toBe(count)
})

test('explicit remember passes content on stdin and the last confirmed receipt, never a shell or model loop', async () => {
  const f = fixture()
  await f.start()
  await f.command('altimate-workspace')
  const content = 'Use `net` $(touch /tmp/no) for revenue'
  const result = await f.command('altimate-remember', 'metrics/revenue ' + content)
  expect(result.text).toContain('published')
  const save = f.processes.at(-1)
  expect(save.argv).toEqual(['altimate-code', 'workspace-client', 'remember', '--directory', '/project', '--token=receipt', '--id=metrics/revenue'])
  expect(save.options.stdin).toBe(content)
  expect(save.argv.some(arg => arg.includes('touch'))).toBe(false)
})

test('model/plugin command calls and oversized memories cannot publish', async () => {
  const f = fixture()
  await f.start()
  await f.command('altimate-workspace')
  const count = f.processes.length
  await f.command('altimate-remember', 'rule hello', { kind: 'plugin', name: 'other' })
  await f.command('altimate-remember', 'rule hello', { kind: 'sdk' })
  await f.command('altimate-remember', 'rule ' + 'x'.repeat(2049))
  expect(f.processes.length).toBe(count)
})

test('automatic prompt context does not grant the receipt needed for an explicit save', async () => {
  const f = fixture()
  await f.start()
  await f.command('altimate-mode', 'on')
  await f.run('prompt.submit', { text: 'Count orders', origin: USER })
  expect((await f.command('altimate-remember', 'rule hello')).text).toContain('Inspect /altimate-workspace first')
  expect(f.processes.length).toBe(0)
})

test('remember ids that look like flags remain a single id value', async () => {
  const f = fixture()
  await f.start()
  await f.command('altimate-workspace')
  await f.command('altimate-remember', '--directory=/outside hello')
  expect(f.processes.at(-1).argv.at(-1)).toBe('--id=--directory=/outside')
  expect(f.processes.at(-1).options.cwd).toBe('/project')
})

test('old CLI and thrown saves report recovery with no retry', async () => {
  const f = fixture()
  await f.start()
  f.process(async () => ({ exitCode: 0, stdout: 'Usage: altimate-code', stderr: '' }))
  expect((await f.command('altimate-workspace')).text).toContain('Update Altimate Code')
  f.process(async () => ({ exitCode: 0, stdout: JSON.stringify({ ok: true, workspace: { id: 35, token: 'receipt' }, workspaces: [] }), stderr: '' }))
  await f.command('altimate-workspace')
  let saves = 0
  f.process(async () => { saves++; throw new Error('interrupted') })
  expect((await f.command('altimate-remember', 'rule hello')).text).toContain('not retried')
  expect(saves).toBe(1)
})

test('engine loads both mod modules and forwards an ordinary prompt unchanged', async ($, on) => {
  on('session.start', () => ({ cwd: '/project' }))
  on('command.register', () => ({ value: undefined }))
  on('prompt.submit', ($, e) => ({ text: e.text, context: e.context, origin: e.origin }))
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  const answer = await $.prompt.submit({ text: 'hello' })
  expect(answer.text).toBe('hello')
  expect(answer.context).toBeUndefined()
})

test('workspace picker renders on terminal, Desktop and VS Code; selecting uses the guarded link operation', async ($, on) => {
  on('session.start', () => ({ cwd: '/project' }))
  on('session.cwd', () => ({ value: '/project' }))
  on('command.register', () => ({ value: undefined }))
  let links = 0
  on('process.run', ($, e) => {
    if (e.argv.includes('link')) {
      links++
      expect(e.argv.includes('--yes')).toBe(false)
      expect(e.init.env.ALTIMATE_DISABLE_MEMORY).toBe('1')
      return { value: { exitCode: 0, stdout: 'Linked', stderr: '' } }
    }
    return { value: { exitCode: 0, stderr: '', stdout: JSON.stringify(e.argv.includes('list')
      ? { ok: true, workspaces: [{ id: 35, name: 'Synthetic analytics' }] }
      : { ok: true, workspace: { id: 35, name: 'Synthetic analytics', token: 'receipt' } }) } }
  })
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'altimate-workspace', args: '' })
  for (const surface of ['terminal', 'desktop', 'vscode']) {
    const ui = await $.ui.mount({ plugin: 'altimate-code', component: 'Pane', requestId: 'altimate-workspace', surface,
      viewport: { columns: 120, rows: 40 }, props: { title: 'Altimate workspace', isFocused: true, bodyColumns: 80,
        placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} } })
    expect(await ui.find({ type: 'Text', text: 'Current workspace: Synthetic analytics (35)' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'workspace-35' })).toBeDefined()
    await ui.unmount()
  }
  const ui = await $.ui.mount({ plugin: 'altimate-code', component: 'Pane', requestId: 'altimate-workspace', surface: 'terminal',
    viewport: { columns: 120, rows: 40 }, props: { title: 'Altimate workspace', isFocused: true, bodyColumns: 80,
      placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} } })
  await ui.press({ key: 'workspace-35' })
  expect(links).toBe(1)
  expect(await ui.find({ type: 'Text', text: /Reconnect Altimate/ })).toBeDefined()
  await ui.unmount()
})
