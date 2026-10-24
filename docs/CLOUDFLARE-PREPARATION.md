# Cloudflare services: offline preparation

The Cloudflare panel now saves a separate local preparation profile for Linux
Containers/Sandboxes, Browser Run, R2 artifacts, Tunnel/DNS, and Workers AI.
This is not an activated execution provider. Saving the profile
makes no Cloudflare API requests, changes no permissions, and creates no resources.
Existing Linux/Proxmox desktops and CLI credentials remain unchanged.

The profile records selected services, proposed resource names, maximum machines,
idle/session limits, artifact retention and prefix, and an optional AI model.
These are deployment preferences: the limits and retention are **not enforced**
on existing desktops or files. Linux remains the only allowed default until a
cloud runtime adapter is implemented and passes live validation.

## Server-side settings only

The profile stays on the application server. Configuration export and its download
endpoint have been removed at the user's request. No download or manual file
transfer is needed for the normal workflow. Proposed names are filled from the
existing Worker configuration for a fresh profile; saved custom values are preserved.
Names and limits remain editable inside the collapsed advanced section.

The repository contains `src/cloudflare/coordination-worker.js`, a standalone
Durable Object development prototype, and a local workerd/SQLite test. It is not
deployed, has no Containers/R2 bindings, and is not connected to the live runner.
Its requests require a separately supplied COMPUTE_SECRET. Live entitlement,
desktop compatibility, file persistence and cloud cancellation remain unverified.

## What Durable Objects add

The production gateway currently uses Durable Objects for stable device routing
and coordination metadata. SQLite on the Linux control plane remains authoritative
for agent ownership and tasks. The prototype prepares one session coordinator per
named device, with a time-limited lease and owner-checked release. Queues, progress
checkpoints, result references, and integration with the real agent runner remain
future work. Do not activate a second authority or replay a task after reconnect
without reconciling the Linux lease and completed actions first.

## What artifacts add

Artifacts are the actual files saved by a task: reports, images, source code and
other outputs. The downloaded run archive now includes `manifest.json` listing
saved file archive paths, byte lengths and SHA-256 digests. Non-completed runs are
marked partial. This supports checking downloaded files and preparing later R2
archiving; it does not provide a cryptographic signature or upload any data.

The intended split is large file bytes in R2, small status/ownership/result
references in a Durable Object, and model credentials outside execution sandboxes.
A Durable Object alone cannot preserve a Linux container's disk or running process.
R2 upload/download, backup/restore, access rules, retention enforcement and a cloud
execution provider still need implementation and live tests before activation.

## Activation and rollback

Review account plan, enabled services, limits and costs. Grant only the selected
service permissions and test each capability explicitly. Build and test the Linux
image with Driver, desktop preview, Arabic input, files, Stop/Takeover and results;
then connect it as a machine provider. Test R2 upload and restore before enabling
any retention deletion. No permission changes or paid resources are part of this
preparation release.

To discard the preparation, deselect the optional services and save. The profile
is local; existing deployment settings, tokens and devices are separate. The
`cloudflare_preparation` table and run manifest are additive, so prior application
versions can ignore them.

Local validation: `bun test`, TypeScript check, and
`bun scripts/test-cloudflare-preparation.mjs` in a Linux environment with the
matching workerd dependency. The latter requires no Cloudflare credentials.
