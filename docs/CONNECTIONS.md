# Connections and NetBird

Open **Settings → مركز الاتصالات وNetBird** (`/settings/connections`), or the
**NetBird والأجهزة الشبكية** link below the server tree. All screens and APIs use
the existing dashboard login and cross-site request protections.

## NetBird Cloud or self-hosted

1. Enter the management HTTPS URL (default `https://api.netbird.io`) and a
   **Personal Access Token** allowed to read peers. A service-user PAT is useful
   for a durable integration. This is not a NetBird Setup Key.
2. Test, then save the exact tested configuration. The five-minute save ticket
   is single-use. The PAT is encrypted with the existing AES-256-GCM master key
   beside the database and is never returned by the API or stored in audit text.
3. Use **مزامنة الأجهزة** to refresh. The backend calls `GET /api/peers` with
   `Authorization: Token <PAT>`. Self-hosted URLs ending in `/api` are supported.
   HTTPS certificate checks remain enabled and redirects are refused so the PAT
   cannot be forwarded to another hostname. Responses are size/count bounded.
4. Search or filter all peers, offline peers, unconfigured peers, or SSH-linked
   peers. Offline devices remain visible, including devices not ready for
   DeskSwarm. A failed sync keeps the previous inventory and displays a stale-data
   message; it does not fabricate an offline status for every device.

**Network state and application readiness are separate.** `connected` and
`last_seen` come from the last NetBird sync. `readiness=configured` means an SSH
server record exists with the same overlay IP or DNS name. It does not guarantee
Docker is responding now: the UI also shows the last SSH/Docker test status/time,
and linked hosts have a test button. Peer records never become runnable desktops
merely because the VPN reports them online.

For an unconfigured Linux peer with a valid IP, **تجهيز ربط SSH** opens the existing
server form with its name and overlay IP. Saved SSH username/port defaults are
filled in. The SSH private key and trusted host fingerprint are still required;
existing SSH test-before-save and fingerprint pinning remain in force. An offline
peer can be prepared this way and tested after it reconnects. Non-Linux or
address-less peers remain visible without a Linux setup action.

The NetBird API connection reads inventory. It does not join the dashboard to the
VPN, install NetBird, change network policy, create Setup Keys or bypass SSH
permissions. NetBird must run on the Linux execution service and peers, with a
policy allowing that service to reach SSH/Docker hosts. A machine that has never
registered with NetBird cannot be discovered in its API; once registered it can
appear as offline or unconfigured until the rest of its setup is complete.

Saved tokens can be reused for tests/sync without re-entry. They are only reused
for the exact stored management URL; changing the URL requires a fresh PAT.
Re-test and save to rotate a PAT or switch the connected NetBird account. The old
inventory is preserved if the replacement account cannot be read.

## Shared defaults and discovery

- Save a default SSH username and port in the connections screen. They apply to
  both ordinary new-server setup and NetBird-assisted setup; each server remains
  individually editable before testing.
- The overview links Cloudflare, Tunnel deployment and SSH hosts in one place.
- Cloudflare can discover accounts from a token (where account-list permission is
  available), list active domains, and discover running DeskSwarm dashboard
  containers on Local Docker or a pinned SSH host.
- Cloudflare's **Tunnel wizard** can create DNS, run the connector and deploy the
  Worker/DO gateway in one tracked operation. See [Cloudflare](CLOUDFLARE.md).

## Validation

On 2026-10-24: 290 application tests passed, with TypeScript and production Docker
build validation. New tests exercise PAT encryption/redaction, authentication and
CSRF, stale inventory, offline devices, host matching, shared defaults, changed
save tickets and an actual local HTTP peer-service fixture carrying Arabic names.
Provider fixture tests do not represent a real NetBird account connection.

An isolated browser fixture (separate container/database and `localhost` cookies,
no production data and no real PAT) displayed synthetic online/offline/macOS
peers. The offline filter was tested, SSH defaults were saved, and selecting the
offline Linux peer opened the SSH form with its overlay IP and saved port 2222.
[Inventory test screenshot](images/netbird-inventory-test.png) is explicitly
labelled synthetic data. The fixture and its container were removed after testing.
No user NetBird account was synchronized: a real PAT is still needed in Settings.

## API

All responses use `{ok,data,error}`. Credentials are omitted from status/audit.

- `GET /api/v1/connections/status`: public service summaries and SSH defaults.
- `POST /api/v1/connections/preferences`: `{ssh_user,ssh_port}`.
- `GET /api/v1/netbird/peers`: cached peers, freshness/error and SSH mapping.
- `POST /api/v1/netbird/test`: `{base_url,token}` → five-minute test ticket/count.
- `POST /api/v1/netbird/connection`: same fields plus `test_token` → encrypted save.
- `POST /api/v1/netbird/sync`: `{}` → refresh using saved PAT.

References: [NetBird API authentication](https://docs.netbird.io/api/guides/authentication),
[peer API](https://docs.netbird.io/api/resources/peers).

## Unified workspace below the device preview

Sidebar Agents, Servers/Connections and Settings, as well as Cloudflare/NetBird
links, open tabs **under the existing device preview**. The top bar, server tree
and selected device stay in the application shell. Bookmarks to `/agents`,
`/manage`, `/settings/cloudflare` and `/settings/connections` return that same shell
with their initial tab, without an HTTP redirect. Internal links update the panel
rather than navigating the outer page.

The application lazily embeds its own authenticated views (`?embedded=1`) in
same-origin frames so existing view scripts/styles stay isolated and draft forms
survive tab switches. Only allowlisted first-party routes are accepted; frame
messages must match both the application origin and the known frame window.
Inactive view polling pauses. The preview and sidebar stay sticky while long
panels scroll, and a collapse control restores the full preview. Keyboard tab
navigation is supported. English legacy views retain their labels while sharing
the same navy/cyan palette and locally hosted Arabic font. Advanced management
now uses local pinned htmx and generated Tailwind CSS instead of external CDNs.

Browser validation covered all four tabs with an unchanged outer URL, Cloudflare
service discovery inside its tab, persistence of an Agent task draft while
switching views (cleared after testing; no Agent was started), and an embedded
synthetic offline NetBird peer opening the parent SSH form with port 2222 without
navigation. Mobile layout at 390 CSS pixels had no horizontal overflow. The final
application screenshot is `images/unified-workspace.png`.
