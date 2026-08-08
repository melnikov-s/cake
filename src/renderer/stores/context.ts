import { createContext } from "r-state-tree";
import type { DesktopClient } from "../desktop-client";
import type { SessionModel } from "../models/session";

export const DesktopClientContext = createContext<DesktopClient>();
export const SessionContext = createContext<SessionModel>();
