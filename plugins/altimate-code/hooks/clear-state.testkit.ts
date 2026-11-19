// For tests: the engine's /clear, which the test kit does not play. A /clear ends the conversation and the next
// one runs under a new session id, so every `$.state` value reads as never written until it is written again,
// and no `session.start` comes.

type Address = { plugin: string; key: string; id?: string }

/**
 * Registers the state and session id hooks (before the test's first call on `$`); the function it returns plays
 * the /clear: the session's end, then the new id with its empty state. `holdWriteOf` holds the new conversation's
 * first write of one value until released.
 */
export function playsClear($: any, on: any, options: { holdWriteOf?: { key: string; until: Promise<void> } } = {}): () => Promise<void> {
  let cleared = false
  let held = false
  const written = new Set<string>()
  const name = (e: Address) => `${e.plugin}\u0000${e.key}\u0000${e.id ?? ''}`
  // A $-call's hook answers `{ value }`: here the value is the read, `{ value, version }`. The version stays, so a write still lands.
  on('state.get', async (_: unknown, e: Address, next: (e: Address) => Promise<{ value?: { value: unknown; version: number } }>) => {
    const stored = await next(e)
    return cleared && !written.has(name(e)) && stored.value ? { ...stored, value: { ...stored.value, value: undefined } } : stored
  })
  on('state.set', async (_: unknown, e: Address, next: (e: Address) => Promise<unknown>) => {
    if (cleared) written.add(name(e))
    // The new conversation's first write of that value waits, so a test can act while it is under way.
    if (cleared && !held && options.holdWriteOf?.key === e.key) {
      held = true
      await options.holdWriteOf.until
    }
    return next(e)
  })
  let clears = 0
  on('session.id', () => ({ value: `session-${clears}` }))
  return async () => {
    await $.session.end({ reason: 'clear', sessionId: `session-${clears}` })
    clears++
    cleared = true
    written.clear()
  }
}
