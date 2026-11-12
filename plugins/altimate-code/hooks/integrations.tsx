import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Busy, Expanded, Form, IntegrationsStatus, Provider, ProviderId, WorkspaceChoice } from '../types'
import { MISSING_BINARY, later, parseJson, runAltimate } from './altimate-cli'
import { lineageBand, registerLineage, startLineage } from './lineage'
import { startReviewNotices } from './review-notices'

const PANE = 'altimate-integrations'
const PANE_TITLE = 'Altimate integrations'
const COMMAND = 'integrations'
// The CLI waits up to 30 s for its state lock and each of its network calls is
// cut off after 20 s (15 s for a provider check), so every timeout here is well
// above the calls a command can make before and while holding the lock.
// Local state and a status read: 30 s lock wait + a workspace read + a catalog fetch.
const DEFAULT_TIMEOUT_MS = 90_000
// Sync and disconnect of one provider: a workspace lookup + 30 s lock wait + a provider
// check + up to 8 workspace calls.
// Connect and update add a catalog fetch and a second lock wait before the lock, and
// two binding lookups inside it, so they sit at the top of this budget; a run that
// outlasts it is reported as failed and is never started again.
// Sync all makes one such call per provider, in turn, so no single call can outlast this budget.
const WORKSPACE_TIMEOUT_MS = 300_000
// The browser sign-in waits for the person to finish in the browser.
const SIGN_IN_TIMEOUT_MS = 300_000

// Bump the shape tag when IntegrationsStatus changes: a stored value of an
// older shape is dropped instead of being drawn with missing fields.
const status = atom({ plugin: 'altimate-code', key: 'status' } as const, null, {
  shape: 'integrations-status-4',
})
const busy = atom({ plugin: 'altimate-code', key: 'busy' } as const, null as Busy | null)
const message = atom({ plugin: 'altimate-code', key: 'message' } as const, null as string | null)
const isBandHidden = atom({ plugin: 'altimate-code', key: 'isBandHidden' } as const, false)
const expanded = atom({ plugin: 'altimate-code', key: 'expanded' } as const, null as Expanded | null)
const form = atom({ plugin: 'altimate-code', key: 'form' } as const, null as Form | null)
const formMessage = atom({ plugin: 'altimate-code', key: 'formMessage' } as const, null as string | null)
// The workspaces the user can link this folder to; null while the picker is closed.
const workspaces = atom({ plugin: 'altimate-code', key: 'workspaces' } as const, null as WorkspaceChoice[] | null)
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

