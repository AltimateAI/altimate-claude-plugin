---
name: data-question
description: >-
  Use for ordinary data questions over a database or warehouse ("how many",
  "which", "average", "top N", "compare", counts, lists, totals). Answer with the
  altimate-code MCP tools yourself; delegate to the CLI analyst if unavailable.
---

# Answer a data question

When the `altimate-code` MCP tools are available in the session, use them yourself;
Claude Code supplies the reasoning. Tell the user that the MCP path is being used.
If the tools are unavailable (server missing or failed to start), tell the user
and follow the `altimate-code` skill's CLI delegation workflow with
`--agent analyst`, including its installation/provider checks and private output
file. Delegation uses the CLI's separate configured LLM provider. Do not attempt
the MCP steps below when its tools are unavailable.

1. List available connections with `warehouse_list`.
2. Inspect relevant tables with `schema_inspect`. Read its value profile before
   choosing columns or join keys: frequency-ranked values, distinct/null counts,
   unique-in-sample flags, value shapes, and nested paths where present. Formats
   can differ across databases; names alone do not establish compatible keys.
3. Prefer computing filters, joins, and aggregates in the database with
   `sql_execute`. If results spill to a file path, read the needed results there.
4. For joins across connections, use `sql_materialize` to copy the smaller,
   filtered side into session-local `scratch` DuckDB. Materialize the other
   required inputs there too, then join them in one SQL query in `scratch`.
5. Use `sql_check` when keys, fan-out, grain, or nulls could change the answer.
   It runs on SQLite, DuckDB, and Postgres. For other engines, first use
   `sql_materialize` to copy the relevant rows into `scratch`, then run the checks
   there. Materialize all relevant rows for a key or grain check, not just a sample.
   Unique-in-sample is evidence to investigate, not proof of a unique key.
6. Check that every condition in the question actually filters something.
   Compare counts or values before and after filtering; investigate no-op
   conditions rather than silently dropping them or inventing exclusions.
7. When a phrase has two readings, compute both and choose using the question's
   own definitions. If those definitions do not resolve it, show both readings.
8. Return the requested values in the requested shape, with a one-line basis
   stating the sources, filters, and calculation. Report tool failures or missing
   data plainly; do not fabricate values.
