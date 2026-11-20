import { expect, mock, test } from 'claude-code/testing'

import { nothingToReport } from './inert-features'
import { setRedactions, clearRedactions } from './dbt-mods-core'
import { MAX_URL, buildDraft, cleanDescription, issueUrl, redactSecrets, titleOf, withoutHome, type Facts } from './feedback'
import { doctorFacts, errorKinds } from './last-problem'

const HOME = '/Users/alice'
const ROOT = '/Users/alice/work/acme_secret_project'
const REPO_URL = 'https://github.com/AltimateAI/altimate-claude-plugin/issues'

const facts = (over: Partial<Facts> = {}): Facts => ({
  plugin: '1.8.3',
  altimate: { name: 'altimate', version: '0.12.11' },
  claudeCode: '2.1.329',
  os: 'macos',
  doctor: { dbtCore: '1.8.2', adapter: 'snowflake 1.8.0', python: '3.11.4' },
  settings: [
    ['dbt helpers', true],
    ['project health blocks git push', false],
  ],
  problem: null,
  ...over,
})

// ─── The payload builder ──────────────────────────────────────────────────────────────────────────────

test('the issue holds the description and each fact the plugin knows, and nothing else', () => {
  const draft = buildDraft(facts(), 'The band said nothing after a failed run')
  expect(draft.title).toBe('Feedback: The band said nothing after a failed run')
  expect(draft.body).toBe(
    [
      'The band said nothing after a failed run',
      '',
      '---',
      '',
      '**Environment** (added by `/altimate-feedback`; nothing else is attached)',
      '',
      '- Plugin: altimate-code 1.8.3',
      '- altimate-code: altimate 0.12.11',
      '- Claude Code: 2.1.329',
      '- OS: macos',
      '- dbt: dbt-core 1.8.2, adapter snowflake 1.8.0, Python 3.11.4',
      '- Settings: dbt helpers on, project health blocks git push off',
    ].join('\n'),
  )
  expect(draft.withProblem).toBe(false)
})

test('a fact that is not known says so: no altimate-code on PATH, no doctor run', () => {
  const draft = buildDraft(facts({ altimate: null, doctor: null, settings: [] }), 'x')
  expect(draft.body).toContain('- altimate-code: not found on PATH')
  expect(draft.body).toContain('- dbt: not checked this session')
  expect(draft.body).not.toContain('Settings')
})

test('the title is the first line of the description, one line, at most 80 characters', () => {
  expect(titleOf('\n\n  first   line  \nsecond')).toBe('Feedback: first line')
  const long = titleOf('x'.repeat(200))
  expect(Array.from(long.slice('Feedback: '.length))).toHaveLength(80)
  expect(long.endsWith('…')).toBe(true)
})

test('the last plugin error is a fenced block that says it holds the error type and code only', () => {
  const draft = buildDraft(facts({ problem: { source: 'dbt run failed', text: 'Database Error, 002003 (42S02)' } }), 'x')
  expect(draft.body).toContain("**Last plugin error** (dbt run failed; the error's type and code only, none of its message)\n\n```text\nDatabase Error, 002003 (42S02)\n```")
  expect(draft.withProblem).toBe(true)
})

test('the dbt doctor contributes versions only, never its free text', () => {
  expect(
    doctorFacts([
      { id: 'dbt', status: 'ok', detail: 'dbt-core 1.8.2 (.venv/bin/dbt)' },
      { id: 'python', status: 'ok', detail: 'Python 3.11.4' },
      { id: 'adapter', status: 'ok', detail: 'snowflake 1.8.0' },
    ]),
  ).toEqual({ dbtCore: '1.8.2', python: '3.11.4', adapter: 'snowflake 1.8.0' })
  expect(
    doctorFacts([
      { id: 'dbt', status: 'ok', detail: 'dbt-core $(whoami) (/Users/alice/venv)' },
      { id: 'python', status: 'warn', detail: 'could not tell which Python runs dbt' },
      { id: 'adapter', status: 'fail', detail: 'the profile uses snowflake, but only bigquery is installed' },
    ]),
  ).toBeNull()
})

// ─── Redaction ────────────────────────────────────────────────────────────────────────────────────────

test('tokens, passwords, connection-string credentials and keys are cut out of any text', () => {
  const text = [
    'token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'password = "hunter2 hunter2"',
    'url postgres://bob:s3cret@db.example.com/x',
    'Authorization: Bearer abcdefgh12345678',
    'key sk-abcdefghijklmnopqrstuvwx',
    'aws AKIAABCDEFGHIJKLMNOP',
    '-----BEGIN PRIVATE KEY-----\nMIIEvQ\n-----END PRIVATE KEY-----',
    'jwt eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.abcDEF123',
    'long 0123456789abcdef0123456789abcdef01234567',
  ].join('\n')
  const out = redactSecrets(text)
  for (const leaked of ['ghp_abc', 'hunter2', 's3cret', 'abcdefgh12345678', 'sk-abcdef', 'AKIAABC', 'MIIEvQ', 'eyJhbGci', '0123456789abcdef0123']) expect(out).not.toContain(leaked)
  expect(out).toContain('postgres://‹redacted›@db.example.com/x')
})

