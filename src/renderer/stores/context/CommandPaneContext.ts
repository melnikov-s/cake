import { createContext } from "r-state-tree";
import type { CommandPaneStore } from "../CommandPaneStore";

/** Command-pane intents shared by project composers and window navigation. */
export const CommandPaneContext =
  createContext<Pick<CommandPaneStore, "open" | "dismiss" | "tryCancelNavigation" | "tryClose">>();
