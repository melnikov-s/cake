import { createContext } from "r-state-tree";
import type { ModelCatalogStore } from "../ModelCatalogStore";

/** One window-owned directory catalog shared by settings and deferred chats. */
export const ModelCatalogContext = createContext<ModelCatalogStore>();
