# Core API and modeling

## Placement

| Concern                                     | Owner        |
| ------------------------------------------- | ------------ |
| Validated domain data and invariants        | Model        |
| Identity, references, owned domain children | Model schema |
| Session/view state and async workflows      | Store        |
| Resources, fibers, subscriptions            | Store Scope  |
| Tiny DOM-only state                         | UI framework |

Models are inert domain trees. Stores are scoped behavioral components.

## Models

```ts
const Todo = createModel(
  "Todo",
  Schema.Struct({
    id: Model.id(Schema.Number),
    title: Schema.String,
    done: Schema.Boolean,
    draft: Model.transient(Schema.optional(Schema.String)),
  }),
  (self) => ({
    rename: (title: string) => self.title.set(title),
    toggle: () => self.done.update((done) => !done),
  }),
);

const todo = yield * Todo.make({ id: 1, title: "Write", done: false });
```

`ModelFactory.make` is the only constructor. It decodes the complete input and
returns Schema issues or `IdentityCollisionError` in the Effect error channel.
Direct field writes validate synchronously and throw on trusted invariant
violations.

Markers take schemas, not factories, and should be applied last:

- `Model.id(schema)`: one mutable, non-empty identity field.
- `Model.child(Child.schema)`: owned child; wrap with `Schema.Array` for lists.
- `Model.modelRef(Target.schema)`: non-owning reference, public value target or
  `null`; reference arrays expose only available targets.
- `Model.transient(schema)`: omitted from snapshot capture/application.

Each root owns an isolated identity namespace. `Model.findById(anchor, Target,
id)` searches the anchor's ownership root. Removing an owned child detaches it
without disposal. Attaching an already-owned child is forbidden. Dispose only
a root or detached Model with `[Symbol.dispose]()`.

## Refs and graph topology

A `Ref<A>` exposes `.value`, `.set`, `.update`, and `.subscribe`. Reads inside
an Effect derived Atom, Store getter, or projector become upstream graph edges.
When a component reads a computed, topology remains:

```text
component -> computed Atom -> source Atoms
```

A derived read must not also register direct component-to-source edges. Writes
during derived evaluation throw. Arrays and objects are shallow values and
must be replaced immutably. Use `batch` for one logical transaction.

The package owns one internal `AtomRegistry`; applications cannot select or
provide another registry. `refStream(ref)` delegates state streaming to the
upstream registry.

## Stores

```ts
const Search = createStore(
  "Search",
  Store.schema({
    props: { initialQuery: Store.prop<string>() },
    query: Schema.String,
    selectedId: Store.snapshot(Schema.NullOr(Schema.String)),
  }),
  function* ({ self, props: { initialQuery }, autorun }) {
    const api = yield* SearchApi;
    autorun("logMount", () => Effect.log("search mounted"));

    return {
      setQuery: (query: string) => self.query.set(query),
      search: () => api.search(self.query.value),
      get normalizedQuery() {
        return self.query.value.trim().toLowerCase();
      },
    };
  },
);
```

State fields are Refs and are ephemeral unless marked with
`Store.snapshot(schema)`. Props are required exactly as declared, arrive as
stable Ref handles, are absent from the instance, and are never snapshotted.
Use `updateStore(instance, { props: patch })` for batched prop changes.

Initializers may be synchronous or Effect generators. Generator requirements
and errors flow through `StoreFactory.make`. Initializers acquire services and
methods close over concrete implementations. Every Effect-returning bag method
must already have `R = never`; the type system rejects an open method
environment. Declared `autorun` programs are effectful Atoms mounted after
hydration and owned by the Store Scope. Function bodies track synchronous Ref
reads and must return an Effect; use Effect resource operators for cleanup.

Core methods preserve their return type. Effect methods remain lazy Effects;
synchronous methods remain synchronous. React adaptation is separate.
Computed bag getters are lazy upstream derived Atoms. Bag keys cannot collide
with fields or child collections.

## Construction and mounting

```ts
const scoped = Effect.scoped(
  Effect.gen(function* () {
    const search = yield* Search.make({
      props: { initialQuery: "state" },
      query: "state",
      selectedId: null,
    });
    yield* search.search();
  }),
);

const handle = yield * mount(Search, input);
yield * handle.dispose;
```

`.make` requires an enclosing Scope. `mount` allocates an owned Scope,
preserves requirements/errors, and closes the Scope if construction fails.
Store disposal is Scope closure.

## Child Stores

```ts
const Row = createStore(
  "Row",
  Store.schema({ props: { todo: Store.prop<TodoInstance>() } }),
  (_self, { todo }) => ({ toggle: () => todo.value.toggle() }),
);

const ListView = createStore(
  "ListView",
  Store.schema({
    props: { list: Store.prop<ListInstance>() },
    rows: Store.children(Row),
  }),
  (_self, { list }) => ({
    rows: () =>
      list.value.todos.value.map((todo) => ({
        key: todo.id.value,
        store: Row,
        props: { todo },
      })),
  }),
);

const rows = yield * listView.rows;
```

Every collection declares at least one allowed factory. Projector output is
validated completely before reconciliation: it must be an array, keys must be
unique strings/numbers, factories must be declared, and props must be objects.
Projectors are pure derived Atoms; writes during evaluation are defects.

A collection is one logical slot and one core Effect read. Child construction
is lazy. The slot starts a child Fiber in an owned child Scope and immediately
polls it:

- synchronous success returns without Suspense or an extra render;
- synchronous failure is cached and fails immediately;
- genuine suspension enters `Pending` and waits for slot readiness.

Readers share initialization. A changed descriptor generation interrupts and
closes superseded attempts. Stale completion cannot publish. Empty desired
state commits immediately. Collections publish only a complete ordered roster,
never a partial or stale roster. Failure remains cached until descriptor
identity changes.

## Snapshots

```ts
const current = toSnapshot(value);
yield * applySnapshot(value, externalUnknown);
const changes = onSnapshot(value);
```

`toSnapshot` is synchronous and typed. `applySnapshot` accepts `unknown`,
requires a complete snapshot, and returns `Effect<void, SnapshotError>`.
`onSnapshot` is a current-first Stream. There are no callback, diff, separate
snapshot-stream, or built-in persistence APIs.

Model snapshots recursively encode owned children and reference wires and omit
transients. Store snapshots include only `Store.snapshot` fields plus every
declared keyed child collection:

```ts
{
  state: { selectedId: "a" },
  children: { rows: [{ key: "a", snapshot: childSnapshot }] },
}
```

Failed application restores the previous snapshot and original owned
instances before surfacing the original error. A rollback failure is an
invariant defect retaining both causes. Applying a Store snapshot records
snapshots for unrealized child keys without constructing them. Delayed child
hydration completes before publication and autorun activation.

## Operations

Ordinary Store methods are operations automatically. Getters and projectors
are excluded. Effect operations start only when executed, are forked into the
Store Scope, and remain linked to caller interruption. Store disposal
interrupts active/late Effects; synchronous late methods throw.

`onOperation(root)` streams completed records from the root and projected
descendants. It is live-only and records no arguments or success values.
Effect operations receive tracing spans with Store path and operation identity
attributes.
