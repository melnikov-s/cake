---
name: effect-ts
description: |
  Production Effect v4 conventions for Cake. Use whenever implementing or reviewing Effect workflows, Services, Layers, Schemas, configuration, schedules, caches, Streams, HTTP clients, tests, or Effect repository setup.
license: MIT
compatibility: Cake's pinned Effect v4 release and the local effect-state-tree package.
metadata:
  upstream: https://github.com/kitlangton/skills/tree/main/skills/effect
  upstream-revision: 22c35cb7fd29f931789253fc3c8eb142f2863a8a
---

# Effect TypeScript

This skill combines Cake's original Effect setup guidance with the production
best practices from Kit Langton's Effect skill. The upstream material is MIT
licensed. Cake-specific decisions and precedence are documented in
[`references/CAKE_CONVENTIONS.md`](./references/CAKE_CONVENTIONS.md).

## Source rule and precedence

Before writing or reviewing Effect code:

1. Read the nearest `AGENTS.md` and Cake's relevant architecture documents.
2. Read `node_modules/effect/AGENTS.md` **completely** and follow the links it
   requires for the APIs being changed.
3. Read this skill and every branch reference selected below.
4. Read the project-pinned Effect source in `node_modules/effect/src` rather
   than guessing when the installed guide does not answer a question.
5. For renderer state, also read the complete local effect-state-tree guidance
   required by Cake's `AGENTS.md`.

Cake's ownership, process, security, and state architecture takes precedence.
The installed Effect package is the API authority. This skill supplies coding
conventions within those boundaries; do not rewrite Cake architecture to match
a generic example.

## Repository setup

Cake pins one exact Effect version shared with effect-state-tree. Do not use a
floating `effect@rc` command in this repository. Preserve the versions and local
peer-instance rules in `docs/development/effect-migration.md` and do not install
`@effect/rpc`; Cake uses `effect/unstable/rpc`.

A repository adopting this skill must include the Effect learning instructions
in `AGENTS.md` and must make this skill required reading before Effect changes.

## Branch chooser

Always read [`references/CAKE_CONVENTIONS.md`](./references/CAKE_CONVENTIONS.md),
then read every branch matching the task:

- Data models, schemas, brands, variants, optional keys, or decoders: read
  [`references/SCHEMA.md`](./references/SCHEMA.md).
- Services, module surfaces, Layers, runtime wiring, errors, `Effect.fn`, or test
  Services: read
  [`references/SERVICES_LAYERS.md`](./references/SERVICES_LAYERS.md).
- Runtime config, environment variables, `ConfigProvider`, or `layerConfig`:
  read [`references/CONFIG.md`](./references/CONFIG.md).
- Retry, repeat, polling, backoff, jitter, rate limits, timeouts, or pass loops:
  read [`references/SCHEDULING.md`](./references/SCHEDULING.md).
- Memoization, keyed caches, concurrent lookup deduplication, or batching: read
  [`references/CACHING.md`](./references/CACHING.md).
- Streams, event sources, queues, PubSub, pagination, backpressure, or Stream
  consumers: read [`references/STREAMS.md`](./references/STREAMS.md).
- Outgoing HTTP or HTTP retry/rate-limit policy: read
  [`references/HTTP_CLIENTS.md`](./references/HTTP_CLIENTS.md).
- Effect tests, time, concurrency synchronization, or fakes: read
  [`references/TESTING.md`](./references/TESTING.md).

## Core defaults

- Compose workflows with `Effect.gen(function* () { ... })`.
- Define public service operations, domain operations, and non-trivial internal
  operations with `Effect.fn("Domain.operation")`.
- Use function-valued Service members, including zero-argument operations.
- Use `Effect.fnUntraced` only for internal helpers where tracing metadata is
  intentionally unnecessary.
- Prefer `Context.Service` for Cake's outside-world Services.
- Build real implementations with the Layer constructor matching acquisition;
  default effectful acquisition to `Layer.effect(Service, Effect.gen(...))` and
  return `Service.of({ ... })`.
- Keep Cake business logic in free domain Effects. Do not turn domain modules
  into Context Services.
