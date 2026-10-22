#!/usr/bin/env python3
"""Synthetic, local-only Claude Code mod comparison. Requires Claude authentication.

Example: python3 tests/mod-smoke.py --server-command '["altimate-code","mcp","serve"]' --output /tmp/mod-results.json
The server command must accept --connections, --integrations local and --pure.
Uses existing Claude credentials; model runs consume plan/API usage.
"""
import argparse
import concurrent.futures
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import time


def invoke(root, plugin, config, prompt, model, direct=False):
    command = [CLAUDE, "-p", prompt, "--model", model, "--effort", "medium",
               "--setting-sources", "", "--settings", str(root / "settings.json"),
               "--strict-mcp-config", "--mcp-config", str(config),
               "--permission-mode", "dontAsk", "--no-session-persistence",
               "--output-format", "stream-json", "--verbose"]
    allowed = ["Bash", "Read", "mcp__plugin_altimate-code_altimate-code__*"]
    command += ["--allowedTools", *allowed]
    if plugin:
        command += ["--plugin-dir", str(plugin)]
    start = time.monotonic()
    # Keep the experiment out of the parent's Claude session, if run from Claude.
    env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}
    response = subprocess.run(command, cwd=root, env=env, stdin=subprocess.DEVNULL,
                              capture_output=True, text=True, timeout=180)
    elapsed = time.monotonic() - start
    events = [json.loads(line) for line in response.stdout.splitlines() if line.startswith("{")]
    results = [event for event in events if event.get("type") == "result"]
    if response.returncode or not results:
        raise RuntimeError(f"Claude failed ({response.returncode}): {response.stderr[-1000:]} {response.stdout[-1000:]}")
    result = results[-1]
    if result.get("is_error"):
        raise RuntimeError(result.get("result", "Claude returned an error"))
    calls = [part["name"] for event in events if event.get("type") == "assistant"
             for part in event.get("message", {}).get("content", []) if part.get("type") == "tool_use"]
    usage = result.get("usage", {})
    return {
        "answer": result.get("result", ""), "cost_usd": result.get("total_cost_usd", 0),
        "input_tokens": usage.get("input_tokens", 0),
        "cache_read_input_tokens": usage.get("cache_read_input_tokens", 0),
        "cache_creation_input_tokens": usage.get("cache_creation_input_tokens", 0),
        "output_tokens": usage.get("output_tokens", 0),
        "turns": result.get("num_turns", 0), "model_usage": result.get("modelUsage", {}),
        "wall_seconds": round(elapsed, 3), "tool_calls": calls,
        "altimate_tool_calls": sum(name.startswith("mcp__plugin_altimate-code_altimate-code__") for name in calls),
        "direct_command": direct,
        "loaded_plugins": [event.get("plugins") for event in events if event.get("subtype") == "init"],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server-command", required=True, help="JSON argv array; never evaluated by a shell")
    parser.add_argument("--claude-bin", default="claude", help="Exact Claude binary to test")
    parser.add_argument("--model", default="sonnet")
    parser.add_argument("--trials", type=int, default=3)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--smoke-only", action="store_true")
    args = parser.parse_args()
    global CLAUDE
    CLAUDE = args.claude_bin
    server = json.loads(args.server_command)
    if not isinstance(server, list) or not server or not all(isinstance(x, str) for x in server):
        parser.error("--server-command must be a nonempty JSON array of strings")
    source = Path(__file__).resolve().parents[1] / "plugins" / "altimate-code"
    report = {"claude_version": subprocess.check_output([CLAUDE, "--version"], text=True).strip(),
              "model": args.model, "trials": args.trials, "runs": []}
    with tempfile.TemporaryDirectory(prefix="altimate-mod-check-") as tmp:
        root = Path(tmp)
        db = sqlite3.connect(root / "orders.sqlite")
        db.execute("CREATE TABLE orders(id INTEGER PRIMARY KEY, region TEXT, status TEXT, amount INTEGER)")
        db.executemany("INSERT INTO orders VALUES (?,?,?,?)", [
            (i, "east" if i % 2 else "west", "paid" if i % 3 else "cancelled", i * 10) for i in range(1, 61)])
        db.commit()
        expected = db.execute("SELECT COUNT(*), SUM(amount) FROM orders WHERE status='paid'").fetchone()
        root.joinpath("connections.json").write_text(json.dumps({"demo": {"type": "sqlite", "path": str(root / "orders.sqlite")}}))
        root.joinpath("settings.json").write_text(json.dumps({"enabledPlugins": {}, "disableAllHooks": False}))
        root.joinpath("empty-mcp.json").write_text('{"mcpServers":{}}')
        root.joinpath("mcp.json").write_text(json.dumps({"mcpServers": {
            "plugin:altimate-code:altimate-code": {"command": server[0], "args": server[1:] + [
                "--connections", str(root / "connections.json"), "--integrations", "local", "--pure"]}}}))
        for name in ["mcp", "mod"]:
            plugin = root / name
            shutil.copytree(source, plugin)
            # Strict config deliberately includes only our synthetic server; no ambient MCPs.
            plugin.joinpath(".mcp.json").unlink()
            if name == "mcp":
                hooks = json.loads(plugin.joinpath("hooks/hooks.json").read_text())
                hooks.pop("modules", None)
                plugin.joinpath("hooks/hooks.json").write_text(json.dumps(hooks))
        direct = invoke(root, root / "mod", root / "mcp.json",
                        "/altimate-query demo SELECT COUNT(*) AS n, SUM(amount) AS total FROM orders WHERE status='paid'", args.model, True)
        assert f"{expected[0]} | {expected[1]}" in direct["answer"], direct
        assert direct["turns"] == 0 and direct["cost_usd"] == 0, direct
        report["direct_query"] = direct
        denied = invoke(root, root / "mod", root / "mcp.json", "/altimate-query demo DELETE FROM orders", args.model, True)
        assert db.execute("SELECT COUNT(*) FROM orders").fetchone()[0] == 60
        assert "denied" in denied["answer"].lower() or "read-only" in denied["answer"].lower(), denied
        report["write_refusal"] = denied
        missing = invoke(root, root / "mod", root / "empty-mcp.json", "/altimate-query demo SELECT 1", args.model, True)
        assert "No query was run" in missing["answer"], missing
        report["missing_server"] = missing
        if not args.smoke_only:
            tasks = [
                ("paid_totals", "How many paid orders are there and what is their total amount?", "40|12000"),
                ("largest_paid", "Give the id and amount of the largest paid order.", "59|590"),
            ]
            jobs = []
            for trial in range(args.trials):
                # Rotate order so one arm does not always run first.
                for arm in (["plain", "mcp", "mod"][trial % 3:] + ["plain", "mcp", "mod"][:trial % 3]):
                    for task, question, expected_answer in tasks:
                        jobs.append((arm, trial, task, question, expected_answer))

            def run(job):
                arm, trial, task, question, expected_answer = job
                prompt = (f"The data is in the local SQLite file {root / 'orders.sqlite'}, table orders "
                          "(id, region, status, amount). Connection demo also points to this file if tools are available. "
                          f"{question} Reply with just the two requested numbers separated by | and no commas.")
                result = invoke(root, root / arm if arm != "plain" else None,
                                root / "mcp.json" if arm != "plain" else root / "empty-mcp.json", prompt, args.model)
                result.update(arm=arm, trial=trial, task=task,
                              correct=result["answer"].strip().replace(" ", "") == expected_answer)
                print(json.dumps({k: result[k] for k in ["arm", "trial", "task", "correct", "cost_usd", "wall_seconds"]}), flush=True)
                return result

            with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
                report["runs"] = list(pool.map(run, jobs))
        db.close()
        args.output.write_text(json.dumps(report, indent=2) + "\n")
        print(f"Verified synthetic workflow; report: {args.output}")


if __name__ == "__main__":
    main()
