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
