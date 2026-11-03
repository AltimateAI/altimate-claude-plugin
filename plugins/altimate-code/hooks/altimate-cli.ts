// The altimate CLI as both halves of the plugin call it.
import type { EngineInterface } from 'claude-code'

// `altimate` is the name the standalone installer and npm v0.7.1+ put on PATH;
// older npm installs only have `altimate-code`.
const CLI_NAMES = ['altimate', 'altimate-code'] as const

// A command that cannot start rejects; only that moves on to the next name, so a timeout never
// reruns a command that may have taken effect.
export const MISSING_BINARY = /ENOENT|not found|no such file|(cannot|could not|failed to) (start|spawn|run)/i

/** Runs the altimate CLI under the first name that is installed; 90 s unless the caller says otherwise. */
export async function runAltimate($: EngineInterface, args: string[], timeoutMs = 90_000) {
  let lastError: unknown = null
  for (const bin of CLI_NAMES) {
    try {
      return await $.process.run([bin, ...args], { timeoutMs })
    } catch (error) {
      if (!MISSING_BINARY.test(String(error))) throw error
      lastError = error
    }
  }
  throw lastError ?? new Error('altimate CLI not found')
}

// The CLI pretty-prints its JSON, so read the whole text first, then fall back
// to the last line for a CLI that logs before printing one compact line.
export function parseJson<T>(text: string): T | null {
  const body = text.trim()
  for (const candidate of [body, body.split('\n').pop() ?? '']) {
    try {
      return JSON.parse(candidate) as T
    } catch {}
  }
  return null
}

// A press has a short budget, so a press only schedules its work; the work then
// runs on the clock, outside the press.
export function later($: EngineInterface, work: () => Promise<unknown>) {
  $.clock.after(0, () => {
    void work()
  })
}
