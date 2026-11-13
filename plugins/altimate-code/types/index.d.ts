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

// ---------------------------------------------------------------------------------------------------
// Runs (/runs): the dbt commands Claude ran and their results.
// Filled in by that feature alone (hooks/features/); the other features never read or write it.
// ---------------------------------------------------------------------------------------------------
export interface RunsState {}

// ---------------------------------------------------------------------------------------------------
// Defer and target: the target and defer state dbt commands run with.
// Filled in by that feature alone (hooks/features/); the other features never read or write it.
// ---------------------------------------------------------------------------------------------------
export interface DeferState {}

// ---------------------------------------------------------------------------------------------------
// Raw SQL to model: the SQL being turned into a dbt model.
// Filled in by that feature alone (hooks/features/); the other features never read or write it.
// ---------------------------------------------------------------------------------------------------
export interface ToModelState {}

// ---------------------------------------------------------------------------------------------------
// Team comments: the shared docs' comments on the project's models.
// Filled in by that feature alone (hooks/features/); the other features never read or write it.
// ---------------------------------------------------------------------------------------------------
export interface CommentsState {}

// ---------------------------------------------------------------------------------------------------
// Cost check: the last scan estimate and any scan allowed once.
// Filled in by that feature alone (hooks/features/); the other features never read or write it.
// ---------------------------------------------------------------------------------------------------
export interface CostState {}

// ---------------------------------------------------------------------------------------------------
// Project health: the health check issues on the changed models.
// Filled in by that feature alone (hooks/features/); the other features never read or write it.
// ---------------------------------------------------------------------------------------------------
export interface HealthState {}

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
export interface DocsState {}

// ---------------------------------------------------------------------------------------------------
// Profile CTEs: each CTE's row count and timing.
// Filled in by that feature alone (hooks/features/); the other features never read or write it.
// ---------------------------------------------------------------------------------------------------
export interface CteProfileState {}

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
      /** The status line's parts by owner, `integrations` and each feature's id (hooks/status-line.ts). */
      statusParts: Record<string, string>
      /** hooks/features/: RunsState. */
      runs: RunsState | null
      /** hooks/features/: DeferState. */
      defer: DeferState | null
      /** hooks/features/: ToModelState. */
      toModel: ToModelState | null
      /** hooks/features/: CommentsState. */
      comments: CommentsState | null
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
