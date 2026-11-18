// Docs coverage and description propagation.
//
// After Claude writes a column description in a model's YAML, the columns downstream that carry the
// same value are looked up (impact_analysis, column reach) and offered as copies: a line under the
// edit, a band line, and a /propagate pane with one button per column. Only a column that is the
// traced one carried as is, or only renamed (lens Original or Alias), is offered; a calculation
// from it is not. After Claude edits a model's SQL, the model's documentation coverage is shown.
import { atom, read, update } from 'claude-code'
import type { Args, EngineInterface, EventResult, On, RenderElement, ToolCallResult } from 'claude-code'

import type { DocsCandidate, DocsCoverageView, DocsGroup, DocsState } from '../../types'
import { later, runTool } from '../altimate-cli'
import { setStatusPart } from '../status-line'
import type { BashCall, ContextLines, EditedFile, FileCall } from '../tool-chain'
import type { BandUi, FeatureContext } from './index'

const PANE = 'altimate-docs'
const PANE_TITLE = 'Altimate docs'
const COMMAND = 'propagate'
// What an edit waits for the column reach of the descriptions it wrote; the edit goes ahead after.
export const ROUND_MS = 3_500
// The most descriptions one edit traces.
const MAX_COLUMNS = 3
// The most pending descriptions the pane keeps.
const MAX_GROUPS = 10
// The most names a context line spells out.
const MAX_NAMES = 6
// The most downstream columns one description offers, so the request and the pane stay a size Claude can take.
const MAX_CANDIDATES = 50

/** The lens types Power User's propagation keeps: a transformation is not the same value. */
const COPYABLE = new Set(['Original', 'Alias'])

const docsAtom = atom({ plugin: 'altimate-code', key: 'docs' } as const, null as DocsState | null)

// Said once a session: the installed altimate-code lacks what this feature reads.
let saidOldReach = false
let saidOldCoverage = false
// Columns the pane's Apply asked Claude to write a description for, with the description asked for, so that
// writing is not offered again (once each, and only that text: a different description written to the same
// column later is a new one; whatever Apply's turn does not write stays until the session starts again).
const applied = new Map<string, string>()
// An Apply whose request is still being sent; a second press is ignored.
let applying = false
/** Whether this feature has put a part in the status line, so a session start clears it only then. */
let statusShown = false

const groupKey = (manifest: string, model: string, column: string) => `${manifest}|${model}.${column}`
/** Names one offer: the column and the description written to it. */
const offerKey = (group: DocsGroup) => `${groupKey(group.manifest, group.model, group.column)}|${group.description}`
// The reach names columns in lower case, so what Apply asked for is looked up the same way.
const appliedKey = (manifest: string, model: string, column: string) => groupKey(manifest, model, column).toLowerCase()

const empty = (): DocsState => ({ groups: [], skipped: [], coverage: null })

// ---------------------------------------------------------------------------------------------------
// Reading descriptions out of a model YAML file
// ---------------------------------------------------------------------------------------------------

const collapse = (text: string) => text.replace(/\s+/g, ' ').trim()
const indentOf = (line: string) => line.length - line.trimStart().length

