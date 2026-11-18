// Which warehouse a tool call runs on, for the one-line note under its row. Everything here reads what
// is already on this machine: altimate-code's connection list and config, dbt's profiles and the kept
// /savings answers. None of it queries a warehouse.
import type { SavingsConnection, SavingsFinding, SavingsKept, SavingsPlatform, SavingsWarehouseRef } from '../types'
import { parseDbtCommand, type DbtInvocation } from './dbt-command'
import { amount, oneLine } from './savings-format'

const platformOfType = (type: unknown): SavingsPlatform | null => {
  const name = String(type ?? '').trim().toLowerCase()
  return name === 'databricks' || name === 'snowflake' ? name : null
}

/** The connections in `warehouse_list`'s table (`Name | Type | Database`, a `Served by` column when one is shadowed), in its order. */
export function parseWarehouseList(output: string): { name: string; platform: SavingsPlatform | null }[] {
  const rows: { name: string; platform: SavingsPlatform | null }[] = []
  const lines = output.split('\n')
  const header = lines.findIndex(line => /^Name \| Type \|/.test(line))
  if (header < 0) return rows
  for (const line of lines.slice(header + 1)) {
    if (!line.trim()) break
    if (/^-+\s*\|/.test(line)) continue
    const [name, type] = line.split(' | ')
    if (name && type) rows.push({ name: name.trim(), platform: platformOfType(type) })
  }
  return rows
}

/** The SQL warehouse a Databricks `http_path` goes through; null for a cluster's path or anything else. */
export function warehouseOfHttpPath(path: unknown): string | null {
  return /^\/?sql\/1\.0\/(?:warehouses|endpoints)\/([^/?#\s]+)\/?$/.exec(String(path ?? '').trim())?.[1] ?? null
}

const computeOf = (platform: SavingsPlatform | null, config: Record<string, unknown>): string | null => {
  // `httpPath` is the alias altimate-code's driver also takes.
  if (platform === 'databricks') return warehouseOfHttpPath(config.http_path ?? config.httpPath)
  if (platform === 'snowflake' && typeof config.warehouse === 'string') return config.warehouse.trim() || null
  return null
}

/** A Snowflake account as written in a connection or profile, in the one form they are compared in. */
const accountOf = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() && !value.includes('{{') ? value.trim().toLowerCase().replace(/\.snowflakecomputing\.com$/, '') : null

/** What a run's answer or a tool call is scoped to: on Snowflake the account, else the connection, since a warehouse name repeats across accounts. */
export const scopeOf = (platform: SavingsPlatform, connection: Pick<SavingsConnection, 'name' | 'account'> | null | undefined, name: string | null): string | null =>
  platform === 'snowflake' ? (connection?.account ?? connection?.name ?? name) : null

/** What a connection's config says about where it runs; nothing else is read from it. */
export type ConnectionFacts = {
  warehouse: string | null
  account: string | null
  /** The Databricks workspace host or Snowflake account it reaches. */
  place: string | null
}

const hostOf = (config: Record<string, unknown>): string | null => {
  const host = [config.server_hostname, config.serverHostname, config.host].find(value => typeof value === 'string' && value.trim())
  return typeof host === 'string' && !host.includes('{{') ? host.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '') || null : null
}

/**
 * What a kept answer belongs to. The plugin's store is one file for every project on the machine, and two
 * projects can each have a connection called `prod`, so an answer is tied to the workspace or account its
 * connection reaches, or to the project it ran in when the config does not say.
 */
export const identityOf = (platform: SavingsPlatform, facts: ConnectionFacts | undefined, root: string | null): string =>
  facts?.place ? `${platform}:${facts.place}` : `project:${root ?? ''}`

/**
 * The compute of each connection in a `connections.json`. The file holds credentials: only these fields
 * are taken from it, and nothing else is kept or passed on. Every connection gets an entry, so one in the
 * project's file replaces the global one of that name whole, as altimate-code reads them.
 */
export function factsOfConnections(text: string): Record<string, ConnectionFacts> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return {}
  }
  const out: Record<string, ConnectionFacts> = {}
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out
  for (const [name, config] of Object.entries(parsed as Record<string, unknown>)) {
    if (!config || typeof config !== 'object') continue
    const fields = config as Record<string, unknown>
    const platform = platformOfType(fields.type)
    const account = platform === 'snowflake' ? accountOf(fields.account) : null
    out[name] = { warehouse: computeOf(platform, fields), account, place: platform === 'databricks' ? hostOf(fields) : account }
  }
  return out
}

