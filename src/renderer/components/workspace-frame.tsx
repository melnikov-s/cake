import type { ComponentProps } from "react";
import { observer, useStore } from "r-state-tree/react";
import type { CakeChatSessionStore } from "../stores/CakeChatSessionStore";
import type { ProjectSessionStore } from "../stores/ProjectSessionStore";
import { RootStore } from "../stores/RootStore";
import { ConversationFocusContext } from "../lib/conversation-focus-context";
import { BrowserWorkspace } from "./browser-workspace";
import { IdeWorkspace } from "./ide-workspace";

/** Shared composition only; the caller provides the workflow's exact-class Store scope. */
export const WorkspaceFrame = observer(function WorkspaceFrame({
  session,
  mode,
  ...slots
}: {
  session: ProjectSessionStore | CakeChatSessionStore;
  mode: "browser" | "vscode";
} & Pick<
  ComponentProps<typeof BrowserWorkspace>,
  | "headerLeading"
  | "headerActions"
  | "conversationHeader"
  | "projectComposerHeader"
  | "projectComposerContent"
  | "projectComposerLeadingAccessory"
  | "sessionTitle"
  | "transcriptBehavior"
>) {
  const root = useStore(RootStore);
  const presentation = root.projectWorkbenchStore.presentationStore;
  const commonProps = {
    ...slots,
    projectChat: session.conversationSessionStore.chatStore,
    sideChat: session.conversationSessionStore.sideChatStore,
  };

  return (
    <ConversationFocusContext.Provider value>
      {mode === "browser" ? (
        <BrowserWorkspace {...commonProps} browser={presentation.browserStore} />
      ) : (
        <IdeWorkspace
          {...commonProps}
          editor={presentation.embeddedEditorStore}
          selections={session.editorSelectionsStore}
          reviews={root.reviewsStore}
        />
      )}
    </ConversationFocusContext.Provider>
  );
});