/** The text of a plain or quoted value written on one line, without its trailing comment. */
function inlineValue(rest: string): string {
  const text = rest.trim()
  const quote = text[0]
  if (quote === '"' || quote === "'") {
    let out = ''
    for (let i = 1; i < text.length; i++) {
      const ch = text[i]!
      if (quote === '"' && ch === '\\' && i + 1 < text.length) {
        const next = text[++i]!
        out += next === 'n' ? ' ' : next === 't' ? ' ' : next
      } else if (quote === "'" && ch === "'" && text[i + 1] === "'") {
        out += "'"
        i++
      } else if (ch === quote) {
        return out
      } else {
        out += ch
      }
    }
    return out
  }
  return text.replace(/\s+#.*$/, '')
}

/**
 * The value of the key whose text starts at `rest` on `lines[at]`, and the index of the last line it
 * covers: a block scalar (`>`, `|`), a quoted or plain value that carries on over more lines, or a
 * one-line value.
 */
function valueAt(lines: string[], at: number, keyIndent: number, rest: string): { value: string; last: number } {
  const head = rest.trim()
  const continues = (i: number) => i < lines.length && (lines[i]!.trim() === '' || indentOf(lines[i]!) > keyIndent)
  if (/^[>|][+-]?\d*(\s+#.*)?$/.test(head)) {
    const parts: string[] = []
    let last = at
    for (let i = at + 1; continues(i); i++) {
      parts.push(lines[i]!.trim())
      if (lines[i]!.trim() !== '') last = i
    }
    return { value: collapse(parts.join(head[0] === '|' ? '\n' : ' ')), last }
  }
  const quote = head[0]
  if (quote === '"' || quote === "'") {
    // A quoted value is closed by its quote; one that is not closed on its line carries on.
    let text = head
    let last = at
    const closed = (s: string) => {
      for (let i = 1; i < s.length; i++) {
        if (s[i] === '\\' && quote === '"') i++
        else if (s[i] === quote && !(quote === "'" && s[i + 1] === "'")) return true
        else if (s[i] === quote) i++
      }
      return false
    }
    while (!closed(text) && last + 1 < lines.length) text += ' ' + lines[++last]!.trim()
    return { value: collapse(inlineValue(text)), last }
  }
  let text = inlineValue(head)
  let last = at
  // A plain value runs on over the lines indented more than its key.
  // A blank line inside it is a paragraph break, not its end: it goes on while the next text line is still indented.
  for (let i = at + 1; i < lines.length; i++) {
    if (lines[i]!.trim() === '') continue
    if (indentOf(lines[i]!) <= keyIndent) break
    text += ' ' + inlineValue(lines[i]!)
    last = i
  }
  return { value: collapse(text), last }
}

/**
 * The column descriptions a model YAML file writes, keyed `model.column`, each as one line of text.
 * Block-style YAML as dbt's schema files are written; a model or column without a description is
 * left out. The text is for telling whether a description changed and for showing it: what gets
 * copied is read from the file by Claude, so line breaks and escapes need not survive here.
 */
export function columnDescriptions(yaml: string): Map<string, string> {
  return new Map(describedColumns(yaml).map(one => [`${one.model}.${one.column}`, one.description]))
}

/** The same descriptions with the model and the column kept apart, as a name may itself hold a dot. */
function describedColumns(yaml: string): { model: string; column: string; description: string }[] {
  const out: { model: string; column: string; description: string }[] = []
  const lines = yaml.replace(/\r\n?/g, '\n').split('\n')
  let inModels = false
  let modelDash = -1
  let modelOpen = false
  let model: string | null = null
  let modelKey = -1
  let modelFrom = 0
  let inColumns = false
  let columnDash = -1
  let columnOpen = false
  let column: string | null = null
  let columnKey = -1
  let described: string | null = null
  const nameOf = inlineValue
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!
    const body = raw.trim()
    if (body === '' || body.startsWith('#')) continue
    const indent = indentOf(raw)
    if (indent === 0 && !body.startsWith('-')) {
      inModels = /^models\s*:\s*(#.*)?$/.test(body)
      modelDash = -1
      modelOpen = columnOpen = inColumns = false
      model = column = null
      continue
    }
    if (!inModels) continue

    // A list item starts a model or a column whatever key it opens with: `name` need not come first.
    const dash = /^-(?:\s+(.*))?$/.exec(body)
    const text = dash ? (dash[1] ?? '') : body
    let at = dash ? indent + body.length - text.length : indent
    if (dash && text === '') {
      // A bare `-` holds its item on the lines below: the item's keys sit where the next line starts.
      let next = i + 1
      while (next < lines.length && (lines[next]!.trim() === '' || lines[next]!.trim().startsWith('#'))) next++
      if (next < lines.length && indentOf(lines[next]!) > indent) at = indentOf(lines[next]!)
    }
    if (dash && (modelDash < 0 || indent === modelDash)) {
      modelDash = indent
      modelKey = at
      modelOpen = true
      model = null
      modelFrom = out.length
      inColumns = false
      columnOpen = false
      column = null
      described = null
    } else if (dash && modelOpen && inColumns && indent > modelDash && (columnDash < 0 || indent === columnDash)) {
      columnDash = indent
      columnKey = at
      columnOpen = true
      column = null
      described = null
    }
    const key = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(text)
    if (!key || !modelOpen) continue
    if (at === modelKey) {
      if (key[1] === 'name') {
        // The name can come after the columns: what was read for this model so far takes it.
        model = nameOf(key[2]!)
        for (let j = modelFrom; j < out.length; j++) out[j]!.model = model
      } else {
        // A key of the model itself: `columns:` opens the column list; any other ends the column in hand.
        columnOpen = false
        column = null
        described = null
        inColumns = key[1] === 'columns'
        if (inColumns) columnDash = -1
      }
    } else if (inColumns && columnOpen && at === columnKey) {
      if (key[1] === 'name') {
        column = nameOf(key[2]!)
        if (described) out.push({ model: model ?? '', column, description: described })
        described = null
      } else if (key[1] === 'description') {
        const { value, last } = valueAt(lines, i, at, key[2]!)
        if (value) {
          if (column !== null) out.push({ model: model ?? '', column, description: value })
          else described = value
        }
        i = last
      }
    }
  }
  return out.filter(one => one.model !== '')
}

/** The descriptions `after` writes that `before` did not (new or changed), `before` being null for a file that did not exist. */
export function changedDescriptions(before: string | null, after: string): { model: string; column: string; description: string }[] {
  const was = before === null ? new Map<string, string>() : columnDescriptions(before)
  return describedColumns(after).filter(one => was.get(`${one.model}.${one.column}`) !== one.description)
}

/** The folders a dbt_project.yml names as holding models; `models` when it names none. */
export function modelPaths(projectYaml: string): string[] {
  const lines = projectYaml.replace(/\r\n?/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const match = /^(?:model-paths|source-paths)\s*:\s*(.*)$/.exec(lines[i]!)
    if (!match) continue
    const rest = match[1]!.replace(/\s+#.*$/, '').trim()
    const names: string[] = []
    if (rest.startsWith('[')) {
      for (const one of rest.replace(/^\[|\]$/g, '').split(',')) names.push(one.trim().replace(/^["']|["']$/g, ''))
    } else if (rest === '') {
      for (let j = i + 1; j < lines.length && (/^\s*(?:#.*)?$/.test(lines[j]!) || /^\s*-\s+/.test(lines[j]!)); j++) if (/^\s*-\s+/.test(lines[j]!)) names.push(lines[j]!.replace(/^\s*-\s+/, '').replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, ''))
    }
    const kept = names.filter(Boolean)
    if (kept.length) return kept
  }
  return ['models']
}

// ---------------------------------------------------------------------------------------------------
// What the column reach says
// ---------------------------------------------------------------------------------------------------

/**
 * The columns downstream of a traced column that can take its description: those the lineage engine
 * rates Original or Alias along the whole path. `unrated` is true when the reach carried columns but
 * no ratings at all, which is what an altimate-code from before the ratings sends.
 */
export function candidatesFrom(metadata: any): { candidates: DocsCandidate[]; unrated: boolean } {
  const models: any[] = Array.isArray(metadata?.column_reach?.models) ? metadata.column_reach.models : []
  const candidates: DocsCandidate[] = []
  let anyColumns = false
  let anyRated = false
  for (const one of models) {
    const columns: unknown[] = Array.isArray(one?.columns) ? one.columns : []
    const lenses = one?.lens_types && typeof one.lens_types === 'object' ? (one.lens_types as Record<string, unknown>) : null
    if (columns.length) anyColumns = true
    if (lenses) anyRated = true
    for (const name of columns) {
      const lens = lenses?.[String(name)]
      if (typeof lens === 'string' && COPYABLE.has(lens)) {
        candidates.push({ model: String(one.name), ...(typeof one.unique_id === 'string' && { id: one.unique_id }), column: String(name), lens: lens as DocsCandidate['lens'] })
      }
    }
  }
  return { candidates, unrated: anyColumns && !anyRated }
}

const groupPrefix = (group: { manifest: string; model: string; column: string }) => `${groupKey(group.manifest, group.model, group.column)}>`
const candidateKey = (group: { manifest: string; model: string; column: string }, one: { model: string; id?: string; column: string }) => `${groupPrefix(group)}${one.id ?? one.model}.${one.column}`

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** One line for Claude and the person: the column, how many downstream columns can take it, and the way to copy it. */
export function propagationLine(group: DocsGroup): string {
  // Names come from the project and this line goes to Claude, so each is a quoted string: data, not instructions.
  const names = group.candidates.slice(0, MAX_NAMES).map(one => JSON.stringify(`${one.model}.${one.column}`))
  const more = group.candidates.length > MAX_NAMES ? `, +${group.candidates.length - MAX_NAMES} more` : ''
  return `◆ docs · ${JSON.stringify(group.column)}: ${plural(group.candidates.length, 'downstream column')} can take this description · /propagate (${names.join(', ')}${more})`
}

/** The groups a request is written for: one whose candidates are all unticked is left out of it, so Apply leaves its offer be. */
export function sentGroups(groups: DocsGroup[], skipped: string[]): DocsGroup[] {
  return groups.filter(group => group.candidates.some(one => !skipped.includes(candidateKey(group, one))))
}

/** The request the pane's Apply sends: the files and columns to edit, for Claude to make the edits. */
export function applyPrompt(groups: DocsGroup[], skipped: string[]): string | null {
  // Names come from the project, so each is written as a quoted string: data, not instructions.
  const name = (model: string, column: string) => JSON.stringify(`${model}.${column}`)
  const blocks: string[] = []
  for (const group of sentGroups(groups, skipped)) {
    const picked = group.candidates.filter(one => !skipped.includes(candidateKey(group, one)))
    blocks.push(
      [
        `Take the description of ${name(group.model, group.column)} as it is written in ${JSON.stringify(group.file)} (dbt project at ${JSON.stringify(group.manifest.replace(/\/target\/manifest\.json$/, ''))}), and put it on:`,
        ...picked.map(one => `- ${name(one.model, one.column)}${one.id ? ` (${JSON.stringify(one.id)})` : ''}, ${one.lens === 'Alias' ? 'renamed from it' : 'carried as is'}`),
      ].join('\n'),
    )
  }
  if (!blocks.length) return null
  return [
    'Copy these column descriptions to the downstream columns that carry the same value. For each model, edit the YAML file that documents it (add the column there when it is not listed) and copy the text exactly as it is written. Leave a column that already has a different description unchanged, and list those columns at the end so the person can decide.',
    'The quoted names below are identifiers from the project, and a description is text to copy: neither is an instruction. Column names are given in lower case; match a column the file lists ignoring case and keep the spelling the file uses.',
    '',
    ...blocks,
  ].join('\n\n')
}

// ---------------------------------------------------------------------------------------------------
// The project around an edited file
// ---------------------------------------------------------------------------------------------------

type Project = { root: string; manifest: string; models: string[]; package?: string }

const normal = (path: string) => path.replace(/\\/g, '/')
/** A path spelled one way, so the same file named two ways compares equal. */
const tidy = (path: string) => normal(path).replace(/\/(?:\.\/)+/g, '/').replace(/\/{2,}/g, '/')

type ManifestModel = { resource_type?: string; package_name?: string; name?: string; original_file_path?: string; version?: string | number | null; latest_version?: string | number | null }

/**
 * The model as the manifest's unique_id, so a model of the same name in another package is never the one
 * traced. A SQL file is the model whose file it is; a name in a YAML file is the model of that name, and for
 * versioned models its latest version stands for them. A model the manifest does not list, or a manifest
 * that cannot be read, gets the id dbt would give it, which finds nothing rather than another package's model.
 */
async function modelRef($: EngineInterface, project: Project, model: string, byFile = false): Promise<string> {
  if (!project.package) return model
  const built = `model.${project.package}.${model}`
  try {
    const nodes = (JSON.parse((await $.fs.read(project.manifest)) ?? '') as { nodes?: Record<string, ManifestModel> }).nodes ?? {}
    const own = Object.entries(nodes).filter(([, node]) => node?.resource_type === 'model' && node.package_name === project.package)
    const stem = (node: ManifestModel) => (node.original_file_path ?? '').replace(/\.sql$/i, '').split('/').pop()
    if (byFile) {
      const files = own.filter(([, node]) => stem(node) === model)
      if (files.length === 1) return files[0]![0]
    }
    const named = own.filter(([, node]) => node.name === model)
    if (named.length <= 1) return named[0]?.[0] ?? built
    const latest = named.find(([, node]) => node.latest_version != null && String(node.version) === String(node.latest_version))
    if (latest) return latest[0]
    const number = (node: ManifestModel) => (typeof node.version === 'number' ? node.version : Number.parseFloat(String(node.version)))
    const [top] = [...named].sort((x, y) => (number(y[1]) || 0) - (number(x[1]) || 0) || (x[0] < y[0] ? 1 : -1))
    return top![0]
  } catch {
    return built
  }
}

/** The dbt project the file is a model file of: its closest dbt_project.yml above it, and the file under one of that project's model folders. */
async function projectOf($: EngineInterface, file: string): Promise<Project | null> {
  const path = normal(file)
  let dir = path.slice(0, path.lastIndexOf('/'))
  for (let guard = 0; dir && guard < 40; guard++) {
    if (await $.fs.exists(`${dir}/dbt_project.yml`).catch(() => false)) {
      const text = await $.fs.read(`${dir}/dbt_project.yml`).catch(() => '')
      const folders = modelPaths(text ?? '')
      const under = folders.some(folder => {
        const name = folder.replace(/^(?:\.\/+)+/, '').replace(/\/+$/, '')
        // `.` is the project's own folder, less what dbt builds into it.
        if (name === '' || name === '.') return path.startsWith(`${dir}/`) && !/^(?:target|dbt_packages|dbt_modules|node_modules|venv|site-packages|dist|build|\.[^/]+)\//.test(path.slice(dir.length + 1))
        return path.startsWith(`${dir}/${name}/`)
      })
      const pkg = /^name:\s*['"]?([A-Za-z0-9_]+)['"]?\s*(?:#.*)?$/m.exec(text ?? '')?.[1]
      return under ? { root: dir, manifest: `${dir}/target/manifest.json`, models: folders, ...(pkg && { package: pkg }) } : null
    }
    const up = dir.slice(0, dir.lastIndexOf('/'))
    if (up === dir) break
    dir = up
  }
  return null
}

// ---------------------------------------------------------------------------------------------------
// After an edit
// ---------------------------------------------------------------------------------------------------

// Only a message about the tool itself: "model not found" is the model's.
const MISSING_TOOL = /unknown tool|no such tool|invalid tool|dbt_docs_coverage[^\n]*not (?:an? )?(?:exposed|available|found|registered)/i

async function schemaEdited($: EngineInterface, file: EditedFile, created: boolean): Promise<string[]> {
  const project = await projectOf($, file.path)
  if (!project) return []
  const after = await $.fs.read(file.path).catch(() => null)
  // A file that is gone writes nothing, so what was offered from it no longer holds.
  const written = columnDescriptions(after ?? '')
  // A before-text that could not be read says nothing about what changed: no offer rather than every description.
  // An Edit replaces text that was in the file, so a missing before-text there is a failed read, not a new file.
  const unknown = (file as { beforeUnknown?: boolean }).beforeUnknown === true || (file.before === null && !created)
  const fresh = after === null || unknown ? [] : changedDescriptions(file.before, after)
  // Writing the description Apply asked for is the copy being made, not a new description to offer;
  // any other text written to that column is a new description.
  const all = fresh.filter(one => {
    const key = appliedKey(project.manifest, one.model, one.column)
    const asked = applied.get(key)
    if (asked === undefined) return true
    applied.delete(key)
    return asked !== one.description
  })
  const changed = all.slice(0, MAX_COLUMNS)
  const replaced = new Set(all.map(one => groupKey(project.manifest, one.model, one.column)))
  // What was offered from this file for a description that has changed or gone no longer holds.
  await update($, docsAtom, prev => {
    if (!prev) return prev
    const groups = prev.groups.filter(g => !(g.file === tidy(file.path) && written.get(`${g.model}.${g.column}`) !== g.description) && !replaced.has(groupKey(g.manifest, g.model, g.column)))
    return groups.length === prev.groups.length ? prev : { ...prev, groups, skipped: prev.skipped.filter(key => groups.some(g => key.startsWith(groupPrefix(g)))) }
  })
  await showStatus($)
  if (!changed.length) return []
  if (!(await $.fs.exists(project.manifest).catch(() => false))) {
    return ['◆ docs · no target/manifest.json: run `dbt compile` so the downstream columns of a description can be found']
  }

  const until = (await $.clock.now()) + ROUND_MS
  const traced = await Promise.all(
    changed.map(async one => {
      const result = await runTool($, 'impact_analysis', { manifest_path: project.manifest, model: await modelRef($, project, one.model), column: one.column, change_type: 'modify' }, { until, cliOnly: true }).catch(() => null)
      return { one, result }
    }),
  )
  // The answers can be late: only a description that is still the file's is offered.
  const now = columnDescriptions((await $.fs.read(file.path).catch(() => null)) ?? '')

  const groups: DocsGroup[] = []
  const lines: string[] = []
  for (const { one, result } of traced) {
    if (now.get(`${one.model}.${one.column}`) !== one.description) continue
    if (result && (!result.ok || !result.metadata)) {
      lines.push(`◆ docs · could not find the downstream columns of ${JSON.stringify(`${one.model}.${one.column}`)}: altimate-code did not give an answer to copy from`)
      continue
    }
    if (!result?.metadata) continue
    const found = candidatesFrom(result.metadata)
    const { unrated } = found
    const candidates = found.candidates.slice(0, MAX_CANDIDATES)
    if (found.candidates.length > candidates.length) lines.push(`◆ docs · ${plural(found.candidates.length - candidates.length, 'more downstream column')} of ${JSON.stringify(`${one.model}.${one.column}`)} ${found.candidates.length - candidates.length === 1 ? 'is' : 'are'} not offered`)
    if (unrated && !saidOldReach) {
      saidOldReach = true
      lines.push('◆ docs · this altimate-code does not rate how each downstream column comes from the traced one (needs a release newer than 0.12.10), so no description can be offered to copy')
    }
    if (!candidates.length) continue
    groups.push({ model: one.model, column: one.column, description: one.description, manifest: project.manifest, file: tidy(file.path), candidates })
  }
  if (groups.length) {
    await update($, docsAtom, prev => {
      const state = prev ?? empty()
      const replaced = new Set(groups.map(g => groupKey(g.manifest, g.model, g.column)))
      const kept = state.groups.filter(g => !replaced.has(groupKey(g.manifest, g.model, g.column)))
      const all = [...kept, ...groups].slice(-MAX_GROUPS)
      return { ...state, groups: all, skipped: state.skipped.filter(key => all.some(g => key.startsWith(groupPrefix(g)))) }
    })
    await showStatus($)
    for (const group of groups) lines.push(propagationLine(group))
  }
  if (all.length > changed.length) lines.push(`◆ docs · ${plural(all.length - changed.length, 'more description')} written; only the first ${MAX_COLUMNS} were traced for downstream columns`)
  return lines
}

async function sqlEdited($: EngineInterface, file: EditedFile): Promise<string[]> {
  const project = await projectOf($, file.path)
  if (!project) return []
  const model = normal(file.path).split('/').pop()!.replace(/\.sql$/i, '')
  if (!(await $.fs.exists(project.manifest).catch(() => false))) return []
  const until = (await $.clock.now()) + ROUND_MS
  const result = await runTool($, 'dbt_docs_coverage', { model: await modelRef($, project, model, true), manifest_path: project.manifest }, { until, cliOnly: true }).catch(() => null)
  if (!result) return []
  const meta = result.metadata
  if (!result.ok || !meta || meta.success !== true) {
    if (MISSING_TOOL.test(result.text) && !saidOldCoverage) {
      saidOldCoverage = true
      return ['◆ docs · this altimate-code has no dbt_docs_coverage (needs a release newer than 0.12.10)']
    }
    return []
  }
  const view: DocsCoverageView = {
    model: typeof meta.model === 'string' && meta.model ? meta.model : model,
    percent: Number.isFinite(Number(meta.percent)) ? Number(meta.percent) : 0,
    documented: Array.isArray(meta.documented) ? meta.documented.length : 0,
    total: Array.isArray(meta.output_columns) ? meta.output_columns.length : 0,
    missing: Array.isArray(meta.missing) ? meta.missing.map(String) : [],
    hasDescription: meta.has_description === true,
  }
  await update($, docsAtom, prev => ({ ...(prev ?? empty()), coverage: view }))
  await showStatus($)
  const gaps = [...(view.hasDescription ? [] : ['the model itself']), ...view.missing]
  // A select list that is not plain column names (a `*`, an unaliased expression, a UNION) is counted by the manifest's columns only.
  const star = meta.source === 'manifest_columns' ? " · the model's select list is not plain column names (a `*`, an unaliased expression or a UNION), so only the columns the manifest lists are counted" : ''
  if (!gaps.length && !star) return []
  // Names come from the project and this line goes to Claude, so each is a quoted string.
  const shown = gaps.slice(0, MAX_NAMES).map(one => JSON.stringify(one)).join(', ') + (gaps.length > MAX_NAMES ? `, +${gaps.length - MAX_NAMES} more` : '')
  // The manifest's compiled SQL is from the last dbt compile, not from this edit.
  return [`◆ docs · ${JSON.stringify(view.model)}: ${view.documented} of ${view.total} columns documented (${view.percent}%)${gaps.length ? ` · no description for: ${shown}` : ''}${star} · as of the last dbt compile`]
}

async function showStatus($: EngineInterface) {
  const state = await read($, docsAtom)
  const pending = state?.groups.reduce((sum, group) => sum + group.candidates.length, 0) ?? 0
  statusShown = pending > 0
  await setStatusPart($, 'docs', pending ? `docs ${pending} to copy` : null)
}

// ---------------------------------------------------------------------------------------------------
// The feature's hooks
// ---------------------------------------------------------------------------------------------------

async function openPane($: EngineInterface) {
  await $.ui.open({ id: PANE, title: PANE_TITLE, focus: true, closeOnEscape: true })
}

/** Adds this feature's own hooks. */
export function register(on: On, context: FeatureContext) {
  on('command.run', { command: COMMAND }, async $ => {
    try {
      await openPane($)
    } catch (error) {
      return { text: `Could not open Altimate docs: ${String(error)}` }
    }
    const state = await read($, docsAtom)
    return { text: state?.groups.length ? 'Descriptions to copy are in the side pane.' : 'No column description has been written yet; the pane shows each one Claude writes, with the downstream columns that can take it.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const state = (await read($, docsAtom)) ?? empty()
    const groups = state.groups.filter(group => group.candidates.length > 0)
    const drawn = new Set(groups.map(group => offerKey(group)))
    const picked = groups.reduce((sum, group) => sum + group.candidates.filter(one => !state.skipped.includes(candidateKey(group, one))).length, 0)
    const coverage = state.coverage
    return (
      <Box flexDirection="column">
        <Text bold>docs</Text>
        {coverage ? (
          <Text dimColor>
            {coverage.model}: {coverage.documented} of {coverage.total} columns documented ({coverage.percent}%)
            {coverage.missing.length ? ` · no description: ${coverage.missing.slice(0, MAX_NAMES).join(', ')}` : ''}
          </Text>
        ) : null}
        {groups.length === 0 ? <Text dimColor>No description to copy: when Claude writes a column description, the downstream columns that carry the same value are listed here.</Text> : null}
        {groups.map(group => (
          <Box key={`docs-${groupKey(group.manifest, group.model, group.column)}`} flexDirection="column">
            <Text>
              <Text bold>
                {group.model}.{group.column}
              </Text>
              <Text dimColor> · {group.description}</Text>
            </Text>
            {group.candidates.map(one => {
              const key = candidateKey(group, one)
              const ticked = !state.skipped.includes(key)
              return (
                <Button
                  key={`docs-pick-${key}`}
                  plain
                  label={`${ticked ? '[x]' : '[ ]'} ${one.model}.${one.column} (${one.lens === 'Alias' ? 'renamed' : 'as is'})`}
                  onPress={() => update($, docsAtom, prev => ({ ...(prev ?? empty()), skipped: ticked ? [...(prev?.skipped ?? []), key] : (prev?.skipped ?? []).filter(k => k !== key) }))}
                />
              )
            })}
          </Box>
        ))}
        {groups.length ? (
          <Box>
            <Button
              key="docs-apply"
              label={`Apply to ${plural(picked, 'column')}`}
              onPress={() =>
                later($, async () => {
                  if (applying) return
                  // What is ticked now, not what was drawn: a tick or a withdrawn offer may have landed since the render.
                  const state = (await read($, docsAtom)) ?? empty()
                  // An offer that arrived after the draw waits for the next Apply: it was never shown.
                  const groups = state.groups.filter(group => group.candidates.length > 0 && drawn.has(offerKey(group)))
                  const prompt = applyPrompt(groups, state.skipped)
                  if (!prompt || applying) return
                  applying = true
                  const marks: string[] = []
                  const sent = new Set(sentGroups(groups, state.skipped).map(group => offerKey(group)))
                  try {
                    for (const group of groups) {
                      for (const one of group.candidates) {
                        if (state.skipped.includes(candidateKey(group, one))) continue
                        const key = appliedKey(group.manifest, one.model, one.column)
                        applied.set(key, group.description)
                        marks.push(key)
                      }
                    }
                    try {
                      const answer = (await $.prompt.submit({ text: prompt })) as { drop?: unknown } | undefined
                      // A request the engine or a hook refused was not sent: the offers stay for the next Apply.
                      if (answer && typeof answer === 'object' && answer.drop !== undefined) {
                        for (const key of marks) applied.delete(key)
                        return
                      }
                    } catch (error) {
                      // A request that was not sent asked for nothing.
                      for (const key of marks) applied.delete(key)
                      throw error
                    }
                    // Only what was sent is cleared: an offer that arrived meanwhile stays.
                    await update($, docsAtom, prev => {
                      const left = (prev?.groups ?? []).filter(group => !sent.has(offerKey(group)))
                      return { ...(prev ?? empty()), groups: left, skipped: (prev?.skipped ?? []).filter(key => left.some(group => key.startsWith(groupPrefix(group)))) }
                    })
                    await showStatus($)
                  } finally {
                    applying = false
                  }
                })
              }
            />
            <Button
              key="docs-dismiss"
              label="Dismiss"
              onPress={() =>
                later($, async () => {
                  await update($, docsAtom, prev => ({ ...(prev ?? empty()), groups: [], skipped: [] }))
                  await showStatus($)
                })
              }
            />
          </Box>
        ) : null}
      </Box>
    )
  })
}

/** After the session started: the place to register commands. */
export async function sessionStart($: EngineInterface, e: Args<'session.start'>) {
  saidOldReach = false
  saidOldCoverage = false
  applied.clear()
  applying = false
  await update($, docsAtom, () => null)
  if (statusShown) await setStatusPart($, 'docs', null)
  statusShown = false
  await $.command.register({ name: COMMAND, description: 'Copy a column description Claude wrote to the downstream columns that carry the same value' })
}

/** Also called for a subagent's turns, which carry `e.agentId`. */
export async function turnStart($: EngineInterface, e: Args<'turn.start'>) {}

/** After the turn's answer; `out` is what the turn ended with. Also called for a subagent's turns (`e.agentId`). */
export async function turnComplete($: EngineInterface, e: Args<'turn.complete'>, out: EventResult<'turn.complete'>) {}

export async function sessionEnd($: EngineInterface, e: Args<'session.end'>) {}

/** This feature's line in the band, under the lineage line; null when there is nothing to say. */
export async function bandLine($: EngineInterface, ui: BandUi): Promise<RenderElement | null> {
  const state = await read($, docsAtom)
  const group = [...(state?.groups ?? [])].reverse().find(one => one.candidates.length > 0)
  if (!state || !group) return null
  const { Box, Button, Text } = ui
  return (
    <Box key="docs-band" flexDirection="column">
      <Text>
        <Text color="warning">✎ </Text>
        <Text bold>{group.column}</Text>
        <Text>: {plural(group.candidates.length, 'downstream column')} can take this description · /propagate</Text>
      </Text>
      <Box>
        <Button key="docs-open" label="Propagate" onPress={() => later($, () => openPane($))} />
        <Button key="docs-dismiss-band" label="Dismiss" onPress={() => later($, async () => { await update($, docsAtom, prev => ({ ...(prev ?? empty()), groups: [], skipped: [] })); await showStatus($) })} />
      </Box>
    </Box>
  )
}

/** The command to run in place of `e.command`; null keeps it. */
export async function bashRewrite($: EngineInterface, e: BashCall): Promise<string | null> {
  return null
}

/**
 * `{ deny }` refuses the Bash call; null lets it run. A gate that throws is logged and the call runs:
 * a gate that must hold the call when its own check fails catches that failure and returns `{ deny }`.
 */
export async function bashGate($: EngineInterface, e: BashCall): Promise<{ deny: string } | null> {
  return null
}

export async function bashAfter($: EngineInterface, e: BashCall, result: ToolCallResult): Promise<ContextLines> {}

/** `file.before` holds the text from before the edit only when `editReadsBefore` is true. */
export async function editAfter($: EngineInterface, e: FileCall, result: ToolCallResult, file: EditedFile): Promise<ContextLines> {
  if (/\.ya?ml$/i.test(file.path)) {
    const oldText = (e as { old_string?: unknown }).old_string
    return schemaEdited($, file, e.tool === 'Write' || (e.tool === 'Edit' && oldText === ''))
  }
  if (/\.sql$/i.test(file.path)) return sqlEdited($, file)
}

export async function readOrEditAfter($: EngineInterface, e: FileCall, result: ToolCallResult, file: { path: string }): Promise<ContextLines> {}

/** Whether `editAfter` needs the file's text from before the edit (one extra read per edit). */
export const editReadsBefore = true
