export type ProviderId = 'github' | 'jira' | 'linear'

export type ProviderState = 'connected' | 'expired' | 'rejected' | 'detected' | 'available' | 'not_found'

export type SyncState = 'synced' | 'local' | 'pending' | 'blocked'

export type SourceKind = 'cli' | 'env' | 'mcp' | 'mcp-remote' | 'browser'

export type Provider = {
  id: ProviderId
  name: string
  state: ProviderState
  source: { kind: SourceKind; label: string } | null
  account: string | null
  syncable: boolean
  sync: SyncState
  updatedAt: string | null
  /** ISO time the access token stops working; null when it does not expire or the provider does not report it. */
  expiresAt?: string | null
  note: string | null
  /** False for a connection made by hand in the web app, which this tool does not manage. */
  managed?: boolean
  /** A credential found on this machine while the row shows a connection made by hand: it can still be connected here. */
  found?: { source: { kind: SourceKind; label: string }; account: string | null }
}

export type IntegrationsStatus = {
  workspace: { name: string; tenant: string | null; linked?: boolean; id?: number | null; signedIn?: boolean }
  providers: Provider[]
}

/** A workspace this folder can be linked to. */
export type WorkspaceChoice = { id: number; name: string }

/** The action running now, with what the pane shows while it runs. */
export type Busy = { provider: ProviderId | 'all'; label: string }

/**
 * One credential field of a provider's form, as `altimate integrations fields` reports it.
 * A secret carries no value: only whether it is set and its masked tail.
 */
export type FormField = {
  name: string
  label: string
  secret: boolean
  required: boolean
  value: string | null
  hasValue: boolean
  masked: string | null
}

export type Form = {
  provider: ProviderId
  variant: string
  variants: string[]
  fields: FormField[]
  tokenUrl: string | null
}

/** Which provider's form is open, and whether it adds credentials or updates them. */
export type Expanded = { provider: ProviderId; mode: 'connect' | 'update'; variant: string | null }

/** One node of the dbt graph, as the lineage pane draws it. */
export type GraphNode = {
  id: string
  name: string
  /** An exposure's label (a dashboard's display name); null for other nodes. */
  label: string | null
  /** dbt resource type: model, source, seed, snapshot, exposure, test, … */
  type: string
  /** Project-relative file path. */
  path: string | null
  materialized: string | null
  /** database.schema.table, lower-cased: how the warehouse names it. */
  relation: string | null
  /** Columns documented in the manifest. */
  columns: string[]
  /** A test's column (test_metadata.kwargs.column_name or column_name); null when it has none or is not a test. */
  testColumn?: string | null
  /** The model a test is attached to (attached_node), when dbt names it. */
  testOn?: string | null
}

export type LineageGraph = {
  nodes: Record<string, GraphNode>
  parents: Record<string, string[]>
  children: Record<string, string[]>
  /** Set when downstream stopped at the node limit. */
  truncated?: boolean
  /** Set when upstream stopped at the node limit. */
  upTruncated?: boolean
  /** Built from a project's SQL files that stopped at the file limit. */
  partial?: boolean
}

/** One column edge from dbt_lineage: an upstream column feeding an output column. */
export type ColumnEdge = {
  source: string
  target: string
  lineageType: 'direct' | 'indirect'
  /** altimate-core's lens: Original, Alias, Transformation, Not sure, Non select. */
  lens: string
  expression: string | null
}

/** A dbt model an answer names, with the project (and manifest) it was found in. */
export type AnswerModel = { id: string; name: string; root: string; manifest?: string }

/** dbt_lineage for one model. */
export type ColumnLineage = {
  model: string
  /** The model's unique_id, when the answer gives it: a name can match models of two projects. */
  id?: string
  confidence: 'high' | 'low'
  note: string | null
  upstream: string[]
  columns: { name: string; sources: string[] }[]
  edges: ColumnEdge[]
}

