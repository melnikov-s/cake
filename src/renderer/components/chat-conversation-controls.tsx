import { observer } from "r-state-tree/react";
import type {
  ConversationModeStore,
  ConversationModeTarget,
} from "../stores/ConversationModeStore";
import { VoiceConversationControls } from "./ui/voice-conversation-controls";
import { Callout } from "./ui/callout";

export const ChatConversationControls = observer(function ChatConversationControls({
  conversation,
  target,
}: {
  conversation: ConversationModeStore;
  target: ConversationModeTarget;
}) {
  const selected = conversation.sessionId === target.sessionId;
  return (
    <div className="grid gap-1">
      <VoiceConversationControls
        active={selected && conversation.phase === "active"}
        preparing={selected && conversation.phase === "preparing"}
        muted={conversation.muted}
        listening={conversation.listening}
        speaking={conversation.speaking}
        disabled={!target.canEnter()}
        error={conversation.error}
        onEnter={() => void conversation.enter(target)}
        onMute={(muted) => void conversation.setMuted(muted)}
        onExit={() => void conversation.exit()}
      />
      {conversation.phase === "error" && conversation.transcript && (
        <Callout variant="warning">Unaccepted speech: {conversation.transcript}</Callout>
      )}
    </div>
  );
});
