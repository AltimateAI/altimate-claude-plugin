# Changelog

All notable changes to this plugin will be documented in this file.

## [Unreleased]

### Changed
- The plugin needs altimate-code 0.12.12 or later, the release with the dbt Power User tools the cost check, project health, team comments, `/runs`, `/profile-ctes`, `/sql-graph`, `/to-model` and `/defer` call, and the documentation coverage after a model edit (`dbt_docs_coverage`). The session-start notice (status line) now names a 0.12.11 install, which it used to leave alone, and the "update altimate-code" lines in the task band and report name 0.12.12.

### Added
- `info_toasts` (on by default): off, the dbt helpers raise no toast for what the transcript or the band already shows (model context added for Claude, a model compiled and validated, the dbt doctor passing); failures still toast.

### Fixed
- On a package repo whose `integration_tests` installs it, with the repo's `target` linked to `integration_tests/target`, the dbt doctor checks the project compile and validate runs from: it no longer says the packages are missing, its dbt, Python, adapter, packages and connection checks, Run dbt parse and Run dbt deps all use `integration_tests`, and its header says dbt runs there.
- After `/clear`, the new conversation loads the team comments again (the band, and the threads Claude gets when it reads a commented model) instead of waiting for `/comments` or the next poll, and project health keeps its baseline, the changes not yet checked and the issues found (`/health` no longer says the session has no project; a check the `/clear` cut short runs again). The status line keeps the integrations and altimate-code parts; health draws its own again.
- The dbt runs the plugin starts by itself (compile and validate's `dbt show` and `dbt ls`, `/dbt-show` and Re-run, and the project health check's parse) write their artifacts to `target/.altimate-plugin/` instead of `target/`, so they no longer replace the project's `manifest.json` (with every model's compiled SQL) or `run_results.json`. The health check runs its CLI call in its own process for that, with the project's `catalog.json` copied beside its manifest. The doctor's **Run dbt parse** still refreshes the project's own manifest.
- After Claude edits a model's SQL that dbt has not compiled since, its documentation coverage says it is from before the edit, and once the edit's compile-and-validate check has run the model, `/propagate` shows the coverage of the model as it is now.
- The end-of-task summary for a model the task created says its columns are new with an unknown reach, not "update altimate-code".
- When the Query results or lineage pane sits above the prompt (a terminal under 110 columns, or not fullscreen), Claude Code gives it the same height whatever size it asks for, so the Min / Default / Max row, which did nothing there, is replaced by a line saying so.
- `--defer --state …`, `--favor-state` and `--target …` that `/defer` and `/target` add to Claude's dbt commands are no longer invisible: Claude's result says what the command ran as, and a line above the prompt shows it until the next prompt.
- **Resolve** on a thread the lagging comment list still shows after it was resolved elsewhere is done (the thread is hidden) instead of answering "not an open thread"; a reply to such a thread says it is no longer open and reads the list again.
- The end-of-task band no longer says a changed column "reaches 0 columns in 0 models" on a compiled project when its readers `select *` from it (jaffle_shop's `stg_payments.amount`, read by `orders` and `customers`). The task's copy of the manifest sat one folder below `target/`, and altimate-code reads a seed's CSV header from the folder above the manifest's, so nothing was traced through a `select *` from a seed. The copies now sit in `target/` itself (`.altimate-manifest-before.<session>.json`, `.altimate-task-manifest.<session>.json`), and the band and `/lineage-report` trace what the per-edit note traces (6 columns in 2 models there). A reach of 0 beside downstream models that may pass the column on without naming it (`select *`, `NATURAL JOIN`, columns named at run time) is now "not traced: N downstream models may read it without naming it (select *)", with a lower-bound footer instead of "✓ Every downstream model was read".
- When no output column changed but values may have (a column computed in a Jinja `{% set %}` block the select reads, as in Tuva's `core__medical_claim`), the band says "values may change in paid_amount → reaches N columns in M models": the names on the lines the change added that the manifest has as the model's columns and that reach a downstream column (impact_analysis decides both). When none qualifies it says "values may change downstream; the model-level count stands", never a count of 0.
- Compile and validate flags a model, seed, snapshot or source that the model's compiled SQL reads by its table but that dbt does not list among the model's dependencies (a `ref()` replaced by `main.stg_orders`): "hardcoded main.stg_orders: use {{ ref('stg_orders') }} — lineage can't follow it", in the band, the dbt check pane and Claude's note, which asks Claude to put the `ref()` back unless the person asked for the table. The tables come from altimate-code's `dbt_map_relations` on the SQL dbt compiled; only a table matched to a single node counts. With an altimate-code that lacks the tool, nothing is flagged.
- Compile and validate warns only about the columns an edit left undocumented. What the model returned before is read from the warehouse, not from its SQL: the last check's columns, or, on a model's first check with an undocumented column, `dbt show` of the model's built relation (`select * from {{ ref('…') }}`, one row). A column it returned before is said once a conversation, quietly ("2 undocumented before this edit"), and does not make the check a warning.
- A package repo tested from a project below it (Tuva: `integration_tests/` installs the package with `local: ../`): when the package's own packages are not installed, compile and validate runs dbt from that project (selecting the model by package and name), says "ran from integration_tests", and the doctor counts the packages installed there. A project whose packages are not installed and that nothing installs gets a one-line "not checked: dbt's packages are not installed…" note instead of a failure.
- With `show_edit_impact` on, a model Claude changes through a shell command (`python3 …`, `sed -i`, `cat > …`) gets the same per-edit impact note as an Edit: the model files under the project's model folders modified since the command started are found after it ends, and their change from the last commit is traced. The note goes to Claude's context too.
- The lineage pane moves to the model Claude is editing as the edit starts (before its impact lookup and the edit itself), and to the model a writing shell command names as it starts, instead of after the edit lands.
- At its default size the lineage pane draws a graph wider than the pane as its ends only (which fit, dashboards included), saying so; `v` shows the whole graph. Dashboards (exposures) downstream that the drawing leaves out are named under it.
- While the end-of-task band traces a change that names no output column, it says "tracing…" instead of "values may change downstream; the model-level count stands", which read as the answer before the trace of `paid_amount` came back.
- `/profile-ctes` times a CTE that reads none of the CTEs before it (a sibling) on its own, instead of as its time less the slower CTE before it (which showed `payments +0 ms` after `order_items` in `customer_revenue`): with an altimate-code that lists the CTEs each one reads, a CTE's own part is its count's time less the own parts of the CTEs it reads, directly or through another. An older altimate-code keeps the previous rule.
- The lineage pane says when the model's schema.yml changed after the manifest was written ("run `dbt parse`, then press r"): its test count comes from there, and removing a model's tests left it counting them with no warning. For a manifest over 4 MiB, whose graph altimate-code builds, this needs an altimate-code whose graph names each node's schema.yml.
- The model-context toast says "N columns in schema.yml" (those listed there, not the columns the model returns) and "1 column", "1 test"; Claude's note says the same. The lineage pane's log line says "read by 1 model".
- A package repo with no `target/` of its own (Tuva, opened at the repo root): the lineage pane, the per-edit impact note, the end-of-task band, `/lineage-report`, a plan's impact, the dbt doctor's manifest line (its **Run dbt parse** runs there too) and the model context Claude gets on a read use the manifest dbt writes in the project below that installs the package (`integration_tests/target/manifest.json`), instead of falling back to the SQL files and tracing nothing (or saying the manifest is missing). The task's manifest copy sits beside it, one copy a task when a package model and an `integration_tests` model both change.
- The lineage pane's out-of-date warning ends "then press r" (the pane's refresh key) instead of "then r".
- With more than three changed columns, the band no longer adds "✓ Every downstream model was read" next to "+ N more changed column, not traced here".
- The lineage pane's key hints (u, d, c, v, r, a) wrap to a second line in a narrow pane instead of running down its right edge a letter a line.
- The doctor pane reads its manifest line from the files whenever it is drawn (the manifest's age against the project's files, kept until a tool call or a new manifest), so a pane open since before Claude's edits no longer says "Manifest current" once a project file is newer. "dbt parse finished" is an `info_toasts` toast: the doctor shows it.
- After Apply, `/propagate` says how many downstream columns it sent to Claude this session, instead of "No column description has been written yet".
- The end-of-task band traces the first three changed columns of a model and now says how many more changed ("+ 1 more changed column, not traced here (/lineage-report <model>.<column> traces one)"), instead of listing three as if they were all.
- Claude's `dbt show` text table and **Re-run** show numbers the same way: a column of numbers in dbt's text table (`21,109.09`, `20,476.10`) is read as numbers, as dbt's JSON output gives them (`21109.09`, `20476.1`). A number with more digits than a double holds keeps its digits as text. Only a column dbt draws right-aligned (as it draws numbers) is read as numbers: a text column (versions such as `1.10`), one whose cells give no alignment, and one holding leading-zero codes (`00501`) stay text.
- `/profile-ctes`: a CTE whose count took less than the CTEs it reads took on their own (the warehouse shares their work inside the count) shows "≈0 ms (the CTEs it reads cost less inside this query)" instead of "+0 ms".

### Added
- `/altimate-feedback <what happened>` drafts a GitHub issue for this plugin's repository from your words and a few facts the plugin knows (plugin, altimate-code and Claude Code versions, the altimate-code binary name, OS, dbt-core, adapter and Python versions when the dbt doctor has run, and the plugin's on/off settings), shows the exact title and body, and creates it only after `--confirm`: with `gh issue create` (labelled `feedback` when the repository has that label) when `gh` is installed and signed in, otherwise as a prefilled new-issue link. `--with-error` also attaches the kind of the last plugin error (its type and code only, none of its message); `--cancel` discards the draft.

