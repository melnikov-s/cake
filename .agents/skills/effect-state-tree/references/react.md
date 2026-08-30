# React integration

Import bindings from `effect-state-tree/react`:

```ts
import {
  observer,
  StoreProvider,
  useAtomRef,
  useComputed,
  useOptionalStore,
  useStore,
} from "effect-state-tree/react";
```

## Provider boundary

`StoreProvider` maps class-style Effect service tags to raw mounted Stores:

```tsx
class WorkspaceTag extends Context.Service<WorkspaceTag, WorkspaceInstance>()("app/Workspace") {}

<StoreProvider stores={[[WorkspaceTag, workspace]]}>
  <Workspace />
</StoreProvider>;
```

`useStore(Tag)` returns the nearest Store facade and throws when absent.
`useOptionalStore(Tag)` returns `null` when absent. Nested providers merge maps
and inner entries override matching tags.

Provider ancestry is lookup only. It never constructs, mounts, reparents, or
disposes a Store. The Effect owner that called `.make` or `mount` remains
responsible for Scope closure.

## The React facade

Raw Stores remain Effect-native. `useStore` creates and caches a stable
recursive facade:

- Effect-returning methods become Promise-returning methods;
- synchronous methods, Refs, and computed getters retain their shape;
- child collection Effects become synchronous-or-Suspense roster reads;
- descendant Store instances become stable facades;
- Promise rejection carries typed failure, defect, or interruption across the
  React boundary.

```tsx
const Toolbar = () => {
  const store = useStore(WorkspaceTag);
  return <button onClick={() => void store.save()}>Save</button>;
};
```

The Promise adapter does not own operation lifetime; the raw Store Scope does.
Method and facade identities remain stable across renders.

## Reactive rendering

`observer(Component)` records top-level reactive sources read while the
component renders and connects them through `useSyncExternalStore`:

```tsx
const Counter = observer(function Counter() {
  const store = useStore(CounterTag);
  return <span>{store.count.value}</span>;
});
```

Effect owns dependency topology beneath computed Atoms. Reading a computed in
a component subscribes the component to that computed, not independently to
all of its source Refs.

Use `useAtomRef(ref)` for an explicit single-Ref subscription and
`useComputed(() => ...)` for an explicit derived subscription. A plain Ref read
outside `observer` or one of these hooks is not subscribed.

Do not mutate Refs during render or computed evaluation.

## Child collections and Suspense

```tsx
const Rows = observer(function Rows() {
  const list = useStore(ListTag);
  return (
    <ul>
      {list.rows.map((element) => (
        <Row key={element.key} store={element.instance} />
      ))}
    </ul>
  );
});
```

The facade reads the slot synchronously when possible:

- synchronously completing construction returns the complete roster in the
  same render and does not show a fallback;
- genuine suspension throws the slot's stable `Promise<void>` gate;
- React retries after the gate wakes and receives the slot's current roster;
- failure throws the cached error for an Error Boundary.

The gate represents latest desired slot readiness, not one construction Fiber.
If A is pending and B supersedes it, A is interrupted, the same gate can remain
pending, and only B readiness wakes the consumer. A stale completion cannot
publish.

A mounted child crossing the roster is recursively adapted, so its Effect
methods return Promises and its child collections have the same Suspense
behavior.

## Strict Mode and SSR

Slot state lives outside component render. Strict Mode, retry renders, and
multiple readers cannot duplicate child construction. Synchronous completion
may update slot cache during render, but subscription notifications are
queued rather than fired synchronously from render.

`useSyncExternalStore` supplies server snapshots. Store construction still
belongs outside render. For SSR, synchronous child construction can render
immediately; genuinely asynchronous child data requires the application's
chosen streaming/Suspense strategy.

Test:

- unrelated Ref updates do not rerender the component;
- several mounted Store instances remain isolated;
- method/facade identity is stable;
- synchronous child construction skips fallback;
- superseded pending children keep fallback until latest readiness;
- child errors reach an Error Boundary;
- unmounting the provider does not dispose the Store.

## Component boundaries

Keep focus, measurement, animation, browser listeners, and isolated drafts in
React. Keep shared workflow state and resources in Stores. Components should
read state and invoke intent methods instead of coordinating several low-level
Refs themselves.

Pass React Store facade types (`ReactStore<StoreInstance>`) when a facade child
is handed through component props. Do not type a facade as the raw Store: raw
Effect methods and adapted Promise methods intentionally differ.
