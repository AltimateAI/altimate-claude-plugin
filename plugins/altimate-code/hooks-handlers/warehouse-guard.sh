#!/usr/bin/env bash
# Opt-in PreToolUse hook for Bash. Does nothing unless ALTIMATE_ROUTE_GUARD=1.
# When enabled, denies commands that query a warehouse directly through a
# client (psql -c, trino --execute, docker exec ... clickhouse-client, snowsql,
# bq query) and points at the matching `altimate tool run`. A lone altimate
# command, dbt compile/parse and file operations are never blocked; altimate
# chained with other commands is checked like any command. Any parsing problem
# results in allow: this is a routing nudge, not a security control.

[ "${ALTIMATE_ROUTE_GUARD:-}" = "1" ] || exit 0

INPUT="$(cat)"
CMD=""
if command -v python3 >/dev/null 2>&1; then
  CMD="$(printf '%s' "$INPUT" | python3 -I -c 'import sys,json
try:
    d=json.load(sys.stdin)
    print((d.get("tool_input") or {}).get("command",""))
except Exception:
    pass' 2>/dev/null)"
elif command -v jq >/dev/null 2>&1; then
  CMD="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)"
fi
[ -n "$CMD" ] || exit 0

# A lone altimate CLI command is always allowed; one chained with other commands
# or running a command or process substitution is checked like any other command.
case "$CMD" in
  *[\;\&\|\`]*|*'$('*|*'<('*|*'>('*|*$'\n'*) ;;
  altimate\ *|altimate-code\ *|/*/altimate\ *|/*/altimate-code\ *|\"\$ALTIMATE_BIN\"\ *) exit 0 ;;
esac

# A client counts only in command position: at the start, after ; & | ( ` or an
# `sh -c` quote, past shell keywords (then, do, {, !), sudo/env/command/time/exec/
# nice/nohup/timeout (with their options, by name or path), VAR=value prefixes and
# docker/kubectl exec, written by name or path, quoted or escaped. Newlines are not
# separators, so a client named at the start of a line of a multi-line message passes;
# one named after ( ; | & or a backtick inside quoted text is still taken as a command.
# Best effort, not a shell parser: it nudges, it does not enforce.
NL=$'\n'
START="(^|[;&|(\`]|(bash|sh|zsh)[[:space:]]+-c[[:space:]]+[\"'])[[:space:]]*"
KEYWORD='(then|do|else|elif|if|while|until|[{]|!)[[:space:]]+'
WRAP='([^[:space:]]*/)?(sudo|env|command|time|exec|nice|nohup|timeout)([[:space:]]+(-[^[:space:]]*([[:space:]]+[^-[:space:]][^[:space:]]*)?|[0-9][^[:space:]]*))*[[:space:]]+'
ASSIGN='[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+'
DOCKER='(docker|podman|kubectl)[[:space:]]+(exec|compose[[:space:]]+exec)[^;&|]*[[:space:]]'
PREFIX="(${START}(${KEYWORD}|${WRAP}|${ASSIGN})*|${DOCKER})"
CLIENT="([^[:space:];&|()\`\"']*/)?[\"'\\\\]?(psql|trino|clickhouse-client|clickhouse|snowsql|mysql|sqlcmd|duckdb)[\"']?"

deny() {
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$1"
  exit 0
}

SQL_HINT='Direct warehouse query detected. The altimate-code CLI runs this read-only with no extra setup: altimate tool run sql_execute --workspace-tools --args with a JSON body holding the warehouse and query fields --json (schema_inspect for structure, warehouse_list for connections). Use altimate-code if altimate is not on PATH.'

# Each client invocation is judged by its own arguments, up to the next separator, so
# flags of other commands on the line never count, and by that client's own query
# flags (combined short flags such as psql -tAc included). Interactive or help runs pass.
QUERY_INPUT='(<<|<[[:space:]]*[^[:space:]]+\.sql)'
CLIENT_NAME="(psql|trino|clickhouse-client|clickhouse|snowsql|mysql|sqlcmd|duckdb)[\"']?[[:space:]]*\$"
# Only psql takes combined short flags here, and only its no-value ones before -c/-f
# (psql -tAc); other clients' query flags must stand alone or carry their value.
query_flag() {
  local flag
  case "$1" in
    psql) flag='-[AaEeHLlnqStXx]*[cf]|--command|--file' ;;
    mysql) flag='-e|--execute' ;;
    trino) flag='-f|--execute|--file' ;;
    clickhouse|clickhouse-client) flag='-q|--query|--queries-file' ;;
    snowsql) flag='-q|-f|--query|--filename' ;;
    sqlcmd) flag='-Q[^[:space:]]*|-q[^[:space:]]*|-i' ;;
    duckdb) flag='-c|-s|-cmd' ;;
  esac
  printf '%s' "[[:space:]]($flag)([[:space:]=\"']|\$)"
}
# duckdb [options] <database> "<sql>": SQL as a quoted argument after the database.
DUCKDB_SQL="^([[:space:]]+-[^[:space:]]+)*[[:space:]]+(\"[^\"]*\"|'[^']*'|[^[:space:]\"'-][^[:space:]]*)[[:space:]]+[\"']"
PIPED_INTO="(^|[^|])[|][[:space:]]*${CLIENT}([[:space:]]|\$)"
BQ_QUERY="${PREFIX}([^[:space:];&|()\`\"']*/)?bq([[:space:]]+-[^[:space:]]+([[:space:]]+[^-[:space:]][^[:space:]]*)?)*[[:space:]]+query([[:space:]]|\$)"
CLIENT_CALL="${PREFIX}${CLIENT}([[:space:]]|\$)"

rest="$CMD"
while [[ "$rest" =~ $CLIENT_CALL ]]; do
  match="${BASH_REMATCH[0]}"
  rest="${rest#*"$match"}"
  args=" ${rest%%[;&|${NL}]*}"
  [[ "$match" =~ $CLIENT_NAME ]] || continue
  client="${BASH_REMATCH[1]}"
  flag="$(query_flag "$client")"
  [[ "$args" =~ $flag || "$args" =~ $QUERY_INPUT ]] && deny "$SQL_HINT"
  [[ "$client" = duckdb && "$args" =~ $DUCKDB_SQL ]] && deny "$SQL_HINT"
done

# SQL piped into a client.
[[ "$CMD" =~ $PIPED_INTO ]] && deny "$SQL_HINT"
[[ "$CMD" =~ $BQ_QUERY ]] && deny "$SQL_HINT"

exit 0
