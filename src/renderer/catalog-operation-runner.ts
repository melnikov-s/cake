import type { Effect } from "effect";

/** Temporary Phase-7 bridge allowing legacy Promise Stores to execute closed catalog Effects. */
export type CatalogOperationRunner = <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
