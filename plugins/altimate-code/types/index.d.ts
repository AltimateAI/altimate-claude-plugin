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
  /** ISO time the access token stops working; null when it does not expire. */
  expiresAt?: string | null
  note: string | null
}

export type IntegrationsStatus = {
  workspace: { name: string; tenant: string | null }
  providers: Provider[]
}

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
      /** Non-secret text typed into the open form, by field name, saved when the form is submitted. */
      typed: Record<string, string>
    }
  }
}
