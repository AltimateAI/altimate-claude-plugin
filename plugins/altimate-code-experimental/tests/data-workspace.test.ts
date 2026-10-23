import { expect, test } from 'claude-code/testing'
import { register } from '../hooks/data-workspace.mjs'

// Shapes from Anthropic's mods/test examples and mods/types/claude-code.d.ts.
const SQL_TOOL = 'mcp__plugin_altimate-code-experimental_altimate-code__sql_execute'
const PANE = {
  plugin: 'altimate-code-experimental', component: 'Pane', requestId: 'altimate-data',
  viewport: { columns: 120, rows: 40 },
  props: { title: 'Altimate data', isFocused: true, bodyColumns: 60,
    placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} },
}

function boot($, on) {
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
}

test('session start registers executable commands without querying a database', async ($, on) => {
  const names = []
  on('command.register', ($, e) => { names.push(e.name); return { value: undefined } })
  on('session.start', () => ({ cwd: '/work' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(names.filter(name => ['altimate-data', 'altimate-query'].includes(name))).toEqual(['altimate-data', 'altimate-query'])
})

test('observing a query runs it once and preserves its complete result', async ($, on) => {
  boot($, on)
  let calls = 0
  // Core's text field is the canonical model-visible text; preserve ref/context too.
  const answer = { result: { content: [{ type: 'text', text: 'count: 42' }] },
    text: 'count: 42', ref: 7, context: ['existing context'] }
  on('tool.call', ($, e) => {
    calls++
    expect(e.query).toBe('SELECT COUNT(*) FROM orders')
    return answer
  })
  const actual = await $.tool.call({ tool: SQL_TOOL, warehouse: 'demo', query: 'SELECT COUNT(*) FROM orders' })
  expect(actual).toEqual(answer)
  expect(calls).toBe(1)
  for (const surface of ['terminal', 'desktop', 'vscode']) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'demo · Completed' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'count: 42' })).toBeDefined()
    await ui.unmount()
  }
})

test('workspace engine SQL shares the results pane without an extra execution', async ($, on) => {
  boot($, on)
  let calls = 0
  const answer = { text: 'workspace count: 7', result: 'workspace count: 7' }
  on('tool.call', () => { calls++; return answer })
  expect(await $.tool.call({ tool: 'mcp__plugin_altimate-code-experimental_altimate-code__workspace_snowflake_execute_database_query', sql: 'SELECT COUNT(*) FROM orders' })).toEqual(answer)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '(workspace snowflake) · Completed' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'workspace count: 7' })).toBeDefined()
  expect(calls).toBe(1)
  await ui.unmount()
})

test('a user command goes through tool.call with SQL as data, with no shell or model', async ($, on) => {
  boot($, on)
  const sql = "SELECT '`whoami` $(touch /tmp/no)' AS literal"
  on('tool.list', () => ({ value: [{ name: SQL_TOOL, mcp: true }] }))
  let calls = 0
  on('tool.call', ($, e) => {
    calls++
    expect(e.tool).toBe(SQL_TOOL)
    expect(e.warehouse).toBe('demo')
    expect(e.query).toBe(sql)
    return { result: 'safe literal' }
  })
  const answer = await $.command.run({ command: 'altimate-query', args: 'demo ' + sql })
  expect(answer.text).toBe('safe literal')
  expect(calls).toBe(1)
})

test('missing MCP reports recovery without trying delegation', async ($, on) => {
  boot($, on)
  on('tool.list', () => ({ value: [] }))
  const answer = await $.command.run({ command: 'altimate-query', args: 'demo SELECT 1' })
  expect(answer.text).toContain('No query was run')
})

test('empty or incomplete command never calls a tool', async ($, on) => {
  boot($, on)
  for (const args of ['', 'demo', 'demo   ']) {
    const answer = await $.command.run({ command: 'altimate-query', args })
    expect(answer.text).toContain('Usage:')
  }
})

test('permission denial is preserved and shown without a retry', async ($, on) => {
  boot($, on)
  let calls = 0
  on('tool.call', () => { calls++; return { deny: 'Permission denied by policy' } })
  expect(await $.tool.call({ tool: SQL_TOOL, query: 'DELETE FROM orders' }))
    .toEqual({ deny: 'Permission denied by policy' })
  expect(calls).toBe(1)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '(default connection) · Refused or failed' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Permission denied by policy' })).toBeDefined()
})

test('MCP error content is visible and remains an error for Claude', async ($, on) => {
  boot($, on)
  const answer = { result: { content: [{ type: 'text', text: 'Invalid column: nope' }], isError: true } }
  on('tool.call', () => answer)
  expect(await $.tool.call({ tool: SQL_TOOL, query: 'SELECT nope FROM orders' })).toEqual(answer)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'Invalid column: nope' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '(default connection) · Refused or failed' })).toBeDefined()
})

test('optional pane shortcut closes on demand and has a headless text fallback', async ($, on) => {
  boot($, on)
  let closed = false
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no surface' } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.close', ($, e) => { expect(e.id).toBe('altimate-data'); closed = true; return { value: undefined } })
  const answer = await $.command.run({ command: 'altimate-data', args: '' })
  expect(answer.text).toContain('results remain in the conversation')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'close' })
  expect(closed).toBe(true)
})

test('other tools and panes pass through unchanged', async ($, on) => {
  boot($, on)
  on('tool.call', () => ({ result: 'other result' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['Other pane'] }))
  expect(await $.tool.call({ tool: 'mcp__other__sql_execute', query: 'SELECT 1' })).toEqual({ result: 'other result' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Ask Claude a data question/ })).toBeDefined()
  const other = await $.ui.mount({ ...PANE, requestId: 'another-pane', surface: 'terminal' })
  expect(await other.find({ type: 'Text', text: 'Other pane' })).toBeDefined()
})

