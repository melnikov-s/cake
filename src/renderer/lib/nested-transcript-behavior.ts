import type { ChatTranscriptBehavior } from "../components/chat-transcript";
import type { ChatStore } from "../stores/ChatStore";
import type { DiscussionSessionStore } from "../stores/DiscussionSessionStore";
import type { RootStore } from "../stores/RootStore";

/** Resolve the displayed sidecar, never the focused parent or a display-only chat ID. */
function discussionSessionFor(
  root: RootStore,
  matches: (session: DiscussionSessionStore) => boolean,
): DiscussionSessionStore | undefined {
  return (
    root.reviewsStore.discussionSessions.find(matches) ??
    root.cakeChatCollectionStore.registry.sessions
      .flatMap((session) => session.sideChats.discussionSessions)
      .find(matches) ??
    root.discussionNavigationStore.sessions.find(matches)
  );
}

/** Shared, explicit allowlist for every secondary conversation host. */
export function nestedTranscriptBehaviorFor(
  root: RootStore,
  chat: ChatStore,
  parent: ChatTranscriptBehavior = {},
): ChatTranscriptBehavior {
  const discussion = discussionSessionFor(root, (session) => session.chatStore === chat);
  const subagents = [
    ...(parent.subagents ? [parent.subagents] : []),
    ...root.discussionNavigationStore.subagents,
  ].find((owner) => owner.runs.some((run) => owner.chatStore(run.key) === chat));
  const worker = subagents?.runs.find((run) => subagents.chatStore(run.key) === chat);
  const workerContext = worker && subagents?.resourceContext(worker.key);
  const workspacePath = discussion?.thread.workingDirectory ?? workerContext?.workspacePath;
  return {
    todos: parent.todos,
    // Selection annotations use this chat's composer. Do not inherit
    // messageComments: secondary chats cannot create nested side chats.
    showSelectionContextMenu: parent.showSelectionContextMenu,
    workspacePath,
    projectPath: parent.projectPath ?? parent.workspacePath,
    messageReferenceSessionId: discussion?.sessionId,
    inlineWidgets: root.inlineWidgetStore,
    inlineArtifactPreviews: root.inlineArtifactPreviewStore,
    openSourceLocation:
      workspacePath && parent.openSourceLocation
        ? (location) =>
            parent.openSourceLocation?.(
              workspacePath !== parent.workspacePath && !location.path.startsWith("/")
                ? { ...location, path: `${workspacePath}/${location.path}` }
                : location,
            )
        : undefined,
    interviews: discussion?.conversationSessionStore.interviewStore.interviews,
    waitingForUser: discussion?.conversationSessionStore.interviewStore.waiting,
  };
}
