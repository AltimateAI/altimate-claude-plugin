// Team comments from shared dbt docs, in Claude's context and in /comments.
//
// The open threads of the project's shared docs are fetched when the session starts and every
// `commentsPollSeconds`. When Claude reads or edits a model that has open threads, one context block
// names each thread's line and text, so it sees the review before it changes the model. Replying and
// resolving are buttons the person presses in the /comments pane; Claude never posts.
import { atom, read, update } from 'claude-code'
import type { Args, EngineInterface, EventResult, On, RenderElement, ToolCallResult } from 'claude-code'

import type { CommentsState, CommentsThread } from '../../types'
import { later, runTool } from '../altimate-cli'
import type { BashCall, ContextLines, EditedFile, FileCall } from '../tool-chain'
import type { BandUi, FeatureContext } from './index'

const COMMAND = 'comments'
const PANE = 'altimate-comments'
const PANE_TITLE = 'Team comments'
const TOOL = 'docs_share_comments'
// A call the CLI starts and waits on, so a stalled backend is cut off well before a poll's period.
const LIST_TIMEOUT_MS = 45_000
const POST_TIMEOUT_MS = 45_000
const DEFAULT_POLL_SECONDS = 900
// What one context block carries at most, so a busy review never floods Claude's context.
const MAX_THREADS_IN_CONTEXT = 8
const MAX_MESSAGE_CHARS = 600
const NEEDS_NEWER_CLI = 'Team comments need a newer altimate-code than 0.12.10 (it has no docs_share_comments tool): npm install -g altimate-code@latest'

const INITIAL: CommentsState = { root: null, project: null, threads: [], loadedAt: null, loading: false, needs: null, note: null, drafts: {}, posting: null }

const state = atom({ plugin: 'altimate-code', key: 'comments' } as const, null as CommentsState | null)

async function get($: EngineInterface): Promise<CommentsState> {
  return (await read($, state)) ?? INITIAL
}

async function change($: EngineInterface, fn: (current: CommentsState) => CommentsState) {
  return update($, state, current => fn(current ?? INITIAL))
}

let pollSeconds = DEFAULT_POLL_SECONDS
let inContext = true
let poll: { cancel: () => void } | null = null

/** Adds this feature's own hooks. */
export function register(on: On, context: FeatureContext) {
  const options = context.options as Record<string, unknown>
  pollSeconds = typeof options.commentsPollSeconds === 'number' && options.commentsPollSeconds >= 30 ? options.commentsPollSeconds : DEFAULT_POLL_SECONDS
  inContext = options.commentsInContext !== false

  on('command.run', { command: COMMAND }, async $ => {
    try {
      await $.ui.open({ id: PANE, title: PANE_TITLE, focus: true, closeOnEscape: true })
      // Running the command again is how a missing tool is looked for again, after an update.
      await change($, current => ({ ...current, needs: null }))
      later($, () => load($))
      return { text: 'Team comments opened in the side pane.' }
    } catch (error) {
      return { text: `Could not open team comments: ${String(error)}` }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    // The mobile app draws no field yet: there a thread is shown, not answered.
    const Input = 'Input' in ui ? ui.Input : null
    const current = await get($)

    if (current.needs) {
      return (
        <Box flexDirection="column">
          <Text color="warning">{current.needs}</Text>
        </Box>
      )
    }
    const groups = groupByModel(current.threads)
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>Team comments{current.project ? ` · ${current.project}` : ''}</Text>
          <Text dimColor>
            {current.loading ? 'Loading…' : current.threads.length === 0 ? 'No open threads.' : `${current.threads.length} open thread${current.threads.length === 1 ? '' : 's'}`}
          </Text>
          {current.note && <Text color="warning">{current.note}</Text>}
        </Box>
        {groups.map(group => (
          <Box key={group.label} flexDirection="column">
            <Text bold>{group.label}</Text>
            {group.threads.map(thread => {
              const key = `${thread.shareId}:${thread.groupId}`
              const busy = current.posting === key
              const draft = current.drafts[key] ?? ''
              return (
                <Box key={key} flexDirection="column">
                  <Text dimColor>
                    {'  '}
                    {thread.column ? `column ${thread.column}` : thread.field ?? 'model'}
                    {thread.range ? ` · line ${thread.range.start.line + 1}` : ''}
                    {thread.highlight ? ` · “${clip(thread.highlight, 60)}”` : ''}
                  </Text>
                  {thread.messages.map(message => (
                    <Text key={String(message.id)}>
                      {'  '}
                      <Text bold>{message.author}</Text>: {clip(message.text, MAX_MESSAGE_CHARS)}
                    </Text>
                  ))}
                  {busy ? (
                    <Text color="warning">{'  '}Posting…</Text>
                  ) : (
                    <Box flexDirection="column">
                      {Input === null ? null : (
                        <Input
                          key={`${key}-reply`}
                          label="Reply"
                          value={draft}
                          submitLabel="send"
                          onInput={(value: string) => {
                            void change($, now => ({ ...now, drafts: { ...now.drafts, [key]: value } }))
                          }}
                          onSubmit={(value: string) => later($, () => reply($, thread, value))}
                        />
                      )}
                      <Box>
                        {Input !== null && <Button key={`${key}-send`} label="Reply" onPress={() => later($, () => reply($, thread, draft))} />}
                        <Button key={`${key}-resolve`} label="Resolve" onPress={() => later($, () => resolve($, thread))} />
                      </Box>
                    </Box>
                  )}
                </Box>
              )
            })}
          </Box>
        ))}
        <Box>
          <Button key="refresh" label="Refresh" onPress={() => later($, () => load($))} />
        </Box>
      </Box>
    )
  })
}

