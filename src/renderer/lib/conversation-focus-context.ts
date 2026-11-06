import { createContext } from "react";

/** Normal app workspaces focus secondary conversations; detached/pop-up hosts retain their chrome. */
export const ConversationFocusContext = createContext(false);
