#!/usr/bin/env python3
"""Exercise a packaged plugin's unchanged MCP registration, without a model."""
import argparse
import json
import os
from pathlib import Path
import queue
import sqlite3
import subprocess
import tempfile
import threading


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plugin", required=True, type=Path)
    args = parser.parse_args()
    plugin = args.plugin.resolve()
    source = Path(__file__).resolve().parents[1] / "plugins/altimate-code-experimental/.mcp.json"
    assert source.read_bytes() == (plugin / ".mcp.json").read_bytes(), "registration was modified in packaging"
    registration = json.loads((plugin / ".mcp.json").read_text())["mcpServers"]["altimate-code"]
    command = registration["command"].replace("${CLAUDE_PLUGIN_ROOT}", str(plugin))
    with tempfile.TemporaryDirectory(prefix="altimate-pilot-smoke-") as temp:
        root = Path(temp)
        database = root / "sales.sqlite"
        with sqlite3.connect(database) as db:
            db.executescript("CREATE TABLE sales(amount INTEGER); INSERT INTO sales VALUES (10), (20), (35);")
        env = {k: v for k, v in os.environ.items() if not k.startswith(("ALTIMATE_", "OPENCODE_", "XDG_"))}
        env.update({"PATH": "/usr/bin:/bin", "HOME": str(root), "USERPROFILE": str(root), "XDG_DATA_HOME": str(root / "data"),
                    "XDG_CONFIG_HOME": str(root / "config"), "XDG_CACHE_HOME": str(root / "cache"),
                    "XDG_STATE_HOME": str(root / "state"), "ALTIMATE_TELEMETRY_DISABLED": "1",
                    "ALTIMATE_CODE_CONN_demo": json.dumps({"type": "sqlite", "path": str(database)})})
        child = subprocess.Popen([command, *registration["args"]], cwd=root, env=env,
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        replies = queue.Queue()
        def consume():
            for line in child.stdout:
                try:
                    replies.put(json.loads(line))
                except json.JSONDecodeError:
                    replies.put({"unexpected_stdout": line})
        threading.Thread(target=consume, daemon=True).start()
        # Drain diagnostics without copying connection/query details into the report.
        threading.Thread(target=lambda: child.stderr.read(), daemon=True).start()
        counter = 0
        def rpc(method, params):
            nonlocal counter
            counter += 1
            child.stdin.write(json.dumps({"jsonrpc": "2.0", "id": counter, "method": method, "params": params}) + "\n")
            child.stdin.flush()
            while True:
                reply = replies.get(timeout=30)
                assert "unexpected_stdout" not in reply, "non-protocol stdout"
                if reply.get("id") == counter:
                    assert "error" not in reply, reply
                    return reply["result"]
        try:
            rpc("initialize", {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "pilot-install-smoke", "version": "1"}})
            child.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
            child.stdin.flush()
            tools = rpc("tools/list", {})["tools"]
            names = [tool["name"] for tool in tools]
            assert {"workspace_context", "workspace_skill", "workspace_execute", "sql_execute"}.issubset(names), names
            setup = rpc("tools/call", {"name": "workspace_context", "arguments": {}})
            status = json.loads(setup["content"][0]["text"])["status"]
            assert status == "needs_auth", status
            result = rpc("tools/call", {"name": "sql_execute", "arguments": {"warehouse": "demo", "query": "SELECT SUM(amount) AS total FROM sales"}})
            assert not result.get("isError"), result
            assert "65" in json.dumps(result), result
            denied = rpc("tools/call", {"name": "sql_execute", "arguments": {"warehouse": "demo", "query": "DELETE FROM sales"}})
            assert denied.get("isError"), denied
            with sqlite3.connect(database) as db:
                assert db.execute("SELECT COUNT(*), SUM(amount) FROM sales").fetchone() == (3, 65)
            assert [tool["name"] for tool in rpc("tools/list", {})["tools"]] == names
            print(json.dumps({"passed": True, "boundary": "packaged native binary over real MCP stdio and SQLite", "noCompatibleCliOnPath": True,
                              "registrationUnchanged": True, "workspaceStatus": status, "sum": 65, "writeRefused": True}))
        finally:
            child.stdin.close()
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()


if __name__ == "__main__":
    main()
