import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { BrowserError } from "../../services/browser/Browser";
import { cakeRpcPayloadSchemas, cakeRpcSuccessSchemas } from "../cake-rpc-contract";

type BrowserOperation = keyof Pick<
  typeof cakeRpcPayloadSchemas,
  | "open-browser"
  | "get-browser-state"
  | "update-browser-bounds"
  | "navigate-browser"
  | "browser-action"
  | "inspect-browser-element"
>;

const browserRpc = <Type extends BrowserOperation>(type: Type) =>
  Rpc.make(`browser.${type}` as const, {
    payload: cakeRpcPayloadSchemas[type],
    success: cakeRpcSuccessSchemas[type],
    error: BrowserError,
  });

export const BrowserRpc = RpcGroup.make(
  browserRpc("open-browser"),
  browserRpc("get-browser-state"),
  browserRpc("update-browser-bounds"),
  browserRpc("navigate-browser"),
  browserRpc("browser-action"),
  browserRpc("inspect-browser-element"),
);
