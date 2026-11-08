import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import { IconButton } from "./ui/icon-button";
import { ArrowLeftIcon } from "./ui/icons";

/** A quiet, direct route out of a session to its owning conversation home. */
export const SessionChatHomeButton = observer(function SessionChatHomeButton() {
  const root = useStore(RootStore);
  const navigation = root.navigationStore;
  const home = navigation.sessionChatHome;
  if (!home) return null;
  const destination = home.sourceSessionId
    ? "source conversation"
    : home.projectPath
      ? `Project Chat for ${root.projectCatalogStore.nameForPath(home.projectPath)}`
      : "Cake Chat";
  return (
    // Float over content, aligned with the rail's pt-2 / h-9 top action.
    <nav aria-label="Session home" className="absolute left-4 top-2 z-20 flex h-9 items-center">
      <IconButton
        data-slot="session-chat-home"
        className="rounded-full bg-sidebar/80 ring-1 ring-border/65"
        tooltip={`Back to ${destination}`}
        onClick={() => void navigation.returnToChatHome()}
      >
        <ArrowLeftIcon />
      </IconButton>
    </nav>
  );
});
