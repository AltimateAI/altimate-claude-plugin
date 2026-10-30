import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Busy, Expanded, Form, IntegrationsStatus, Provider, ProviderId } from '../types'

const PANE = 'altimate-integrations'
const PANE_TITLE = 'Altimate integrations'
const COMMAND = 'integrations'
// Testing a credential and saving it to the workspace are two network calls.
const CONNECT_TIMEOUT_MS = 60_000

// Bump the shape tag when IntegrationsStatus changes: a stored value of an
// older shape is dropped instead of being drawn with missing fields.
const status = atom({ plugin: 'altimate-code', key: 'status' } as const, null, {
  shape: 'integrations-status-3',
})
const busy = atom({ plugin: 'altimate-code', key: 'busy' } as const, null as Busy | null)
const message = atom({ plugin: 'altimate-code', key: 'message' } as const, null as string | null)
const isBandHidden = atom({ plugin: 'altimate-code', key: 'isBandHidden' } as const, false)
const expanded = atom({ plugin: 'altimate-code', key: 'expanded' } as const, null as Expanded | null)
const form = atom({ plugin: 'altimate-code', key: 'form' } as const, null as Form | null)
const formMessage = atom({ plugin: 'altimate-code', key: 'formMessage' } as const, null as string | null)
const typed = atom({ plugin: 'altimate-code', key: 'typed' } as const, {} as Record<string, string>)

const ICON: Record<Provider['state'], string> = {
  connected: '●',
  expired: '⚠',
  rejected: '⚠',
  detected: '◐',
  available: '◌',
  not_found: '○',
}

const SYNC_LABEL: Record<Provider['sync'], string> = {
  synced: 'synced to workspace',
  local: 'stored locally',
  pending: 'ready to sync',
  blocked: 'local only (sync blocked)',
}

const STATE_COLOR: Record<Provider['state'], string> = {
  connected: 'success',
  expired: 'warning',
  rejected: 'warning',
  detected: 'warning',
  available: 'suggestion',
  not_found: 'inactive',
}

// `altimate` is the name the standalone installer and npm v0.7.1+ put on PATH;
// older npm installs only have `altimate-code`.
const CLI_NAMES = ['altimate', 'altimate-code'] as const

