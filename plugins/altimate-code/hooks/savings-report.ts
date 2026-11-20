// The "Share report" page: one self-contained HTML file of the kept /savings answers. No script, no
// remote asset, no upload: it is a file on this machine until the person sends it to someone.
import type { SavingsKept, SavingsPlatform } from '../types'
import { checksNotRun, HOSTED_CHECK_COUNT, LOCAL_CHECK_COUNT, nothingRan } from './savings-checks'
import { amount, cleanText, combinedTotal, compared, dollars, limitedText, OBSERVED_NOTE, PLATFORM_NAME, range, windowDays } from './savings-format'

const escape = (value: unknown) =>
  cleanText(String(value ?? '')).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)

const STYLE = `
:root{color-scheme:light dark;--fg:#1c2024;--dim:#5c6670;--line:#d9dee3;--bg:#fff;--card:#f6f7f9;--good:#0a7a4b}
@media (prefers-color-scheme:dark){:root{--fg:#e7eaee;--dim:#9aa5b1;--line:#333a42;--bg:#14171a;--card:#1c2025;--good:#3ecf8e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:860px;margin:0 auto;padding:40px 24px 64px}h1{font-size:24px;margin:0 0 4px}h2{font-size:19px;margin:36px 0 2px}h3{font-size:15px;margin:0}
.dim{color:var(--dim)}.total{font-size:30px;font-weight:650;color:var(--good);margin:18px 0 0}.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin:12px 0}
ul{margin:6px 0 0;padding-left:18px}table{border-collapse:collapse;width:100%;margin-top:8px}th,td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--line);font-size:14px}th{color:var(--dim);font-weight:500}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}a{color:inherit}.gap{color:var(--dim)}`

/** The page, from the kept answers. `builtAt` is written on it as given. */
export function savingsReportHtml(kept: readonly SavingsKept[], builtAt: string, signupUrl: string, failed: readonly { platform: SavingsPlatform; text: string }[] = []): string {
  const views = kept.map(one => one.view)
  const total = combinedTotal(views)
  const findings = views.reduce((sum, view) => sum + view.findings.length, 0)
  const partial = failed.length > 0 || views.some(view => view.skipped.length > 0 || view.limited.length > 0)
  const nothingChecked = views.length > 0 && views.every(nothingRan)
  const prices = [...new Set(views.map(view => view.pricing))]
  const priced = prices.length === 1 ? `at ${escape(prices[0])}` : 'at the prices shown for each platform'
  const sections = kept.map(({ savedAt, view }) => {
    const name = PLATFORM_NAME[view.platform]
    const days = windowDays(view.window)
    const notRun = checksNotRun(view)
    const limited = limitedText(view)
    const verdict = nothingRan(view)
      ? 'None of the checks could run, so nothing was checked.'
      : view.skipped.length > 0 || limited
        ? 'No savings found by the checks that ran.'
        : 'No savings found by these checks.'
    return `<section>
<h2>${escape(name)}</h2>
<div class="dim">${view.connection ? `Connection ${escape(view.connection)} · ` : ''}the ${days} days to ${escape(view.window.end)} · ${LOCAL_CHECK_COUNT} of Altimate's ${HOSTED_CHECK_COUNT[view.platform]} ${escape(name)} checks · priced at ${escape(view.pricing)} · checked ${escape(new Date(savedAt).toISOString().slice(0, 10))}</div>
${view.skipped.length > 0 ? `<p class="gap">Not checked: ${escape(view.skipped.join('; '))}.</p>` : ''}
${limited ? `<p class="gap">${escape(limited)}</p>` : ''}
${view.fixes.map(one => (one.state === 'lower' ? `<p>${escape(one.text)}</p>` : `<p class="gap">${escape(one.text)}</p>`)).join('\n')}
${view.changes
  .map(one => {
    const costs = compared(one.monthlyBefore, one.monthlyNow)
    return `<p>${escape(`${one.name}: ${one.from} → ${one.to} since ${one.since}. Observed spend: ${costs.was} a month before, ${costs.now} after.`)}</p>`
  })
  .join('\n')}
${view.changes.length > 0 ? `<p class="dim">${escape(OBSERVED_NOTE)}</p>` : ''}
${view.findings.length === 0 ? `<p>${verdict}</p>` : ''}
${view.findings
  .map(
    one => `<div class="card"><h3>${escape(one.resourceName)}${one.workspace ? ` (workspace ${escape(one.workspace)})` : ''} · ${escape(one.title)} · ${escape(amount(one.monthlyMin, one.monthlyMax))}</h3>
<ul>${one.evidence.map(line => `<li>${escape(line)}</li>`).join('')}</ul></div>`,
  )
  .join('\n')}
${view.whatIf
  .map(
    one => `<div class="card"><h3>What if ${escape(one.resourceName)} (${escape(dollars(one.currentMonthly))} a month now) were…</h3>
<table><tr><th>Choice</th><th class="n">A month</th><th class="n">Saves</th><th>Fits its queries</th></tr>
${one.choices.map(c => `<tr><td>${escape(c.label)}</td><td class="n">${escape(dollars(c.monthlyCost))}</td><td class="n">${c.monthlySaving > 0 ? escape(dollars(c.monthlySaving)) : 'none'}</td><td>${c.fits === false ? 'no: queries would queue' : c.fits ? 'yes' : 'no size to fit: it scales with its queries'}</td></tr>`).join('\n')}
</table></div>`,
  )
  .join('\n')}
<div class="card"><h3>Checks that did not run here</h3><ul>${notRun.map(one => `<li><b>${escape(one.name)}</b>: ${escape(one.reads)}</li>`).join('')}</ul></div>
</section>`
  })
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Warehouse savings report</title><style>${STYLE}</style></head>
<body><main>
<h1>Warehouse savings report</h1>
<div class="dim">Built ${escape(builtAt)} on this machine from read-only checks on your own connections. Nothing was sent to Altimate.</div>
<p class="total">${total.resources > 0 ? `${escape(range(total.min, total.max))} a month` : findings > 0 ? `${findings} finding${findings === 1 ? '' : 's'}, no dollar estimate` : nothingChecked ? 'Nothing was checked' : 'No savings found'}</p>
<div class="dim">${total.resources > 0 ? `on ${total.resources} resource${total.resources === 1 ? '' : 's'}, ${priced} and the measured week's rate, each counted once at its largest saving` : findings > 0 ? 'see each finding below' : nothingChecked ? 'none of the checks could run: see why below' : 'by the checks that ran'}${partial && !nothingChecked ? '. Some checks did not run in full: see below.' : ''}</div>
${failed.map(one => `<p class="gap">The last ${escape(PLATFORM_NAME[one.platform])} check did not finish: ${escape(one.text)}</p>`).join('\n')}
${sections.join('\n')}
<p><a href="${escape(signupUrl)}">See every check in Altimate</a></p>
</main></body></html>
`
}
