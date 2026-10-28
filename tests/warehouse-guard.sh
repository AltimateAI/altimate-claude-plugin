#!/usr/bin/env bash
# Checks hooks-handlers/warehouse-guard.sh: silent unless ALTIMATE_ROUTE_GUARD=1,
# then denies direct warehouse queries and allows everything else.
set -u
cd "$(dirname "$0")/.."
GUARD=plugins/altimate-code/hooks-handlers/warehouse-guard.sh
FAILURES=0
fail() { echo "FAIL: $*"; FAILURES=$((FAILURES + 1)); }

payload() { python3 -c 'import json,sys; print(json.dumps({"tool_name":"Bash","tool_input":{"command":sys.argv[1]}}))' "$1"; }

# run_guard <enabled 0|1> <command>
run_guard() {
  if [ "$1" = 1 ]; then payload "$2" 2>/dev/null | ALTIMATE_ROUTE_GUARD=1 bash "$GUARD"; else payload "$2" 2>/dev/null | env -u ALTIMATE_ROUTE_GUARD bash "$GUARD"; fi
}
deny() {
  out="$(run_guard 1 "$1")"
  printf '%s' "$out" | python3 -c 'import json,sys; o=json.load(sys.stdin)["hookSpecificOutput"]; assert o["permissionDecision"]=="deny" and o["permissionDecisionReason"]' 2>/dev/null \
    || fail "expected deny: $1 (got: $out)"
}
allow() {
  out="$(run_guard 1 "$1")"
  [ -z "$out" ] || fail "expected allow: $1 (got: $out)"
}

command -v python3 >/dev/null || { echo "skip: python3 not installed"; exit 0; }

# Disabled by default: even a clear warehouse query passes silently.
[ -z "$(run_guard 0 'psql -c "select 1"')" ] || fail "guard active without ALTIMATE_ROUTE_GUARD=1"
[ -z "$(printf 'not json' | env -u ALTIMATE_ROUTE_GUARD bash "$GUARD")" ] || fail "disabled guard reacted to bad input"

deny 'docker exec -it trino trino --execute "select 1"'
deny 'docker exec ch clickhouse-client --query "select 1"'
deny 'docker exec -i pg psql -U postgres -c "select 1"'
deny 'trino --server localhost:8080 --execute "show tables"'
deny 'psql -h db -c "select count(*) from t"'
deny 'snowsql -q "select 1"'
deny 'bq query --use_legacy_sql=false "select 1"'
deny 'cd /tmp && psql -f q.sql'

allow 'altimate tool run sql_execute --args '"'"'{"sql":"select 1"}'"'"' --json'
allow 'altimate-code tool run schema_inspect --args {} --json'
allow '"$ALTIMATE_BIN" tool run data_diff --args - --json'
allow 'dbt compile --select stg_orders'
allow 'dbt parse'
allow 'cat psql.sql'
allow 'grep -rn trino models/'
allow 'git commit -m "docs: psql -c example"'
allow 'ls -la'
allow 'psql --version'
[ -z "$(printf 'not json' | ALTIMATE_ROUTE_GUARD=1 bash "$GUARD")" ] || fail "bad input should allow"

[ "$FAILURES" -eq 0 ] && echo "PASS" || { echo "$FAILURES failure(s)"; exit 1; }
