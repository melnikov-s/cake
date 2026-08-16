---
name: cake-plugin-authoring
description: Customize Cake by creating, changing, or repairing plugins, scenes, widgets, commands, backends, and other user-owned interface code. Use whenever the user wants to personalize Cake, add a custom widget or scene, build a plugin, change how Cake looks or behaves, or fix an existing customization.
---

# Cake Plugin Authoring

Treat a Cake plugin as trusted, user-owned software. It may include a constrained
React renderer, an unrestricted Node backend, an optional plugin-owned scene,
or any combination. The backend is not a
capability sandbox: it can use Git, files, subprocesses, credentials, and the
network. Never invent per-capability permission declarations unless the user is
explicitly asking to redesign that policy.

## Locate the authoritative source

Choose the source entry for the current mode:

- **Development mode:** use the live Cake repository containing this skill
  (`../../..` relative to this file).
- **Packaged mode:** use the shipped read-only authoring snapshot containing
  this skill.

Before editing, read `AGENTS.md`, `docs/architecture/cake-architecture.md`,
`docs/architecture/cake-plugins.md`, and the current `cake` / `cake/backend`
exports. Then inspect the editable plugin files with their exact
working and source revisions. Current source outranks examples in this skill.
Never edit the shipped authoring snapshot to customize an installed build.

If the running Cake version lacks a convention described here, report the
missing host capability instead of fabricating an incompatible substitute.

## Plugin and scene boundaries

Keep plugin source beneath `~/.cake/plugins/<plugin-id>/`. The strict v2
manifest uses the same stable namespaced ID as its directory and declares
optional `renderer`, `backend`, and `scene` entries. At least one entry is required. Do
not silently rename an ID: it namespaces persistence, diagnostics, backend
calls, builds, and history.

Enabled renderer entries load automatically. Do not create or select a scene merely
to install, remove, or reorder a plugin. A renderer calls `definePlugin` and may
declare named components, commands, and contributions to canonical slots. Slot
order belongs on the contribution. Commands validate their inputs and may use
the Cake reveal intent to focus mounted UI.

Slot namespaces express ownership. Use `global.*` only for application chrome
that should remain across Cake Chat, project sessions, and settings. Use
`project-session.*` for UI belonging to an individual project session.
`project-session.header.actions` is specifically the toolbar/menu row. Persistent
session panels belong in the normal-flow `project-session.left.*` and
`project-session.right.*` rails, each of which has `top`, `middle`, and `bottom`
outlets. “Top right of the session” means `project-session.right.top`. Rail
content reserves space and must not position itself over the conversation.
Header slots are fixed-height action rows, so put only a compact trigger there.
Use Cake's `Popover` with `PopoverTrigger` and `PopoverContent` when a temporary
surface should intentionally overlap the application.

A plugin-owned `scene` is an optional complete application replacement. At most
one enabled plugin scene is selected with `activeScene`. With none selected,
Cake uses its immutable core default; there is no editable global scene file.
A scene may render `DefaultScene`, arrange `<Slot name="..." />` outlets in a
different layout, or return a wholly custom React tree. Preserve canonical slot
names when ordinary plugins should remain compatible. The immutable recovery
scene is Cake core and never loads user renderers or backends.

## Renderer source

Renderer source may import relative files contained by its plugin, plugin-local
CSS/assets, `cake`, React and its JSX runtimes, React DOM, and Zod. Reject other
bare imports, absolute imports, path escapes, and symlink escapes. In particular,
renderer source has no Node, Electron, raw IPC, raw Pi, credential, compiler, or
recovery access. Use `usePluginBackend(pluginId)` for privileged work.

The `cake` module is version-matched, explicit, and not a compatibility promise.
It exposes `DefaultScene`, `Slot`, plugin and command helpers, persistence hooks,
React Store adapters, approved Stores/components, and styling utilities. Do not
reach into Cake source through relative paths or add duplicate React runtimes.

