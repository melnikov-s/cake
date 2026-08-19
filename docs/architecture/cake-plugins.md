# Cake plugins and customization

Cake plugins are trusted, user-owned software. A plugin may have a React
renderer, an unrestricted Node backend, an optional whole-application scene, or
any combination. Cake owns discovery,
typechecking and bundling, process lifecycle, health-gated activation,
persistence, and immutable recovery.

The renderer and backend are deliberately separate. Renderer code runs in
Cake's sandboxed renderer and composes the UI. Backend code runs in its own
Electron utility process with normal Node capabilities: filesystem reads and
writes, Git and other subprocesses, and network access. This is process
isolation for application reliability, not a permission sandbox. Installing or
enabling a plugin is therefore equivalent to trusting local executable code.

## Source layout and manifest

The default root is `~/.cake` or the absolute `CAKE_HOME` override:

```text
plugins/<plugin-id>/
  cake-plugin.json
  renderer.tsx                  # optional; any relative path is valid
  backend.ts                    # optional; any relative path is valid
  scene.tsx                     # optional whole-application replacement
  skills/<skill>/SKILL.md       # optional embedded-Pi resource
  prompts/*                     # optional embedded-Pi resources
  pi-extensions/*               # optional embedded-Pi resources
  styles/*                      # optional renderer source
  assets/*                      # optional renderer source
recovery/
  builds/<sha256>/              # renderer plus compiled plugin backends
  sources/<sha256>/             # exact regular source files for repair
  history/*.json                # request/base/result/diagnostic provenance
  customization-state.json      # activation journal
state/plugin-state/             # versioned namespaced JSON persistence
```

`cake-plugin.json` is strict version 2 metadata. The directory name and `id`
must match. At least one of `renderer`, `backend`, and `scene` is required.

```json
{
  "schemaVersion": 2,
  "id": "acme.calendar",
  "name": "Acme Calendar",
  "renderer": "renderer.tsx",
  "backend": "backend.ts",
  "scene": "scene.tsx",
  "activeScene": false,
  "enabled": true
}
```

## Renderer plugins and slots

Every enabled renderer entry is imported automatically. A scene never needs to
know which plugins are installed. The entry calls `definePlugin` and declares
slot contributions, reusable components, and optional commands:

```tsx
import { Button, definePlugin, usePluginBackend, usePluginSession } from "cake";

function BranchButton() {
  const backend = usePluginBackend("acme.calendar");
  const session = usePluginSession();
  return (
    <Button
      onClick={() => void backend.call("currentBranch", { workspacePath: session.workspacePath })}
    >
      Branch
    </Button>
  );
}

export default definePlugin({
  id: "acme.calendar",
  contributions: { BranchButton },
  slots: {
    "project-session.header.actions": [{ id: "branch", component: BranchButton, order: 20 }],
  },
  commands: {
    open: {
      description: "Open the calendar",
      run(args, context) {
        context.reveal("acme.calendar.main", { query: args });
      },
    },
  },
});
```

Canonical slots are stable semantic outlets rather than coordinates:

- `global.sidebar.header`
- `global.sidebar.footer`
- `project-session.header.actions`
- `project-session.left.top`
- `project-session.left.middle`
- `project-session.left.bottom`
- `project-session.right.top`
- `project-session.right.middle`
- `project-session.right.bottom`
- `project-session.transcript.after`
- `project-session.composer.before`
- `project-session.composer.actions`
- `project-session.status`

The namespace is the ownership boundary. `global.*` outlets belong to
application chrome and remain visible across Cake Chat, project sessions, and
settings. `project-session.*` outlets exist only inside a selected project
session. `project-session.header.actions` is specifically the toolbar/menu row.
The six left/right rail outlets are persistent normal-flow panels: each side
has top, middle, and bottom placement, reserves space beside the conversation,
and stacks rather than overlaps when multiple plugins contribute. “Top right
of the session” means `project-session.right.top`. Global plugins use the
global sidebar outlets instead.

Header outlets are compact action rows with a fixed height. Contributions may
render a button, badge, or other compact trigger there. Expanded content must
open as a popover, dialog, or overlay anchored to that trigger; it must not grow
the header row or displace Cake-owned controls.

Rail contributions fill the host-controlled inspector width. Empty rails
collapse. Rails remain beside the conversation at ordinary desktop sizes; only
genuinely compact session canvases move occupied rails below the conversation,
so a plugin never pushes the opening transcript and composer off screen.
Plugins must remain responsive within the provided width and must not use
absolute or fixed positioning for structural panel layout.

Intentional overlap is explicit. The public `Popover`, `PopoverTrigger`, and
`PopoverContent` components render a compact trigger in normal flow and portal
the open surface into Cake's overlay layer with viewport collision handling,
outside-click dismissal, Escape handling, and focus restoration. Use a Popover
for temporary anchored UI; do not turn a persistent rail contribution into an
overlay with plugin-owned positioning.

Contributions are ordered by numeric `order`, plugin ID, then contribution ID.
Each contribution has its own error boundary. Settings reports a contributed
slot that is absent from a custom scene or mounted more than once.

Renderer source may import only `cake`, React and its JSX runtimes, React DOM,
Zod, and relative files inside that plugin. It has no Node or Electron globals.
That constraint protects Cake's renderer boundary; it does not limit the
plugin's backend.

## Replaceable scenes

Scene replacement is an optional plugin capability, not a standalone global
file. At most one enabled plugin has `activeScene: true`. Cake renders that
plugin's scene default export under the immutable providers and health boundary.
When no plugin scene is active, Cake renders its core `DefaultScene` directly.

The stock scene is:

