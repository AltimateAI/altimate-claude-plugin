export type ProviderId = 'github' | 'jira' | 'linear'

export type ProviderState = 'connected' | 'expired' | 'detected' | 'available' | 'not_found'

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
  /** ISO time the access token stops working; null when it does not expire. */
  expiresAt?: string | null
  note: string | null
}

export type IntegrationsStatus = {
  workspace: { name: string; tenant: string | null }
  providers: Provider[]
}

/** The action running now, with what the pane shows while it runs. */
export type Busy = { provider: ProviderId | 'all'; label: string; url: string | null }

declare module 'claude-code' {
  interface PluginState {
    'altimate-code': {
      status: Shaped<IntegrationsStatus | null>
      busy: Busy | null
      message: string | null
      isBandHidden: boolean
    }
  }
}
