// The checks Altimate's hosted product runs that /savings does not, by the names its catalog gives them.
//
// Databricks: the detectors in altimate-ingestion's `marts/opportunities` models, each model's `insight_id`
// and `name`; the two `*_autotune_owned` models there emit no opportunities and are not checks. Snowflake:
// the warehouse rules in `int_opp_wh_insight_catalog`, which has ids and no display names, so a name here
// is its id in words. Each row says what this run's own counts show the check would read, and nothing else:
// no such check ran, so no row is a finding.
import type { SavingsPlatform, SavingsView } from '../types'
import { count, windowDays } from './savings-format'

/** How many checks the hosted product runs for each platform, and how many of them /savings runs. */
export const HOSTED_CHECK_COUNT: Record<SavingsPlatform, number> = { databricks: 13, snowflake: 11 }
export const LOCAL_CHECK_COUNT = 4

/**
 * How many of the local checks did not run, each once: an entry is "Check name (reason)", and one check can be
 * listed once per workspace. Databricks only: a Snowflake entry can cover several checks, or be about warehouses.
 */
export function skippedChecks(view: Pick<SavingsView, 'skipped'>): number {
  return Math.min(LOCAL_CHECK_COUNT, new Set(view.skipped.map(one => one.replace(/ \(.*$/s, ''))).size)
}

/** No local check ran, so nothing was checked: a verdict must not read as "nothing found". */
export const nothingRan = (view: Pick<SavingsView, 'platform' | 'skipped'>) => view.platform === 'databricks' && skippedChecks(view) >= LOCAL_CHECK_COUNT

type Facts = { warehouses: number; billedNothing: number | null; clusters: number | null; jobs: number | null; queries: number | null; queriesOn: string | null; days: number }
type Check = { id: string; name: string; reads: (facts: Facts) => string }

const plural = (value: number, one: string, many = `${one}s`) => `${count(value)} ${value === 1 ? one : many}`
const warehouses = (facts: Facts) => plural(facts.warehouses, 'SQL warehouse')
const sfWarehouses = (facts: Facts) => plural(facts.warehouses, 'warehouse')
/** A row about things this run counted. Null is a count it could not read, which says nothing about how many there are. */
const about = (value: number | null, one: string, days: number, rest: string) =>
  value === null ? `this run could not read its ${one}s` : value === 0 ? `no ${one}s in these ${days} days` : `${plural(value, one)}: ${rest}`
/** A row about jobs. The run counts only jobs that ran on all-purpose compute, so its count is not all the jobs there are. */
const jobRow = (facts: Facts, rest: string) =>
  facts.jobs === null
    ? 'this run could not read its jobs'
    : facts.jobs === 0
      ? 'not read: this run counts only jobs on all-purpose compute, and saw none'
      : `${plural(facts.jobs, 'job')} on all-purpose compute, of possibly more: ${rest}`
const queriesOn = (facts: Facts) => `${plural(facts.queries!, 'query', 'queries')} on ${facts.queriesOn ?? 'the flagged warehouses'}`

const NOT_RUN: Record<SavingsPlatform, readonly Check[]> = {
  databricks: [
    { id: 'wh_idle_ratio', name: 'High Warehouse Idle Time', reads: f => `${warehouses(f)}: not ranked by idle time` },
    {
      id: 'wh_stale_warehouse',
      name: 'Stale/Orphaned Warehouse',
      reads: f => (f.billedNothing === null ? `${warehouses(f)} not checked for disuse` : `${count(f.billedNothing)} of ${warehouses(f)} billed nothing in these ${f.days} days, not checked further`),
    },
    {
      id: 'wh_undersized_concurrency',
      name: 'Undersized Concurrency Capacity',
      reads: f => (f.queries ? `${queriesOn(f)} not ranked for queueing` : `${warehouses(f)} not ranked for queueing`),
    },
    { id: 'ap_driver_oversized', name: 'Driver Node Oversizing', reads: f => about(f.clusters, 'all-purpose cluster', f.days, 'drivers not compared with their workers') },
    { id: 'apc_memory_pressure_undersized', name: 'Memory-Starved All-Purpose Cluster (Sustained Swap)', reads: f => about(f.clusters, 'all-purpose cluster', f.days, 'memory and swap not read') },
    { id: 'apc_zombie_cluster', name: 'Ghost All-Purpose Cluster', reads: f => about(f.clusters, 'all-purpose cluster', f.days, 'billing not compared with node telemetry') },
    { id: 'job_consecutive_failures', name: 'Continuously Failing Job', reads: f => jobRow(f, 'run history not read for repeated failures') },
    { id: 'jobs_hung_runs', name: 'Hung & Long-Cancelled Job Runs', reads: f => jobRow(f, 'runs not checked for hangs') },
    { id: 'jobs_periodic_trigger_overhead', name: 'Periodic Job Cluster-Startup Overhead', reads: f => jobRow(f, 'cluster start-up time not measured') },
  ],
  snowflake: [
    { id: 'no_resource_monitor', name: 'No resource monitor', reads: f => `${sfWarehouses(f)}: resource monitors not read` },
    { id: 'auto_tune_disabled', name: 'Auto tune disabled', reads: f => `${sfWarehouses(f)}: Auto Tune setting not read` },
    {
      id: 'many_queries_under_5_seconds',
      name: 'Many queries under 5 seconds',
      reads: f => (f.queries ? `${queriesOn(f)} not bucketed by duration` : `${sfWarehouses(f)}: queries not bucketed by duration`),
    },
    { id: 'frequent_short_warehouse_activity', name: 'Frequent short warehouse activity', reads: f => `${sfWarehouses(f)}: resume and suspend pattern not read` },
    { id: 'high_cloud_services_cost', name: 'High cloud services cost', reads: f => `${sfWarehouses(f)}: cloud services share not read` },
    { id: 'high_auto_suspend', name: 'High auto suspend', reads: f => `${sfWarehouses(f)}: auto-suspend setting not read` },
    { id: 'convert_to_gen2', name: 'Convert to Gen2', reads: f => `${sfWarehouses(f)} not compared with Gen2` },
  ],
}

export type CheckNotRun = { id: string; name: string; reads: string }

/** The hosted checks this run left out, each with what the run's own counts show it would read. */
export function checksNotRun(view: SavingsView): CheckNotRun[] {
  const costs = view.inventory.map(one => one.windowCost)
  const facts: Facts = {
    warehouses: view.checked.warehouses,
    // Only when every warehouse's cost is known: otherwise "billed nothing" would be a guess.
    billedNothing: costs.length > 0 && costs.every(cost => cost !== null) ? costs.filter(cost => cost === 0).length : null,
    // A check that could not read its table reports a count of 0, which is no count at all.
    clusters: view.skipped.some(one => one.startsWith('Idle Cluster Detection')) ? null : view.checked.clusters,
    jobs: view.skipped.some(one => one.startsWith('Job Running on All-Purpose Compute')) ? null : view.checked.jobs,
    queries: view.queryCount,
    queriesOn: view.queriesOn,
    days: windowDays(view.window),
  }
  return NOT_RUN[view.platform].map(check => ({ id: check.id, name: check.name, reads: check.reads(facts) }))
}