/** impact_analysis' column reach: the downstream models whose SQL reads a column. */
export type ColumnReachView = {
  model: string
  column: string
  /** `id` is the model's unique_id: names repeat across packages and versions. */
  models: { name: string; id?: string; columns: string[] }[]
  exposures: string[]
  /** Dashboards on models that may read it or could not be traced. */
  uncertainExposures: string[]
  /** Models that may read it: only outside their select list, or through an ambiguous table name. */
  uncertain: { name: string; id?: string; reason: string }[]
  /** Models the lineage engine could not trace (no compiled SQL, unparseable SQL). */
  untraced: { name: string; id?: string; reason: string }[]
  truncated: boolean
  /** The dashboards could not be read: their count is a lower bound. */
  exposuresError?: string
}

/** A table_lineage edge from a SaaS MCP server: what the warehouse's query history shows. */
export type WarehouseEdge = { source: string | null; target: string | null; hop: number }

/** The model the lineage pane follows, and where its manifest is. */
export type LineageFocus = {
  model: string
  root: string
  manifest: string
  /** How the graph was read: the manifest file, or altimate-code's tools for a manifest over 4 MiB. */
  via: 'manifest' | 'tools' | 'sql'
  /** Milliseconds the graph took to read. */
  readMs: number
  /** The manifest's modification time when it was read: a recompile is a new focus. */
  mtimeMs: number
  /** When this follow ran: what the pane draws from changes with it. */
  stamp?: number
}

/** `complete` is false when the warehouse answer was paged or cut, so a missing edge proves nothing. */
export type WarehouseView = { server: string; tool: string; table: string; edges: WarehouseEdge[]; complete: boolean }

/** What the band reports after Claude edits a model. */
export type ImpactView = {
  model: string
  column: string | null
  severity: 'SAFE' | 'LOW' | 'MEDIUM' | 'HIGH'
  direct: number
  transitive: number
  tests: number
  exposures: string[]
  /** Downstream models that read the edited column; null when no column was traced. */
  readers: number | null
  /** Models that may read it or could not be traced: `readers` is then a lower bound. */
  unsettled: number
  /** Of `unsettled`, the models that may read it or could not be traced. */
  maybeReaders: number
  /** Of `exposures`, the dashboards on models that only may read it. */
  maybeExposures: number
  /** The dashboards could not be read: the count is a lower bound. */
  dashboardsUnsettled?: boolean
  /** altimate-code stopped the graph at its node limit: `transitive` is a lower bound. */
  truncated: boolean
}

/** A node a dbt run, test or build left failed: from run_results.json, or the command's text. */
export type DbtFailure = {
  id: string
  name: string
  /** model, test, seed, snapshot, or project for an error before any node ran. */
  kind: string
  status: 'error' | 'fail'
  message: string
  /** Project-relative file, when known. */
  path: string | null
  /** A failed test's failing row count. */
  failures: number | null
}

/** The last failed dbt command Claude ran, offered for Explain and Fix. */
export type FailureView = {
  command: string
  root: string
  /** run, test, build, seed, snapshot or retry; a command that ran several joins them (`run+test`). */
  verb: string
  /**
   * What it ran with: every flag but the selection and display-only ones (target, vars, `--full-refresh`, …),
   * sorted by flag, a repeated flag's values in the order written (the last wins), a `--X`/`--no-X` pair
   * reduced to its effective value; then the environment set in the command (each value as a short hash,
   * never in the clear), then `cwd:<folder it ran in>`. A passing run with anything else clears nothing. A
   * command that ran several invocations with different contexts keeps each one's list, in order.
   */
  options: string[] | string[][]
  /** The failed command's --select; null when it ran the whole project. A compound command's selections are joined (`a | b`, `*` for a whole-project one). */
  select: string | null
  failures: DbtFailure[]
  at: number
}

