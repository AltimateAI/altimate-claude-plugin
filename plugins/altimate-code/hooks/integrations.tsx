import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Busy, IntegrationsStatus, Provider, ProviderId } from '../types'

const PANE = 'altimate-integrations'
const PANE_TITLE = 'Altimate integrations'
const COMMAND = 'integrations'
const CONNECT_TIMEOUT_MS = 5 * 60 * 1000

// Bump the shape tag when IntegrationsStatus changes: a stored value of an
// older shape is dropped instead of being drawn with missing fields.
const status = atom({ plugin: 'altimate-code', key: 'status' } as const, null, {
  shape: 'integrations-status-2',
})
const busy = atom({ plugin: 'altimate-code', key: 'busy' } as const, null as Busy | null)
const message = atom({ plugin: 'altimate-code', key: 'message' } as const, null as string | null)
const isBandHidden = atom({ plugin: 'altimate-code', key: 'isBandHidden' } as const, false)

const ICON: Record<Provider['state'], string> = {
  connected: '●',
  expired: '⚠',
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

function parseStatus(text: string): IntegrationsStatus | null {
  try {
    const value = JSON.parse(text) as IntegrationsStatus
    return Array.isArray(value?.providers) ? value : null
  } catch {
    return null
  }
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
  const expired = current.providers.filter(one => one.state === 'expired').length
  const parts = [`⚡ Altimate ${linked.length}/${current.providers.length} integrations`]
  if (expired > 0) parts.push(`${expired} expired`)
  if (synced > 0) parts.push(`${synced} synced`)
  if (waiting > 0) parts.push(`${waiting} found`)
  $.ui.status(parts.join(' · '))
}

/** Runs one CLI action, keeping the pane's progress line and the status current. */
async function act($: EngineInterface, target: ProviderId | 'all', label: string, ...commands: string[][]) {
  const verb = commands[0]?.[0]
  if (await read($, busy)) return
  await update($, busy, () => ({ provider: target, label, url: null }))
  await update($, message, () => null)
  try {
    let failure: string | null = null
    for (const args of commands) {
      const result = await runCli($, args)
      if (result.exitCode !== 0) {
        failure = firstLine(result.stderr) ?? 'failed'
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

// A press has a short budget and the browser flow waits on the person, so the
// press only schedules it; the flow then runs on the clock, outside the press.
function startConnect($: EngineInterface, provider: ProviderId, name: string, reauth = false) {
  $.clock.after(0, () => {
    void connect($, provider, name, reauth)
  })
}

/** The browser flow: streams the CLI so the pane can show the consent URL while it waits. */
async function connect($: EngineInterface, provider: ProviderId, name: string, reauth = false) {
  if (await read($, busy)) return
  await update($, busy, () => ({ provider, label: reauth ? `Reconnecting ${name} in your browser…` : `Waiting for ${name} approval in your browser…`, url: null }))
  await update($, message, () => null)
  let outcome: { status?: string; sync?: string; account?: string | null } = {}
  let stdout = ''
  try {
    const child = $.process.spawn({ argv: [CLI_NAMES[0], 'integrations', 'connect', provider, ...(reauth ? ['--reauth'] : []), '--json'] })
    const deadline = (await $.clock.now()) + CONNECT_TIMEOUT_MS
    for await (const piece of child) {
      if (piece.stream === 'stdout') stdout += piece.text
      if (piece.stream === 'stderr') {
        for (const line of piece.text.split('\n')) {
          const url = browserUrl(line)
          if (url) await update($, busy, value => (value ? { ...value, url } : value))
        }
      }
      if ((await $.clock.now()) > deadline) break
    }
    outcome = parseOutcome(stdout)
  } catch {
    outcome = { status: 'failed' }
  } finally {
    await update($, busy, () => null)
  }
  const text =
    outcome.status === 'connected'
      ? `${name} connected${outcome.account ? ` as ${outcome.account}` : ''}: ${
          outcome.sync === 'synced' ? 'synced to your Altimate workspace' : 'stored locally only'
        }`
      : outcome.status === 'cancelled'
        ? `${name}: you cancelled in the browser, nothing stored`
        : `${name}: browser approval did not finish`
  await update($, message, () => text)
  $.ui.toast(text)
  await refresh($)
}

// The CLI pretty-prints its JSON result, so read the whole stream, then fall
// back to the last line for a CLI that logs before printing one compact line.
function parseOutcome(stdout: string): { status?: string; sync?: string; account?: string | null } {
  const text = stdout.trim()
  for (const candidate of [text, text.split('\n').pop() ?? '']) {
    try {
      return JSON.parse(candidate)
    } catch {}
  }
  return { status: 'failed' }
}

function browserUrl(line: string): string | null {
  try {
    const event = JSON.parse(line) as { event?: string; url?: string }
    return event.event === 'browser' && typeof event.url === 'string' ? event.url : null
  } catch {
    return null
  }
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
  return one.state === 'expired' ? (Date.parse(one.expiresAt) > now ? 'Expired · reconnect now' : `Expired · ${when} ago`) : `expires in ${when}`
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
      await update($, isBandHidden, () => false)
      await $.ui.open({ id: PANE, title: PANE_TITLE, focus: true, closeOnEscape: true })
      void refresh($, 'detect')

      return { text: 'Altimate integrations opened in the side pane.' }
    } catch (error) {
      return { text: `Could not open Altimate integrations: ${String(error)}` }
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, status)
    if (e.props.hasSurvey || !current || (await read($, isBandHidden))) return next(e)

    const expired = current.providers.filter(one => one.state === 'expired')
    const found = current.providers.filter(one => one.state === 'detected')
    const remote = current.providers.filter(one => one.state === 'available')
    const pending = current.providers.filter(one => one.state === 'connected' && one.sync === 'pending')
    if (expired.length + found.length + remote.length + pending.length === 0) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const running = await read($, busy)
    const foundText = [...found, ...pending]
      .map(one => `${one.name} (${one.source?.label ?? 'local'})`)
      .join(', ')

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
        {expired.map(one => (
          <Box key={`expired-${one.id}`}>
            <Text color="warning">⚠ {one.name} access expired. </Text>
            {!running && (
              <Button key={`expired-${one.id}-reconnect`} label="Reconnect" onPress={() => startConnect($, one.id, one.name, true)} />
            )}
          </Box>
        ))}
        {running ? (
          <Text dimColor>{running.label}</Text>
        ) : found.length + remote.length + pending.length === 0 ? null : (
          <Box>
            {found.length + pending.length > 0 && (
              <Button key="sync-all" label="Sync to Altimate" onPress={() => act($, 'all', 'Syncing…', ['sync', '--all', '--json'])} />
            )}
            {found.length + pending.length > 0 && (
              <Button key="keep-local" label="Keep local" onPress={() => act($, 'all', 'Saving locally…', ['block', '--all', '--json'], ['sync', '--all', '--json'])} />
            )}
            <Button
              key="details"
              label="Open integrations"
              onPress={() => $.ui.open({ id: PANE, title: PANE_TITLE, focus: true, closeOnEscape: true })}
            />
            <Button key="hide" label="Later" onPress={() => update($, isBandHidden, () => true)} />
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const current = await read($, status)
    const running = await read($, busy)
    const note = await read($, message)
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
            {expiryText(one, now) && (
              <Text color={one.state === 'expired' ? 'warning' : undefined} dimColor={one.state !== 'expired'}>
                {'  '}
                {expiryText(one, now)}
              </Text>
            )}
            {one.note && <Text dimColor>{'  '}{one.note}</Text>}
            {running?.provider === one.id ? (
              <Box flexDirection="column">
                <Text color="warning">{'  '}{running.label}</Text>
                {running.url && <Text dimColor>{'  '}{running.url}</Text>}
              </Box>
            ) : (
              <Box>{actionsFor($, one, Button)}</Box>
            )}
          </Box>
        ))}
        {note && <Text color="suggestion">{note}</Text>}
        <Box>
          <Button key="refresh" label="Rescan" onPress={() => act($, 'all', 'Rescanning…', ['detect', '--json'])} />
          <Button key="sync-everything" label="Sync all" onPress={() => act($, 'all', 'Syncing…', ['sync', '--all', '--json'])} />
        </Box>
      </Box>
    )
  })
}

