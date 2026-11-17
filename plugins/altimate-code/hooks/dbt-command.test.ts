import { expect, test } from 'claude-code/testing'

import { parseDbtCommand } from './dbt-command'

/** The fields a caller decides on, without the offsets. */
const shape = (line: string) => parseDbtCommand(line).map(({ start, end, subcommandEnd, ...rest }) => rest)

const base = { select: [], target: null, targetPath: null, hasDefer: false, hasState: false, dynamic: false }

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
  expect(shape('dbt run $(printf "(") -t dev')).toEqual([{ ...base, binary: 'dbt', subcommand: 'run', target: 'dev', dynamic: true }])
  expect(shape('dbt run "$(printf ")")" -t dev')).toEqual([{ ...base, binary: 'dbt', subcommand: 'run', target: 'dev', dynamic: true }])
})

test('short options joined to their value, and global options that take one before the subcommand', () => {
  expect(shape('dbt run -tprod -sorders -musers')).toEqual([{ ...base, binary: 'dbt', subcommand: 'run', select: ['orders', 'users'], target: 'prod' }])
  expect(shape(`dbt --warn-error-options '{"include":"all"}' -r timing.txt run -s a`)).toEqual([
    { ...base, binary: 'dbt', subcommand: 'run', select: ['a'] },
  ])
  expect(shape('dbt build --indirect-selection cautious -s a')).toEqual([{ ...base, binary: 'dbt', subcommand: 'build', select: ['a'] }])
})