/** What compile-and-validate found after Claude edited a model. */
export type CheckView = {
  model: string
  /** The dbt project the model is in. */
  root: string
  /** Project-relative path of the model's file. */
  file: string
  /** `partial`: not fully checked (see `reason`): its columns could not be compared, or dbt has no model for the file. */
  status: 'running' | 'ok' | 'warn' | 'error' | 'partial'
  /** What was not checked, for a `partial` check. */
  reason: string | null
  /** Whether dbt compiled and ran the model at all. */
  ran: boolean
  /** Project-relative path of the schema file that documents the model, when the manifest names one. */
  schema: string | null
  /** The project's artifact folder (absolute): edits there are dbt's output, not sources. */
  target: string
  /** dbt's compile or warehouse errors. */
  errors: string[]
  /** Columns schema.yml documents that the warehouse did not return. */
  missing: string[]
  /** Columns the warehouse returned that schema.yml does not document. */
  undocumented: string[]
  /** Columns the warehouse returned; null when it returned no row to read them from. */
  columns: number | null
  /** Their names, in the query's order. */
  returned: string[]
  /** The columns schema.yml documents for the model. */
  documented: string[]
  ms: number
  at: number
}

/** One query's rows, as the results pane shows them. */
export type QueryResult = {
  id: string
  /** The model name, or the start of the inline SQL. */
  title: string
  root: string
  select: string | null
  inline: string | null
  /** The context flags it ran with (target, profile, vars, …), part of its identity. */
  options: string[]
  /** Claude's own dbt invocation, as the shell ran it: Re-run runs it again. Null for /dbt-show's queries. */
  argv?: string[] | null
  /** The folder Claude ran it in. */
  cwd?: string | null
  /** False when Claude's command used shell variables or an env prefix: it cannot be run again word for word. */
  replayable?: boolean
  columns: string[]
  rows: unknown[][]
  limit: number
  ms: number | null
  at: number
  error: string | null
  /** Who ran it first: Claude's own `dbt show`, or the person's /dbt-show. A Re-run keeps it. */
  by: 'claude' | 'you'
}

/** A query kept in the results pane's history or bookmarks, rows included (capped). */
export type SavedQuery = QueryResult & { bookmarked: boolean }

export type DoctorCheck = {
  id: 'dbt' | 'python' | 'adapter' | 'manifest' | 'packages' | 'connection'
  label: string
  status: 'ok' | 'warn' | 'fail'
  detail: string
  fix: string | null
}

/** The environment doctor's last answer for the session's dbt project. */
export type DoctorView = {
  root: string
  checks: DoctorCheck[]
  at: number
  /** Files changed after the manifest was written, newest first, when it is stale. */
  staleFiles: string[]
  /** What runs now: a parse, a connection test, the check itself. */
  busy: string | null
}

/** A column of a model's manifest entry, as Claude is told about it on Read. */
export type ModelContextColumn = { name: string; type: string | null; description: string | null; tests: string[] }

export type ModelContext = {
  id: string
  name: string
  path: string | null
  materialized: string | null
  description: string | null
  relation: string | null
  columns: ModelContextColumn[]
  tests: string[]
  parents: string[]
  children: string[]
  upstreamDepth: number
  downstreamDepth: number
  tags: string[]
}

/** How far a changed column's value reaches downstream. */
export type Reach = {
  columns: number
  models: number
  ends: number
  hops: number
  mayCarry: number
  unresolved: number
  modelLevel: number | null
  truncated: boolean
}

/** `note` says why a found column has no reach to give (models it reads were not read), in place of one. */
export type SummaryColumn = { name: string; reach: Reach | null; failed: boolean; note?: string }

/** What the band shows after a task that changed models. */
export type TaskSummaryView = {
  state: 'tracing' | 'ready'
  models: { name: string; modelLevel: number | null; columns: SummaryColumn[] }[]
  /** Models whose SQL could not be read, across every column traced: the reach is a lower bound. */
  unresolved: number
  truncated: boolean
  /** Where the report was written, once one was asked for. */
  report: string | null
  /** Tracing upstream and writing the report, after a press. */
  building?: boolean
  /** The report could not be opened: its path is shown as a link instead. */
  openFailed: boolean
}

