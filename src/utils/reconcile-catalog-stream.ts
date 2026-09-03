import { Stream } from "effect";

type ScanEvent<Item> =
  | { readonly _tag: "Started" }
  | { readonly _tag: "Found"; readonly item: Item }
  | { readonly _tag: "Completed" };

interface ScanState<Item> {
  readonly visible: ReadonlyMap<string, Item>;
  readonly scanned: ReadonlyMap<string, Item>;
}

export type CatalogReconciliation<Item> =
  | { readonly _tag: "Upserted"; readonly item: Item }
  | { readonly _tag: "Removed"; readonly id: string };

/** Keeps the prior catalog visible until a refreshed lazy scan proves an item disappeared. */
export function reconcileCatalogScans<
  Refresh,
  Item,
  RefreshError,
  ScanError,
  RefreshServices,
  ScanServices,
>(
  refreshes: Stream.Stream<Refresh, RefreshError, RefreshServices>,
  scan: (refresh: Refresh) => Stream.Stream<Item, ScanError, ScanServices>,
  options: {
    readonly key: (item: Item) => string;
    readonly equals: (left: Item, right: Item) => boolean;
  },
): Stream.Stream<
  CatalogReconciliation<Item>,
  RefreshError | ScanError,
  RefreshServices | ScanServices
> {
  return refreshes.pipe(
    Stream.switchMap((refresh) =>
      Stream.make({ _tag: "Started" } satisfies ScanEvent<Item>).pipe(
        Stream.concat(
          scan(refresh).pipe(
            Stream.map((item) => ({ _tag: "Found", item }) satisfies ScanEvent<Item>),
          ),
        ),
        Stream.concat(Stream.make({ _tag: "Completed" } satisfies ScanEvent<Item>)),
      ),
    ),
    Stream.mapAccum(
      (): ScanState<Item> => ({ visible: new Map(), scanned: new Map() }),
      (state, event): readonly [ScanState<Item>, ReadonlyArray<CatalogReconciliation<Item>>] => {
        if (event._tag === "Started") return [{ ...state, scanned: new Map() }, []];
        if (event._tag === "Found") {
          const id = options.key(event.item);
          const scanned = new Map(state.scanned).set(id, event.item);
          const previous = state.visible.get(id);
          if (previous !== undefined && options.equals(previous, event.item))
            return [{ ...state, scanned }, []];
          return [
            { visible: new Map(state.visible).set(id, event.item), scanned },
            [{ _tag: "Upserted", item: event.item }],
          ];
        }
        const removed = [...state.visible.keys()]
          .filter((id) => !state.scanned.has(id))
          .map((id): CatalogReconciliation<Item> => ({ _tag: "Removed", id }));
        return [{ visible: state.scanned, scanned: state.scanned }, removed];
      },
    ),
  );
}
