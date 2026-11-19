// Anonymous usage events, sent through altimate-code's own telemetry (`altimate tool report-event`): the
// plugin opens no network connection of its own. A session start carries the plugin version, the OS and a
// random install id kept in this plugin's Claude Code store (the CLI adds its own version); a feature
// used carries which panel, command or gate, and its outcome. Nothing else: no project, model, column or
// file names, SQL or session text. The CLI checks every value against a fixed list or pattern.
//
// Every event runs in the background and is never awaited by a hook. With the telemetry opt-out set, no
// CLI is started and no install id is made; the CLI also drops events under its own opt-out (its config).
// An altimate-code without these actions refuses them, and nothing is shown.
import type { EngineInterface } from 'claude-code'

import { later, runAltimate } from './altimate-cli'

export type Feature =
  | 'lineage'
  | 'dbt_show'
  | 'profile_ctes'
  | 'scan_cost'
  | 'comments'
  | 'sql_graph'
  | 'health'
  | 'runs'
  | 'to_model'
  | 'cost_gate'
  | 'health_push_gate'

/** A panel opened or could not open; a gate held a command or let it through. */
export type Outcome = 'opened' | 'failed' | 'held' | 'allowed'

const INSTALL_ID_KEY = 'usage.installId'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,32})?$/
const OS = new Set(['macos', 'linux', 'windows', 'wsl'])
const EVENT_TIMEOUT_MS = 15_000

// The CLI's own reading of its opt-out: "true" or "1", any case.
const isSet = (value: string | undefined) => value !== undefined && ['true', '1'].includes(value.toLowerCase())

/** True when the telemetry opt-out is set, or the environment cannot be read (then nothing is sent). */
export async function usageOff($: EngineInterface): Promise<boolean> {
  try {
    const [altimate, opencode] = await Promise.all([$.env.get('ALTIMATE_TELEMETRY_DISABLED'), $.env.get('OPENCODE_DISABLE_TELEMETRY')])
    return isSet(altimate) || isSet(opencode)
  } catch {
    return true
  }
}

/** The anonymous install id: made on first run and kept in this plugin's store, so it stays the same across sessions. */
export async function installId($: EngineInterface): Promise<string> {
  const kept = await $.store.get(INSTALL_ID_KEY)
  if (typeof kept === 'string' && UUID.test(kept)) return kept
  const made = crypto.randomUUID().toLowerCase()
  await $.store.set(INSTALL_ID_KEY, made)
  return made
}

let ownVersion: string | null = null

/** This plugin's version from its manifest, or `unknown`. */
async function pluginVersion($: EngineInterface): Promise<string> {
  if (ownVersion) return ownVersion
  const version = await $.fs
    .read(`${$.plugin.root}/.claude-plugin/plugin.json`)
    .then(text => (JSON.parse(text) as { version?: unknown }).version)
    .catch(() => undefined)
  return (ownVersion = typeof version === 'string' && VERSION.test(version) ? version : 'unknown')
}

async function send($: EngineInterface, action: 'plugin_session_start' | 'plugin_feature_used', fields: string[]) {
  if (await usageOff($)) return
  const session = await $.session.id()
  const [version, install] = await Promise.all([pluginVersion($), installId($)])
  const argv = ['tool', 'report-event', action, '--session', `claude:${session}`, '--plugin-version', version, '--install-id', install, ...fields]
  // An older CLI answers with an error: it is not this plugin's to show.
  await runAltimate($, argv, EVENT_TIMEOUT_MS).catch(() => null)
}

/** One `plugin_session_start`, in the background. Never throws: a usage event never stops a hook. */
export function sessionStarted($: EngineInterface) {
  try {
    later($, async () => {
      const platform = await $.session
        .info()
        .then(info => info.platform)
        .catch(() => undefined)
      await send($, 'plugin_session_start', ['--os', platform && OS.has(platform) ? platform : 'unknown'])
    })
  } catch {}
}

/** One `plugin_feature_used`, in the background. Never throws: a usage event never stops a hook. */
export function featureUsed($: EngineInterface, feature: Feature, outcome: Outcome) {
  try {
    later($, () => send($, 'plugin_feature_used', ['--feature', feature, '--outcome', outcome]))
  } catch {}
}