/** The list joined with what the config files say about each connection. */
export function withFacts(list: { name: string; platform: SavingsPlatform | null }[], facts: Record<string, ConnectionFacts>): SavingsConnection[] {
  return list.map(one => ({ ...one, warehouse: facts[one.name]?.warehouse ?? null, account: facts[one.name]?.account ?? null }))
}

// The altimate-code tools that run SQL on a warehouse; without a `warehouse` they use the first connection.
const SQL_TOOLS = new Set(['sql_execute', 'sql_explain'])
const MCP_TOOL = /^mcp__.*altimate-code__([a-z_]+)$/
const CLI_CALL = /(?:^|[\s;&|(])altimate(?:-code)?\s+tool\s+run\s+([a-z_]+)\s+--args\s+(?:'([^']*)'|"((?:[^"\\]|\\.)*)")/

/** The connection each statement of an altimate-code SQL call runs on; null for one left to the default. */
function connectionsAsked(input: unknown): (string | null)[] {
  const call = (input ?? {}) as { warehouse?: unknown; queries?: unknown }
  const named = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null)
  const top = named(call.warehouse)
  return Array.isArray(call.queries) && call.queries.length > 0 ? call.queries.map(one => named((one as { warehouse?: unknown } | null)?.warehouse) ?? top) : [top]
}

/** The altimate-code SQL call in a tool row (over MCP, or `altimate tool run` in a shell), or null. */
export function sqlCallOf(tool: string, input: unknown): (string | null)[] | null {
  const mcp = MCP_TOOL.exec(tool)
  if (mcp) return SQL_TOOLS.has(mcp[1]!) ? connectionsAsked(input) : null
  if (tool !== 'Bash') return null
  const command = String((input as { command?: unknown } | null)?.command ?? '')
  const cli = CLI_CALL.exec(command)
  if (!cli || !SQL_TOOLS.has(cli[1]!)) return null
  try {
    const asked = connectionsAsked(JSON.parse(cli[2] ?? cli[3]!.replace(/\\(.)/g, '$1')))
    // With --allow-write and no connection named, altimate-code may go through dbt instead of the first connection.
    return asked.includes(null) && /\s--allow-write\b/.test(command) ? null : asked
  } catch {
    return null
  }
}

/** The compute a connection runs on: its config, else the warehouse its kept run went through. */
export function refOfConnection(name: string | null, connections: readonly SavingsConnection[], kept: Record<string, SavingsKept>): SavingsWarehouseRef | null {
  const connection = name === null ? connections[0] : connections.find(one => one.name === name)
  if (!connection?.platform) return null
  const warehouse = connection.warehouse ?? Object.values(kept).find(one => one.view.connection === connection.name)?.view.ranOn
  return warehouse ? { platform: connection.platform, warehouse, scope: scopeOf(connection.platform, connection, connection.name) } : null
}

/** The kept finding with the largest saving on that compute, or null. */
export function findingOn(ref: SavingsWarehouseRef, kept: Record<string, SavingsKept>): SavingsFinding | null {
  const same = (one: SavingsFinding) =>
    ref.platform === 'databricks'
      ? one.resourceType === 'sql_warehouse' && one.resourceId === ref.warehouse
      : (one.resourceType === 'warehouse' || one.resourceType === 'sql_warehouse') && [one.resourceId, one.matchName].some(name => name.toLowerCase() === ref.warehouse.toLowerCase())
  let best: SavingsFinding | null = null
  for (const { view } of Object.values(kept)) {
    if (view.platform !== ref.platform || view.scope !== ref.scope) continue
    for (const one of view.findings) if (same(one) && (!best || one.monthlyMax > best.monthlyMax)) best = one
  }
  return best
}

