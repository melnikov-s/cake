import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import { IconButton } from "./ui/icon-button";
import { BackIcon, ForwardIcon } from "./ui/icons";

/** The same visit-history commands as the keyboard, not adjacent session-list rows. */
export const ConversationHistoryControls = observer(function ConversationHistoryControls() {
  const navigation = useStore(RootStore).navigationStore;
  return (
    <div
      role="group"
      aria-label="Conversation history"
      className="mr-2 flex shrink-0 items-center gap-0.5 [app-region:no-drag]"
    >
      <IconButton
        tooltip="Back"
        ariaLabel="Go back in session history"
        hotkey="history-back"
        disabled={!navigation.canGoBack}
        onClick={() => navigation.navigateBack()}
      >
        <BackIcon />
      </IconButton>
      <IconButton
        tooltip="Forward"
        ariaLabel="Go forward in session history"
        hotkey="history-forward"
        disabled={!navigation.canGoForward}
        onClick={() => navigation.navigateForward()}
      >
        <ForwardIcon />
      </IconButton>
    </div>
  );
});
