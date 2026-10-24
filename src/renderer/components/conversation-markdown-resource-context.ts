import { createContext } from "react";
import type { Client } from "../client/Client";
import type { InlineArtifactPreviewStore } from "../stores/InlineArtifactPreviewStore";
import type { InlineWidgetStore } from "../stores/InlineWidgetStore";

/** Window-owned read/presentation capabilities; conversation identity comes from the pane. */
export const ConversationMarkdownResourceContext = createContext<
  | {
      filesystem: Pick<Client["filesystem"], "readImage">;
      inlineArtifacts: InlineArtifactPreviewStore;
      inlineWidgets: InlineWidgetStore;
    }
  | undefined
>(undefined);
