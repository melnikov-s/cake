import { observer } from "r-state-tree/react";
import { NumberedIconButton } from "./ui/numbered-icon-button";
import { DiffIcon } from "./ui/icons";
import type { ProjectSessionStore } from "../stores/ProjectSessionStore";

export const SessionChangesToggle = observer(function SessionChangesToggle({
  session,
}: {
  session: ProjectSessionStore;
}) {
  const store = session.changesStore;
  const count = store.data?.totalCommits;
  const secondaryFocused = Boolean(
    session.conversationSessionStore.sideChatStore.target?.chatStore,
  );
  return (
    <NumberedIconButton
      count={count}
      countPlacement="inline"
      tooltip={`Review changes${secondaryFocused ? ` in ${session.workspacePath}` : ""}${count === undefined ? "" : ` · ${count} commits`}`}
      wrapTooltip={secondaryFocused}
      pressedAppearance="subtle"
      aria-pressed={store.open}
      aria-expanded={store.open}
      onClick={() => store.toggle()}
    >
      <DiffIcon />
    </NumberedIconButton>
  );
});
