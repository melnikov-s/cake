---
name: cake-plugin-authoring
description: Customize Cake by creating, changing, or repairing plugins, scenes, widgets, commands, and other user-owned interface code. Use whenever the user wants to personalize Cake, add a custom widget or scene, build a plugin, change how Cake looks or behaves, or fix an existing customization.
---

# Cake Plugin Authoring

Treat a Cake plugin as trusted, user-owned React source. A plugin is not sandboxed, but its module graph is deliberately constrained: it can use its own files, ordinary React, and the explicit surface exported by Cake. Do not invent a JSON UI language or a second application runtime.

## Locate the authoritative source

Choose the source entry for the current mode:

- **Development mode:** load Cake source from the live repository root containing this skill (`../../..` relative to this `SKILL.md`). Changes there are application-development changes, not plugin customization.
- **Packaged mode:** load Cake source from the shipped, read-only authoring snapshot containing this skill (`../../..` relative to this `SKILL.md`).

Cake must load the skill from the same source tree that it designates as the authoring root. Never mix a skill or source snapshot from a different Cake version.

Before editing a plugin:

1. Read `AGENTS.md` and `docs/architecture/cake-architecture.md` from the authoring source root.
2. Read the current `cake` module exports, plugin types, scene host, Store methods, component examples, persistence hooks, and verification commands. Current source outranks examples and this skill when signatures change.
3. Identify the editable plugin directory supplied by Cake. Never edit the read-only authoring source to customize an installed build.

If the running Cake version does not yet implement a convention described here, report the missing host capability instead of fabricating an incompatible local substitute.

## Plugin boundary

Keep every editable plugin beneath Cake's plugin source directory, conventionally `~/.cake/plugins/<plugin-id>/`. A plugin is the atomic source, build, activation, disable, repair, and rollback unit. Each plugin owns one scene and may own its widgets, commands, styles, assets, and tests.

Use a stable, namespaced plugin ID. Do not silently rename it because the ID also namespaces plugin persistence, builds, diagnostics, and rollback history.

Export one typed plugin entry describing the ID, scene component, and optional commands. Widgets are ordinary local React components composed by that scene. Commands validate their inputs, select the scene, and pass explicit initialization data into it.

Cake core plugins, boot code, recovery UI, compiler/activation machinery, preload, Electron main-process code, credentials, and privileged adapters are immutable. Plugin code may inspect the shipped renderer source, but it may import Cake functionality only through the `cake` module. Privileged work must pass through Cake's existing Store intents.

## Allowed imports

Allow these imports in plugin source:

- relative imports that resolve inside the same plugin directory;
- plugin-local CSS and assets;
- `cake`;
- `react`, `react/jsx-runtime`, and `react/jsx-dev-runtime`;
- `react-dom` when a component needs `createPortal`;
- `zod` for structured command or persisted-data validation.

Reject every other bare import, absolute import, path escape, and symlink escape with a compiler diagnostic that identifies the importing file and specifier. In particular, reject Electron, Node built-ins, preload modules, raw IPC, direct Cake source imports, and direct state-library imports.

React owns `createElement`, `Fragment`, hooks, Context, `lazy`, and `Suspense`; do not duplicate them in `cake`. Resolve allowed shared packages from Cake's runtime so a plugin never embeds another React instance.

## The `cake` module

Treat `cake` as an explicit, version-matched export surface generated from the running Cake source. It is an allowlist, not a compatibility promise. The shipped skill and source let the agent migrate plugin code when exports change.

Expose through `cake`:

- `observer`, `useStore`, and `useOptionalStore`;
- approved Cake Store classes so `useStore(StoreType)` returns the real running Store instance;
- approved UI primitives, composed interface components, icons, and styling utilities;
- plugin, scene, command, and persistence types;
- React-friendly plugin persistence hooks for global and session scope.

Do not expose raw Pi objects, provider credentials, Electron APIs, preload clients, transport envelopes, compiler internals, activation controls, or recovery internals.

## React and Cake state

