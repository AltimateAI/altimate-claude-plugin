// A dbt package repo (Tuva, dbt_utils) is run from the project below it that installs it by a local path
// (`integration_tests`): its packages are installed there, and dbt writes the manifest there. The dbt helpers run
// dbt in that project; the lineage half reads the manifest it writes when the package has none of its own.
import type { EngineInterface } from 'claude-code'

/** `a/./b/../c` → `a/c`: two spellings of one folder are one project, one queue, one identity. */
export function normalize(path: string): string {
  const out: string[] = []
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (part === '.' || (part === '' && out.length > 0)) continue
    if (part === '..' && out.length > 1 && out[out.length - 1] !== '..') out.pop()
    else out.push(part)
  }
  return out.join('/') || '/'
}

/** The project's name in its dbt_project.yml; null when it has none. */
export async function projectName($: EngineInterface, root: string): Promise<string | null> {
  return /^name:\s*['"]?([\w-]+)/m.exec(await $.fs.read(`${root}/dbt_project.yml`).catch(() => ''))?.[1] ?? null
}

// The project below a package's folder that installs it, by package folder: found once a session.
const runners = new Map<string, Promise<string | null>>()

/**
 * A dbt project in a folder below `root`, a level or two down (a package's `integration_tests`), whose
 * packages.yml or dependencies.yml installs `root` itself by a local path (`local: ../`). That is where dbt is run
 * for a package repo: its packages are installed there, not in the package's own folder.
 */
export function runnerOf($: EngineInterface, folder: string): Promise<string | null> {
  // `/repo/integration_tests/..` (a shell read through `../`) is `/repo`.
  const root = normalize(folder)
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
 * The manifest the lineage half reads for the project at `root`: its own `target/manifest.json`, else, for a package
 * repo with none, the one dbt wrote in the project below that installs it (`integration_tests/target/manifest.json`),
 * whose nodes for the package keep their paths relative to the package. The project's own path when neither exists.
 */
export async function manifestFile($: EngineInterface, folder: string): Promise<string> {
  const root = normalize(folder)
  const own = `${root}/target/manifest.json`
  if (await $.fs.exists(own).catch(() => false)) return own
  const theirs = await runnerManifest($, root)
  return theirs && (await $.fs.exists(theirs).catch(() => false)) ? theirs : own
}

/**
 * Whether the manifest the project at `root` reads holds another local project's models beside its own, so a bare
 * model name may be either's: a package repo reading integration_tests' manifest, or a project that installs a package
 * by a local path (integration_tests itself), whose manifest holds that package's models.
 */
export async function sharesManifest($: EngineInterface, root: string, manifest: string): Promise<boolean> {
  if (!manifest.startsWith(`${root}/`) || manifest.slice(root.length + 1).split('/').length > 2) return true
  const declared = `${await $.fs.read(`${root}/packages.yml`).catch(() => '')}\n${await $.fs.read(`${root}/dependencies.yml`).catch(() => '')}`
  return /^\s*-?\s*local:\s*\S/m.test(declared)
}

/** Where the project below a package repo that installs it writes its manifest; null when there is no such project. */
export async function runnerManifest($: EngineInterface, root: string): Promise<string | null> {
  const runner = await runnerOf($, root).catch(() => null)
  return runner ? `${runner}/target/manifest.json` : null
}
