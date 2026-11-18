// Opening a file or address in the person's browser, for the plugin's offline reports.
import type { EngineInterface } from 'claude-code'

import { openersFor, type Platform, WINDOWS_EXPLORER } from './impact-report'

/** Which opener family this machine has: macOS, Linux, WSL (Linux under Windows), or Windows itself. */
async function platformOf($: EngineInterface): Promise<Platform> {
  // -r too: a WSL kernel's release names Microsoft, with no environment variable needed.
  const uname = await $.process.run(['uname', '-sr'], { timeoutMs: 5_000 }).catch(() => null)
  if (!uname || uname.exitCode !== 0) return 'windows'
  if (/darwin/i.test(uname.stdout)) return 'mac'
  if (/microsoft/i.test(uname.stdout)) return 'wsl'
  if (await $.env.get('WSL_DISTRO_NAME').catch(() => undefined)) return 'wsl'
  return /microsoft/i.test(await $.fs.read('/proc/version').catch(() => '')) ? 'wsl' : 'linux'
}

/** Opens the report in the person's browser; false when no opener worked. */
export async function openReport($: EngineInterface, path: string): Promise<boolean> {
  const platform = await platformOf($)
  let wsl = {}
  // An address needs no Windows form of a path: only a file does.
  if (platform === 'wsl' && !/^https?:/.test(path)) {
    const windows = await $.process.run(['wslpath', '-w', path], { timeoutMs: 5_000 }).catch(() => null)
    wsl = { windowsPath: windows?.exitCode === 0 ? windows.stdout.trim() || null : null, explorerAtC: await $.fs.exists(WINDOWS_EXPLORER).catch(() => false) }
  }
  // The first that starts and exits as it does on success; one that cannot start, or fails, gives way to the next.
  for (const opener of openersFor(platform, path, wsl)) {
    const result = await $.process.run(opener.argv, { timeoutMs: 15_000 }).catch(() => null)
    if (result && opener.okExits.includes(result.exitCode)) return true
  }
  return false
}