```tsx
import { DefaultScene } from "cake";

export default function Scene() {
  return <DefaultScene />;
}
```

`DefaultScene` mounts every canonical slot. A custom scene may render
`DefaultScene`, build an entirely different React tree, and/or place outlets
with `<Slot name="project-session.header.actions" />`. Keeping the same slot names lets
ordinary plugins continue working in a fully custom scene. Immutable recovery
is outside the replaceable scene and never evaluates user code.

## Unrestricted backends

A backend exports `definePluginBackend(...)` from `cake/backend`:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { definePluginBackend } from "cake/backend";

const exec = promisify(execFile);

export default definePluginBackend({
  methods: {
    async currentBranch(input, { signal }) {
      const cwd = String((input as { cwd?: string } | null)?.cwd ?? process.cwd());
      const { stdout } = await exec("git", ["branch", "--show-current"], { cwd, signal });
      return stdout.trim();
    },
  },
});
```

Backends may import Node built-ins, packages resolvable from their source tree,
and arbitrary relative files. They can spawn programs, change repositories,
read credentials available to Cake, and make network requests. Cake does not
declare separate Git, filesystem, or network permissions.

Each enabled backend gets a dedicated utility process. Calls and events cross a
validated JSON protocol with bounded payloads. `usePluginBackend(pluginId)`
returns `call(method, input, { signal? })` and `subscribe(name, listener)`.
Cancellation aborts the backend method's signal. A backend crash is attributed
to its plugin and selects immutable recovery; it cannot crash the Electron main
process directly.

## Public renderer API and state

The version-matched `cake` module exports `DefaultScene`, `Slot`,
`definePlugin`, `usePluginBackend`, commands, persistence hooks, React Store
adapters, approved Stores and components, and styling utilities. Workflow
Stores remain internal. Components reading Cake state must use `observer`.

`usePluginSession()` exposes the selected project session's `workspacePath`,
Pi `sessionId`, opaque `workspace` and `ref` values, and an `openChanges()` host intent. Use the workspace path as an
explicit input to backend Git/filesystem methods; never guess a repository from
the backend process working directory. `openChanges()` opens Cake's native
Changes surface for that same selected session and rejects if the contribution
became stale after a session switch. The hook is valid only in
`project-session.*` contributions or custom-scene branches that render while a
project session is selected.

Trusted contributions use three distinct execution paths. Use
`usePluginBackend(pluginId)` for deterministic privileged Node work such as
network, filesystem, Git, and subprocess operations. Use
`usePluginCompletion()` for bounded, tool-less transformations over a
host-selected session slice. Use `usePluginAgent()` for durable, multi-turn,
tool-using Pi work that creates, attaches to, or forks a session. Inside a
`project-session.*` contribution, omitted targets resolve to the selected
session or workspace.

`usePluginSessionActivity()` exposes streaming state, a settled source
revision, the branch leaf, and the last message ID. Derived widgets refresh on
settled revisions rather than streamed tokens. Completion calls are
take-latest and cancellable. Agent observation detaches on unmount while durable
work continues; `{ abortOnUnmount: true }` opts into view-scoped cancellation.

Agent and completion model preferences are utility, Pi default, current
session, or an exact provider/model. Preflight fallback is observable in the
returned resolved-model metadata; provider failures after execution begins are
surfaced without another-model retry. These APIs exist only in the trusted
plugin renderer graph. Delegated inline widgets receive none of them.

Mounted commands registered with `useCommand(pluginId, name, command)` are
removed on unmount. Headless commands come from `definePlugin`. Internal names
are `<plugin-id>.<command>`; a short alias is offered only when unique. Async
commands receive an `AbortSignal`.

`usePluginGlobalState` and `usePluginSessionState` validate persisted JSON with
the supplied Zod schema. Global records are keyed by plugin and key; session
records also use the Pi session ID. Unreachable records remain available for
rollback and semantic repair.

## Build, activation, and recovery

A validation hashes and snapshots every enabled plugin, typechecks
renderer source against the exact shipped Cake API, builds one renderer graph,
and separately bundles each backend for Node. It does not reload Cake or start a
backend. The build revision also includes Cake core, so host changes invalidate
old candidates.

A validated, unchanged revision must then be explicitly activated. It is pending
until its backends start and its renderer imports
and renders. Only then does Cake record it as active and last-known-good. A
source conflict, diagnostic, backend startup failure, missing health report,
render error, backend crash, or renderer crash selects the immutable factory
UI. Broken source, diagnostics, persistence, and previous builds are retained.

Cake Chat first reads the version-matched authoring reference, then edits plugins
through plugin-scoped optimistic controls. A normal widget request creates only
a renderer plugin; it does not add or select a scene. Validation diagnostics are
intermediate feedback. Activation happens only once the requested implementation
is complete and valid. The factory recovery surface exposes the
failed enabled plugin with two actions: disable it for now or open Cake Chat to
repair it. Intentionally disabled plugins rebuild the remaining customization
without entering recovery.

Visual health remains an authoring requirement. Scenes and contributions must
reflow without collisions from 320 CSS pixels through wide desktop sizes and
with long content. Use normal-flow wrapping flex/grid, `min-width: 0` where
needed, and avoid fixed positioning for structural content.

Focused host verification:

```sh
pnpm typecheck
pnpm exec vitest run tests/app/main/plugin-build-service.test.ts tests/app/renderer/plugin-runtime.test.ts
pnpm build
pnpm exec playwright test tests/electron/plugin-customization.smoke.spec.ts
```

Enabled plugin skills, prompts, and Pi extensions are still discovered only
from the Cake plugin root and passed explicitly to embedded Pi. They are
separate from the unrestricted Node backend.
