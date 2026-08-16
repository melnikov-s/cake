# Cake plugins and customization

Cake plugins are trusted, user-owned React source. Cake core owns discovery,
typechecking, the candidate renderer build, health-gated activation, persistence,
and immutable recovery. There is no `eval`, Jiti loader, standalone plugin
bundle, or second React runtime.

## Source layout and manifest

The default root is `~/.cake` or the absolute `CAKE_HOME` override:

```text
plugins/<plugin-id>/
  cake-plugin.json
  index.tsx
  skills/<skill>/SKILL.md       # optional embedded-Pi resource
  prompts/*                     # optional embedded-Pi resources
  pi-extensions/*               # optional embedded-Pi resources
  styles/*                      # optional renderer source
  assets/*                      # optional renderer source
scenes/global.tsx
recovery/
  builds/<sha256>/              # complete immutable renderer candidates
  sources/<sha256>/             # exact regular source files for repair
  history/*.json                # request/base/result/diagnostic provenance
  customization-state.json      # activation journal
state/plugin-state/             # versioned namespaced JSON persistence
```

`cake-plugin.json` is strict version 1 metadata. The directory name and `id`
must match. IDs are stable, namespaced, lowercase identifiers such as
`acme.calendar`.

```json
{
  "schemaVersion": 1,
  "id": "acme.calendar",
  "entry": "index.tsx",
  "enabled": true
}
```

The entry exports one typed definition. Headless commands register when that
entry is imported:

```tsx
import { definePlugin } from "cake";

function Calendar() {
  return <section>Calendar</section>;
}

export default definePlugin({
  id: "acme.calendar",
  contributions: { Calendar },
  commands: {
    open: {
      description: "Open the calendar",
      run(args, context) {
        context.reveal("acme.calendar.main", { query: args });
      }
    }
  }
});
```

The single user-owned global scene composes enabled plugins with generated
`plugin:<id>` imports. It must keep `children` mounted; those children contain
the normal Cake application and the render-health reporter.

```tsx
import type { ReactNode } from "react";
import calendar from "plugin:acme.calendar";

const Calendar = calendar.contributions.Calendar;

export default function GlobalScene({ children }: { children: ReactNode }) {
  return <><aside><Calendar /></aside>{children}</>;
}
```

Both plugin files and scene files may import only `cake`, `react` and its JSX
runtimes, `react-dom`, `zod`, or relative files that remain inside their own
root. The resolver rejects other bare modules, absolute paths, `..` escapes,
and symlink escapes. Only scene source may import `plugin:<id>`. Plugin code has
no Electron, Node, raw IPC, raw Pi, compiler, activation, credential, or
recovery access.

## Public renderer API

The version-matched `cake` module exports `definePlugin`, `useCommand`,
`useContributionReveal`, `observer`, `useStore`, `useOptionalStore`, approved
application intents through `RootStore`, `Button`, `cn`, and global/session
persistence hooks. Workflow Stores remain internal rather than becoming a
traversable public API. Plugin UI state normally belongs in React. A component
reading a Cake Store must be wrapped in `observer`.

Mounted commands registered with `useCommand(pluginId, name, command)` are
removed on unmount. Headless commands come from `definePlugin`. Internal names
are always `<plugin-id>.<command>`; `/open` is offered only when exactly one
plugin owns that alias. Async commands receive an `AbortSignal` and are aborted
when the renderer is replaced. `context.reveal()` pairs with
`useContributionReveal()` without imposing fixed layout slots.

`usePluginGlobalState(pluginId, key, initialValue)` and
`usePluginSessionState(pluginId, key, initialValue)` suspend the contribution
until the stored JSON value is loaded, so dependent effects do not run against
a temporary default. Writes use React updater semantics and optimistic storage
versions. Global records are keyed by plugin and key; session records also use
the Pi session ID. Old or unreachable records are retained for rollback and
semantic repair.

## How bundles are built

Plugin source is never emitted as an independent package. A rebuild computes a
SHA-256 revision over the global scene and every enabled plugin, snapshots those
sources, typechecks them against the authoring source shipped with this exact
Cake version, then invokes Vite on Cake's complete renderer entry. Runtime
aliases force React, React DOM, Zod, and `cake` to resolve from the running Cake
installation. The result is:

```text
~/.cake/recovery/builds/<revision>/index.html
```

In the running app, use **Build and retry** in the immutable customization
recovery panel. The same operation is available to global chat through
`build_customization`. Global chat has no general filesystem or shell access;
it uses the curated `list_customization_files`, `read_customization_file`, and
`write_customization_file` controls. Every write supplies the latest
`workingRevision`. The final build supplies the original active/source head as
`expectedBaseRevision` and the final write's `buildRevision` as
`expectedSourceRevision`, plus a provenance request. A changed working tree or
head is rejected instead of overwriting concurrent edits.

During a user-requested create or edit, a failed typecheck or bundle is
intermediate authoring feedback. Global chat inspects the diagnostics, repairs
the source, and repeats the write/build cycle without asking the user to approve
each attempt. It yields only after activation begins or it encounters a genuine
blocker. The recovery panel and an offer to repair are for a customization that
had previously activated and later became incompatible or failed to load; once
repair is requested, its build iteration is autonomous as well.

Visual health is part of authoring even though compilation cannot prove it.
Custom scenes and contributions must remain collision-free from 320 CSS pixels
through wide desktop sizes and when labels or values expand. Structural content
uses wrapping, normal-flow flex or grid layout, reserves explicit space for
icons and decorations, and keeps shrinkable children at `min-width: 0`.
Absolute or fixed positioning is not used for structural text, controls,
navigation, or Cake-owned children. The authoring agent applies these checks
before considering a customization complete.

`pnpm build` at the Cake repository root builds the immutable desktop app and
then writes `out/authoring`, the read-only version-matched source/skill snapshot
used by packaged Cake. It does not activate files in the developer's real
`~/.cake` directory. Focused host verification is:

```sh
pnpm exec vitest run tests/app/main/plugin-build-service.test.ts
pnpm exec playwright test tests/electron/plugin-customization.smoke.spec.ts
```

## Activation and recovery

A successful bundle is still only a pending candidate. Cake loads its
`index.html`, waits up to ten seconds for the exact revision to import and
render, then atomically records it as active and last-known-good. Source changes
during a build, an optimistic-head conflict, type/bundle failure, an interrupted
pending activation, a missing health report, an error boundary report, or an
Electron renderer-process crash selects immutable factory UI and records an
attributed diagnostic.

Factory UI contains the ordinary Cake application, global chat, model/thinking
controls, diagnostics, plugin enable/disable, rebuild, rollback, and factory
selection. It evaluates no user scene or plugin code. Global chat is recreated
with exact recovery context and has curated controls to inspect state, build an
exact candidate, disable a plugin, roll back, or use factory UI. Broken source,
builds, snapshots, provenance, and persistence are preserved.

Enabled plugin skills, prompts, and Pi extensions are discovered only from the
Cake plugin root and passed explicitly to embedded Pi. Changes restart Cake's
workspace Pi hosts. Standalone Pi resources are not discovered because every
Cake runtime uses the isolated `<CAKE_HOME>/pi` agent and session roots.
