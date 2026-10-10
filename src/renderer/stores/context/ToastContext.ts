import { createContext } from "r-state-tree";
import type { ToastStore } from "../ToastStore";

/** Window-local toast delivery owned by RootStore. */
export const ToastContext = createContext<ToastStore>();
