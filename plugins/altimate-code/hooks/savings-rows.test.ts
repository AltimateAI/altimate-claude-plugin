import { expect, test } from 'claude-code/testing'

import type { SavingsConnection, SavingsFinding, SavingsKept, SavingsView } from '../types'
import {
  dbtFlag,
  dbtInline,
  dbtMovesFirst,
  dbtRunOf,
  factsOfConnections,
  findingOn,
  identityOf,
  parseWarehouseList,
  readYaml,
  refOfConnection,
  refOfProfile,
  rowNote,
  sqlCallOf,
  scopeOf,
  warehouseOfHttpPath,
  withFacts,
} from './savings-rows'

const finding = (over: Partial<SavingsFinding>): SavingsFinding => ({
  checkId: 'wh_oversized',
  title: 'Over-Sized Warehouse',
  resourceType: 'sql_warehouse',
  resourceId: 'wh-1',
  resourceName: 'Classic',
  matchName: 'Classic',
  workspace: null,
  workspaceId: null,
  monthlyMin: 10,
  monthlyMax: 20,
  evidence: [],
  fact: '95% idle',
  dailyCost: 1,
  config: 'SMALL CLASSIC',
  fixRequest: '',
  ...over,
})

const kept = (platform: SavingsView['platform'], findings: SavingsFinding[], ranOn: string | null = null, scope: string | null = null, connection: string | null = null): SavingsKept => ({ savedAt: 0, view: { platform, connection, scope, ranOn, findings } as SavingsView })

test('the connection list is read from warehouse_list\'s table, in its order', () => {
  expect(parseWarehouseList('Name | Type | Database\n-----|------|--------\ndbx | databricks | -\nsf | Snowflake | DB\npg | postgres | app\n\nTables:\nx | y | z')).toEqual([
    { name: 'dbx', platform: 'databricks' },
    { name: 'sf', platform: 'snowflake' },
    { name: 'pg', platform: null },
  ])
  // A shadowed connection adds a column.
  expect(parseWarehouseList('Name | Type | Database | Served by\ndbx | databricks | - | local')).toEqual([{ name: 'dbx', platform: 'databricks' }])
  expect(parseWarehouseList('No warehouse connections configured.')).toEqual([])
})

test('only a SQL warehouse path names a warehouse', () => {
  expect(warehouseOfHttpPath('/sql/1.0/warehouses/abc123')).toBe('abc123')
  expect(warehouseOfHttpPath('sql/1.0/endpoints/abc123/')).toBe('abc123')
  expect(warehouseOfHttpPath('/sql/protocolv1/o/1/0101-abc')).toBeNull()
  expect(warehouseOfHttpPath(undefined)).toBeNull()
})

test('a connections file gives up where each connection runs and nothing else', () => {
  const file = JSON.stringify({
    d: { type: 'databricks', server_hostname: 'https://H.example.com/', http_path: '/sql/1.0/warehouses/w1', access_token: 'SECRET' },
    alias: { type: 'databricks', httpPath: '/sql/1.0/warehouses/w2' },
    s: { type: 'snowflake', warehouse: 'WH', account: 'AB123.snowflakecomputing.com', password: 'SECRET' },
    c: { type: 'databricks', http_path: '/sql/protocolv1/o/1/2' },
    p: { type: 'postgres', host: 'h', warehouse: 'not-this', account: 'not-this' },
    bad: 'text',
  })
  const facts = factsOfConnections(file)
  expect(facts).toEqual({
    d: { warehouse: 'w1', account: null, place: 'h.example.com' },
    alias: { warehouse: 'w2', account: null, place: null },
    s: { warehouse: 'WH', account: 'ab123', place: 'ab123' },
    c: { warehouse: null, account: null, place: null },
    p: { warehouse: null, account: null, place: null },
  })
  expect(JSON.stringify(facts)).not.toContain('SECRET')
  expect(factsOfConnections('{not json')).toEqual({})
  expect(factsOfConnections('[1]')).toEqual({})
  expect(withFacts([{ name: 'd', platform: 'databricks' }, { name: 'x', platform: null }], facts)).toEqual([
    { name: 'd', platform: 'databricks', warehouse: 'w1', account: null },
    { name: 'x', platform: null, warehouse: null, account: null },
  ])
})

test('a project connection replaces the global one of its name whole', () => {
  const merged = { ...factsOfConnections('{"s":{"type":"snowflake","warehouse":"GLOBAL_WH","account":"a"}}'), ...factsOfConnections('{"s":{"type":"snowflake","account":"b"}}') }
  expect(merged.s).toEqual({ warehouse: null, account: 'b', place: 'b' })
})

