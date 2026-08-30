# Architecture and refactoring

## Classify ownership first

Before changing a feature, identify:

- durable domain entities and their Model root;
- session/workflow state and its Store owner;
- local framework state and why it stays local;
- persistence/hydration boundary;
- every resource and its Scope;
- every async intent and its repeated-call policy;
- external systems represented by Effect services/Layers.

Place state in the nearest cohesive owner, not the nearest existing file.

## Models own domain facts

A Model owns:

- Schema and wire contract;
- identity and non-owning references;
- owned nested domain entities;
- synchronous invariant-preserving mutations;
- pure domain queries.

Models are inert. Do not put services, Fibers, timers, subscriptions, mounted
state, or framework effects in a Model. Do not add a Store that merely forwards
every Model field and method.

Use aggregate methods for invariants. Prefer `list.removeTodo(id)` over a child
reaching through `parent` to mutate its owner.

## Stores own behavior and lifetime

A Store owns:

- session/orchestration Refs and computed getters;
- resources, Streams, Fibers, and cancellation;
- Effectful intents and their state transitions;
- projected child Stores;
- dependencies acquired from Effect services.

Root/application Stores are composition boundaries, not automatic owners for
all product workflows. Extract a focused Store when a subsystem has its own
state, resource lifetime, concurrency policy, reuse, or coherent UI/workflow
surface. Do not split solely to reduce file length.

A child Store should be a real behavioral component. Avoid forwarding wrappers,
action-named one-command Stores, duplicate facades, and children whose only
purpose is hidden mount work.

## Composition

Reuse factories rather than inheritance. Each `.make` creates an independent
instance, Scope, operation stream, and child tree. Variation comes from props,
Effect services/Layers, narrow callback capabilities, and intent methods.

Use `Store.children(...)` for state-selected keyed children. Its projector only
declares desired descriptors; it does not start work. Consumption through the
collection Effect realizes the complete roster lazily.

Always-present Stores may be composed directly with `yield* Child.make(...)`
in an enclosing Scope when they are genuinely part of construction rather than
a state-selected collection.

## Public APIs

Expose intent methods such as `retryLoad`, `selectItem`, or
`tryExitFocusMode`, not transport envelopes or sets of Refs callers must
coordinate. Keep command preconditions with the command owner and batch its
multi-field transition there.

Use semantic computed queries such as `canSubmit` when they hide representation
rather than mechanically forwarding state.

Core async methods return Effects. React facade methods return Promises. Keep
raw Store and `ReactStore<...>` types distinct across component props.

## Services and transport

Workflow Stores depend on intent-level services:

```ts
interface ImportClientShape {
  startImport(input: ImportInput): Effect.Effect<void, ImportError>;
  cancelImport(id: string): Effect.Effect<void, ImportError>;
  events: Stream.Stream<ImportEvent, ImportError>;
}
```

Adapters privately map those methods to HTTP/RPC/IPC details. Keep endpoint
paths, command discriminants, correlation DTOs, wire validation, and transport
error unions out of ordinary workflow Stores. Compose production/test/branch
implementations with Layers.

Use props for parent-owned changing inputs and Effect Context for ambient
capabilities. Do not pass competing versions of the same dependency through
both channels.

## Reactive audit

For every computed getter or projector:

- read current Ref `.value`s during evaluation;
- do not capture a one-time value that should remain live;
- do not write state, start work, or perform I/O;
- use stable unique keys and declared factories;
- replace Ref-held arrays/objects immutably.

Effect Atoms own the graph. Never add another dependency tracker, cache,
registry provider, deferred-write queue, or notification scheduler.

For every Stream/subscription:

1. identify all source writers;
2. check whether an authoritative method already has the event;
3. move domain repairs into a Model method;
4. confirm the sources are genuinely independent;
5. assign the work a Scope and cleanup path.

## Async audit

Every workflow has two separate policies:

1. **Lifetime:** which Scope interrupts it?
2. **Concurrency:** what happens when invoked again?

Use interruption, revisions, queues, semaphores, or explicit sharing for
concurrency. Loading/error Refs communicate state but enforce no policy.
Prevent old operations from committing after newer results.

Projected child construction adds another generation boundary. Superseded
construction must be interrupted, closed, and unable to publish. A collection
cannot expose partial or stale rosters.

## Snapshot and persistence boundaries

Models commonly supply durable domain snapshots. Store fields participate only
when marked with `Store.snapshot`; props never do. Applying a snapshot is a
complete validation boundary and an Effect.

Storage is application policy:

1. load and migrate external data;
2. apply the complete snapshot;
3. choose fallback explicitly on failure;
4. subscribe to the current-first snapshot Stream;
5. bind persistence work to a Scope.

Test malformed snapshots for rollback of values, identity, ownership, realized
Store instances, pending child intent, and notifications. Verify applying a
Store snapshot does not realize unused children.

## Migration from r-state-tree or legacy revisions

Translate concepts, not syntax:

| Legacy concept                             | Current API                                                   |
| ------------------------------------------ | ------------------------------------------------------------- |
| Model class/decorator                      | `createModel(name, Schema.Struct(...), bag)`                  |
| observable field                           | flattened `Ref`                                               |
| `@id`, `@child`, `@modelRef`, `@transient` | Model Schema annotations                                      |
| implicit child creation on assignment      | `yield* Child.make`, then attach                              |
| root/child `.detach()`                     | ownership removal; `[Symbol.dispose]()` for terminal disposal |
| Store class                                | `createStore(name, Store.schema(...), initializer)`           |
| Store Context walk                         | `Context.Service` and Layers                                  |
| durable Store marker                       | `Store.snapshot(schema)`                                      |
| synchronous child view / `.value`          | `yield* rawStore.children`                                    |
| infallible/eager child construction        | lazy slot Effect with sync fast path                          |
| Store method Promise in core               | raw Effect; Promise only through `useStore`                   |
| callback snapshot/diff APIs                | `onSnapshot` Stream composition                               |
| built-in persistence                       | application service + snapshot Stream                         |
| per-root/custom AtomRegistry               | one internal package-global registry                          |
| deferred writes in projectors              | invariant violation                                           |
| provider-owned lifetime                    | Effect Scope ownership                                        |

Do not introduce compatibility wrappers unless a concrete migration requires a
temporary, explicitly isolated boundary.

## Review checklist

- Domain facts and invariants remain in Models.
- Workflows and resources have focused Store owners.
- Root Stores coordinate rather than absorb unrelated behavior.
- Methods expose intent and preserve Effect error/result types.
- Every method environment is closed at construction.
- Every Fiber/resource has Scope and concurrency policies.
- Getters/projectors read live values and never write.
- Child generations, complete roster publication, failure caching, and lazy
  hydration are tested.
- Snapshot rollback preserves owned instances and emits no failed commit.
- Persistence uses snapshots, not live Models/Refs.
- React provider topology remains separate from Scope topology.
- Raw Stores and React facades are not type-confused.
