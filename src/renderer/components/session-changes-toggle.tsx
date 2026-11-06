import { observer } from "r-state-tree/react";
import { NumberedIconButton } from "./ui/numbered-icon-button";
import { DiffIcon } from "./ui/icons";
import type { ProjectSessionStore } from "../stores/ProjectSessionStore";

export const SessionChangesToggle = observer(function SessionChangesToggle({
  session,
  onOpen,
}: {
  session: ProjectSessionStore;
  onOpen(): void;
}) {
  const store = session.changesStore;
  const count = store.data?.totalCommits;
  return (
    <NumberedIconButton
      count={count}
      tooltip={`Review changes${count === undefined ? "" : ` · ${count} commits`}`}
      pressedAppearance="subtle"
      aria-pressed={store.open}
      aria-expanded={store.open}
      onClick={() => {
        onOpen();
        store.toggle();
      }}
    >
      <DiffIcon />
    </NumberedIconButton>
  );
});
