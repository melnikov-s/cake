import { createContext } from "r-state-tree";
import type { ModelPreset, UtilityModel } from "../../../contracts/application/application-data";

/** Window-owned model preferences, read live; icon choices themselves are dialog-local. */
export const ProjectIdentityContext = createContext<
  () => {
    presets: readonly ModelPreset[];
    defaultPresetId: string | undefined;
    utilityModel: UtilityModel | undefined;
  }
>();
