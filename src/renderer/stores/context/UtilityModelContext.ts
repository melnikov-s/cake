import { createContext } from "r-state-tree";
import type { UtilityModel } from "../../../contracts/conversations/session-contract";

/** Read-only view of the configured utility model, offered as a chat picker choice. */
export const UtilityModelContext = createContext<() => UtilityModel | undefined>();
