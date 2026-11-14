import { expect, test } from 'claude-code/testing'

import { parseDbtCommand } from './dbt-command'

/** The fields a caller decides on, without the offsets. */
const shape = (line: string) => parseDbtCommand(line).map(({ start, end, subcommandEnd, ...rest }) => rest)

const base = { select: [], target: null, targetPath: null, hasDefer: false, hasState: false }

test('a plain dbt command: subcommand, selections, target and target path', () => {
  expect(shape('dbt build -s stg_orders --select +fct_orders -t prod --target-path tgt')).toEqual([
    { ...base, binary: 'dbt', subcommand: 'build', select: ['stg_orders', '+fct_orders'], target: 'prod', targetPath: 'tgt' },
  ])
  expect(shape('dbt run --models a b --target=dev')).toEqual([{ ...base, binary: 'dbt', subcommand: 'run', select: ['a', 'b'], target: 'dev' }])
})

test('commands joined with &&, ; and pipes each give their dbt invocation, in order', () => {
  expect(shape('cd jaffle && dbt deps && dbt run -s a; dbt test | tee log.txt')).toEqual([
    { ...base, binary: 'dbt', subcommand: 'deps' },
    { ...base, binary: 'dbt', subcommand: 'run', select: ['a'] },
    { ...base, binary: 'dbt', subcommand: 'test' },
  ])
})

test('uv run dbt, poetry run dbt and a path to dbt are dbt launchers', () => {
  expect(shape('uv run dbt build -s a')).toEqual([{ ...base, binary: 'uv run dbt', subcommand: 'build', select: ['a'] }])
  expect(shape('poetry run dbt test')).toEqual([{ ...base, binary: 'poetry run dbt', subcommand: 'test' }])
  expect(shape('.venv/bin/dbt compile')).toEqual([{ ...base, binary: '.venv/bin/dbt', subcommand: 'compile' }])
})

test('VAR=x in front of dbt is kept in the invocation; DBT_DEFER and DBT_STATE count as defer and state', () => {
  const line = 'DBT_PROFILES_DIR=. dbt run -s a'
  const [one] = parseDbtCommand(line)
  expect(one).toEqual({ ...base, binary: 'dbt', subcommand: 'run', select: ['a'], start: 0, end: line.length, subcommandEnd: line.indexOf(' -s') })
  expect(shape('DBT_DEFER=1 DBT_STATE=prod dbt run')).toEqual([{ ...base, binary: 'dbt', subcommand: 'run', hasDefer: true, hasState: true }])
})

test('--defer and --state are seen; the offsets cut the invocation out of the line', () => {
  const line = 'echo hi && dbt build --defer --state prod-artifacts -s a > out.log'
  const [one] = parseDbtCommand(line)
  expect(one).toMatchObject({ subcommand: 'build', hasDefer: true, hasState: true })
  expect(line.slice(one!.start, one!.end)).toBe('dbt build --defer --state prod-artifacts -s a')
  expect(line.slice(one!.start, one!.subcommandEnd)).toBe('dbt build')
})

test('a line without dbt, or one that cannot be read, gives no invocation', () => {
  expect(parseDbtCommand('ls -la && git status')).toEqual([])
  expect(parseDbtCommand('echo "dbt run')).toEqual([])
  expect(parseDbtCommand('dbt run $(echo')).toEqual([])
  expect(parseDbtCommand('')).toEqual([])
  expect(parseDbtCommand('grep dbt run.log')).toEqual([])
})

test('a bare dbt has no subcommand; quoted selections are unquoted', () => {
  expect(shape('dbt')).toEqual([{ ...base, binary: 'dbt', subcommand: null }])
  expect(shape(`dbt ls -s "tag:nightly" --select 'path:models/staging'`)).toEqual([
    { ...base, binary: 'dbt', subcommand: 'ls', select: ['tag:nightly', 'path:models/staging'] },
  ])
})

test('a heredoc, or an operator or redirection with nothing after it, makes the line unreadable', () => {
  expect(parseDbtCommand('cat > run.sh <<EOF\ndbt run -s a\nEOF')).toEqual([])
  expect(parseDbtCommand("cat <<'EOF' > x.sh\ndbt build\nEOF\nbash x.sh")).toEqual([])
  expect(parseDbtCommand('cat <<-EOF\n\tdbt run\n\tEOF')).toEqual([])
  for (const line of ['dbt run >', 'dbt run &&', 'dbt run |', '&& dbt run', '; dbt run', 'dbt run )', 'dbt run (', '(dbt run', 'dbt run ; ;'])
    expect(parseDbtCommand(line)).toEqual([])
  // A here-string is no heredoc; a subshell, a function and a trailing ; or & are fine.
  expect(shape('dbt run <<< y')).toEqual([{ ...base, binary: 'dbt', subcommand: 'run' }])
  expect(shape('(cd a && dbt run); f() { dbt test; }; dbt ls &')).toEqual([
    { ...base, binary: 'dbt', subcommand: 'run' },
    { ...base, binary: 'dbt', subcommand: 'test' },
    { ...base, binary: 'dbt', subcommand: 'ls' },
  ])
})

