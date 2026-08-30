---
name: effect-state-tree
description: Build, review, debug, or refactor applications using effect-state-tree Models, Stores, Refs, snapshots, scoped lifecycle, Effect services, lazy projected child Stores, operation observability, or React/Suspense integration.
---

# effect-state-tree

Use the installed package's `README.md`, public exports, source, and tests as
the authority. This skill describes the current API only; do not restore
legacy r-state-tree APIs, decorators, Store classes, persistence helpers,
custom registries, synchronous child views, or historical design proposals.

## Workflow

1. Inspect the package version, Effect version, repository instructions, and
   the existing Model/Store ownership boundaries.
2. Classify state:
   - durable domain facts and invariants → Model;
   - session state, workflows, resources, and cancellation → Store;
   - focus, measurement, animation, or isolated drafts → framework-local.
3. Identify the Scope owner of every Store, Fiber, stream, timer,
   subscription, and asynchronous operation.
4. Identify each async intent's repeated-call policy independently from its
   terminal Scope lifetime.
5. Implement through Schema, Refs, Effect services/Layers, Scope, Stream,
   snapshots, and the explicit React facade.
6. Verify types, cleanup, rollback, notification counts, lazy child behavior,
   and React Strict Mode/Suspense behavior where relevant.

## Non-negotiable API rules

- Create Models with `createModel(name, Schema.Struct(...), init?)`; construct
  them with `yield* Factory.make(input)`. Model initializers and behavior are
  synchronous and service-free.
- Model fields are flattened Refs. Use `Model.id`, `Model.child`,
  `Model.modelRef`, and `Model.transient` as outermost Schema annotations.
- Owned Model fields accept constructed children after initial construction.
  Remove before reattaching; never reparent implicitly.
- Dispose only a root or detached Model with `[Symbol.dispose]()`. There is no
  public `detach()` or `.dispose()` method.
- Create Stores with `createStore(name, Store.schema(spec), initializer)`.
  Bind `.make(...)` to an enclosing Scope or use Effectful `mount(...)` and
  run the returned `dispose` Effect.
- Store state is ephemeral unless marked with `Store.snapshot(schema)`. Props
  live only under the schema's `props` section, arrive as Ref handles in the
  initializer's second argument, and are updated with `updateStore`.
- Initializers acquire services. Every Effect-returning public method must
  already have `R = never`; never hide an uncaptured service requirement.
- Raw core Store methods remain lazy Effects. Only `useStore(Tag)` converts
  them to Promises at the React boundary.
- Store operations are owned by the Store Scope and caller lifetime. Disposal
  interrupts active and late Effect operations; synchronous late calls throw.
- Register Store-owned effectful Atoms with `autorun(name, body)`. Bare Effects
  run once after hydration. Function bodies synchronously read dependencies and
  return Effects; Effect's Atom runtime re-evaluates them when tracked state
  commits. Use Effect resource operators for cleanup. The Store Scope owns the
  Atom mount and unmount.
- Declare child collections with `Store.children(Factory, ...)` and return a
  same-named pure projector of `{ key, store, props }` descriptors.
- Raw child access is one Effect: `const rows = yield* store.rows`. There is no
  core `.value`, `.await`, Promise, or direct synchronous child API.
- Child construction is lazy, may fail or suspend, uses a synchronous Fiber
  poll fast path, caches by descriptor, and commits complete rosters
  atomically. Never assume child construction is infallible or eager.
- Do not write reactive state inside a computed getter or projector. Effect
  owns the graph; writes during derived evaluation are invariant violations.
- Use only the package-global reactive graph. Do not add registry options,
  registry providers, custom computed caches, or deferred notification
  engines.
- `applySnapshot` accepts a complete unknown snapshot and returns an Effect.
  Failed application must restore prior values and owned instances. Store
  snapshots never force unrealized children.
- `onSnapshot` is a current-first Stream. Persistence, migration, diffing,
  debounce, and storage belong to application Effects and services.
- `onOperation` is live-only and privacy-preserving. Instrumentation must not
  execute discarded Effects or change values, errors, interruption, or
  batching.

## React rules

- Import `observer`, `useAtomRef`, `useComputed`, `StoreProvider`, `useStore`,
  and `useOptionalStore` from `effect-state-tree/react`.
- Providers are keyed by class-style Effect service tags and control lookup
  only—not Store lifetime.
- `useStore(Tag)` returns a stable recursive facade. Effect methods return
  Promises; child collections read synchronously or suspend; descendant Stores
  remain facades.
- `observer` tracks direct top-level reactive reads. Effect owns dependencies
  beneath computed Atoms; do not create component-to-source duplicate edges.
- Mount Stores outside render. React retries and Strict Mode must never start
  duplicate child construction.

## Engineering rules

- Treat arrays and objects in Refs immutably and batch logical multi-Ref
  transitions.
- Prefer intent methods and domain methods over exposing coordination details.
- Keep transport envelopes behind narrow Effect services.
- Do not create forwarding Stores or projected children solely for hidden
  startup work.
- Keep projectors declarative, keyed, deterministic, and side-effect-free.
- Keep implementation assertions localized to real runtime protocol
  boundaries and document why each assertion is valid.

## References

- [references/core-api.md](references/core-api.md): exact Model, Store, child,
  snapshot, and operation API.
- [references/lifecycle-and-async.md](references/lifecycle-and-async.md): Scope,
  lifecycle, cancellation, concurrency, persistence wiring, and lazy child
  construction.
- [references/react.md](references/react.md): provider, observer, facade,
  Suspense, SSR, and Strict Mode behavior.
- [references/architecture-and-refactoring.md](references/architecture-and-refactoring.md):
  ownership, decomposition, service boundaries, and migration guidance.

## Completion check

- Construction and method Effect channels preserve their declared types.
- No Store method has an uncaptured environment requirement.
- Every resource and operation has a deliberate Scope owner.
- Child generations cannot publish stale instances; complete rosters commit
  atomically and failures are cached by descriptor.
- Snapshot failure restores values, identity, ownership, and realized Store
  instances without successful-change notifications.
- No snapshot realizes a lazy child.
- React adapts only at `useStore`, preserves facade identity, and uses stable
  slot wake-up Promises.
- `pnpm typecheck`, `pnpm test`, relevant example checks, and production builds
  pass in proportion to the change.