test('bounded previews never truncate what Claude receives', async ($, on) => {
  boot($, on)
  const full = 'x'.repeat(20000)
  on('tool.call', () => ({ result: full }))
  for (let i = 0; i < 12; i++) {
    expect(await $.tool.call({ tool: SQL_TOOL, warehouse: 'connection-' + i, query: 'SELECT ' + i }))
      .toEqual({ result: full })
  }
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'connection-3 · Completed' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'connection-4 · Completed' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Pane preview clipped/ })).toBeDefined()
})

test('clear during a running query does not bring its preview back on completion', async ($, on) => {
  boot($, on)
  let finish
  let started
  const ready = new Promise(resolve => { started = resolve })
  on('tool.call', async () => {
    started()
    await new Promise(resolve => { finish = resolve })
    return { result: 'private result' }
  })
  const pending = $.tool.call({ tool: SQL_TOOL, query: 'SELECT 1' })
  await ready
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '(default connection) · Running' })).toBeDefined()
  await ui.press({ key: 'clear' })
  finish()
  await pending
  expect(await ui.find({ type: 'Text', text: 'private result' })).toBeUndefined()
})

test('/clear removes the previous conversation previews', async ($, on) => {
  boot($, on)
  on('tool.call', () => ({ result: 'previous conversation' }))
  on('command.run', () => ({ text: 'Conversation cleared' }))
  await $.tool.call({ tool: SQL_TOOL, query: 'SELECT 1' })
  expect(await $.command.run({ command: 'clear', args: '' })).toEqual({ text: 'Conversation cleared' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'previous conversation' })).toBeUndefined()
})

test('conversation switches discard previews even without another session.start', async ($, on) => {
  boot($, on)
  on('tool.call', () => ({ result: 'previous conversation' }))
  on('session.end', () => ({ sessionId: 'old-session' }))
  await $.tool.call({ tool: SQL_TOOL, query: 'SELECT 1' })
  await $.session.end({ reason: 'resume', sessionId: 'old-session', resume: { id: 'old-session' } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'previous conversation' })).toBeUndefined()
})

test('core top-level tool errors are not labelled Completed', async ($, on) => {
  boot($, on)
  // ToolCallResult core error variant: isError/text at the top level, not in result.
  const answer = { result: 'database disconnected', isError: true, text: 'database disconnected' }
  on('tool.call', () => answer)
  expect(await $.tool.call({ tool: SQL_TOOL, query: 'SELECT 1' })).toEqual(answer)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '(default connection) · Refused or failed' })).toBeDefined()
})

// Supplement engine tests with a rejecting next handler. Throwing from a test-kit
// stub skips that stub; it does not model an implementation rejecting its call.
test('thrown and aborted underlying calls are rethrown unchanged and recorded', async () => {
  for (const aborted of [false, true]) {
    const handlers = new Map()
    register((event, matcher, handler) => handlers.set(event + ':' + (matcher?.command ?? ''), handler ?? matcher))
    const element = props => props
    const api = { ui: { invalidate() {}, resolve() { return { Box: element, Text: element, Button: element, Code: element } } } }
    const error = new Error('connection lost')
    const controller = new AbortController()
    if (aborted) controller.abort()
    let calls = 0
    const next = Object.assign(async () => { calls++; throw error }, { signal: controller.signal })
    let caught
    try { await handlers.get('tool.call:')(api, { tool: SQL_TOOL, query: 'SELECT 1' }, next) } catch (e) { caught = e }
    expect(caught).toBe(error)
    expect(calls).toBe(1)
    const pane = handlers.get('ui.render:')(api, PANE, next)
    expect(JSON.stringify(pane)).toContain(aborted ? 'Interrupted' : 'Failed')
    // Reset to keep the two direct invocations independent.
    await handlers.get('session.end:')(api, { reason: 'resume' }, async () => ({}))
  }
})

test('direct command reports a thrown tool failure without retry or fallback', async () => {
  const handlers = new Map()
  register((event, matcher, handler) => handlers.set(event + ':' + (matcher?.command ?? ''), handler ?? matcher))
  let calls = 0
  const api = { tool: {
    async list() { return [{ name: SQL_TOOL }] },
    async call() { calls++; throw new Error('interrupted') },
  } }
  const answer = await handlers.get('command.run:altimate-query')(api, { args: 'demo SELECT 1' })
  expect(answer.text).toContain('it was not retried')
  expect(calls).toBe(1)
})

test('a query waiting for tool discovery cannot execute after resume or clear', async () => {
  for (const reset of ['session.end:', 'command.run:clear']) {
    const handlers = new Map()
    register((event, matcher, handler) => handlers.set(event + ':' + (matcher?.command ?? ''), handler ?? matcher))
    let finish
    let entered
    let calls = 0
    const ready = new Promise(resolve => { entered = resolve })
    const api = { ui: { invalidate() {} }, tool: {
      async list() { entered(); return await new Promise(resolve => { finish = resolve }) },
      async call() { calls++; return { result: 'old result' } },
    } }
    const pending = handlers.get('command.run:altimate-query')(api, { args: 'demo SELECT 1' })
    await ready
    await handlers.get(reset)(api, { reason: 'resume', command: 'clear' }, async () => ({}))
    finish([{ name: SQL_TOOL }])
    expect((await pending).text).toContain('No query was run')
    expect(calls).toBe(0)
  }
})
