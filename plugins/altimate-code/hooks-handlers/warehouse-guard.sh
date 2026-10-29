#!/usr/bin/env bash
# Opt-in PreToolUse hook for Bash. Does nothing unless ALTIMATE_ROUTE_GUARD=1.
# When enabled, denies commands that query a warehouse directly through a
# client (psql -c, trino --execute, docker exec ... clickhouse-client, snowsql,
# bq query) and points at the matching `altimate tool run`. A lone altimate
# command, dbt compile/parse and file operations are never blocked; altimate
# chained with other commands is checked like any command. Any parsing problem
# results in allow.

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
# is checked like any other command.
case "$CMD" in
  *[\;\&\|]*|*$'\n'*) ;;
  altimate\ *|altimate-code\ *|/*/altimate\ *|/*/altimate-code\ *|\"\$ALTIMATE_BIN\"\ *) exit 0 ;;
esac

# A client is only matched in command position (start, or after ; & | ( or sudo / docker exec),
# so file operations that merely mention a client name pass.
START='(^|[;&|(]|&&|\|\|)[[:space:]]*(sudo[[:space:]]+)?'
DOCKER='(docker|podman|kubectl)[[:space:]]+(exec|compose[[:space:]]+exec)[^;&|]*[[:space:]]'
PREFIX="($START|$DOCKER)"

deny() {
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$1"
  exit 0
}

SQL_HINT='Direct warehouse query detected. The altimate-code CLI runs this read-only with no extra setup: altimate tool run sql_execute --workspace-tools --args with a JSON body holding the warehouse and query fields --json (schema_inspect for structure, warehouse_list for connections). Use altimate-code if altimate is not on PATH.'

if [[ "$CMD" =~ ${PREFIX}(psql|trino|clickhouse-client|clickhouse|snowsql|mysql|sqlcmd|duckdb)([[:space:]]|$) ]]; then
  # Interactive or help invocations without a query are left alone.
  if [[ "$CMD" =~ (^|[[:space:]])(-c|--command|-e|--execute|-q|--query|-f|--file|-x)([[:space:]=]|$) ]] || [[ "$CMD" =~ (\<\<|\|[[:space:]]*(psql|trino|clickhouse|snowsql|mysql|duckdb)|\<[[:space:]]*[^[:space:]]+\.sql) ]]; then
    deny "$SQL_HINT"
  fi
fi

if [[ "$CMD" =~ ${START}bq[[:space:]]+query ]]; then
  deny "$SQL_HINT"
fi

exit 0
