import { createContext } from "r-state-tree";
import type { DesktopClient } from "../desktop-client";
import type { SessionCacheStore } from "./SessionCacheStore";

export const DesktopClientContext = createContext<DesktopClient>();
export const SessionCacheContext = createContext<SessionCacheStore>();
