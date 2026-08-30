# Lifetime and asynchronous ownership

## Scope is lifetime

A Store created with `yield* Factory.make(...)` belongs to the enclosing Scope.
`mount(...)` creates an owned root Scope and returns a `dispose` Effect.
Projected children own child Scopes. Removal, replacement, supersession, parent
disposal, and failed construction close the appropriate Scope.

Models have no Scope. Dispose a terminal root or detached Model with
`[Symbol.dispose]()`; never dispose an attached child directly.

## Autoruns

The initializer's `autorun` parameter registers Store-owned effectful Atoms:

```ts
const Factory = createStore("Factory", spec, function* ({ self, props, autorun }) {
  autorun("logQuery", () => {
    const query = self.query.value; // tracked read: re-runs when it commits
    return Effect.log(`Query changed to: ${query}`);
  });
  return bag;
});
```

The Store mounts each Atom only after publication and mount-time snapshot
hydration. A bare `Effect` runs once and tracks nothing. A function reads Refs
and computed values synchronously while producing an Effect. Effect's Atom
runtime records those dependencies, closes the previous evaluation Scope when
a dependency changes, and evaluates the function again. `untracked` excludes
reads from that dependency set.

Bodies always return ordinary Effects. Model resources with
`Effect.acquireRelease`, scoped Layers, Stream finalizers, or
`Effect.addFinalizer`; callback cleanup functions are not a second cleanup
protocol. Unhandled causes are logged. Do not synchronously write Store state
while the Atom is discovering dependencies.

`AtomRegistry.mount` binds every declared Atom to the Store Scope. Store
disposal releases the mount; Atom disposal removes dependency subscriptions,
interrupts active work, and runs the current evaluation's Effect finalizers.
The Atom runtime therefore owns tracking, scheduling, and per-run lifetime—this
package only controls post-hydration activation and Store ownership. Never
launch unscoped application work with `Effect.runFork`.

## Store operations

A Store method returning an Effect is still lazy in core:

```ts
const operation = store.refresh(); // starts nothing
yield * operation; // starts one owned operation Fiber
```

The runtime instruments the Effect when it executes, forks it into the Store
Scope, and joins it from the caller. Therefore:

- Store disposal interrupts active operations;
- caller interruption interrupts the operation it awaits;
- success and typed failure are preserved;
- an Effect first run after disposal interrupts immediately;
- a synchronous method called after disposal throws;
- constructing/discarding an Effect records no execution.

The React facade is only a boundary conversion from Effect to Promise; it does
not provide Store ownership.

## Concurrency policy

Scope ownership answers terminal lifetime, not repeated-call behavior. Every
async intent still needs one explicit policy:

- ignore while active;
- share one in-flight operation;
- interrupt previous;
- latest result wins;
- queue;
- run concurrently with isolated outcomes.

A loading Ref is not a concurrency policy. For latest-wins work, interrupt the
prior Fiber or guard commits with a generation/revision. Check cancellation or
revision after uncancellable external boundaries before committing. Batch one
successful multi-Ref transition.

Prefer direct consequences at the authoritative method or callback. Add a
Stream only when sources genuinely change independently; do not write an event
to a Ref merely to rediscover it through a reaction.

## Polling and timers

Use Effect Clock and self-scheduling loops instead of `setInterval`:

```ts
const poll = Effect.forever(refresh.pipe(Effect.andThen(Effect.sleep("30 seconds"))));

autorun("poll", poll);
```

Use `TestClock` for deterministic tests. Effect timers and Streams are
interrupted with their evaluation Scope. Wrap native timers or external
callback subscriptions in `Effect.acquireRelease`.

## Lazy child construction

A projector synchronously computes desired descriptors, but Store construction
for those descriptors may itself complete synchronously, suspend, or fail.
Projectors must not perform I/O, start Fibers, mutate Refs, or await work.

The collection slot owns construction state outside React:

```ts
type SlotState<A> =
  | { _tag: "Uninitialized" }
  | { _tag: "Pending"; generation: number; gate: Promise<void> }
  | { _tag: "Ready"; value: A }
  | { _tag: "Failed"; cause: Cause.Cause<unknown> };
```

On first read, the slot starts construction immediately and polls the Fiber.
Only genuine suspension creates a readiness gate. Multiple readers share the
same attempt and state. React throws the stable gate; core callers await the
Effect.

A descriptor change increments generation. Pending superseded Fibers are
interrupted and their Scopes close. The existing gate may remain pending while
the latest generation constructs. Stale completion never publishes. Latest
empty state publishes immediately without waiting for cleanup.

Collections prepare synchronously completed and reused entries privately, then
commit the complete roster in projector order. They never expose progressive
subsets or stale-while-revalidate values.

Construction failure is cached for the current descriptor. A retry requires a
different application-owned key/generation; there is no first-class retry API.

Disposal interrupts pending construction and terminates pending core reads
through ordinary Effect interruption.

## Snapshots and persistence wiring

Snapshot capture/application belongs to the library; storage does not. Build
persistence with application services and Streams:

```ts
autorun(
  "persist",
  onSnapshot(model).pipe(
    Stream.debounce("250 millis"),
    Stream.runForEach((snapshot) => storage.write(snapshot)),
  ),
);
```

Hydration order is:

1. load and parse external data;
2. `yield* applySnapshot(value, data)`;
3. choose an explicit fallback if validation fails;
4. subscribe to future snapshots only after hydration;
5. bind the writer to its owner Scope.

This prevents defaults from overwriting saved state. Versioning and migration
belong before `applySnapshot` at the application boundary.

Applying a Store snapshot never realizes lazy children. Pending keyed snapshots
remain encoded for the parent's lifetime. When a matching descriptor is first
read, snapshot decoding, hydration, construction, and autorun activation finish
before that child enters the complete public roster.

Failed application rolls back before notifications escape. Destructive child
Store cleanup and autorun activation happen only on commit, so rollback can
restore original instances and ownership edges.

## Disposal review

- Every root Store Scope closes on teardown.
- Every operation, Fiber, stream, timer, subscription, and resource has an
  explicit owner.
- Superseded child attempts are interrupted and generation-guarded.
- Removed child Scopes close only after the replacement roster commits.
- Pending child reads terminate when the parent dies.
- Detached Models are either reattached or explicitly disposed.
- No callback commits after interruption or a newer operation generation.
