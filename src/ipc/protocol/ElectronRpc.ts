import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { ElectronError } from "../../services/electron/Electron";
import {
  cakeRpcPayloadSchemas,
  cakeRpcSuccessSchemas,
  surfaceEventSchema,
} from "../cake-rpc-contract";

type ElectronOperation = keyof Pick<
  typeof cakeRpcPayloadSchemas,
  | "choose-project"
  | "open-external-url"
  | "show-transcript-selection-context-menu"
  | "show-composer-context-menu"
  | "show-session-context-menu"
  | "show-project-context-menu"
  | "set-fullscreen-surface-open"
>;

const electronRpc = <Type extends ElectronOperation>(type: Type) =>
  Rpc.make(`electron.${type}` as const, {
    payload: cakeRpcPayloadSchemas[type],
    success: cakeRpcSuccessSchemas[type],
    error: ElectronError,
  });

export const ElectronRpc = RpcGroup.make(
  electronRpc("choose-project"),
  electronRpc("open-external-url"),
  electronRpc("show-transcript-selection-context-menu"),
  electronRpc("show-composer-context-menu"),
  electronRpc("show-session-context-menu"),
  electronRpc("show-project-context-menu"),
  electronRpc("set-fullscreen-surface-open"),
  Rpc.make("electron.observeSurfaceEvents", { success: surfaceEventSchema, stream: true }),
);
