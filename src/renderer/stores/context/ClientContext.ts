import { createContext } from "r-state-tree";
import type { Client } from "../../client/Client";

/** The one window-owned Client provided by RootStore to every child Store. */
export const ClientContext = createContext<Client>();
