#!/usr/bin/env bash
# Runs the three Python scripts the dbt helpers embed (PROFILE_TYPE, MANIFEST_SLICE, RUN_FAILURES) for
# real, with python3 and PyYAML, against fixture profiles, manifests and run_results files that hold a
# secret in odd places. No secret may appear in what a script prints. DBT_MODS_SRC points at another copy
# of dbt-mods.tsx to run these checks against.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${DBT_MODS_SRC:-$ROOT/plugins/altimate-code/hooks/dbt-mods.tsx}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
FAILURES=0
fail() { echo "FAIL: $1"; FAILURES=$((FAILURES + 1)); }

# A missing tool fails the run when CI is set, so CI never runs none of these checks; elsewhere it is a visible warning.
missing() {
  if [ -n "${CI:-}" ]; then echo "FAIL: dbt-scripts: $1, and CI is set"; FAILURES=$((FAILURES + 1)); else echo "SKIP: dbt-scripts: $1; these checks did not run"; fi
}

JS="$(command -v node || command -v bun || true)"
[ -n "$JS" ] || { missing "no node or bun to read the scripts from the TypeScript source"; exit "$FAILURES"; }
command -v python3 >/dev/null || { missing "no python3"; exit "$FAILURES"; }

# Each script is a template literal with no substitutions: read it the way JavaScript does.
"$JS" -e '
const fs = require("fs")
const source = fs.readFileSync(process.argv[1], "utf8")
for (const name of ["PROFILE_TYPE", "PROFILE_REDACT", "MANIFEST_SLICE", "RUN_FAILURES"]) {
  const found = new RegExp("export const " + name + " = `([\\s\\S]*?)`\\n").exec(source)
  if (!found) { console.error("no " + name + " in " + process.argv[1]); process.exit(1) }
  fs.writeFileSync(process.argv[2] + "/" + name + ".py", eval("`" + found[1] + "`"))
}' "$SRC" "$TMP" || { echo "FAIL: could not read the scripts from $SRC"; exit 1; }

# The plugin runs `python -c <script> <args>`; so does this.
script() { local name="$1"; shift; python3 -c "$(cat "$TMP/$name.py")" "$@"; }
field() { python3 -I -c 'import json,sys; print(json.load(sys.stdin).get(sys.argv[1], ""))' "$1"; }
SECRET="SENTINEL_SECRET_VALUE"

# ─── PROFILE_TYPE ───────────────────────────────────────────────────────────────────────────────
YPY=python3
# dbt's own Python always has PyYAML and jinja2; a bare python3 may lack them, so a throwaway venv gets both.
if ! python3 -c 'import yaml, jinja2' 2>/dev/null && python3 -m venv "$TMP/yaml-venv" >/dev/null 2>&1 \
  && "$TMP/yaml-venv/bin/python" -m pip install -q pyyaml jinja2 >/dev/null 2>&1; then
  YPY="$TMP/yaml-venv/bin/python"
