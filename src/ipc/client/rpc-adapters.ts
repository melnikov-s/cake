type BoundAdapters<Adapters> = {
  readonly [Key in keyof Adapters]: Adapters[Key] extends (
    client: infer _Client,
    ...args: infer Arguments
  ) => infer Result
    ? (...args: Arguments) => Result
    : never;
};

/** Bind the generated capability once; bind preserves each semantic adapter's arity. */
export function bindRpcAdapters<
  Client,
  Result,
  Adapters extends Record<string, (client: Client, ...args: never[]) => Result>,
>(client: Client, adapters: Adapters): BoundAdapters<Adapters> {
  const result: Record<string, (...args: never[]) => Result> = {};
  for (const [key, adapter] of Object.entries(adapters))
    result[key] = adapter.bind(undefined, client);
  // SAFETY: every key comes from Adapters and bind removes precisely its first
  // argument. This restores the key/signature correlation erased by entries.
  // oxlint-disable-next-line anti-slop/no-known-value-widening
  return result as BoundAdapters<Adapters>;
}
