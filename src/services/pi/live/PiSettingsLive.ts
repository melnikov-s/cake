import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { makePiSettingsLayer } from "../PiSettings";

/** Process-wide access to Pi's global settings, independent of any conversation runtime. */
export const makePiSettingsLive = (agentDirectory: string) =>
  makePiSettingsLayer(
    SettingsManager.create(agentDirectory, agentDirectory, {
      projectTrusted: true,
    }),
  );
