import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { Schema } from "effect";
import { PiExtensionSetting, PiExtensionToggle } from "../../contracts/pi/extension-settings-data";
import { PiSettingsError } from "../../contracts/pi/pi-settings-errors";
import {
  piSettingUpdateSchema,
  piSettingsSchema,
} from "../../contracts/conversations/session-contract";

export const PiSettingsRpc = RpcGroup.make(
  Rpc.make("piSettings.extensions", {
    success: Schema.Array(PiExtensionSetting),
    error: PiSettingsError,
  }),
  Rpc.make("piSettings.setExtensionEnabled", {
    payload: PiExtensionToggle,
    success: piSettingsSchema,
    error: PiSettingsError,
  }),
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