/** After the session started: the command, a first load, and the poll. */
export async function sessionStart($: EngineInterface, e: Args<'session.start'>) {
  await $.command.register({ name: COMMAND, description: 'Open comment threads from your team’s shared dbt docs; reply or resolve' })
  poll?.cancel()
  poll = null
  // A `-p` run or the SDK has nobody to answer a thread and no pane: it neither fetches nor polls.
  if (!e.isInteractive) return
  const cwd = (e as { cwd?: string }).cwd ?? (await $.session.cwd())
  const found = await projectOf($, cwd)
  if (!found) return
  await change($, current => ({ ...INITIAL, ...found, drafts: current.drafts }))
  later($, () => load($))
  poll = $.clock.every(pollSeconds * 1000, () => later($, () => load($)))
}

export async function turnStart($: EngineInterface, e: Args<'turn.start'>) {}

export async function turnComplete($: EngineInterface, e: Args<'turn.complete'>, out: EventResult<'turn.complete'>) {}

export async function sessionEnd($: EngineInterface, e: Args<'session.end'>) {
  poll?.cancel()
  poll = null
}

/** The line under the lineage one while threads are open; null with none. */
export async function bandLine($: EngineInterface, ui: BandUi): Promise<RenderElement | null> {
  const current = await get($)
  if (current.threads.length === 0) return null
  const { Box, Button, Text } = ui
  return (
    <Box>
      <Text>
        💬 {current.threads.length} open team comment{current.threads.length === 1 ? '' : 's'}
        {current.project ? ` on ${current.project}` : ''}{' '}
      </Text>
      <Button key="comments-open" label="Open" onPress={() => later($, () => $.ui.open({ id: PANE, title: PANE_TITLE, focus: true, closeOnEscape: true }))} />
    </Box>
  )
}

export async function bashRewrite($: EngineInterface, e: BashCall): Promise<string | null> {
  return null
}

export async function bashGate($: EngineInterface, e: BashCall): Promise<{ deny: string } | null> {
  return null
}

export async function bashAfter($: EngineInterface, e: BashCall, result: ToolCallResult): Promise<ContextLines> {}

export async function editAfter($: EngineInterface, e: FileCall, result: ToolCallResult, file: EditedFile): Promise<ContextLines> {}

/** Whether `editAfter` needs the file's text from before the edit. */
export const editReadsBefore = false

/** The open threads on a file Claude read or edited, as one context block. */
export async function readOrEditAfter($: EngineInterface, e: FileCall, result: ToolCallResult, file: { path: string }): Promise<ContextLines> {
  if (!inContext) return null
  const current = await get($)
  if (!current.root || current.threads.length === 0) return null
  const here = threadsOnFile(current.threads, current.root, file.path)
  if (here.length === 0) return null
  const text = await $.fs.read(file.path).catch(() => null)
  return [contextBlock(relativePath(current.root, file.path), here, text)]
}

