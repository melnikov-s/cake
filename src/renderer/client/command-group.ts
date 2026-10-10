import type { Effect } from "effect";
import { RpcSchema } from "effect/unstable/rpc";
import {
  CakeClientRpc,
  cakeIpcAdapters,
  type CakeIpcClientService,
} from "../../ipc/client/CakeIpcClient";
import type { ClientCommandOptions } from "./Client";

export type CommandGroup<Group> = {
  readonly [
    Key in keyof Group as Group[Key] extends (
      ...args: infer _Args
    ) => Effect.Effect<unknown, unknown>
      ? Key
      : never
  ]: Group[Key] extends (...args: infer Args) => Effect.Effect<infer Success, unknown>
    ? (...args: [...Args, options?: ClientCommandOptions]) => Promise<Success>
    : never;
};

type Execute = <Success, Failure>(
  operation: string,
  command: (client: CakeIpcClientService) => Effect.Effect<Success, Failure>,
  options?: ClientCommandOptions,
) => Promise<Success>;

type GroupName = Extract<keyof CakeIpcClientService, string>;
type CommandArguments = unknown[];
type ServiceMethod = {
  [
    Group in keyof CakeIpcClientService
  ]: CakeIpcClientService[Group][keyof CakeIpcClientService[Group]];
}[keyof CakeIpcClientService];
type CommandEffect = Extract<ReturnType<ServiceMethod>, Effect.Effect<unknown, unknown>>;
type RuntimeCommand = (
  ...args: CommandArguments
) => Effect.Effect<Effect.Success<CommandEffect>, Effect.Error<CommandEffect>>;
type RuntimePromiseCommand = (...args: CommandArguments) => Promise<Effect.Success<CommandEffect>>;

/** Adapt unary RPC commands only; observations remain on the runtime's Stream path. */
export function makeCommandGroup<Group extends GroupName>(
  group: Group,
  execute: Execute,
): CommandGroup<CakeIpcClientService[Group]> {
  const adapters = Object.entries(cakeIpcAdapters).find(([name]) => name === group)?.[1];
  const commands: Record<string, RuntimePromiseCommand> = {};
  for (const rpc of CakeClientRpc.requests.values()) {
    if (!rpc._tag.startsWith(`${group}.`) || RpcSchema.isStreamSchema(rpc.successSchema)) continue;
    const name = rpc._tag.slice(group.length + 1);
    const adapter = adapters && Object.entries(adapters).find(([key]) => key === name)?.[1];
    const arity = adapter ? adapter.length - 1 : rpc.payloadSchema.ast._tag === "Void" ? 0 : 1;
    commands[name] = (...args: CommandArguments) => {
      // SAFETY: CommandGroup appends options after the semantic argument tuple;
      // arity comes from the schema or adapter itself, never a second list.
      const options = args[arity] as ClientCommandOptions | undefined;
      return execute(
        rpc._tag,
        (client) => {
          const methods = client[group];
          const method = Object.entries(methods).find(([key]) => key === name)?.[1];
          if (!method) throw new Error(`Missing Cake command: ${rpc._tag}`);
          // SAFETY: schema enumeration excludes Streams; the source Service's
          // command methods require no services and accept this semantic tuple.
          // Only the heterogeneous method/argument correlation was erased.
          const command = method as RuntimeCommand;
          return command(...args.slice(0, arity));
        },
        options,
      );
    };
  }
  // SAFETY: schema enumeration supplies precisely the command keys; each tag
  // remains paired with the same service method and semantic argument tuple.
  // This restores their mapped signatures, rather than widening known values.
  // oxlint-disable-next-line anti-slop/no-known-value-widening
  return commands as CommandGroup<CakeIpcClientService[Group]>;
}
