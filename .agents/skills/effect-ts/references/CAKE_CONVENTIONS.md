# Cake Effect conventions

Read this reference for every Cake Effect change. It applies the general Effect
best practices to Cake's normative architecture.

## Authority and dependency direction

Cake's architecture decides what is a Service, domain operation, RPC operation,
or renderer Store:

```text
renderer Store → RendererClient Promise adapter → CakeIpcClient → Effect RPC
renderer projection synchronizer → CakeIpcClient Stream → r-state-tree Model
CakeIpcServer → free Cake domain Effects → outside-world Services
```

- Services represent outside-world, native, persistence, process, or transport
  boundaries. They own scoped resources when necessary.
- Cake business policy belongs in cohesive free domain `Effect.fn` operations.
  Domain modules are not Context Services.
- RPC handlers delegate. They do not implement Cake business policy.
- Ordinary renderer Stores consume the Promise-based `RendererClient` and never
  import Effect, `CakeIpcClient`, RPC contracts, main Services, or domain
  implementations. Projection synchronizers are the renderer Effect/Stream
  boundary: they apply authoritative snapshots with `applySnapshot` and reduce
  ordered Events transactionally, using direct, batched r-state-tree Model
  mutations for incremental entity changes.
- Pi packages stop beneath `src/services/pi`. Raw Pi values do not cross RPC.
- Pi remains transcript authority. Effect Streams and renderer Models are
  projections, not new durable authorities.

## Services and operations

Define public Service members as functions, including zero-argument operations:

```ts
export class Records extends Context.Service<
  Records,
  {
    readonly load: () => Effect.Effect<RecordSnapshot, RecordLoadError>;
    readonly save: (snapshot: RecordSnapshot) => Effect.Effect<void, RecordSaveError>;
  }
>()("cake/services/records/Records") {}
```

Implement public and non-trivial internal operations with names:

```ts
const load = Effect.fn("Records.load")(function* () {
  // ...
});
```

Avoid Effect values such as `readonly load: Effect.Effect<...>` in Service
interfaces. Function-valued operations give each invocation a named trace and
compose naturally in test Services.

Promise APIs are permitted only at an external or framework adapter boundary.
Wrap them with `Effect.tryPromise`, pass the supplied `AbortSignal`, map expected
failures to `Schema.TaggedError`, and expose Effect from a main-side Service. In
the renderer, the permanent typed `RendererClient` deliberately executes the
authoritative Effect client as Promises for r-state-tree Stores. It must
propagate cancellation and must not define another protocol or domain
abstraction.

## Layers and runtime wiring

- Cake main owns one `ManagedRuntime`; each renderer window owns its one renderer
  runtime. Feature modules do not construct parallel runtimes.
- Use `Layer.succeed` only for an already-built implementation,
  `Layer.sync` for lazy synchronous construction, and `Layer.effect` for
  effectful acquisition.
- Acquire clients and long-lived resources once in their owning Layer/Scope.
- Fork listeners, Streams, and workers with `Effect.forkScoped` so Layer
  acquisition completes.
- Use `Layer.provide` when an implementation dependency should be hidden and
  `provideMerge` only when it intentionally remains available downstream.
- Name Layer subgraphs and keep runtime composition topologically legible.
- Bootstrap must not evaluate user plugin code or acquire optional project,
  session, terminal, or editor resources.

## Schemas and optional keys

For new Effect-owned records, prefer:

```ts
export const Project = Schema.Struct({
  id: ProjectId,
  name: Schema.NonEmptyString,
  description: Schema.optionalKey(Schema.String),
});

export interface Project extends Schema.Schema.Type<typeof Project> {}
```

Use the representation that matches the encoded contract:

- `Schema.optionalKey(S)`: the JSON, RPC, or persisted key may be absent;
- `Schema.optional(S)`: the key/value contract deliberately includes explicit
  `undefined`;
- null unions only when null is an actual encoded value.

Do not make required domain values optional for constructor convenience. Decode
unknown persisted, RPC-transport, plugin, and Pi-adapter values at their
receiving boundary. Use non-throwing/effectful decoding in runtime paths.

