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

1. List available connections with `warehouse_list`. If the one you need is
   missing, find its details in the project and add it with `warehouse_add`.
2. Inspect relevant tables by passing `tables` to `sql_execute` (together with
   your first queries when you can). Read the value profile before
   choosing columns or join keys: frequency-ranked values, distinct/null counts,
   unique-in-sample flags, value shapes, and nested paths where present. Formats
   can differ across databases; names alone do not establish compatible keys.
3. Prefer computing filters, joins, and aggregates in the database with
   `sql_execute`. If results spill to a file path, read the needed results there.
4. For joins across connections, use `sql_materialize` to copy the smaller,
   filtered side into session-local `scratch` DuckDB. Materialize the other
   required inputs there too, then join them in one SQL query in `scratch`.
5. Check keys, fan-out, grain, or nulls with counting queries when they could
   change the answer. Count over all relevant rows, not just a sample.
   Unique-in-sample is evidence to investigate, not proof of a unique key.
6. Check that every condition in the question actually filters something.
   Compare counts or values before and after filtering; investigate no-op
   conditions rather than silently dropping them or inventing exclusions.
7. When a phrase has two readings, compute both and choose using the question's
   own definitions. If those definitions do not resolve it, show both readings.
8. Finish with `answer_commit`: pass one field (or rows column) per item the
   request asks for, `asked` listing those items in order, and a one-line basis
   (sources, filters, calculation). It rejects a call that leaves an asked item
   unanswered or commits a number absent from query output; fix what it names and
   call again. Reply with exactly the `FINAL ANSWER:` text it returns. Report tool
   failures or missing data plainly; do not fabricate values.

For a dedicated analyst session, start Claude Code with
`claude --agent altimate-code:analyst`; it carries this method as its system prompt.
