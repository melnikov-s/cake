import { createContext } from "r-state-tree";
import type { RendererClient } from "./RendererClient";

/** The one window-owned RendererClient provided by RootStore to every child Store. */
export const RendererClientContext = createContext<RendererClient>();