### Privacy
- PRIVACY.md has a section on the dbt Power User features: what team comments, the model context note, the dbt run history, the cost check, project health, the SQL graph, CTE timing, `/to-model`, defer, docs coverage and the lineage pane read and send, what the run history keeps and where, and which tools run with `--allow-write` without asking. The README's note on write permission lists them too.

## [1.8.3] — 2026-11-19

### Fixed
- Project health: a Bash command with its own `cd` is read from the folder it started in even when another Bash call finishes meanwhile (a subagent's); the start folder is kept per call. `echo ${#arr[@]}; git push` is found as a push. A session outside a dbt project no longer looks up the shell folder or holds a push.
- `/scan-cost` with no model keeps the planner label of the last Snowflake or Databricks estimate ("Snowflake plan estimate").

### Added
- The README documents the cost check, project health, team comments, `/runs`, `/profile-ctes`, `/sql-graph`, `/to-model`, `/defer` and `/target`, and `/propagate`, lists the hooks module among the components, and says those need altimate-code 0.12.12 (the release with the dbt Power User tools they call) while the plugin itself runs from 0.12.11.
- The README explains `altimate-dbt`, the dbt command line that comes with altimate-code, what the agent uses it for, and that you do not need to run it.

## [1.8.2] — 2026-11-19

### Added
- Anonymous usage events, sent through altimate-code's usage telemetry (`altimate-code tool report-event`); the plugin opens no network connection of its own for them. `plugin_session_start` at each session start carries the plugin version, the altimate-code version (added by the CLI), the OS (`macos`, `linux`, `windows`, `wsl` or `unknown`) and an install id: a random UUID made on first use and kept in the plugin's Claude Code store, so it stays the same across sessions on the machine. `plugin_feature_used` carries the feature and its outcome when `/lineage`, `/dbt-show`, `/profile-ctes`, `/scan-cost`, `/comments`, `/sql-graph`, `/health`, `/runs` or `/to-model` opens (`opened`, or `failed` when its pane could not open), when the cost check holds a dbt command (`held`) or `/allow-scan` allows it (`allowed`), and, with "Project health blocks git push" on, when the push gate holds or lets through a `git push`. No session id, project, model, column or file names, SQL or session text: the CLI takes each field only from a fixed list or pattern, and sends these events without the account, machine id or project its other events carry. A panel counts when a person opens it (its command, or the band's Open lineage or Open); `failed` when it could not open or be shown. Every event and field is listed in PRIVACY.md.
- The events need an altimate-code with the `plugin_session_start` and `plugin_feature_used` actions; an older one refuses them and nothing is sent or shown. They run in the background and never delay a hook.

### Changed
- With `ALTIMATE_TELEMETRY_DISABLED` (or `OPENCODE_DISABLE_TELEMETRY`) set to `true` or `1`, the plugin no longer starts the CLI for any usage event (the lineage report's included) and makes no install id. The CLI's own opt-out (that variable, or `telemetry.disabled` in its config) still drops them too.

## [1.8.1] — 2026-11-19

### Fixed
- The end-of-task column summary no longer says a changed column "reaches 0 columns in 0 models" when nothing was traced. When the models that read the column have no compiled SQL (a manifest from `dbt parse`), the band says "not traced: N downstream models have no compiled SQL (run `dbt compile`)". The report says the same in its downstream section, and `/lineage-report <model>.<column>` on a column the manifest does not reach is a plain error. The per-edit impact note (to Claude, and to you with `show_edit_impact`) follows the same rules. Models read in full that the value was not traced to still show as "may change" beside a reach of 0. Every changed column is asked of the manifest by name; one the SQL from before the task did not name and the manifest lacks (likely added) is said to have an unknown reach. The old name of a rename is still traced. A model read only in part counts as unread. A column found with nothing downstream still says it reaches 0.
- A missing altimate-code, or one without the `dbt_health` tool, no longer pops a toast at session start or after a turn; `/health` says it, naming the tool and the install command instead of a version.
- The settings say what each option does and that it is optional, with its default. The BigQuery scan limit and the team comments options no longer say they are unused.
- With a column in focus, the lineage pane counts only the tests on that column of the model ("3 tests on amount"); with none, or when the graph does not say which column each test checks (a manifest over 4 MiB), the tests downstream as before.
- Install and update instructions in the commands and skills give one method: `npm i -g @altimateai/altimate-code`.

### Added
- At session start, an altimate-code older than the plugin needs (or none on PATH) keeps a part at the end of the status line (a preview build, 0.0.0-…, says nothing) with its version, the binary and where it is, and `npm i -g @altimateai/altimate-code`.
- When the terminal is too narrow for the lineage pane, a line above the prompt says so, with the width it needs, until the pane can open or `/lineage` is used.
- `show_edit_impact` (off by default): also shows the per-edit impact note Claude gets in the transcript.

## [1.8.0] — 2026-11-17

### Added
- dbt helpers from dbt Power User, in the Claude Code session. Each runs the project's own dbt (its `.venv/bin/dbt` when there is one) and calls no model:
  - **Compile and validate.** After Claude edits or writes a model, the plugin runs it with `dbt show` (one row) against the warehouse. dbt's error, or the columns `schema.yml` documents that the query no longer returns and those it returns undocumented, go to Claude with the edit's result and to a line above the prompt; the **dbt check** pane shows every column, or dbt's whole error. The check says when the columns could not be compared, and runs again when the model or its schema file changes outside Claude's edits.
  - **Explain and Fix.** A failed `dbt run`, `test`, `build`, `seed`, `snapshot` or `retry` puts the failed nodes, read from the `run_results.json` the command wrote together with the errors dbt printed, above the prompt with **Explain** and **Fix with Altimate Code** (`/altimate-code:altimate`).
  - **Query results pane.** Rows from Claude's `dbt show`, `/dbt-show <model>` and `/dbt-show select …` open as a table beside the chat, with **Re-run** (Claude's own command with the same flags and folder, unless it depended on its shell; or your query), **Bookmark**, **Clear history** and a history kept across sessions on this machine. It opens at the widest dock, and **Min / Default / Max** resize it (the lineage pane has them too); the choice is kept across sessions.
  - **Model context.** When Claude reads a model, its materialization, columns (types, descriptions, tests), parents, children and depth upstream and downstream, from `target/manifest.json`, go with the file, once a turn.
  - **Environment doctor.** At session start the plugin checks dbt, Python, the profile's adapter, installed packages and whether the manifest is older than the project's files, and offers **Run dbt parse** (or **Run dbt deps**). `/dbt-doctor` runs the checks with the warehouse connection test.
- Compile and validate runs one `dbt show` per edit (with `dbt ls`, which runs no query, first when the manifest does not name the model). It skips a model whose path holds a space, says "dbt could not be run here" when dbt cannot be started, and asks Claude to fix the model only for errors that are the model's own.
- Secret values from the `profiles.yml` a dbt command reads (the one its `--profiles-dir` or `DBT_PROFILES_DIR` names, else the one in the folder it ran in, the project's, or `~/.dbt`'s: the string fields of its outputs, and the env vars it names with their defaults) are removed from dbt's messages (errors, logs, the doctor's details, the failure band, Explain and Fix, and the error text kept in the query history) that the helpers show, save or send, and dbt's errors about a `profiles.yml` it cannot read, validate or render are replaced with a fixed message. Identifiers such as schema, database, dataset, project, catalog, warehouse, role and user are not treated as secrets, nor are values under 6 characters or the `type`, `threads`, `method` and `port` fields; query results and manifest facts are shown as they are. The plugin reads those values locally, keeps them in memory only, and never logs, stores or sends them. Redaction is best effort, not a guarantee about every text dbt prints: it matches those values as written, JSON-escaped and in Python's string and byte forms, including values set for the command (`NAME=value dbt …`, `env`, `export`); it cannot catch a value dbt or an adapter prints in another form (encoded, transformed or split), or one the profile builds other than through `env_var`. Other dbt errors (a missing target or profile name, a model's own missing `env_var`) are kept, since they carry no secret. A dbt command Claude runs itself shows its output to Claude unchanged. The fixed message is "profiles.yml could not be parsed; run `dbt debug` yourself to see the error"; it replaces the error on every surface: the compile-and-validate note, the check pane, the band, Explain and Fix, `/dbt-show` and its saved history, and the doctor.
- Saved queries cut long cells and drop rows to stay within 32 KiB each (a query whose SQL alone is larger is kept whole, within the history's 2 MiB total); bookmarks are capped at 50.
- Artifacts are read from the `target-path` of `dbt_project.yml`; `DBT_TARGET_PATH`, `--target-path` and a Jinja `target-path` are not followed.
- The `dbt_mods` option turns the dbt helpers off.

### Privacy
- README and PRIVACY say that opening a dbt folder runs the project's `.venv` dbt `--version` and its Python at session start, and that bookmarked queries keep their rows after **Clear history** in Claude Code's plugin store.

## [1.7.0] — 2026-11-17

### Added
- `/altimate-code:rules` also lists your skill and knowledge requests to the linked workspace: waiting, approved, rejected with the reviewer's reason, withdrawn or removed (replaced requests are counted, not listed). It is read-only: withdraw or remove in the Altimate web app, altimate-code's TUI or its VS Code extension.
- Decisions on your skill and knowledge requests appear as one toast per check (the newest, and how many more), once each, at session start and every 15 minutes in an interactive session (`hooks/review-notices.ts`). A decision is held for the session that shows it and marked shown only after the toast, so two sessions never both toast it and one whose session ended first, or whose acknowledgement failed (logged), is shown again later. Signed out or not linked is asked again at the next check. The first check in a project records decisions already kept without a toast. Claude is also told of them at session start by altimate-code, whether or not team rules apply in the project. Needs an altimate-code release with `workspace review decisions`; with an older one the plugin asks once per session and shows nothing.
- `skill publish` from a session uses `--json` and relays the review outcome: sent for review to the owner, already waiting, or already approved. Claude first checks `skill publish --help`: with an altimate-code that has no `--json` there, it publishes without it and relays the text.
- `/altimate-code:rules` says when the request list may be partial, and shows names, reviewers and reasons as quoted data.
- PRIVACY.md: the review status checks.

## [1.6.1] — 2026-11-16

### Fixed
- Integrations pane: a failed discard of entered values is reported when the form opens and when it is cancelled, instead of ignored. A credential form without variants opens instead of failing. A CLI reason is shown only when it is a non-empty string (`message` or `error`, as `altimate workspace` sends it); otherwise the CLI's stderr, or a generic failure text, is shown.

## [1.6.0] — 2026-11-16

### Added
- End-of-task column impact: after a task that changed a dbt model, a band sums up each changed column's downstream reach from `impact_analysis`. The task's start copies `target/manifest.json` aside, so the answer reflects the SQL before the task.
- An offline HTML report, built when **Open report** or `/lineage-report` asks for it: what changed and what to expect downstream in plain words, who consumes it from dbt exposures, then upstream and downstream lineage, two levels by default, and click-to-highlight paths.
- `/lineage-report <model>.<column>` opens the same report for any column, with no task behind it: where the column comes from first, then where its value goes. It reads the project's manifest as it is now, writes its own file beside the task's report, and an unknown model or column gets a plain error.
- When a plan goes up for approval, a line above the dialog gives the downstream models, tests and exposures of each model the plan names.
- Usage events for the report, through altimate-code's telemetry (`tool report-event`): the summary shown, **Open report** pressed, `/lineage-report` run, and the report built, failed or with no browser. The step and the session id only, off under the telemetry opt-out. See PRIVACY.md.
- The report draws the column lineage as a graph beside the summary: upstream on the left, downstream on the right, opened to fit, with zoom and pan. A click lights a column's path, "more levels" adds one, and a level of more than 12 models folds into one box. The page allows only its own inline script and style. An edge carries a label only when the engine told how the value changes (same, renamed, calculated, aggregated); the rest are dashed and unlabelled, and a note under the graph says so. A click on a column counts even when the hand drifts a few pixels (up to 12) before letting go; a longer drag still pans.
- The report lists every downstream model the value wasn't traced to under "May carry it", grouped by reason: SQL that couldn't be read, an ephemeral model, `*`, a NATURAL JOIN, a name given at run time, a model the value reaches, and so on, with "not traced" last. No model is reported unaffected. On the column report, "Where it comes from" also says how many models upstream may also be a source, with the same reasons.

### Changed
- The band says how many columns and models the value reaches and how many more models may change: "reaches 24 columns in 11 models (11 end columns) · 28 more may change".
- Needs altimate-code 0.12.11 or later, whose column answer says why each model it couldn't trace to may carry the value. An altimate-code that gives no column answer is told to update in the band and the report.
- The per-edit impact note no longer shows as a toast and band; it still goes to Claude's context with the edit's result. A lookup that missed its time or failed still shows a toast.
- The per-edit column lookup goes through the altimate CLI instead of the MCP server, so it raises no permission prompt in accept-edits mode and a large column answer arrives whole.

### Fixed
- The end-of-task band comes back after Claude Code's session list (Left arrow at an empty prompt, then back), unless a prompt came since or it was dismissed.

## [1.5.0] — 2026-11-10

### Added
- Team rules from a linked Altimate workspace apply in Claude Code sessions. At session start the plugin gives Claude the workspace's approved rules for the repository, the number of proposed rules waiting for you, and the owner's reviews of your proposals since your last session.
- Corrections you make to Claude are recorded locally (UserPromptSubmit, no model call). After a turn, altimate-code checks them in the background (Stop) and keeps a proposed rule when you corrected the same topic in two sessions or corrected a team rule Claude was given.
- "Remember this as a team rule: …" said to Claude waits as a proposal (no model call).
- `/altimate-code:rules`: answer proposed rules (send for review, approve as owner, edit, save as memory, or "Not a rule"), and see the team rules and the review status of your proposals.
- The hooks run altimate-code only where the session's folder (or a folder above it in the repository) is in altimate-code's workspace link cache, which is in your own state directory: nothing in the repository turns them on. Team rules arrive in a linked project when you are signed in; recording corrections and drafting proposals also need learning on. `ALTIMATE_LEARN=0` turns all of it off and the hooks start nothing.
- Start the session in the linked folder or below it: with only a subfolder linked (a dbt project), a session started at the repository root gets no team rules.
- The hooks need an altimate-code release with `learn hook`; with an older one they do nothing.

## [1.4.2] — 2026-11-09

### Fixed
- Lineage counts read right. "No model for certain (2 may)" replaces "at least 0 models", a dashboard that only may read a column is called a maybe, and one dashboard is "1 dashboard".
- `/lineage` replies with what it found, so a model that doesn't exist says so. It also says where the pane is: beside the chat when docked, above the prompt otherwise.
- In a terminal under 144 columns, Claude Code holds back a pane the plugin opens on its own. A toast now says so once, and that `/lineage` opens it.
- The pane says when the shown model's `.sql` changed after the manifest was written, by an edit or a shell command, until `dbt compile` and `r`. The edit note and toast say it too.
- A graph too big for Claude Code to draw in a pane is shown as folders, with a line saying why. Before, the pane was blank or cut off.
- An edit's column check uses the edited model's own columns: the pane's, an earlier read's, or `dbt_lineage` through the CLI. A column that `schema.yml` leaves out is traced, whatever model the pane shows.
- Claude Code hands over a column reach of about 49 KB or more as a preview of a saved file. That file is now read, so a widely read column keeps its column detail.
- Work the plugin schedules no longer fails a session that has ended, such as after a reload or `/clear`.

## [1.4.1] — 2026-11-06

### Added
- Lineage beside the chat (`hooks/lineage.tsx`, a Claude Code mod): a pane follows the dbt model Claude reads or edits and draws its upstream and downstream models, dashboards and column lineage from `target/manifest.json`, with no model calls. `/lineage <model>[.column]` opens it on a model. A column the engine can't classify shows no derivation label, rather than "Not sure" on every column. See the README's "Lineage beside the chat".
- Impact first: before an edit to a model's SQL lands, the plugin checks what reads the model and the columns the edit touches. It adds the result to Claude's context and leaves a band above the prompt with the severity and counts.

### Fixed
- A manifest over 4 MiB is read through altimate-code. When the answer arrives cut off, the pane now reports that the answer could not be read, and asking again tries again. An edit that hits this goes ahead with a toast saying the lookup failed, and Claude is told that what reads the model is unknown. Before, the pane said "No dbt model matches" for a model that exists and kept saying so until the manifest changed, and the edit got no note and no message. altimate-code releases up to 0.12.9 can cut off a large answer on a pipe.

### Upgrading
- A 1.4.0 install from this marketplace made before lineage merged has no lineage, and `plugin update` calls it current, because it compares versions. In a terminal, run `claude plugin marketplace update altimate-claude-plugin`, then `claude plugin update altimate-code@altimate-claude-plugin`, then restart Claude Code.

## [1.4.0] — 2026-10-28

### Added
- One-click integrations (`hooks/integrations.tsx`, a Claude Code mod; typed by `types/index.d.ts`): a band offers Connect, Keep local, Review or Later for GitHub, Jira and Linear credentials found on the machine, `/integrations` opens a side pane to add, update, sync, allow sync, disconnect or link a workspace, and the status line counts connected integrations. It runs `altimate integrations`, trying `altimate` then `altimate-code` only when the first is not installed.
- Signed out of Altimate, the band and pane offer Sign in to sync and hide the sync buttons; everything stays local.
- Keep local is durable: sync, Sync all and Link workspace skip it until Allow sync. In a provider's Update form it removes the workspace connection this tool made and keeps the credential on this machine, with the token pasted again. Connect or Keep local on a found credential acts on what was found, not on values left in an earlier form, and shows the CLI's notes.
- A credential is tested with its provider before it is uploaded, by Connect and by Sync alike, and a known token expiry is saved with the workspace connection. A credential the workspace marks invalid is not kept (a new connection is removed again), and local secrets are deleted only after the workspace accepts the upload.
- Sync all and Link workspace upload nothing over a connection this tool already saved to the workspace; they only attach it to the linked workspace, also when this machine has no record of it, and say so when it was deleted there. A credential found here stays offered next to a connection made by hand in the web app.
- The CLI serialises state writes, Keep local, uploads and disconnect with the shared cross-process file lock; a lock left by a killed run is taken over after 12 seconds, and waiting for it ends after 30 seconds.
- The plugin allows 90 s for local calls, 300 s for connect, update, a one-provider sync and disconnect, and the same 300 s for each provider of Sync all, which makes one call per provider in turn, so one provider failing or timing out does not stop the others. Sessions run with `-p` or the SDK do not scan the machine.
- Tests: `hooks/integrations.test.tsx` (`claude plugin test .`).
- Team workspace skills as Claude Code skills, in both the MCP and CLI modes. At session start `hooks-handlers/sync-workspace-skills.py` copies the skills of the Altimate workspace linked to the project (from `.altimate-code/skill/_workspace/`) into `.claude/skills/`. Copies keep only `name` and `description` from the frontmatter, have `!` command blocks disarmed, leave out files Claude Code reads as hooks, agents, commands or settings, are served only for the Altimate account the user is signed in to (tenant, URL and key digest), never replace a skill the user wrote (copies carry a marker file; a name clash skips the workspace skill), and get a `.gitignore` so they stay out of version control. When the workspace drops a skill, its copy is removed. The SessionStart context mentions the project skills when copies exist.
- A project that was never synced, or not for an hour, is refreshed by a detached `altimate workspace refresh` that the hook does not wait for. It is bounded by a per-project lock that expires after ten minutes, and it is skipped silently when no CLI is on PATH or the project has no `.altimate-code` directory. Claude Code's skill watcher loads the copies when it finishes.
- The SessionStart context lists each workspace skill copy with its description (250 characters per skill, 4,000 in all; past that, a count of the rest). Claude Code shows skill descriptions only while its skill listing fits a size budget (about 1% of the context window), and past it project skills appear as bare names that Claude cannot match to a request.
- `ALTIMATE_CLAUDE_SKILL_SYNC=0` turns the skill copy and refresh off.
- Tests: `tests/test_sync_workspace_skills.py` (`python3 -m pytest tests/`).
- `hooks-handlers/refresh-skills.sh` holds the refresh: `--if-stale` starts it in the background only when the snapshot is missing or over an hour old, `--wait` refreshes now and reports how many workspace skill copies are present. SessionStart never waits on the network.
- A Stop hook runs the same hourly background refresh in long sessions, so updated or removed workspace skills reach the session.
- `/altimate-code:refresh-skills` refreshes the workspace skills on demand.
- Tests: `tests/refresh-skills.sh`.

- How the copies stay safe: they are served only for the signed-in Altimate account (tenant, URL and the CLI's credential digest); concurrent sessions, refreshes and the CLI's own copy take turns under one renewed `mkdir` lock in `.claude/skills` and swap each copy with rollback; a snapshot or credentials that cannot be read, a listed skill directory that is gone, or a snapshot briefly missing or replaced while the CLI swaps in a new one, leaves the copies alone; symlinked snapshot files and nested `CLAUDE.md` files are not copied; a skill folder without the `.altimate-workspace-skill` marker is never touched; staging left by a killed sync is removed. `ALTIMATE_CLAUDE_SKILL_SYNC=0` also removes the copies.
- Refresh is per account: a failed refresh is retried at most hourly, and a newly signed-in account refreshes at once. `/altimate-code:refresh-skills` reports when another refresh still holds the lock instead of running alongside it.
- The mode check reads MCP policy as Claude Code applies it (`managed-mcp.json`, `managed-settings.d/`, merged `allowedMcpServers` and `deniedMcpServers` by name or command, `allowManagedMcpServersOnly`, servers turned off in `/mcp`), and the CLI-mode guidance names the executable on PATH (`altimate` or `altimate-code`).
- The opt-in warehouse guard (a best-effort nudge, not a security control) allows only a lone `altimate` command, judges each client call by its own arguments and that client's query flags (`psql -tAc` included), and also catches command and process substitution, client paths and quoted names, shell keywords, `sudo`/`env`/`time`/`timeout` wrappers and variable prefixes, `sh -c`, `bq` global flags and DuckDB SQL arguments.

- MCP registration (`.mcp.json`): the `altimate-code` stdio server runs `altimate-code mcp serve`, read-only by default. Tools: `warehouse_list`, `warehouse_add`, `sql_execute` (`tables` returns schemas and value profiles in the same call), `sql_materialize`, `answer_commit`, plus `impact_analysis`, `dbt_lineage`, `altimate_core_column_lineage`, `schema_detect_pii`, `data_diff`, `altimate_core_equivalence` and `sql_translate`. It needs an altimate-code build that contains `mcp serve`, and the CLI on PATH as `altimate-code`; curl installs expose only `altimate`, so they need an `altimate-code` link for the server to start (the CLI mode works either way).
- The skill, `/altimate-code:altimate`, the `analyst` agent and the SessionStart text describe two modes. When tools named `mcp__plugin_altimate-code_altimate-code__*` are available, they are used. When they are not (an organisation's managed settings disallow MCP servers, the server failed to start, or the build lacks `mcp serve`), the same tools run through `altimate tool run`, starting with one `tool context` call that prints the connections, schema listing and analyst method. An organisation that blocks MCP therefore still gets every tool.

- SessionStart picks the mode without starting the CLI (`hooks-handlers/data-mode.sh`). It uses the CLI mode when `altimate-code` is not on PATH, when managed, user or project settings deny the server (`deniedMcpServers`, or an `allowedMcpServers` list without it; `disabledMcpjsonServers` covers only a project's own `.mcp.json` servers, so it is not read), or when `ALTIMATE_DATA_MODE=cli`; `ALTIMATE_DATA_MODE=mcp` forces the MCP mode. Only the CLI mode adds the project routing guidance (the same text `altimate-code link --claude-md` writes to `CLAUDE.md`); the MCP mode adds none.
- Tests: `tests/data-mode.sh`.
- Linked Altimate workspaces in both modes, without an altimate-code agent. The MCP server starts with `--workspace-tools`, and in CLI mode every `tool run`, `tool list` and `tool schema` call passes `--workspace-tools` (one warm tool process per project). Claude uses `workspace_context` (setup status, receipt, summary, skills, memory and, with `include_tools`, the operation catalog), `workspace_skill` and `workspace_execute` (`ask_knowledge_base`, workspace warehouse connections and read-only queries). The skill covers setup statuses (`needs_auth`, `needs_workspace`, `disabled`, `unavailable`, `needs_engine`), receipt refresh, engine installation only after the user agrees, linking with `ALTIMATE_DISABLE_MEMORY=1`, skill list/refresh/publish, and memory saving only on explicit request through `workspace-client remember`. Older CLIs without `--workspace-tools` keep delegating workspace questions to `run`.
- Tests: `tests/workspace-tools.sh` (static checks; with `ALTIMATE_TEST_BIN`, a live check against a CLI build).

- Opt-in PreToolUse hook `warehouse-guard.sh`, active only when `ALTIMATE_ROUTE_GUARD=1`. It denies Bash commands that query a warehouse directly and suggests the matching `tool run`. `altimate` commands, dbt and file operations pass. Needs `python3`.
- `analyst` agent: a read-only data analyst that works through `tool run`.
- Tests: `tests/warehouse-guard.sh`.

### Changed

- Managed MCP policy is also read from `C:\Program Files\ClaudeCode` on Windows; a background or `--wait` refresh releases its lock when it exits or is stopped; the opt-in guard's hint also says how to run a write (`--allow-write` after the user agrees, or `altimate run`).
- The skill, the `analyst` agent and the CLI-mode SessionStart text describe the three workspace features in both modes: team skills as project skills, conventions, knowledge and memory through `workspace_context`, and warehouse reads through `workspace_execute`. With a CLI that turns workspace tools on in linked projects, `tool context` also prints the workspace name and its team skills; the plugin still passes `--workspace-tools` so older CLIs work.

- The `analyst` agent works in both modes and ends with `FINAL ANSWER:`, optionally recorded with `answer_commit`.
- `/altimate-code:altimate` answers data questions with the MCP tools when present and otherwise delegates with the `analyst` agent; long jobs use `builder`.

- The `altimate-code` skill now has Claude call the model-free data tools itself with `altimate tool run <name> --args '<json>'` instead of delegating each task to a second agent. It lists which tools fit which question, how to pass arguments, that calls are read-only until the user approves `--allow-write`, and to ask a clarifying question when a request has two readings. Delegation with `altimate run` stays for long multi-step jobs and is the fallback when the CLI has no `tool` subcommand.
- The skill description and SessionStart context describe the tools directly and no longer claim work Claude does well alone.

## [1.1.1] — 2026-10-20

### Fixed
- The skills and slash commands now resolve the CLI as `altimate`, its canonical name since v0.7.1, and fall back to `altimate-code` for npm installs older than v0.7.1. Older curl and PowerShell installs expose only `altimate`, so the plugin reported "not installed" on machines where the CLI was present. Workspace, link and sign-in commands use the same lookup.
- Install guidance and recovery messages name `altimate`, which every install method provides, and list both the npm and the curl install.

## [1.1.0] — 2026-10-19

### Fixed
- Delegated runs no longer hang. Claude Code's shell leaves stdin open and `altimate-code run` reads piped stdin as part of the task, so the run waited forever before it started. Every `altimate-code run` invocation now redirects stdin from `/dev/null`.
- The skill and `/altimate-code:altimate` no longer pass `--agent fast-edit`. altimate-code has no such agent, so every run fell back to `builder` with a warning. Runs now ask for `builder` directly.
- Sign-in advice uses `altimate-code auth login -p altimate-backend --method "Altimate LLM Gateway"`. Without `--method`, `auth login` waits at a menu that Claude Code's `!` prompt cannot answer.
- The output file is created with `mktemp "${TMPDIR:-/tmp}/altimate-result.XXXXXX"`. On macOS, `mktemp -t altimate-result.XXXXXX.md` left the `X`s in the name.

### Added
- Altimate workspaces: the skill, `/altimate-code:altimate` and the SessionStart context say that a linked project's runs use the workspace's skills, knowledge and memory, route questions about the team's own conventions and knowledge to altimate-code, and tell the user how to sign in and link. Linking from Claude Code lists the workspaces with `altimate-code workspace list` (in altimate-code releases that have it) and links the chosen one with `link --workspace`, because the `link` picker needs a terminal that `!` does not provide.
- README: "Use an Altimate workspace" setup, and the install command for Anthropic's plugin directory.

### Changed
- Docs name the command `/altimate-code:altimate`, as Claude Code lists it. Claude Code namespaces plugin commands, so a bare `/altimate` answers "Unknown command".

## [1.0.0] — 2026-07-09

### Added
- Initial release of the `altimate-code` plugin.
- Delegation skill (`skills/altimate-code/SKILL.md`) that routes dbt and warehouse tasks to the [altimate-code](https://github.com/AltimateAI/altimate-code) CLI agent instead of Claude's native tools.
- SessionStart hook (`hooks/hooks.json`) that describes the plugin's capabilities in the system prompt so Claude can route to it when the task shape fits.
- `/altimate` slash command (`commands/altimate.md`) for explicit delegation with agent-persona selection (`fast-edit` / `analyst` / `builder`).