fi
if "$YPY" -c 'import yaml, jinja2' 2>/dev/null; then
  printf "name: 'shop'\nprofile: 'shop'\n" > "$TMP/dbt_project.yml"
  # profile <name> <profiles.yml> <expected status> <expected target> <expected type> [VAR=value ...]; an empty target or type is one the script does not print
  profile() {
    local name="$1" yml="$2" want="$3" want_target="$4" want_type="$5" out got; shift 5
    printf '%s' "$yml" > "$TMP/profiles.yml"
    out="$(env "$@" "$YPY" -c "$(cat "$TMP/PROFILE_TYPE.py")" "$TMP/dbt_project.yml" "$TMP/profiles.yml" 2>&1)"
    case "$out" in *SENTINEL*) fail "profile: $name: a secret reached the output: $out" ;; esac
    got="$(printf '%s' "$out" | field status)"
    [ "$got" = "$want" ] || fail "profile: $name: expected status $want, got '$got' ($out)"
    got="$(printf '%s' "$out" | field target)"
    [ "$got" = "$want_target" ] || fail "profile: $name: expected target '$want_target', got '$got' ($out)"
    got="$(printf '%s' "$out" | field type)"
    [ "$got" = "$want_type" ] || fail "profile: $name: expected type '$want_type', got '$got' ($out)"
  }
  profile "plain output" $'shop:\n  target: dev\n  outputs:\n    dev: {type: duckdb}\n' ok dev duckdb
  profile "env_var default and DBT_TARGET" $'shop:\n  target: "{{ env_var(\'T\', \'dev\') }}"\n  outputs:\n    dev: {type: duckdb}\n    prod: {type: postgres}\n' ok dev duckdb X=1
  profile "DBT_TARGET picks the output" $'shop:\n  target: dev\n  outputs:\n    dev: {type: duckdb}\n    prod: {type: postgres}\n' ok prod postgres DBT_TARGET=prod
  # An output's keys under `target:` by an indentation slip: a mapping, never echoed.
  profile "target is a mapping holding a password" $'shop:\n  target:\n    type: postgres\n    password: SENTINEL_SECRET_VALUE\n  outputs:\n    dev: {type: duckdb}\n' no_target '' ''
  profile "target is a list holding a password" $'shop:\n  target: [SENTINEL_SECRET_VALUE]\n  outputs:\n    dev: {type: duckdb}\n' no_target '' ''
  # A line YAML cannot read, with the secret on it.
  profile "malformed line with a password" $'shop:\n  target: dev\n  outputs:\n    dev:\n      type: duckdb\n      password: SENTINEL_SECRET_VALUE: invalid\n' error '' ''
  # Templates dbt renders: never echoed, whatever is inside.
  profile "target template naming a secret" $'shop:\n  target: "{{ foo(\'SENTINEL_SECRET_VALUE\') }}"\n  outputs:\n    dev: {type: duckdb}\n' template '' ''
  profile "type template naming a secret" $'shop:\n  target: dev\n  outputs:\n    dev: {type: "{{ var(\'SENTINEL_SECRET_VALUE\') }}"}\n' template '' ''
  profile "type is a mapping" $'shop:\n  target: dev\n  outputs:\n    dev:\n      type: {password: SENTINEL_SECRET_VALUE}\n' no_type dev ''
  profile "type that is no name" $'shop:\n  target: dev\n  outputs:\n    dev: {type: "SENTINEL_SECRET_VALUE pw!"}\n' no_type dev ''
  # A target an env var (or DBT_TARGET) gave is never echoed back, even when it names no output.
  profile "env_var target with no such output" $'shop:\n  target: "{{ env_var(\'T\') }}"\n  outputs:\n    dev: {type: duckdb}\n' no_output '' '' T=SENTINEL_TARGET_FROM_ENV
  profile "DBT_TARGET with no such output" $'shop:\n  target: dev\n  outputs:\n    dev: {type: duckdb}\n' no_output '' '' DBT_TARGET=SENTINEL_TARGET_FROM_ENV
  profile "profile named by DBT_PROFILE with no such profile" $'shop:\n  target: dev\n  outputs:\n    dev: {type: duckdb}\n' no_profile '' '' DBT_PROFILE=SENTINEL_PROFILE_FROM_ENV
  printf "name: 'shop'\nprofile: \"{{ env_var('P') }}\"\n" > "$TMP/dbt_project.yml"
  profile "profile named by an env_var in dbt_project.yml" $'shop:\n  target: dev\n  outputs:\n    dev: {type: duckdb}\n' ok dev duckdb P=shop
  printf "name: 'shop'\nprofile: 'shop'\n" > "$TMP/dbt_project.yml"
  profile "a nested filter in the target" $'shop:\n  target: "{{ env_var(\'T\') | trim }}"\n  outputs:\n    dev: {type: duckdb}\n' ok dev duckdb "T= dev "
  profile "a default holding the opposite quote" $'shop:\n  target: "{{ env_var(\'T\', \\"d\'ev\\") }}"\n  outputs:\n    "d\'ev": {type: duckdb}\n' ok "d'ev" duckdb
  profile "no such output" $'shop:\n  target: staging\n  outputs:\n    dev: {type: duckdb}\n' no_output staging ''