test('the values of the dbt profile that the plugin holds are cut out of the description', () => {
  setRedactions(ROOT, ['wh-pa55-phrase'])
  try {
    expect(cleanDescription('it failed with wh-pa55-phrase in the log', [HOME])).toBe('it failed with ‹redacted› in the log')
  } finally {
    clearRedactions()
  }
})

test('a path under the home folder is replaced whole, in either slash style, and a bare home folder too', () => {
  expect(withoutHome(`open ${HOME}/work/acme/models/fct_orders.sql now`, [HOME])).toBe('open <path under home> now')
  expect(withoutHome('C:\\Users\\Alice\\work\\x.sql', ['C:\\Users\\Alice'])).toBe('<path under home>')
  expect(withoutHome(`in ${HOME}`, [HOME])).toBe('in <path under home>')
  // A root or one-segment value would match everything: it is not a home folder.
  expect(withoutHome('/etc/hosts', ['/'])).toBe('/etc/hosts')
})

test('the description keeps the person\'s own words but loses secrets and home paths, and is cut to length', () => {
  const out = cleanDescription(`run in ${ROOT}/models/a.sql used password=abc123 and /clear`, [HOME])
  expect(out).toBe('run in <path under home> used password=‹redacted› and /clear')
  expect(Array.from(cleanDescription('é'.repeat(5000), [HOME]))).toHaveLength(4000)
  expect(cleanDescription('a\u0000b\u001b[31mc\r\nd', [HOME])).toBe('ab[31mc\nd')
})

test('an error is kept as its type, code and fixed phrases only: no part of its message can reach the issue', () => {
  const raw = [
    `Database Error in model fct_orders (${ROOT}/models/fct_orders.sql)`,
    "  002003 (42S02): SQL compilation error: Object 'ACME_DB.RAW.ORDERS' does not exist or not authorized.",
    '  LINE 1: select private_column',
    '  select\n  employee_ssn,\n  salary * 1.2\nfrom payroll',
    "Model 'fct_orders' depends on a node named 'stg_payroll' which was not found",
    `  config ${HOME}/Client Files/settings.json password: p4ssw0rd Authorization: Basic dXNlcjpodW50ZXIy`,
    'C:/work/payroll/models/orders.sql \\\\corp\\share\\hr.sql target/run/acme/models/fct_orders.sql',
    'relation "analytics"."marts"."fct_orders" and private_schema.private_customers missing',
  ].join('\n')
  const out = errorKinds(raw)
  expect(out).toBe('Database Error, 002003 (42S02), SQL compilation error, does not exist, not authorized, not found')
  for (const leaked of ['fct_orders', 'ACME', 'private', 'employee_ssn', 'salary', 'payroll', 'p4ssw0rd', 'dXNl', 'Client', 'analytics', 'marts', 'corp', 'acme']) expect(out).not.toContain(leaked)
})

test('the plugin host-call names and error codes are kept, and a lookalike that is not on the list is not', () => {
  expect(errorKinds('HooksError: altimate-code: $.process.run(dbt) failed to start: ENOENT: Executable not found in $PATH')).toBe('HooksError, $.process.run, failed to start, ENOENT, not found')
  expect(errorKinds('AcmePayrollError EXYZ 12345 (hello) $.acme.thing')).toBe('')
  // A JSON path in a SQL error is not a host call, and a host call's name only counts whole.
  expect(errorKinds("JSON_VALUE(data, '$.store.payroll') $.session.customersecret $.store.getpayroll")).toBe('')
  expect(errorKinds('TypeError TypeError ENOENT ENOENT')).toBe('TypeError, ENOENT')
  expect(errorKinds('x'.repeat(100_000) + ' ENOENT')).toBe('')
  expect(errorKinds(Array.from({ length: 30 }, (_, i) => `SQLSTATE ${10000 + i}`).join(' ')).split(', ').length).toBe(8)
})

