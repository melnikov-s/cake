# S1 session and state contract

Cake's project chat uses a project-aware, multi-session Pi runtime.
The focused `src/agent` adapter modules remain the only ordinary application modules that
imports Pi. It creates, resumes, or opens an explicit Pi session for the
selected workspace and emits only the schemas in `src/ipc/session-contract.ts`.

## Authority and lifecycle

| State                                                                                                                                                                                    | Authority                         | Lifetime and persistence                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------- |
| Transcript, tool results, model history, compaction                                                                                                                                      | Pi `SessionManager`               | Pi JSONL session; Cake only projects snapshots and deltas                                          |
| Provider credentials                                                                                                                                                                     | Pi `ModelRuntime`                 | Pi auth storage; secret prompt values are never retained in Cake state or logs                     |
| Active run, queued delivery, UI requests                                                                                                                                                 | Main-process Pi workspace runtime | One active session runtime; replaced with take-latest semantics when switching sessions            |
| Transcript projection                                                                                                                                                                    | Renderer `Session` tree           | Window lifetime; `RootStore` applies validated desktop events                                      |
| Composer workflow                                                                                                                                                                        | Renderer chat/composer Store      | Window lifetime; the focused Store owns drafts, submission policy, and pending composer operations |
| Project history, trusted paths, per-session composer drafts, the single staged New Chat input and identity, explicit draft-session messages and attachments, theme, reasoning visibility | Cake main process                 | Atomic `window-state.json`, saved only after renderer hydration                                    |
| Attachment selection                                                                                                                                                                     | Renderer workflow                 | Cleared after accepted submission; images are bounded by IPC schemas                               |

Renderer workflow Stores depend on the intent-level `DesktopClient`, not IPC
envelopes. Each focused Store owns the concurrency and lifecycle policy for its
workflow, including revisions or correlated operation IDs where needed.
`RootStore` owns the desktop subscription and routes validated events without
absorbing the workflows they affect. It is created with
`mount(createStore(RootStore, ...))` and disposed on renderer `pagehide`.

## Trust and security

The main process only accepts project paths selected by the native directory
dialog or restored from Cake's persisted window state. Before creating Pi
services, the Pi adapter checks for trust-requiring project resources.
The renderer must resolve that prompt before `DefaultResourceLoader.reload()`
is allowed to load project-local executable resources. Approval is persisted by
exact workspace path and reused for future sessions in that workspace.

The renderer remains sandboxed and receives Cake-owned UI parts for text,
reasoning, tools, sources, attachments, and notices. Raw Pi messages and AI SDK
types do not cross IPC. Model output is rendered as React text; raw HTML is not
parsed or injected.

## Verification boundary

Deterministic tests cover Pi JSONL reopen, trust detection, schema rejection,
Store hydration and stale-session filtering, source-owned components, and the
real Electron process boundary. Live provider calls and native provider login
flows remain opt-in because they require user credentials and may incur cost.