/** What the band shows for a plan: the models it names, at the model level. */
export type PlanImpactView = {
  state: 'tracing' | 'ready'
  models: { name: string; modelLevel: number | null; tests: number | null; exposures: number | null; declared: number | null; failed: boolean }[]
  /** Models the plan names past the ones looked up. */
  more: number
}

// ---------------------------------------------------------------------------------------------------
// Runs (/runs): the dbt commands Claude ran and their results.
// Filled in by that feature alone (hooks/features/); the other features never read or write it.
// ---------------------------------------------------------------------------------------------------
export type RunRow = {
  uniqueId: string
  name: string
  status: string
  executionTimeSec: number | null
  /** Cut to a few hundred characters. */
  message: string | null
}

export type RunRecord = {
  /** The artifact's invocation id; when the artifact has none, the project folder plus its completion time. */
  id: string
  /** The dbt project folder the run was read from. */
  project: string
  /** The command as Claude ran it, with the folder it ran in and a secret's value left out; what Re-run fills in. */
  commandLine: string
  /** `dbt retry` with the launcher, environment and folder flags the command had; what Re-run failed fills in. */
  retryLine: string
  /** The folder run_results.json was read from, as the command named it; absent in a run stored before it was kept. */
  folder?: string
  /** The dbt subcommand the artifact names (`build`, `run`…). */
  command: string
  elapsedSec: number | null
  completedAt: string
  /** Every node dbt reported. */
  total: number
  /** Nodes that succeeded, passed or warned. */
  passed: number
  /** Nodes that errored or failed. */
  failed: number
  /** Nodes dbt skipped. */
  skipped: number
  /** The rows kept: failures first, then the rest, at most as many as the plugin holds. */
  rows: RunRow[]
}

export interface RunsState {
  /** The session folder the runs below were recorded for. */
  root: string
  /** Newest first, at most 50 of each project: a session folder that covers several dbt projects holds up to 50 per project. */
  runs: RunRecord[]
  /** The run the pane shows in full; null for the list. */
  open: string | null
}

// ---------------------------------------------------------------------------------------------------
// Defer and target: the target and defer state dbt commands run with.
// Filled in by that feature alone (hooks/features/); the other features never read or write it.
// ---------------------------------------------------------------------------------------------------
export interface DeferState {
  /** The dbt project the session works in; null when there is none (nothing is rewritten). */
  projectDir: string | null
  /** The project's Power User setting turns defer on and gives a usable state directory. */
  enabled: boolean
  favorState: boolean
  mode: 'local' | 'remote' | 'none'
  /** The directory passed as `--state`; null when there is none to use. */
  stateDir: string | null
  /** Why defer is configured but cannot be applied. */
  reason: string | null
  /** /defer on or off for this session; null follows the project's setting. */
  override: boolean | null
  /** The profile's default target and its output names. */
  defaultTarget: string | null
  targets: string[]
  /** /target for this session; null leaves the command's own or the profile's default. */
  target: string | null
  /** When reading the setting failed (engine clock, ms); null when it was read. */
  failedAt: number | null
}

// ---------------------------------------------------------------------------------------------------
// Raw SQL to model: the SQL being turned into a dbt model.
// Filled in by that feature alone (hooks/features/); the other features never read or write it.
// ---------------------------------------------------------------------------------------------------
/** How a table of the SQL matched a model or source: every part the same, the same but for case, fewer parts written, or none. */
export type RelationMatch = 'exact' | 'case_insensitive' | 'partial' | 'none'

