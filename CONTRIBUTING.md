# Contributing

## Running it locally

```bash
cp .env.example .env          # nothing is required in it to start
docker compose up -d --build
cd dashboard-ts && bun test
```

The fleet starts empty. Add a machine from the UI — the first one builds the
bridge image (about a minute), later ones take about a second.

## Layout

| Path | What it is |
|---|---|
| `dashboard-ts/src/app.ts` | Middleware, then one router per slice of the URL space |
| `dashboard-ts/src/providers/` | The only modules that talk to Docker |
| `dashboard-ts/src/mcp/` | Keys, the tool table, and who is doing what |
| `dashboard-ts/src/routes/mcp.ts` | The MCP endpoint itself |
| `bridge/` | cua-computer-server in VNC-backend mode |

## Things worth knowing before you change something

**Layout and image sources belong in the template, not in JS run after the
swap.** The wall lost its grid columns and its screenshots twice because both
were applied by JavaScript on `htmx:afterSwap`, which sometimes lost the race
with htmx's initial load. Both bugs only showed up on a real deployment.

**The provisioning shell runs as root; the desktop session runs as `cua`.**
Launching a GUI app over `/exec` leaves root-owned files in `/home/cua` and
that app then refuses to start for the desktop user. Finish provisioning with
`chown -R cua:cua /home/cua`. A headless CLI check will pass while the GUI
path is broken, so test the GUI path.

**A failed tool call is not a protocol error.** MCP draws this line
deliberately: a JSON-RPC error means the client is broken, `isError` on a
normal result means the call went wrong and the model on the other end should
read the message and try something else. Returning the second as the first is
how an agent gets stuck instead of correcting itself.

**A key names one machine and must never be able to name another.** The path
and the key are checked against each other in `routes/mcp.ts`. Removing that
check would not open a hole so much as make a misconfigured client silently
drive the wrong machine, which is worse.

**The advertised tool list and the handlers are one table.** `mcp/tools.ts`
holds both, because a tool advertised but not implemented — or implemented but
never advertised — is a bug you can only find from inside someone else's
client.

**Anything that mutates state must survive the CSRF guard.** See
[`SECURITY.md`](SECURITY.md). Send JSON, from the same origin.

## Pull requests

Keep them small, explain what you actually verified, and add a test when you
fix a bug. `bun test` must pass; CI runs it plus a typecheck and a container
build.
