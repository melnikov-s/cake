# Session Plugins

Session Plugins are durable session-bound controls, separate from artifacts and
blocking requests. Generated React uses the opaque-origin widget sandbox and mounts
in the `composer.above` slot alongside extension companions. `SessionPluginStore`
projects main-owned application metadata.

## State and patching

Definitions, private JSON state, and named session-shared JSON state survive turns,
remounts, window closure, and restarts. Ordinary React state is iframe-mount-local.
User-owned hidden visibility is independent of agent state: updating or replacing a
plugin does not reopen it. Explicit deletion or permanent owning-Session deletion
removes data; hide, resolve, and runtime release do not.

`plugins.patch` shallow-merges object state in the main ApplicationState transaction,
validates the complete resulting preset, and preserves omitted actions/visibility.
Disjoint concurrent patches compose; conflicts follow transaction order. Nested
values replace as units, null is a value, and missing plugins/invalid results fail
atomically. There is no separate Draw guide state machine; actions send ordinary
user messages rather than optimistically changing progress.

## Capabilities

The token-bound SDK supplies `useCake()` through the owning Project Session's actual
operation registry, `usePluginState()` for durable private state, and
`useSharedState(key)` for durable state shared only within that Session's plugins.
The host supplies live theme tokens and always-available Hide/Show. It exposes no
Node, Electron, parent DOM, credentials, or direct network access.

## Verification

- [Plugin agent operations](../../tests/app/agent/cake-session-plugin-operations.test.ts)
- [Real Electron plugins](../../tests/electron/session-plugins.smoke.spec.ts)