export interface ToModelState {
  /** The model to write. */
  name: string
  /** Where the SQL came from: a file path, or "selection". */
  source: string
  /** The dialect the tool read the SQL with; null when it did not say. */
  dialect: string | null
  /** The folder the project keeps its models in, relative to the session's root, or whole when the project lies outside it; unset when neither the SQL's folder nor the session's root is in a dbt project. */
  modelsDir?: string
  /** One row per table, unmatched and partial first. */
  rows: {
    raw: string
    replaceWith: string
    match: RelationMatch
    candidates: { replaceWith: string; kind: string; name: string; relationName: string; match: RelationMatch }[]
  }[]
  /** The SQL, kept so the prompt can quote it. */
  sql: string
}

// ---------------------------------------------------------------------------------------------------
// Team comments: the shared docs' comments on the project's models.
// Filled in by that feature alone (hooks/features/); the other features never read or write it.
// ---------------------------------------------------------------------------------------------------
/** One open comment thread on a shared docs page, as the docs_share_comments tool lists it. */
export interface CommentsThread {
  shareId: number
  shareName: string
  groupId: number
  /** The model file, relative to the dbt project folder. */
  filePath?: string
  uniqueId?: string
  column?: string
  field?: string
  /** The text the comment was made on. */
  highlight?: string
  /** 0-based lines the comment was made on, when the page stored a range. */
  range?: { start: { line: number }; end: { line: number } }
  messages: { id: number; author: string; text: string }[]
}

export interface CommentsState {
  /** The dbt project folder the threads belong to. */
  root: string | null
  project: string | null
  threads: CommentsThread[]
  loadedAt: number | null
  loading: boolean
  /** Set when the installed altimate-code has no docs_share_comments tool: what to tell the person. */
  needs: string | null
  /** Why the last load failed. */
  error: string | null
  /** Set when the last list was only part of the threads: what to tell the person. */
  partial: string | null
  /** The outcome of the last post. */
  note: string | null
  /** Reply text typed so far, by `shareId:groupId`. */
  drafts: Record<string, string>
  /** `shareId:groupId` of the thread being posted to. */
  posting: string | null
}

// ---------------------------------------------------------------------------------------------------
// Cost check: the last scan estimate and any scan allowed once.
// Filled in by that feature alone (hooks/features/); the other features never read or write it.
// ---------------------------------------------------------------------------------------------------
export interface CostState {
  /** The warehouse with no estimate (not BigQuery, Snowflake or Databricks, or an altimate-code too old for it), once the tool said so: nothing is estimated after that. */
  unsupportedAdapter: string | null
  /** The newest estimate: what was estimated, in bytes, as the dry run or the planner gave it. */
  lastEstimate: { target: string; bytes: number; display: string } | null
  /** The command held for being over the limit, until it is allowed or a later dbt command is estimated under the limit; `bytes` is its scan's upper bound, `planner` the warehouse whose planner made the estimate (none for a dry run). */
  held: { command: string; target: string; bytes: number; display: string; planner?: string } | null
  /** /allow-scan was given for the held command: that same command runs once. */
  allowOnce: boolean
}

// ---------------------------------------------------------------------------------------------------
// Project health: the health check issues on the changed models.
// Filled in by that feature alone (hooks/features/); the other features never read or write it.
// ---------------------------------------------------------------------------------------------------
/** One DataPilot insight on a model, as altimate-code's dbt_health returns it. */
export interface HealthInsight {
  uniqueId: string
  path: string
  name: string
  severity: string
  message: string
  recommendation: string
  /** The model's SQL file and its properties file, absolute; empty when the model is not the project's own. */
  file: string
  properties: string
}

export interface HealthState {
  /** `uniqueId\u0000insight name` of every insight the project had at session start; null until that run lands. */
  baseline: string[] | null
  /** Model files changed since the last check. */
  pending: string[]
  /** Every model file changed this session. */
  touched: string[]
  /** What the last check found that the baseline lacked, on the touched models. */
  issues: HealthInsight[]
  /** Why the check can't run, shown once per distinct reason. */
  problem: string | null
  running: boolean
}