async function runCli($: EngineInterface, args: string[], timeoutMs = DEFAULT_TIMEOUT_MS) {
  return runAltimate($, ['integrations', ...args], timeoutMs)
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

/**
 * Why a failed CLI call failed: a `sync` report's own lines, else the `message` or `error` of the JSON the
 * CLI prints to stdout, else the first line of stderr.
 */
function failureText(result: { stdout: string; stderr: string }, command?: string): string {
  const data = parseJson<{ message?: string; error?: string }>(result.stdout)
  return (command === 'sync' ? syncText(result.stdout) : null) ?? data?.message ?? data?.error ?? firstLine(result.stderr.replace(ANSI, '')) ?? 'failed'
}

// A status read that finishes after a newer one started is dropped, so an older answer never overwrites a newer one.
let latestRefresh = 0

async function refresh($: EngineInterface, subcommand: 'status' | 'detect' = 'status') {
  const mine = ++latestRefresh
  try {
    const result = await runCli($, [subcommand, '--json'])
    if (mine !== latestRefresh) return
    const next = parseStatus(result.stdout)
    if (next) {
      await update($, status, () => next)
      showStatusLine($, next)
    } else {
      const failure = parseJson<{ message?: string }>(result.stdout)?.message ?? firstLine(result.stderr.replace(ANSI, ''))
      await update($, message, () => failure ?? 'altimate returned no integrations status.')
    }
  } catch (error) {
    if (mine !== latestRefresh) return
    await update($, message, () =>
      MISSING_BINARY.test(String(error)) ? 'altimate CLI not found: install it to use one-click integrations.' : `Could not run altimate: ${String(error)}`,
    )
  }
}

function showStatusLine($: EngineInterface, current: IntegrationsStatus) {
  const linked = current.providers.filter(one => one.state === 'connected')
  const synced = linked.filter(one => one.sync === 'synced').length
  const waiting = current.providers.filter(one => one.state === 'detected' || one.found || one.state === 'available').length
  const attention = current.providers.filter(one => one.state === 'expired' || one.state === 'rejected').length
  const parts = [`⚡ Altimate ${linked.length}/${current.providers.length} integrations`]
  if (attention > 0) parts.push(`${attention} needs attention`)
  if (synced > 0) parts.push(`${synced} synced`)
  if (waiting > 0) parts.push(`${waiting} found`)
  $.ui.status(parts.join(' · '))
}

/** The timeout that fits what the command runs: one provider's sync or disconnect. */
function timeoutFor(args: string[]) {
  return args[0] === 'sync' || args[0] === 'disconnect' ? WORKSPACE_TIMEOUT_MS : undefined
}

const SYNC_PROVIDERS: ProviderId[] = ['github', 'jira', 'linear']

/**
 * Syncs every provider with its own call, one after the other, attaching what the workspace already
 * holds and never overwriting it. One provider failing or timing out does not stop the others.
 */
async function syncEveryProvider($: EngineInterface): Promise<string | null> {
  const lines: string[] = []
  for (const id of SYNC_PROVIDERS) {
    try {
      const result = await runCli($, ['sync', id, '--keep-synced', '--json'], WORKSPACE_TIMEOUT_MS)
      const line = syncText(result.stdout) ?? (result.exitCode === 0 ? null : `${nameOf(id)}: ${failureText(result)}`)
      if (line) lines.push(line)
    } catch (error) {
      lines.push(`${nameOf(id)}: Could not run altimate: ${String(error)}`)
    }
  }
  return lines.length > 0 ? lines.join(' · ') : null
}

/** Sync all: every provider in turn, with the pane's progress line and the status kept current. */
async function syncAll($: EngineInterface) {
  if (await read($, busy)) return
  await update($, busy, () => ({ provider: 'all', label: 'Syncing…' }))
  await update($, message, () => null)
  try {
    const text = (await syncEveryProvider($)) ?? summarize('sync', 'all')
    await update($, message, () => text)
    $.ui.toast(text)
  } finally {
    await update($, busy, () => null)
    await refresh($)
  }
}

/** Runs one CLI action, keeping the pane's progress line and the status current. */
async function act($: EngineInterface, target: ProviderId | 'all', label: string, ...commands: string[][]) {
  const verb = commands[0]?.[0]
  if (await read($, busy)) return
  await update($, busy, () => ({ provider: target, label }))
  await update($, message, () => null)
  try {
    let failure: string | null = null
    let detail: string | null = null
    for (const args of commands) {
      const result = await runCli($, args, timeoutFor(args))
      if (result.exitCode !== 0) {
        failure = failureText(result, args[0])
        break
      }
      if (args[0] === 'sync') detail = syncText(result.stdout)
      if (args[0] === 'disconnect') detail = disconnectText(result.stdout, target)
    }
    const text = failure ?? detail ?? summarize(verb, target)
    await update($, message, () => text)
    $.ui.toast(text)
  } catch (error) {
    await update($, message, () => `Could not run altimate: ${String(error)}`)
  } finally {
    await update($, busy, () => null)
    await refresh($)
  }
}

/** Opens the browser sign-in; sync stays off until it completes, so only this click opens the browser. */
async function signIn($: EngineInterface) {
  if (await read($, busy)) return
  await update($, busy, () => ({ provider: 'all', label: 'Waiting for the browser sign-in…' }))
  await update($, message, () => null)
  try {
    const result = await runAltimate(
      $,
      ['auth', 'login', '-p', 'altimate-backend', '--method', 'Altimate LLM Gateway'],
      SIGN_IN_TIMEOUT_MS,
    )
    const text = result.exitCode === 0 ? 'Signed in to Altimate' : (firstLine(result.stderr.replace(ANSI, '')) ?? 'Sign-in did not finish.')
    await update($, message, () => text)
    $.ui.toast(text)
  } catch (error) {
    await update($, message, () => `Could not run altimate: ${String(error)}`)
  } finally {
    await update($, busy, () => null)
    await refresh($)
  }
}

// ---------------------------------------------------------------- link workspace

async function listWorkspaces($: EngineInterface) {
  if (await read($, busy)) return
  await update($, busy, () => ({ provider: 'all', label: 'Loading workspaces…' }))
  await update($, message, () => null)
  try {
    const result = await runAltimate($, ['workspace', 'list', '--json'])
    const data = parseJson<{ ok?: boolean; workspaces?: WorkspaceChoice[] }>(result.stdout)
    if (result.exitCode !== 0 || !Array.isArray(data?.workspaces)) {
      await update($, message, () => failureText(result) === 'failed' ? 'Could not list workspaces.' : failureText(result))
    } else if (data.workspaces.length === 0) {
      await update($, message, () => 'No workspaces found for this account.')
    } else {
      await update($, workspaces, () => data.workspaces ?? null)
    }
  } catch (error) {
    await update($, message, () => `Could not run altimate: ${String(error)}`)
  } finally {
    await update($, busy, () => null)
  }
}

/** Links this folder to the workspace, then syncs so connections already saved attach to it. */
async function linkWorkspace($: EngineInterface, choice: WorkspaceChoice) {
  if (await read($, busy)) return
  await update($, busy, () => ({ provider: 'all', label: `Linking ${choice.name}…` }))
  await update($, message, () => null)
  try {
    const link = await runAltimate($, ['link', '--workspace', String(choice.id), '-y'], WORKSPACE_TIMEOUT_MS)
    if (link.exitCode !== 0) {
      await update($, message, () => (failureText(link) === 'failed' ? 'Could not link the workspace.' : failureText(link)))
      return
    }
    await update($, workspaces, () => null)
    await update($, busy, () => ({ provider: 'all', label: 'Syncing…' }))
    const detail = await syncEveryProvider($)
    const text = `Linked to ${choice.name}${detail ? ` · ${detail}` : ''}`
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

/** Forgets what was typed or pasted for a provider, so an abandoned form cannot leak into the next connect. */
async function discardEntries($: EngineInterface, provider: ProviderId) {
  try {
    await runJson($, ['discard', provider, '--json'])
  } catch {}
}

/** Discards what was entered for a provider ahead of an action that ignores the form; an open form for it is closed with it. Returns why it failed, or null. */
async function discardForAction($: EngineInterface, provider: ProviderId): Promise<string | null> {
  let failure: string | null
  try {
    failure = (await runJson($, ['discard', provider, '--json'])).failure
  } catch (error) {
    failure = String(error)
  }
  if (failure) return failure
  if ((await read($, expanded))?.provider === provider) await closeForm($)
  return null
}

async function openForm($: EngineInterface, provider: ProviderId, mode: Expanded['mode'], note: string | null = null) {
  const open: Expanded = { provider, mode, variant: null }
  await discardEntries($, provider)
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

async function cancelForm($: EngineInterface, provider: ProviderId) {
  await discardEntries($, provider)
  await closeForm($)
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
    const { data, failure } = await runJson<{ tokenUrl?: string; message?: string }>($, ['open-token-page', open.provider, ...(open.variant ? ['--variant', open.variant] : []), '--open', '--json'])
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

/** What a successful connect did, with the CLI's own note (not linked, sync blocked, could not detach) when it sent one. */
function connectedText(name: string, result: Outcome): string {
  if (result.sync === 'synced') return result.message ? `${name} saved · ${result.message}` : `${name} synced to your Altimate workspace`
  return result.message ? `${name} connected · kept local · ${result.message}` : `${name} connected · kept local`
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
      const run = await runJson<Outcome>($, [verb, open.provider, ...(localOnly ? ['--local-only'] : []), ...variant, '--json'], WORKSPACE_TIMEOUT_MS)
      outcome = run.data ?? { status: 'failed', message: run.failure }
    })
    const result = outcome as Outcome | null
    if (!result) return
    if (result.status === 'connected') {
      const text = `${connectedText(name, result)}${result.account ? ` as ${result.account}` : ''}`
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
        // The band acts on what was found, not on values left in an earlier form.
        const discardFailure = await discardForAction($, one.id)
        if (discardFailure) {
          lines.push(`${one.name}: could not clear earlier input: ${discardFailure}`)
          continue
        }
        const { data, failure } = await runJson<Outcome>($, ['connect', one.id, ...(localOnly ? ['--local-only'] : []), '--json'], WORKSPACE_TIMEOUT_MS)
        if (data?.status === 'connected') lines.push(connectedText(one.name, data))
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

type SyncReport = { results?: { id: string; result?: string; reason?: string; steps?: { label: string; ok: boolean }[] }[] }

/** One line per synced, skipped or failed provider from `sync --json`; null when the output is not that JSON. */
function syncText(stdout: string): string | null {
  const results = parseJson<SyncReport>(stdout)?.results
  if (!Array.isArray(results) || results.length === 0) return null
  return results
    .map(one => {
      const who = ['github', 'jira', 'linear'].includes(one.id) ? nameOf(one.id as ProviderId) : one.id
      if (one.result !== 'synced') return `${who}: ${one.reason ?? one.result ?? 'not synced'}`
      const steps = one.steps ?? []
      const bad = steps.filter(step => !step.ok).map(step => step.label)
      const last = steps.filter(step => step.ok).pop()?.label
      const detail = bad.length > 0 ? `${bad.join(', ')} failed` : last
      return detail ? `${who} synced · ${detail}` : `${who} synced`
    })
    .join(' · ')
}

/** What a disconnect did: the CLI says whether anything was stored and whether a workspace copy went. */
function disconnectText(stdout: string, target: ProviderId | 'all'): string | null {
  const data = parseJson<{ removed?: boolean; removedFromWorkspace?: number; detached?: boolean; message?: string }>(stdout)
  if (!data) return null
  const who = target === 'all' ? 'Integrations' : nameOf(target)
  if (!data.removed) return `${who}: nothing was stored`
  const done = data.removedFromWorkspace ? `${who} disconnected · removed from your Altimate workspace` : `${who} disconnected`
  return data.detached === false ? `${done} · ${data.message ?? 'it could not be detached from the linked workspace'}` : done
}

function summarize(verb: string | undefined, target: ProviderId | 'all'): string {
  const who = target === 'all' ? 'Integrations' : nameOf(target)
  switch (verb) {
    case 'sync':
      return `${who} synced to your Altimate workspace`
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
    // The lineage half failing to start must not stop this pane's own setup below.
    await startLineage($).catch(error => $.ui.log(`lineage-pane · could not start: ${String(error)}`))
    // A press that was running when an earlier session ended can never finish, so it must not block this one.
    await update($, busy, () => null)
    // A `-p` run or the SDK has nobody to show the band to, so it does not scan the machine.
    if (e.isInteractive) void refresh($, 'detect')
    // Decisions on the person's skill and knowledge requests, as toasts: only someone at the terminal reads them.
    if (e.isInteractive) startReviewNotices($, e.cwd)

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
    // One band per plugin: the lineage impact line rides under the integrations one, or alone.
    if (e.props.hasSurvey) return next(e)
    const lineage = await lineageBand($, $.ui.resolve(e))
    const pass = async () => lineage ?? next(e)
    const current = await read($, status)
    if (!current || (await read($, isBandHidden))) return pass()

    const stopped = current.providers.filter(one => one.state === 'rejected' || one.state === 'expired')
    const found = current.providers.filter(one => one.state === 'detected' || one.found)
    const remote = current.providers.filter(one => one.state === 'available')
    if (stopped.length + found.length + remote.length === 0) return pass()

    const { Box, Button, Text } = $.ui.resolve(e)
    const running = await read($, busy)
    const ready = found
    const signedOut = current.workspace.signedIn === false
    const foundText = ready.map(one => `${one.name} (${(one.found?.source ?? one.source)?.label ?? 'local'})`).join(', ')

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
                    await openForm($, one.id, one.managed === false ? 'connect' : 'update')
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
            {ready.length > 0 && !signedOut && <Button key="connect-all" label="Connect" onPress={() => connectFound($, ready, false)} />}
            {ready.length > 0 && <Button key="keep-local" label="Keep local" onPress={() => connectFound($, ready, true)} />}
            {signedOut && <Button key="sign-in" label="Sign in to sync" onPress={() => later($, () => signIn($))} />}
            <Button key="details" label="Review" onPress={() => later($, () => openPane($))} />
            <Button key="hide" label="Later" onPress={() => update($, isBandHidden, () => true)} />
          </Box>
        )}
        {lineage}
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
    const choices = await read($, workspaces)
    const now = await $.clock.now()

    if (!current) {
      return (
        <Box flexDirection="column">
          <Text dimColor>{note ?? 'Looking for GitHub, Jira and Linear credentials on this machine…'}</Text>
        </Box>
      )
    }

    const signedOut = current.workspace.signedIn === false

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>One-click integrations</Text>
          <Text dimColor>Workspace: {signedOut ? 'not signed in · everything stays on this machine' : current.workspace.linked === false ? 'not linked' : current.workspace.name}</Text>
          {signedOut && !running && (
            <Box>
              <Button key="sign-in" label="Sign in to sync" onPress={() => later($, () => signIn($))} />
            </Box>
          )}
          {!signedOut && current.workspace.linked === false && !running && !choices && (
            <Box>
              <Button key="link-workspace" label="Link workspace" onPress={() => later($, () => listWorkspaces($))} />
            </Box>
          )}
          {choices && !running && (
            <Box flexDirection="column">
              <Text dimColor>Link this folder to:</Text>
              <Box flexDirection="column">
                {choices.map(one => (
                  <Button key={`link-${one.id}`} label={one.name} onPress={() => later($, () => linkWorkspace($, one))} />
                ))}
                <Button key="link-cancel" label="Cancel" onPress={() => later($, () => update($, workspaces, () => null))} />
              </Box>
            </Box>
          )}
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
                    {(open.mode === 'update' || !signedOut) && (
                      <Button
                        key={`${one.id}-submit`}
                        label={open.mode === 'update' ? 'Update' : 'Connect & sync'}
                        onPress={() => submitForm($, false)}
                      />
                    )}
                    <Button key={`${one.id}-keep-local`} label="Keep local" onPress={() => submitForm($, true)} />
                    <Button key={`${one.id}-cancel`} label="Cancel" onPress={() => later($, () => cancelForm($, one.id))} />
                  </Box>
                )}
              </Box>
            ) : running?.provider === one.id ? (
              <Box flexDirection="column">
                <Text color="warning">{'  '}{running.label}</Text>
              </Box>
            ) : (
              <Box>{actionsFor($, one, Button, signedOut)}</Box>
            )}
          </Box>
        ))}
        {note && <Text color="suggestion">{note}</Text>}
        <Box>
          <Button key="refresh" label="Rescan" onPress={() => later($, () => act($, 'all', 'Rescanning…', ['detect', '--json']))} />
          {!signedOut && <Button key="sync-everything" label="Sync all" onPress={() => later($, () => syncAll($))} />}
        </Box>
      </Box>
    )
  })

  registerLineage(on)
}