else
  missing "no python3 with PyYAML and jinja2 (and none could be installed into a venv), so the PROFILE_TYPE checks cannot run"
fi

# ─── PROFILE_REDACT ─────────────────────────────────────────────────────────────────────────────
# The strings dbt's errors may echo back: every string under the profile's outputs (aliases resolved) and the env vars
# profiles.yml names. The script prints them to the plugin only.
if "$YPY" -c 'import yaml, jinja2' 2>/dev/null; then
  printf "name: 'shop'\nprofile: 'shop'\n" > "$TMP/dbt_project.yml"
  # redact <name> <profiles.yml> <value that must be listed> [VAR=value ...]; a value of "-" means none must be listed
  redact() {
    local name="$1" yml="$2" want="$3" out; shift 3
    printf '%s' "$yml" > "$TMP/profiles.yml"
    # The assignments set for the command arrive on stdin (REDACT_STDIN), as the plugin sends them.
    out="$(env "$@" "$YPY" -c "$(cat "$TMP/PROFILE_REDACT.py")" "$TMP/dbt_project.yml" "$TMP/profiles.yml" 2>&1 <<<"${REDACT_STDIN:-{\}}")"
    printf '%s' "$out" | python3 -I -c '
import json, sys
want = sys.argv[1]
found = json.load(sys.stdin)["redact"]
assert (want == "-" and not found) or want in found, found
' "$want" || fail "redact: $name: expected $want in the list ($out)"
  }
  redact "a connection URL as the host" $'shop:\n  target: dev\n  outputs:\n    dev:\n      type: postgres\n      host: "postgresql://alice:SENTINEL_HOST@db.example/d"\n' 'postgresql://alice:SENTINEL_HOST@db.example/d'
  redact "sslmode read from the wrong variable" $'shop:\n  target: dev\n  outputs:\n    dev:\n      type: postgres\n      sslmode: "{{ env_var(\'DB_PASSWORD\') }}"\n' SENTINEL_SSLMODE DB_PASSWORD=SENTINEL_SSLMODE
  redact "target read from an env var" $'shop:\n  target: "{{ env_var(\"DB_PASSWORD\", \"SENTINEL_DEFAULT\") }}"\n  outputs:\n    dev: {type: duckdb}\n' SENTINEL_TARGET DB_PASSWORD=SENTINEL_TARGET
  redact "an env_var default literal" $'shop:\n  target: dev\n  outputs:\n    dev: {type: duckdb, path: "{{ env_var(\'P\', \'SENTINEL_DEFAULT\') }}"}\n' SENTINEL_DEFAULT
  redact "a password reused through an alias" $'shop:\n  target: dev\n  outputs:\n    dev:\n      type: postgres\n      password: &pw SENTINEL_ALIAS\n      threads: *pw\n' SENTINEL_ALIAS
  redact "a JWT with a line break" $'shop:\n  target: dev\n  outputs:\n    dev:\n      type: trino\n      method: jwt\n      jwt_token: "eyJSENTINEL_JWT\\n.sig"\n' $'eyJSENTINEL_JWT\n.sig'
  redact "an output that is not the active target" $'shop:\n  target: dev\n  outputs:\n    dev: {type: duckdb}\n    prod: {type: postgres, password: SENTINEL_PROD}\n' SENTINEL_PROD
  # env_var calls are read in the decoded values: a double-quoted YAML string may escape its quotes.
  redact "an env_var with escaped quotes: its value" $'shop:\n  target: dev\n  outputs:\n    dev:\n      type: postgres\n      sslmode: "{{ env_var(\\"DB_PASSWORD\\", \\"SENTINEL_DEFAULT\\") }}"\n' SENTINEL_ENV_VALUE DB_PASSWORD=SENTINEL_ENV_VALUE
  redact "an env_var with escaped quotes: its default" $'shop:\n  target: dev\n  outputs:\n    dev:\n      type: postgres\n      sslmode: "{{ env_var(\\"DB_PASSWORD\\", \\"SENTINEL_DEFAULT\\") }}"\n' SENTINEL_DEFAULT
  # Identifiers are not secrets: schema, database, user and the like, and an env var used only under one.
  redact "identifier keys" $'shop:\n  target: dev\n  outputs:\n    dev: {type: postgres, schema: analytics_prod, database: warehouse_db, dataset: some_dataset, project: some_project, catalog: some_catalog, warehouse: some_warehouse, role: some_role_name, user: some_user_name}\n' -
  redact "an env var used only under an identifier key" $'shop:\n  target: dev\n  outputs:\n    dev: {type: postgres, schema: "{{ env_var(\'SCH\', \'default_schema\') }}"}\n' - SCH=SENTINEL_SCHEMA
  redact "an env var used under an identifier and a secret key" $'shop:\n  target: dev\n  outputs:\n    dev: {type: postgres, schema: "{{ env_var(\'SCH\') }}", password: "{{ env_var(\'SCH\') }}"}\n' SENTINEL_SCHEMA SCH=SENTINEL_SCHEMA
  # Templates are rendered with jinja2, not matched: a default holding the other quote, nested filters, a profile name from an env var.
  redact "a default holding the opposite quote" $'shop:\n  target: dev\n  outputs:\n    dev:\n      type: postgres\n      password: "{{ env_var(\'X\', \\"SENTINEL\'PASSWORD\\") }}"\n' "SENTINEL'PASSWORD"
  redact "a nested filter: the env value" $'shop:\n  target: dev\n  outputs:\n    dev:\n      type: postgres\n      password: "{{ env_var(\'X\') | trim }}"\n' SENTINEL_FILTERED X="  SENTINEL_FILTERED  "
  redact "a nested filter: the rendered field" $'shop:\n  target: dev\n  outputs:\n    dev:\n      type: postgres\n      password: "{{ env_var(\'X\') | trim | upper }}"\n' SENTINEL_UPPER X=sentinel_upper
  redact "a template that errors is taken as written" $'shop:\n  target: dev\n  outputs:\n    dev:\n      type: postgres\n      password: "{{ var(\'SENTINEL_UNDEFINED\') }}"\n' "{{ var('SENTINEL_UNDEFINED') }}"
  redact "a template that errors still gives the env_var before it" $'shop:\n  target: dev\n  outputs:\n    dev:\n      type: postgres\n      password: "{{ env_var(\'X\') ~ var(\'y\') }}"\n' SENTINEL_BEFORE_ERROR X=SENTINEL_BEFORE_ERROR
  # profile named by an env var in dbt_project.yml
  printf "name: 'shop'\nprofile: \"{{ env_var('P') }}\"\n" > "$TMP/dbt_project.yml"
  redact "a profile named by an env_var in dbt_project.yml" $'shop:\n  target: dev\n  outputs:\n    dev: {type: postgres, password: SENTINEL_NAMED_BY_ENV}\n' SENTINEL_NAMED_BY_ENV P=shop
  printf "name: 'shop'\nprofile: 'shop'\n" > "$TMP/dbt_project.yml"
  # Python's own reprs of a value: dbt prints a non-ASCII or control-byte secret in a bytes repr, `\xNN` escapes among it.
  redact "a non-ASCII value as a bytes repr" $'shop:\n  target: dev\n  outputs:\n    dev:\n      type: trino\n      jwt_token: "SENTINEL_\u20ac_TOKEN"\n' 'SENTINEL_\xe2\x82\xac_TOKEN'
  redact "a control byte as a repr" $'shop:\n  target: dev\n  outputs:\n    dev:\n      type: trino\n      jwt_token: "SENTINEL_TOKEN\\x07\\ttail"\n' 'SENTINEL_TOKEN\x07\ttail'
  # Assignments set for the command (DB_PASSWORD=x dbt run) are what dbt renders with.
  REDACT_STDIN='{"env": {"DB_PASSWORD": "SENTINEL_COMMAND_ENV"}}' redact "an env var set for the command" $'shop:\n  target: dev\n  outputs:\n    dev:\n      type: postgres\n      sslmode: "{{ env_var(\'DB_PASSWORD\') }}"\n' SENTINEL_COMMAND_ENV
  redact "nothing but short values, types and ports" $'shop:\n  target: dev\n  outputs:\n    dev: {type: postgres, method: password, port: 5432, threads: 1234567, user: me}\n' -
