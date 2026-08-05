"""
Runs a single natural-language task against one desktop in the swarm.

Invoked as a subprocess by app.py so that each task gets a clean process
(the cua Agent/Computer SDKs are not designed to be reused concurrently
across unrelated tasks in the same interpreter).

Usage:
    python3 run_task.py <bridge_host> <bridge_port> "<task description>"

Prints a single JSON line to stdout on success:
    {"final_text": "...", "actions": ["screenshot", ...], "cost_usd": 0.01}
"""

import asyncio
import json
import os
import sys

from computer import Computer
from cua_agent.agent import ComputerAgent

MODEL = os.environ["DESKSWARM_MODEL"]
API_BASE = os.environ.get("DESKSWARM_API_BASE") or None
API_KEY = os.environ.get("DESKSWARM_API_KEY") or None
MAX_RETRIES = int(os.environ.get("DESKSWARM_MAX_RETRIES", "1"))


async def main(bridge_host: str, bridge_port: int, task: str) -> None:
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
    actions = []
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
            elif item_type == "computer_call":
                action = item.get("action", {})
                actions.append(action.get("type"))

    print(json.dumps({
        "final_text": final_text,
        "actions": actions,
        "cost_usd": round(total_cost, 6),
    }))


if __name__ == "__main__":
    host_arg = sys.argv[1]
    port_arg = int(sys.argv[2])
    task_arg = sys.argv[3]
    asyncio.run(main(host_arg, port_arg, task_arg))