// ---------------------------------------------------------------------------------------------------
// Loading, replying, resolving
// ---------------------------------------------------------------------------------------------------

/** The dbt project above the folder and its name, or null when there is none. */
async function projectOf($: EngineInterface, start: string): Promise<{ root: string; project: string | null } | null> {
  let dir = start
  for (let i = 0; i < 40; i++) {
    if (await $.fs.exists(`${dir}/dbt_project.yml`).catch(() => false)) {
      const text = await $.fs.read(`${dir}/dbt_project.yml`).catch(() => '')
      return { root: dir, project: projectName(text) }
    }
    const parent = dir.replace(/[\\/][^\\/]*$/, '') || dir
    if (parent === dir) return null
    dir = parent
  }
  return null
}

/** `name:` of a dbt_project.yml. */
export function projectName(text: string): string | null {
  return /^name:\s*['"]?([^'"\s#]+)/m.exec(text)?.[1] ?? null
}

type Listed = { threads?: unknown[] } | null

/** True when the CLI has no such tool, or only the placeholder one. */
function lacksTool(text: string): boolean {
  return /unknown tool|not exposed|no such tool|not implemented|invalid tool|tool .* not found/i.test(text)
}

async function load($: EngineInterface) {
  const before = await get($)
  if (before.loading || before.needs || !before.project) return
  await change($, current => ({ ...current, loading: true }))
  try {
    const out = await runTool($, TOOL, { action: 'list', project: before.project }, { cliOnly: true, until: (await $.clock.now()) + LIST_TIMEOUT_MS })
    const listed = out.metadata as Listed
    if (!out.ok || !Array.isArray(listed?.threads)) {
      if (lacksTool(out.text)) {
        await change($, current => ({ ...current, needs: NEEDS_NEWER_CLI, loading: false }))
        return
      }
      // Keep what was shown: a failed refresh is no reason to hide the threads already fetched.
      await change($, current => ({ ...current, loading: false, note: oneLine(out.text) || 'Could not load the comments.' }))
      return
    }
    const threads = listed.threads.map(toThread).filter((one): one is CommentsThread => one !== null)
    const now = await $.clock.now()
    await change($, current => ({ ...current, threads, loadedAt: now, loading: false, note: null }))
  } catch (error) {
    const missing = /ENOENT|not found|no such file/i.test(String(error))
    await change($, current => ({
      ...current,
      loading: false,
      note: missing ? 'Team comments need the altimate-code CLI: npm install -g altimate-code@latest' : `Could not load the comments: ${oneLine(String(error))}`,
    }))
  }
}

async function post($: EngineInterface, thread: CommentsThread, args: Record<string, unknown>, done: string) {
  const key = `${thread.shareId}:${thread.groupId}`
  if ((await get($)).posting) return
  await change($, current => ({ ...current, posting: key, note: null }))
  try {
    // Posting speaks for the person and changes the shared docs: write permission, CLI route.
    const out = await runTool(
      $,
      TOOL,
      { share_id: thread.shareId, group_id: thread.groupId, ...args },
      { write: true, until: (await $.clock.now()) + POST_TIMEOUT_MS },
    )
    const sent = out.ok && (out.metadata as { success?: boolean } | null)?.success !== false
    if (!sent) {
      await change($, current => ({ ...current, posting: null, note: oneLine(out.text) || 'The comment service did not accept that.' }))
      return
    }
    await change($, current => ({ ...current, posting: null, note: done, drafts: { ...current.drafts, [key]: '' } }))
    await load($)
  } catch (error) {
    await change($, current => ({ ...current, posting: null, note: `Could not post: ${oneLine(String(error))}` }))
  }
}

async function reply($: EngineInterface, thread: CommentsThread, value: string) {
  const text = value.trim()
  if (!text) return void (await change($, current => ({ ...current, note: 'Type a reply first.' })))
  await post($, thread, { action: 'reply', text }, 'Replied.')
}

async function resolve($: EngineInterface, thread: CommentsThread) {
  await post($, thread, { action: 'resolve' }, 'Resolved.')
}

// ---------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 240)
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const slashes = (path: string) => path.replace(/\\/g, '/')

/** A path relative to the project folder, with forward slashes; the path itself when outside it. */
export function relativePath(root: string, path: string): string {
  const base = slashes(root).replace(/\/+$/, '')
  const full = slashes(path)
  return full.startsWith(`${base}/`) ? full.slice(base.length + 1) : full
}

/** A thread as the tool returns it (snake_case), or null when it lacks the ids. */
export function toThread(raw: unknown): CommentsThread | null {
  const t = raw as Record<string, any> | null
  if (!t || typeof t.share_id !== 'number' || typeof t.group_id !== 'number') return null
  const range = t.range?.start && typeof t.range.start.line === 'number' ? { start: { line: t.range.start.line }, end: { line: Number(t.range.end?.line ?? t.range.start.line) } } : undefined
  return {
    shareId: t.share_id,
    shareName: String(t.share_name ?? ''),
    groupId: t.group_id,
    filePath: typeof t.file_path === 'string' ? slashes(t.file_path) : undefined,
    uniqueId: typeof t.unique_id === 'string' ? t.unique_id : undefined,
    column: typeof t.column === 'string' ? t.column : undefined,
    field: typeof t.field === 'string' ? t.field : undefined,
    highlight: typeof t.highlight === 'string' && t.highlight ? t.highlight : undefined,
    range,
    messages: (Array.isArray(t.messages) ? t.messages : []).map((m: any) => ({
      id: Number(m.id ?? 0),
      author: String(m.author ?? 'someone'),
      text: String(m.text ?? ''),
    })),
  }
}

/** The threads that sit on this file (their path is relative to the project folder). */
export function threadsOnFile(threads: CommentsThread[], root: string, path: string): CommentsThread[] {
  const rel = relativePath(root, path)
  return threads.filter(thread => thread.filePath !== undefined && slashes(thread.filePath).replace(/^\.\//, '') === rel)
}

/**
 * The 1-based line a thread sits on in the file's current text: the first line holding its highlighted
 * text, since an edit moves the stored range; else the stored range's line; else null.
 */
export function placeThread(thread: CommentsThread, text: string | null): number | null {
  if (text !== null && thread.highlight) {
    // A highlight may span lines, and the line it starts on is the one to name.
    const first = thread.highlight.split(/\r?\n/).find(line => line.trim() !== '')
    const at = first === undefined ? -1 : text.indexOf(first.trim())
    if (at >= 0) return text.slice(0, at).split('\n').length
  }
  return thread.range ? thread.range.start.line + 1 : null
}

/** One context block for a file: each thread's line, what it is on, and its messages. */
export function contextBlock(relative: string, threads: CommentsThread[], text: string | null): string {
  const shown = threads.slice(0, MAX_THREADS_IN_CONTEXT)
  const lines = [`Open team comments on ${relative} (from the shared dbt docs; the person decides whether to reply or resolve):`]
  for (const thread of shown) {
    const line = placeThread(thread, text)
    const target = thread.column ? `column ${thread.column}` : thread.field ?? 'model'
    lines.push(`- ${line === null ? 'no line' : `line ${line}`}, ${target}${thread.highlight ? `, on “${clip(thread.highlight, 80)}”` : ''}:`)
    for (const message of thread.messages) lines.push(`    ${message.author}: ${clip(message.text.replace(/\s+/g, ' '), MAX_MESSAGE_CHARS)}`)
  }
  if (threads.length > shown.length) lines.push(`- and ${threads.length - shown.length} more open threads; /comments lists them.`)
  return lines.join('\n')
}

/** The threads grouped by the model (file) they are on, in file order. */
export function groupByModel(threads: CommentsThread[]): { label: string; threads: CommentsThread[] }[] {
  const by = new Map<string, CommentsThread[]>()
  for (const thread of threads) {
    const label = thread.filePath ?? thread.uniqueId ?? thread.shareName
    by.set(label, [...(by.get(label) ?? []), thread])
  }
  return [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([label, group]) => ({ label, threads: group }))
}