async function runCli($: EngineInterface, args: string[], timeoutMs = 30_000) {
  let lastError: unknown = null
  for (const bin of CLI_NAMES) {
    try {
      return await $.process.run([bin, 'integrations', ...args], { timeoutMs })
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error('altimate CLI not found')
}

// The CLI pretty-prints its JSON, so read the whole text first, then fall back
// to the last line for a CLI that logs before printing one compact line.
function parseJson<T>(text: string): T | null {
  const body = text.trim()
  for (const candidate of [body, body.split('\n').pop() ?? '']) {
    try {
      return JSON.parse(candidate) as T
    } catch {}
  }
  return null
}

function parseStatus(text: string): IntegrationsStatus | null {
  const value = parseJson<IntegrationsStatus>(text)
  return Array.isArray(value?.providers) ? value : null
}

const ANSI = /\u001b\[[0-9;]*m/g

/** Runs a CLI call whose answer is JSON: the parsed answer, or the reason it failed. */
async function runJson<T extends { message?: string | null }>($: EngineInterface, args: string[], timeoutMs?: number) {
  const result = await runCli($, args, timeoutMs)
  const data = parseJson<T>(result.stdout)
  const failure = result.exitCode === 0 ? null : (data?.message ?? firstLine(result.stderr.replace(ANSI, '')) ?? 'failed')
  return { data, failure }
}

async function refresh($: EngineInterface, subcommand: 'status' | 'detect' = 'status') {
  try {
    const result = await runCli($, [subcommand, '--json'])
    const next = parseStatus(result.stdout)
    if (next) {
      await update($, status, () => next)
      showStatusLine($, next)
    }
  } catch {
    await update($, message, () => 'altimate CLI not found: install it to use one-click integrations.')
  }
}

function showStatusLine($: EngineInterface, current: IntegrationsStatus) {
  const linked = current.providers.filter(one => one.state === 'connected')
  const synced = linked.filter(one => one.sync === 'synced').length
  const waiting = current.providers.filter(one => one.state === 'detected' || one.state === 'available').length
  const attention = current.providers.filter(one => one.state === 'expired' || one.state === 'rejected').length
  const parts = [`⚡ Altimate ${linked.length}/${current.providers.length} integrations`]
  if (attention > 0) parts.push(`${attention} needs attention`)
  if (synced > 0) parts.push(`${synced} synced`)
  if (waiting > 0) parts.push(`${waiting} found`)
  $.ui.status(parts.join(' · '))
}

// A press has a short budget, so a press only schedules its work; the work then
// runs on the clock, outside the press.
function later($: EngineInterface, work: () => Promise<void>) {
  $.clock.after(0, () => {
    void work()
  })
}

/** Runs one CLI action, keeping the pane's progress line and the status current. */
async function act($: EngineInterface, target: ProviderId | 'all', label: string, ...commands: string[][]) {
  const verb = commands[0]?.[0]
  if (await read($, busy)) return
  await update($, busy, () => ({ provider: target, label }))
  await update($, message, () => null)
  try {
    let failure: string | null = null
    for (const args of commands) {
      const result = await runCli($, args)
      if (result.exitCode !== 0) {
        failure = firstLine(result.stderr.replace(ANSI, '')) ?? 'failed'
        break
      }
    }
    const text = failure ?? summarize(verb, target)
    await update($, message, () => text)
    $.ui.toast(text)
  } catch (error) {
    await update($, message, () => `Could not run altimate: ${String(error)}`)
  } finally {
    await update($, busy, () => null)
    await refresh($)
  }
}

// ---------------------------------------------------------------- credentials form

type Outcome = { status?: string; sync?: string; account?: string | null; message?: string | null }

/** Reads the provider's fields from the CLI. A secret arrives as "set or not" and a masked tail, never its value. */
async function loadForm($: EngineInterface, open: Expanded) {
  try {
    const { data, failure } = await runJson<Form & { message?: string }>($, ['fields', open.provider, ...(open.variant ? ['--variant', open.variant] : []), '--json'])
    if (data && Array.isArray(data.fields)) await update($, form, () => data)
    else await update($, formMessage, () => failure ?? 'Could not read the credential fields.')
  } catch (error) {
    await update($, formMessage, () => `Could not run altimate: ${String(error)}`)
  }
}

async function openForm($: EngineInterface, provider: ProviderId, mode: Expanded['mode'], note: string | null = null) {
  const open: Expanded = { provider, mode, variant: null }
  await update($, expanded, () => open)
  await update($, form, () => null)
  await update($, typed, () => ({}))
  await update($, formMessage, () => note)
  await update($, message, () => null)
  await loadForm($, open)
}

async function closeForm($: EngineInterface) {
  await update($, expanded, () => null)
  await update($, form, () => null)
  await update($, typed, () => ({}))
  await update($, formMessage, () => null)
}

async function openPane($: EngineInterface) {
  await update($, isBandHidden, () => false)
  await $.ui.open({ id: PANE, title: PANE_TITLE, focus: true, closeOnEscape: true })
}

/** Runs a form step with the pane's progress line, so a second press cannot start another. */
async function withProgress($: EngineInterface, provider: ProviderId, label: string, work: () => Promise<void>) {
  if (await read($, busy)) return
  await update($, busy, () => ({ provider, label }))
  await update($, formMessage, () => null)
  try {
    await work()
  } catch (error) {
    await update($, formMessage, () => `Could not run altimate: ${String(error)}`)
  } finally {
    await update($, busy, () => null)
  }
}

/** Saves one typed non-secret value. */
async function setField($: EngineInterface, open: Expanded, name: string, value: string) {
  const { failure } = await runJson($, ['set', open.provider, name, value, '--json'])
  if (failure) await update($, formMessage, () => failure)
}

/** Saves what was typed but not submitted, so Connect uses what the person sees. */
async function flushTyped($: EngineInterface, open: Expanded) {
  const pending = await read($, typed)
  const shown = await read($, form)
  for (const [name, value] of Object.entries(pending)) {
    const field = shown?.fields.find(one => one.name === name)
    if (field && !field.secret && value.trim() !== (field.value ?? '')) await setField($, open, name, value)
  }
}

function submitField($: EngineInterface, name: string, value: string) {
  later($, async () => {
    const open = await read($, expanded)
    if (!open) return
    await withProgress($, open.provider, 'Saving…', async () => {
      await setField($, open, name, value)
      await update($, typed, current => {
        const { [name]: _saved, ...rest } = current
        return rest
      })
      await loadForm($, open)
    })
  })
}

function pasteSecret($: EngineInterface, name: string) {
  later($, async () => {
    const open = await read($, expanded)
    if (!open) return
    await withProgress($, open.provider, 'Reading the clipboard…', async () => {
      const { failure } = await runJson($, ['set-secret', open.provider, name, '--from-clipboard', '--json'])
      if (failure) await update($, formMessage, () => failure)
      await loadForm($, open)
    })
  })
}

function createToken($: EngineInterface) {
  later($, async () => {
    const open = await read($, expanded)
    if (!open) return
    const { data, failure } = await runJson<{ tokenUrl?: string; message?: string }>($, ['open-token-page', open.provider, ...(open.variant ? ['--variant', open.variant] : []), '--json'])
    if (failure) await update($, formMessage, () => failure)
    else $.ui.toast(`Opened ${data?.tokenUrl ?? 'the token page'} in your browser`)
  })
}

function switchVariant($: EngineInterface, variant: string) {
  later($, async () => {
    const open = await read($, expanded)
    if (!open) return
    const next: Expanded = { ...open, variant }
    await update($, expanded, () => next)
    await update($, formMessage, () => null)
    await loadForm($, next)
  })
}

/** Test and save the form's credentials: connect or update, local or shared with the workspace. */
function submitForm($: EngineInterface, localOnly: boolean) {
  later($, async () => {
    const open = await read($, expanded)
    if (!open) return
    const name = nameOf(open.provider)
    let outcome: Outcome | null = null
    await withProgress($, open.provider, 'Testing connection…', async () => {
      await flushTyped($, open)
      if (await read($, formMessage)) return
      // Keep local always goes through connect: it is how an update switches to local.
      const verb = open.mode === 'update' && !localOnly ? 'update' : 'connect'
      const variant = open.variant ? ['--variant', open.variant] : []
      const run = await runJson<Outcome>($, [verb, open.provider, ...(localOnly ? ['--local-only'] : []), ...variant, '--json'], CONNECT_TIMEOUT_MS)
      outcome = run.data ?? { status: 'failed', message: run.failure }
    })
    const result = outcome as Outcome | null
    if (!result) return
    if (result.status === 'connected') {
      const text = `${name} ${result.sync === 'synced' ? 'synced to your Altimate workspace' : 'connected · kept local'}${result.account ? ` as ${result.account}` : ''}`
      await closeForm($)
      await update($, message, () => text)
      $.ui.toast(text)
      await refresh($)
      return
    }
    await update($, formMessage, () => result.message ?? `${name} could not be connected.`)
    await loadForm($, open)
  })
}

/** Connect (or keep local) every provider the band found, one after the other. */
function connectFound($: EngineInterface, providers: Provider[], localOnly: boolean) {
  later($, async () => {
    if (await read($, busy)) return
    await update($, message, () => null)
    const lines: string[] = []
    let needsInput: ProviderId | null = null
    try {
      for (const one of providers) {
        await update($, busy, () => ({ provider: one.id, label: `Testing ${one.name}…` }))
        const { data, failure } = await runJson<Outcome>($, ['connect', one.id, ...(localOnly ? ['--local-only'] : []), '--json'], CONNECT_TIMEOUT_MS)
        if (data?.status === 'connected') lines.push(`${one.name} ${data.sync === 'synced' ? 'synced to your workspace' : 'kept local'}`)
        else {
          if (data?.status === 'missing_fields') needsInput = needsInput ?? one.id
          lines.push(`${one.name}: ${data?.message ?? failure ?? 'not connected'}`)
        }
      }
    } catch (error) {
      lines.push(`Could not run altimate: ${String(error)}`)
    } finally {
      await update($, busy, () => null)
    }
    const text = lines.join(' · ')
    await update($, message, () => text)
    $.ui.toast(text)
    await refresh($)
    if (needsInput) {
      await openPane($)
      await openForm($, needsInput, 'connect', lines.find(line => line.startsWith(nameOf(needsInput as ProviderId))) ?? null)
    }
  })
}

/** "45m", "3h" or "2d" for the time between now and an ISO time; null when unparsable. */
function span(iso: string, now: number): string | null {
  const ms = Date.parse(iso) - now
  if (Number.isNaN(ms)) return null
  const minutes = Math.max(1, Math.round(Math.abs(ms) / 60_000))
  if (minutes < 60) return `${minutes}m`
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`
  return `${Math.round(minutes / (60 * 24))}d`
}

function expiryText(one: Provider, now: number): string | null {
  if (!one.expiresAt) return null
  const when = span(one.expiresAt, now)
  if (!when) return null
  return one.state === 'expired' ? (Date.parse(one.expiresAt) > now ? 'Expired · update now' : `Expired · ${when} ago`) : `expires in ${when}`
}

function firstLine(text: string): string | null {
  return text.trim().split('\n')[0] || null
}

function summarize(verb: string | undefined, target: ProviderId | 'all'): string {
  const who = target === 'all' ? 'Integrations' : nameOf(target)
  switch (verb) {
    case 'sync':
      return `${who} synced to your Altimate workspace`
    case 'block':
      return `${who} will stay on this machine only`
    case 'unblock':
      return `${who} can sync to your Altimate workspace`
    case 'disconnect':
      return `${who} disconnected`
    default:
      return `${who} updated`
  }
}

function nameOf(id: ProviderId): string {
  return { github: 'GitHub', jira: 'Jira', linear: 'Linear' }[id]
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: COMMAND,
      description: 'One-click GitHub, Jira and Linear integrations for your Altimate workspace',
    })
    void refresh($, 'detect')

    return started
  })

  on('command.run', { command: COMMAND }, async $ => {
    try {
      await openPane($)
      void refresh($, 'detect')

      return { text: 'Altimate integrations opened in the side pane.' }
    } catch (error) {
      return { text: `Could not open Altimate integrations: ${String(error)}` }
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, status)
    if (e.props.hasSurvey || !current || (await read($, isBandHidden))) return next(e)

    const stopped = current.providers.filter(one => one.state === 'rejected' || one.state === 'expired')
    const found = current.providers.filter(one => one.state === 'detected')
    const remote = current.providers.filter(one => one.state === 'available')
    const pending = current.providers.filter(one => one.state === 'connected' && one.sync === 'pending')
    if (stopped.length + found.length + remote.length + pending.length === 0) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const running = await read($, busy)
    const ready = [...found, ...pending]
    const foundText = ready.map(one => `${one.name} (${one.source?.label ?? 'local'})`).join(', ')

    return (
      <Box flexDirection="column">
        <Box>
          <Text color="claude" bold>
            ⚡ Altimate{' '}
          </Text>
          {foundText !== '' && <Text>Found {foundText}. </Text>}
          {remote.length > 0 && (
            <Text dimColor>{remote.map(one => one.name).join(', ')} available via Claude MCP. </Text>
          )}
        </Box>
        {stopped.map(one => (
          <Box key={`stopped-${one.id}`}>
            <Text color="warning">
              ⚠ {one.name} {one.state === 'expired' ? 'access expired' : 'credentials stopped working'} ·{' '}
            </Text>
            {!running && (
              <Button
                key={`stopped-${one.id}-update`}
                label="Update"
                onPress={() =>
                  later($, async () => {
                    await openPane($)
                    await openForm($, one.id, 'update')
                  })
                }
              />
            )}
          </Box>
        ))}
        {running ? (
          <Text dimColor>{running.label}</Text>
        ) : ready.length + remote.length === 0 ? null : (
          <Box>
            {ready.length > 0 && <Button key="connect-all" label="Connect" onPress={() => connectFound($, ready, false)} />}
            {ready.length > 0 && <Button key="keep-local" label="Keep local" onPress={() => connectFound($, ready, true)} />}
            <Button key="details" label="Review" onPress={() => later($, () => openPane($))} />
            <Button key="hide" label="Later" onPress={() => update($, isBandHidden, () => true)} />
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    // The mobile app draws no field yet: there a value is shown, not edited.
    const Input = 'Input' in ui ? ui.Input : null
    const current = await read($, status)
    const running = await read($, busy)
    const note = await read($, message)
    const open = await read($, expanded)
    const fields = await read($, form)
    const inForm = await read($, formMessage)
    const draft = await read($, typed)
    const now = await $.clock.now()

    if (!current) {
      return (
        <Box flexDirection="column">
          <Text dimColor>{note ?? 'Looking for GitHub, Jira and Linear credentials on this machine…'}</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>One-click integrations</Text>
          <Text dimColor>Workspace: {current.workspace.name}</Text>
        </Box>
        {current.providers.map(one => (
          <Box key={one.id} flexDirection="column">
            <Text>
              <Text color={STATE_COLOR[one.state]}>{ICON[one.state]} </Text>
              <Text bold>{one.name}</Text>
              {one.account && <Text dimColor> · {one.account}</Text>}
            </Text>
            <Text dimColor>
              {'  '}
              {one.source ? `via ${one.source.label}` : 'not found on this machine'}
              {one.state === 'connected' ? ` · ${SYNC_LABEL[one.sync]}` : ''}
            </Text>
            {one.state === 'rejected' && <Text color="warning">{'  '}⚠ Token rejected · Update</Text>}
            {expiryText(one, now) && (
              <Text color={one.state === 'expired' ? 'warning' : undefined} dimColor={one.state !== 'expired'}>
                {'  '}
                {expiryText(one, now)}
              </Text>
            )}
            {one.note && one.state !== 'rejected' && <Text dimColor>{'  '}{one.note}</Text>}
            {open?.provider === one.id ? (
              <Box flexDirection="column">
                {fields?.fields.map(field =>
                  field.secret ? (
                    <Box key={`${one.id}-${field.name}`}>
                      <Text>
                        {'  '}
                        {field.label}: {field.hasValue ? `✓ ${field.masked ?? ''}` : 'not set'}{' '}
                      </Text>
                      {!running && fields.tokenUrl && (
                        <Button key={`${one.id}-${field.name}-create`} label="Create token ↗" onPress={() => createToken($)} />
                      )}
                      {!running && (
                        <Button key={`${one.id}-${field.name}-paste`} label="Paste from clipboard" onPress={() => pasteSecret($, field.name)} />
                      )}
                    </Box>
                  ) : Input === null ? (
                    <Text key={`${one.id}-${field.name}`}>
                      {'  '}
                      {field.label}: {field.value ?? 'not set'}
                    </Text>
                  ) : (
                    <Input
                      key={`${one.id}-${field.name}`}
                      label={`${field.label}${field.required ? '' : ' (optional)'}`}
                      value={draft[field.name] ?? field.value ?? ''}
                      submitLabel="save"
                      onInput={(value: string) => {
                        void update($, typed, current => ({ ...current, [field.name]: value }))
                      }}
                      onSubmit={(value: string) => submitField($, field.name, value)}
                    />
                  ),
                )}
                {!fields && !inForm && <Text dimColor>{'  '}Reading the fields…</Text>}
                {fields && fields.variants.length > 1 && !running && (
                  <Box>
                    {fields.variants
                      .filter(variant => variant !== fields.variant)
                      .map(variant => (
                        <Button key={`${one.id}-variant-${variant}`} label={`Use ${variant} instead`} onPress={() => switchVariant($, variant)} />
                      ))}
                  </Box>
                )}
                {inForm && <Text color="warning">{'  '}{inForm}</Text>}
                {running?.provider === one.id ? (
                  <Text color="warning">{'  '}{running.label}</Text>
                ) : (
                  <Box>
                    <Button
                      key={`${one.id}-submit`}
                      label={open.mode === 'update' ? 'Update' : 'Connect & sync'}
                      onPress={() => submitForm($, false)}
                    />
                    <Button key={`${one.id}-keep-local`} label="Keep local" onPress={() => submitForm($, true)} />
                    <Button key={`${one.id}-cancel`} label="Cancel" onPress={() => later($, () => closeForm($))} />
                  </Box>
                )}
              </Box>
            ) : running?.provider === one.id ? (
              <Box flexDirection="column">
                <Text color="warning">{'  '}{running.label}</Text>
              </Box>
            ) : (
              <Box>{actionsFor($, one, Button)}</Box>
            )}
          </Box>
        ))}
        {note && <Text color="suggestion">{note}</Text>}
        <Box>
          <Button key="refresh" label="Rescan" onPress={() => later($, () => act($, 'all', 'Rescanning…', ['detect', '--json']))} />
          <Button key="sync-everything" label="Sync all" onPress={() => later($, () => act($, 'all', 'Syncing…', ['sync', '--all', '--json']))} />
        </Box>
      </Box>
    )
  })
}

// One row of buttons per provider, chosen by its state. Credentials are added
// or updated in the row's form; there is no browser sign-in button.
function actionsFor($: EngineInterface, one: Provider, Button: any) {
  const buttons = []
  const addCredentials = () => (
    <Button key={`${one.id}-add`} label="Add credentials" onPress={() => later($, () => openForm($, one.id, 'connect'))} />
  )
  if (one.state === 'detected') {
    buttons.push(
      <Button key={`${one.id}-use`} label="Connect" onPress={() => connectFound($, [one], false)} />,
      <Button key={`${one.id}-local`} label="Keep local" onPress={() => connectFound($, [one], true)} />,
      addCredentials(),
    )
  }
  if (one.state === 'available' || one.state === 'not_found') buttons.push(addCredentials())
  if (one.state === 'expired' || one.state === 'rejected') {
    buttons.push(<Button key={`${one.id}-update`} label="Update" onPress={() => later($, () => openForm($, one.id, 'update'))} />)
  }
  if (one.state === 'connected' || one.state === 'expired' || one.state === 'rejected') {
    // A local credential that is not blocked only waits for a sync; a blocked one
    // is unblocked and synced in the same click.
    if (one.state === 'connected' && (one.sync === 'pending' || one.sync === 'local')) {
      buttons.push(<Button key={`${one.id}-sync`} label="Sync" onPress={() => later($, () => act($, one.id, 'Syncing…', ['sync', one.id, '--json']))} />)
    }
    if (one.sync === 'blocked') {
      buttons.push(
        <Button
          key={`${one.id}-allow`}
          label="Allow sync"
          onPress={() => later($, () => act($, one.id, 'Syncing…', ['unblock', one.id, '--json'], ['sync', one.id, '--json']))}
        />,
      )
    } else if (one.sync !== 'local') {
      // Already local: Sync is the only move left, so Keep local would do nothing.
      buttons.push(<Button key={`${one.id}-block`} label="Keep local" onPress={() => later($, () => act($, one.id, 'Updating…', ['block', one.id, '--json']))} />)
    }
    buttons.push(<Button key={`${one.id}-off`} label="Disconnect" onPress={() => later($, () => act($, one.id, 'Disconnecting…', ['disconnect', one.id, '--json']))} />)
  }
  return buttons
}
