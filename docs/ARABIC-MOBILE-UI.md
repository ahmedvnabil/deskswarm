# Arabic interface and compact phone layouts

The application templates use Arabic and RTL, including sign-in, fleet state labels,
files, model setup, access keys, activity, audit and backup views. Provider names,
API protocol identifiers, shell commands, machine names and user/task content are
preserved. Technical errors returned by external providers can retain their original language.

Fleet polling keeps image elements through htmx `hx-preserve`, with stable device
IDs. New frames preload separately; a failed load leaves the previous frame in
place. Stale completions cannot overwrite a newer requested frame. Sleeping or
unavailable devices still render their own state instead of a stale image.

Phone layouts stack model status rows, wrap actions/tabs, shorten the server tree,
and constrain wide operational tables to scroll inside their own region.

Validation: full Bun suite, TypeScript, inline script parsing; browser viewport
checks at requested 390×844 and 320×740 (the embedded browser reported effective
content widths 354 and 291). Task entry was exercised without submitting a paid
run. Connections tables stayed within the page. A 17px Cloudflare overflow at
the smaller width was found and corrected. Three fleet images were loaded across
successive frame tokens during live polling. These checks emulate phone-sized
browser viewports; they are not physical iOS/Android device tests.

## Mobile device drawer

At widths up to 720px, the server tree moves into a native modal dialog opened
by the top-bar Devices button. Choosing a device closes it; Escape, the close
button and backdrop also dismiss it. The native dialog contains keyboard focus
and makes the background inert. Crossing back to desktop closes the dialog and
returns the same server tree to its original position, preserving search/group
state. The mobile workspace preview is 72px tall while a panel is open; ordinary
desktop viewing retains its larger preview.

Live validation: device selection auto-close, explicit close, Escape, desktop
restoration, no page overflow at effective widths 354px and 291px, and 72px
preview measured in Agents and Cloudflare. Full automated suite: 326 passed;
TypeScript and dashboard JavaScript syntax checks passed.

## Inline desktop session

The main Open screen action mounts the noVNC session inside the current workspace.
A Return to preview button disconnects the frame. Opening a settings/Agents panel,
changing the selected computer, or changing agent ownership removes the old frame
source. Agent-owned sessions request view-only mode. The backend's existing
ownership controls remain authoritative.

Agents and embedded fleet-management actions request the same inline view through
the first-party panel bridge. Messages require the same origin and a registered
panel window; computer IDs are resolved against the server inventory before opening.
Live validation confirmed an encrypted noVNC connection, the Agents action, return
to preview, and source removal on selecting a different device. No task was run and
no desktop files were changed for this check. Full suite: 326 passed.
