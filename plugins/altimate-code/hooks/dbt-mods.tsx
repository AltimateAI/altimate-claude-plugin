// dbt Power User's everyday helpers, beside Claude: compile-and-validate after each model edit, Explain
// and Fix on a failed dbt run, a results pane for `dbt show`, the manifest's facts on a model Claude
// reads, and an environment doctor at session start. Each runs the project's own dbt; none calls a model.
import { atom, read, update } from 'claude-code'
import type { Args, EngineInterface, EventResult, On, PluginOptions, RenderElement, ToolCallResult } from 'claude-code'

import type { CheckView, DoctorCheck, DoctorView, FailureView, QueryResult, SavedQuery } from '../types'
import { later, runTool } from './altimate-cli'
import { openTracked } from './usage'
import { loadPaneSizesOnce, noteTerminal, paneTerminalColumns, paneRequest, sizeControls, type PaneSpec } from './pane-size'
import {
  cellText,
  columnDrift,
  undocumentedByEdit,
  columnWidths,
  dbtCommands,
  type DbtCommand,
  envNames,
  doctorNote,
  explainPrompt,
  failuresFrom,
  failuresFromText,
  sameFailure,
  isVersioned,
  fixPrompt,
  listedFiles,
  listedNames,
  logErrors,
  modelContext,
  modelContextNote,
  modelPaths,
  nodeForFile,
  profilesError,
  PROFILES_UNREADABLE,
  scrubDbt,
  redactValues,
  redactionValues,
  setRedactions,
  flagOf,
  profilesDirOf,
  withoutDropped,
  projectPaths,
  replayArgv,
  budgetHistory,
  dropOldest,
  fitSaved,
  savedRows,
  dbtVerdict,
  RUN_VERBS,
  targetPath,
  SCRATCH_TARGET,
  showPreview,
  stripAnsi,
  textTable,
  versionInfo,
  debugInfo,
} from './dbt-mods-core'

const RESULTS_PANE = 'altimate-results'
const RESULTS_TITLE = 'Query results'
// Wide by default: a data grid takes the widest dock.
const RESULTS_SIZES: PaneSpec = { rows: 30 }
const DOCTOR_PANE = 'altimate-doctor'
const DOCTOR_TITLE = 'dbt doctor'
const CHECK_PANE = 'altimate-check'
const CHECK_TITLE = 'dbt check'
const SHOW_COMMAND = 'dbt-show'
const DOCTOR_COMMAND = 'dbt-doctor'
const HISTORY_KEY = 'dbt-results-history'
// The tools that write a file in this Claude Code build (MultiEdit is not one of them).
const EDIT_TOOLS = new Set(['Edit', 'Write'])
// How long an edit's result waits for compile-and-validate before it goes back to Claude without it;
// a later answer rides on Claude's next tool result.
export const CHECK_HOLD_MS = 30_000
const DBT_TIMEOUT_MS = 120_000
const SHOW_LIMIT = 50
const HISTORY_SIZE = 20
// Bookmarks keep their rows past Clear history, so they are bounded too.
const BOOKMARK_SIZE = 50
// $.fs.read refuses files over 4 MiB.
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024
// The most files the doctor's freshness check looks at.
const MAX_SCANNED = 3000
// The history the results pane lists: every saved query, most recent first.
const HISTORY_SHOWN = HISTORY_SIZE

const checkAtom = atom({ plugin: 'altimate-code', key: 'dbtCheck' } as const, null as CheckView | null)
const failureAtom = atom({ plugin: 'altimate-code', key: 'dbtFailure' } as const, null as FailureView | null)
const doctorAtom = atom({ plugin: 'altimate-code', key: 'dbtDoctor' } as const, null as DoctorView | null)
const resultAtom = atom({ plugin: 'altimate-code', key: 'dbtResult' } as const, null as QueryResult | null)
const historyAtom = atom({ plugin: 'altimate-code', key: 'dbtHistory' } as const, [] as SavedQuery[])
const resultBusyAtom = atom({ plugin: 'altimate-code', key: 'dbtResultBusy' } as const, null as string | null)

// Notes for Claude that missed their own tool result (a slow check): they ride on the next tool result of
// the same agent, while their check is still the newest check of its file in this conversation (the band may
// show another file's check by then: the note is still its own edit's).
const pendingNotes: { note: string; agentId: string | null; current: () => boolean }[] = []
// Model context given this turn, by model and manifest revision: once a turn, as context may be compacted.
const contextGiven = new Set<string>()
// The doctor's note goes with the first prompt after it lands, once a session.
let doctorNoteDue: string | null = null
// Every dbt the plugin starts in a project waits for the one before it: DuckDB and SQLite projects
// lock their database file for a whole invocation.
const queues = new Map<string, Promise<unknown>>()
// The newest check per file: an older one of the same file landing late does not overwrite it.
const checkSeq = new Map<string, number>()
// The columns each model's last check found returned and undocumented, less the gaps an edit made, by project and
// file: a column there is not a new gap. (One documented then and undocumented now is: its documentation went.)
const lastReturned = new Map<string, string[]>()
// Models whose columns undocumented from before an edit were said once in this conversation: not said again.
const oldGapsSaid = new Set<string>()
// The undocumented columns an edit in this conversation made, by project and file: still the edit's on later edits until documented.
const editGaps = new Map<string, string[]>()
let seq = 0
// Bumped when a conversation ends (/clear): work started in the last one lands nowhere in this one.
let generation = 0
/** Gives Claude the doctor's note with its next prompt, unless the conversation that asked for it has ended. */
function noteDoctor(root: string, view: DoctorView, asked: number) {
  if (generation === asked) doctorNoteDue = doctorNote(root, view.checks)
}
// Slices of manifests too big to read here, by manifest path, file and revision.
const slices = new Map<string, Promise<any>>()
const MAX_SLICES = 16
// The last manifest read whole, by path and revision.
let parsed: { path: string; mtimeMs: number; manifest: any } | null = null

const dirname = (path: string) => path.replace(/[\\/][^\\/]*$/, '') || path
const basename = (path: string) => path.split(/[\\/]/).pop() ?? path
const relative = (root: string, path: string) => path.slice(root.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
const quoteName = (name: string) => JSON.stringify(name)

function within<T>($: EngineInterface, ms: number, work: Promise<T>): Promise<T | null> {
  return new Promise(resolve => {
    let settled = false
    const settle = (value: T | null) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    $.clock.after(ms, () => settle(null))
    work.then(settle, () => settle(null))
  })
}

/** `a/./b/../c` → `a/c`: two spellings of one folder are one project, one queue, one identity. */
function normalize(path: string): string {
  const out: string[] = []
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (part === '.' || (part === '' && out.length > 0)) continue
    if (part === '..' && out.length > 1 && out[out.length - 1] !== '..') out.pop()
    else out.push(part)
  }
  return out.join('/') || '/'
}

/** The closest folder above a file or folder that holds dbt_project.yml, spelled one way. */
async function projectRoot($: EngineInterface, start: string, isFile: boolean): Promise<string | null> {
  let dir = normalize(isFile ? dirname(start) : start)
  for (let i = 0; i < 40; i++) {
    if (await $.fs.exists(`${dir}/dbt_project.yml`).catch(() => false)) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

/** The session's dbt project: the session folder's own, else one a level or two below it. */
async function sessionProject($: EngineInterface): Promise<string | null> {
  const root = await $.session.root().catch(() => null)
  if (!root) return null
  const own = await projectRoot($, root, false)
  if (own) return own
  let level = [root]
  for (let depth = 0; depth < 2; depth++) {
    const next: string[] = []
    for (const dir of level) {
      for (const entry of await $.fs.list(dir).catch(() => [])) {
        if (entry.kind !== 'dir' || entry.name.startsWith('.') || ['node_modules', 'target', 'dbt_packages'].includes(entry.name)) continue
        const sub = `${dir}/${entry.name}`
        if (await $.fs.exists(`${sub}/dbt_project.yml`).catch(() => false)) return sub
        next.push(sub)
      }
    }
    level = next.slice(0, 200)
  }
  return null
}

/** The project's dbt: its virtual environment's when it has one, else the one on PATH. */
async function dbtBinary($: EngineInterface, root: string): Promise<string> {
  // Only the project's own folders: never a dbt found above the folder the person opened. A project dbt runs from
  // for a package (integration_tests) also takes the package repo's own environment.
  for (const dir of [root, ...(runFor.has(root) ? [runFor.get(root)!] : [])]) {
    for (const candidate of [`${dir}/.venv/bin/dbt`, `${dir}/venv/bin/dbt`, `${dir}/.venv/Scripts/dbt.exe`, `${dir}/venv/Scripts/dbt.exe`]) {
      if (await $.fs.exists(candidate).catch(() => false)) return candidate
    }
  }
  return 'dbt'
}

// The package repo each project dbt runs from for a package belongs to (integration_tests → the repo).
const runFor = new Map<string, string>()

// A run's process result, with what `read` gave of its artifacts while the queue was held (null when that failed).
type Artifact = { manifest: any; mtimeMs: number } | null
type ProcessDone = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated?: boolean; artifact?: Artifact }

// What a run that was no longer wanted when its turn came answers: it never started.
const SKIPPED = { exitCode: -2, stdout: '', stderr: 'skipped: a newer check replaced it' }

/**
 * Runs a command in a project, after any dbt this plugin already started there. `wanted` is asked
 * when its turn comes: a check a newer edit replaced runs no warehouse query.
 */
function runQueued($: EngineInterface, root: string, argv: () => Promise<string[]>, options: { cwd?: string; timeoutMs?: number; wanted?: () => boolean; scratch?: boolean; read?: () => Promise<Artifact> } = {}): Promise<ProcessDone> {
  const before = queues.get(root) ?? Promise.resolve()
  const run = before
    .catch(() => {})
    .then(async () => {
      if (options.wanted && !options.wanted()) return SKIPPED
      const command = await argv()
      // The values of the profile dbt may echo in its errors are known before any of its output is read.
      await ensureRedactions($, root)
      // The artifact's invocation right before the plugin's dbt runs and right after it exits: it is the plugin's
      // own only when it changed across the process, and when dbt printed its own id, only that one is. A run in
      // the plugin's own folder leaves the project's artifact alone, unless the command names a folder itself.
      const ownFolder = options.scratch && !command.some(word => word === '--target-path' || word.startsWith('--target-path='))
      const tracked = !ownFolder && command.some(word => word === 'show' || word === 'ls')
      const before = tracked ? await seenInvocation($, root).catch(() => null) : null
      // A run the plugin starts by itself writes its artifacts to its own folder (a --target-path the command
      // names still wins): the project's manifest keeps every model's compiled SQL.
      const env = options.scratch ? { DBT_TARGET_PATH: await scratchOf($, root) } : undefined
      const done = await $.process.run(command, { cwd: options.cwd ?? root, timeoutMs: options.timeoutMs ?? DBT_TIMEOUT_MS, ...(env && { env }) })
      if (tracked) {
        const after = await seenInvocation($, root).catch(() => null)
        const own = printedInvocation(done.stdout) ?? (after !== null && after !== before ? after : null)
        if (own) ownInvocation.set(root, own)
      }
      // What the run wrote is read before the next queued run can write over it.
      return options.read ? { ...done, artifact: await options.read().catch(() => null) } : done
    })
  queues.set(root, run.catch(() => {}))
  return run
}

// The invocation of the run_results.json the plugin's own last dbt show or ls wrote in a project: an artifact
// of that invocation is never the result of a command Claude ran.
const ownInvocation = new Map<string, string>()

/** The invocation id dbt's own JSON log lines carry, when the command printed them. */
const printedInvocation = (stdout: string): string | null => /"invocation_id"\s*:\s*"([^"]+)"/.exec(stdout)?.[1] ?? null

// Projects where the last dbt the plugin started could not be run at all (no such program, not on PATH): an
// edit's check does not start it again until a dbt runs there.
const unrunnable = new Set<string>()

/**
 * Whether a dbt run says there was no dbt to run: the spawn failed (a run that rejected, other than by its
 * timeout), or it exited non-zero with the shell saying dbt itself is not found (exit 127 naming no other
 * command), or a wrapper's own report that it cannot start dbt or its interpreter. A run that exited 0 never is, whatever its rows say, and another command not found (git, in
 * `dbt deps`) is not dbt.
 */
