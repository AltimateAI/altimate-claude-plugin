---
name: data-question
description: >-
  Answer natural-language questions over one or more databases directly with
  altimate-code MCP tools, using Claude Code for reasoning and SQL analysis.
---

# Answer a data question

Use the `altimate-code` MCP tools yourself; Claude Code supplies the reasoning.

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
   Unique-in-sample is evidence to investigate, not proof of a unique key.
6. Check that every condition in the question actually filters something.
   Compare counts or values before and after filtering; investigate no-op
   conditions rather than silently dropping them or inventing exclusions.
7. When a phrase has two readings, compute both and choose using the question's
   own definitions. If those definitions do not resolve it, show both readings.
8. Return the requested values in the requested shape, with a one-line basis
   stating the sources, filters, and calculation. Report tool failures or missing
   data plainly; do not fabricate values.
