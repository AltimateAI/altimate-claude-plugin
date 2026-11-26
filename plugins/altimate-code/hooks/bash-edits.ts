// Shell commands that write dbt model files: the command's writes are found by the model files it changed, not by
// reading its words. Both halves of the plugin (the lineage note and the compile & validate check) use it.
import type { EngineInterface } from 'claude-code'
import { projectLayout } from './lineage-graph'
import { normalize } from './package-runner'

export { normalize }

const dirname = (path: string) => path.replace(/[\\/][^\\/]*$/, '') || path

/** The dbt project above a file or folder: the closest folder holding dbt_project.yml. */
export async function projectRoot($: EngineInterface, start: string, isFile: boolean): Promise<string | null> {
  // Spelled one way (`integration_tests/../models` is `models`), so a project is one root whichever path reached it.
  let dir = normalize(isFile ? dirname(start) : start)
  for (let i = 0; i < 40; i++) {
    if (await $.fs.exists(`${dir}/dbt_project.yml`).catch(() => false)) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

// Folders never holding a project of the session's own: installed packages, builds, environments.
export const SKIP_DIRS = new Set(['node_modules', 'dbt_packages', 'dbt_modules', 'target', 'venv', 'site-packages', 'dist', 'build'])

// Per folder, until a refresh, a dbt_project.yml edit, or a new conversation.
const projectsCache = new Map<string, Promise<string[]>>()
const MAX_DIRS = 2000
/** Forgets the projects found below each folder: the next ask walks again. */
export function forgetProjects() {
  projectsCache.clear()
}
/** dbt projects under a folder (a monorepo's root), a few levels down, at most 2000 folders, 16 at a time. */
export function projectsBelow($: EngineInterface, start: string, depth = 4): Promise<string[]> {
  const cached = projectsCache.get(start)
  if (cached) return cached
  const walk = async () => {
    const found: string[] = []
    let level = [start]
    let seen = 0
    for (let d = 0; d <= depth && level.length > 0; d++) {
      const next: string[] = []
      for (let i = 0; i < level.length && seen < MAX_DIRS; i += 16) {
        const chunk = level.slice(i, Math.min(i + 16, i + MAX_DIRS - seen))
        seen += chunk.length
        await Promise.all(
          chunk.map(async dir => {
            if (await $.fs.exists(`${dir}/dbt_project.yml`).catch(() => false)) return void found.push(dir)
            if (d === depth) return
            for (const entry of await $.fs.list(dir).catch(() => [])) {
              if (entry.kind === 'dir' && !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) next.push(`${dir}/${entry.name}`)
            }
          }),
        )
      }
      level = next
    }
    return found.sort()
  }
  const started = walk()
  projectsCache.set(start, started)
  return started
}

// Where a shell command reads from: the session folder, moved by each `cd` in the command. Blanks after a
// separator stop at any line break, which starts a line itself, so a long run of blank lines is read once, not once per line.
const CD = /(?:^|[;&|(\n\r\u2028\u2029][^\S\n\r\u2028\u2029]*)cd\s+("[^"]+"|'[^']+'|[^\s;&|)]+)/gm
export function commandDir(command: string, cwd: string): string {
  let dir = cwd
  for (const match of command.matchAll(CD)) {
    const target = match[1]!.replace(/^['"]|['"]$/g, '')
    dir = target.startsWith('/') ? target : `${dir}/${target}`
  }
  return normalize(dir)
}

// A shell command that may write the SQL files it names (`sed -i`, a redirect, `tee`, a script).
export const WRITES = /\bsed\b[^|;&]*\s-i|\bperl\b[^|;&]*\s-\w*i|>>?\s*['"]?[^\s'"|;&]*\.sql\b|\btee\b|\b(?:python3?|node|ruby|bun|deno)\b|\b(?:mv|cp|patch|truncate)\b|\bgit\s+(?:apply|checkout|restore)\b/
// The most model files one shell command's note is about, and the most projects below the session folder looked in.
export const MAX_BASH_MODELS = 3
const MAX_BASH_PROJECTS = 5
// A file's time can trail the clock read as the command started by this much.
export const MTIME_SLACK_MS = 1_000

/** A shell command that may write, as it started: where it runs and when, to find the model files it changed after. */
export type BashStart = { command: string; startedAt: number }

/** The project's model files a shell command changed: modified since it started, with their text from the last commit. */
export async function bashChanged($: EngineInterface, start: BashStart): Promise<{ file: string; before: string }[]> {
  // From the session's folder, as the task summary reads it: Claude's shell folder can be slow to read, and this
  // holds the command's result. With no project there, the projects below it (a monorepo, a shell in a subfolder).
  const base = await $.session.root().catch(() => '.')
  const own = await projectRoot($, commandDir(start.command, base), false).catch(() => null)
  // And the projects below it (a project inside another, a monorepo): the walk is bounded (2000 folders) and kept for the session.
  // projectsBelow stops at a project: below one, its sub-folders are walked (a few levels) for the projects inside it.
  const children = own ? (await $.fs.list(own).catch(() => [])).filter(entry => entry.kind === 'dir' && !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)).map(entry => `${own}/${entry.name}`) : [base]
  const below = (await Promise.all(children.slice(0, 50).map(dir => projectsBelow($, dir, own ? 2 : 4).catch(() => [] as string[])))).flat().filter(one => one !== own)
  const roots = [...(own ? [own] : []), ...below].slice(0, MAX_BASH_PROJECTS)
  // Files touched since the command started, in whole minutes rounded up, then each one's own time against its start.
  const minutes = Math.max(1, Math.ceil(((await $.clock.now()) - start.startedAt) / 60_000))
  const files: { file: string; before: string }[] = []
  for (const root of roots) {
    const models = projectLayout(await $.fs.read(`${root}/dbt_project.yml`).catch(() => '')).models.map(one => one.replace(/^\.\//, '').replace(/\/+$/, '')).filter(Boolean)
    const dirs = models.map(one => (one === '.' ? root : `${root}/${one}`))
    if (!dirs.length) continue
    const listed = await $.process.run(['find', ...dirs, '-name', '*.sql', '-type', 'f', '-mmin', `-${minutes}`], { timeoutMs: 10_000 }).catch(() => null)
    const found = (listed?.stdout ?? '').split('\n').map(one => one.trim()).filter(Boolean)
    // Nothing touched: no git call either.
    if (!found.length) continue
    const top = (await $.process.run(['git', '-C', root, 'rev-parse', '--show-toplevel'], { timeoutMs: 5_000 }).catch(() => null))?.stdout.trim() ?? ''
    for (const file of found) {
      if (files.length >= MAX_BASH_MODELS) return files
      if (/[\\/](?:target|dbt_packages|dbt_modules)[\\/]/.test(file.slice(root.length)) || !isModelPath(root, models, file)) continue
      const stat = await $.fs.stat(file).catch(() => null)
      if (!stat || stat.mtimeMs < start.startedAt) continue
      // Its text before: the last commit's (an untracked file had none).
      const head = top && file.startsWith(`${top}/`) ? await $.process.run(['git', '-C', top, 'show', `HEAD:${file.slice(top.length + 1)}`], { timeoutMs: 5_000 }).catch(() => null) : null
      files.push({ file, before: head?.exitCode === 0 ? head.stdout : '' })
    }
  }
  return files
}

/** Whether a file is under one of the project's model folders. */
export function isModelPath(root: string, models: string[], file: string): boolean {
  const rel = file.slice(root.length + 1)
  return file.startsWith(`${root}/`) && /\.sql$/i.test(rel) && models.some(one => one === '.' || rel.startsWith(`${one}/`))
}
