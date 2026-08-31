# S1 Project Session and state contract

Cake's Project Session is a project-aware Cake Session backed by one Pi Session.
`PiSessions` is the only ordinary Cake Service that operates Pi session
runtimes. It creates, resumes, inspects, or opens an explicit Pi Session for the
selected Working Directory and projects only Cake-owned values into Effect RPC.

## Authority and lifecycle

| State                                                                             | Authority                       | Owner, lifetime, and persistence                           |
| --------------------------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------- |
| Transcript, tool results, model history, branches, compaction                     | Pi                              | Pi JSONL; Cake only projects snapshots and events          |
| Provider credentials and Pi resource configuration                                | Pi                              | Pi storage; secrets never enter Cake documents or logs     |
| Active turn, queued delivery, extension UI requests                               | Pi Session Runtime              | Scoped `PiSessions` handle; reconstructed when reopened    |
| Cake Session kind, Project association, Working Directory, resolved/archive state | Cake domain                     | Cake-owned metadata and typed storage where durable        |
| Transcript projection                                                             | Renderer Session/Message Models | Window lifetime; rebuilt from `CakeSessionUpdate`          |
| Composer and renderer workflow                                                    | Focused renderer Stores         | Window lifetime; explicitly snapshotted drafts may persist |
| Projects, trust, presets, staged chats, explicit drafts, theme/view settings      | Cake                            | Focused typed storage documents                            |
| Attachments before accepted submission                                            | Renderer Store                  | Cleared after acceptance; bounded by RPC Schemas           |

## Observation

A Project Session subscription emits one coherent `CakeSessionSnapshot`
followed by revision-ordered `CakeSessionEvent` values. The durable portion is
reconstructed through Pi from JSONL, and the active runtime supplies live
in-progress events. Cake does not tail JSONL or maintain a second transcript
log.

The renderer's owning Store consumes the Stream, batches related transitions,
and updates reactive Models. Every event carries stable Cake/Pi Session
identity, and Stores reject events for a stale target. Reconnect obtains a new
authoritative snapshot.

## Commands and concurrency

Project Session commands execute as main-process domain operations through
Effect RPC. Prompt returns an accepted Turn ID; lifecycle continues through the
subscription. Turn delivery, steer, follow-up, abort, compaction, fork, rename,
resolve, and restore retain explicit typed failures and cancellation.

Per-session turn coordination is serialized or queued according to Pi and Cake
policy. Switching renderer selection does not implicitly destroy a retained
session runtime. Scope ownership and repeated-call policy are specified
separately.

## Trust and security

Main accepts Project paths selected through native capability or restored from
validated Cake storage. Before `PiAgentResources` loads trusted project-local
executable resources, the domain requires approval for the exact Working
Directory and persists that Cake-owned trust decision.

The renderer receives Cake-owned parts for text, reasoning, tools, sources,
attachments, and notices. Raw Pi messages and AI SDK types never cross Effect
RPC. Model output renders through Cake-owned safe surfaces; raw HTML is not
inserted into Cake's DOM.

## Renderer ownership

The window-owned Model synchronizer owns Project Session observations and
applies mapped snapshots to stable Session Models supplied only by `RootStore`.
`ProjectSessionStore` owns composer, chat
configuration, artifacts, discussion presentation, and renderer operation state
around that Model. Its `ChatStore` supplies the authoritative shared `Chat`
component. `RootStore` routes application intents and coordinates selection
without copying this state.

Stores invoke the Promise-based `RendererClient`; they do not import Effect,
`CakeIpcClient`, RPC definitions, main domain modules, or `PiSessions`.
The window-owned Model synchronizer owns observation subscriptions. Store disposal
owns local workflow cleanup and aborts cancellable client operations.

## Verification boundary

Deterministic tests cover Pi JSONL reopen, complete active-branch projection,
trust detection, Schema rejection, snapshot/event ordering, Store hydration,
stale-session filtering, cancellation, and the real Electron RPC boundary.
Provider-backed calls and native provider login remain opt-in because they may
require credentials or incur cost.