Use constrained branded Schemas for stable IDs as new contracts are introduced.
Do not convert existing IDs in unrelated changes; migrate a complete vertical
contract and all callers together.

## Errors and recovery

- Expected operational failures use `Schema.TaggedError` and remain in the typed
  error channel.
- Adapter errors include an operation label and useful diagnostic evidence when
  several calls can fail in the same Service.
- Use typed-error recovery for expected failures. Cause-level recovery belongs
  only at explicit runtime/supervision boundaries.
- Never swallow interruption. A fallback catches exactly the failures for which
  that fallback is truthful.
- Main runtime and renderer error boundaries report defects; ordinary domain
  code does not turn defects into generic user-facing failures.

## Lifetimes, concurrency, and caching

For every resource or repeated asynchronous intent, state:

1. authority;
2. owner;
3. lifetime and Scope;
4. persistence boundary;
5. concurrency policy.

Use Effect primitives rather than mutable registries when they match:

- `Effect.cached` for one memoized effect;
- `Cache` for bounded keyed lookup memoization and concurrent miss sharing;
- `ScopedCache` for cached resources requiring finalization;
- the installed keyed Layer/resource primitive for dynamic scoped resources;
- `FiberMap`/`FiberSet` for keyed or grouped child Fibers;
- `Queue`, `PubSub`, or `SubscriptionRef` for producer/consumer boundaries.

Do not hand-roll `let pending: Promise`, Map-plus-TTL caches, or maps of Fibers.
If no Effect primitive preserves the required semantics, document the mismatch
and encapsulate one named helper rather than scattering mutable bookkeeping.

## Streams

- Observations begin with one coherent authoritative Snapshot and then ordered
  Events without a subscription gap.
- Expose Streams to consumers, not producer queues or mutable subscription
  registries.
- Use `PubSub` when every subscriber sees every event and `SubscriptionRef` when
  consumers need current state plus updates.
- Consume long-lived Streams in an owning Scope with `Stream.runForEach` and
  `Effect.forkScoped`.
- Preserve lossless transcript events. Buffer, debounce, coalesce, or drop only
  where the domain contract explicitly permits it.
- Reconnect through a fresh authoritative Snapshot; never create a Cake-owned
  transcript log to repair a Stream gap.

## Configuration and clocks

Effect application logic reads environment-backed configuration with `Config`.
Direct `process.env` access is acceptable only at the minimal pre-runtime
Electron/bootstrap boundary or untouched legacy code awaiting its vertical
migration. New Services receive decoded configuration through Layers.

Use `DateTime`, `Clock`, and `Schedule` for testable time, deadlines, retry,
polling, and pacing. Do not implement sleep loops manually.

## Testing

New Effect-focused tests use `@effect/vitest` when available:

- `it.effect` for Effect tests;
- `it.live` only when live time/runtime behavior is under test;
- Test Layers for Services;
- `TestClock` for timeout, retry, debounce, lease, and schedule behavior;
- `Deferred`, `Queue`, `Latch`, `Ref`, or explicit hooks for concurrency;
- assertions for typed failures, interruption, finalization, rollback,
  idempotency, and concurrency laws.

Do not coordinate a unit test with arbitrary elapsed time. Real Electron tests
remain Playwright tests and prove the actual process boundary after a build.

## Review checklist

Before accepting an Effect slice, verify:

- every Effect-returning operation is named appropriately;
- zero-argument Service operations are functions;
- Layer acquisition and exposed dependencies are intentional;
- optional fields use the correct encoded semantics;
- untrusted inputs decode without unchecked casts;
- expected failures are typed and interruption is preserved;
- fallback and retry policies catch only truthful cases;
- external calls occur outside authoritative storage transactions;
- resources and background work have Scope owners;
- repeated work has an explicit concurrency policy;
- no manual cache, in-flight Promise, or Fiber registry duplicates an Effect
  primitive;
- tests use deterministic Effect time and synchronization;
- RPC remains one Schema-validated protocol;
- Cake/Pi authority and renderer sandbox boundaries remain unchanged.
