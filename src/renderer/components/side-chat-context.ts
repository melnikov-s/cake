import { createContext } from "react";
import type { SideChatStore } from "../stores/SideChatStore";

export const SideChatContext = createContext<SideChatStore | undefined>(undefined);
