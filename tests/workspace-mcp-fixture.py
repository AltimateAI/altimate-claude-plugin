#!/usr/bin/env python3
"""Synthetic MCP protocol fixture for routing, never a workspace backend test."""
import json
import sys

log = open(sys.argv[1], "a")
tools = [
    {"name": "workspace_context", "description": "Read the current workspace's context", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "workspace_ask_knowledge_base", "description": "Answer company convention questions from the linked workspace's knowledge", "inputSchema": {"type": "object", "properties": {"question": {"type": "string"}}, "required": ["question"]}},
    {"name": "sql_execute", "description": "Run local SQL; not needed for knowledge questions", "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}}}},
]
for line in sys.stdin:
    request = json.loads(line)
    if "id" not in request:
        continue
    method = request["method"]
    if method == "initialize":
        result = {"protocolVersion": request["params"]["protocolVersion"], "capabilities": {"tools": {}}, "serverInfo": {"name": "synthetic-workspace", "version": "1"}}
    elif method == "tools/list":
        result = {"tools": tools}
    elif method == "tools/call":
        name = request["params"]["name"]
        log.write(json.dumps({"name": name}) + "\n")
        log.flush()
        if name == "workspace_context":
            text = json.dumps({"workspace": {"id": 35, "name": "Synthetic analytics", "token": "a" * 64}, "summary": "Company conventions are available through workspace_ask_knowledge_base.", "skills": [], "memory": {"status": "loaded", "memories": []}})
        elif name == "workspace_ask_knowledge_base":
            text = "Workspace convention: use booked ARR for recurring revenue, excluding professional services. Source: synthetic revenue policy."
        else:
            text = "No SQL database in this knowledge-routing fixture."
        result = {"content": [{"type": "text", "text": text}], "isError": name == "sql_execute"}
    elif method == "ping":
        result = {}
    else:
        print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "error": {"code": -32601, "message": "Unsupported fixture method"}}), flush=True)
        continue
    print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)