// ---------------------------------------------------------------------------------------------------
// SQL graph: the edited model's SQL graph.
// Filled in by that feature alone (hooks/features/); the other features never read or write it.
// ---------------------------------------------------------------------------------------------------
export interface SqlGraphState {
  /** The model Claude last read or edited, which /sql-graph shows when it is given no name. */
  lastModel: string | null
  /** The model the pane shows, with its graph once the tool answered; `request` is the ask that owns it, so an older ask's answer is dropped. */
  shown: { model: string; request: number; graph: SqlGraphView | null; loading: boolean; message: string | null; selected: string | null } | null
}

/** What `dbt_sql_graph` returns: one node per CTE, relation or select, and the edges between them (input id, then consumer id). A node's `id` is unique; its `name` is only what is shown and can repeat. */
export interface SqlGraphView {
  nodes: { id: string; name: string; type: string; nodeId?: string; sql: string; columns: { name: string; datatype?: string; expression?: string }[] }[]
  edges: [string, string][]
}

// ---------------------------------------------------------------------------------------------------
// Docs coverage and propagation: what the project documents.
// Filled in by that feature alone (hooks/features/); the other features never read or write it.
// ---------------------------------------------------------------------------------------------------
/** A downstream column that can take a description: the traced column reaches it unchanged (Original) or only renamed (Alias). */
export interface DocsCandidate {
  model: string
  /** The model's unique_id: names repeat across packages and versions. */
  id?: string
  column: string
  lens: 'Original' | 'Alias'
}

/** A description Claude wrote, and the downstream columns that can take it. */
export interface DocsGroup {
  model: string
  column: string
  description: string
  manifest: string
  /** The YAML file the description was written in. */
  file: string
  candidates: DocsCandidate[]
}

/** The documentation coverage of the model whose SQL Claude last edited. */
export interface DocsCoverageView {
  model: string
  percent: number
  documented: number
  total: number
  /** Output columns without a description. */
  missing: string[]
  hasDescription: boolean
  /** Read from a manifest dbt wrote before the model's last edit; the edit's check reads it again. */
  stale: boolean
}

export interface DocsState {
  /** Written descriptions with candidates, oldest first. */
  groups: DocsGroup[]
  /** Candidates the person unticked in the pane, keyed `manifest|model.column>unique_id.column`. */
  skipped: string[]
  coverage: DocsCoverageView | null
}

// ---------------------------------------------------------------------------------------------------
// Profile CTEs: each CTE's row count and timing.
// Filled in by that feature alone (hooks/features/); the other features never read or write it.
// ---------------------------------------------------------------------------------------------------
export type CteTier = 'hot' | 'warm' | 'cool'

export interface CteRow {
  name: string
  line: number
  /** Offset of the WITH keyword the CTE belongs to: CTEs of one WITH clause build on each other. */
  clause: number
  status: 'pending' | 'running' | 'done' | 'failed'
  /** Wall time of the count query, which holds every earlier CTE of its clause (a warehouse may skip those the CTE does not use). */
  queryMs?: number
  rows?: number
  /** Time this CTE adds over the one before it. */
  marginalMs?: number
  tier?: CteTier
  error?: string
}

export interface CteProfileState {
  model: string
  status: 'listing' | 'running' | 'stopping' | 'done' | 'stopped' | 'failed'
  rows: CteRow[]
  message?: string
}