function cannotRun(run: { exitCode: number; stdout: string; stderr: string }): boolean {
  if (run.exitCode === -1) return !/time(?:d)?[ -]?out/i.test(run.stderr)
  if (run.exitCode === 0) return false
  // zsh says `zsh: command not found: dbt`, bash `bash: dbt: command not found`, dash and busybox `sh: 1: dbt: not found`:
  // the name is the command's, never the shell's.
  const names = [/command not found: ([\w./\\-]+)/gi, /([\w./\\-]+): command not found/gi, /\bsh: \d+: ([\w./\\-]+): not found/gi].flatMap(pattern => [...run.stderr.matchAll(pattern)].map(one => one[1]!))
  const missing = names.filter(name => !/^-?(?:ba|z|da|k|c|fi)?sh$/i.test(name)).map(name => name.split(/[\\/]/).pop()!.replace(/\.exe$/i, ''))
  // A wrapper or shim that cannot start dbt says so itself: the line names dbt or its interpreter.
  // The script that failed to start is dbt itself (a path ending in /dbt): another script's bad interpreter is not.
  const wrapped = run.stderr.split('\n').some(line => (/bad interpreter|cannot execute: required file not found/i.test(line) && /(?:^|[\s'"(:])(?:[^\s:'"]*[\\/])?dbt(?:\.exe)?(?=:)/i.test(line)) || /^\W*dbt(?:\.exe)?\W+is not recognized as an internal or external command/i.test(line))
  if (wrapped) return true
  // A bare 127 counts only when nothing else is said to be missing.
  return missing.length > 0 ? missing.includes('dbt') : run.exitCode === 127 && !/not found|no such file or directory/i.test(run.stderr)
}

/** Runs the project's dbt in the project, after any dbt this plugin already started there. */
function runDbt($: EngineInterface, root: string, args: string[], timeoutMs = DBT_TIMEOUT_MS, wanted?: () => boolean, scratch = false, read?: () => Promise<Artifact>) {
  return runQueued($, root, async () => [await dbtBinary($, root), ...args], { timeoutMs, wanted, scratch, read }).then(
    done => {
      if (done !== SKIPPED) {
        if (cannotRun(done)) unrunnable.add(root)
        else if (done.exitCode === 0) unrunnable.delete(root)
      }
      return done
    },
    error => {
      if (cannotRun({ exitCode: -1, stdout: '', stderr: String(error) })) unrunnable.add(root)
      throw error
    },
  )
}

/** The last lines of dbt's output; the fixed line when it is the unreadable-profiles error, whose lines quote the file. */
function dbtTail(run: { stdout: string; stderr: string }, lines: number, loose = true, joiner = '\n'): string {
  return profilesError(`${run.stdout}\n${run.stderr}`, loose) ? PROFILES_UNREADABLE : scrubDbt(stripAnsi(run.stderr || run.stdout)).trim().split('\n').slice(-lines).join(joiner)
}

// Reads a manifest too big for $.fs.read with the project's Python, and prints only what the helpers need
// about one file's node: the node, its tests, and the graph above and below it, names only.
export const MANIFEST_SLICE = `import sys; sys.path = [p for p in sys.path if p not in ('', '.')]
import json
m = json.load(open(sys.argv[1]))
rel = sys.argv[2]
nodes = m.get('nodes') or {}
pm = m.get('parent_map') or {}
cm = m.get('child_map') or {}
if not pm:
    for k, n in nodes.items():
        pm[k] = (n.get('depends_on') or {}).get('nodes') or []
        for p in pm[k]:
            cm.setdefault(p, []).append(k)
project = sys.argv[3] if len(sys.argv) > 3 else ''
hit = [k for k, n in nodes.items() if n.get('original_file_path') == rel and n.get('resource_type') != 'test' and (not project or not n.get('package_name') or n.get('package_name') == project)]
keep = set(hit)
tests = [c for h in hit for c in cm.get(h, []) if c.startswith('test.')]
for t in tests:
    if len(keep) >= 20000:
        break
    keep.add(t)
for graph in (pm, cm):
    todo = list(hit)
    while todo and len(keep) < 20000:
        for x in graph.get(todo.pop(), []):
            if len(keep) >= 20000:
                break
            if x not in keep:
                keep.add(x)
                todo.append(x)
full = set(hit) | (set(tests) & keep)
fields = ('name', 'package_name', 'resource_type', 'original_file_path', 'relation_name', 'description', 'config', 'tags', 'columns', 'column_name', 'test_metadata', 'depends_on', 'patch_path', 'version')
out = {'nodes': {}, 'parent_map': {}, 'child_map': {}, 'metadata': {'project_name': project or (m.get('metadata') or {}).get('project_name')}}
for k in keep:
    n = nodes.get(k)
    if n is not None:
        out['nodes'][k] = {f: n.get(f) for f in fields} if k in full else {'name': n.get('name'), 'resource_type': n.get('resource_type'), 'config': {'materialized': (n.get('config') or {}).get('materialized')}}
    out['parent_map'][k] = pm.get(k, [])
    out['child_map'][k] = cm.get(k, [])
print(json.dumps(out))
`

// Reads a run_results.json too big for $.fs.read with the project's Python, and prints only the results that
// did not succeed, with the fields the failure view reads.
export const RUN_FAILURES = `import sys; sys.path = [p for p in sys.path if p not in ('', '.')]
import json
r = json.load(open(sys.argv[1]))
# The profile's secret values arrive on stdin, never in argv or the environment: they are cut out of a message before it is cut to length.
try:
    values = [v for v in json.load(sys.stdin) if isinstance(v, str) and v]
except Exception:
    values = []
forms = set()
for v in values:
    for part in [v] + [line for line in v.splitlines() if len(line) >= 6]:
        repr_form = part.replace('\\\\', '\\\\\\\\').replace('\\n', '\\\\n').replace('\\r', '\\\\r').replace('\\t', '\\\\t')
        forms.update([part, json.dumps(part)[1:-1], repr_form, repr_form.replace("'", "\\\\'")])
forms = sorted((f for f in forms if f), key=len, reverse=True)
def clean(text):
    for f in forms:
        text = text.replace(f, '\\u2039redacted\\u203a')
    return text
keep = ('unique_id', 'status', 'message', 'failures')
bad = [{k: x[k] for k in keep if k in x} for x in (r.get('results') or []) if x.get('status') not in ('success', 'pass', 'skipped')]
for x in bad:
    if isinstance(x.get('message'), str):
        x['message'] = clean(x['message'])[:2000]
meta = r.get('metadata') or {}
print(json.dumps({'results': bad, 'metadata': {k: meta.get(k) for k in ('invocation_id', 'generated_at')}}))
`

/** The project's name in dbt_project.yml: which manifest nodes are its own, not an installed package's. */
async function projectName($: EngineInterface, root: string): Promise<string | null> {
  return /^name:\s*['"]?([\w-]+)/m.exec(await $.fs.read(`${root}/dbt_project.yml`).catch(() => ''))?.[1] ?? null
}

/** What a project's packages.yml (or a dependencies.yml with packages) asks for, and whether anything is installed; null when it declares none. */
async function packagesOf($: EngineInterface, root: string): Promise<{ file: string; installPath: string; installed: boolean } | null> {
  // A dependencies.yml that declares only `projects:` has no packages to install.
  const file = (await $.fs.exists(`${root}/packages.yml`).catch(() => false))
    ? 'packages.yml'
    : /^packages:/m.test(await $.fs.read(`${root}/dependencies.yml`).catch(() => ''))
      ? 'dependencies.yml'
      : null
  if (!file) return null
  // `packages-install-path` in dbt_project.yml, `dbt_packages` when absent.
  const configured = /^packages-install-path:\s*['"]?([^'"#\s]+)/m.exec(await $.fs.read(`${root}/dbt_project.yml`).catch(() => ''))?.[1]
  // A Jinja value is dbt's to render: dbt's default stands in.
  const installPath = configured && !configured.includes('{{') ? configured : 'dbt_packages'
  const installed = (await $.fs.list(installPath.startsWith('/') ? installPath : `${root}/${installPath}`).catch(() => [])).length > 0
  return { file, installPath, installed }
}

// The project below a package's folder that installs it, by package folder: found once a session.
const runners = new Map<string, Promise<string | null>>()

/**
 * A dbt project in a folder below `root`, a level or two down (a package's `integration_tests`), whose
 * packages.yml or dependencies.yml installs `root` itself by a local path (`local: ../`). That is where dbt is run
 * for a package repo: its packages are installed there, not in the package's own folder.
 */
function runnerOf($: EngineInterface, root: string): Promise<string | null> {
  const known = runners.get(root)
  if (known) return known
  const finding = (async () => {
    let level = [root]
    for (let depth = 0; depth < 2; depth++) {
      const next: string[] = []
      for (const dir of level) {
        for (const entry of await $.fs.list(dir).catch(() => [])) {
          if (entry.kind !== 'dir' || entry.name.startsWith('.') || ['node_modules', 'target', 'dbt_packages', 'dbt_modules', 'logs', 'venv'].includes(entry.name)) continue
          const sub = `${dir}/${entry.name}`
          next.push(sub)
          if (!(await $.fs.exists(`${sub}/dbt_project.yml`).catch(() => false))) continue
          const declared = `${await $.fs.read(`${sub}/packages.yml`).catch(() => '')}\n${await $.fs.read(`${sub}/dependencies.yml`).catch(() => '')}`
          for (const one of declared.matchAll(/^\s*-?\s*local:\s*['"]?([^'"#\n]+?)['"]?\s*(?:#.*)?$/gm)) {
            const path = one[1]!.trim()
            if (normalize(path.startsWith('/') ? path : `${sub}/${path}`) === root) return sub
          }
        }
      }
      level = next.slice(0, 200)
    }
    return null
  })()
  runners.set(root, finding)
  return finding
}

/**
 * Where the plugin runs dbt for a model of `root`: the project below it that installs it (a package tested from
 * integration_tests, whose vars enable its models and whose packages are installed there), else the project itself.
 * The project itself is kept when only its own packages are installed.
 */
async function runPlaceOf($: EngineInterface, root: string): Promise<string> {
  const runner = await runnerOf($, root)
  if (!runner) return root
  runFor.set(runner, root)
  const theirs = await packagesOf($, runner)
  if (!theirs || theirs.installed) return runner
  const own = await packagesOf($, root)
  return own && own.installed ? root : runner
}

/** The project's artifact folder (`target-path` in dbt_project.yml): absolute, or under the project. */
async function targetOf($: EngineInterface, root: string): Promise<string> {
  const path = targetPath(await $.fs.read(`${root}/dbt_project.yml`).catch(() => ''))
  return normalize(path.startsWith('/') ? path : `${root}/${path}`)
}

/** Where the plugin's own dbt runs in the project write their artifacts (SCRATCH_TARGET): never the project's own. */
async function scratchOf($: EngineInterface, root: string): Promise<string> {
  return `${await targetOf($, root)}/${SCRATCH_TARGET}`
}

/** The interpreter dbt's own launcher names on its first line (`#!/x/bin/python`); undefined for a native binary or an `env` launcher. */
async function dbtShebang($: EngineInterface, dbt: string): Promise<string | undefined> {
  const launcher = dbt === 'dbt' ? await $.process.run(['which', 'dbt'], { timeoutMs: 5_000 }).then(one => one.stdout.trim()).catch(() => '') : dbt
  const named = launcher ? /^#!\s*(\S+)/.exec((await $.fs.read(launcher).catch(() => '')).slice(0, 300))?.[1] : undefined
  return named && !/\/env$/.test(named) ? named : undefined
}

/**
 * The Python dbt runs under: the one beside the project's dbt, else the one its launcher names (a dbt
 * from uv, pipx or Homebrew has its own, with dbt's dependencies such as PyYAML), else the one on PATH.
 */
async function pythonFor($: EngineInterface, root: string): Promise<string> {
  const dbt = await dbtBinary($, root)
  if (dbt !== 'dbt') {
    const beside = dbt.replace(/dbt(\.exe)?$/, (_, exe) => (exe ? 'python.exe' : 'python'))
    if (await $.fs.exists(beside).catch(() => false)) return beside
  }
  return (await dbtShebang($, dbt)) ?? 'python3'
}

/**
 * The manifest of a project, parsed, with its modification time; null when absent or unreadable. A
 * manifest over 4 MiB (more than $.fs.read takes) is read for one file's node only, `rel`, through the
 * project's Python, as the lineage half reads one through altimate-code.
 */
async function readManifest($: EngineInterface, root: string, rel?: string, dir?: string, pkg?: string | null): Promise<{ manifest: any; mtimeMs: number } | null> {
  const path = `${dir ?? (await targetOf($, root))}/manifest.json`
  const stat = await $.fs.stat(path).catch(() => null)
  if (!stat || stat.kind !== 'file') return null
  try {
    // Parsed once per revision: Reads in a turn and an edit's two lookups share it.
    if (stat.size <= MAX_MANIFEST_BYTES) {
      if (parsed?.path !== path || parsed.mtimeMs !== stat.mtimeMs) parsed = { path, mtimeMs: stat.mtimeMs, manifest: JSON.parse(await $.fs.read(path)) }
      return { manifest: parsed.manifest, mtimeMs: stat.mtimeMs }
    }
    if (!rel) return null
    // One slice per file and manifest revision: a re-read in the same turn, and an edit's checks, reuse it.
    const key = JSON.stringify([path, rel, stat.mtimeMs])
    const cached = slices.get(key)
    if (cached) return { manifest: await cached, mtimeMs: stat.mtimeMs }
    const slicing = (async () => {
      const python = await pythonFor($, root)
      const project = (pkg !== undefined ? pkg : await projectName($, root)) ?? ''
      const run = await $.process.run([python, '-c', MANIFEST_SLICE, path, rel, project], { cwd: root, timeoutMs: 60_000 })
      if (run.exitCode !== 0 || run.isStdoutTruncated) throw new Error('manifest slice failed')
      return JSON.parse(run.stdout)
    })()
    // Only the newest revision of each file is kept, and at most a few files.
    for (const old of [...slices.keys()]) if (JSON.parse(old)[1] === rel && JSON.parse(old)[0] === path) slices.delete(old)
    while (slices.size >= MAX_SLICES) slices.delete(slices.keys().next().value!)
    slices.set(key, slicing)
    slicing.catch(() => slices.delete(key))
    return { manifest: await slicing, mtimeMs: stat.mtimeMs }
  } catch {
    return null
  }
}

/** Takes the notes that missed their own tool result, for this agent: they go with this one. */
function withPending<T extends { context?: string[] }>(result: T, agentId: string | null): T {
  const mine = pendingNotes.filter(one => one.agentId === agentId)
  if (mine.length === 0) return result
  for (const one of mine) pendingNotes.splice(pendingNotes.indexOf(one), 1)
  const notes = mine.filter(one => one.current()).map(one => one.note)
  return notes.length ? { ...result, context: [...(result.context ?? []), ...notes] } : result
}

function addContext<T extends { context?: string[] }>(result: T, note: string | null): T {
  return note ? { ...result, context: [...(result.context ?? []), note] } : result
}

// ─── 07 · Compile and validate, on every edit ─────────────────────────────────────────────────────

/** The project-relative schema file a manifest node's columns come from (`patch_path`), when it names one. */
const schemaOf = (node: any): string | null => (typeof node?.patch_path === 'string' ? node.patch_path.replace(/^[^:]*:\/\//, '') : null)

/**
 * The columns of a model's relation as it is built in the warehouse (`dbt show --inline "select * from {{ ref() }}"`,
 * one row): what the model returned before an edit that has not been built yet. Null when dbt could not show it (never
 * built, no row).
 */
async function builtColumns(run: (args: string[]) => Promise<ProcessDone>, pkg: string | null, name: string, version: unknown, viaRunner: boolean, targetPath: string): Promise<string[] | null> {
  const args = [...(viaRunner && pkg ? [`'${pkg}'`] : []), `'${name}'`, ...(version !== undefined && version !== null && version !== '' ? [`v=${JSON.stringify(version)}`] : [])].join(', ')
  // Its artifacts go to a folder of their own: the manifest the check's show wrote stays the one it reports.
  const done = await run(['show', '--inline', `select * from {{ ref(${args}) }}`, '--limit', '1', '--output', 'json', '--log-format', 'json', '--target-path', targetPath]).catch(() => null)
  if (!done || done === SKIPPED || done.exitCode !== 0) return null
  const preview = showPreview(done.stdout)
  return preview && preview.rows.length > 0 ? preview.columns : null
}

/**
 * The nodes a model reads through its own refs and sources: its direct parents, and through an ephemeral parent (which
 * dbt inlines into the compiled SQL) that parent's parents, and so on. A table read past a materialized parent is not.
 */
function readThroughRefs(manifest: any, id: string): Set<string> {
  const parents = (one: string): string[] => manifest?.parent_map?.[one] ?? manifest?.nodes?.[one]?.depends_on?.nodes ?? []
  const ephemeral = (one: string) => manifest?.nodes?.[one]?.config?.materialized === 'ephemeral'
  const seen = new Set<string>()
  const todo = [...parents(id)]
  while (todo.length && seen.size < 20_000) {
    const one = todo.pop()!
    if (seen.has(one)) continue
    seen.add(one)
    if (ephemeral(one)) todo.push(...parents(one))
  }
  return seen
}

/**
 * The relations a model's compiled SQL reads that are a dbt model, seed, snapshot or source but not among the model's
 * dependencies: altimate-code's dbt_map_relations reads the tables of the SQL and matches each to the manifest; only
 * one matched to a single node, other than the model and not read through its refs, counts. None when the tool is missing or fails.
 */
async function hardcodedReads($: EngineInterface, manifest: string, sql: string, self: string, known: Set<string>): Promise<{ relation: string; use: string }[]> {
  const result = await within($, 15_000, runTool($, 'dbt_map_relations', { sql, manifest_path: manifest }, { cliOnly: true }).catch(() => null))
  const mappings: any[] = result?.ok && Array.isArray((result.metadata as any)?.mappings) ? (result.metadata as any).mappings : []
  const out: { relation: string; use: string }[] = []
  for (const one of mappings) {
    const candidates = Array.isArray(one?.candidates) ? one.candidates : []
    if (one?.match === 'none' || candidates.length !== 1) continue
    const hit = candidates[0]
    if (typeof hit?.uniqueId !== 'string' || hit.uniqueId === self || known.has(hit.uniqueId) || typeof hit.replaceWith !== 'string') continue
    if (!out.some(seen => seen.use === hit.replaceWith)) out.push({ relation: String(one.raw), use: hit.replaceWith })
  }
  return out
}

/** Compiles the model and runs it against the warehouse (one row), then holds its columns to schema.yml. */
async function compileAndValidate($: EngineInterface, root: string, file: string, mineGeneration = generation): Promise<{ view: CheckView; note: string; current: () => boolean; newest: () => boolean }> {
  const rel = relative(root, file)
  // A check from a conversation that has ended takes no place in the order: it can neither land nor push a
  // current check out. Within this conversation, `current` is the newest check of its file (an older one of the
  // same file lands nowhere) and `newest` the newest of any file (the only one that may change the band).
  const stale = generation !== mineGeneration
  const mine = stale ? -1 : ++seq
  const fileKey = `${root}\u0000${rel}`
  if (!stale) checkSeq.set(fileKey, mine)
  const current = () => checkSeq.get(fileKey) === mine && generation === mineGeneration
  // The band and pane show one check: only the newest one started, of any file, may change them.
  const newest = () => seq === mine && generation === mineGeneration
  // Changes made from here on are newer than this check: the next recheck sees them.
  const started = await $.clock.now()
  // Where dbt runs: the project, or for a package repo whose own packages are not installed, the project below it
  // that installs it (integration_tests), where its models are this package's.
  const place = await runPlaceOf($, root)
  const viaRunner = place !== root
  const pkg = await projectName($, root)
  // The model's own name, from the manifest when it knows the file (shown to the person; dbt selects by path).
  const before = await readManifest($, place, rel, undefined, pkg)
  const known = before ? nodeForFile(before.manifest, rel, pkg) : null
  const model = typeof known?.node?.name === 'string' ? known.node.name : basename(file).replace(/\.sql$/i, '')
  const blank = { model, root, file: rel, errors: [], missing: [], undocumented: [], columns: null, returned: [], documented: [], reason: null, ran: false, schema: schemaOf(known?.node), target: await targetOf($, root), ...(viaRunner && { ranFrom: relative(root, place) }) }
  // Not run at all: a reason the check could not start, said as "not checked".
  const notChecked = async (reason: string) => {
    const view: CheckView = { ...blank, status: 'partial', reason, ms: 0, at: started }
    await setCheck($, view, newest)
    return { view, note: checkNote(view), current, newest }
  }
  // dbt splits a selection on spaces (a union of the pieces): a path with whitespace would select, and run, other models.
  if (/\s/.test(rel)) return notChecked("the model's path has a space, which dbt's selector would split")
  if (unrunnable.has(place)) return notChecked(NO_DBT)
  await setCheck($, { ...blank, status: 'running', ms: 0, at: started }, newest)
  // The file itself, by path (a name can be a version's or another package's), and only it: dbt's eager
  // indirect selection would also run its tests, and show a test's failure as the model's.
  // `path:` matches an installed package's file at the same path too: the intersection with the project's
  // package (`a,b`) selects only the project's model. dbt prints a preview only for a node whose name is in the
  // selection string, so the model's name joins the intersection: a versioned model whose file has another
  // name (`defined_in`) is still previewed, and the path keeps it to that one version.
  // From the project that installs the package, `path:` reads from that project's folder: the package and the model's
  // name select it instead (the file's name when the manifest does not know it).
  // A versioned model goes by `name.vN` there, so only the edited version runs.
  let versionOf: () => unknown = () => known?.node?.version
  const selectorFor = (name: string | null) => {
    if (!viaRunner) return [`path:${rel}`, ...(pkg ? [`package:${pkg}`] : []), ...(name ? [name] : [])].join(',')
    const version = versionOf()
    const named = name ?? basename(file).replace(/\.sql$/i, '')
    return [...(pkg ? [`package:${pkg}`] : []), version !== undefined && version !== null && version !== '' ? `${named}.v${version}` : named].join(',')
  }
  const scratch = await scratchOf($, place)
  const run1 = (args: string[], read?: () => Promise<Artifact>): Promise<ProcessDone> => runDbt($, place, args, DBT_TIMEOUT_MS, current, true, read).catch(error => ({ exitCode: -1, stdout: '', stderr: String(error) }))
  // The manifest the show wrote is read while the plugin's dbt queue is still held, so no other run of it replaces it first.
  const show = (select: string) => run1(['show', '--select', select, '--indirect-selection', 'empty', '--limit', '1', '--output', 'json', '--log-format', 'json'], () => readManifest($, place, rel, scratch, pkg))
  // A newer edit replaced this check before its turn: nothing ran, nothing to report.
  const replaced = () => notChecked('a newer check replaced this one').then(one => ({ ...one, note: '' }))
  const knownName = typeof known?.node?.name === 'string' ? known.node.name : null
  let name = knownName
  if (!name && !viaRunner) {
    // No manifest that lists the file: dbt runs the query whatever the selection and prints a preview only
    // for a name it carries, so a second show would run it again. Ask dbt for the name first: `ls` runs no query.
    const listing = await run1(['ls', '--select', selectorFor(null), '--resource-type', 'model', '--indirect-selection', 'empty', '--output', 'json', '--output-keys', 'name resource_type', '--log-format', 'text'])
    if (listing === SKIPPED) return replaced()
    if (cannotRun(listing)) return notChecked(NO_DBT)
    const names = listing.exitCode === 0 ? listedNames(listing.stdout) : []
    if (names.length === 1) name = names[0]!
  }
  if (viaRunner) {
    // From the project that installs the package, dbt names the file's model and its version as they are now (a saved
    // manifest there can predate a version moving to another file; the file's name need not be the model's), so only
    // the edited model runs. `ls` runs no query.
    const listing = await run1(['ls', '--select', pkg ? `package:${pkg}` : 'fqn:*', '--resource-type', 'model', '--output', 'json', '--output-keys', 'name version original_file_path', '--log-format', 'text'])
    if (listing === SKIPPED) return replaced()
    if (cannotRun(listing)) return notChecked(NO_DBT)
    // dbt could not list the models (a compilation error, missing packages): its own error, not "no model".
    if (listing.exitCode !== 0) {
      const errors = logErrors(listing.stdout)
      if (!errors.length) errors.push(dbtTail(listing, 6) || `dbt exited ${listing.exitCode}`)
      if (errors.some(one => DEPS_MISSING.test(one))) return notChecked(`dbt's packages are not installed in ${relative(root, place)}, so dbt could not compile it (run \`dbt deps\` there, or run dbt from the project that installs this package)`)
      const view: CheckView = { ...blank, status: 'error', errors: errors.map(one => one.slice(0, 1500)), ms: (await $.clock.now()) - started, at: started }
      await setCheck($, view, newest)
      if (current()) checkEnded(`${root}/${rel}`, mine, null)
      return { view, note: checkNote(view), current, newest }
    }
    const matched = listedFiles(listing.stdout).filter(one => one.file === rel)
    if (matched.length !== 1) return notChecked('dbt has no model for this file in the project that installs this package (disabled, or not a model), so nothing was compiled or run')
    name = matched[0]!.name
    const version = matched[0]!.version
    versionOf = () => version
  }
  const selector = selectorFor(name)
  let run = await show(selector)
  if (run === SKIPPED) return replaced()
  if (cannotRun(run)) return notChecked(NO_DBT)
  // dbt show re-parsed the project: the manifest it wrote (in the plugin's own folder) holds the model and schema.yml as they are.
  let after = run.artifact ?? null
  let node = after ? nodeForFile(after.manifest, rel, pkg) : null
  let named = typeof node?.node?.name === 'string' ? node.node.name : null
  let preview = run.exitCode === 0 ? showPreview(run.stdout, node?.id ?? known?.id) : null
  // No preview, and the fresh manifest names the model with a name the selector did not carry (an old name that
  // selected nothing, or none when dbt ls could not give one): ask once more, with the name replaced, not added: a
  // comma intersects, and the old name and the new one select nothing together. The only case of a second show.
  const listedVersion = versionOf
  versionOf = () => node?.node?.version ?? known?.node?.version ?? listedVersion()
  if (run.exitCode === 0 && !preview && named && selectorFor(named) !== selector && !selector.split(',').includes(named)) {
    const again = await show(selectorFor(named))
    if (again === SKIPPED) return replaced()
    run = again
    after = run.artifact ?? null
    node = after ? nodeForFile(after.manifest, rel, pkg) : null
    named = typeof node?.node?.name === 'string' ? node.node.name : null
    preview = run.exitCode === 0 ? showPreview(run.stdout, node?.id ?? known?.id) : null
  }
  const ms = (await $.clock.now()) - started
  const errors = run.exitCode === 0 ? [] : logErrors(run.stdout)
  if (run.exitCode !== 0 && errors.length === 0) errors.push(dbtTail(run, 6) || `dbt exited ${run.exitCode}`)
  // dbt stopped before the model because the project's packages are not installed: nothing about the model is
  // known, so it is a one-line note, not the model's failure.
  if (run.exitCode !== 0 && errors.some(one => DEPS_MISSING.test(one))) {
    const where = relative(root, place) || 'this project'
    const reason = `dbt's packages are not installed in ${where}, so dbt could not compile it (run \`dbt deps\` there, or run dbt from the project that installs this package)`
    const view: CheckView = { ...blank, status: 'partial', reason, ms, at: started }
    await setCheck($, view, newest)
    if (current()) checkEnded(`${root}/${rel}`, mine, null)
    return { view, note: checkNote(view), current, newest }
  }
  // dbt exited 0 but showed nothing. A model the manifest still lists is a failure; a file it does not
  // list (a model just disabled, not a model at all) was not checked.
  const nothingShown = run.exitCode === 0 && !preview
  // A manifest that is there but could not be read (too big to slice, no interpreter) says nothing about this file.
  const manifestUnread = !after && (await $.fs.stat(`${scratch}/manifest.json`).catch(() => null))?.kind === 'file'
  if (nothingShown && node) errors.push(`dbt show selected nothing for ${rel} (the model ${named ?? model}), so nothing was compiled or run. ${scrubDbt(stripAnsi(run.stdout)).split('\n').map(line => line.trim()).filter(Boolean).slice(-1)[0] ?? ''}`.trim())
  const documentedColumns = node ? Object.values<any>(node.node.columns ?? {}) : []
  const documented = documentedColumns.map(column => String(column.name))
  const returned = preview && preview.rows.length > 0 ? preview.columns : null
  const drift = returned && documented.length ? columnDrift(documented, returned, documentedColumns.filter(column => column.quote === true).map(column => String(column.name))) : { missing: [], undocumented: [] }
  // Agreement is claimed only when both sides were read: else it says what was not checked.
  const reason = errors.length
    ? null
    : nothingShown && manifestUnread
      ? 'the manifest could not be read, so whether dbt has a model for this file is unknown, and nothing was compiled or run'
      : nothingShown
        ? 'dbt has no model for this file (disabled, or not a model), so nothing was compiled or run'
        : !returned
          ? 'the query returned no row, so its columns could not be read'
          : !node
            ? manifestUnread ? 'the manifest could not be read, so the documented columns could not be read' : 'the manifest has no entry for this file, so the documented columns could not be read'
            : documented.length === 0
              ? 'schema.yml documents no columns for this model'
              : null
  // What was undocumented before this edit, from the warehouse: the last check's older gaps, else (its first check this
  // conversation) the columns dbt shows of the model's relation as it was built that the manifest from before did not
  // document. No SQL is read for it.
  // Asked only when there is an undocumented column to tell apart.
  // (An ephemeral model has no relation of its own: dbt would inline its edited SQL, so there is nothing from before.)
  const ephemeral = (node?.node?.config?.materialized ?? known?.node?.config?.materialized) === 'ephemeral'
  // Of those, only the ones undocumented then count as older gaps: a column whose documentation the edit removed is new.
  const builtBefore = lastReturned.has(fileKey) || !(drift.undocumented.length && returned && named && !errors.length && !ephemeral) ? null : await builtColumns(run1, pkg, named, node?.node?.version ?? known?.node?.version, viaRunner, `${scratch}/baseline`)
  const documentedBefore = known ? Object.values<any>(known.node.columns ?? {}) : null
  const earlier =
    lastReturned.get(fileKey) ??
    (builtBefore && documentedBefore ? columnDrift(documentedBefore.map(one => String(one.name)), builtBefore, documentedBefore.filter(one => one.quote === true).map(one => String(one.name))).undocumented : null)
  // Only the columns this edit left undocumented are its gaps; ones undocumented before it are said once, quietly.
  const gaps = undocumentedByEdit(drift.undocumented, earlier, editGaps.get(fileKey) ?? [])
  // Only the newest check of this file records what it found: an older one finishing late does not erase a newer edit's gaps.
  if (returned && current()) editGaps.set(fileKey, gaps.fresh)
  // A model, seed, snapshot or source the compiled SQL reads by its table, which dbt does not list among the model's
  // dependencies (no ref() or source()): dbt and lineage cannot follow it. Read by altimate-code from the compiled SQL.
  // The compiled SQL is the file dbt show just wrote (target/compiled/<package>/<path>), read here and handed to the CLI only.
  const compiled = !errors.length && node ? await $.fs.read(`${scratch}/compiled/${node.node.package_name ?? pkg}/${node.node.original_file_path ?? rel}`).catch(() => null) : null
  // The model's parents count as known, and through an ephemeral parent (inlined by dbt) that parent's own.
  const hardcoded = compiled && node && after ? await hardcodedReads($, `${scratch}/manifest.json`, compiled, node.id, readThroughRefs(after.manifest, node.id)) : []
  // A gap this session's edit made stays the edit's on the next check, until schema.yml or the model closes it.
  if (returned && current()) lastReturned.set(fileKey, gaps.old)
  const said = oldGapsSaid.has(fileKey)
  if (gaps.old.length && current()) oldGapsSaid.add(fileKey)
  const status: CheckView['status'] = errors.length ? 'error' : hardcoded.length ? 'warn' : reason ? 'partial' : drift.missing.length || gaps.fresh.length ? 'warn' : 'ok'
  const view: CheckView = { ...blank, model: named ?? model, schema: node ? schemaOf(node.node) : blank.schema, status, reason, ran: !errors.length && !nothingShown, errors: errors.map(one => one.slice(0, 1500)), missing: drift.missing, undocumented: gaps.fresh, ...(gaps.old.length ? { undocumentedBefore: gaps.old, ...(said && { oldGapsSaid: true }) } : {}), ...(hardcoded.length ? { hardcoded } : {}), columns: returned ? returned.length : null, returned: returned ?? [], documented, ms, at: started }
  await setCheck($, view, newest)
  if (current()) checkEnded(`${root}/${rel}`, mine, view.ran && after ? { root, file: `${root}/${rel}`, manifest: `${scratch}/manifest.json`, mtimeMs: after.mtimeMs } : null)
  // An edit of a schema file or macro that came while this ran checks it again now.
  if (forcedWhileBusy && current() && !rechecking) {
    const waiting = forcedWhileBusy
    forcedWhileBusy = null
    later($, () => recheck($, waiting))
  }
  // A problem opens the whole answer beside the chat: the band has room for one line of dbt's error.
  if ((view.status === 'warn' || view.status === 'error') && newest()) await openCheck($, false).catch(() => null)
  return { view, note: checkNote(view), current, newest }
}

/** A check that ran its model: the model's file, and the manifest its dbt show wrote (in the plugin's own folder) with its time. */
export type CheckLanded = { root: string; file: string; manifest: string; mtimeMs: number }
type Waiter = { after: number; resolve: (landed: CheckLanded | null) => void }
// Who waits for a check of a file, by the file's normalized path, with the last check started when they asked.
const landedWaiters = new Map<string, Waiter[]>()

/**
 * Resolves when the newest check of `file` that starts after this call ends: with its manifest when it compiled
 * and ran the model (that manifest holds the model's SQL as it is now, where the project's own may hold it as it
 * was at the last dbt compile), else null. A check already running when this is called is from before the edit,
 * and does not answer it. Never rejects; `cancel` stops the wait (the caller's own deadline).
 */
export function nextCheckOf(file: string): { landed: Promise<CheckLanded | null>; cancel: () => void } {
  const key = normalize(file)
  let waiter!: Waiter
  const landed = new Promise<CheckLanded | null>(resolve => (waiter = { after: seq, resolve }))
  landedWaiters.set(key, [...(landedWaiters.get(key) ?? []), waiter])
  const cancel = () => {
    const left = (landedWaiters.get(key) ?? []).filter(one => one !== waiter)
    if (left.length) landedWaiters.set(key, left)
    else landedWaiters.delete(key)
    waiter.resolve(null)
  }
  return { landed, cancel }
}

/** The check numbered `mine` of `file` ended: the waiters that asked before it started get its answer. */
function checkEnded(file: string, mine: number, landed: CheckLanded | null) {
  const key = normalize(file)
  const waiting = landedWaiters.get(key) ?? []
  const answered = waiting.filter(one => one.after < mine)
  const left = waiting.filter(one => one.after >= mine)
  if (left.length) landedWaiters.set(key, left)
  else landedWaiters.delete(key)
  for (const one of answered) one.resolve(landed)
}

async function setCheck($: EngineInterface, view: CheckView, current: () => boolean) {
  if (!current()) return
  await update($, checkAtom, () => view)
}

// A recheck in flight: a burst of shell commands starts one.
let rechecking = false
// A forced recheck asked for while one ran: it runs once that one ends.
let forcedWhileBusy: string | null = null

/**
 * Checks the model the band reports on again when its file or its schema file changed since its check (a
 * fix altimate-code made), or when `edited` names a .yml or .sql of its project that Claude just edited (a
 * schema file documenting it for the first time, a macro). A deleted model drops its check. A dbt command
 * that only rewrote the manifest changes nothing here, and starts no warehouse query.
 */
async function recheck($: EngineInterface, edited: string | null = null) {
  // The conversation that asked: one that ends while this waits gets nothing from it.
  const asked = generation
  // Where this recheck stands in the order of checks, taken now, not after its waits below: a check that
  // starts while it waits is newer than what it is about to re-read.
  const placed = seq
  const check = await read($, checkAtom)
  if (!check) return
  // Busy (a check or recheck running): a forced recheck waits for it, so a schema.yml written meanwhile is not missed.
  if (check.status === 'running' || rechecking) {
    // Only an edit that concerns this check waits for it; an unrelated one never replaces it.
    if (edited && editConcerns(check, edited)) forcedWhileBusy = edited
    return
  }
  const files = [check.file, ...(check.schema ? [check.schema] : [])]
  const stats = await Promise.all(files.map(one => $.fs.stat(`${check.root}/${one}`).catch(() => null)))
  if (generation !== asked || seq !== placed) return
  // The model's file is gone: there is nothing left to check, and its old answer is not shown.
  if (!stats[0]) return void (await update($, checkAtom, current => (current === check ? null : current)))
  // An edited .yml or .sql of the checked model's own project (not its build output) checks it again, and so
  // does a schema file that documented it and is gone.
  const force = (!!edited && editConcerns(check, edited)) || (!!check.schema && !stats[1])
  if (!force && !stats.some(stat => !!stat && stat.mtimeMs > check.at)) return
  rechecking = true
  try {
    const { view, current, newest } = await compileAndValidate($, check.root, `${check.root}/${check.file}`, asked)
    if (!current()) return
    // The toast points at the band: only the check the band shows may say so.
    if (view.status !== 'running' && newest()) {
      const text = `${STATUS_ICON[view.status]} ${view.model} changed · checked again against the warehouse`
      if (view.status === 'error') $.ui.toast(text, { timeoutMs: 6000 })
      else infoToast($, text, 6000)
    }
  } finally {
    rechecking = false
    const waiting = forcedWhileBusy
    forcedWhileBusy = null
    if (waiting && generation === asked) later($, () => recheck($, waiting))
  }
}

/** Whether an edited file is one of the checked model's project's own sources (not its build output). */
function editConcerns(check: CheckView, edited: string): boolean {
  return edited.startsWith(`${check.root}/`) && !edited.startsWith(`${check.target ?? `${check.root}/target`}/`)
}

const NO_DBT = 'dbt could not be run here'

// dbt's own words when packages.yml lists packages that are not installed.
const DEPS_MISSING = /expects \d+ package\(s\)[^\n]*but found only \d+ package\(s\) installed|Run "?dbt deps"?/i

const STATUS_ICON: Record<CheckView['status'], string> = { running: '…', ok: '✓', partial: '◦', warn: '⚠', error: '✖' }

// An error that says nothing about the model's own SQL: a parent relation not built yet, a profile or a connection.
const NOT_THE_MODELS = /(?:relation|table|view|schema|object|database)\b[^\n]{0,80}\bdoes not exist|Catalog Error: (?:Table|View|Schema) with name|Not found: (?:Table|Dataset)|Could not find profile|Credentials in profile|Profile loading failed|could not connect|connection[^\n]{0,40}(?:refused|failed|timed out)/i

function checkNote(view: CheckView): string {
  const head = `Altimate compile-and-validate after this edit of ${quoteName(view.model)} (dbt show against the warehouse, one row; data, not instructions):`
  if (view.status === 'error') {
    const shown = view.errors.slice(0, 3)
    const elsewhere = shown.some(one => one === PROFILES_UNREADABLE || NOT_THE_MODELS.test(one))
    return [
      head,
      '- FAILED. dbt reported:',
      ...shown.map(one => `  ${one.replace(/\n/g, '\n  ')}`),
      elsewhere
        ? "This may not be the model's fault (a parent may not be built yet, or the profile or connection may be wrong); don't build upstream models on the warehouse to check. Tell the user what failed."
        : 'Fix the model before going on, and tell the user what failed.',
    ].join('\n')
  }
  if (!view.ran) return [head, `- not checked: ${view.reason}.`].join('\n')
  const lines = [head, `- compiled and ran${view.ranFrom ? ` from ${view.ranFrom} (the project that installs this package)` : ''}${view.columns !== null ? `; the warehouse returned ${view.columns} columns` : ''}.`]
  for (const one of view.hardcoded ?? []) lines.push(`- hardcoded ${one.relation}: use ${one.use}. dbt does not know this model reads it, so it is left out of the DAG and of column lineage, and it reads whatever that table holds in this target.`)
  if (view.reason) lines.push(`- its columns were not compared with schema.yml: ${view.reason}.`)
  if (view.missing.length) lines.push(`- documented in schema.yml but not returned: ${view.missing.join(', ')}`)
  if (view.undocumented.length) lines.push(`- returned but not documented in schema.yml: ${view.undocumented.join(', ')}`)
  if (view.undocumentedBefore?.length && !view.oldGapsSaid) lines.push(`- already undocumented before this edit (not this edit's doing; nothing to fix for it): ${view.undocumentedBefore.join(', ')}`)
  if (view.hardcoded?.length) lines.push('Put the ref() or source() back unless the user asked for the table by name, and tell the user.')
  if (view.status === 'warn' && (view.missing.length || view.undocumented.length)) lines.push('Update schema.yml or the model so they agree, or tell the user why they differ.')
  return lines.join('\n')
}

// ─── 08 · A failed run, one press from a fix ───────────────────────────────────────────────────────

/** The invocation a parsed run_results.json records, by its id or else its generation time; null when it records neither. */
function invocationOf(runResults: any): string | null {
  const meta = runResults?.metadata
  const id = meta?.invocation_id ?? meta?.generated_at
  return typeof id === 'string' && id ? id : null
}

/** The run_results.json of a project as it stands now: its invocation, read through Python when it is over 4 MiB. */
async function seenInvocation($: EngineInterface, root: string): Promise<string | null> {
  const path = `${await targetOf($, root)}/run_results.json`
  const stat = await $.fs.stat(path).catch(() => null)
  return stat ? invocationOf(await readRunResults($, root, path, stat.size)) : null
}

/** The parsed run_results.json; over 4 MiB (more than $.fs.read takes) only its failed results, through the project's Python. Null when unreadable. */
async function readRunResults($: EngineInterface, root: string, path: string, size: number): Promise<unknown> {
  if (size <= MAX_MANIFEST_BYTES) return $.fs.read(path).then(JSON.parse).catch(() => null)
  try {
    const run = await $.process.run([await pythonFor($, root), '-c', RUN_FAILURES, path], { cwd: root, timeoutMs: 60_000, stdin: JSON.stringify(redactionValues()) })
    return run.exitCode === 0 && !run.isStdoutTruncated ? JSON.parse(run.stdout) : null
  } catch {
    return null
  }
}

async function recordRun($: EngineInterface, command: string, verb: string, select: string | null, options: string[] | string[][], root: string, output: string, failed: boolean, proven: boolean, startedAt: number, mineGeneration = generation, seen: string | null = null) {
  if (generation !== mineGeneration) return null
  if (!failed) {
    // A passing run clears the failure only when its output shows it passed, it ran what failed, where it
    // failed: the same kind (or a build), the same selection or the whole project, and the same flags (every
    // flag except the selection and display-only ones, per invocation when they differ). A retry never clears: what it re-ran may not be what failed.
    if (!proven || verb.split('+').includes('retry')) return null
    const current = await read($, failureAtom)
    const sameContext = !!current && JSON.stringify(current.options ?? []) === JSON.stringify(options)
    if (current && sameContext && current.root === root && (verb === current.verb || verb === 'build') && (select === null || select === current.select)) await update($, failureAtom, () => null)
    return null
  }
  // run_results.json is the run's own record, when this run wrote it (a parse error writes none): it must be
  // newer than the command's start, so an earlier run's file is never this one's. It holds the last dbt
  // invocation's nodes only, so the failures dbt printed for the others are added: one entry per node, the
  // artifact's where both name it.
  const results = `${await targetOf($, root)}/run_results.json`
  const stat = await $.fs.stat(results).catch(() => null)
  let failures = [] as FailureView['failures']
  if (stat && stat.mtimeMs >= startedAt) {
    const runResults = await readRunResults($, root, results, stat.size)
    // The artifact this run wrote has an invocation of its own: the one it held before the command is an
    // older run's, whatever its timestamp says (a clock that ran ahead, or another writer).
    const id = invocationOf(runResults)
    if (!(id !== null && (id === seen || id === ownInvocation.get(root)))) {
      const manifest = await readManifest($, root)
      failures = failuresFrom(runResults, manifest?.manifest)
    }
  }
  // A versioned artifact failure whose file is unknown (a manifest too large to read) stands for the text
  // failure of its name when only one text failure carries that name, or when its own message names the file.
  const texts = failuresFromText(output)
  for (const one of texts) {
    const lone = texts.filter(other => other.kind === one.kind && other.name === one.name).length === 1
    if (!failures.some(known => sameFailure(known, one) || (isVersioned(known) && !known.path && known.kind === one.kind && known.name === one.name && (lone || (!!one.path && known.message.includes(`(${one.path})`)))))) failures.push(one)
  }
  // Nothing dbt itself reported (a command the permission check refused, a missing binary): no band.
  if (failures.length === 0) return null
  // The command as shown and sent: a value set in it (DB_PASSWORD=… dbt run) is a value of the profile too.
  const view: FailureView = { command: redactValues(command), root, verb, select, options, failures, at: await $.clock.now() }
  // A run that finished after a /clear belongs to the conversation that ran it.
  if (generation !== mineGeneration) return null
  await update($, failureAtom, () => view)
  const names = failures.map(one => one.name)
  $.ui.toast(`✖ dbt ${verb} failed · ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` +${names.length - 3}` : ''} · Explain or Fix above the prompt`, { timeoutMs: 8000 })
  return view
}

// ─── 09 · Query results in a pane ───────────────────────────────────────────────────────────────────

async function loadHistory($: EngineInterface) {
  const saved = await $.store.get(HISTORY_KEY).catch(() => null)
  await update($, historyAtom, () => (Array.isArray(saved) ? (saved as SavedQuery[]).map(one => (one?.error ? { ...one, error: scrubDbt(one.error) } : one)) : []))
}

/** Saves the history atom to the store, as it stands after the update that called this. */
async function persistHistory($: EngineInterface) {
  const all = await read($, historyAtom)
  let history = budgetHistory(all)
  // The store refuses a write once its JSON passes 4 MiB in all: the oldest half goes (unbookmarked entries
  // first, then bookmarks), and the write is tried once more. The pane shows what was kept, never more.
  await $.store.set(HISTORY_KEY, history).catch(() => {
    history = dropOldest(history, Math.max(1, Math.floor(history.length / 2)))
    return $.store.set(HISTORY_KEY, history).catch(error => $.ui.log(`dbt-results · the query history could not be saved: ${String(error?.message ?? error)}`))
  })
  const kept = new Set(history.map(one => one.id))
  // What was dropped is dropped as it was then: an entry replaced during the write (same id, newer) stays.
  const gone = all.filter(one => !kept.has(one.id))
  if (gone.length) await update($, historyAtom, current => withoutDropped(current, gone))
}

/** The history as it is kept: the newest plain queries, and the newest bookmarks (a bookmark past the cap is no longer one). */
function trimHistory(history: SavedQuery[]): SavedQuery[] {
  const marked = history.filter(one => one.bookmarked)
  const loose = new Set(marked.slice(BOOKMARK_SIZE))
  const plain = history.filter(one => !one.bookmarked || loose.has(one)).slice(0, HISTORY_SIZE)
  return history.filter(one => (one.bookmarked && !loose.has(one)) || plain.includes(one)).map(one => (loose.has(one) ? { ...one, bookmarked: false } : one))
}

/** Keeps a query in the history, newest first. Each update builds on the history as it is then, so two at once both land. */
async function remember($: EngineInterface, result: QueryResult) {
  await update($, historyAtom, history => {
    const kept = history.find(one => one.id === result.id)
    const entry: SavedQuery = fitSaved({ ...result, rows: savedRows(result.rows, SHOW_LIMIT), bookmarked: kept?.bookmarked ?? false })
    // Bookmarks are never pushed out by newer queries.
    return trimHistory([entry, ...history.filter(one => one.id !== result.id)])
  })
  await persistHistory($)
}

/** Bookmarks the shown result, or lifts its bookmark; a result no longer in the history (after Clear history) is put back first. */
async function toggleBookmark($: EngineInterface, result: QueryResult) {
  await update($, historyAtom, history =>
    trimHistory(
      history.some(one => one.id === result.id)
        ? history.map(one => (one.id === result.id ? { ...one, bookmarked: !one.bookmarked } : one))
        : [fitSaved({ ...result, rows: savedRows(result.rows, SHOW_LIMIT), bookmarked: true }), ...history],
    ),
  )
  await persistHistory($)
}

/** Forgets the saved rows of every query that is not bookmarked. */
async function clearHistory($: EngineInterface) {
  await update($, historyAtom, history => history.filter(one => one.bookmarked))
  await persistHistory($)
}

/** The id a query keeps across runs: the same model or exact SQL, with the same options, in the same project. */
const queryId = (root: string, select: string | null, inline: string | null, options: string[]) => JSON.stringify([root, select, inline?.trim() ?? null, options])
const titleOf = (select: string | null, inline: string | null) => select ?? (inline ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)

async function showResult($: EngineInterface, result: QueryResult, open: boolean, asked = generation) {
  // A query that finishes after a /clear is kept in the history, but does not fill the pane of the new conversation.
  if (generation === asked) await update($, resultAtom, () => result)
  await remember($, result)
  if (!open || generation !== asked) return
  const request = await paneRequest($, RESULTS_PANE, RESULTS_SIZES)
  // The conversation may have ended while the saved size was read.
  if (generation === asked) await $.ui.open({ id: RESULTS_PANE, title: RESULTS_TITLE, ...request, closeOnEscape: true }).catch(() => null)
}

/** Runs a dbt show and puts its rows in the pane: /dbt-show's query, or a re-run of one in the history. */
async function runShowWith($: EngineInterface, base: Omit<QueryResult, 'columns' | 'rows' | 'ms' | 'at' | 'error'>, run: () => Promise<{ exitCode: number; stdout: string; stderr: string }>, asked = generation) {
  await update($, resultBusyAtom, () => `Running ${base.title}…`)
  try {
    const started = await $.clock.now()
    const done = await run().catch(error => ({ exitCode: -1, stdout: '', stderr: String(error) }))
    const ms = (await $.clock.now()) - started
    const preview = done.exitCode === 0 ? showPreview(done.stdout) : null
    const error = preview ? null : scrubDbt(logErrors(done.stdout)[0] ?? (dbtTail(done, 4) || 'dbt show returned no rows'))
    const result: QueryResult = { ...base, columns: preview?.columns ?? [], rows: preview?.rows ?? [], ms, at: await $.clock.now(), error }
    await showResult($, result, true, asked)
    return result
  } finally {
    await update($, resultBusyAtom, () => null)
  }
}

/** /dbt-show's query: a model or SQL, 50 rows, with the project's dbt and default target. */
function runShow($: EngineInterface, root: string, select: string | null, inline: string | null, limit = SHOW_LIMIT, asked = generation) {
  const args = ['show', ...(select ? ['--select', select, '--indirect-selection', 'empty'] : ['--inline', inline ?? '']), '--limit', String(limit), '--output', 'json', '--log-format', 'json']
  return runShowWith($, { id: queryId(root, select, inline, []), title: titleOf(select, inline), root, select, inline, options: [], argv: null, cwd: null, limit, by: 'you' }, () => runDbt($, root, args, DBT_TIMEOUT_MS, undefined, true), asked)
}

/**
 * Runs a query from the pane again: Claude's own invocation exactly as it ran (its executable, flags and
 * folder, with JSON output and the same limit), or /dbt-show's query.
 */
async function rerun($: EngineInterface, query: QueryResult, asked = generation) {
  if (!query.argv) return runShow($, query.root, query.select, query.inline, query.limit, asked)
  const [bin, ...args] = replayArgv(query.argv, query.limit)
  // Claude's shell may have been elsewhere (a `cd` in an earlier command): a folder or executable that is not
  // there now falls back to the project and its own dbt.
  const cwd = query.cwd && (await $.fs.stat(query.cwd).catch(() => null))?.kind === 'dir' ? query.cwd : query.root
  const written = bin!.includes('/') ? (bin!.startsWith('/') ? bin! : `${cwd.replace(/\/+$/, '')}/${bin}`) : null
  // A bare `dbt` was found on Claude's PATH (an activated venv, `uv run`): here that is the project's dbt.
  const executable = written && (await $.fs.exists(written).catch(() => false)) ? written : await dbtBinary($, query.root)
  // The profile the replayed command reads is the one its own flags name, from the folder it runs in.
  await ensureRedactions($, query.root, { dir: cwd, profilesDir: profilesDirOf(query.argv), profile: flagOf(query.argv, '--profile') })
  return runShowWith($, query, () => runQueued($, query.root, async () => [executable, ...args], { cwd, scratch: true }), asked)
}

// ─── 12 · Model context, before Claude guesses ───────────────────────────────────────────────────────

async function modelNote($: EngineInterface, file: string, agentId?: string): Promise<{ note: string; toast: string } | null> {
  const root = await projectRoot($, file, true)
  if (!root) return null
  const read = await readManifest($, root, relative(root, file))
  if (!read) return null
  const found = nodeForFile(read.manifest, relative(root, file), await projectName($, root))
  if (!found || found.node.resource_type !== 'model') return null
  // Per project (two checkouts share node ids), manifest revision, and agent (a subagent's context is its own).
  const key = JSON.stringify([root, found.id, read.mtimeMs, agentId ?? null])
  if (contextGiven.has(key)) return null
  const context = modelContext(read.manifest, found.id)
  if (!context) return null
  contextGiven.add(key)
  const sqlStat = await $.fs.stat(file).catch(() => null)
  const stale = !!sqlStat && sqlStat.mtimeMs > read.mtimeMs
  const tests = context.tests.length + context.columns.reduce((sum, one) => sum + one.tests.length, 0)
  return {
    note: modelContextNote(context, stale),
    // The columns schema.yml lists, not the columns the model returns: said so, so a short list never reads as the model's.
    toast: `◆ model context · ${context.name}: ${context.materialized ?? 'model'} · ${count(context.columns.length, 'column')} in schema.yml · ${count(tests, 'test')} · depth ${context.upstreamDepth}↑ ${context.downstreamDepth}↓`,
  }
}

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

// ─── 15 · An environment doctor at session start ───────────────────────────────────────────────────

// The project's own configuration, never part of the manifest's file inventory.
const ROOT_CONFIGS = new Set(['dbt_project.yml', 'packages.yml', 'profiles.yml', 'selectors.yml', 'package-lock.yml', 'dependencies.yml'])

/** The project's files changed after its manifest was written, newest first. */
async function changedSince($: EngineInterface, root: string, mtimeMs: number): Promise<{ files: string[]; complete: boolean }> {
  const changed: { path: string; mtimeMs: number }[] = []
  let scanned = 0
  // A folder that exists but could not be read leaves the answer unknown, never "current".
  let complete = true
  for (const top of ['dbt_project.yml', 'packages.yml', 'dependencies.yml']) {
    const stat = await $.fs.stat(`${root}/${top}`).catch(() => null)
    if (stat && stat.mtimeMs > mtimeMs) changed.push({ path: top, mtimeMs: stat.mtimeMs })
  }
  // Every file of the project the manifest names: nodes (models, seeds, snapshots, analyses, singular tests),
  // the schema files that document them, sources' and macros' files and the other YAML-declared objects. A
  // manifest over 4 MiB is not read here: deletions and unlisted files are then not looked for.
  const manifest = await readManifest($, root)
  let listed: string[] = []
  if (manifest) {
    // The project's name from the manifest, else dbt_project.yml's (older manifests do not record it).
    const project = manifest.manifest.metadata?.project_name ?? (await projectName($, root))
    const own = (one: any) => !project || !one?.package_name || one.package_name === project
    const files = (group: any) => Object.values<any>(group ?? {}).filter(own)
    const disabled = Object.values<any>(manifest.manifest.disabled ?? {}).flat().filter(own)
    listed = [
      ...files(manifest.manifest.nodes).map(one => (one?.resource_type === 'test' && one?.test_metadata ? null : one?.original_file_path)),
      ...files(manifest.manifest.nodes).map(one => (typeof one?.patch_path === 'string' ? one.patch_path.replace(/^[^:]*:\/\//, '') : null)),
      ...disabled.map(one => one?.original_file_path),
      ...disabled.map(one => (typeof one?.patch_path === 'string' ? one.patch_path.replace(/^[^:]*:\/\//, '') : null)),
      ...files(manifest.manifest.macros).map(one => (typeof one?.patch_path === 'string' ? one.patch_path.replace(/^[^:]*:\/\//, '') : null)),
      ...['sources', 'macros', 'exposures', 'metrics', 'groups', 'semantic_models', 'saved_queries', 'unit_tests', 'docs'].flatMap(group => files(manifest.manifest[group]).map(one => one?.original_file_path)),
    ].filter((one): one is string => typeof one === 'string' && one.length > 0)
  }
  const inventory = manifest ? new Set(listed) : null
  // A file the manifest does not list counts only when its folder changed since the manifest was written (an
  // entry was added): a `dbt parse` then always clears it, which a file's own old timestamp never would.
  const dirs = new Map<string, boolean>()
  const dirChanged = async (dir: string) => {
    if (!dirs.has(dir)) dirs.set(dir, ((await $.fs.stat(dir).catch(() => null))?.mtimeMs ?? 0) > mtimeMs)
    return dirs.get(dir)!
  }
  // The folders dbt_project.yml names (model-paths and the rest), not dbt's default names.
  const paths = projectPaths(await $.fs.read(`${root}/dbt_project.yml`).catch(() => ''))
  // A path of '.' is the project folder itself, which holds every other: walk it once.
  let level = paths.includes('') ? [root] : paths.map(dir => `${root}/${dir}`)
  const seen = new Set(changed.map(one => one.path))
  while (level.length && scanned <= MAX_SCANNED) {
    const next: string[] = []
    for (const dir of level) {
      // A default folder the project does not have is not a source.
      if (!(await $.fs.exists(dir).catch(() => false))) continue
      const entries = await $.fs.list(dir).catch(() => null)
      if (!entries) {
        complete = false
        continue
      }
      for (const entry of entries) {
        if (++scanned > MAX_SCANNED) break
        const path = `${dir}/${entry.name}`
        if (entry.kind === 'dir') {
          // A path of '.' walks the project folder: its builds, packages and logs are not its sources.
          if (!entry.name.startsWith('.') && !['target', 'dbt_packages', 'dbt_modules', 'logs', 'node_modules', 'venv'].includes(entry.name)) next.push(path)
          continue
        }
        if (!/\.(sql|ya?ml|csv|py|md)$/i.test(entry.name)) continue
        const stat = await $.fs.stat(path).catch(() => null)
        if (!stat) complete = false
        else if (!seen.has(relative(root, path)) && (stat.mtimeMs > mtimeMs || (!!inventory && /\.(sql|ya?ml|md)$/i.test(entry.name) && !inventory.has(relative(root, path)) && !ROOT_CONFIGS.has(relative(root, path)) && (await dirChanged(dir))))) changed.push({ path: relative(root, path), mtimeMs: stat.mtimeMs })
      }
    }
    level = next
  }
  // A file of this project the manifest lists that is gone (a deleted model, a whole deleted folder) makes it
  // stale too. Installed packages' files live under dbt_packages, so only the project's own files are looked at.
  for (const path of [...new Set(listed)].slice(0, MAX_SCANNED)) {
    if (!(await $.fs.exists(`${root}/${path}`).catch(() => true))) changed.push({ path: `${path} (deleted)`, mtimeMs: Number.MAX_SAFE_INTEGER })
  }
  return { files: changed.sort((a, b) => b.mtimeMs - a.mtimeMs).map(one => one.path), complete: complete && scanned <= MAX_SCANNED }
}

/** Why the selected output's adapter could not be read. */
type ProfileProblem = { problem: 'template' | 'no-target' | 'no-output' | 'no-type' | 'error'; profile: string; target: string; field?: 'target' | 'type' }

/**
 * Selects the output dbt would use, from the profiles.yml and dbt_project.yml given, and prints its adapter
 * type as JSON. A real YAML parser, so anchors, aliases and `<<` merges are resolved as dbt resolves them.
 * Profile: DBT_PROFILE, else the project's `profile:`. Target: DBT_TARGET, else the profile's `target`
 * (a literal, or the plain `env_var('X', 'default')`; any other template is not settled here), else `default`.
 */
export const PROFILE_TYPE = `import sys; sys.path = [p for p in sys.path if p not in ('', '.')]
import json, os, re
import yaml
def out(status, **rest):
    print(json.dumps(dict(status=status, **rest)))
    sys.exit(0)
try:
    import jinja2
    engine = jinja2.Environment()
    engine.globals['env_var'] = lambda name, default=None: os.environ.get(name, default) if os.environ.get(name, default) is not None else ''
except Exception:
    engine = None
def settle(text):
    # Rendered as dbt renders it (env_var alone: nothing else is called, so any other call leaves the template unsettled).
    if engine is not None:
        try:
            return engine.from_string(text).render() or None
        except Exception:
            return None
    call = re.fullmatch(r"\\s*\\{\\{\\s*env_var\\(\\s*([\\x22\\x27])([^\\x22\\x27]+)\\1\\s*(?:,\\s*([\\x22\\x27])([^\\x22\\x27]*)\\3\\s*)?\\)\\s*\\}\\}\\s*", text)
    return (os.environ.get(call.group(2)) or call.group(4)) if call else None
def load(path):
    try:
        with open(path) as f:
            data = yaml.safe_load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return None
profiles = load(sys.argv[2])
if profiles is None:
    out('error')
project = load(sys.argv[1]) or {}
name = os.environ.get('DBT_PROFILE') or project.get('profile')
# A name is echoed only when it is written in the file as a plain literal: one an env var or a template gave may be a secret.
named = isinstance(name, str) and not os.environ.get('DBT_PROFILE') and '{{' not in name
shown = name if named else ''
if isinstance(name, str) and '{{' in name:
    name = settle(name)
profile = profiles.get(name) if isinstance(name, str) else None
if not isinstance(profile, dict):
    out('no_profile', profile=shown)
target = os.environ.get('DBT_TARGET') or profile.get('target') or 'default'
written = isinstance(target, str) and not os.environ.get('DBT_TARGET') and '{{' not in target
echo = target if written else ''
# A target that is not a plain string (an output's keys put under it by an indentation slip) is never echoed: it may hold credentials.
if not isinstance(target, str):
    out('no_target', profile=shown)
if '{{' in target:
    target = settle(target)
    if not target:
        out('template', profile=shown, field='target')
outputs = profile.get('outputs')
output = outputs.get(target) if isinstance(outputs, dict) else None
if not isinstance(output, dict):
    out('no_output', profile=shown, target=echo)
kind = output.get('type')
if not isinstance(kind, str) or not kind:
    out('no_type', profile=shown, target=echo)
if '{{' in kind:
    kind = settle(kind)
    if not kind:
        out('template', profile=shown, field='type')
# An adapter type is a plain name: anything else is not echoed.
if not re.fullmatch(r"\\w+", kind):
    out('no_type', profile=shown, target=echo)
out('ok', profile=name, target=target, type=kind)
`

// Prints the secrets in a profile that dbt's errors may echo back: every string under the profile's outputs (all of
// them, aliases resolved), rendered as dbt would render it, and the value and default of each env_var the profile
// calls. Templates are rendered with jinja2 (dbt's own engine, always installed beside it) in a plain Environment
// with an env_var global and nothing else: no extensions, nothing executed, any other call is an error and the
// string is taken as written. Identifiers (schema, database, user…) are not secrets, nor is an env var used only
// under one. Stdout only, to the plugin.
export const PROFILE_REDACT = `import sys; sys.path = [p for p in sys.path if p not in ('', '.')]
import json, os, re
try:
    import yaml
except Exception:
    yaml = None
try:
    import jinja2
except Exception:
    jinja2 = None
found = []
recorded = []
# What dbt will render with: the plugin's environment under the assignments set for the command (read from stdin, never argv or env).
ENV = dict(os.environ)
try:
    ENV.update({k: v for k, v in (json.load(sys.stdin).get('env') or {}).items() if isinstance(k, str) and isinstance(v, str)})
except Exception:
    pass
PLAIN = ('type', 'threads', 'method', 'port')
IDENTIFIERS = ('schema', 'database', 'dataset', 'project', 'catalog', 'warehouse', 'role', 'user')
def keep(value):
    if isinstance(value, bool):
        return
    # Numbers and dates (PyYAML parses an unquoted 2026-11-18 as one) are printed as dbt renders them: as text.
    if not isinstance(value, str) and value is not None:
        value = str(value)
    # Short values (and so every number under 6 digits) are skipped: too common to cut from dbt's text.
    if not isinstance(value, str) or len(value) < 6:
        return
    if value not in found:
        found.append(value)
def env_var(name, default=None):
    value = ENV.get(name, default)
    recorded.extend([ENV.get(name), default])
    value = '' if value is None else str(value)
    recorded.append(value)
    return value
engine = None
if jinja2 is not None:
    try:
        engine = jinja2.Environment()
        engine.globals['env_var'] = env_var
        # dbt's own filters: a template that uses one must still render, or its env_var reads are lost.
        for name in ('as_text', 'as_number', 'as_bool', 'as_native'):
            engine.filters[name] = lambda value: value
    except Exception:
        engine = None
CALL = re.compile(r"env_var\\(\\s*([\\x22\\x27])([^\\x22\\x27]+)\\1\\s*(?:,\\s*([\\x22\\x27])([^\\x22\\x27]*)\\3\\s*)?\\)")
def render(text):
    # The rendered string, or None when it cannot be rendered; what the calls read is in recorded either way.
    del recorded[:]
    if engine is not None:
        try:
            return engine.from_string(text).render()
        except Exception:
            return None
    for call in CALL.finditer(text):
        recorded.extend([ENV.get(call.group(2)), call.group(4)])
    return None
def handle(text, key, secret):
    rendered = text
    del recorded[:]
    if '{{' in text or '{%' in text:
        rendered = render(text)
    if key in IDENTIFIERS:
        return
    for value in recorded:
        keep(value)
    if secret and key not in PLAIN:
        keep(rendered if rendered is not None else text)
def scan(node, key=None, secret=False):
    if isinstance(node, dict):
        for name, value in node.items():
            scan(value, name, secret)
    elif isinstance(node, list):
        for value in node:
            scan(value, key, secret)
    elif isinstance(node, str):
        handle(node, key, secret)
    elif secret and key not in PLAIN and key not in IDENTIFIERS:
        keep(node)
def load(path):
    try:
        with open(path) as f:
            return f.read()
    except Exception:
        return ''
text = load(sys.argv[2])
profiles = None
try:
    profiles = yaml.safe_load(text) if yaml else None
    project = (yaml.safe_load(load(sys.argv[1])) if yaml else None) or {}
    name = (sys.argv[3] if len(sys.argv) > 3 else None) or ENV.get('DBT_PROFILE') or project.get('profile')
    # A profile name a template gives is rendered the same way; its env vars are not secrets.
    if isinstance(name, str) and ('{{' in name or '{%' in name):
        name = render(name)
        del recorded[:]
    profile = profiles.get(name) if isinstance(profiles, dict) and isinstance(name, str) else None
except Exception:
    profile = None
if isinstance(profiles, dict):
    # Every env_var the file calls, under any key but an identifier; then the strings of the profile's outputs as rendered.
    scan(profiles)
    if isinstance(profile, dict):
        scan(profile.get('outputs'), None, True)
else:
    for call in CALL.finditer(text):
        keep(ENV.get(call.group(2)))
        keep(call.group(4))
# The forms Python prints a value in (a repr, a bytes repr with \\xNN escapes), by the rules that print them.
result = list(found)
for value in found:
    for part in [value] + [line for line in value.splitlines() if len(line) >= 6]:
        for form in (repr(part)[1:-1], repr(part.encode('utf-8'))[2:-1]):
            if len(form) >= 6 and form not in result:
                result.append(form)
print(json.dumps(dict(redact=result)))
`

/** Where an invocation reads its profiles.yml from, by its own words: the folder it ran in, and the folder it names. */
type ProfilesFrom = { dir: string; profilesDir: string | null; profile?: string | null; env?: string[] }

/**
 * The profiles.yml files dbt may read, the first existing one being the one it does: the invocation's own
 * `--profiles-dir` (or `DBT_PROFILES_DIR` set for it); else the inherited DBT_PROFILES_DIR; a relative one is read from
 * the folder it ran in. With neither, by default: the folder it ran in, the project folder, then ~/.dbt.
 */
async function profileCandidates($: EngineInterface, root: string, from?: ProfilesFrom): Promise<string[]> {
  const env = async (name: string) => $.process.run(['printenv', name], { timeoutMs: 5_000 }).then(one => one.stdout.trim()).catch(() => '')
  const home = await env('HOME')
  // A relative profiles folder, named by the command or inherited from DBT_PROFILES_DIR, is read from the folder dbt
  // ran in (the project folder for the plugin's own runs); `~` is the home folder.
  const rawDir = from?.profilesDir ?? (await env('DBT_PROFILES_DIR'))
  const expanded = rawDir.startsWith('~') && home ? `${home}${rawDir.slice(1)}` : rawDir
  const profilesDir = expanded && !expanded.startsWith('/') ? normalize(`${from?.dir ?? root}/${expanded}`) : expanded
  const wanted = profilesDir ? [`${profilesDir}/profiles.yml`] : [`${from?.dir ?? root}/profiles.yml`, `${root}/profiles.yml`, ...(home ? [`${home}/.dbt/profiles.yml`] : [])]
  const found: string[] = []
  for (const path of new Set(wanted.map(one => normalize(one)))) if (await $.fs.exists(path).catch(() => false)) found.push(path)
  return found
}

async function profilesPath($: EngineInterface, root: string): Promise<string | null> {
  return (await profileCandidates($, root))[0] ?? null
}

// What was loaded for a profiles.yml (and the profile asked for): when, and the file's time then.
const redactionLoaded = new Map<string, { mtimeMs: number; at: number; done: Promise<void> }>()
const REDACTION_REFRESH_MS = 30_000

/**
 * Makes the next dbt output load the values again. The values already held stay for as long as the plugin runs: a
 * query that was under way when the conversation ended is still held to them when it finishes.
 */
function forgetRedactions() {
  redactionLoaded.clear()
}

/**
 * Loads the values of the profiles.yml an invocation reads (and of the env vars it names) that dbt's errors may echo,
 * before any dbt output of the invocation is read: the plugin's own profile, and the one the invocation names with
 * `--profiles-dir` or `DBT_PROFILES_DIR`. Again when a file changed, or after 30 seconds (an env var may have).
 * Whatever stops the script leaves what was loaded, or nothing: the fixed-message scrub still applies.
 */
async function ensureRedactions($: EngineInterface, root: string, from?: ProfilesFrom): Promise<void> {
  try {
    const paths = new Set<string>(await profileCandidates($, root))
    if (from) for (const path of await profileCandidates($, root, from)) paths.add(path)
    for (const path of paths) {
      // The assignments set for the command change what the profile renders to: another load for them. The key stays in memory.
      const env = Object.fromEntries((from?.env ?? []).map(one => [one.slice(0, one.indexOf('=')), one.slice(one.indexOf('=') + 1)]))
      // The project too: another project's dbt_project.yml may select another profile of the same profiles.yml.
      const key = `${root}|${path}|${from?.profile ?? ''}|${JSON.stringify(env)}`
      const stat = await $.fs.stat(path).catch(() => null)
      const now = await $.clock.now()
      const seen = redactionLoaded.get(key)
      // A load still running is waited for, not skipped: a caller that gets ahead of it would read dbt's output with no values yet.
      if (seen && stat && seen.mtimeMs === stat.mtimeMs && now - seen.at < REDACTION_REFRESH_MS) {
        await seen.done
        continue
      }
      const done = (async () => {
        const run = await $.process.run([await pythonFor($, root), '-c', PROFILE_REDACT, `${root}/dbt_project.yml`, path, ...(from?.profile ? [from.profile] : [])], { cwd: root, timeoutMs: 30_000, stdin: JSON.stringify({ env }) })
        if (run.exitCode !== 0) return
        const answer = JSON.parse(run.stdout) as { redact?: unknown }
        if (Array.isArray(answer.redact)) setRedactions(key, answer.redact.filter((one): one is string => typeof one === 'string'))
      })().catch(() => {})
      redactionLoaded.set(key, { mtimeMs: stat?.mtimeMs ?? 0, at: now, done })
      await done
    }
  } catch {}
}

/** The adapter type the project's profile names, from the profiles.yml dbt itself would read; a problem when it cannot be read, null when there is no such profile. */
async function profileType($: EngineInterface, root: string): Promise<string | null | ProfileProblem> {
  const path = await profilesPath($, root)
  if (!path) return null
  // Whatever stops the parser (no interpreter, no PyYAML, a file it cannot read) is "could not tell", never a guess.
  const unread: ProfileProblem = { problem: 'error', profile: '', target: '' }
  try {
    const run = await $.process.run([await pythonFor($, root), '-c', PROFILE_TYPE, `${root}/dbt_project.yml`, path], { cwd: root, timeoutMs: 30_000 })
    if (run.exitCode !== 0) return unread
    const answer = JSON.parse(run.stdout) as { status: string; profile?: string; target?: string; type?: string; field?: 'target' | 'type' }
    if (answer.status === 'ok' && answer.type) return answer.type
    if (answer.status === 'no_profile') return null
    const problem = ({ template: 'template', no_target: 'no-target', no_output: 'no-output', no_type: 'no-type' } as const)[answer.status as 'template']
    return problem ? { problem, profile: answer.profile ?? '', target: answer.target ?? '', field: answer.field === 'type' ? 'type' : 'target' } : unread
  } catch {
    return unread
  }
}

/** The doctor's manifest line: whether the manifest is missing, current, or older than files of the project. */
async function manifestCheck($: EngineInterface, root: string): Promise<{ check: DoctorCheck; staleFiles: string[] }> {
  const target = await targetOf($, root)
  const stat = await $.fs.stat(`${target}/manifest.json`).catch(() => null)
  const shown = target.startsWith(`${root}/`) ? relative(root, target) : target
  if (!stat) return { check: { id: 'manifest', label: 'Manifest', status: 'warn', detail: `${shown}/manifest.json is missing: lineage, model context and docs need it`, fix: 'dbt parse' }, staleFiles: [] }
  const scan = await changedSince($, root, stat.mtimeMs)
  const staleFiles = scan.files
  const age = Math.round(((await $.clock.now()) - stat.mtimeMs) / 60_000)
  const ageText = age < 60 ? `${age} min` : age < 2880 ? `${Math.round(age / 60)} h` : `${Math.round(age / 1440)} days`
  const check: DoctorCheck = staleFiles.length
    ? { id: 'manifest', label: 'Manifest', status: 'warn', detail: `stale: ${staleFiles.length} file${staleFiles.length === 1 ? '' : 's'} changed since it was written ${ageText} ago (${staleFiles.slice(0, 3).join(', ')}${staleFiles.length > 3 ? ', …' : ''})`, fix: 'dbt parse' }
    : scan.complete
      ? { id: 'manifest', label: 'Manifest', status: 'ok', detail: `current (written ${ageText} ago)`, fix: null }
      : { id: 'manifest', label: 'Manifest', status: 'warn', detail: `no change found, but not every project file could be checked (over ${MAX_SCANNED} files, or a folder could not be read), so it may be stale (written ${ageText} ago)`, fix: 'dbt parse' }
  return { check, staleFiles }
}

/**
 * After a tool call that may have changed the project's files (an edit, a shell command): the doctor's manifest
 * line is read again, so a doctor shown before the change no longer says the manifest is current.
 */
async function recheckDoctorManifest($: EngineInterface) {
  const view = await read($, doctorAtom)
  if (!view) return
  // A doctor running now may publish what it read before this change: it reads the manifest again when it is done.
  if (view.busy) {
    recheckWhenIdle = true
    return
  }
  const seq = ++manifestSeq
  const { check, staleFiles } = await manifestCheck($, view.root)
  // A newer read (another change, or the doctor itself) has the say.
  if (seq !== manifestSeq) return
  check.detail = redactValues(check.detail)
  if (check.fix) check.fix = redactValues(check.fix)
  let landed = false
  await update($, doctorAtom, prev => {
    // Checked again here: a newer read may have landed while this update waited its turn.
    if (!prev || prev.root !== view.root || prev.busy || seq !== manifestSeq) return prev
    landed = true
    return { ...prev, checks: prev.checks.map(one => (one.id === 'manifest' ? check : one)), staleFiles }
  })
  if (!landed && (await read($, doctorAtom))?.busy) recheckWhenIdle = true
}

/** When the doctor is idle again: a change made while it was busy has its manifest line read now. */
function drainDoctorRecheck($: EngineInterface) {
  if (!recheckWhenIdle) return
  recheckWhenIdle = false
  later($, () => recheckDoctorManifest($))
}

// Each read of the manifest's freshness, by the doctor or after a change: only the newest one is shown.
let manifestSeq = 0
// A change arrived while the doctor was running: the manifest is read again once it is done.
let recheckWhenIdle = false

async function runDoctor($: EngineInterface, root: string, connection = false): Promise<DoctorView> {
  const previous = await read($, doctorAtom)
  await update($, doctorAtom, () => ({ root, checks: previous?.root === root ? previous.checks : [], at: previous?.at ?? 0, staleFiles: previous?.staleFiles ?? [], busy: connection ? 'Testing the connection…' : 'Checking the dbt environment…' }))
  const checks: DoctorCheck[] = []
  const dbt = await dbtBinary($, root)
  const version = await runDbt($, root, ['--version'], 60_000).catch(error => ({ exitCode: -1, stdout: '', stderr: String(error) }))
  const info = versionInfo(`${version.stdout}\n${version.stderr}`)
  if (version.exitCode !== 0 && !info.core) {
    checks.push({ id: 'dbt', label: 'dbt', status: 'fail', detail: `could not run ${dbt}: ${dbtTail(version, 1)}`.slice(0, 300), fix: 'install dbt-core and your adapter (pip install dbt-core dbt-<adapter>), or create the project\'s .venv' })
  } else {
    checks.push({ id: 'dbt', label: 'dbt', status: 'ok', detail: `dbt-core ${info.core ?? 'unknown'} (${dbt === 'dbt' ? 'on PATH' : relative(root, dbt) || dbt})`, fix: null })
  }

  // Python: the interpreter dbt's own launcher names.
  const shebang = await dbtShebang($, dbt)
  const python = shebang ? await $.process.run([shebang, '--version'], { timeoutMs: 10_000 }).catch(() => null) : null
  const pythonVersion = python ? /Python\s+(\S+)/.exec(`${python.stdout}${python.stderr}`)?.[1] : null
  if (pythonVersion) {
    const [major, minor] = pythonVersion.split('.').map(Number)
    const old = major! < 3 || (major === 3 && minor! < 9)
    checks.push({ id: 'python', label: 'Python', status: old ? 'warn' : 'ok', detail: `${pythonVersion}${old ? ' (dbt needs 3.9 or newer)' : ''}`, fix: old ? 'use Python 3.9+ for dbt' : null })
  } else {
    checks.push({ id: 'python', label: 'Python', status: 'warn', detail: 'could not tell which Python runs dbt', fix: null })
  }

  // Adapter: the profile's type, installed beside dbt-core.
  const type = await profileType($, root)
  const installed = info.adapters.map(one => one.name)
  const known = installed.length ? `; installed: ${installed.join(', ')}` : ''
  if (type && typeof type === 'object') {
    // A name is shown only when the file writes it plainly: one an env var or a template gave may be a secret.
    const named = type.profile ? `profile ${type.profile}` : 'the profile'
    const detail = {
      template: `the profile's ${type.field ?? 'target'} is set by a template, so which adapter it uses could not be told${known}`,
      'no-target': `${named}: the target is not a name`,
      'no-output': type.target ? `${named} has no output named ${type.target}` : `${named} has no output for the target its template or env var gives`,
      'no-type': `${type.target ? `output ${type.target}` : 'the output'} has no \`type\` key`,
      error: `could not tell which adapter the profile uses (its profiles.yml could not be read here)${known}`,
    }[type.problem]
    // dbt itself refuses a profile with no such output, or an output with no type.
    const refused = type.problem === 'no-target' || type.problem === 'no-output' || type.problem === 'no-type'
    checks.push({ id: 'adapter', label: 'Adapter', status: refused ? 'fail' : 'warn', detail, fix: type.problem === 'no-target' ? 'make the profile\'s `target` the name of one of its outputs' : type.problem === 'no-output' ? 'add the output to profiles.yml, or pick another target' : type.problem === 'no-type' ? 'add the adapter\'s `type` to the output in profiles.yml' : null })
  }
  else if (!type) checks.push({ id: 'adapter', label: 'Adapter', status: 'warn', detail: `no profile found for this project${installed.length ? `; installed: ${installed.join(', ')}` : ''}`, fix: 'add the profile to profiles.yml (or set DBT_PROFILES_DIR)' })
  // dbt-core's version unread (dbt Fusion bundles its adapters, a broken install): nothing to hold the profile to.
  else if (installed.length === 0 && !info.core) checks.push({ id: 'adapter', label: 'Adapter', status: 'warn', detail: `the profile uses ${type}; could not tell which adapters are installed`, fix: null })
  else if (installed.length === 0) checks.push({ id: 'adapter', label: 'Adapter', status: 'fail', detail: `the profile uses ${type}, but no dbt adapter is installed beside dbt-core`, fix: `pip install dbt-${type}` })
  else if (!installed.includes(type)) checks.push({ id: 'adapter', label: 'Adapter', status: 'fail', detail: `the profile uses ${type}, but only ${installed.join(', ')} ${installed.length === 1 ? 'is' : 'are'} installed`, fix: `pip install dbt-${type}` })
  else {
    const adapter = info.adapters.find(one => one.name === type)
    checks.push({ id: 'adapter', label: 'Adapter', status: 'ok', detail: `${type}${adapter ? ` ${adapter.version}` : ''}`, fix: null })
  }

  // Packages: packages.yml with nothing installed (at packages-install-path) fails every parse. A package repo
  // whose own packages are not installed is fine when the project below it that installs it (integration_tests)
  // has them: dbt is run from there.
  const packages = await packagesOf($, root)
  if (packages) {
    const runner = packages.installed ? null : await runnerOf($, root)
    const theirs = runner ? await packagesOf($, runner) : null
    const has = packages.installed || (!!runner && (!theirs || theirs.installed))
    const detail = packages.installed ? `${packages.installPath} installed` : has ? `installed in ${relative(root, runner!)}, where dbt runs for this package` : `${packages.file} is not installed`
    checks.push({ id: 'packages', label: 'Packages', status: has ? 'ok' : 'fail', detail, fix: has ? null : 'dbt deps' })
  }

  // Manifest freshness. A read after a change that is still going is outdated by this one.
  manifestSeq++
  const manifest = await manifestCheck($, root)
  checks.push(manifest.check)
  const staleFiles = manifest.staleFiles

  // The connection test opens a warehouse session: only when asked for.
  if (connection) {
    const debug = await runDbt($, root, ['debug', '--log-format', 'text'], 120_000).catch(error => ({ exitCode: -1, stdout: '', stderr: String(error) }))
    const parsed = debugInfo(`${debug.stdout}\n${debug.stderr}`)
    checks.push(
      debug.exitCode === 0 && parsed.connection !== 'failed'
        ? { id: 'connection', label: 'Connection', status: 'ok', detail: `${parsed.adapterType ?? (typeof type === 'string' ? type : null) ?? 'warehouse'} connection test passed`, fix: null }
        : { id: 'connection', label: 'Connection', status: 'fail', detail: (profilesError(`${debug.stdout}\n${debug.stderr}`) ? PROFILES_UNREADABLE : scrubDbt(parsed.detail ?? stripAnsi(debug.stdout || debug.stderr).trim().split('\n').slice(-3).join(' '))).slice(0, 300), fix: 'check profiles.yml credentials; run dbt debug' },
    )
  } else if (previous?.root === root) {
    const kept = previous.checks.find(one => one.id === 'connection')
    if (kept) checks.push(kept)
  }

  // Every line the doctor shows or sends, the plugin's own wording included, is held to the same rule as dbt's text: no value of the profile.
  for (const check of checks) {
    check.detail = redactValues(check.detail)
    if (check.fix) check.fix = redactValues(check.fix)
  }
  const view: DoctorView = { root, checks, at: await $.clock.now(), staleFiles, busy: null }
  await update($, doctorAtom, () => view)
  // A change while it ran (the connection test can take minutes): its manifest line is read again.
  drainDoctorRecheck($)
  return view
}

async function parseNow($: EngineInterface, root: string) {
  const asked = generation
  const current = await read($, doctorAtom)
  if (current) await update($, doctorAtom, () => ({ ...current, busy: 'Running dbt parse…' }))
  const run = await runDbt($, root, ['parse', '--log-format', 'text'], 300_000).catch(error => ({ exitCode: -1, stdout: '', stderr: String(error) }))
  if (run.exitCode !== 0) {
    const reason = dbtTail({ stdout: run.stdout || run.stderr, stderr: '' }, 3, true, ' ').slice(0, 200)
    $.ui.toast(`✖ dbt parse failed · ${reason}`, { timeoutMs: 10000 })
  } else infoToast($, '✓ dbt parse finished · the manifest is current', 6000)
  const view = await runDoctor($, root)
  // Claude hears the manifest is current again on its next prompt.
  noteDoctor(root, view, asked)
}

function doctorSummary(view: DoctorView) {
  const bad = view.checks.filter(one => one.status !== 'ok')
  return { bad, text: bad.length === 0 ? `${view.checks.length} checks passed` : bad.map(one => `${one.label} ${one.status === 'fail' ? 'failed' : 'needs attention'}`).join(' · ') }
}

// Opened inside the press itself, so Claude Code counts it as the person's: a pane opened later, on the
// clock, is one the plugin asked for, and a narrow terminal leaves those unplaced.
async function openCheck($: EngineInterface, focus: boolean) {
  await $.ui.open({ id: CHECK_PANE, title: CHECK_TITLE, columns: 100, rows: 24, closeOnEscape: true, ...(focus ? { focus: true as const } : {}) })
}

async function openDoctor($: EngineInterface) {
  await $.ui.open({ id: DOCTOR_PANE, title: DOCTOR_TITLE, columns: 90, rows: 20, focus: true, closeOnEscape: true })
}

// ─── Start, the band, the hooks ─────────────────────────────────────────────────────────────────────

export async function startDbtMods($: EngineInterface, isInteractive: boolean) {
  const asked = generation
  contextGiven.clear()
  oldGapsSaid.clear()
  lastReturned.clear()
  editGaps.clear()
  pendingNotes.splice(0)
  doctorNoteDue = null
  unrunnable.clear()
  ownInvocation.clear()
  forgetRedactions()
  await loadHistory($)
  await $.command.register({ name: SHOW_COMMAND, description: 'Run dbt show for a model or a SQL query and open the rows in the Query results pane', argumentHint: '<model> | <select …>' })
  await $.command.register({ name: DOCTOR_COMMAND, description: 'Check the dbt environment: Python, dbt, adapter, packages, manifest freshness and the warehouse connection' })
  await loadPaneSizesOnce($)
  // The doctor at session start: a -p run or the SDK has nobody to show the band to, and no dbt to wait on.
  if (!isInteractive) return
  later($, async () => {
    const root = await sessionProject($)
    if (!root) return
    const view = await runDoctor($, root)
    const { bad, text } = doctorSummary(view)
    noteDoctor(root, view, asked)
    if (bad.length) $.ui.toast(`⚕ dbt doctor · ${text}`, { timeoutMs: 8000 })
    else infoToast($, `✓ dbt doctor · ${text}`, 8000)
  })
}

/** The band lines: a failed run's Explain and Fix, the last compile-and-validate, the doctor's findings. */
export async function dbtModsBand($: EngineInterface, ui: { Box: any; Button: any; Text: any }): Promise<RenderElement | null> {
  const { Box, Button, Text } = ui
  const failure = await read($, failureAtom)
  const check = await read($, checkAtom)
  const doctor = await read($, doctorAtom)
  const rows: RenderElement[] = []

  if (failure) {
    const first = failure.failures[0]!
    const firstLine = first.message.split('\n').find(line => line.trim() && !/^(Compilation|Database|Runtime|Parsing) Error$/.test(line.trim())) ?? first.message
    rows.push(
      <Box key="dbt-failure" flexDirection="column">
        <Text>
          <Text color="error">✖ dbt failed </Text>
          <Text bold>{failure.failures.map(one => one.name).slice(0, 3).join(', ')}</Text>
          {failure.failures.length > 3 ? <Text dimColor> +{failure.failures.length - 3}</Text> : null}
          <Text dimColor>  {firstLine.trim().slice(0, 140)}</Text>
        </Text>
        <Box>
          <Button key="dbt-explain" label="Explain" onPress={() => later($, async () => {
            await $.prompt.submit({ text: explainPrompt(failure.command, failure.failures) })
          })} />
          <Button key="dbt-fix" label="Fix with Altimate Code" onPress={() => later($, async () => {
            // The plugin's /altimate-code:altimate routes the fix through altimate-code; a plugin runs a
            // command with command.run, never a prompt that starts with "/".
            const task = fixPrompt(failure.command, failure.failures)
            await $.command.run({ command: 'altimate-code:altimate', args: task }).catch(() => $.prompt.submit({ text: `Use altimate-code (the altimate-code plugin) for this. ${task}` }))
          })} />
          <Button key="dbt-failure-dismiss" label="Dismiss" onPress={() => update($, failureAtom, () => null)} />
        </Box>
      </Box>,
    )
  }

  if (check) {
    const color = { running: 'subtle', ok: 'success', partial: 'subtle', warn: 'warning', error: 'error' }[check.status]
    const icon = STATUS_ICON[check.status]
    const detail =
      check.status === 'running'
        ? 'compiling and checking against the warehouse…'
        : check.status === 'partial'
          ? `${check.ran ? 'compiled and ran · columns not compared' : 'not checked'}: ${check.reason} · ${(check.ms / 1000).toFixed(1)}s`
        : check.status === 'error'
          ? (check.errors[0] ?? 'failed').split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 160)
          : [
              ...(check.hardcoded ?? []).map(one => `hardcoded ${one.relation}: use ${one.use} — lineage can't follow it`),
              check.columns !== null ? `${check.columns} columns` : 'no row returned',
              check.missing.length ? `missing ${check.missing.join(', ')}` : null,
              check.undocumented.length ? `undocumented ${check.undocumented.join(', ')}` : null,
              check.status === 'ok' && check.columns !== null ? (check.undocumentedBefore?.length ? 'no new gaps with schema.yml' : 'match schema.yml') : null,
              check.undocumentedBefore?.length && !check.oldGapsSaid ? `${check.undocumentedBefore.length} undocumented before this edit` : null,
              check.ranFrom ? `ran from ${check.ranFrom}` : null,
              `${(check.ms / 1000).toFixed(1)}s`,
            ]
              .filter(Boolean)
              .join(' · ')
    rows.push(
      <Box key="dbt-check">
        <Text>
          <Text color={color}>{icon} Compile & validate </Text>
          <Text bold>{check.model}</Text>
          <Text dimColor>  {detail}  </Text>
        </Text>
        {check.status !== 'running' ? <Button key="dbt-check-details" label="Details" onPress={() => openCheck($, true).catch(() => {})} /> : null}
        {check.status !== 'running' ? <Button key="dbt-check-dismiss" label="Dismiss" onPress={() => update($, checkAtom, () => null)} /> : null}
      </Box>,
    )
  }

  if (doctor && !doctor.busy) {
    const { bad } = doctorSummary(doctor)
    if (bad.length) {
      const stale = doctor.checks.find(one => one.id === 'manifest' && one.status !== 'ok')
      const deps = doctor.checks.find(one => one.id === 'packages' && one.status !== 'ok')
      rows.push(
        <Box key="dbt-doctor" flexDirection="column">
          <Text>
            <Text color="warning">⚕ dbt doctor </Text>
            <Text dimColor>{bad.map(one => `${one.label}: ${one.detail}`).join(' · ').slice(0, 200)}</Text>
          </Text>
          <Box>
            {deps ? <Button key="dbt-doctor-deps" label="Run dbt deps" onPress={() => later($, async () => {
              await update($, doctorAtom, view => (view ? { ...view, busy: 'Running dbt deps…' } : view))
              const deps = await runDbt($, doctor.root, ['deps', '--log-format', 'text'], 300_000).catch(error => ({ exitCode: -1, stdout: '', stderr: String(error) }))
              // Parsing without the packages would only fail again: say what deps said and stop.
              if (deps === SKIPPED || deps.exitCode !== 0) {
                await update($, doctorAtom, view => (view ? { ...view, busy: null } : view))
                drainDoctorRecheck($)
                if (deps !== SKIPPED) $.ui.toast(`✖ dbt deps failed · ${dbtTail(deps, 1).slice(0, 160)}`, { timeoutMs: 8000 })
                return
              }
              await parseNow($, doctor.root)
            })} /> : null}
            {stale ? <Button key="dbt-doctor-parse" label="Run dbt parse" onPress={() => later($, () => parseNow($, doctor.root))} /> : null}
            <Button key="dbt-doctor-details" label="Details" onPress={() => openDoctor($).catch(() => {})} />
            <Button key="dbt-doctor-dismiss" label="Dismiss" onPress={() => update($, doctorAtom, () => ({ ...doctor, checks: doctor.checks.filter(one => one.status === 'ok') }))} />
          </Box>
        </Box>,
      )
    }
  } else if (doctor?.busy) {
    rows.push(
      <Box key="dbt-doctor-busy">
        <Text dimColor>⚕ {doctor.busy}</Text>
      </Box>,
    )
  }

  if (rows.length === 0) return null
  return (
    <Box key="dbt-mods-band" flexDirection="column">
      {rows}
    </Box>
  )
}

// ─── The tool chain's phases (tool-chain.ts) ──────────────────────────────────────────────────────
//
//   callStart        what a call needs from before it runs: the conversation it belongs to, and for a dbt
//                    command the folder, the time and the run artifact as they are (an observer: it never
//                    refuses or changes the call);
//   bashAfter        a command's results: the failed run, the query preview, a re-check of the model;
//   editAfter        a model Claude edited: compile and validate it, hold its note for up to CHECK_HOLD_MS;
//   readOrEditAfter  a model Claude read: its manifest facts; and, after any read or edit, the notes that
//                    missed their own tool result.

/** Whether the dbt helpers are on: the `dbt_mods` option, read when the plugin registers them (off until then). */
let enabled = false
// The `info_toasts` setting: off, a toast that only repeats what the transcript or the band shows is not raised.
let infoToasts = true

/** A toast that repeats what the transcript or the band above the prompt already shows: raised only with `info_toasts` on. */
function infoToast($: EngineInterface, text: string, timeoutMs: number) {
  if (infoToasts) $.ui.toast(text, { timeoutMs })
}

/** What a call needs from before it ran: taken in `callStart`, used in the after phase of the same call. */
type Start = {
  /** The conversation this call belongs to: one that ends (/clear) while it runs gets nothing from it. */
  asked: number
  startedAt: number
  /** Where an invocation ran: the session's folder before the command (Claude's shell keeps its `cd`s). */
  base: string
  /** Settles when the run artifact's previous invocation is read and the profile's values are loaded. */
  ready: Promise<string | null>
}
// The calls that have started and not yet finished, by agent and command (Bash) or file (edits).
const starts = new Map<string, Start>()
const agentOf = (e: unknown): string | null => (e as { agentId?: string }).agentId ?? null
const startKey = (e: { tool: string; agentId?: string }, what: string) => `${e.agentId ?? ''}\u0000${e.tool}\u0000${what}`
const bashOf = (e: { tool: string }): { command: string } | null => (e.tool === 'Bash' && typeof (e as { command?: unknown }).command === 'string' ? (e as unknown as { command: string }) : null)
const editedFile = (e: { tool: string }): string | null => {
  const path = (e as { file_path?: unknown }).file_path
  return EDIT_TOOLS.has(e.tool) && typeof path === 'string' ? normalize(path) : null
}
// One per key, the latest: a call refused after it started, or an edit that failed, leaves one behind that the next call of the same key replaces.
const noteStart = (key: string, start: Start) => void starts.set(key, start)
const takeStart = (key: string): Start | undefined => {
  const start = starts.get(key)
  starts.delete(key)
  return start
}

/** Where an invocation ran: the folder after the `cd`s before it, and its project (--project-dir, else that folder's). */
async function placeOf($: EngineInterface, base: string, one: DbtCommand): Promise<{ dir: string; root: string } | null> {
  const dir = cdTarget(one.cds, base)
  // A `cd ~/x` or `cd $DIR` leaves the folder unknown: nothing is filed under a guessed project.
  if (dir === null) return null
  const projectDir = one.options.reduce<string | null>((found, value, i) => (one.options[i - 1] === '--project-dir' ? value : found), null)
  const root = await projectRoot($, projectDir ? (projectDir.startsWith('/') ? projectDir : `${dir.replace(/\/+$/, '')}/${projectDir}`) : dir, false)
  return root ? { dir, root } : null
}

/** Loads the profile values of every run in a command, each from the profiles.yml its own words name. */
async function ensureForRuns($: EngineInterface, base: string, runs: DbtCommand[]): Promise<void> {
  for (const one of runs) {
    const place = await placeOf($, base, one)
    if (place) await ensureRedactions($, place.root, { dir: place.dir, profilesDir: one.profilesDir, profile: one.profile, env: one.assignments })
  }
}

/** Before a call runs: the conversation it is in; for a dbt command also the folder, the time and the run artifact as they are now. */
export async function dbtModsCallStart($: EngineInterface, e: { tool: string; agentId?: string }): Promise<void> {
  if (!enabled) return
  // Taken before the first wait, so a /clear during it is seen.
  const asked = generation
  const file = editedFile(e)
  if (file) return noteStart(startKey(e, file), { asked, startedAt: 0, base: '', ready: Promise.resolve(null) })
  const bash = bashOf(e)
  const invocations = bash ? dbtCommands(bash.command) : []
  if (!bash || invocations.length === 0) return
  const runs = invocations.filter(one => RUN_VERBS.includes(one.verb))
  const cwd = await $.session.cwd().catch(() => null)
  const base = cwd ?? ((await $.session.root().catch(() => '.')) as string)
  const startedAt = await $.clock.now()
  // The invocation the run's artifact held before the command: an older run's. The profile's values are
  // loaded before the command's output is read.
  const ready = (async () => {
    const first = runs[0] ? await placeOf($, base, runs[0]) : null
    if (!first) return null
    // The values come first: the snapshot reads run_results.json through the script that cuts them out.
    await ensureForRuns($, base, runs)
    return seenInvocation($, first.root).catch(() => null)
  })()
  // Nobody awaits it if the call never reaches its after phase.
  ready.catch(() => {})
  noteStart(startKey(e, bash.command), { asked, startedAt, base, ready })
  await ready.catch(() => {})
}

/** After a Bash call: re-check the checked model, record a dbt run's result, open a `dbt show`'s rows. */
export async function dbtModsBashAfter($: EngineInterface, e: { tool: string; command: string; agentId?: string }, result: ToolCallResult): Promise<string[]> {
  if (!enabled) return []
  const agentId = agentOf(e)
  const command = e.command
  const start = takeStart(startKey(e, command))
  // A command may have changed the checked model.
  later($, () => recheck($, null))
  later($, () => recheckDoctorManifest($))
  const invocations = dbtCommands(command)
  if (invocations.length === 0) return pendingLines(agentId)
  const asked = start?.asked ?? generation
  const startedAt = start?.startedAt ?? (await $.clock.now())
  const base = start?.base ?? (((await $.session.cwd().catch(() => null)) ?? ((await $.session.root().catch(() => '.')) as string)))
  const seen = start ? await start.ready.catch(() => null) : null
  const runs = invocations.filter(one => RUN_VERBS.includes(one.verb))
  const places = await Promise.all(runs.map(one => placeOf($, base, one)))
  const firstRun = places[0] ?? null
  // The profile's values are loaded before the command's output is read.
  if (!start) await ensureForRuns($, base, runs)
  const raw = (result as any).result
  const output = typeof raw?.stdout === 'string' ? `${raw.stdout}\n${raw.stderr ?? ''}` : String((result as any).text ?? '')
  // Runs: one result for the whole command. Two or more (`dbt run -s a && dbt test -s a`) are recorded as
  // one compound run, so only the same compound command or a whole-project build clears its failure.
  // Runs in two projects in one command (`cd a && dbt run; cd ../b && dbt test`) are not one result.
  if (firstRun && places.every(place => place?.root === firstRun.root)) {
    // One piece of output per invocation says which one failed: the exit code, which any of them may have set,
    // does not. It decides only when the output cannot say (a killed run, no pieces to match). A failure is
    // cleared only by output that shows every run finished without errors.
    const verdict = dbtVerdict(output, invocations.map(one => one.verb))
    const failed = verdict.failed || (!(verdict.mapped && verdict.passed) && !!result.isError)
    const proven = !failed && verdict.passed
    const verb = runs.map(one => one.verb).join('+')
    const select = runs.length === 1 ? runs[0]!.select : runs.map(one => one.select ?? '*').join(' | ')
    // One context when every run shares it (`-t prod` on each), else each run's in turn.
    // The folder it ran in too: relative `--profiles-dir .`, `--state` and the environment's paths depend on it.
    const contexts = runs.map((one, i) => [...one.identity, ...one.env.map(env => `env:${env}`), `cwd:${places[i]!.dir.replace(/\/+$/, '')}`])
    const context = contexts.every(one => JSON.stringify(one) === JSON.stringify(contexts[0])) ? contexts[0]! : contexts
    // Where it ran includes the environment set for it in the same command (`DBT_TARGET=prod dbt run`).
    await recordRun($, command.trim(), verb, select, context, firstRun.root, output, failed, proven, startedAt, asked, seen).catch(() => null)
  }
  // Shows: a command that runs several different shows saves no preview, whatever node dbt names: which
  // show printed which rows cannot be told. One show, or the same show twice (`dbt show -s a || dbt show -s a`),
  // owns the preview.
  const table = showPreview(output) ?? textTable(output)
  const shows = invocations.filter(one => one.verb === 'show')
  const identity = (one: DbtCommand) => JSON.stringify([one.argv, one.env, cdTarget(one.cds, base)])
  const sameShow = shows.every(one => identity(one) === identity(shows[0]!))
  const show = sameShow ? shows.at(-1) : undefined
  const shown = show && !result.isError ? await placeOf($, base, show) : null
  if (show && shown && table) {
    const select = show.select
    const inline = select ? null : show.inline
    // A re-run runs Claude's own invocation again, from where it ran: same flags, same order. One that
    // depended on its shell (variables, `~`, globs, other commands before it) is kept with no Re-run.
    const replay = replayArgv(show.argv, 0).slice(0, -6)
    await showResult(
      $,
      { id: JSON.stringify([shown.root, shown.dir, replay, envNames(show.env)]), title: titleOf(select, inline) || 'dbt show', root: shown.root, select, inline, options: show.options, argv: show.replayable ? show.argv : null, cwd: shown.dir, replayable: show.replayable, columns: table.columns, rows: table.rows, limit: show.limit ?? 5, ms: (await $.clock.now()) - startedAt, at: await $.clock.now(), error: null, by: 'claude' },
      true,
      asked,
    ).catch(() => null)
  }
  return pendingLines(agentId)
}

/** The notes that missed their own tool result, for this agent, as context lines. */
function pendingLines(agentId: string | null): string[] {
  return withPending({ context: [] as string[] }, agentId).context
}

/** After a model Claude edited: compile it and run it against the warehouse, then check its columns. */
export async function dbtModsEditAfter($: EngineInterface, e: { tool: string; agentId?: string }, result: ToolCallResult, file: { path: string }): Promise<string[]> {
  if (!enabled || !EDIT_TOOLS.has(e.tool)) return []
  later($, () => recheckDoctorManifest($))
  const path = normalize(file.path)
  // The conversation this edit belongs to, taken before the edit ran, so a /clear during it is seen.
  const asked = takeStart(startKey(e, path))?.asked ?? generation
  const agentId = agentOf(e)
  if (/\.sql$/i.test(path)) {
    const root = await projectRoot($, path, true)
    // Only a file under the project's model-paths is a model dbt can show.
    const folders = root ? modelPaths(await $.fs.read(`${root}/dbt_project.yml`).catch(() => '')) : []
    const inModels = !!root && folders.some(folder => (folder === '' ? !/^(target|dbt_packages|dbt_modules|logs)\//.test(relative(root, path)) : relative(root, path).startsWith(`${folder}/`)))
    if (root && inModels) {
      const check = compileAndValidate($, root, path, asked)
      const landed = await within($, CHECK_HOLD_MS, check)
      // Landed, and still the newest check of this file in this conversation.
      if (landed && landed.current()) {
        // The toast points at the band, so only the check the band shows may say so.
        if (landed.newest() && landed.view.status === 'error') $.ui.toast(`✖ ${landed.view.model} · dbt could not compile or run it · see the band`, { timeoutMs: 6000 })
        else if (landed.newest())
          infoToast(
            $,
            landed.view.status === 'partial'
              ? `◦ ${landed.view.model} · ${landed.view.ran ? 'compiled and ran; columns not compared' : `not checked: ${landed.view.reason}`}`
              : `${STATUS_ICON[landed.view.status]} ${landed.view.model} · compiled and validated against the warehouse`,
            6000,
          )
        return landed.note ? [landed.note] : []
      }
      // Too slow for this result: its answer rides on this agent's next one, if it is still the newest.
      if (!landed) check.then(done => void (done.current() && pendingNotes.push({ note: done.note, agentId, current: done.current }))).catch(() => {})
      return []
    }
  }
  // An edit of a .yml (a schema file documenting the model for the first time) or of another .sql (a macro
  // the model calls) can change its answer though neither watched file did: check it again regardless.
  if (/\.(ya?ml|sql)$/i.test(path)) later($, () => recheck($, path))
  return []
}

/** After a read or an edit succeeded: a model that was read brings its manifest facts; then the notes that are due. */
export async function dbtModsReadOrEditAfter($: EngineInterface, e: { tool: string; agentId?: string }, result: ToolCallResult, file: { path: string }): Promise<string[]> {
  if (!enabled) return []
  const agentId = agentOf(e)
  const path = normalize(file.path)
  // A model Claude reads: the manifest's facts go with the file.
  if (e.tool === 'Read' && /\.sql$/i.test(path)) {
    const found = await modelNote($, path, agentId ?? undefined).catch(() => null)
    if (found) {
      infoToast($, found.toast, 6000)
      $.ui.log(`model-context · added to Claude's context: ${basename(path)}`)
      return [found.note, ...pendingLines(agentId)]
    }
  }
  return pendingLines(agentId)
}

/**
 * A conversation ended (a /clear): its notes, context, check and failed run are not the next one's.
 * Called from the plugin's one session.end hook. A check still running lands nowhere.
 */
export async function endDbtMods($: EngineInterface) {
  generation++
  // A check of the conversation that ended answers nobody in the next.
  for (const waiting of landedWaiters.values()) for (const one of waiting) one.resolve(null)
  landedWaiters.clear()
  forgetRedactions()
  slices.clear()
  parsed = null
  forcedWhileBusy = null
  contextGiven.clear()
  oldGapsSaid.clear()
  lastReturned.clear()
  editGaps.clear()
  pendingNotes.splice(0)
  doctorNoteDue = null
  await update($, checkAtom, () => null)
  await update($, failureAtom, () => null)
}

/** A main-conversation turn started: the model context may have been compacted, so it is given again. A subagent's turn does not. */
export function newTurnDbtMods(e: { agentId?: string }) {
  if (enabled && !e.agentId) contextGiven.clear()
}

/** The feature's session start (features/index.ts). */
export async function sessionStartDbtMods($: EngineInterface, e: Args<'session.start'>) {
  if (enabled) await startDbtMods($, !!e.isInteractive).catch(error => $.ui.log(`dbt-mods · could not start: ${String(error)}`))
}

/** The feature's band lines, under the lineage one; none when the helpers are off. */
export async function bandDbtMods($: EngineInterface, ui: { Box: any; Button: any; Text: any }): Promise<RenderElement | null> {
  return enabled ? dbtModsBand($, ui) : null
}

/** Registers the helpers' own hooks (their prompt, commands and panes); the tool calls go through the chain's phases above. */
export function registerDbtMods(on: On, context: { options: PluginOptions }) {
  // The dbt helpers can be turned off in the plugin's settings; they run the project's own dbt.
  enabled = (context.options as { dbt_mods?: boolean } | undefined)?.dbt_mods !== false
  const info = (context.options as { info_toasts?: boolean | string } | undefined)?.info_toasts
  infoToasts = info !== false && info !== 'false'
  if (!enabled) return

  // The doctor's findings go with the first prompt after they land.
  on('prompt.submit', async ($, e, next) => {
    if (!doctorNoteDue) return next(e)
    const note = doctorNoteDue
    doctorNoteDue = null
    $.ui.log('dbt-doctor · added to Claude\'s context: the dbt environment check')
    return next({ ...e, context: [...(e.context ?? []), note] })
  })

  on('command.run', { command: SHOW_COMMAND }, async ($, e) => {
    // The conversation that asked, taken before the first wait: a /clear before the query runs keeps its answer out of the new one's pane.
    const asked = generation
    const root = await sessionProject($)
    if (!root) return { text: 'No dbt project here: start Claude Code in a dbt project (a folder with dbt_project.yml).' }
    const args = e.args.trim()
    noteTerminal(e.presentation?.columns)
    const request = await paneRequest($, RESULTS_PANE, RESULTS_SIZES)
    // A /clear while the project or the size was being read ended the conversation that asked: open nothing in the new one.
    if (asked !== generation) return { text: 'The conversation was cleared before the query started; run /dbt-show again.' }
    try {
      await openTracked($, 'dbt_show', () => $.ui.open({ id: RESULTS_PANE, title: RESULTS_TITLE, ...request, focus: true, closeOnEscape: true }))
    } catch (error) {
      return { text: `Could not open the Query results pane: ${String(error)}` }
    }
    if (!args) return { text: 'Query results are open. Run /dbt-show <model> or /dbt-show select … to query.' }
    const isSql = /\s/.test(args) || /^(select|with)\b/i.test(args)
    later($, () => runShow($, root, isSql ? null : args, isSql ? args : null, SHOW_LIMIT, asked))
    return { text: `Running dbt show for ${isSql ? 'your query' : args}; the rows open in the Query results pane.` }
  })

  on('command.run', { command: DOCTOR_COMMAND }, async ($, e) => {
    const asked = generation
    const root = await sessionProject($)
    if (!root) return { text: 'No dbt project here: start Claude Code in a dbt project (a folder with dbt_project.yml).' }
    try {
      await openDoctor($)
    } catch (error) {
      return { text: `Could not open the dbt doctor: ${String(error)}` }
    }
    later($, async () => {
      const view = await runDoctor($, root, true)
      noteDoctor(root, view, asked)
    })
    return { text: 'Checking the dbt environment, the warehouse connection included; the results are in the dbt doctor pane.' }
  })

  on('ui.render', { component: 'Pane', requestId: RESULTS_PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const result = await read($, resultAtom)
    const history = await read($, historyAtom)
    const busy = await read($, resultBusyAtom)
    // The cells across the pane's body, less one for the scrollbar; a row wider than that is clipped, never wrapped.
    const width = Math.max(1, ((e.props as any).bodyColumns ?? 100) - 1)
    const saved = result ? history.find(one => one.id === result.id) : null
    const marks = history.filter(one => one.bookmarked)
    const recent = history.filter(one => !one.bookmarked && one.id !== result?.id).slice(0, HISTORY_SHOWN)
    // Clear history is offered while any query that is not bookmarked is kept, the one shown included.
    const clearable = history.some(one => !one.bookmarked)
    const sizes = await sizeControls($, { Box, Button, Text }, { id: RESULTS_PANE, title: RESULTS_TITLE, spec: RESULTS_SIZES, keyPrefix: 'results', terminal: paneTerminalColumns(e), placement: (e.props as { placement?: string } | undefined)?.placement }, work => later($, work))

    const table = (() => {
      if (!result) return <Text dimColor>Run /dbt-show &lt;model&gt;, or ask Claude to `dbt show` a model.</Text>
      if (result.error) return <Text color="error">{result.error.slice(0, 600)}</Text>
      if (result.rows.length === 0) return <Text dimColor>No rows.</Text>
      const widths = columnWidths(result, width)
      const line = (cells: string[]) => cells.map((cell, i) => cell.padEnd(widths[i]!)).join(' │ ')
      return (
        <Box flexDirection="column">
          <Text bold wrap="truncate-end">{line(result.columns.map((name, i) => cellText(name, widths[i]!)))}</Text>
          <Text dimColor wrap="truncate-end">{widths.map(one => '─'.repeat(one)).join('─┼─')}</Text>
          {result.rows.map((row, r) => (
            <Text key={`row-${r}`} wrap="truncate-end">{line(row.map((cell, i) => cellText(cell, widths[i]!)))}</Text>
          ))}
        </Box>
      )
    })()

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text>
            <Text bold>{result ? result.title : RESULTS_TITLE}</Text>
            {result && !result.error ? (
              <Text dimColor>
                {'  '}
                {result.rows.length} row{result.rows.length === 1 ? '' : 's'} · {result.columns.length} columns{result.ms !== null ? ` · ${(result.ms / 1000).toFixed(1)}s` : ''} · {result.by === 'claude' ? "Claude's dbt show" : 'your query'}
              </Text>
            ) : null}
          </Text>
          {busy ? <Text color="suggestion">{busy}</Text> : null}
          {result ? (
            <Box>
              <Button key="results-bookmark" label={saved?.bookmarked ? '★ Bookmarked' : '☆ Bookmark'} onPress={() => later($, () => toggleBookmark($, result))} />
              {!busy && result.replayable !== false ? <Button key="results-rerun" label="Re-run" onPress={() => { const asked = generation; later($, async () => void (await rerun($, result, asked))) }} /> : null}
              {result.replayable === false ? <Text dimColor>  Re-run is off: Claude's command depended on its shell (variables, `~`, other commands before it)</Text> : null}
            </Box>
          ) : null}
        </Box>
        {sizes}
        {table}
        {marks.length ? (
          <Box flexDirection="column">
            <Text bold>Bookmarks</Text>
            {marks.map(one => (
              <Button key={`mark-${one.id}`} plain label={`★ ${one.title}  (${one.rows.length} rows)`} onPress={() => later($, () => update($, resultAtom, () => one))} />
            ))}
          </Box>
        ) : null}
        {recent.length ? (
          <Box flexDirection="column">
            <Text bold>History</Text>
            {recent.map(one => (
              <Button key={`hist-${one.id}`} plain label={`${one.title}  (${one.error ? 'error' : `${one.rows.length} rows`} · ${one.by === 'claude' ? 'Claude' : 'you'})`} onPress={() => later($, () => update($, resultAtom, () => one))} />
            ))}
          </Box>
        ) : null}
        {clearable ? (
          <Box>
            <Button key="results-clear" label="Clear history" onPress={() => later($, () => clearHistory($))} />
          </Box>
        ) : null}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: CHECK_PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const check = await read($, checkAtom)
    if (!check) return (
      <Box flexDirection="column">
        <Text dimColor>No check yet. The plugin checks a model each time Claude edits it.</Text>
      </Box>
    )
    const color = { running: 'subtle', ok: 'success', partial: 'subtle', warn: 'warning', error: 'error' }[check.status]
    const verdict = {
      running: 'Compiling and running it against the warehouse…',
      ok: check.undocumentedBefore?.length ? 'Compiles and runs; no new gaps with schema.yml (some columns were undocumented before this edit)' : 'Compiles, runs, and its columns match schema.yml',
      partial: check.ran ? `Compiles and runs; columns not compared: ${check.reason}` : `Not checked: ${check.reason}`,
      warn: check.hardcoded?.length ? `Compiles and runs, but names ${check.hardcoded.map(one => one.relation).join(', ')} by table: lineage can't follow it` : 'Compiles and runs, but its columns differ from schema.yml',
      error: 'dbt could not compile or run it',
    }[check.status]
    // The exact names the core compared: a quoted column is not matched without case here.
    const missing = new Set(check.missing)
    const extra = new Set(check.undocumented)
    const before = new Set(check.undocumentedBefore ?? [])
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text>
            <Text bold>Compile & validate · {check.model}</Text>
            <Text dimColor>  {check.file}{check.status !== 'running' ? ` · ${(check.ms / 1000).toFixed(1)}s` : ''}</Text>
          </Text>
          <Text color={color} bold>{verdict}</Text>
        </Box>
        {check.hardcoded?.length ? (
          <Box flexDirection="column">
            <Text bold>Named by table, not ref() or source()</Text>
            {check.hardcoded.map(one => (
              <Text key={`hardcoded-${one.relation}`}>
                <Text color="warning">{one.relation}</Text>
                <Text dimColor>  use </Text>
                <Text>{one.use}</Text>
              </Text>
            ))}
          </Box>
        ) : null}
        {check.errors.length ? (
          <Box flexDirection="column">
            <Text bold>dbt said</Text>
            {check.errors.slice(0, 3).flatMap((one, i) => one.split('\n').filter(line => line.trim()).slice(0, 12).map((line, j) => (
              <Text key={`err-${i}-${j}`} color="error">{line}</Text>
            )))}
          </Box>
        ) : null}
        {check.status === 'ok' || check.status === 'warn' || (check.status === 'partial' && check.returned.length > 0) ? (
          <Box flexDirection="column">
            <Text bold>{check.status === 'partial' ? 'Columns the warehouse returned' : 'Columns · warehouse vs schema.yml'}</Text>
            {check.columns === null ? <Text dimColor>The query returned no row, so its columns could not be read.</Text> : null}
            {check.returned.map(name => (
              <Text key={`col-${name}`}>
                {check.status === 'partial' ? <Text dimColor>· </Text> : before.has(name) ? <Text dimColor>· </Text> : <Text color={extra.has(name) ? 'warning' : 'success'}>{extra.has(name) ? '+ ' : '✓ '}</Text>}
                <Text>{name}</Text>
                {extra.has(name) ? <Text dimColor>  returned, not documented</Text> : before.has(name) ? <Text dimColor>  not documented, from before this edit</Text> : null}
              </Text>
            ))}
            {check.documented.filter(name => missing.has(name)).map(name => (
              <Text key={`miss-${name}`}>
                <Text color="error">- </Text>
                <Text>{name}</Text>
                <Text dimColor>  documented, not returned</Text>
              </Text>
            ))}
          </Box>
        ) : null}
        {check.status !== 'running' ? (
          <Box>
            <Button key="check-again" label="Check again" onPress={() => later($, async () => void (await compileAndValidate($, check.root, `${check.root}/${check.file}`)))} />
          </Box>
        ) : null}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: DOCTOR_PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const doctor = await read($, doctorAtom)
    if (!doctor) return (
      <Box flexDirection="column">
        <Text dimColor>No dbt project checked yet. Run /dbt-doctor in a dbt project.</Text>
      </Box>
    )
    const color = { ok: 'success', warn: 'warning', fail: 'error' } as const
    const icon = { ok: '✓', warn: '⚠', fail: '✖' } as const
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>dbt environment</Text>
          <Text dimColor>{doctor.root}</Text>
          {doctor.busy ? <Text color="suggestion">{doctor.busy}</Text> : null}
        </Box>
        <Box flexDirection="column">
          {doctor.checks.map(one => (
            <Text key={`check-${one.id}`}>
              <Text color={color[one.status]}>{icon[one.status]} {one.label.padEnd(11)}</Text>
              <Text>{one.detail}</Text>
              {one.fix ? <Text dimColor>  → {one.fix}</Text> : null}
            </Text>
          ))}
        </Box>
        {!doctor.busy ? (
          <Box>
            {doctor.checks.some(one => one.id === 'manifest' && one.status !== 'ok') ? <Button key="doctor-parse" label="Run dbt parse" onPress={() => later($, () => parseNow($, doctor.root))} /> : null}
            <Button key="doctor-connection" label="Test connection" onPress={() => later($, async () => void (await runDoctor($, doctor.root, true)))} />
            <Button key="doctor-recheck" label="Check again" onPress={() => later($, async () => void (await runDoctor($, doctor.root)))} />
          </Box>
        ) : null}
      </Box>
    )
  })
}

// Where a shell command runs: the session folder, moved by each `cd` before it (the parser lists them).
function cdTarget(cds: (string | null)[], cwd: string): string | null {
  let dir = cwd
  for (const target of cds) {
    if (target === null) return null
    dir = target.startsWith('/') ? target : `${dir.replace(/\/+$/, '')}/${target}`
  }
  return normalize(dir)
}
