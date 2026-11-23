import { expect, test } from 'claude-code/testing'

import { changedSettings, comparable, configLabel, configOf, covers, learns, loadConfig } from './savings-config'

test('a kept config loads only as the object this version keeps; anything else is fully unknown', () => {
  const unknown = { size: null, type: null }
  for (const value of [undefined, null, 'SMALL CLASSIC', '? PRO', 42, ['SMALL', 'PRO'], {}]) expect(loadConfig(value)).toEqual(unknown)
  expect(loadConfig({ size: 'SMALL', type: 'PRO' })).toEqual({ size: 'SMALL', type: 'PRO' })
  expect(loadConfig({ size: '  ', type: 7 })).toEqual({ size: null, type: '7' })
  expect(configOf({ size: 'X\u001b_SMALL', type: '' })).toEqual({ size: 'X _SMALL', type: null })
})

test('each setting is learned, covered, compared and named on its own', () => {
  const was = { size: 'SMALL', type: null }
  const now = { size: 'X_SMALL', type: 'PRO' }
  // The size changed, so PRO is the type after the change: it teaches nothing about the state before.
  expect(learns(was, now)).toBe(false)
  // With nothing known changed, the type is learned.
  expect(learns(was, { size: 'SMALL', type: 'PRO' })).toBe(true)
  expect(learns(now, was)).toBe(false)
  // A read covers another when it knows every setting the other knows.
  expect(covers(was, now)).toBe(true)
  expect(covers(was, { size: null, type: 'PRO' })).toBe(false)
  expect(covers({ size: null, type: null }, { size: null, type: null })).toBe(true)
  expect(comparable(was, now)).toEqual(['size'])
  expect(changedSettings(was, now)).toEqual(['size'])
  expect(configLabel(now, comparable(was, now))).toBe('X-SMALL')
  expect(configLabel(now)).toBe('X-SMALL PRO')
  expect(configLabel({ size: null, type: null })).toBe('')
})
