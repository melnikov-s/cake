import type { Rpc, RpcClient, RpcClientError, RpcGroup } from "effect/unstable/rpc";

type TransportError = RpcClientError.RpcClientError;
type RpcDefinition = Rpc.Any & Pick<Rpc.AnyWithProps, "payloadSchema" | "successSchema">;

// Invoke without RpcClient's optional queue/discard modes. This keeps Effect's
// own default call signature (including middleware failures and schema services).
const invoke = <R extends RpcDefinition>(
  client: RpcClient.RpcClient.Flat<R, TransportError>,
  tag: R["_tag"],
  payload: Rpc.Payload<R>,
) => client(tag, payload);

type Method<R extends RpcDefinition> = [Rpc.Payload<R>] extends [void]
  ? () => ReturnType<typeof invoke<R>>
  : (payload: Rpc.Payload<R>) => ReturnType<typeof invoke<R>>;

type RuntimeMethod<R extends RpcDefinition> = (
  payload: Rpc.Payload<R>,
) => ReturnType<typeof invoke<R>>;
type RuntimeGroups<R extends RpcDefinition> = Record<string, Record<string, RuntimeMethod<R>>>;

type GroupName<R extends RpcDefinition> = R["_tag"] extends `${infer Group}.${string}`
  ? Group
  : never;

export type GroupedRpcClient<R extends RpcDefinition> = {
  readonly [Group in GroupName<R>]: {
    readonly [
      Operation in R as Operation["_tag"] extends `${Group}.${infer Name}` ? Name : never
    ]: Method<Operation>;
  };
};

/** Group generated RPC methods by their protocol tags; no second endpoint list. */
export function groupRpcClient<R extends RpcDefinition>(
  group: RpcGroup.RpcGroup<R>,
  client: RpcClient.RpcClient.Flat<R, TransportError>,
): GroupedRpcClient<R> {
  const groups: RuntimeGroups<R> = {};
  for (const rpc of group.requests.values()) {
    const [name, operation, extra] = rpc._tag.split(".");
    if (!name || !operation || extra !== undefined)
      throw new Error(`Expected a group.operation RPC tag: ${rpc._tag}`);
    const methods = (groups[name] ??= {});
    if (Object.hasOwn(methods, operation)) throw new Error(`Duplicate RPC tag: ${rpc._tag}`);
    const method = (payload: Rpc.Payload<R>) => invoke(client, rpc._tag, payload);
    // Void methods are called with no arguments; JS supplies undefined to the
    // same generated invocation without a second forwarding implementation.
    methods[operation] = method;
  }
  // SAFETY: the checked group.operation split constructs exactly the mapped
  // keys, each delegating to its typed tag. Only key/signature correlation was
  // erased while iterating the heterogeneous Map; this narrows that dictionary.
  // oxlint-disable-next-line anti-slop/no-known-value-widening
  return groups as GroupedRpcClient<R>;
}