Write plugins as ordinary React component trees. Use React state, reducers, Context, refs, and effects for plugin-owned state and lifecycle. A plugin does not need to define Cake Models or Stores merely because Cake uses them internally.

Cake renders plugin scenes beneath its existing Store providers. Import `observer`, `useStore`, and an approved Store class from `cake`. `useStore(StoreType)` provides reactive Cake state and existing Cake intents; wrap every component that reads that state with `observer()` so updates rerender it.

Do not add dynamic child-Store arrays, `getChild()` registries, RootStore subclasses, or SessionStore subclasses for plugin-owned React state. A command should validate its inputs, select the plugin scene, and let that scene initialize and own the workflow. Consider a separate headless Store only when work must genuinely continue while the scene is unmounted, and follow the current Cake architecture rather than inventing a plugin Store framework.

Use the persistence hooks exported by `cake` for durable React state. Global scope is namespaced by plugin ID; session scope is namespaced by plugin ID plus Pi session ID. Persistence must support serializable values and React updater semantics without exposing storage paths or transport details.

Do not persist timers, subscriptions, abort controllers, pending promises, transient loading state, or other runtime resources. Preserve data made unreachable by a rename until the user explicitly approves cleanup so rollback and agent-led migration remain possible.

## Build and activation

Compile the plugin against the source and `cake` exports shipped with the running build. Enforce the import allowlist during resolution and typechecking. Do not vendor Cake source or install duplicate React or Cake runtime dependencies inside the plugin.

Build the immutable Cake renderer source and editable plugin source as one candidate renderer graph. Do not emit a standalone plugin bundle containing duplicate runtime modules. Typecheck before activation, activate transactionally, and retain the prior last-known-good renderer.

Treat activation as a lifecycle replacement: unmount the old plugin tree, run effect cleanup, remount the candidate scene, and reject stale async completion. Mark a candidate healthy only after it imports and renders successfully; a crash or incomplete activation must select recovery on the next boot.

## Authoring workflow

1. Inspect the selected plugin and its current diagnostics, persisted snapshots, and last-known-good revision.
2. Inspect `cake` exports and choose only the Store intents, components, and persistence scope the scene needs.
3. Edit any source inside the plugin as needed. Update every plugin-local caller and test in the same change; Cake is greenfield and does not require compatibility shims.
4. Run import-policy validation, the plugin typecheck, focused tests, and the candidate renderer build using commands from the current Cake source.
5. Activate only after all deterministic checks pass. Verify the scene renders, commands resolve, Cake Store reads react, persisted state hydrates, and replaced effects clean up.
6. Record semantic migration notes when compiler success cannot prove behavior.

## Repair and migration

Use Cake's immutable factory-default recovery scene when a plugin cannot load safely. It must load no user plugins and must retain a vanilla global chat, the normal transcript and composer, provider/model/thinking controls, tool activity, exact plugin diagnostics, and safe disable and rollback controls.

Treat global chat as the primary self-healing surface. Cake should open it with explicit recovery context: the failed plugin ID and revision, whether compilation, import, activation, or rendering failed, the exact diagnostics or attributed runtime error, and the available last-known-good build. The user and agent can then inspect and repair the preserved plugin source, run deterministic checks, activate a candidate transactionally, and reload the repaired scene without depending on the broken plugin UI.

Recovery UI, global chat, plugin diagnostics, compiler/activation controls, and last-known-good selection belong to immutable Cake core. They must remain usable when every user plugin is disabled or unimportable. Do not allow a plugin to replace, hide, or intercept this recovery path.

For a broken or outdated plugin, inspect its source, exact diagnostics, persisted snapshots, current Cake source, and last-known-good diff. Make the semantic migration in plugin code or persisted data, rebuild, test, and retry activation. Cake supplies backups, version stamps, validation, health checks, and rollback; the agent supplies migration meaning.

Do not delete broken source or orphaned persistence merely to make Cake boot. Disable the candidate or roll back first, then preserve evidence for repair unless the user explicitly requests deletion.
