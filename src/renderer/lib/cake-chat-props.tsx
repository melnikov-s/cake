import { ConversationActivity } from "../components/conversation-activity";
import { SessionAssistant } from "../components/session-assistant";
import type { RootStore } from "../stores/RootStore";
import type { CakeChatSessionStore } from "../stores/CakeChatSessionStore";
import { cakeChatTranscriptBehaviorFor } from "./cake-chat-transcript-behavior";

/** Shared conversation presentation in standalone and mixed Project Chat panes. */
export function cakeChatPropsFor(root: RootStore, session: CakeChatSessionStore, overlay = false) {
  return {
    composerLeadingAccessory: root.settingsStore.appearance.sessionAvatarsEnabled
      ? {
          visible: true,
          content: (
            <SessionAssistant
              store={root.sessionAssistantStore}
              seed={session.sessionId}
              labels={[]}
              value={[]}
              animated
            />
          ),
        }
      : undefined,
    composerHeader: (
      <ConversationActivity
        placement="composer"
        sessionId={session.sessionId}
        subagents={session.subagentActivityStore}
        sideChat={session.conversationSessionStore.sideChatStore}
      />
    ),
    parkComposerFocusWhileDictating: !overlay,
    transcriptTransition: {
      ready:
        Boolean(session.model.sessionFile) ||
        root.cakeChatCollectionStore.pendingSessions.isPending(session.sessionId),
    },
    transcriptBehavior: cakeChatTranscriptBehaviorFor(root, session),
    empty: (
      <div className="grid min-h-[calc(100vh-330px)] place-items-center content-center p-10 text-center">
        <span className="grid size-14 rotate-3 place-items-center rounded-bl-[14px] rounded-br-[20px] rounded-tl-[20px] rounded-tr-[14px] border border-border bg-card/75 shadow-[0_20px_70px_-30px_hsl(var(--shadow)/0.5)]">
          <span className="grid size-[27px] select-none place-items-center rounded-bl-[6px] rounded-br-[9px] rounded-tl-[9px] rounded-tr-[6px] bg-foreground text-sm font-black tracking-tighter text-background -rotate-2">
            C
          </span>
        </span>
        <h1 className="mt-5 font-display text-2xl font-semibold tracking-tight">
          {session.sessionId.startsWith("project-chat:")
            ? "Let’s talk about this project"
            : "What can I help you find or do?"}
        </h1>
        <p className="mt-3 max-w-[470px] text-sm leading-relaxed text-muted-foreground">
          {session.sessionId.startsWith("project-chat:")
            ? "Explore ideas, remember decisions, or delegate work—all in one ongoing project conversation."
            : "Ask about your tasks, open one, or delegate work to it."}
        </p>
      </div>
    ),
  };
}