else
  missing "no python3 with PyYAML and jinja2 (and none could be installed into a venv), so the PROFILE_REDACT checks cannot run"
fi

# ─── MANIFEST_SLICE ─────────────────────────────────────────────────────────────────────────────
python3 - "$TMP" <<'PY'
import json, sys
secret = 'SENTINEL_SECRET_VALUE'
def node(name, kind, path, **rest):
    return dict(name=name, resource_type=kind, package_name='shop', original_file_path=path, raw_code=secret, compiled_code=secret, **rest)
manifest = {
    'metadata': {'project_name': 'shop', 'env': {'DBT_ENV_SECRET_PASSWORD': secret}},
    'nodes': {
        'model.shop.stg': node('stg', 'model', 'models/stg.sql', description=secret, columns={}, depends_on={'nodes': []}),
        'model.shop.orders': node('orders', 'model', 'models/orders.sql', description='One row per order', relation_name='"db"."orders"', patch_path='shop://models/schema.yml', config={'materialized': 'table'}, tags=[], columns={'id': {'name': 'id', 'description': 'key'}}, depends_on={'nodes': ['model.shop.stg']}),
        'model.shop.revenue': node('revenue', 'model', 'models/revenue.sql', description=secret, columns={'x': {'name': 'x', 'description': secret}}, depends_on={'nodes': ['model.shop.orders']}),
        'test.shop.unique_orders_id.abc': node('unique_orders_id', 'test', 'models/schema.yml', column_name='id', test_metadata={'name': 'unique'}, depends_on={'nodes': ['model.shop.orders']}),
        'model.shop.unrelated': node('unrelated', 'model', 'models/unrelated.sql', description=secret, columns={}, depends_on={'nodes': []}),
    },
    'macros': {'macro.shop.m': {'macro_sql': secret}},
    'sources': {'source.shop.s': {'description': secret}},
    'parent_map': {'model.shop.orders': ['model.shop.stg'], 'model.shop.revenue': ['model.shop.orders'], 'test.shop.unique_orders_id.abc': ['model.shop.orders'], 'model.shop.stg': [], 'model.shop.unrelated': []},
    'child_map': {'model.shop.stg': ['model.shop.orders'], 'model.shop.orders': ['model.shop.revenue', 'test.shop.unique_orders_id.abc'], 'model.shop.revenue': [], 'model.shop.unrelated': []},
}
json.dump(manifest, open(sys.argv[1] + '/manifest.json', 'w'))
# The same graph with no parent_map and child_map: the slice builds them from depends_on.
bare = dict(manifest); bare.pop('parent_map'); bare.pop('child_map')
json.dump(bare, open(sys.argv[1] + '/manifest-bare.json', 'w'))
open(sys.argv[1] + '/manifest-broken.json', 'w').write('{"nodes": {"a": "' + secret + '" ')
PY
for file in manifest manifest-bare; do
  out="$(script MANIFEST_SLICE "$TMP/$file.json" models/orders.sql shop 2>&1)"
  case "$out" in *SENTINEL*) fail "manifest slice ($file): a secret reached the output" ;; esac
  printf '%s' "$out" | python3 -I -c '
