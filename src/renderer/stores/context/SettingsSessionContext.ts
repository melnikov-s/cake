import { createContext } from "r-state-tree";
import type { CakeChatTarget } from "../../../domain/cake-chats/cake-chat-data";

export type SettingsSessionContextValue =
  | {
      readonly kind: "project-session";
      readonly sessionId: string;
      readonly workingDirectory: string;
    }
  | ({ readonly kind: "cake-chat" } & CakeChatTarget);

/** The conversation from which the window opened the settings surface. */
export const SettingsSessionContext = createContext<SettingsSessionContextValue | undefined>(
  undefined,
);
