# Dashboard design QA

final result: passed

## Artifacts and state

- Source visual truth: `docs/images/dashboard-reference.png`, the exact selected
  user attachment (1487 × 1058 pixels).
- Final implementation: `docs/images/dashboard-ssh.png`.
- Browser route: `http://127.0.0.1:7861/`.
- Full-view comparison: `.local/dashboard-build/comparison-final.png`.
- Focused form comparison: `.local/dashboard-build/form-comparison-final.png`.
- Mobile evidence: `.local/dashboard-build/mobile-dialog-normalized.png` and
  `.local/dashboard-build/mobile-dashboard-normalized.png`.
- State: Arabic RTL, Local/Pilot selected, SSH connection dialog open with a
  non-secret Build Server name draft. Actual saved hosts/tasks replace mock
  example rows; test hosts were disposed of before final capture.

## Viewport and normalization

The browser override 1190 × 846 maps to a measured DOM viewport of 1487 × 1057
on this desktop. The screenshot API returns a 1859 × 1321 canvas with additional
right/bottom overscan. Comparisons crop that overscan at 1:1 content pixels to
the 1487 × 1058 reference frame; the one-pixel height difference contains only
background. No application content is stretched or resampled. The temporary
viewport override was reset after testing.

## Comparison history

1. **Initial comparison — blocked.**
   Evidence: `comparison-iteration1.png` and `form-comparison-iteration1.png`
   under `.local/dashboard-build/`.
   - [P2] Default Arabic font leading and field spacing made the dialog 787px
     tall, starting at y135 instead of the source's approximately y207.
   - [P2] A 4:3 preview stage was taller than the source's approximately 45:31
     stage and pushed desktop actions lower.
   - [P2] A previous completed task was labeled as current Agent availability.
   Fixes: explicit Arabic line heights, 14px fields, source-aligned modal width
   and offset, compact helper layout, preview aspect ratio, and separate current
   availability versus prior task report/download.

2. **Post-fix comparison — blocked.**
   Evidence: `.local/dashboard-build/implementation-final.png` before the paired
   field fix; full/focused comparisons were inspected together with the source.
   - [P2] A sibling-label spacing rule placed the port field 21px below username.
   Fixes: reset spacing inside the paired row; retain the intended gap before
   the fingerprint field. Clear stale task notices when switching desktops.

3. **Final comparison — passed.**
   Evidence: the final full/focused comparisons listed above. Username and port
   inputs both start at y513.06. Preview bounds are x25–926.50, y162.99–784.02,
   closely matching the source's x26–926, y163–783. Dialog width is 568px at
   x367.76, with its extra passphrase affordance accounting for the small
   remaining height difference. No actionable P0/P1/P2 findings remain.

## Required fidelity surfaces

- **Fonts/typography:** locally bundled Noto Sans Arabic, readable Arabic
  hierarchy, consistent field sizes/line heights and deliberate LTR IP/key
  fields. The reference's mixed Arabic/Latin structure is preserved.
- **Spacing/layout:** right navigation rail, server tree, desktop preview,
  adjacent Agent panel and centered connection dialog match the selected
  composition. Paired fields align. At 390px CSS width, scrollWidth is also
  390px; dialog bounds are x17–373 and its footer ends at y760 within an 844px
  viewport. The dashboard scrolls vertically on small screens.
- **Colors/tokens:** midnight/navy surfaces, restrained cyan actions, muted
  supporting copy and green availability match the target hierarchy. Flat
  surfaces replace the mock's subtle illustrative lighting.
- **Images/assets:** the preview is a real native Driver frame, intentionally
  showing the actual Pilot session rather than a fabricated Firefox image.
  Frames use contain sizing so desktop controls are not cropped. Icons are
  licensed Tabler outline assets; no bespoke raster placeholders or drawn
  approximations replace the source's UI imagery.
- **Copy/content:** core Arabic labels and SSH fields match. The fingerprint
  remains required. Optional passphrase support, real previous task results,
  and entry points to existing management tools are functional additions.
  There are no invented connected Lab hosts or fake success states.

## Interaction and console verification

- New server form: choose a generated local test key, test real SSH/Docker,
  edit settings to invalidate saving, re-test, save and create a remote-owned
  Linux desktop through the browser UI.
- Wrong fingerprint rejected; credentials encrypted and omitted from responses.
- Final application-owned noVNC 1.7.0 client connected over SSH. Mouse opened
  Terminal; individual key events created `finalvnc`, whose existence was
  independently verified through the file download API.
- A real Codex-backed task started through the new Agent dialog completed on
  that SSH desktop and downloaded exact Arabic content (`نجاح`, 8 UTF-8 bytes).
- Main dashboard console contained no errors. After the final viewer path fix,
  the noVNC navigation contained no new console errors. Earlier diagnostic
  failures were corrected and the final viewer was re-tested.
- Existing fleet/Agent routes and new transport tests passed: 259 tests in
  total. TypeScript checking, JavaScript syntax checking and Docker build passed.
- Fixture desktops, saved SSH connections, SSH daemon and temporary fixture
  images were removed. Original Pilot and its home volume remain intact.

## Follow-up polish — P3 only

- Native file chooser text and glyphs vary with browser/OS; it remains a real,
  keyboard-accessible file input rather than an imitation of the mock control.
- Subtle mock lighting and exact generated font rasterization are approximated
  with ordinary product tokens. Current data and Dubai time intentionally differ
  from illustrative names/timestamps in the source.

## Implementation checklist

- [x] Selected visual target implemented in the existing application.
- [x] Primary SSH and Agent flows work with real transports.
- [x] Source and implementation opened in full/focused comparison images.
- [x] P0/P1/P2 findings fixed and captured again.
- [x] Mobile width/dialog checked; viewport override reset.
- [x] Test infrastructure cleaned up; original desktop preserved.
