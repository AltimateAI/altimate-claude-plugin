import { expect, test } from 'claude-code/testing'

import { nothingToReport } from '../inert-features'
import {
  registerFeatures,
  attempt,
  featureBandLines,
  featuresBashAfter,
  featuresBashGate,
  featuresBashRewrite,
  featuresEditAfter,
  featuresReadOrEditAfter,
  featuresSessionEnd,
  featuresSessionStart,
  featuresTurnComplete,
  featuresTurnStart,
} from './index'

const engine = () => {
  const logs: string[] = []
  const atoms = new Map<string, unknown>()
  // Enough of the engine for a feature that keeps state, reads files and registers commands; a stub needs none of it.
  const $ = {
    ui: { log: (text: string) => void logs.push(text), status: async () => {}, toast: () => {}, open: async () => {} },
    fs: { exists: async () => false, read: async () => '', list: async () => [], stat: async () => null },
    state: {
      get: async (key: unknown) => ({ value: atoms.get(JSON.stringify(key)) }),
      set: async (key: unknown, value: unknown) => (atoms.set(JSON.stringify(key), value), { isSet: true }),
    },
    command: { register: async () => {} },
    // What the features that are built ask of the session: a project with nothing to report, no CLI beyond the data tools, no clock work run.
    process: { run: async (argv: readonly string[]) => nothingToReport(argv) ?? { exitCode: 1, stdout: '', stderr: 'no CLI here' } },
    clock: { now: async () => 0, after: () => {}, every: () => {}, sleep: async () => {} },
    session: { root: async () => '/repo', cwd: async () => '/repo' },
    store: { get: async () => null, set: async () => {}, keys: async () => [], delete: async () => {} },
    env: { get: async () => undefined },
    mcp: { connect: async () => ({ isConnected: false, reason: 'not_connected', message: 'off' }) },
  }
  return { logs, $: $ as any }
}

test('attempt logs a feature function that throws at once, one that rejects, and passes a value on', async () => {
  const { $, logs } = engine()
  // Each phase wraps the call in attempt, so a function that throws before it returns a promise
  // (not an async function) is caught like a rejection.
  const syncThrow = (): Promise<string> => {
    throw new Error('at once')
  }
  expect(await attempt($, 'runs', 'sessionStart', syncThrow)).toBeUndefined()
  expect(await attempt($, 'defer', 'bandLine', async () => Promise.reject(new Error('later')))).toBeUndefined()
  expect(await attempt($, 'cost', 'bashGate', () => ({ deny: 'no' }))).toEqual({ deny: 'no' })
  expect(await attempt($, 'docs', 'bashRewrite', async () => 'dbt run')).toBe('dbt run')
  expect(logs).toEqual(['runs · sessionStart failed: Error: at once', 'defer · bandLine failed: Error: later'])
})

test('no feature fails in any phase: every failure would be logged, and none is', async () => {
  const { $, logs } = engine()
  // The engine does record a failure: a feature function that throws is logged through it.
  await attempt($, 'runs', 'sessionStart', () => {
    throw new Error('broken')
  })
  expect(logs.splice(0)).toEqual(['runs · sessionStart failed: Error: broken'])
  const bash = { tool: 'Bash', command: 'dbt run -s a' } as any
  const file = { tool: 'Edit', file_path: '/repo/models/a.sql' } as any
  await featuresSessionStart($, {} as any)
  await featuresTurnStart($, {} as any)
  await featureBandLines($, {} as any)
  await featuresBashRewrite($, bash)
  await featuresBashGate($, bash)
  await featuresBashAfter($, bash, {} as any)
  await featuresEditAfter($, file, {} as any, { path: '/repo/models/a.sql', before: null })
  await featuresReadOrEditAfter($, file, {} as any, { path: '/repo/models/a.sql' })
  await featuresTurnComplete($, {} as any, {} as any)
  await featuresSessionEnd($, {} as any)
  // A feature may log what it does; what must not appear is a failure, which is logged as `<id> · <phase> failed: …`.
  expect(logs.filter(line => line.includes(' failed: '))).toEqual([])
})

test('each phase runs through the features, which find nothing to report and log nothing', async () => {
  const { $, logs } = engine()
  const bash = { tool: 'Bash', command: 'dbt run -s a' } as any
  const file = { tool: 'Edit', file_path: '/repo/models/a.sql' } as any
  await featuresSessionStart($, {} as any)
  await featuresTurnStart($, {} as any)
  await featuresTurnComplete($, {} as any, {} as any)
  await featuresSessionEnd($, {} as any)
  expect(await featureBandLines($, {} as any)).toEqual([])
  expect(await featuresBashRewrite($, bash)).toBe('dbt run -s a')
  expect(await featuresBashGate($, bash)).toBeNull()
  // A dbt command may get a note from a feature that watches dbt (what a run would scan); a call no feature watches gets none.
  expect(await featuresBashAfter($, { tool: 'Bash', command: 'ls models', tool_use_id: 'ls' } as any, {} as any)).toEqual([])
  expect(await featuresEditAfter($, file, {} as any, { path: '/repo/models/a.sql', before: null })).toEqual([])
  expect(await featuresReadOrEditAfter($, file, {} as any, { path: '/repo/models/a.sql' })).toEqual([])
  // The runs feature is real here and needs a fuller engine than this stub; every other feature must log nothing.
  expect(logs.filter(line => !line.startsWith('runs · '))).toEqual([])
})

test('a feature whose register throws never reaches the caller, so the tool hook after the features still installs', () => {
  let calls = 0
  const on = new Proxy(() => {}, {
    get: () => on,
    apply: () => {
      calls++
      throw new Error('refused matcher')
    },
  }) as any
  expect(() => registerFeatures(on, { options: {} } as any)).not.toThrow()
  expect(calls).toBeGreaterThan(0)
})
