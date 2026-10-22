// Claude Code mods API: https://code.claude.com/docs/en/plugins/mods/events
import { register as registerDataMode, resetMode } from './data-mode.mjs'
// Keep this display-only middleware transparent to the model and MCP server.
const SQL_TOOL = 'mcp__plugin_altimate-code_altimate-code__sql_execute'
const WORKSPACE_QUERIES = {
  'mcp__plugin_altimate-code_altimate-code__workspace_snowflake_execute_database_query': 'snowflake',
  'mcp__plugin_altimate-code_altimate-code__workspace_bigquery_execute_database_query': 'bigquery',
  'mcp__plugin_altimate-code_altimate-code__workspace_postgresql_execute_database_query': 'postgresql',
  'mcp__plugin_altimate-code_altimate-code__workspace_databricks_execute_sql': 'databricks',
}
const PANE = 'altimate-data'
const LIMIT = 8
let queries = []

function clip(text, limit = 8000) {
  return text.length > limit ? text.slice(0, limit) + '\n[Pane preview clipped; full output remains in the tool result.]' : text
}

function resultText(answer) {
  if (typeof answer.deny === 'string') return answer.deny
  if (typeof answer.text === 'string') return answer.text
  if (typeof answer.result === 'string') return answer.result
  const content = answer.result?.content
  return Array.isArray(content)
    ? content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    : 'No text result. See the tool call in the conversation.'
}

function failed(answer) {
  return typeof answer.deny === 'string' || answer.isError === true || answer.result?.isError === true
}

function begin(input) {
  const query = {
    warehouse: WORKSPACE_QUERIES[input.tool] ? '(workspace ' + WORKSPACE_QUERIES[input.tool] + ')' :
      typeof input.warehouse === 'string' ? clip(input.warehouse, 120) : '(default connection)',
    sql: clip(typeof input.query === 'string' ? input.query : typeof input.sql === 'string' ? input.sql : typeof input.sql_query === 'string' ? input.sql_query : JSON.stringify({
      queries: input.queries, query_from: input.query_from, tables: input.tables,
    }), 2000),
    status: 'Running',
    output: '',
  }
  queries = [...queries.slice(-(LIMIT - 1)), query]
  return query
}

// Redraw failures must never retry, replace, or conceal a completed query.
function redraw($) {
  try { $.ui.invalidate('ui.render') } catch { /* The transcript remains available. */ }
}

export function register(on) {
  registerDataMode(on)
  on('session.start', async ($, e, next) => {
    queries = []
    resetMode()
    await $.command.register({ name: 'altimate-data', description: 'Open recent Altimate SQL results', immediate: true })
    await $.command.register({ name: 'altimate-query', description: 'Run SQL through Altimate MCP without a model turn', argumentHint: '<connection> <SQL>' })
    await $.command.register({ name: 'altimate-mode', description: 'Route data work through Altimate using Claude', argumentHint: 'on|off|status' })
    await $.command.register({ name: 'altimate-workspace', description: 'Inspect or select an Altimate workspace', argumentHint: '[link <id>]' })
    await $.command.register({ name: 'altimate-remember', description: 'Explicitly save one project memory to Altimate', argumentHint: '<id> <text, max 2048 characters>' })
    return next(e)
  })

  on('command.run', { command: 'clear' }, ($, e, next) => {
    queries = []
    resetMode()
    redraw($)
    return next(e)
  })

  // session.start runs on plugin load, not on every conversation switch.
  on('session.end', ($, e, next) => {
    queries = []
    resetMode()
    redraw($)
    return next(e)
  })

  on('command.run', { command: 'altimate-data' }, async ($) => {
    const placement = await $.ui.open({ id: PANE, title: 'Altimate data', focus: true, closeOnEscape: true })
    return placement.isPlaced ? {} : { text: 'The data pane is unavailable here. SQL results remain in the conversation.' }
  })

  on('command.run', { command: 'altimate-query' }, async ($, e) => {
    const parts = e.args.trim().match(/^(\S+)\s+([\s\S]+)$/)
    if (!parts) return { text: 'Usage: /altimate-query <connection> <SQL>. Use the connection name from warehouse_list.' }
    const tools = await $.tool.list()
    if (!tools.some(tool => tool.name === SQL_TOOL)) {
      return { text: 'Altimate MCP is unavailable. Check /mcp and install an Altimate build with mcp serve. No query was run.' }
    }
    // $.tool.call retains Claude Code's permission check; $.mcp.call would bypass it.
    // The observer below also sees this call, so there is just one history entry.
    try {
      const answer = await $.tool.call({ tool: SQL_TOOL, warehouse: parts[1], query: parts[2] })
      return { text: resultText(answer) }
    } catch (error) {
      return { text: 'Query failed or was interrupted; it was not retried. Check the tool result and /mcp before running it again.\n' +
        (error instanceof Error ? error.message : String(error)) }
    }
  })

  on('tool.call', async ($, e, next) => {
    if (e.tool !== SQL_TOOL && !Object.hasOwn(WORKSPACE_QUERIES, e.tool)) return next(e)
    const query = begin(e)
    redraw($)
    try {
      const answer = await next(e)
      query.status = failed(answer) ? 'Refused or failed' : 'Completed'
      query.output = clip(resultText(answer))
      return answer
    } catch (error) {
      query.status = next.signal.aborted ? 'Interrupted' : 'Failed'
      query.output = clip(error instanceof Error ? error.message : String(error))
      throw error
    } finally {
      redraw($)
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    return Box({ flexDirection: 'column', children: [
      Text({ children: ['Recent SQL · session only · source permissions enforced by MCP'] }),
      Box({ flexDirection: 'row', children: [
        Button({ key: 'clear', label: 'Clear previews', onPress: () => { queries = []; redraw($) } }),
        Button({ key: 'close', label: 'Close', onPress: () => $.ui.close({ id: PANE }) }),
      ] }),
      ...(queries.length ? [...queries].reverse().flatMap(query => [
        Text({ children: [query.warehouse + ' · ' + query.status] }),
        Code({ source: query.sql, language: 'sql' }),
        Text({ children: [query.output || 'Waiting for the tool result…'] }),
      ]) : [Text({ children: ['Ask Claude a data question, or run /altimate-query <connection> <SQL>.\nThe latest 8 calls appear here, including backend checks and errors.'] })]),
    ] })
  })
}
