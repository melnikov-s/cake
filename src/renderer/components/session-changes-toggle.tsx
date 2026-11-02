import { observer } from "r-state-tree/react";
import { IconButton } from "./ui/icon-button";
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
    <IconButton
      tooltip={`Review changes${count === undefined ? "" : ` · ${count} commits`}`}
      className="inline-flex h-8 w-auto items-center gap-1.5 px-2"
      pressedAppearance="subtle"
      aria-pressed={store.open}
      aria-expanded={store.open}
      onClick={() => {
        onOpen();
        store.toggle();
      }}
    >
      <DiffIcon />
      {count !== undefined && (
        <span className="rounded-full bg-muted px-1 font-mono text-xs tabular-nums">{count}</span>
      )}
    </IconButton>
  );
});
