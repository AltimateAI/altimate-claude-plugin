import { expect, test } from 'claude-code/testing'

import { compareVersions, isPreviewBuild, parseVersion, runTool, within } from './altimate-cli'

/** A stand-in for `$` whose CLI answers every call and whose MCP connection attempts go through `connect`. */
function standIn(connect: () => unknown, now = 0) {
  const argvs: string[][] = []
  let mcpCalls = 0
  const $: any = {
    process: {
      run: async (argv: string[]) => {
        argvs.push(argv)
        return { exitCode: 0, stdout: JSON.stringify({ status: 'ok', output: 'done', metadata: { n: 1 } }) }
      },
    },
    mcp: {
      connect: async () => connect(),
      // No answer: a call that does reach the server falls back to the CLI.
      call: async () => (mcpCalls++, null),
    },
    // A deadline that never fires, so the fallback is the no-answer one.
    clock: { now: async () => now, after: () => {} },
  }
  return { $, argvs, mcpCalls: () => mcpCalls }
}

test('a read call goes without --allow-write; a write call goes through the CLI with it', async () => {
  const { $, argvs } = standIn(() => null)
  expect(await runTool($, 'dbt_manifest', { a: 1 })).toEqual({ metadata: { n: 1 }, text: 'done', ok: true })
  expect(await runTool($, 'dbt_manifest', { a: 1 }, { write: true })).toEqual({ metadata: { n: 1 }, text: 'done', ok: true })
  expect(argvs.map(argv => argv.slice(1))).toEqual([
    ['tool', 'run', 'dbt_manifest', '--args', '{"a":1}', '--json'],
    ['tool', 'run', 'dbt_manifest', '--args', '{"a":1}', '--json', '--allow-write'],
  ])
})

test('a write call never asks the MCP server, even when one is connected', async () => {
  let connects = 0
  const { $, argvs, mcpCalls } = standIn(() => {
    connects++
    return { isConnected: true, server: 'altimate-code' }
  }, 10 * 60_000)
  await runTool($, 'dbt_manifest', {}, { write: true })
  expect(connects).toBe(0)
  expect(argvs).toHaveLength(1)
  // The same call without `write` does ask the server: the test above can fail. It gets no answer, so
  // it goes through the CLI without --allow-write.
  await runTool($, 'dbt_manifest', {})
  expect(connects).toBe(1)
  expect(mcpCalls()).toBe(1)
  expect(argvs.map(argv => argv.slice(1))[1]).toEqual(['tool', 'run', 'dbt_manifest', '--args', '{}', '--json'])
})

test('a failure with no answer object keeps its first line of text; one with an object keeps the object\'s', async () => {
  const failing = (run: () => unknown) => {
    const { $ } = standIn(() => null)
    $.process.run = async () => run()
    return $
  }
  const text = async (run: () => unknown) => (await runTool(failing(run), 'dbt_manifest', {})).text
  expect(await text(() => ({ exitCode: 1, stdout: 'Error: no such tool\nusage: altimate tool run', stderr: 'ignored' }))).toBe('Error: no such tool')
  expect(await text(() => ({ exitCode: 1, stdout: '', stderr: '\nTypeError: crashed\n    at main' }))).toBe('TypeError: crashed')
  expect(await text(() => ({ exitCode: 1, stdout: 'x'.repeat(900), stderr: '' }))).toBe('x'.repeat(500))
  expect(await text(() => ({ exitCode: 1, stdout: '', stderr: '' }))).toBe('')
  // An answer cut off mid-JSON is no message: only stderr, if any, is shown.
  expect(await text(() => ({ exitCode: 1, stdout: '{"status":"ok","out', stderr: '' }))).toBe('')
  expect(await text(() => ({ exitCode: 1, stdout: '{"status":"ok","out', stderr: 'Killed: out of memory' }))).toBe('Killed: out of memory')
  // An answer object speaks for itself: its output, or nothing, never a line of stderr.
  expect(await text(() => ({ exitCode: 1, stdout: JSON.stringify({ status: 'error', output: 'boom', metadata: {} }), stderr: 'noise' }))).toBe('boom')
  expect(await text(() => ({ exitCode: 1, stdout: JSON.stringify({ status: 'error', metadata: {} }), stderr: 'noise' }))).toBe('')
  const result = await runTool(failing(() => ({ exitCode: 2, stdout: 'plain failure' })), 'dbt_manifest', {})
  // The whole output also comes back as `raw`, for a caller that reads more than its first line.
  expect(result).toEqual({ metadata: null, text: 'plain failure', ok: false, raw: 'plain failure' })
})

test('within handles the work\'s rejection before it sets the deadline, so a throwing clock leaves none unhandled', async () => {
  let handled = false
  // A work that rejects, recording when a rejection handler is attached.
  const rejected = Promise.reject(new Error('rewrite failed'))
  const work = {
    then: (ok: (v: string) => unknown, failed?: (e: unknown) => unknown) => {
      handled = typeof failed === 'function'
      return rejected.then(ok, failed)
    },
  } as unknown as Promise<string>
  const $: any = {
    clock: {
      after: () => {
        expect(handled).toBe(true)
        throw new Error('clock failed')
      },
    },
  }
  await expect(within($, 10, work)).rejects.toThrow('clock failed')
  expect(handled).toBe(true)
})

test('versions are read from what --version prints and compared as semver', () => {
  expect(parseVersion('0.12.8\n')).toBe('0.12.8')
  expect(parseVersion('altimate-code 0.12.11')).toBe('0.12.11')
  expect(parseVersion('v0.13.0-beta.2 (abc)')).toBe('0.13.0-beta.2')
  expect(parseVersion('local build')).toBeNull()
  expect(compareVersions('0.12.9', '0.12.11')).toBe(-1)
  expect(compareVersions('0.12.11', '0.12.11')).toBe(0)
  expect(compareVersions('0.13.0', '0.12.11')).toBe(1)
  expect(compareVersions('1.0.0', '0.99.99')).toBe(1)
  // A prerelease is older than its release, and newer than the release before.
  expect(compareVersions('0.12.11-beta.1', '0.12.11')).toBe(-1)
  expect(compareVersions('0.12.12-beta.1', '0.12.11')).toBe(1)
  expect(compareVersions('0.12.11-beta.2', '0.12.11-beta.10')).toBe(-1)
  expect(compareVersions('0.12.11-beta', '0.12.11-beta.1')).toBe(-1)
})

test('the last version printed is read, and a preview build is no release to compare with', () => {
  expect(parseVersion('Using node v22.1.0\n0.12.9\n')).toBe('0.12.9')
  expect(isPreviewBuild('0.0.0-main-202611191200')).toBe(true)
  expect(isPreviewBuild('0.0.0--202611190701')).toBe(true)
  expect(isPreviewBuild('0.12.9')).toBe(false)
})
