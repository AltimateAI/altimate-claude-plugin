const PREFIX = 'mcp__plugin_altimate-code-experimental_altimate-code__'
const CONTEXT = PREFIX + 'workspace_context'
const PANE = 'altimate-workspace'
let enabled = true
let workspace
let saveTarget
let available = []
let message = 'Ask a data question. Workspace setup appears only when needed.'
let state = 'idle'
let epoch = 0
let busy = false
let pendingUser
let memoryId = ''
let memoryText = ''

export function automaticEnabled() { return enabled }
export function workspaceShortcut($, e) {
  if (!enabled || !pendingUser || !['needs_auth', 'needs_workspace', 'needs_engine', 'unavailable'].includes(state)) return
  const { Button } = $.ui.resolve(e)
  return Button({ key: 'altimate-setup', label: 'Continue Altimate setup', onPress: () => open($, true) })
}
export function resetMode() {
  enabled = true; workspace = undefined; saveTarget = undefined; available = []; pendingUser = undefined
  memoryId = ''; memoryText = ''; state = 'idle'; message = 'Ask a data question.'; epoch++
}
function redraw($) { try { $.ui.invalidate('ui.render') } catch {} }
function runtime($) { return $.plugin.root + '/runtime/altimate-code' }
function clean(value, length = 160) { return String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, length) }
function textOf(answer) {
  if (answer.deny || answer.isError || answer.result?.isError) throw new Error('Workspace request failed.')
  if (typeof answer.text === 'string') return answer.text
  if (typeof answer.result === 'string') return answer.result
  return (answer.result?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
}
function jsonOf(result) {
  let value
  try { value = JSON.parse(result.stdout) } catch { throw new Error('The experimental runtime did not return a workspace response. Reinstall the matching experimental package.') }
  if (result.exitCode !== 0 || value.ok !== true) throw new Error('Workspace access could not be confirmed. Check sign-in and connection.')
  return value
}
function apply(value) {
  state = value.status ?? 'ready'
  workspace = value.workspace ? { ...value.workspace, name: clean(value.workspace.name) } : undefined
  if (saveTarget?.token !== workspace?.token) saveTarget = undefined
  available = Array.isArray(value.workspaces) ? value.workspaces.filter(x => Number.isSafeInteger(x.id) && x.id > 0 && typeof x.name === 'string')
    .slice(0, 100).map(x => ({ id: x.id, name: clean(x.name, 120) })) : []
  message = state === 'ready' ? 'Workspace connected. Data tools are ready for your question.'
    : state === 'needs_auth' ? 'Sign in once to continue this workspace question. Local data needs no workspace sign-in.'
    : state === 'needs_workspace' ? 'Choose the workspace for this project. Existing links will not be replaced.'
    : state === 'disabled' ? 'Workspace access is disabled in Altimate settings.'
    : 'Workspace access could not be confirmed. Check your connection or sign in again.'
  if (value.engineStatus === 'needs_engine') { state = 'needs_engine'; message = 'Add workspace engine support to use this workspace’s data and knowledge tools.' }
}
async function inspect($) {
  const generation = epoch
  const directory = await $.session.cwd()
  if (generation !== epoch) return false
  const result = await $.process.run([runtime($), 'workspace-client', 'context', '--directory', directory], { cwd: directory, timeoutMs: 30000 })
  if (generation !== epoch) return false
  const value = jsonOf(result)
  apply(value)
  // The explicit inspector may arm a destination, never an automatic/model-origin read.
  if (workspace) saveTarget = workspace
  if (state === 'needs_workspace') {
    const listed = jsonOf(await $.process.run([runtime($), 'workspace-client', 'list'], { cwd: directory, timeoutMs: 30000 }))
    if (generation !== epoch) return false
    apply({ ...value, workspaces: listed.workspaces })
  }
  redraw($)
  return true
}
async function open($, focus = false) {
  return $.ui.open({ id: PANE, title: 'Altimate workspace', focus, closeOnEscape: true, rows: 18 })
}
async function lastUser($) {
  const users = (await $.session.messages()).filter(x => x.role === 'user' && x.text && !x.toolResults?.length)
  return users.length ? { text: users.at(-1).text, count: users.length } : undefined
}
async function resume($, generation) {
  if (generation !== epoch || !pendingUser) return
  const current = await lastUser($)
  if (generation !== epoch || current?.text !== pendingUser.text || current?.count !== pendingUser.count) { pendingUser = undefined; return }
  pendingUser = undefined
  // This runs from an explicit setup button, outside the model's waiting tool hook.
  void $.prompt.submit({ text: 'Altimate setup completed at my request. Continue the previous user data question. Read workspace_context with refresh=true and include_tools=true when workspace operations are needed. Do not publish memory or perform source writes.' }).catch(() => {
    if (generation === epoch) { message = 'Setup finished. Send your question again to continue.'; redraw($) }
  })
}
async function setupAction($, action, id) {
  if (busy) return
  busy = true
  const generation = epoch
  try {
    const directory = await $.session.cwd()
    if (generation !== epoch) return
    message = action === 'signin' ? 'Finish signing in in your browser…' : action === 'engine' ? 'Installing workspace support…' : 'Connecting this project…'
    redraw($)
    const argv = action === 'signin' ? [runtime($), 'auth', 'login', '-p', 'altimate-backend', '--method', 'Altimate LLM Gateway']
      : action === 'engine' ? [runtime($), 'workspace-client', 'engine-install']
      : [runtime($), 'link', '--workspace', String(id), '--directory', directory]
    const result = await $.process.run(argv, { cwd: directory, timeoutMs: action === 'link' ? 60000 : 300000,
      ...(action === 'link' ? { env: { ALTIMATE_DISABLE_MEMORY: '1', OPENCODE_DISABLE_MEMORY: '1' } } : {}) })
    if (generation !== epoch) return
    if (result.exitCode !== 0) { message = 'Setup was not confirmed. Check the connection and try again when ready.'; return }
    if (await inspect($)) {
      // UI inspection is part of an explicit user action; context tools remain read-only.
      if (state === 'ready') await resume($, generation)
    }
  } catch { if (generation === epoch) message = 'Setup failed or was interrupted. No data task or memory publication was retried.' }
  finally { busy = false; redraw($) }
}

export async function observeWorkspace($, e, answer) {
  if (!enabled || e.tool !== CONTEXT) return
  const generation = epoch
  let value
  try { value = JSON.parse(textOf(answer)) } catch { return }
  if (generation !== epoch) return
  apply(value)
  if (['needs_auth', 'needs_workspace', 'needs_engine', 'unavailable'].includes(state)) {
    const user = await lastUser($)
    if (generation !== epoch) return
    pendingUser = user
    try { await open($, false) } catch { /* The original structured status remains in the tool result. */ }
  }
  redraw($)
}

async function remember($, id, text) {
  if (!saveTarget?.token) return 'Open the workspace inspector to confirm the destination before saving.'
  if (!text.trim() || text.length > 2048) return 'Memory must contain 1–2048 characters.'
  const token = saveTarget.token
  const generation = epoch
  const directory = await $.session.cwd()
  if (generation !== epoch) return 'Conversation changed. Nothing was saved.'
  try {
    const result = jsonOf(await $.process.run([runtime($), 'workspace-client', 'remember', '--directory', directory, '--token=' + token, '--id=' + id], { cwd: directory, stdin: text, timeoutMs: 60000 }))
    return result.message
  } catch { return 'Save failed or was interrupted. Publication may be uncertain; it was not retried.' }
}

export function register(on) {
  on('command.run', { command: 'altimate-mode' }, ($, e) => {
    const action = e.args.trim() || 'status'
    if (!['on', 'off', 'status'].includes(action)) return { text: 'Usage: /altimate-mode on|off|status' }
    if (action !== 'status' && !['composer', 'bridge', 'sdk'].includes(e.origin.kind)) return { text: 'Only you can change automatic Altimate presentation.' }
    if (action !== 'status') { enabled = action === 'on'; epoch++; pendingUser = undefined }
    return { text: `Altimate automatic data experience ${enabled ? 'ON' : 'OFF'}. No activation command is needed. Shared memory is saved only by an explicit user action.` }
  })
  on('command.run', { command: 'altimate-workspace' }, async ($, e) => {
    if (e.origin.kind !== 'composer') return { text: 'Use workspace_context for read-only context. Only the user can inspect a save destination or choose a workspace.' }
    try {
      const match = /^link\s+([1-9]\d*)$/.exec(e.args.trim())
      if (e.args.trim() && !match) return { text: 'Usage: /altimate-workspace [link <id>]' }
      if (match) { await setupAction($, 'link', match[1]); return { text: message } }
      if (!await inspect($)) return { text: 'Conversation changed; workspace inspection cancelled.' }
      await open($, true)
      return { text: message }
    } catch { return { text: 'Workspace inspection failed. Check your connection or reinstall the matching experimental package.' } }
  })
  on('command.run', { command: 'altimate-remember' }, async ($, e) => {
    if (e.origin.kind !== 'composer') return { text: 'Only an explicit user save can publish shared memory. Nothing was saved.' }
    const match = /^(\S+)\s+([\s\S]+)$/.exec(e.args.trim())
    if (!match) return { text: 'Usage: /altimate-remember <id> <text>. You can also use Save a decision in the workspace inspector.' }
    return { text: await remember($, match[1], match[2]) }
  })
  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    return Box({ flexDirection: 'column', children: [
      Text({ children: [workspace ? `Workspace: ${workspace.name} (${workspace.id})` : 'Altimate workspace setup'] }),
      Text({ children: [message] }),
      ...(['needs_auth', 'unavailable'].includes(state) ? [Button({ key: 'signin', label: 'Sign in to Altimate', onPress: () => setupAction($, 'signin') })] : []),
      ...(state === 'needs_engine' ? [Button({ key: 'engine', label: 'Install workspace support (Node 20+ / npm)', onPress: () => setupAction($, 'engine') })] : []),
      ...available.map(item => Button({ key: 'workspace-' + item.id, label: `${item.name} (${item.id})`, onPress: () => setupAction($, 'link', item.id) })),
      ...(saveTarget ? [Text({ children: [`Save one project decision to ${saveTarget.name} (${saveTarget.id}). Publication may use backend models.`] }),
        Input({ key: 'memory-id', value: memoryId, placeholder: 'Memory ID, e.g. metrics/arr', onInput: value => { memoryId = value }, onSubmit: value => { memoryId = value } }),
        Input({ key: 'memory-text', value: memoryText, placeholder: 'Decision to remember (max 2048 characters)', onInput: value => { memoryText = value.slice(0, 2048) }, onSubmit: value => { memoryText = value.slice(0, 2048) } }),
        Button({ key: 'save', label: 'Save this decision to ' + saveTarget.name, onPress: async () => { const generation = epoch; const result = await remember($, memoryId, memoryText); if (generation === epoch) { message = result; redraw($) } } })] : []),
      Button({ key: 'refresh', label: 'Refresh workspace', onPress: async () => { try { await inspect($) } catch { message = 'Workspace could not be confirmed.' }; redraw($) } }),
      Button({ key: 'close', label: 'Not now', onPress: () => { pendingUser = undefined; redraw($); return $.ui.close({ id: PANE }) } }),
    ] })
  })
}