test('an answer belongs to the workspace or account, else to the project', () => {
  expect(identityOf('databricks', { warehouse: 'w', account: null, place: 'h' }, '/repo')).toBe('databricks:h')
  expect(identityOf('snowflake', { warehouse: 'w', account: 'a', place: 'a' }, '/repo')).toBe('snowflake:a')
  expect(identityOf('databricks', { warehouse: 'w', account: null, place: null }, '/repo')).toBe('project:/repo')
  expect(identityOf('snowflake', undefined, '/other')).toBe('project:/other')
})

test('a SQL call is recognized over MCP and in a shell, and nothing else is', () => {
  const tool = 'mcp__plugin_altimate-code_altimate-code__sql_execute'
  expect(sqlCallOf(tool, { warehouse: 'a' })).toEqual(['a'])
  expect(sqlCallOf(tool, {})).toEqual([null])
  expect(sqlCallOf(tool, { queries: [{ warehouse: 'a' }, { warehouse: 'b' }, {}] })).toEqual(['a', 'b', null])
  expect(sqlCallOf(tool, { warehouse: 'top', queries: [{}, { warehouse: 'b' }] })).toEqual(['top', 'b'])
  expect(sqlCallOf('mcp__altimate-code__sql_explain', { warehouse: 'a' })).toEqual(['a'])
  expect(sqlCallOf('mcp__plugin_altimate-code_altimate-code__schema_inspect', { warehouse: 'a' })).toBeNull()
  expect(sqlCallOf('mcp__other__sql_execute', { warehouse: 'a' })).toBeNull()
  expect(sqlCallOf('Read', { file_path: 'x' })).toBeNull()
  expect(sqlCallOf('Bash', { command: `altimate tool run sql_execute --args '{"warehouse":"a"}'` })).toEqual(['a'])
  expect(sqlCallOf('Bash', { command: `cd x && altimate-code tool run sql_explain --args "{\\"warehouse\\":\\"b\\"}" --json` })).toEqual(['b'])
  expect(sqlCallOf('Bash', { command: `altimate tool run sql_execute --args '{broken'` })).toBeNull()
  expect(sqlCallOf('Bash', { command: `altimate tool run schema_inspect --args '{"warehouse":"a"}'` })).toBeNull()
  expect(sqlCallOf('Bash', { command: 'echo altimate' })).toBeNull()
  // With --allow-write and no connection, what it runs on is not the first connection for certain.
  expect(sqlCallOf('Bash', { command: `altimate tool run sql_execute --args '{"query":"x"}' --allow-write` })).toBeNull()
  expect(sqlCallOf('Bash', { command: `altimate tool run sql_execute --args '{"warehouse":"a"}' --allow-write` })).toEqual(['a'])
})

test('a connection runs on its configured compute, else the one its kept run went through', () => {
  const list: SavingsConnection[] = [
    { name: 'pg', platform: null, warehouse: null, account: null },
    { name: 'dbx', platform: 'databricks', warehouse: 'w1', account: null },
    { name: 'env', platform: 'databricks', warehouse: null, account: null },
    { name: 'sf', platform: 'snowflake', warehouse: 'WH', account: 'acct' },
    { name: 'sf2', platform: 'snowflake', warehouse: 'WH', account: null },
  ]
  expect(refOfConnection('dbx', list, {})).toEqual({ platform: 'databricks', warehouse: 'w1', scope: null })
  expect(refOfConnection('env', list, { x: kept('databricks', [], 'w9', null, 'env') })).toEqual({ platform: 'databricks', warehouse: 'w9', scope: null })
  expect(refOfConnection('env', list, {})).toBeNull()
  expect(refOfConnection('nope', list, {})).toBeNull()
  expect(refOfConnection('sf', list, {})).toEqual({ platform: 'snowflake', warehouse: 'WH', scope: 'acct' })
  // With no account known, the connection itself is the scope.
  expect(refOfConnection('sf2', list, {})?.scope).toBe('sf2')
  // The default is the first connection, even when that is not a warehouse this checks.
  expect(refOfConnection(null, list, {})).toBeNull()
  expect(refOfConnection(null, list.slice(1), {})?.warehouse).toBe('w1')
  expect(scopeOf('databricks', list[1], 'dbx')).toBeNull()
  expect(scopeOf('snowflake', undefined, 'named')).toBe('named')
})