/** The line under a tool row. */
export const rowNote = (one: SavingsFinding) => `${oneLine(one.resourceName)}: ${one.fact} · ${amount(one.monthlyMin, one.monthlyMax)} → /savings`

// --- dbt: a `dbt run` or `dbt build` runs on its target's warehouse.

/** The first `dbt run` or `dbt build` a command line states fully, or null. */
export function dbtRunOf(command: string): DbtInvocation | null {
  return parseDbtCommand(command).find(one => !one.dynamic && (one.subcommand === 'run' || one.subcommand === 'build')) ?? null
}

/** Whether the line moves or reconfigures dbt before it runs, so what the session's files say may not apply. */
export const dbtMovesFirst = (command: string, invocation: DbtInvocation) =>
  /(?:^|[\s;&|(])(?:cd|pushd|export\s+DBT_\w+=)/.test(command.slice(0, invocation.start)) || /\s--(?:directory|project|cwd)\b/.test(invocation.binary)

/** A variable as set in front of the invocation, or null. */
export function dbtInline(command: string, invocation: DbtInvocation, name: 'DBT_PROFILES_DIR' | 'DBT_PROJECT_DIR'): string | null {
  const value = new RegExp(`(?:^|\\s)${name}=("[^"]*"|'[^']*'|\\S+)`).exec(command.slice(invocation.start, invocation.end))?.[1]
  return value ? value.replace(/^["']|["']$/g, '') : null
}

/** The value of `--name value` or `--name=value` in the invocation's own text. */
export function dbtFlag(command: string, invocation: DbtInvocation, name: string): string | null {
  const text = command.slice(invocation.start, invocation.end)
  const value = new RegExp(`(?:^|\\s)--${name}(?:=|\\s+)("[^"]*"|'[^']*'|\\S+)`).exec(text)?.[1]
  return value ? value.replace(/^["']|["']$/g, '') : null
}

type Yaml = { [key: string]: string | Yaml }

/** The `key: value` and `key:` lines of a YAML file as nested maps; lists and anything fancier are skipped. */
export function readYaml(text: string): Yaml {
  const root: Yaml = {}
  const stack: { indent: number; map: Yaml }[] = [{ indent: -1, map: root }]
  for (const raw of text.split('\n')) {
    const line = /^(\s*)([^\s#'"\-][^:#]*?|"[^"]+"|'[^']+')\s*:(?:\s+(.*?))?\s*$/.exec(raw)
    if (!line) continue
    const indent = line[1]!.length
    while (stack.at(-1)!.indent >= indent) stack.pop()
    const key = line[2]!.replace(/^["']|["']$/g, '')
    const value = (line[3] ?? '').replace(/\s+#.*$/, '')
    if (value === '') {
      const map: Yaml = {}
      stack.at(-1)!.map[key] = map
      stack.push({ indent, map })
    } else {
      stack.at(-1)!.map[key] = value.replace(/^["']|["']$/g, '')
    }
  }
  return root
}

/** The compute a dbt profile's target runs on; null when the profile does not state it plainly (a `{{ env_var() }}`, say). */
export function refOfProfile(profiles: string, profile: string, target: string | null): SavingsWarehouseRef | null {
  const entry = readYaml(profiles)[profile]
  if (!entry || typeof entry !== 'object') return null
  const name = target ?? (typeof entry.target === 'string' ? entry.target : 'default')
  const outputs = entry.outputs
  const output = outputs && typeof outputs === 'object' ? outputs[name] : null
  if (!output || typeof output !== 'object') return null
  const platform = platformOfType(output.type)
  const compute = computeOf(platform, output)
  if (!platform || !compute || compute.includes('{{')) return null
  if (platform === 'databricks') return { platform, warehouse: compute, scope: null }
  // Without its account a Snowflake target cannot be told from one of the same name elsewhere.
  const scope = accountOf(output.account)
  return scope ? { platform, warehouse: compute, scope } : null
}
