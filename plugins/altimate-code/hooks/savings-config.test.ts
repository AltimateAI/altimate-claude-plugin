import { expect, test } from 'claude-code/testing'

import { changedSettings, comparable, configLabel, configOf, learns, loadConfig, mergeConfig } from './savings-config'

test('a kept config loads only as the object this version keeps; anything else is fully unknown', () => {
  const unknown = { size: null, type: null }
  for (const value of [undefined, null, 'SMALL CLASSIC', '? PRO', 42, ['SMALL', 'PRO'], {}]) expect(loadConfig(value)).toEqual(unknown)
  expect(loadConfig({ size: 'SMALL', type: 'PRO' })).toEqual({ size: 'SMALL', type: 'PRO' })
  expect(loadConfig({ size: '  ', type: 7 })).toEqual({ size: null, type: '7' })
  expect(configOf({ size: 'X\u001b_SMALL', type: '' })).toEqual({ size: 'X _SMALL', type: null })
})

test('each setting merges, compares and is named on its own', () => {
  const was = { size: 'SMALL', type: null }
  const now = { size: 'X_SMALL', type: 'PRO' }
  // The size changed, so PRO is the type after the change: it is not recorded as the type before.
  expect(mergeConfig(was, now)).toEqual({ size: 'SMALL', type: null })
  expect(learns(was, now)).toBe(false)
  // With nothing known changed, the unknown type is filled.
  expect(mergeConfig(was, { size: 'SMALL', type: 'PRO' })).toEqual({ size: 'SMALL', type: 'PRO' })
  expect(learns(was, { size: 'SMALL', type: 'PRO' })).toBe(true)
  expect(learns(now, was)).toBe(false)
  expect(comparable(was, now)).toEqual(['size'])
  expect(changedSettings(was, now)).toEqual(['size'])
  expect(configLabel(now, comparable(was, now))).toBe('X-SMALL')
  expect(configLabel(now)).toBe('X-SMALL PRO')
  expect(configLabel({ size: null, type: null })).toBe('')
})
