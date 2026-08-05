# deskswarm

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Docker Compose](https://img.shields.io/badge/deploy-docker%20compose-2496ED?logo=docker&logoColor=white)](docker-compose.yml)
[![Built on cua](https://img.shields.io/badge/built%20on-cua-orange)](https://github.com/trycua/cua)
[![Upstream bug filed](https://img.shields.io/badge/upstream%20bug-trycua%2Fcua%20%232869-red)](https://github.com/trycua/cua/issues/2869)

**Self-hosted fleet of AI-controlled desktops, with a dashboard to dispatch
tasks and see what's happening.**

deskswarm spins up N full Linux desktops (real XFCE sessions, not headless
browsers) in Docker, wires each one up to an AI computer-use agent, and gives
you a single dashboard to send natural-language tasks to one desktop — or the
whole fleet in parallel — and watch the results, costs, and history.

Built on top of [cua](https://github.com/trycua/cua) (Apache-2.0), the
open-source computer-use SDK. deskswarm is the orchestration + fleet
management + dashboard layer on top.

<p align="center">
  <img src="docs/screenshots/dashboard.png" alt="deskswarm dashboard — fleet status, task launcher, task log with cost per run" width="820">
</p>

<p align="center">
  <sub>Fleet status, a task launcher, and a live task log/report — all in one page.</sub>
</p>

```
┌─────────────┐      ┌─────────────┐      ┌─────────────┐
│  desktop-1  │◄────►│  bridge-1   │◄─┐   │             │
│  (XFCE/VNC) │      │ (REST↔VNC)  │  │   │             │
└─────────────┘      └─────────────┘  │   │             │
┌─────────────┐      ┌─────────────┐  ├──►│  dashboard  │◄── you
│  desktop-2  │◄────►│  bridge-2   │◄─┤   │ (Flask/HTMX)│
└─────────────┘      └─────────────┘  │   │             │
┌─────────────┐      ┌─────────────┐  │   │             │
│  desktop-3  │◄────►│  bridge-3   │◄─┘   │             │
└─────────────┘      └─────────────┘      └─────────────┘
```

Each `desktop-N` is a full XFCE session — the agent doesn't just see a
browser viewport, it sees (and can click, type into, and screenshot) an
entire Linux desktop:

<p align="center">
  <img src="docs/screenshots/live-desktop.png" alt="A real desktop controlled by the agent — Firefox open on a Google search" width="700">
</p>

<p align="center">
  <sub>What "watch live" actually shows — the agent driving a real Firefox session, not a scripted mock.</sub>
</p>

## Why

Most "AI browser agent" tools give the model a browser tab. deskswarm gives
it a **whole desktop** — any app, not just a browser — and lets you run
**several of them in parallel**, from one place, with a real task history
instead of a chat log you have to scroll through.

Good fits:
- Fanning the same task out across N desktops for throughput or comparison
- Anything that needs a real desktop app, not just a browser (file managers,
  PDF viewers, office tools, legacy GUI-only software)
- A cheap way to try computer-use agents without committing to a cloud
  provider's hosted sandbox

## Quickstart

Requires Docker and Docker Compose.

```bash
git clone https://github.com/ahmedvnabil/deskswarm.git
cd deskswarm
cp .env.example .env
# edit .env — at minimum set DESKSWARM_MODEL / DESKSWARM_API_KEY
docker compose up -d --build
```

Open `http://localhost:7861`. You should see 3 desktops (green = healthy),
a task box, and an empty task log. Send a task, watch it complete, click
"watch live" on any desktop to see it work in real time over noVNC.

## Configuring a model

deskswarm uses [cua](https://github.com/trycua/cua)'s Agent SDK, which is
built on LiteLLM — so `DESKSWARM_MODEL` accepts any LiteLLM model string.
`.env.example` documents four setups:

- **Anthropic API key** (recommended — most reliably tested path)
- **OpenAI API key**
- **Any OpenAI-compatible proxy** (LiteLLM proxy, internal gateway, etc.)
- **Local Ollama** (experimental, see below)

### Local models (experimental)

Running fully local is possible but not the default, because cua's generic
vision-model loop pulls in `qwen-agent` → `torch` (multi-GB) for tool-call
prompt formatting. If you want it:

```bash
# inside dashboard/Dockerfile, add:
RUN pip install --no-cache-dir "cua-agent[qwen]" torch
```

Then set `DESKSWARM_MODEL=ollama_chat/qwen3.5:9b` (or another
vision+tool-calling capable model) and `DESKSWARM_API_BASE` to your Ollama
host. Models without both vision and tool-calling support will fail or
silently misbehave — check `cua_agent/loops/model_types.csv` in the installed
package for what's natively supported.

## Scaling the fleet

The default `docker-compose.yml` ships 3 desktop+bridge pairs. To add more:

1. Duplicate a `desktop-N` / `bridge-N` block in `docker-compose.yml`,
   incrementing the number and picking a free host port for
   `DESKTOP_N_NOVNC_PORT`.
2. Add the matching entry to `FLEET_JSON` in `.env`
   (`bridge_host` = the new bridge service name).
3. `docker compose up -d --build`.

## API

See [`docs/APIs.md`](docs/APIs.md) — `GET /api/v1/fleet`,
`GET /api/v1/tasks`, `POST /api/v1/tasks`, optional bearer-token auth.

## Known issues

`cua-computer-server`'s VNC backend has two upstream bugs that will silently
break screenshots (agent reports a "black screen" that isn't real) if you're
integrating cua yourself outside this repo. deskswarm works around both —
full writeup in [`docs/UPSTREAM_CUA_BUG.md`](docs/UPSTREAM_CUA_BUG.md).

## Security

- No auth by default on read endpoints; set `DASHBOARD_TOKEN` to require a
  bearer token on task creation.
- No TLS, no rate limiting. Don't expose this directly to the internet —
  put it behind a reverse proxy on a trusted network or VPN.
- Task descriptions are executed by an AI agent with real desktop control
  (mouse, keyboard, any installed app). Don't give it tasks involving
  credentials or payment details, and don't expose the dashboard to anyone
  you wouldn't trust to run arbitrary commands on a sandboxed machine.

## Architecture notes

- **desktop-N**: [`trycua/xfce-cua`](https://hub.docker.com/r/trycua/xfce-cua) — a real XFCE session over VNC/noVNC.
- **bridge-N**: `cua-computer-server` in VNC-backend mode, translating REST/WS calls into VNC input events + screenshots. See `bridge/`.
- **dashboard**: Flask + HTMX + SQLite. Each task runs as an isolated subprocess (`dashboard/run_task.py`) using cua's `Computer` + `ComputerAgent` SDKs, so unrelated tasks never share agent state.

## Credits

Built on [cua](https://github.com/trycua/cua) by the Cua team — deskswarm
wouldn't exist without their open-source computer-use SDK.

## License

MIT — see [`LICENSE`](LICENSE).
