import { createContext } from "r-state-tree";

/** User-initiated capture goes to the active conversation draft; never auto-sends. */
export const WidgetViewAttachmentContext = createContext<{
  attachWidgetView(viewId: string): Promise<void>;
}>();