test('parentheses inside a quoted string in a substitution are text', () => {
  expect(shape('dbt run $(printf "(") -t dev')).toEqual([{ ...base, binary: 'dbt', subcommand: 'run', target: 'dev' }])
  expect(shape('dbt run "$(printf ")")" -t dev')).toEqual([{ ...base, binary: 'dbt', subcommand: 'run', target: 'dev' }])
})

test('short options joined to their value, and global options that take one before the subcommand', () => {
  expect(shape('dbt run -tprod -sorders -musers')).toEqual([{ ...base, binary: 'dbt', subcommand: 'run', select: ['orders', 'users'], target: 'prod' }])
  expect(shape(`dbt --warn-error-options '{"include":"all"}' -r timing.txt run -s a`)).toEqual([
    { ...base, binary: 'dbt', subcommand: 'run', select: ['a'] },
  ])
  expect(shape('dbt build --indirect-selection cautious -s a')).toEqual([{ ...base, binary: 'dbt', subcommand: 'build', select: ['a'] }])
})

test('env options that take a value; DBT_TARGET and DBT_TARGET_PATH in front of dbt, which the flags override', () => {
  expect(shape('env -i -u FOO dbt run')).toEqual([{ ...base, binary: 'dbt', subcommand: 'run' }])
  expect(shape('DBT_TARGET=prod DBT_TARGET_PATH=tgt dbt run')).toEqual([{ ...base, binary: 'dbt', subcommand: 'run', target: 'prod', targetPath: 'tgt' }])
  expect(shape('DBT_TARGET=prod dbt run -t dev')).toEqual([{ ...base, binary: 'dbt', subcommand: 'run', target: 'dev' }])
})

test('subshells after a keyword, case patterns, process substitution, arrays and arithmetic are read', () => {
  const run = { ...base, binary: 'dbt', subcommand: 'run' }
  expect(shape('time (dbt build)')).toEqual([{ ...base, binary: 'dbt', subcommand: 'build' }])
  for (const line of [
    'if (cd proj && dbt run); then echo ok; fi',
    '! (dbt run)',
    '{ (dbt run); }',
    'dbt run 2> >(tee err.log)',
    'for ((i=0;i<3;i++)); do dbt run; done',
    'f() ( dbt run )',
    'case $t in\n  a|b) dbt run;;\nesac',
  ])
    expect(shape(line)).toEqual([run])
  expect(shape('case $t in prod) dbt run -t prod;; *) dbt run;; esac')).toEqual([{ ...run, target: 'prod' }, run])
  expect(shape('case $t in (prod) dbt run -t prod;; esac')).toEqual([{ ...run, target: 'prod' }])
  expect(shape('models=(orders users); for m in "${models[@]}"; do dbt run -s $m; done')).toEqual([{ ...run, select: ['$m'] }])
  const line = 'diff <(dbt ls -s a) <(dbt ls -s b)'
  const found = parseDbtCommand(line)
  expect(found.map(({ start, end }) => line.slice(start, end))).toEqual(['dbt ls -s a', 'dbt ls -s b'])
})

test('a function definition takes one name: `dbt run ()` is unreadable and a function named dbt is no invocation', () => {
  expect(parseDbtCommand('dbt run ()')).toEqual([])
  expect(parseDbtCommand('case x in a) dbt run')).toEqual([])
  expect(shape('dbt() { echo hi; }; dbt test')).toEqual([{ ...base, binary: 'dbt', subcommand: 'test' }])
  expect(shape('function f() { dbt run; }')).toEqual([{ ...base, binary: 'dbt', subcommand: 'run' }])
})

test('a case pattern named dbt is no invocation', () => {
  const run = { ...base, binary: 'dbt', subcommand: 'run' }
  for (const line of ['case $t in a) x;; dbt) dbt run;; esac', 'case $t in a|dbt) dbt run;; esac', 'case $t in (dbt) dbt run;; esac'])
    expect(shape(line)).toEqual([run])
})

test("quotes in a heredoc inside a substitution are text, so Claude's commit form stays readable", () => {
  const line = `dbt run -s a && git commit -m "$(cat <<'EOF'\nfix "foo it's\nEOF\n)"`
  expect(shape(line)).toEqual([{ ...base, binary: 'dbt', subcommand: 'run', select: ['a'] }])
})

test('a here-string inside a substitution is no heredoc', () => {
  const line = `dbt run -s a && echo "$(cat <<< text\n)"`
  expect(shape(line)).toEqual([{ ...base, binary: 'dbt', subcommand: 'run', select: ['a'] }])
})

test('a heredoc right after an escaped < is still a heredoc, so its quotes are text', () => {
  const line = `dbt run -s a && echo "$(cat \\<<<'EOF'\nit's\nEOF\n)"`
  expect(shape(line)).toEqual([{ ...base, binary: 'dbt', subcommand: 'run', select: ['a'] }])
})
