import { expect, mock, test } from 'claude-code/testing'

import { nothingToReport } from '../inert-features'
import {
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
  // Enough of the engine for a feature that keeps state, reads files and registers commands; a stub needs none of it.
  const $ = {
    ui: { log: (text: string) => void logs.push(text) },
    fs: { exists: async () => false, read: async () => '' },
    state: { get: async () => ({ value: null }), set: async () => ({ isSet: true }), update: async () => ({ isSet: true }) },
    command: { register: async () => {} },
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

test('each phase runs through the features, which find nothing to report and log nothing', async ($, on) => {
  // Under the plugin sits a session with nothing to report, so a feature that is built (it keeps state,
  // registers commands, asks the CLI) has nothing to say whichever features are built.
  const logs: string[] = []
  mock.clock(on)
  on('ui.log', (_: unknown, e: { text: string }) => (logs.push(e.text), { value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('command.register', (_: unknown, e: { name: string }) => ({ value: { command: e.name } }))
  on('session.root', () => ({ value: '/repo' }))
  on('fs.exists', () => ({ value: false }))
  on('process.run', (_: unknown, e: { argv: readonly string[] }) => ({ value: nothingToReport(e.argv) ?? { exitCode: 1, stdout: '', stderr: 'no CLI here' } }))
  const bash = { tool: 'Bash', command: 'dbt run -s a' } as any
  const file = { tool: 'Edit', file_path: '/repo/models/a.sql' } as any
  await featuresSessionStart($, {} as any)
  await featuresTurnStart($, {} as any)
  await featuresTurnComplete($, {} as any, {} as any)
  await featuresSessionEnd($, {} as any)
  expect(await featureBandLines($, {} as any)).toEqual([])
  expect(await featuresBashRewrite($, bash)).toBe('dbt run -s a')
  expect(await featuresBashGate($, bash)).toBeNull()
  expect(await featuresBashAfter($, bash, {} as any)).toEqual([])
  expect(await featuresEditAfter($, file, {} as any, { path: '/repo/models/a.sql', before: null })).toEqual([])
  expect(await featuresReadOrEditAfter($, file, {} as any, { path: '/repo/models/a.sql' })).toEqual([])
  expect(logs).toEqual([])
})