test('env options that take a value; DBT_TARGET and DBT_TARGET_PATH in front of dbt, which the flags override', () => {
  expect(shape('env FOO=1 dbt run')).toEqual([{ ...base, binary: 'dbt', subcommand: 'run' }])
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
  expect(shape('models=(orders users); for m in "${models[@]}"; do dbt run -s $m; done')).toEqual([{ ...run, dynamic: true }])
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

test('the offsets leave out the keywords and prefix commands in front of dbt, but keep its assignments', () => {
  const cut = (line: string) => parseDbtCommand(line).map(inv => line.slice(inv.start, inv.end))
  expect(cut('if dbt run; then echo ok; fi')).toEqual(['dbt run'])
  expect(cut('time dbt run -s a')).toEqual(['dbt run -s a'])
  expect(cut('! nohup dbt test')).toEqual(['dbt test'])
  expect(cut('env DBT_TARGET=prod dbt run -s a')).toEqual(['DBT_TARGET=prod dbt run -s a'])
  expect(cut('env X=1 Y=2 dbt build')).toEqual(['X=1 Y=2 dbt build'])
  expect(cut('X=1 nohup dbt run')).toEqual(['dbt run'])
  // Splicing a rewrite in keeps the line valid shell.
  const line = 'if dbt run; then echo ok; fi'
  const [one] = parseDbtCommand(line)
  expect(line.slice(0, one!.start) + 'dbt run --target dev' + line.slice(one!.end)).toBe('if dbt run --target dev; then echo ok; fi')
})

test('prefix options: a lookup, env with options and a NAME=value after a wrapper are no invocation', () => {
  const run = { ...base, binary: 'dbt', subcommand: 'run' }
  for (const line of [
    'command -v dbt run',
    'command -V dbt run',
    'env -u X dbt run',
    'env -i dbt run',
    'env -S "dbt run" dbt run',
    'env -u HOME X=1 dbt build',
    'DBT_TARGET=prod env -u DBT_TARGET dbt build',
    'nohup X=1 dbt run',
    'command X=1 dbt run',
    'exec X=1 dbt run',
    'env -- dbt run',
  ])
    expect(parseDbtCommand(line)).toEqual([])
  // `command -p` and `command --` still run the command; assignments after env's or a keyword stay assignments.
  expect(shape('command -p dbt run')).toEqual([run])
  expect(shape('command -- dbt run')).toEqual([run])
  expect(shape('env X=1 Y=2 dbt run')).toEqual([run])
  expect(shape('if X=1 dbt run; then :; fi')).toEqual([run])
  expect(shape('time DBT_TARGET=prod dbt run')).toEqual([{ ...run, target: 'prod' }])
  expect(shape('env DBT_TARGET=prod dbt run')).toEqual([{ ...run, target: 'prod' }])
})

test('a quoted word is never an assignment, a keyword or a prefix command, but a quoted dbt is dbt', () => {
  const run = { ...base, binary: 'dbt', subcommand: 'run' }
  expect(parseDbtCommand('"DBT_TARGET=prod" dbt run')).toEqual([])
  expect(parseDbtCommand("'DBT_TARGET=prod' dbt run")).toEqual([])
  expect(parseDbtCommand('DBT_\\TARGET=prod dbt run')).toEqual([])
  expect(parseDbtCommand('"if" dbt run')).toEqual([])
  expect(parseDbtCommand('"nohup" dbt run')).toEqual([])
  expect(parseDbtCommand("$'time' dbt run")).toEqual([])
  expect(shape('"dbt" run')).toEqual([run])
  // A quoted value is still an assignment's value.
  expect(shape('DBT_TARGET="prod" dbt run')).toEqual([{ ...run, target: 'prod' }])
})

test('an expansion is part of its word, and the invocation is dynamic; its values are never reported', () => {
  const run = { ...base, binary: 'dbt', subcommand: 'run' }
  expect(shape('dbt run --target "$DBT_TARGET"')).toEqual([{ ...run, dynamic: true }])
  expect(shape('dbt run -t $T --target-path ${P:-a b}')).toEqual([{ ...run, dynamic: true }])
  expect(shape('dbt run -s "$(printf orders)"')).toEqual([{ ...run, dynamic: true }])
  expect(shape('dbt run -s $(printf a b)')).toEqual([{ ...run, dynamic: true }])
  expect(shape('dbt run -s `echo a b` -s c')).toEqual([{ ...run, dynamic: true, select: ['c'] }])
  expect(shape('for m in a b; do dbt run -s $m; done')).toEqual([{ ...run, dynamic: true }])
  expect(shape('DBT_TARGET=$T dbt run')).toEqual([{ ...run, dynamic: true }])
  // An expansion in an assignment ahead of a prefix word still reaches dbt's environment.
  expect(shape('DBT_TARGET=$T time dbt run')).toEqual([{ ...run, dynamic: true }])
  expect(shape('DBT_TARGET_PATH=$P nohup dbt run')).toEqual([{ ...run, dynamic: true }])
  expect(shape('DBT_TARGET=prod time dbt run')).toEqual([{ ...run, target: 'prod' }])
  // The flag wins over the environment, but a dynamic flag value is unknown, not the environment's.
  expect(shape('DBT_TARGET=prod dbt run --target "$T"')).toEqual([{ ...run, dynamic: true }])
  expect(shape('dbt run --select=a,$x -s b')).toEqual([{ ...run, dynamic: true, select: ['b'] }])
  // Single quotes and escapes hold no expansion.
  expect(shape("dbt run -s '$literal'")).toEqual([{ ...run, select: ['$literal'] }])
  expect(shape('dbt run -s \\$literal')).toEqual([{ ...run, select: ['$literal'] }])
  // A bare $ is text; an expansion in the binary or the subcommand is no invocation.
  expect(shape('dbt run -s a$')).toEqual([{ ...run, select: ['a$'] }])
  expect(parseDbtCommand('dbt $CMD')).toEqual([])
  expect(parseDbtCommand('dbt "$(echo run)" -s a')).toEqual([])
  expect(parseDbtCommand('$(which dbt) run')).toEqual([])
  expect(parseDbtCommand('"$DBT" run')).toEqual([])
  // An unclosed ${ is unreadable.
  expect(parseDbtCommand('dbt run -s ${a')).toEqual([])
})

test('a redirection among the arguments with an argument after it is unsupported; a trailing one is left out of the range', () => {
  for (const line of ['dbt run > run.log -s orders', 'dbt run 2>/dev/null --target dev', 'DBT_TARGET=a > log dbt run'])
    expect(parseDbtCommand(line)).toEqual([])
  for (const line of ['dbt run -s orders > run.log', 'dbt run -s orders 2>&1 | tee x', 'dbt run -s orders >> run.log 2>&1']) {
    const [one] = parseDbtCommand(line)
    expect(line.slice(one!.start, one!.end)).toBe('dbt run -s orders')
    expect(one!.select).toEqual(['orders'])
  }
  const lead = 'time 2>/dev/null dbt run -s a'
  const [front] = parseDbtCommand(lead)
  expect(lead.slice(front!.start, front!.end)).toBe('dbt run -s a')
})

test('global options that take a value come before the subcommand, and an unknown word does not hide the subcommand', () => {
  const run = { ...base, binary: 'dbt', subcommand: 'run' }
  expect(shape('dbt --partial-parse-file-path p run')).toEqual([run])
  expect(shape('dbt --packages-install-path pk --partial-parse-file-path=p run -s a')).toEqual([{ ...run, select: ['a'] }])
  // A flag this list does not know, with its value, in front of the subcommand.
  expect(shape('dbt --some-new-option value build -s a')).toEqual([{ ...base, binary: 'dbt', subcommand: 'build', select: ['a'] }])
  const line = 'dbt --some-new-option value test'
  const [one] = parseDbtCommand(line)
  expect(line.slice(one!.start, one!.subcommandEnd)).toBe(line)
  // No known subcommand: the first word is reported, as before.
  expect(shape('dbt frobnicate')).toEqual([{ ...base, binary: 'dbt', subcommand: 'frobnicate' }])
})

test('a backslash in double quotes is kept unless it escapes $, a backtick, a quote, a backslash or a newline', () => {
  const run = { ...base, binary: 'dbt', subcommand: 'run' }
  expect(shape('dbt run --target-path "target\\compiled"')).toEqual([{ ...run, targetPath: 'target\\compiled' }])
  expect(shape('dbt run -t "p\\"rod" ')).toEqual([{ ...run, target: 'p"rod' }])
  expect(shape('dbt run -t "pro\\\nd"')).toEqual([{ ...run, target: 'prod' }])
  expect(shape('dbt run -t pro\\\nd')).toEqual([{ ...run, target: 'prod' }])
})

test('a $\'…\' word with an escape is not decoded: it is dynamic and reports no value', () => {
  const run = { ...base, binary: 'dbt', subcommand: 'run' }
  expect(shape("dbt run -t $'pro\\x64'")).toEqual([{ ...run, dynamic: true }])
  expect(shape("dbt run -t $'prod'")).toEqual([{ ...run, target: 'prod' }])
})

test('unquoted tilde, brace lists and patterns are expansions; $"…" is a quoted string; launcher help runs nothing', () => {
  const run = { ...base, binary: 'dbt', subcommand: 'run' }
  expect(shape('dbt run --target-path ~/dbt-target')).toEqual([{ ...run, dynamic: true }])
  expect(shape('DBT_TARGET_PATH=~/x dbt run')).toEqual([{ ...run, dynamic: true }])
  expect(shape('dbt run -s {orders,users}')).toEqual([{ ...run, dynamic: true }])
  expect(shape('dbt run -s models/*.sql -t dev')).toEqual([{ ...run, dynamic: true, target: 'dev' }])
  expect(shape('dbt run -s "{orders,users}" --target-path "~/x" -t \\~')).toEqual([{ ...run, select: ['{orders,users}'], targetPath: '~/x', target: '~' }])
  expect(shape('dbt run -t $"prod"')).toEqual([{ ...run, target: 'prod' }])
  expect(shape('dbt run -t $-')).toEqual([{ ...run, dynamic: true }])
  expect(parseDbtCommand('uv run --help dbt run')).toEqual([])
  expect(parseDbtCommand('uvx --version dbt run')).toEqual([])
})
