import { observer, useStore } from "r-state-tree/react";
import type { ChatTranscriptBehavior } from "./chat-transcript";
import type { ChatStore } from "../stores/ChatStore";
import { RootStore } from "../stores/RootStore";
import { nestedTranscriptBehaviorFor } from "../lib/nested-transcript-behavior";
import { Chat } from "./chat";
import { BlockingInterviews } from "./blocking-interviews";

/** One child-scoped capability assembly across normal, IDE and Browser hosts. */
export const NestedChat = observer(function NestedChat({
  store,
  parentBehavior,
  composerFocusEnabled = true,
  compact = true,
}: {
  store: ChatStore;
  parentBehavior?: ChatTranscriptBehavior;
  composerFocusEnabled?: boolean;
  compact?: boolean;
}) {
  const root = useStore(RootStore);
  const behavior = nestedTranscriptBehaviorFor(root, store, parentBehavior);
  return (
    <Chat
      store={store}
      embedded
      compact={compact}
      composerFocusEnabled={composerFocusEnabled}
      transcriptBehavior={behavior}
      composerContent={
        behavior.interviews && (
          <BlockingInterviews
            session={{ interviews: behavior.interviews, canonicalParts: store.parts }}
            inlineWidgets={root.inlineWidgetStore}
          />
        )
      }
    />
  );
});
