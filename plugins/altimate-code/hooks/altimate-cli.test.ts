import { expect, test } from 'claude-code/testing'

import { runTool } from './altimate-cli'

/** A stand-in for `$` whose CLI answers every call and whose MCP connection attempts go through `connect`. */
function standIn(connect: () => unknown) {
  const argvs: string[][] = []
  const $: any = {
    process: {
      run: async (argv: string[]) => {
        argvs.push(argv)
        return { exitCode: 0, stdout: JSON.stringify({ status: 'ok', output: 'done', metadata: { n: 1 } }) }
      },
    },
    mcp: {
      connect: async () => connect(),
      call: async () => {
        throw new Error('the MCP server must not be used')
      },
    },
    clock: { now: async () => 0 },
  }
  return { $, argvs }
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
  const { $, argvs } = standIn(() => {
    connects++
    return { isConnected: true, server: 'altimate-code' }
  })
  await runTool($, 'dbt_manifest', {}, { write: true })
  expect(connects).toBe(0)
  expect(argvs).toHaveLength(1)
})
