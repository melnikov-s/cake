import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { PiSettingsError } from "../../services/pi/PiSettings";
import { piSettingUpdateSchema, piSettingsSchema } from "../session-contract";

export const PiSettingsRpc = RpcGroup.make(
  Rpc.make("piSettings.get", {
    success: piSettingsSchema,
    error: PiSettingsError,
  }),
  Rpc.make("piSettings.update", {
    payload: { update: piSettingUpdateSchema },
    success: piSettingsSchema,
    error: PiSettingsError,
  }),
  Rpc.make("piSettings.reload", {
    success: piSettingsSchema,
    error: PiSettingsError,
  }),
);
