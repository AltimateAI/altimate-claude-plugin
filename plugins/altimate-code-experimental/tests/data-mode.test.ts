import { expect, test } from 'claude-code/testing'
import { register } from '../hooks/data-workspace.mjs'
const PREFIX = 'mcp__plugin_altimate-code-experimental_altimate-code__'
const CONTEXT = PREFIX + 'workspace_context'
const USER = { kind: 'composer' }
function fixture() {
  const handlers = []
  register((event, matcher, handler) => handlers.push({ event, matcher: typeof matcher === 'function' ? {} : matcher, fn: handler ?? matcher }))
  const processes = [], opened = [], prompts = [], calls = []
  const users = ['What is our revenue convention?']
  let value = { status: 'needs_workspace', workspaces: [{ id: 35, name: 'Growth' }], message: 'Choose workspace' }
  const ready = { ok: true, status: 'ready', workspace: { id: 35, name: 'Growth', token: 'receipt' } }
  let process = async argv => ({ exitCode: 0, stderr: '', stdout: JSON.stringify(argv.includes('list') ? { ok: true, workspaces: [{ id: 35, name: 'Growth' }] } : ready) })
  const element = type => props => ({ type, ...props })
  const $ = {
    plugin: { root: '/plugin' }, command: { register: async () => {} },
    session: { cwd: async () => '/project', messages: async () => users.map(text => ({ role: 'user', text })) },
    prompt: { submit: async input => { prompts.push(input); return {} } },
    process: { run: async (argv, options) => { processes.push({ argv, options }); return process(argv, options) } },
    tool: { list: async () => [{ name: CONTEXT }], call: async input => { calls.push(input); return { text: JSON.stringify(value) } } },
    ui: { invalidate() {}, open: async options => { opened.push(options); return { isPlaced: true } }, close: async () => {},
      resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Code'].map(type => [type, element(type)])) },
  }
  const run = (event, input = {}, next = async e => e) => {
    const h = handlers.find(x => x.event === event && Object.entries(x.matcher).every(([k, v]) => input[k] === v))
    return h ? h.fn($, input, next) : next(input)
  }
  const command = (command, args = '', origin = USER) => run('command.run', { command, args, origin })
  const context = () => run('tool.call', { tool: CONTEXT }, async () => ({ text: JSON.stringify(value) }))
  const button = key => {
    const tree = run('ui.render', { component: 'Pane', requestId: 'altimate-workspace' })
    const stack = [tree]
    while (stack.length) { const x = stack.pop(); if (x?.key === key) return x; if (x?.children) stack.push(...x.children) }
    throw new Error('No button ' + key)
  }
  return { $, handlers, run, command, context, button, opened, processes, prompts, calls,
    start: () => run('session.start', {}), process: fn => { process = fn }, value: x => { value = x }, user: x => { users[users.length - 1] = x }, addUser: x => users.push(x), ready }
}

test('installation enables automatic presentation; ordinary prompts are untouched and cause no setup or context reads', async () => {
  const f = fixture(); await f.start()
  expect((await f.command('altimate-mode')).text).toContain('ON')
  expect(f.handlers.some(h => h.event === 'prompt.submit')).toBe(false)
  const input = { text: 'Fix this CSS', attachments: [{ type: 'image' }], origin: USER }
  expect(await f.run('prompt.submit', input)).toBe(input)
  expect(f.opened.length).toBe(0); expect(f.processes.length).toBe(0); expect(f.calls.length).toBe(0)
  await f.command('altimate-mode', 'off'); await f.command('clear')
  expect((await f.command('altimate-mode')).text).toContain('ON')
})

test('workspace tool status automatically opens setup; explicit selection links without backfill and resumes the same pending question', async () => {
  const f = fixture(); await f.start()
  const answer = await f.context()
  expect(answer.text).toContain('needs_workspace')
  expect(f.opened[0].focus).toBe(false)
  expect(f.processes.length).toBe(0)
  await f.button('workspace-35').onPress()
  const link = f.processes.find(x => x.argv.includes('link'))
  expect(link.argv).toEqual(['/plugin/runtime/altimate-code', 'link', '--workspace', '35', '--directory', '/project'])
  expect(link.options.env).toEqual({ ALTIMATE_DISABLE_MEMORY: '1', OPENCODE_DISABLE_MEMORY: '1' })
  expect(link.argv.includes('--yes')).toBe(false)
  expect(f.prompts.length).toBe(1)
  expect(f.prompts[0].text).toContain('Continue the previous user data question')
})

test('narrow-terminal band exposes click actions without commands, yields to surveys and preserves another band', async () => {
  const f = fixture(); await f.start()
  const e = { component: 'AbovePrompt', props: { hasSurvey: false, bodyColumns: 120 } }
  expect(await f.run('ui.render', e, async () => undefined)).toBeUndefined()
  await f.context()
  const previous = { type: 'Text', children: ['Other plugin'] }
  const setup = await f.run('ui.render', e, async () => previous)
  expect(setup.children[0]).toBe(previous)
  expect(setup.children[1].label).toBe('Continue Altimate setup')
  await setup.children[1].onPress()
  expect(f.opened.at(-1).focus).toBe(true)
  expect(f.processes.length).toBe(0)
  expect(await f.run('ui.render', { ...e, props: { hasSurvey: true } }, async () => previous)).toBe(previous)
  await f.button('close').onPress()
  expect(await f.run('ui.render', e, async () => undefined)).toBeUndefined()
  await f.run('tool.call', { tool: PREFIX + 'sql_execute', warehouse: 'demo', query: 'SELECT 1' }, async () => ({ text: '1' }))
  const result = await f.run('ui.render', e, async () => undefined)
  expect(result.children[0].label).toBe('View SQL results (1)')
  await result.children[0].onPress()
  expect(f.opened.at(-1).focus).toBe(true)
  await f.run('ui.close', { id: 'altimate-data' })
  expect(await f.run('ui.render', e, async () => undefined)).toBeUndefined()
})

test('sign-in uses the specified native browser flow; no credential output enters the model', async () => {
  const f = fixture(); await f.start(); f.value({ status: 'needs_auth' }); await f.context()
  f.process(async argv => ({ exitCode: 0, stderr: 'private diagnostics', stdout: argv.includes('login') ? 'private auth callback URL' : JSON.stringify(f.ready) }))
  await f.button('signin').onPress()
  expect(f.processes[0].argv).toEqual(['/plugin/runtime/altimate-code', 'auth', 'login', '-p', 'altimate-backend', '--method', 'Altimate LLM Gateway'])
  expect(JSON.stringify(f.prompts)).not.toContain('private')
  expect(f.prompts.length).toBe(1)
})

test('missing engine offers one explicit native install action and then resumes', async () => {
  const f = fixture(); await f.start(); f.value({ ...f.ready, engineStatus: 'needs_engine' }); await f.context()
  await f.button('engine').onPress()
  expect(f.processes[0].argv).toEqual(['/plugin/runtime/altimate-code', 'workspace-client', 'engine-install'])
  expect(f.prompts.length).toBe(1)
})

test('clearing or changing the last user question during setup never resumes obsolete work', async () => {
  for (const reset of ['clear', 'new-question', 'same-question-new-turn']) {
    const f = fixture(); await f.start(); await f.context()
    let finish; let entered
    const started = new Promise(resolve => { entered = resolve })
    f.process(async argv => {
      if (argv.includes('link')) { entered(); return new Promise(resolve => { finish = resolve }) }
      return { exitCode: 0, stderr: '', stdout: JSON.stringify(f.ready) }
    })
    const pending = f.button('workspace-35').onPress(); await started
    if (reset === 'clear') await f.command('clear')
    else if (reset === 'same-question-new-turn') f.addUser('What is our revenue convention?')
    else f.user('Explain a CSS selector')
    finish({ exitCode: 0, stderr: '', stdout: 'linked' }); await pending
    expect(f.prompts.length).toBe(0)
  }
})

test('context completed after clear cannot reopen setup or bind the new question', async () => {
  const f = fixture(); await f.start()
  let finish, entered
  const started = new Promise(resolve => { entered = resolve })
  const answer = { text: JSON.stringify({ status: 'needs_workspace', workspaces: [{ id: 35, name: 'Growth' }] }) }
  const pending = f.run('tool.call', { tool: CONTEXT }, async () => { entered(); return new Promise(resolve => { finish = resolve }) })
  await started; await f.command('clear'); f.user('Explain a CSS selector')
  finish(answer)
  expect(await pending).toBe(answer)
  expect(f.opened.length).toBe(0)
  expect(f.processes.length).toBe(0)
  expect(f.prompts.length).toBe(0)
})

test('tool discovery delayed across clear cannot register an old SQL preview', async () => {
  const f = fixture(); await f.start()
  let finish, entered
  const started = new Promise(resolve => { entered = resolve })
  f.$.tool.list = async () => { entered(); return new Promise(resolve => { finish = resolve }) }
  let calls = 0
  const answer = { text: 'private old result' }
  const pending = f.run('tool.call', { tool: PREFIX + 'sql_execute', query: 'SELECT 1' }, async () => { calls++; return answer })
  await started; await f.command('clear'); finish([{ name: CONTEXT }])
  expect(await pending).toBe(answer)
  expect(calls).toBe(1)
  expect(f.opened.length).toBe(0)
  expect(await f.run('ui.render', { component: 'AbovePrompt', props: {} }, async () => undefined)).toBeUndefined()
})

test('cancelled setup and failed setup do not automatically retry or resume', async () => {
  const f = fixture(); await f.start(); await f.context()
  await f.button('close').onPress()
  f.process(async () => ({ exitCode: 1, stderr: 'private', stdout: '' }))
  await f.button('workspace-35').onPress()
  expect(f.processes.length).toBe(1); expect(f.prompts.length).toBe(0)
})

test('model/plugin context cannot arm a memory save; user inspection and explicit save use receipt and stdin', async () => {
  const f = fixture(); await f.start(); f.value(f.ready); await f.context()
  expect((await f.command('altimate-remember', 'metrics/arr Use booked ARR.')).text).toContain('confirm the destination')
  expect((await f.command('altimate-workspace', '', { kind: 'plugin' })).text).toContain('Only the user')
  expect(f.processes.length).toBe(0)
  await f.command('altimate-workspace')
  f.process(async () => ({ exitCode: 0, stderr: '', stdout: JSON.stringify({ ok: true, message: 'Saved locally.' }) }))
  expect((await f.command('altimate-remember', 'metrics/arr Use booked ARR.')).text).toBe('Saved locally.')
  const save = f.processes[f.processes.length - 1]
  expect(save.argv.includes('--token=receipt')).toBe(true)
  expect(save.options.stdin).toBe('Use booked ARR.')
  expect((await f.command('altimate-remember', 'metrics/arr Not allowed', { kind: 'plugin' })).text).toContain('Nothing was saved')
})

test('pending directory lookup cannot start a workspace write after clear', async () => {
  const f = fixture(); await f.start(); await f.context()
  let finish
  f.$.session.cwd = () => new Promise(resolve => { finish = resolve })
  const pending = f.button('workspace-35').onPress(); await Promise.resolve()
  await f.command('clear'); finish('/project'); await pending
  expect(f.processes.length).toBe(0); expect(f.prompts.length).toBe(0)
})

test('both Altimate listings enabled gives explicit migration guidance without an ambiguous operation', async () => {
  const f = fixture(); await f.start()
  f.$.tool.list = async () => [{ name: CONTEXT }, { name: 'mcp__plugin_altimate-code_altimate-code__sql_execute' }]
  let calls = 0
  const answer = await f.run('tool.call', { tool: CONTEXT }, async () => { calls++; return {} })
  expect(answer.deny).toContain('disable altimate-code')
  expect(calls).toBe(0)
})

test('setup pane actions render on terminal, Desktop and VS Code', async ($, on) => {
  on('session.start', () => ({ cwd: '/project' }))
  on('command.register', () => ({ value: undefined }))
  on('session.messages', () => ({ value: [{ role: 'user', text: 'What is our revenue policy?' }] }))
  on('tool.call', () => ({ result: { content: [{ type: 'text', text: JSON.stringify({ status: 'needs_auth' }) }] }, text: JSON.stringify({ status: 'needs_auth' }) }))
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: CONTEXT })
  for (const surface of ['terminal', 'desktop', 'vscode']) {
    const ui = await $.ui.mount({ plugin: 'altimate-code-experimental', component: 'Pane', requestId: 'altimate-workspace', surface,
      viewport: { columns: 120, rows: 40 }, props: { title: 'Altimate workspace', isFocused: true, bodyColumns: 80, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} } })
    expect(await ui.find({ type: 'Button', key: 'signin' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'close' })).toBeDefined()
    await ui.unmount()
  }
})


test('SQL opens results automatically without focus; gateway SQL is observed once and UI failures preserve results', async () => {
  const f = fixture(); await f.start()
  let calls = 0
  const result = { text: 'count: 42', result: 'count: 42' }
  const input = { tool: PREFIX + 'workspace_execute', workspace_token: 'receipt', operation: 'snowflake_execute_database_query', arguments: { connection_id: 'demo', sql_query: 'SELECT COUNT(*) FROM orders' } }
  expect(await f.run('tool.call', input, async () => { calls++; return result })).toBe(result)
  expect(calls).toBe(1); expect(f.opened[0].focus).toBe(false)
  const tree = f.run('ui.render', { component: 'Pane', requestId: 'altimate-data' })
  expect(JSON.stringify(tree)).toContain('SELECT COUNT(*) FROM orders')
  expect(JSON.stringify(tree)).toContain('count: 42')
  await f.run('ui.close', { id: 'altimate-data' })
  await f.run('tool.call', input, async () => result)
  expect(f.opened.length).toBe(1)
  await f.command('clear')
  f.$.ui.open = async () => { throw new Error('no UI') }
  expect(await f.run('tool.call', input, async () => result)).toBe(result)
})
