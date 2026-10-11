# Architecture documentation map

Start with [Cake architecture](./cake-architecture.md) for product identity,
authorities, and process boundaries. Read focused contracts for the behavior under
review; exhaustive documentation reading is not a prerequisite to a focused change.

## Document responsibilities

| Document                                            | Responsibility                                                                                                                                                                   |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Cake architecture](./cake-architecture.md)         | Cross-cutting product, authority, trust, and lifetime invariants; not a feature inventory or roadmap                                                                             |
| [Vocabulary](./cake-vocabulary.md)                  | Canonical meanings of architectural terms                                                                                                                                        |
| [Effect architecture](./effect-architecture.md)     | Runtime composition, dependency directions, RPC, and renderer synchronization rules                                                                                              |
| [Storage ownership](./cake-storage.md)              | Persistent authorities, formats, migration boundaries, and workflow recovery references                                                                                          |
| [Foundation boundaries](./foundation-boundaries.md) | Compact local Electron process-safety reference                                                                                                                                  |
| Focused contracts in this directory                 | Feature-specific authority, lifecycle, concurrency, and protocol rules                                                                                                           |
| Development guides                                  | Maintained operational instructions and testing, including [remote hosts](../development/headless-backend.md) and [renderer workflows](../development/renderer-store-testing.md) |
| Cake artifacts                                      | Task-specific plans, proposals, audits, investigations, handoffs, and verification records; not a replacement for maintained contracts                                           |

The overview owns cross-cutting invariants; focused contracts supply their details.
Keep one detailed explanation of a policy and link to it rather than maintaining
parallel copies. A historical proposal or working record does not override a
maintained contract. When descriptions disagree, identify the discrepancy rather
than silently treating one as proof of current implementation. Removed feature
and historical guides are not alternate authorities; consult the owning source
and tests for implementation details.

Architecture documents state contracts and intent. A documentation-only review
can establish consistency between descriptions, not implementation compliance.
Verification commands describe how to check behavior; recorded test outcomes are
evidence from the named effort, not a claim that those checks passed on every later
checkout. Implementation observations and proposed changes should remain clearly
distinguished from established policy.

## Saved drafts and unsent input

Unsent composer input and explicitly saved Draft records are different concepts.
The former is client-owned presentation state; the latter is shared backend data,
as described in the maintained [host guide](../development/headless-backend.md#browser-access).
Do not infer saved-record ownership from composer persistence or restore the
removed window-owned account. This distinction does not prescribe a new storage
migration or redesign the activation workflow.
