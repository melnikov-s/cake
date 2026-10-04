import { observer } from "r-state-tree/react";
import type {
  ConversationModeStore,
  ConversationModeTarget,
} from "../stores/ConversationModeStore";
import { VoiceConversationControls } from "./ui/voice-conversation-controls";

export const ChatConversationControls = observer(function ChatConversationControls({
  conversation,
  target,
}: {
  conversation: ConversationModeStore;
  target: ConversationModeTarget;
}) {
  if (!conversation.enabled) return null;
  const selected = conversation.sessionId === target.sessionId;
  return (
    <VoiceConversationControls
      active={selected && conversation.phase === "active"}
      preparing={selected && conversation.phase === "preparing"}
      muted={conversation.muted}
      listening={conversation.listening}
      speaking={conversation.speaking}
      disabled={!target.canEnter()}
      onEnter={() => void conversation.enter(target)}
      onMute={(muted) => void conversation.setMuted(muted)}
      onExit={() => void conversation.exit()}
    />
  );
});