For a `project-session.*` contribution, call `usePluginSession()` to obtain the
selected session's `workspacePath`, Pi `sessionId`, and `openChanges()` host
intent. Pass `workspacePath` explicitly to backend Git or filesystem methods;
the backend process working directory is not the selected repository. Use
`openChanges()` to open Cake's native Changes surface instead of simulating a
click or importing an internal Store. The intent rejects if that session is no
longer selected.

Write contributions as ordinary React. Use React state and lifecycle for
plugin-owned UI state. Components reading Cake Stores use `observer` and
`useStore`. Use Cake's global/session persistence hooks for durable serializable
values; never persist runtime resources such as promises, timers, controllers,
or subscriptions.

## Backend source

Backend source imports `definePluginBackend` from `cake/backend`. It otherwise
uses normal Node ESM and can import Node built-ins, plugin-relative modules, and
packages resolvable from the plugin source tree. Methods accept validated JSON,
an `AbortSignal`, and an event emitter. Return only JSON-compatible bounded
values. Honor cancellation where the underlying operation supports it, and
clean up long-lived resources in `dispose`.

Cake starts one utility process per enabled backend. This is crash and lifecycle
isolation, not authority restriction. Keep renderer presentation in the renderer
and native/system work in the backend. Do not add bespoke Git, filesystem, or
network bridges when a backend can call those facilities directly.

## Build and activation

Cake builds one renderer graph from core, the selected plugin scene (if any), and all enabled renderer
entries, while bundling every enabled backend separately for Node. It typechecks
without activation, uses exact source revisions, and retains the last-known-good
candidate. Explicit activation replaces the previous renderer and backend processes;
effects and backend `dispose` hooks must clean up.

A candidate is healthy only after every backend starts and the renderer imports
and renders. A backend crash, renderer error, or incomplete activation selects
immutable recovery. Recovery and compiler machinery remain core and cannot be
replaced by a plugin.

## Authoring workflow

1. Read `get_plugin_authoring_reference`, then inspect customization state,
   current plugin files, diagnostics,
   persisted snapshots when relevant, and the last-known-good revision.
2. Inspect the current public exports and choose the smallest existing Cake
   components, Store intents, slots, and persistence scope that fit.
3. Create and edit plugin-owned source. For ordinary widgets, use a renderer
   plugin and leave `scene` false. Add a scene only when the user explicitly
   requests whole-application replacement. Cake is greenfield: update all callers
   and tests together and do not add compatibility shims.
4. In global chat, retain the original `sourceRevision`; make each
   `write_plugin_file` call with the latest `workingRevision`; then call
   `validate_customization` with the original base and latest source revisions
   plus concise provenance. On a stale revision, reread and merge semantically.
5. Treat typecheck, bundle, and backend-start diagnostics as intermediate
   authoring feedback. Repair and repeat validation autonomously. Call
   `activate_customization` only after the requested implementation is complete,
   unless blocked by missing intent, unavailable host capability, or an unsafe
   concurrent conflict.
6. Verify automatic registration, each intended slot, commands, reactive Store
   reads, persistence hydration, backend calls/events/cancellation, and cleanup
   on replacement. A custom scene that omits a contributed canonical slot must
   do so intentionally; resolve Settings warnings for accidental missing or
   duplicate outlets.
7. Check responsive behavior from 320 CSS pixels through wide desktop sizes and
   with long values. Use wrapping normal-flow flex/grid, reserve icon space, set
   `min-width: 0` on shrinkable children, and avoid absolute/fixed positioning
   for structural content.

For host development, run the focused verification commands in
`docs/architecture/cake-plugins.md`.

## Repair

Distinguish intermediate authoring diagnostics from a failure discovered after
activation. For the latter, use immutable factory recovery, preserve the failed
source and persistence, inspect the exact attributed diagnostic and previous
build, make the semantic repair, and retry the full build/activation cycle.

Do not delete broken source or orphaned persistence merely to boot. Disable or
roll back first and preserve evidence unless the user explicitly requests
deletion.
