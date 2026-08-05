"""
Runs a single natural-language task against one desktop in the swarm.

Invoked as a subprocess by app.py so that each task gets a clean process
(the cua Agent/Computer SDKs are not designed to be reused concurrently
across unrelated tasks in the same interpreter).

Writes live progress directly to the shared SQLite DB after every agent
turn (current_action + running actions list), so the dashboard can show
"what it's doing right now" instead of just a final result.

Usage:
    python3 run_task.py <task_id> <bridge_host> <bridge_port> "<task description>"

Prints a single JSON line to stdout on success:
    {"final_text": "...", "actions": ["screenshot", ...], "cost_usd": 0.01}
"""

import asyncio
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

from computer import Computer
from cua_agent.agent import ComputerAgent

MODEL = os.environ["DESKSWARM_MODEL"]
API_BASE = os.environ.get("DESKSWARM_API_BASE") or None
API_KEY = os.environ.get("DESKSWARM_API_KEY") or None
MAX_RETRIES = int(os.environ.get("DESKSWARM_MAX_RETRIES", "1"))

DB_PATH = Path(os.environ.get("DESKSWARM_DB_PATH", str(Path(__file__).resolve().parent / "data" / "fleet.db")))


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def update_progress(task_id: int, current_action: str, actions: list) -> None:
    try:
        conn = sqlite3.connect(DB_PATH, timeout=5)
        conn.execute(
            "UPDATE tasks SET current_action = ?, actions = ?, updated_at = ? WHERE id = ?",
            (current_action, json.dumps(actions), now_iso(), task_id),
        )
        conn.commit()
        conn.close()
    except Exception:  # noqa: BLE001
        pass  # progress updates are best-effort; never let this crash the task


async def main(task_id: int, bridge_host: str, bridge_port: int, task: str) -> None:
    computer = Computer(
        os_type="linux",
        use_host_computer_server=True,
        api_host=bridge_host,
        api_port=bridge_port,
    )
    await computer.run()

    agent = ComputerAgent(
        model=MODEL,
        api_base=API_BASE,
        api_key=API_KEY,
        tools=[computer],
        max_retries=MAX_RETRIES,
    )

    final_text = None
    actions: list = []
    total_cost = 0.0

    async for chunk in agent.run(task):
        usage = chunk.get("usage")
        cost = usage.get("response_cost") if isinstance(usage, dict) else None
        if cost:
            total_cost += cost
        for item in chunk.get("output", []):
            item_type = item.get("type")
            if item_type == "message":
                content = item.get("content") or []
                if content and content[0].get("text"):
                    final_text = content[0]["text"]
                    update_progress(task_id, "responding", actions)
            elif item_type == "computer_call":
                action = item.get("action", {})
                action_type = action.get("type") or "action"
                actions.append(action_type)
                update_progress(task_id, action_type, actions)

    print(json.dumps({
        "final_text": final_text,
        "actions": actions,
        "cost_usd": round(total_cost, 6),
    }))


if __name__ == "__main__":
    task_id_arg = int(sys.argv[1])
    host_arg = sys.argv[2]
    port_arg = int(sys.argv[3])
    task_arg = sys.argv[4]
    asyncio.run(main(task_id_arg, host_arg, port_arg, task_arg))