import json, sys
s = json.load(sys.stdin)
names = sorted(n["name"] for n in s["nodes"].values())
assert names == ["orders", "revenue", "stg", "unique_orders_id"], names
assert "model.shop.unrelated" not in s["nodes"]
orders = s["nodes"]["model.shop.orders"]
assert orders["description"] == "One row per order" and orders["columns"]["id"]["name"] == "id"
assert set(s["nodes"]["model.shop.stg"]) == {"name", "resource_type"}
' || fail "manifest slice ($file): the slice is not the file's node, its test and its neighbours by name"
done
out="$(script MANIFEST_SLICE "$TMP/manifest-broken.json" models/orders.sql shop 2>&1)"; code=$?
[ "$code" -ne 0 ] || fail "manifest slice: a broken manifest did not fail"
case "$out" in *SENTINEL*) fail "manifest slice: the error for a broken manifest quotes it" ;; esac

# ─── RUN_FAILURES ───────────────────────────────────────────────────────────────────────────────
python3 - "$TMP" <<'PY'
import json, sys
secret = 'SENTINEL_SECRET_VALUE'
results = {
    'metadata': {'invocation_id': 'inv-1', 'generated_at': '2026-11-17T00:00:00Z', 'env': {'DBT_ENV_SECRET_PASSWORD': secret}},
    'args': {'vars': {'password': secret}, 'target': 'dev'},
    'results': [
        {'unique_id': 'model.shop.ok', 'status': 'success', 'message': 'OK', 'compiled_code': secret, 'adapter_response': {'query_id': secret}},
        {'unique_id': 'model.shop.skipped', 'status': 'skipped', 'message': 'SKIPPED'},
        {'unique_id': 'model.shop.bad', 'status': 'error', 'message': 'Binder Error: no column named order_dte', 'compiled_code': secret, 'adapter_response': {'query_id': secret}, 'relation': secret, 'failures': None},
        {'unique_id': 'test.shop.unique_bad.abc', 'status': 'fail', 'message': 'Got 2 results, configured to fail if != 0', 'failures': 2, 'compiled_code': secret},
    ],
}
json.dump(results, open(sys.argv[1] + '/run_results.json', 'w'))
long = dict(results); long['results'] = [dict(results['results'][2], message='x' * 5000)]
json.dump(long, open(sys.argv[1] + '/run_results-long.json', 'w'))
# A message whose secret starts before the cut at 2000 characters and ends after it.
crossing = dict(results); crossing['results'] = [dict(results['results'][2], message='x' * 1990 + 'SENTINEL_LONG_SECRET_VALUE_CROSSING_THE_CUT' + ' tail')]
json.dump(crossing, open(sys.argv[1] + '/run_results-crossing.json', 'w'))
open(sys.argv[1] + '/run_results-broken.json', 'w').write('{"results": [{"message": "' + secret + '"')
PY
out="$(script RUN_FAILURES "$TMP/run_results.json" <<<'[]' 2>&1)"
case "$out" in *SENTINEL*) fail "run failures: a secret reached the output" ;; esac
printf '%s' "$out" | python3 -I -c '
import json, sys
r = json.load(sys.stdin)
assert [x["unique_id"] for x in r["results"]] == ["model.shop.bad", "test.shop.unique_bad.abc"], r
assert set(r["results"][0]) <= {"unique_id", "status", "message", "failures"}
assert r["metadata"] == {"invocation_id": "inv-1", "generated_at": "2026-11-17T00:00:00Z"}, r["metadata"]
' || fail "run failures: only the failed results, with their message and the run's invocation, are given"
out="$(script RUN_FAILURES "$TMP/run_results-long.json" <<<'[]' 2>&1)"
printf '%s' "$out" | python3 -I -c 'import json, sys; assert len(json.load(sys.stdin)["results"][0]["message"]) == 2000' || fail "run failures: a message is cut at 2000 characters"
# The profile's values arrive on stdin and are cut out before the message is cut: no part of one is left at the cut.
out="$(script RUN_FAILURES "$TMP/run_results-crossing.json" <<<'["SENTINEL_LONG_SECRET_VALUE_CROSSING_THE_CUT"]' 2>&1)"
case "$out" in *SENTINEL*) fail "run failures: a secret crossing the cut left its start in the message" ;; esac
printf '%s' "$out" | python3 -I -c 'import json, sys; m = json.load(sys.stdin)["results"][0]["message"]; assert "redacted" in m and len(m) <= 2000' || fail "run failures: the secret is replaced before the message is cut"
out="$(script RUN_FAILURES "$TMP/run_results-broken.json" <<<'[]' 2>&1)"; code=$?
[ "$code" -ne 0 ] || fail "run failures: a broken file did not fail"
case "$out" in *SENTINEL*) fail "run failures: the error for a broken file quotes it" ;; esac

[ "$FAILURES" -eq 0 ] && echo "dbt-scripts: all checks that could run passed"
exit "$FAILURES"
