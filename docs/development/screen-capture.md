# Screen capture attachments

Settings → **Screen Capture** controls the global shortcut (default
Command–Shift–6 on macOS / Control–Shift–6 elsewhere) and maximum image dimension
(default 2048 pixels). Clear the shortcut to disable it. Cake must be running with
an open window; the shortcut works even while another application is active.

The shortcut freezes the display containing the pointer and opens a borderless
capture overlay. Its default **Crop** mode attaches the selected region immediately
on mouse release. **Annotate** mode draws arrows from their label position toward
the indicated point, then opens a text field beside the arrow. Enter commits a
label while that field is active. Switching back to Crop preserves all arrows and
labels, so a region can include any part of the annotations.

Outside a label field, **Enter** attaches the entire frozen display, including
annotations. **Escape** cancels without attaching anything, including while an
image is being flattened. Undo removes the most recent arrow. Controls and crop
guides never enter the exported image. The longest output edge is capped at the
configured size without enlarging smaller captures.

The destination is the focused primary Project Session or Cake Chat in the
current/last-focused Cake window. If no conversation is selected, the last active
conversation in that window is used. The destination is fixed at shortcut
activation, then checked again before appending. Resolved/deleted chats and drafts
already containing 20 attachments reject capture explicitly. Existing draft text
and attachments are preserved; capture never submits a message. If there is no
editable current or last chat, Cake asks the user to open one.

## Native permissions

On macOS, allow Cake under System Settings → Privacy & Security → Screen & System
Audio Recording (called Screen Recording on older versions), then restart if
required. Protected video and secure OS screens may remain unavailable. The
shortcut is configurable because Command–Shift–6 is also used for Touch Bar
screenshots on some Macs. Registration collisions produce a visible error without
unregistering the previously working shortcut.

## Ownership and lifetime

- `Electron` owns global shortcut registration and native capture/window access.
  `ScreenCaptureWindow` holds one transient frozen screenshot and overlay at a
  time. The caller's RPC interruption, overlay/owner closure, and application
  shutdown tear down the capture. No screenshot files or clipboard entries are
  created.
- `ScreenCaptureAttachmentStore` owns persisted window-local preferences and last
  destination, plus single-flight draft delivery. Configuration changes are
  serialized. Shortcut recording temporarily suspends its global registration.
- The overlay has a separate sandboxed renderer with only its editing Store and
  existing validated Electron RPC bridge. It does not hydrate another application
  Store tree or acquire a conversation. `ScreenCaptureOverlayStore` owns transient
  mode, annotations, and completion/cancellation; none are persisted.
- `CaptureCanvas` maps DOM gestures into original image pixels. The compositor
  flattens screenshot + annotations before cropping/resizing. Main validates PNG
  output and enforces the image-size and attachment payload bounds. Only the
  overlay's native sender can read or complete its capture.
- The result enters the authoritative existing `ComposerDraftStore`; Pi remains
  transcript authority when the user eventually submits that draft.

## Verification

`screen-capture.smoke.spec.ts` uses a synthetic native screen source while retaining
real hidden Electron windows, RPC, pointer/keyboard input, annotation rendering,
resizing, and Chat draft attachment. It does not capture the user's desktop, request
OS permissions, or focus native windows. Native service tests cover ownership,
concurrent activation, cancellation during acquisition, shutdown, shortcut
collisions, and Retina display selection. Renderer workflow tests cover last-chat
routing, destination changes/resolution, cancellation, failures/retry, and late
render cancellation.

Capture the settings surface with:

```sh
pnpm visual:capture screen-capture-settings --theme dark
```