// One row of buttons per provider, chosen by its state. Credentials are added
// or updated in the row's form; signed out, nothing offers to sync.
function actionsFor($: EngineInterface, one: Provider, Button: any, signedOut: boolean) {
  const buttons = []
  const addCredentials = () => (
    <Button key={`${one.id}-add`} label="Add credentials" onPress={() => later($, () => openForm($, one.id, 'connect'))} />
  )
  if (one.state === 'detected' || one.found) {
    buttons.push(
      ...(signedOut ? [] : [<Button key={`${one.id}-use`} label="Connect" onPress={() => connectFound($, [one], false)} />]),
      <Button key={`${one.id}-local`} label="Keep local" onPress={() => connectFound($, [one], true)} />,
      addCredentials(),
    )
  }
  if (one.state === 'available' || one.state === 'not_found') buttons.push(addCredentials())
  // A connection made by hand in the web app is managed there: from here it can only be replaced by adding credentials.
  if (one.managed === false && one.state !== 'detected') return one.found ? buttons : [addCredentials()]
  // The connection this tool made can be replaced even when the row shows a newer one made by hand and still valid.
  if (one.state === 'expired' || one.state === 'rejected' || (one.state === 'connected' && one.sync === 'synced')) {
    buttons.push(<Button key={`${one.id}-update`} label="Update" onPress={() => later($, () => openForm($, one.id, 'update'))} />)
  }
  if (one.state === 'connected' || one.state === 'expired' || one.state === 'rejected') {
    // A local credential that is not blocked only waits for a sync; a blocked one
    // is unblocked and synced in the same click. One saved in the workspace has no
    // local copy to keep: Update (above) offers Keep local, which moves it here.
    if (!signedOut && one.state === 'connected' && one.sync === 'local') {
      buttons.push(<Button key={`${one.id}-sync`} label="Sync" onPress={() => later($, () => act($, one.id, 'Syncing…', ['sync', one.id, '--json']))} />)
    }
    if (one.sync === 'blocked') {
      if (!signedOut) buttons.push(
        <Button
          key={`${one.id}-allow`}
          label="Allow sync"
          onPress={() => later($, () => act($, one.id, 'Syncing…', ['unblock', one.id, '--json'], ['sync', one.id, '--json']))}
        />,
      )
    }
    buttons.push(<Button key={`${one.id}-off`} label="Disconnect" onPress={() => later($, () => act($, one.id, 'Disconnecting…', ['disconnect', one.id, '--json']))} />)
  }
  return buttons
}
