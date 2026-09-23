# VS Code selection pills

## Ownership and lifetime

Each retained `ProjectSessionStore` owns one `EditorSelectionsStore`. That Store
is the only selection authority: ordered selections, IDs, deduplication,
open/reveal/remove/clear, operation serialization, and errors.

Selections are ephemeral application state. There is no domain collection,
Model, `@snapshot`, disk storage, transcript copy, main-owned collection, or
observation stream. Switching sessions retains their separate lists, even when
they share a Working Directory and VS Code instance. Disposing the session Store
or closing its Cake window loses the selections. There is no cross-window sync.

| State                                    | Owner                                              | Lifetime / concurrency                                                              |
| ---------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------- |
| IDs, ordered selections, operation error | Session's `EditorSelectionsStore`                  | Non-persisted; serialized operations; disposal rejects late results                 |
| Active editor presentation               | `SessionPresentationStore` / `EmbeddedEditorStore` | Window-local; reactive active locations; serialized complete highlight replacements |
| Highlight locations in VS Code           | Companion rendering cache                          | Replaced completely; reapplied to matching visible editors                          |
| Input focus, chat drafts, attachments    | Existing Chat / composer owners                    | Unchanged                                                                           |

## Behavior

- Ranged `vscode.open` calls accumulate selections. Disjoint source links produce
  one selection per range; selections can span files.
- Exact normalized duplicates reuse their ID. Overlapping ranges, different
  diff sides, and different bases remain distinct.
- File-only opens navigate without adding selections. Native navigation resolves
  symbols and clamps coordinates. A diff fallback records the actual file view.
- Source-style pills appear above the IDE project-chat input. Click a pill to
  reveal its location; click its independent X action to remove only that
  selection and highlight, without closing the tab.
- Sending messages and clearing attachments leave tour selections unchanged.
  Manual editor text selection remains a separate composer-context feature.
- Hiding/closing editor tabs never removes selections. Reopening VS Code renders
  the active session's complete list, including an empty list after clear.
- Selections use fixed coordinates, not edit-tracking anchors. Native navigation
  and rendering clamp if the document changes; edits do not rewrite Store state.

## Session switching and native transport

The shared editor displays the active session's collection, not the union of all
sessions. Switching to an empty session clears prior highlights; switching back
restores the retained collection. Changes to an inactive session do not project
its highlights over the active session.

`EmbeddedEditorStore` reacts to active highlight locations and native readiness.
It serializes native sends and reads the current active locations when each send
starts, so a delayed previous send is followed by the current session's list.
Opening/restoring the editor also resends the current list.

Main validates paths and transports native rendering requests; it does not own
selection CRUD. Native highlight payloads contain only `{ locations }`: file,
range, and any diff side/base. The companion receives
`{ type: "selection-highlights", locations }`; an empty list clears highlights.
Neither selection IDs nor session identity cross this native boundary.

## Agent controls

Agent operations use the existing renderer application-control bridge, routed by
`source.sessionId` to the owning session Store—not whichever session has focus.

| Command                    | Input                             | Result                                                      |
| -------------------------- | --------------------------------- | ----------------------------------------------------------- |
| `vscode.open`              | Existing one-based location input | Actual view, resolved location, selection IDs, any warnings |
| `vscode.selections.list`   | `{}`                              | Calling session's ordered IDs and one-based locations       |
| `vscode.selections.remove` | `{ id }`                          | Updated list; unknown ID is a no-op                         |
| `vscode.selections.clear`  | `{}`                              | Empty list                                                  |

List/remove/clear work while VS Code is hidden if the source session Store is
available. Missing renderer/Store produces an explicit error, never a main-owned
fallback collection. Opening code requires the source session to be selected in
VS Code mode: background opens return mode-required rather than navigating the
shared editor underneath another session. `vscode.enter` can retain an inactive
session's presentation preference but does not steal focus.

Help explains accumulation, session-local ephemeral retention, inspecting IDs,
and clearing the previous tour step. Internal Store replies use zero-based
locations; public primary-agent results use one-based coordinates.

## Failure behavior

Native open failure registers nothing. Store commands are serialized; disposal
rejects late navigation results. Removal/clear remain effective if rendering
fails, with a warning instead of rollback. Reopening retries the current list;
there is no reconciliation service or retry timer. Revealing a removed ID fails
without recreating it. Existing path checks and diff fallback rules remain.

## Replacement map

- Replaced companion per-editor reveal tracking with one supplied-location render
  cache and a shared decoration applied to matching visible editors.
- Replaced direct main-process agent open/enter and its entered event with
  source-session renderer application controls.
- Changed native reveal replies from outcome-only/void to resolved locations.
- Added presentation-only highlight transport to the native Client/RPC/service.
- Added session Store composition and IDE composer pills; kept Chat, ChatStore,
  manual context, attachments, and annotations independent.

## Verification

Store tests cover collection identity/order, deduplication, serialization,
disposal, errors, and non-persistence. Workflow tests retain real Root composition,
application controls, session routing, and presentation synchronization, replacing
only native Client boundaries. Companion tests cover file/diff rendering and
resolved navigation. Agent tests cover input validation, help, coordinates,
selection IDs, and warnings.

Isolated Electron tests drive application-control requests into real Stores and
VS Code, then exercise pill navigation, mouse/keyboard dismissal, multiple editor
groups, actual composer focus/typing, enabled submission, and retained selections.
Build `out/` after source changes before running these tests.