test('a finding is matched to compute exactly, on its own platform and account, largest saving first', () => {
  const small = finding({ monthlyMax: 20 })
  const large = finding({ monthlyMax: 90, title: 'Migrate' })
  const cluster = finding({ resourceType: 'cluster', resourceId: 'w2' })
  const sf = finding({ resourceId: '7', resourceName: 'COMPUTE_WH', matchName: 'COMPUTE_WH' })
  const all = { a: kept('databricks', [small, large, cluster]), s: kept('snowflake', [sf], 'COMPUTE_WH', 'acct-a') }
  const dbx = (warehouse: string) => ({ platform: 'databricks' as const, warehouse, scope: null })
  expect(findingOn(dbx('wh-1'), all)).toBe(large)
  expect(findingOn(dbx('w2'), all)).toBeNull()
  expect(findingOn(dbx('WH-1'), all)).toBeNull()
  // Snowflake folds unquoted names to upper case, so a profile's `compute_wh` is that warehouse.
  expect(findingOn({ platform: 'snowflake', warehouse: 'compute_wh', scope: 'acct-a' }, all)).toBe(sf)
  expect(findingOn({ platform: 'snowflake', warehouse: 'wh-1', scope: 'acct-a' }, all)).toBeNull()
  // The same name in another account is another warehouse.
  expect(findingOn({ platform: 'snowflake', warehouse: 'COMPUTE_WH', scope: 'acct-b' }, all)).toBeNull()
  expect(rowNote(large)).toBe('Classic: 95% idle · $10.00–$90.00 a month → /savings')
  expect(rowNote(finding({ monthlyMin: 0, monthlyMax: 0 }))).toBe('Classic: 95% idle · no dollar estimate → /savings')
})

test('only a dbt run or build written out in full counts', () => {
  expect(dbtRunOf('cd x && dbt run -s orders')?.subcommand).toBe('run')
  expect(dbtRunOf('uv run dbt build --target prod')?.target).toBe('prod')
  expect(dbtRunOf('dbt test')).toBeNull()
  expect(dbtRunOf('dbt run --target $T')).toBeNull()
  expect(dbtRunOf('ls')).toBeNull()
  const command = 'dbt run --profiles-dir ./conf --project-dir=app --profile "acme"'
  const run = dbtRunOf(command)!
  expect(dbtFlag(command, run, 'profiles-dir')).toBe('./conf')
  expect(dbtFlag(command, run, 'project-dir')).toBe('app')
  expect(dbtFlag(command, run, 'profile')).toBe('acme')
  expect(dbtFlag(command, run, 'target')).toBeNull()
  const inline = 'DBT_PROFILES_DIR=/conf dbt run'
  expect(dbtInline(inline, dbtRunOf(inline)!, 'DBT_PROFILES_DIR')).toBe('/conf')
  expect(dbtInline('dbt run', dbtRunOf('dbt run')!, 'DBT_PROFILES_DIR')).toBeNull()
  const elsewhere = 'uv run --directory /other dbt run'
  expect(dbtMovesFirst(elsewhere, dbtRunOf(elsewhere)!)).toBe(true)
  const exported = 'export DBT_TARGET=prod; dbt run'
  expect(dbtMovesFirst(exported, dbtRunOf(exported)!)).toBe(true)
  const moved = 'cd sub && dbt run'
  expect(dbtMovesFirst(moved, dbtRunOf(moved)!)).toBe(true)
  expect(dbtMovesFirst('dbt run', dbtRunOf('dbt run')!)).toBe(false)
})

const PROFILES = `# profiles
config:
  send_anonymous_usage_stats: false
acme:
  target: dev  # the default
  outputs:
    dev:
      type: databricks
      http_path: "/sql/1.0/warehouses/w1"
      token: "{{ env_var('T') }}"
    sf:
      type: snowflake
      account: AB123
      warehouse: TRANSFORM_WH
    noaccount:
      type: snowflake
      warehouse: TRANSFORM_WH
    templated:
      type: snowflake
      account: AB123
      warehouse: "{{ env_var('WH') }}"
    pg:
      type: postgres
      host: localhost
plain:
  outputs:
    default:
      type: snowflake
      account: "{{ env_var('ACCOUNT') }}"
      warehouse: 'BI_WH'
`

test('a dbt target gives its warehouse; what it does not state plainly gives nothing', () => {
  expect(readYaml('a: 1\nb:\n  c: "x"\n').b).toEqual({ c: 'x' })
  expect(refOfProfile(PROFILES, 'acme', null)).toEqual({ platform: 'databricks', warehouse: 'w1', scope: null })
  expect(refOfProfile(PROFILES, 'acme', 'sf')).toEqual({ platform: 'snowflake', warehouse: 'TRANSFORM_WH', scope: 'ab123' })
  // A Snowflake target whose account is not stated could be any account's warehouse of that name.
  expect(refOfProfile(PROFILES, 'acme', 'noaccount')).toBeNull()
  expect(refOfProfile(PROFILES, 'plain', null)).toBeNull()
  expect(refOfProfile(PROFILES, 'acme', 'templated')).toBeNull()
  expect(refOfProfile(PROFILES, 'acme', 'pg')).toBeNull()
  expect(refOfProfile(PROFILES, 'acme', 'missing')).toBeNull()
  expect(refOfProfile(PROFILES, 'nope', null)).toBeNull()
})
