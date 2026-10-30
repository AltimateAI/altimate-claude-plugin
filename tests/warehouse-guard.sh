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
deny 'altimate --version; psql -c "select 1"'
deny 'echo ALTIMATE_BIN; psql -c "select 1"'
deny '/usr/local/bin/altimate-code --version && psql -c "select 1"'
deny 'altimate --version $(psql -c "select 1")'
deny 'altimate --version `psql -c "select 1"`'
deny '/usr/local/bin/psql -c "select 1"'
deny 'env psql -c "select 1"'
deny 'PGPASSWORD=x psql -h db -c "select 1"'
deny 'time psql -c "select 1"'
deny 'sqlcmd -S db -Q "select 1"'
deny 'sqlcmd -S db -i query.sql'
deny 'duckdb db.duckdb "select 1"'
deny "duckdb -readonly db.duckdb 'select 1'"
deny 'altimate tool run x --args @<(psql -c "select 1")'
deny 'altimate tool run x > >(psql -f -)'
deny 'sudo -u postgres psql -c "select 1"'
deny 'env -i psql -c "select 1"'
deny 'time -p psql -c "select 1"'
deny 'timeout 5 psql -c "select 1"'
deny 'nohup psql -c "select 1"'
deny "bash -c 'psql -c \"select 1\"'"
deny '"psql" -c "select 1"'
deny '\psql -c "select 1"'
deny 'duckdb "my db.duckdb" "select 1"'
deny 'duckdb -cmd "select 1" db.duckdb'
deny 'psql "$DSN" -tAc "select 1"'
deny 'mysql -h db -e"select 1"'
deny 'sqlcmd -S db -Qx'
deny 'bq --project_id=x query "select 1"'
deny 'if true; then psql -c "select 1"; fi'
deny '{ psql -c "select 1"; }'
deny '! psql -c "select 1"'
deny '/usr/bin/env psql -c "select 1"'
deny 'clickhouse-client -q "select 1"'
deny 'echo "select 1" | psql'

allow 'altimate tool run sql_execute --args '"'"'{"sql":"select 1"}'"'"' --json'
allow 'altimate-code tool run schema_inspect --args {} --json'
allow '"$ALTIMATE_BIN" tool run data_diff --args - --json'
allow 'altimate tool run sql_execute --args '"'"'{"sql":"select 1; select 2"}'"'"' --json'
allow "$(printf '%s\n' 'TASK="$(cat <<'"'"'ALTIMATE_TASK'"'"'' 'why does stg_orders fail' 'ALTIMATE_TASK' ')"' 'ALTIMATE_BIN="$(command -v altimate)"' '"$ALTIMATE_BIN" run "$TASK" --agent builder < /dev/null')"
allow 'dbt compile --select stg_orders'
allow 'dbt parse'
allow 'cat psql.sql'
allow 'grep -rn trino models/'
allow 'git commit -m "docs: psql -c example"'
allow 'ls -la'
allow 'psql --version'
allow 'duckdb db.duckdb'
allow 'duckdb "my db.duckdb"'
allow 'env | grep PG'
allow 'mysql -h db mydb'
allow 'psql --version && tail -f log'
allow 'trino --version; grep -c foo file'
allow './scripts/psql-helper.sh -c x'
allow 'time make'
allow 'VAR=x make -e'
allow 'psql -h db mydb'
allow 'psql -q -x -e -h db mydb'
allow "$(printf 'git commit -m "docs: guard\n\npsql -c is now caught"')"
allow "$(printf 'git commit -F - <<EOF\nduckdb db.duckdb %s example\nEOF' "'select 1'")"
allow 'bq ls'
allow 'psql -Ufred -l'
allow 'psql -h db -Ucfo mydb'
allow 'mysql -uroot -psecret mydb'
allow 'snowsql -a acct -ufred'
allow 'sqlcmd -S srv -Usa -Pquiz'
allow 'duckdb -version'
allow 'duckdb -json my.duckdb'
[ -z "$(printf 'not json' | ALTIMATE_ROUTE_GUARD=1 bash "$GUARD")" ] || fail "bad input should allow"

[ "$FAILURES" -eq 0 ] && echo "PASS" || { echo "$FAILURES failure(s)"; exit 1; }
