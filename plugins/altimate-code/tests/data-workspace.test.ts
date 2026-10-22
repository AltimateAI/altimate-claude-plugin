import { expect, test } from 'claude-code/testing'

// Shapes from Anthropic's mods/test examples and mods/types/claude-code.d.ts.
const SQL_TOOL = 'mcp__plugin_altimate-code_altimate-code__sql_execute'
const PANE = {
  plugin: 'altimate-code', component: 'Pane', requestId: 'altimate-data',
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
  expect(names).toEqual(['altimate-data', 'altimate-query'])
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

test('pane is opt-in, closes on demand, and headless mode gives a text fallback', async ($, on) => {
  boot($, on)
  let closed = false
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no surface' } }))
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
