import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { TerminalError } from "../../services/terminal/Terminal";
import {
  cakeRpcPayloadSchemas,
  cakeRpcSuccessSchemas,
  terminalEventSchema,
} from "../cake-rpc-contract";

type TerminalOperation = keyof Pick<
  typeof cakeRpcPayloadSchemas,
  "open-terminal" | "get-terminal-status" | "write-terminal" | "resize-terminal" | "close-terminal"
>;

const terminalRpc = <Type extends TerminalOperation>(type: Type) =>
  Rpc.make(`terminals.${type}` as const, {
    payload: cakeRpcPayloadSchemas[type],
    success: cakeRpcSuccessSchemas[type],
    error: TerminalError,
  });

export const TerminalRpc = RpcGroup.make(
  terminalRpc("open-terminal"),
  terminalRpc("get-terminal-status"),
  terminalRpc("write-terminal"),
  terminalRpc("resize-terminal"),
  terminalRpc("close-terminal"),
  Rpc.make("terminals.observeEvents", { success: terminalEventSchema, stream: true }),
);
