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
deny 'sudo docker exec -i pg psql -c "select 1"'
allow "git commit -m 'docker exec -i pg psql -c select 1'"
deny 'env X=1 docker exec -i pg psql -c "select 1"'
deny 'bash -c "docker exec -i pg psql -c 1"'
deny 'bash -lc "docker exec -i pg psql -c 1"'
deny "sh -ec 'docker exec pg psql -c 1'"
deny 'zsh -lc "psql -c 1"'
deny 'bash -cl "psql -c 1"'
deny "sh -ce 'psql -c 1'"
deny 'zsh -cl "psql -c 1"'
deny "bash -l -c 'psql -c 1'"
deny "bash --login -c 'psql -c 1'"
deny "bash -o pipefail -c 'psql -c 1'"
deny "/bin/bash -e -c 'psql -c 1'"
deny "dash -c 'psql -c 1'"
allow "git commit -m \"make refresh -c 'psql -c x' work\""
allow "bash -l script.sh"
deny '/usr/local/bin/docker exec pg psql -c "select 1"'
deny 'docker --context prod exec pg psql -c "select 1"'
deny 'kubectl -n prod exec -it pod -- psql -c "select 1"'
deny 'kubectl exec pod -c app -- psql -c "select 1"'
deny 'docker compose -f x.yml exec db psql -c "select 1"'
deny 'docker-compose exec db mysql -e "select 1"'
deny 'docker exec -u root -it db mysql -uroot -e "select 1" mysql'
allow 'docker exec -it db psql'
allow 'docker exec db ls psql'
allow 'docker logs db psql -c 1'
allow 'docker exec -it db ls psql -c 1'
allow 'kubectl -n prod exec pod -- ls psql -c 1'
deny 'docker exec -e PGPASSWORD=x -w /tmp db psql -c 1'
deny 'docker exec -ePGPASSWORD=x --user=root db psql -c 1'
deny 'podman --connection prod exec db psql -c 1'
allow 'watch -n1 echo psql -c 1'
allow 'xargs -r echo psql -c 1'
allow "git commit -m \"document bash -cl 'psql -c 1'\""
allow "echo \"run bash -c 'psql -c 1'\""
deny "sudo bash -c 'psql -c 1'"
deny "docker exec db bash -lc 'psql -c 1'"
deny "cd x && bash -O extglob -c 'psql -c 1'"
deny "bash -c \"bash -c 'psql -c 1'\""
deny "docker exec db bash -c \"sh -c 'psql -c 1'\""
deny 'docker exec -- db psql -c 1'
deny 'docker exec -i -- db mysql -e 1'
allow "sudo -n echo bash -cl 'psql -c 1'"
allow "env -i echo bash -cl 'psql -c 1'"
allow '/usr/bin/docker exec --user root psql echo -c 1'
deny 'cat q.sql | sudo psql'
deny 'docker exec -i db psql < q.sql'
deny 'echo "$(psql -c 1)"'
allow 'echo "it'"'"'s'
deny 'timeout -s KILL 5 psql -c 1'
deny 'exec -a x psql -c 1'
deny 'nice -n 5 psql -c 1'
deny 'nice -5 psql -c 1'
allow "echo ';' psql -c 1"
allow "printf '%s' '|' psql"
allow 'echo \; psql -c 1'
allow 'duckdb -init init.sql db'
allow 'bq show query'
deny 'bq --format json query "select 1"'
deny 'bq --headless query "select 1"'
deny "env -S 'psql -c 1'"
deny "env --split-string='psql -c 1'"
deny "echo \"\$(printf '%s' ')'; psql -c 1)\""
deny 'echo "$(echo "a;b"; psql -c 1)"'
deny 'x=`psql -c 1`'
deny "$(printf 'psql -d db <<'"'"'SQL'"'"'\n-- don'"'"'t touch\nselect 1;\nSQL')"
deny "$(printf 'psql "$DB" <<SQL\nselect 1;\nSQL')"
deny "$(printf 'psql -c 1 && git commit -m "$(cat <<'"'"'EOF'"'"'\ndon'"'"'t\nEOF\n)"')"
allow "$(printf 'git commit -m "$(cat <<'"'"'EOF'"'"'\nfix `psql -f migrate.sql`, don'"'"'t (psql -c 1) | psql\nEOF\n)"')"
allow "$(printf 'TASK="$(cat <<'"'"'ALTIMATE_TASK'"'"'\nwhy does `psql -c 1` fail\nALTIMATE_TASK\n)"\nALTIMATE_BIN="$(command -v altimate)"\n"$ALTIMATE_BIN" run "$TASK" < /dev/null')"
allow "$(printf 'cat <<'"'"'EOF'"'"'\n$(psql -c 1)\nhello; psql -c 1\nEOF')"
deny "$(printf 'cat <<EOF\n$(psql -c 1)\nEOF')"
deny "$(printf 'cat <<-EOF\n\tx\n\tEOF\npsql -c 1')"
allow "env GIT_PAGER=cat git log -S 'psql -c x'"
deny '(cat a.sql; cat b.sql)|psql db'
allow "$(printf 'duckdb --version\necho done')"
allow "$(printf 'psql --version\nls -f')"
deny "$(printf 'cd x\npsql -c 1')"
deny "$(printf 'psql \\\n  -c 1')"
deny "$(printf 'psql -\\\nc 1')"
deny 'echo `echo "a`; psql -c 1'
allow 'echo ok # ; psql -c select'
allow 'echo ok # $(psql -c select)'
allow 'echo ok # | psql'
allow 'env echo -S "psql -c select"'
allow 'env echo --split-string "psql -c select"'
deny 'echo a#b; psql -c 1'
deny "$(printf '# note\npsql -c 1')"
deny 'echo "#"; psql -c 1'
allow "$(printf 'echo hi\n# $(psql -c 1)\ntrue')"
deny "$(printf 'echo hi\n# note\npsql -c 1')"
allow "$(printf 'cat <<EOF\nUse \\$(psql -c 1) literally\nEOF')"
deny "$(printf 'cat <<EOF\nUse \\\\\\\\$(psql -c 1) here\nEOF')"
deny "$(printf 'cat <<EOF\n$(echo hi\npsql -c 1)\nEOF')"
allow 'cat <<< "$HOME" && echo psql'
deny "$(printf 'cat <<< x\npsql -c 1')"
deny 'psql <<< "select 1"'
deny "$(printf 'cat a.sql |\n  psql db')"
deny "$(printf 'true &&\n  psql -c 1')"
deny "env -iS'psql -c 1'"
allow "env -uS echo 'psql -c 1'"
deny 'echo x\ #$(psql -c 1)'
deny 'echo $(echo hi)#$(psql -c 1)'
allow '(echo a)#$(psql -c 1)'
deny "$(printf 'cat <<'"'"'E"O'"'"'\ntext\nE"O\npsql -c 1')"
deny "$(printf 'cat <<\\EOF\ntext\nEOF\npsql -c 1')"
deny "$(printf 'cat <<EOF\n$(\npsql -c 1\n)\nEOF')"
deny "$(printf 'printf sql |&\npsql')"
deny 'kubectl exec -it pod -- psql -c "select 1"'
deny 'cd x && podman exec pg psql -c "select 1"'
deny 'true; docker compose exec db mysql -e "select 1"'
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
# Without python3 every command passes.
out="$(payload 'psql -c 1' 2>/dev/null | env -i PATH=/nonexistent ALTIMATE_ROUTE_GUARD=1 /bin/bash "$GUARD" 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && [ -z "$out" ] || fail "guard without python3 should allow quietly (rc=$rc out=$out)"

[ "$FAILURES" -eq 0 ] && echo "PASS" || { echo "$FAILURES failure(s)"; exit 1; }
