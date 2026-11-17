import { expect, test } from 'claude-code/testing'

import { runTool, within } from './altimate-cli'

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
  // An answer object speaks for itself: its output, or nothing, never a line of stderr.
  expect(await text(() => ({ exitCode: 1, stdout: JSON.stringify({ status: 'error', output: 'boom', metadata: {} }), stderr: 'noise' }))).toBe('boom')
  expect(await text(() => ({ exitCode: 1, stdout: JSON.stringify({ status: 'error', metadata: {} }), stderr: 'noise' }))).toBe('')
  const result = await runTool(failing(() => ({ exitCode: 2, stdout: 'plain failure' })), 'dbt_manifest', {})
  expect(result).toEqual({ metadata: null, text: 'plain failure', ok: false })
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