test('a secret that straddles the length limit is gone whole, never left as a prefix', () => {
  for (const secret of ['ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'Authorization: Bearer abcdefgh12345678xyz']) {
    for (const pad of [3980, 3990, 3995, 3999, 4000]) {
      const out = cleanDescription(`${'ok '.repeat(2000).slice(0, pad)}${secret}`, [HOME])
      expect(out).not.toMatch(/ghp_|Bearer abc|abcdefgh/)
    }
  }
  setRedactions(ROOT, ['sup3r-long-warehouse-secret'])
  try {
    expect(cleanDescription(`${'x '.repeat(1995)}sup3r-long-warehouse-secret`, [HOME])).not.toContain('sup3r')
  } finally {
    clearRedactions()
  }
})

test('Basic and other authorization schemes are cut out whole, not only Bearer', () => {
  const out = redactSecrets('Authorization: Basic dXNlcjpodW50ZXIy\nProxy-Authorization: Digest abcdefgh12345678\nsent Basic dXNlcjpodW50ZXIy twice')
  expect(out).not.toMatch(/dXNl|abcdefgh/)
  expect(out).toContain('Authorization: ‹redacted›')
})

test('a home path with a space in a folder name is replaced whole, quoted or not, and Windows paths in either slash style', () => {
  expect(withoutHome(`"${HOME}/Client Files/acme/models/payroll.sql"`, [HOME])).toBe('"<path under home>"')
  expect(withoutHome(`'${HOME}/Client Files'`, [HOME])).toBe("'<path under home>'")
  expect(withoutHome(`open ${HOME}/Client Files/acme/models/payroll.sql with password`, [HOME])).toBe('open <path under home> with password')
  expect(withoutHome('C:/Users/Alice/Client Files/x.sql', ['C:\\Users\\Alice'])).toBe('<path under home>')
  expect(withoutHome('C:\\Users\\Alice\\Client Files\\y.sql', ['C:\\Users\\Alice'])).toBe('<path under home>')
  // Two paths close together may be cut as one: more is cut, never less.
  expect(withoutHome('C:/Users/Alice/Client Files/x.sql and C:\\Users\\Alice\\Client Files\\y.sql', ['C:\\Users\\Alice'])).not.toMatch(/Client|x\.sql|y\.sql/)
})

// ─── The link ─────────────────────────────────────────────────────────────────────────────────────────

test('the link is the new-issue page with the title and body URL-encoded, and decodes back to them', () => {
  const draft = { title: 'Feedback: a & b = c?', body: 'line one\n\n- é ✓ 😀 #tag & more=1' }
  const { url, truncated } = issueUrl(draft)
  expect(truncated).toBe(false)
  expect(url.startsWith(`${REPO_URL}/new?title=`)).toBe(true)
  const parsed = new URL(url)
  expect(parsed.searchParams.get('title')).toBe(draft.title)
  expect(parsed.searchParams.get('body')).toBe(draft.body)
  expect([...parsed.searchParams.keys()]).toEqual(['title', 'body'])
})

test('a body too long for a link is cut to fit the limit, on a character boundary, and the cut is stated', () => {
  const body = `${'😀é'.repeat(3000)} END`
  const { url, truncated } = issueUrl({ title: 'Feedback: long', body })
  expect(truncated).toBe(true)
  expect(url.length).toBeLessThanOrEqual(MAX_URL)
  // Still valid: decoding throws on a split pair, and the note is the last thing in the body.
  const decoded = new URL(url).searchParams.get('body')!
  expect(decoded).toContain('[Cut to fit the link')
  expect(decoded).not.toContain('END')
  expect(decoded.startsWith('😀é')).toBe(true)
  // Nearly all the room is used: a cut that gave up early would be a bug too.
  expect(url.length).toBeGreaterThan(MAX_URL - 40)
  expect(issueUrl({ title: 'Feedback: long', body }, 500).url.length).toBeLessThanOrEqual(500)
})

// ─── The command: nothing leaves without confirmation ─────────────────────────────────────────────────

type Gh = {
  /** `gh` is not installed. */
  missing?: boolean
  /** `gh auth status` exits with this. */
  auth?: number
  /** The repository's labels. */
  labels?: string[]
  /** `gh issue create` fails with this exit code. */
  createFails?: number
  /** `gh issue create` never answers within its time. */
  createTimesOut?: boolean
}

async function start($: any, on: any, options: { holdVersion?: () => Promise<void> | undefined; registerError?: string; gh?: Gh; env?: Record<string, string>; platform?: string; claude?: string } = {}) {
  const clock = mock.clock(on)
  mock.env(on, { HOME, ...(options.env ?? {}) })
  const gh = options.gh ?? {}
  const calls: Array<{ argv: string[]; stdin?: string }> = []
  const logs: string[] = []
  on('session.id', () => ({ value: 'a1b2c3d4-0000-4000-8000-000000000001' }))
  on('session.info', () => ({ value: { platform: options.platform ?? 'macos', isHosted: false } }))
  on('session.version', async () => {
    await options.holdVersion?.()
    return { value: { version: options.claude ?? '2.1.329' } }
  })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT }))
  on('session.cwd', () => ({ value: ROOT }))
  on('command.register', (_: unknown, e: { name: string }) => (options.registerError && e.name === 'defer' ? { deny: options.registerError } : { value: { command: e.name } }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', (_: unknown, e: { answer: string }) => ({ text: e.answer }))
  on('session.end', () => ({ sessionId: 'test' }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', (_: unknown, e: { text: string }) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('ui.render', ($$: any, e: any) => {
    const { Box } = $$.ui.resolve(e)
    return <Box key="engine" />
  })
  on('fs.exists', () => ({ value: false }))
  on('fs.stat', () => {
    throw new Error('ENOENT')
  })
  on('fs.list', () => ({ value: [] }))
  on('fs.read', (_: unknown, e: { path: string }) => {
    if (e.path.endsWith('/.claude-plugin/plugin.json')) return { value: JSON.stringify({ name: 'altimate-code', version: '1.8.3' }) }
    throw new Error('ENOENT ' + e.path)
  })
  on('tool.list', () => ({ value: [] }))
  on('mcp.connect', () => ({ value: { isConnected: false, reason: 'not_connected', message: 'off' } }))
  on('process.run', async (_: unknown, e: { argv: readonly string[]; init?: { stdin?: string } }) => {
    const argv = [...e.argv]
    const [bin, a, b] = argv
    if (bin === 'altimate' && a === '--version') return { value: { exitCode: 0, stdout: '0.12.11\n', stderr: '' } }
    if (bin === 'gh') {
      calls.push({ argv, stdin: e.init?.stdin })
      if (gh.missing) return { deny: 'spawn gh ENOENT' }
      if (a === 'auth') return { value: { exitCode: gh.auth ?? 0, stdout: '', stderr: gh.auth ? 'You are not logged in' : '' } }
      if (a === 'label') return { value: { exitCode: 0, stdout: JSON.stringify((gh.labels ?? ['feedback', 'bug']).map(name => ({ name }))), stderr: '' } }
      if (a === 'issue' && b === 'create') {
        if (gh.createTimesOut) return { deny: 'process timed out after 60000ms' }
        if (gh.createFails) return { value: { exitCode: gh.createFails, stdout: '', stderr: `GraphQL: Resource not accessible (${HOME}/x) token ghp_abcdefghijklmnopqrstuvwxyz0123456789` } }
        return { value: { exitCode: 0, stdout: `${REPO_URL}/77\n`, stderr: '' } }
      }
    }
    if (bin === 'open' || bin === 'xdg-open') {
      calls.push({ argv })
      return { value: { exitCode: 0, stdout: '', stderr: '' } }
    }
    if (argv[1] === 'tool' && argv[2] === 'report-event') return { value: { exitCode: 0, stdout: '', stderr: '' } }
    const inert = nothingToReport(argv)
    if (inert) return { value: inert }
    return { value: { exitCode: 1, stdout: '', stderr: 'not this test' } }
  })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.settle()
  const run = async (args: string) => {
    const answer = (await $.command.run({ command: 'altimate-feedback', args } as any)) as { text?: string }
    await clock.settle()
    return answer.text ?? ''
  }
  const creates = () => calls.filter(call => call.argv[1] === 'issue')
  const opens = () => calls.filter(call => call.argv[0] === 'open' || call.argv[0] === 'xdg-open')
  return { run, calls, creates, opens, logs, clock }
}

/** The body the preview shows: everything between its `Body:` line and the closing rule. */
const shownBody = (text: string) => text.slice(text.indexOf('\nBody:\n') + '\nBody:\n'.length, text.lastIndexOf('\n\n---\nCreate it:'))
const shownTitle = (text: string) => /^Title: (.*)$/m.exec(text)![1]

test('with no description the command asks for one and does nothing else', async ($, on) => {
  const { run, calls } = await start($, on)
  const text = await run('')
  expect(text).toContain('/altimate-feedback <what happened>')
  expect(await run('--with-error')).toContain('/altimate-feedback <what happened>')
  expect(calls).toEqual([])
})

test('a description gives the exact draft and sends nothing: no gh call, no browser, no issue', async ($, on) => {
  const { run, calls } = await start($, on)
  const text = await run('The band said nothing after a failed run')
  expect(text).toContain('Nothing has been sent.')
  expect(shownTitle(text)).toBe('Feedback: The band said nothing after a failed run')
  expect(shownBody(text)).toContain('- Plugin: altimate-code 1.8.3')
  expect(shownBody(text)).toContain('- altimate-code: altimate 0.12.11')
  expect(shownBody(text)).toContain('- Claude Code: 2.1.329')
  expect(shownBody(text)).toContain('- OS: macos')
  expect(shownBody(text)).toContain('- dbt: not checked this session')
  expect(shownBody(text)).toContain('- Settings: dbt helpers on')
  expect(text).toContain('/altimate-feedback --confirm')
  expect(calls).toEqual([])
})

test('--confirm with no draft, and --confirm after --cancel, create nothing', async ($, on) => {
  const { run, calls } = await start($, on)
  expect(await run('--confirm')).toContain('no draft to send')
  await run('some feedback')
  expect(await run('--cancel')).toContain('Discarded')
  expect(await run('--confirm')).toContain('no draft to send')
  expect(await run('--cancel')).toContain('no draft to discard')
  expect(calls).toEqual([])
})

test('a draft replaced by a new description is the one that is sent', async ($, on) => {
  const { run, creates } = await start($, on)
  await run('first thoughts')
  const second = await run('second thoughts')
  expect(await run('--confirm')).toContain(`Created: ${REPO_URL}/77`)
  expect(creates()).toHaveLength(1)
  expect(creates()[0]!.argv).toContain(shownTitle(second))
})

test('a description that holds the word --confirm is a description, not a confirmation', async ($, on) => {
  const { run, calls } = await start($, on)
  const text = await run('please --confirm nothing')
  expect(text).toContain('Draft issue')
  expect(calls).toEqual([])
})

test('gh installed and signed in: the confirmed draft is created with gh, labelled feedback, body and title as shown', async ($, on) => {
  const { run, creates, opens } = await start($, on)
  const preview = await run('The band said nothing after a failed run')
  const done = await run('--confirm')
  expect(done).toBe(`Created: ${REPO_URL}/77`)
  expect(creates()).toHaveLength(1)
  const { argv, stdin } = creates()[0]!
  expect(argv).toEqual(['gh', 'issue', 'create', '--repo', 'AltimateAI/altimate-claude-plugin', '--title', shownTitle(preview), '--body-file', '-', '--label', 'feedback'])
  expect(stdin).toBe(shownBody(preview))
  expect(opens()).toEqual([])
})

test('a repository without a feedback label gets the issue without a label', async ($, on) => {
  const { run, creates } = await start($, on, { gh: { labels: ['bug'] } })
  await run('x')
  await run('--confirm')
  expect(creates()[0]!.argv).not.toContain('--label')
})

test('gh missing: the link is given and opened, and no issue is created', async ($, on) => {
  const { run, creates, opens } = await start($, on, { gh: { missing: true } })
  const preview = await run('x & y')
  const done = await run('--confirm')
  expect(creates()).toEqual([])
  expect(done).toContain('gh is not installed')
  const url = /https:\/\/github\.com\S+/.exec(done)![0]
  const parsed = new URL(url)
  expect(`${parsed.origin}${parsed.pathname}`).toBe(`${REPO_URL}/new`)
  expect(parsed.searchParams.get('title')).toBe(shownTitle(preview))
  expect(parsed.searchParams.get('body')).toBe(shownBody(preview))
  expect(opens()).toEqual([{ argv: ['open', url] }])
  expect(done).toContain('nothing is created until you press "Submit new issue"')
})

test('gh missing on Linux opens with xdg-open; on another platform the link is only given', async ($, on) => {
  const linux = await start($, on, { gh: { missing: true }, platform: 'linux' })
  await linux.run('x')
  await linux.run('--confirm')
  expect(linux.opens().map(call => call.argv[0])).toEqual(['xdg-open'])
})

test('gh not signed in: the link, no sign-in attempt, no create', async ($, on) => {
  const { run, calls, creates } = await start($, on, { gh: { auth: 1 } })
  await run('x')
  const done = await run('--confirm')
  expect(done).toContain('gh is not signed in')
  expect(done).toContain('never signs in')
  expect(creates()).toEqual([])
  expect(calls.filter(call => call.argv.includes('login'))).toEqual([])
})

test('gh failing to create falls back to the link, with its reason redacted', async ($, on) => {
  const { run, creates } = await start($, on, { gh: { createFails: 1 } })
  await run('x')
  const done = await run('--confirm')
  expect(creates()).toHaveLength(1)
  expect(done).toContain('gh could not create the issue')
  expect(done).toContain('/issues/new?title=')
  expect(done).not.toContain('ghp_abc')
  expect(done).not.toContain(HOME)
})

test('gh that times out is not retried and the link is not offered as if nothing had happened', async ($, on) => {
  const { run, creates } = await start($, on, { gh: { createTimesOut: true } })
  await run('x')
  const done = await run('--confirm')
  expect(creates()).toHaveLength(1)
  expect(done).toContain('may have been created')
  expect(await run('--confirm')).toContain('no draft to send')
})

test('two confirmations create one issue', async ($, on) => {
  const { run, creates } = await start($, on)
  await run('x')
  await run('--confirm')
  expect(await run('--confirm')).toContain('no draft to send')
  expect(creates()).toHaveLength(1)
})

test('ALTIMATE_FEEDBACK_DRY_RUN prints the gh command and creates nothing, opens nothing', async ($, on) => {
  const { run, creates, opens } = await start($, on, { env: { ALTIMATE_FEEDBACK_DRY_RUN: '1' } })
  await run("it's broken")
  const done = await run('--confirm')
  expect(done).toContain('Dry run')
  expect(done).toContain("gh issue create --repo AltimateAI/altimate-claude-plugin --title 'Feedback: it'\\''s broken' --body-file -")
  expect(creates()).toEqual([])
  expect(opens()).toEqual([])
})

test('ALTIMATE_FEEDBACK_DRY_RUN without gh prints the link and opens nothing', async ($, on) => {
  const { run, opens } = await start($, on, { env: { ALTIMATE_FEEDBACK_DRY_RUN: 'true' }, gh: { missing: true } })
  await run('x')
  const done = await run('--confirm')
  expect(done).toContain('/issues/new?title=')
  expect(opens()).toEqual([])
})

test('the description\'s secrets and home paths are gone from the draft, the title and the issue that is sent', async ($, on) => {
  const { run, creates } = await start($, on)
  const preview = await run(`crash in ${ROOT}/models/a.sql with token=abc123def and ghp_abcdefghijklmnopqrstuvwxyz0123456789`)
  for (const text of [preview, shownTitle(preview), shownBody(preview)]) {
    expect(text).not.toContain(HOME)
    expect(text).not.toContain('acme_secret_project')
    expect(text).not.toContain('abc123def')
    expect(text).not.toContain('ghp_abc')
  }
  await run('--confirm')
  const sent = JSON.stringify(creates()[0])
  expect(sent).not.toContain(HOME)
  expect(sent).not.toContain('ghp_abc')
})

test('--with-error with no error recorded says so and attaches nothing', async ($, on) => {
  const { run } = await start($, on)
  const text = await run('x --with-error')
  expect(text).toContain('No plugin error has been recorded this session')
  expect(shownBody(text)).not.toContain('Last plugin error')
})

test('the last plugin error is attached only with --with-error, as its type and code and none of its message', async ($, on) => {
  // A feature that fails is the plugin's own error: here the /defer registration fails, with a message naming a path, a relation and a token.
  const { run } = await start($, on, { registerError: `ENOENT: no such file ${ROOT}/target/manifest.json while reading 'ACME.RAW.ORDERS' (token ghp_abcdefghijklmnopqrstuvwxyz0123456789)` })
  const without = await run('it failed')
  expect(shownBody(without)).not.toContain('Last plugin error')
  const withError = await run('it failed --with-error')
  const body = shownBody(withError)
  expect(body).toContain("**Last plugin error** (defer sessionStart failed; the error's type and code only, none of its message)")
  expect(body).toContain('```text\nHooksError, $.command.register, ENOENT\n```')
  for (const leaked of [HOME, 'manifest.json', 'ACME', 'ghp_abc', 'no such file']) expect(body).not.toContain(leaked)
})

test('a draft still being built when it is discarded, or when the session ends, is not kept and cannot be sent', async ($, on) => {
  let release!: () => void
  const held = new Promise<void>(resolve => (release = resolve))
  const { run, creates } = await start($, on, { holdVersion: () => held })
  const building = run('slow draft')
  await run('--cancel')
  release()
  expect(await building).toContain('replaced or discarded before it was ready')
  expect(await run('--confirm')).toContain('no draft to send')
  expect(creates()).toEqual([])
})

test('a confirmation while a replacement draft is being built sends nothing: the draft it replaces is gone, and the new one is sent only when confirmed', async ($, on) => {
  let hold = false
  let release!: () => void
  const held = new Promise<void>(resolve => (release = resolve))
  const { run, creates } = await start($, on, { holdVersion: () => (hold ? held : undefined) })
  await run('first draft')
  hold = true
  const replacing = run('second draft')
  expect(await run('--confirm')).toContain('no draft to send')
  expect(creates()).toEqual([])
  release()
  const preview = await replacing
  expect(shownTitle(preview)).toBe('Feedback: second draft')
  await run('--confirm')
  expect(creates()).toHaveLength(1)
  expect(creates()[0]!.argv).toContain('Feedback: second draft')
})

test('a description over the read limit is refused, not cut: no secret is split before it is redacted', async ($, on) => {
  const { run, calls } = await start($, on)
  const text = await run(`${'1'.repeat(100_000)} ghp_abcdefghijklmnopqrstuvwxyz0123456789`)
  expect(text).toContain('too long')
  expect(text).not.toContain('ghp_')
  expect(calls).toEqual([])
})

test('a description at the read limit is redacted whole and quickly, whatever shrinks before it', () => {
  const started = Date.now()
  const out = cleanDescription(`${'Authorization: Basic dXNlcjpodW50ZXIy\n'.repeat(2600)}${'1'.repeat(99_000 - 2600 * 37)} ghp_abcdefghijklmnopqrstuvwxyz0123456789`.slice(0, 100_000), [HOME])
  expect(out).not.toMatch(/ghp_|dXNl/)
  expect(Date.now() - started).toBeLessThan(3000)
  const worst = Date.now()
  cleanDescription(`${'a-1'.repeat(33_000)}${' x/'.repeat(1000)}${HOME}/${'a '.repeat(30_000)}`, [HOME])
  expect(Date.now() - worst).toBeLessThan(3000)
})

test('a quoted secret value is cut whole, whatever escaped quotes it holds', () => {
  for (const text of ['{"password":"alpha\\"omega-secret"}', "password='alpha\\'omega-secret'", 'secret = "x" and then password=plain-secret']) {
    const out = redactSecrets(text)
    expect(out).not.toMatch(/omega|b-secret|plain-secret/)
  }
  expect(redactSecrets('{"password":"alpha\\"omega-secret","user":"bob"}')).toBe('{"password":‹redacted›,"user":"bob"}')
})

test('a home path whose names hold apostrophes, quotes of another kind, or many spaces is replaced whole', () => {
  expect(withoutHome(`"${HOME}/O'Brien/payroll.sql"`, [HOME])).toBe('"<path under home>"')
  expect(withoutHome(`'${HOME}/say "hi"/payroll.sql'`, [HOME])).toBe("'<path under home>'")
  expect(withoutHome(`see ${HOME}/O'Brien/payroll.sql now`, [HOME])).toBe('see <path under home> now')
  expect(withoutHome(`see ${HOME}/My Very Private Client Files/payroll.sql now`, [HOME])).toBe('see <path under home> now')
  expect(withoutHome(`a "${HOME}/x\\"y/z.sql" b`, [HOME])).toBe('a "<path under home>" b')
})

test('a description that is refused as too long, or empty after the flag, leaves no earlier draft to confirm, finished or still being built', async ($, on) => {
  let hold = false
  let release!: () => void
  const held = new Promise<void>(resolve => (release = resolve))
  const { run, creates } = await start($, on, { holdVersion: () => (hold ? held : undefined) })
  await run('obsolete draft')
  expect(await run('x'.repeat(100_001))).toContain('too long')
  expect(await run('--confirm')).toContain('no draft to send')
  hold = true
  const building = run('in flight draft')
  expect(await run('y'.repeat(100_001))).toContain('too long')
  release()
  expect(await building).toContain('replaced or discarded before it was ready')
  expect(await run('--confirm')).toContain('no draft to send')
  expect(creates()).toEqual([])
})

test('credential keys with a prefix or suffix (DBT_PASSWORD, access_token), YAML block scalars and doubled apostrophes are cut out whole, with no profile values loaded', () => {
  const text = [
    'DBT_PASSWORD=hunter2',
    'SNOWFLAKE_PASSWORD="warehouse private secret"',
    'access_token=private-token-value',
    "password: 'alpha''omega-secret'",
    'password: |\n  my-database-password\n  second-line-secret\nuser: bob',
    'client_secret: >-\n  folded-secret',
    'AWS_SECRET_ACCESS_KEY=abcd/efgh+ijkl',
  ].join('\n')
  const out = redactSecrets(text)
  expect(out).not.toMatch(/hunter2|warehouse|private-token|omega|database-password|second-line|folded-secret|abcd\/efgh/)
  expect(out).toContain('user: bob')
})

test('a YAML block scalar under a credential key is cut whole: comments on its header, blank lines inside it, folded and literal', () => {
  const out = redactSecrets(['password: | # database password', '  correct-horse', '', '  battery-staple', 'client_secret: >- # note', '    folded', 'next: kept', '- db_token: |', '    listed-secret', 'last: kept too'].join('\n'))
  expect(out).not.toMatch(/correct|battery|folded|listed/)
  expect(out).toContain('next: kept')
  expect(out).toContain('last: kept too')
  expect(out.split('\n')[0]).toBe('password: ‹redacted›')
})

test('a YAML credential under a quoted key, or with a value of several words, is cut whole', () => {
  const out = redactSecrets(['password: correct horse battery staple', '"password": |', '  quoted-key-secret', "'db_token': >-", '  folded-quoted', '  - secret: two words here', 'name: kept'].join('\n'))
  expect(out).not.toMatch(/correct|horse|staple|quoted-key|folded-quoted|two words/)
  expect(out).toContain('name: kept')
  expect(out.split('\n')[0]).toBe('password: ‹redacted›')
})

test('connection-string passwords are cut whole: braced, multi-word, and an Azure account key with slashes', () => {
  const key = `${'Ab1/'.repeat(21)}Zz+/Qw==`
  const out = redactSecrets(
    ['Driver={ODBC Driver 18};Server=db;PWD={correct horse battery staple};Encrypt=yes', 'Server=db;Password=correct horse staple;User=bob', `DefaultEndpointsProtocol=https;AccountName=acme;AccountKey=${key};EndpointSuffix=core.windows.net`, 'PWD={a}}b c};x=1'].join('\n'),
  )
  expect(out).not.toMatch(/correct|horse|battery|staple|Ab1\/|Zz\+|b c/)
  expect(out).toContain('Encrypt=yes')
  expect(out).toContain('User=bob')
  expect(out).toContain('AccountName=acme')
})

test('a quoted password with a semicolon inside, and a last unquoted connection-string password with spaces, are cut whole', () => {
  const out = redactSecrets(['password="alpha;omega-secret"', 'Server=db;Password=correct horse battery staple', "pwd='x;y-secret' and more", 'Server=db;Password=last words here;'].join('\n'))
  expect(out).not.toMatch(/alpha|omega|correct|horse|battery|staple|y-secret|last words/)
  expect(out).toContain('Server=db;Password=‹redacted›')
  expect(out).toContain('and more')
})

test('the rules read the text as written: a profile value that is a key name or a home folder, or the base of a long key, cannot hide anything', () => {
  const key = `${'Ab1/'.repeat(21)}Zz+/Qw==`
  setRedactions(ROOT, [key, HOME, 'password'])
  try {
    const out = cleanDescription(`"${HOME}/work/acme/models/fct_orders.sql" key=${key} password=hunter2-production-key`, [HOME])
    expect(out).not.toMatch(/work|acme|fct_orders|Ab1|Zz|hunter2|production/)
  } finally {
    clearRedactions()
  }
})

test('a password inside a JSON string that is itself JSON-escaped is cut whole', () => {
  const out = redactSecrets(JSON.stringify({ message: JSON.stringify({ password: 'hunter2-prod', user: 'bob' }) }))
  expect(out).not.toContain('hunter2')
  expect(redactSecrets(JSON.stringify({ message: JSON.stringify({ message: JSON.stringify({ api_key: 'deep-secret-value' }) }) }))).not.toContain('deep-secret')
})

test('a multi-word password inside JSON strings escaped one, two or three times is cut whole', () => {
  let value = JSON.stringify({ password: 'correct horse battery staple', user: 'bob' })
  for (let depth = 0; depth < 3; depth++) {
    const out = redactSecrets(value)
    expect(out).not.toMatch(/correct|horse|battery|staple/)
    expect(out).toContain('bob')
    value = JSON.stringify({ message: value })
  }
})

test('ADO.NET doubled quotes inside a quoted password are part of it, and a profile value that is also a key name does not hide the key', () => {
  const out = redactSecrets('Server=db;Password="alpha""omega-secret";Encrypt=yes')
  expect(out).not.toMatch(/alpha|omega/)
  expect(out).toContain('Encrypt=yes')
  setRedactions(ROOT, ['password', 'secret'])
  try {
    expect(redactSecrets('password=hunter2-production-key and client_secret=private-client-credential')).not.toMatch(/hunter2|private-client/)
  } finally {
    clearRedactions()
  }
})

test('a profile value that YAML writes with doubled apostrophes is cut out too', () => {
  setRedactions(ROOT, ["alpha'omega-secret"])
  try {
    expect(redactSecrets("it said 'alpha''omega-secret' and alpha'omega-secret")).not.toMatch(/alpha|omega/)
  } finally {
    clearRedactions()
  }
})

test('~/ paths and a path with parentheses in a folder name are replaced whole, with or without a home folder known', () => {
  expect(withoutHome('see ~/private/payroll.sql now', [HOME])).toBe('see <path under home> now')
  expect(withoutHome('see ~/private/payroll.sql now', [])).toBe('see <path under home> now')
  expect(withoutHome("open '~/My Files/a.sql'", [])).toBe("open '<path under home>'")
  expect(withoutHome(`see ${HOME}/Client(Private)/payroll.sql now`, [HOME])).toBe('see <path under home> now')
  expect(withoutHome(`(see ${HOME}/x.sql)`, [HOME])).toBe('(see <path under home>)')
  expect(withoutHome('a~b and file:///Users/alice/x.sql', [HOME])).toBe('a~b and file://<path under home>')
  expect(withoutHome('2~3 and ~ alone', [])).toBe('2~3 and ~ alone')
})

test('a Windows home path as JSON or a Python repr writes it, with doubled backslashes or escaped slashes, is replaced whole', () => {
  const home = 'C:\\Users\\Alice'
  const json = JSON.stringify({ path: 'C:\\Users\\Alice\\work\\orders.sql', posix: `${HOME}/work/orders.sql` })
  expect(json).toContain('C:\\\\Users')
  const out = withoutHome(json, [home, HOME])
  expect(out).toBe('{"path":"<path under home>","posix":"<path under home>"}')
  expect(withoutHome('{"p":"\\/Users\\/alice\\/work\\/a.sql"}', [HOME])).not.toContain('work')
  expect(cleanDescription(json, [home, HOME])).not.toMatch(/Alice|orders/)
})

test('a new session starts with no draft', async ($, on) => {
  const { run, creates } = await start($, on)
  await run('x')
  await $.session.end({ reason: 'clear', sessionId: 'a1b2c3d4-0000-4000-8000-000000000001' } as any)
  expect(await run('--confirm')).toContain('no draft to send')
  expect(creates()).toEqual([])
})