- Model records with `Schema.Struct(...)` plus a same-name interface for new
  Effect-owned contracts. Existing aliases may be migrated when touched rather
  than through unrelated churn.
- Model expected typed failures with `Schema.TaggedError`.
- Read runtime configuration through `Config`, not direct `process.env` access
  inside Effect application logic.
- Use `Schedule` for retry, repeat, polling, pacing, and backoff.
- Use `Stream` for effectful many-valued, ordered sources.
- Prefer Effect HTTP clients where their typed failures and Layers are useful.
- Prefer `@effect/vitest`, explicit Layers, `TestClock`, and deterministic
  synchronization for new Effect tests.
- Decode untrusted boundaries without unchecked casts. Prefer
  `Schema.decodeUnknownEffect`, `schema.makeEffect`, or an explicit non-throwing
  Result where a callback must remain synchronous.

## Quick selection guide

- Ordinary record: `Schema.Struct(...)` plus same-name interface.
- Encoded key may be absent: `Schema.optionalKey(...)`.
- Explicit `undefined` is part of the encoded contract: `Schema.optional(...)`.
- Scalar ID/value object: constrained branded Schema.
- Internal workflow algebra: `Data.TaggedEnum` and exhaustive `$match`.
- Boundary tagged variant/union: `Schema.TaggedStruct` / `Schema.TaggedUnion`.
- Expected failure: `Schema.TaggedError`.
- Unknown boundary payload: `Schema.decodeUnknownEffect(...)`.
- Outside-world boundary: `Context.Service` plus a Live Layer.
- Cake business policy: a named free `Effect.fn` domain operation.
- Event source: `Stream`; use private `Queue`, `PubSub`, or `SubscriptionRef`
  according to delivery semantics.
- Long-lived consumer: `Stream.runForEach(...)` forked with
  `Effect.forkScoped` in its owning Layer or Scope.
- Polling/retry: `Effect.repeat` / `Effect.retry` with a bounded `Schedule`.
- One memoized effect: `Effect.cached` or `Effect.cachedWithTTL`.
- Keyed lookup cache and concurrent deduplication: `Cache` or `ScopedCache`.
- Dynamic keyed resources: the installed Effect keyed-resource primitive
  appropriate to the ownership contract; do not scatter mutable Maps of Fibers.
- Time-sensitive test: `TestClock`, not real sleeping.
- Concurrent test coordination: `Deferred`, `Queue`, `Latch`, `Ref`, or an
  explicit test hook.

## Boundary rules

- Keep RPC handlers thin: decode through the protocol, read middleware context,
  call domain operations or a simple Service capability, and preserve typed
  failures.
- Keep business rules in Cake domain functions, not RPC handlers or external
  adapters.
- Wrap Promise SDKs, CLIs, native APIs, and external integrations in named
  Effects at the Service boundary and propagate cancellation.
- Decode persisted and cross-process values with Schema.
- Keep provider/network calls outside authoritative storage transactions.
- Catch or retry only where the boundary has a truthful response.
- Preserve interruption. Retry only proven-idempotent operations and let
  exhausted failures remain visible unless product policy defines a fallback.
- Give every resource a Scope owner and every repeated operation an explicit
  concurrency policy.

## Do nots

- Do not use `as any`, non-null assertions, or unchecked casts to silence Effect
  typing problems.
- Do not use `Schema.Class` or `Schema.TaggedClass` as Cake's default data-model
  pattern.
- Do not hand-roll tagged error classes when `Schema.TaggedError` fits.
- Do not use cause-level recovery when typed-error recovery is sufficient.
- Do not use `Layer.mergeAll` or `provideMerge` as make-it-compile tools; each
  exposed dependency must be intentional.
- Do not hide application authority, persistence, credentials, transports, or
  external Services behind `Context.Reference` defaults.
- Do not use arbitrary real sleeps in tests.
- Do not hand-roll caches, TTL pruning, in-flight lookup deduplication, or keyed
  Fiber registries when an Effect primitive fits.
- Do not add a generic Service where Cake's architecture calls for free domain
  operations or a concrete dependency.
