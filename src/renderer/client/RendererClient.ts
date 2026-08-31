import type { Effect } from "effect";
import type { CakeIpcClientService } from "../../ipc/client/CakeIpcClient";
import type { ModelOption } from "../../ipc/session-contract";

export interface RendererCommandOptions {
  readonly signal?: AbortSignal;
}

type CommandGroup<Group> = {
  readonly [
    Key in keyof Group as Group[Key] extends (
      ...args: infer _Arguments
    ) => Effect.Effect<unknown, unknown, unknown>
      ? Key
      : never
  ]: Group[Key] extends (...args: infer Arguments) => Effect.Effect<infer Success, unknown, unknown>
    ? (...args: [...Arguments, options?: RendererCommandOptions]) => Promise<Success>
    : never;
};

/**
 * Permanent renderer-facing Promise API. Capability groups are semantic Cake
 * boundaries; Effect, RPC, transport envelopes, and Fibers remain private to
 * RendererClientLive.
 */
export interface RendererClient {
  readonly application: CommandGroup<CakeIpcClientService["application"]>;
  readonly models: {
    readonly list: (options?: RendererCommandOptions) => Promise<ReadonlyArray<ModelOption>>;
    readonly refresh: (options?: RendererCommandOptions) => Promise<void>;
  };
  readonly modelPresets: CommandGroup<CakeIpcClientService["modelPresets"]>;
  readonly projectSessions: CommandGroup<CakeIpcClientService["projectSessions"]>;
  readonly cakeChats: CommandGroup<CakeIpcClientService["cakeChats"]>;
  readonly discussionSessions: CommandGroup<CakeIpcClientService["discussionSessions"]>;
  readonly subagents: CommandGroup<CakeIpcClientService["subagents"]>;
  readonly foundation: CommandGroup<CakeIpcClientService["foundation"]>;
}

export type RendererClientErrorKind = "interrupted" | "transport" | "rejected" | "unexpected";

/** Stable error exposed to Stores and React by every RendererClient command. */
export class RendererClientError extends Error {
  readonly _tag = "RendererClientError";

  constructor(
    readonly kind: RendererClientErrorKind,
    readonly operation: string,
    message: string,
    readonly details: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RendererClientError";
  }
}
