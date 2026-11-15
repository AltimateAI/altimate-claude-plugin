import { expect, test } from 'claude-code/testing'

import { registerFeatures } from './index'

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