// One row of buttons per provider, chosen by its state; the browser flow is
// always offered because it is how a remote-MCP-only or missing provider connects.
function actionsFor($: EngineInterface, one: Provider, Button: any) {
  const buttons = []
  if (one.state === 'detected') {
    buttons.push(
      <Button key={`${one.id}-use`} label="Use & sync" onPress={() => act($, one.id, 'Syncing…', ['sync', one.id, '--json'])} />,
      <Button key={`${one.id}-local`} label="Keep local" onPress={() => act($, one.id, 'Saving locally…', ['block', one.id, '--json'], ['sync', one.id, '--json'])} />,
    )
  }
  if (one.state === 'available' || one.state === 'not_found') {
    buttons.push(<Button key={`${one.id}-connect`} label="Connect in browser" onPress={() => startConnect($, one.id, one.name)} />)
  }
  if (one.state === 'expired') {
    buttons.push(<Button key={`${one.id}-reconnect`} label="Reconnect" onPress={() => startConnect($, one.id, one.name, true)} />)
  }
  if (one.state === 'connected' || one.state === 'expired') {
    // A local credential that is not blocked only waits for a sync; a blocked one
    // is unblocked and synced in the same click.
    if (one.sync === 'pending' || one.sync === 'local') {
      buttons.push(<Button key={`${one.id}-sync`} label="Sync" onPress={() => act($, one.id, 'Syncing…', ['sync', one.id, '--json'])} />)
    }
    if (one.sync === 'blocked') {
      buttons.push(
        <Button
          key={`${one.id}-allow`}
          label="Allow sync"
          onPress={() => act($, one.id, 'Syncing…', ['unblock', one.id, '--json'], ['sync', one.id, '--json'])}
        />,
      )
    } else {
      buttons.push(<Button key={`${one.id}-block`} label="Keep local" onPress={() => act($, one.id, 'Updating…', ['block', one.id, '--json'])} />)
    }
    buttons.push(<Button key={`${one.id}-off`} label="Disconnect" onPress={() => act($, one.id, 'Disconnecting…', ['disconnect', one.id, '--json'])} />)
  }
  return buttons
}