declare module 'claude-code' {
  interface PluginState {
    'altimate-code': {
      status: Shaped<IntegrationsStatus | null>
      busy: Busy | null
      message: string | null
      isBandHidden: boolean
      expanded: Expanded | null
      form: Form | null
      /** Shown inside the open form: the provider's refusal or the fields still missing. */
      formMessage: string | null
      /** Workspaces offered for linking this folder; null when the picker is closed. */
      workspaces: WorkspaceChoice[] | null
      /** Non-secret text typed into the open form, by field name, saved when the form is submitted. */
      typed: Record<string, string>
      /** The model the lineage pane follows; null until Claude reads or edits one, or /lineage names one. */
      lineageFocus: Shaped<LineageFocus | null>
      /** The graph the pane draws, for the followed model's project. */
      lineageGraph: Shaped<LineageGraph | null>
      /** dbt_lineage for the followed model. */
      lineageColumns: Shaped<ColumnLineage | null>
      /** The column the pane's column box is about. */
      lineageColumn: string | null
      lineageReach: Shaped<ColumnReachView | null>
      /** Warehouse lineage from a connected SaaS MCP server's table_lineage; null when none is connected. */
      lineageWarehouse: Shaped<WarehouseView | null>
      /** Whether the upstream and downstream sections show every node. */
      lineageExpanded: { up: boolean; down: boolean }
      /** How the pane draws the graph: boxes and arrows, only its ends, folders, or the text lists. */
      lineageView: 'graph' | 'ends' | 'folders' | 'list'
      /** The graph canvas's first visible column; null centres it on the followed model. */
      lineagePan: number | null
      /** The dbt models Claude's last answer names, first named first. */
      lineageAnswer: AnswerModel[]
      /** Why there is no lineage to show, or what the last step reported. */
      lineageMessage: string | null
      /** The shown model's SQL file changed after the manifest was written, said so; null when it didn't. */
      lineageStale: string | null
      /** Why the pane waits undrawn on a narrow terminal, and the width it needs; null when it does not. */
      lineageNarrow: { text: string; floor: number | null } | null
      lineageLoading: boolean
      /** Compile-and-validate's answer for the last model Claude edited. */
      dbtCheck: CheckView | null
      /** The last failed dbt run, test, build, seed, snapshot or retry Claude ran; null once a passing run of the same kind, selection, project and context (or a whole-project build, or a build with the same selection) clears it or it is dismissed. A passing `dbt retry` never clears it, and neither does a run whose output shows no passing summary or cannot be split per command (piped through `tail`, headers cut off). A compound command (`run+test`) is cleared only by the same command again or a whole-project build. */
      dbtFailure: FailureView | null
      /** The environment doctor's answer for the session's dbt project. */
      dbtDoctor: DoctorView | null
      /** The query the results pane shows. */
      dbtResult: QueryResult | null
      /** Earlier queries and bookmarks, newest first, for the results pane. */
      dbtHistory: SavedQuery[]
      /** A /dbt-show or Re-run in flight: its label. */
      dbtResultBusy: string | null
      /** The Min, Default or Max size chosen for a pane, by pane id; a pane without one opens at its default. */
      paneSizes: Record<string, 'min' | 'default' | 'max'>
      /** The end-of-task column impact summary the band shows; null until a task changes a model. */
      lineageTaskSummary: Shaped<TaskSummaryView | null>
      lineagePlanImpact: Shaped<PlanImpactView | null>
      isLineageSummaryHidden: boolean
      /** The status line's parts by owner, `integrations` and each feature's id (hooks/status-line.ts). */
      statusParts: Record<string, string>
      /** hooks/features/: RunsState. */
      runs: Shaped<RunsState | null>
      /** hooks/features/: DeferState. */
      defer: DeferState | null
      /** hooks/features/: the flags /defer and /target added to Claude's last dbt command, until the next prompt; null with none. */
      deferRan: string | null
      /** hooks/features/: ToModelState. */
      toModel: ToModelState | null
      /** hooks/features/: CommentsState. */
      comments: Shaped<CommentsState | null>
      /** hooks/features/: CostState. */
      cost: CostState | null
      /** hooks/features/: HealthState. */
      health: HealthState | null
      /** hooks/features/: SqlGraphState. */
      sqlGraph: Shaped<SqlGraphState | null>
      /** hooks/features/: DocsState. */
      docs: DocsState | null
      /** hooks/features/: CteProfileState. */
      cteProfile: CteProfileState | null
    }
  }
}
