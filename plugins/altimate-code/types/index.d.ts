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
   * The flags it ran with, in the order written: every flag but the selection and display-only ones (target,
   * vars, `--full-refresh`, …), then its environment. A passing run with other flags clears nothing. A command
   * that ran several invocations with different flags keeps each one's list, in order.
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
      lineageImpact: Shaped<ImpactView | null>
      /** The dbt models Claude's last answer names, first named first. */
      lineageAnswer: AnswerModel[]
      /** Why there is no lineage to show, or what the last step reported. */
      lineageMessage: string | null
      /** The shown model's SQL file changed after the manifest was written, said so; null when it didn't. */
      lineageStale: string | null
      lineageLoading: boolean
      isLineageBandHidden: boolean
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
    }
  }
}
