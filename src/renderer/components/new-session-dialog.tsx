import { observer } from "r-state-tree/react";
import type { NewSessionStore } from "../stores/NewSessionStore";
import { CakeIcon, FolderIcon } from "./ui/icons";
import { SearchableChoiceDialog } from "./ui/searchable-choice-dialog";

export const NewSessionDialog = observer(function NewSessionDialog({
  store,
}: {
  store: NewSessionStore;
}) {
  if (!store.open) return null;
  return (
    <SearchableChoiceDialog
      title="New session"
      description="Choose Cake Chat or a project."
      searchLabel="Filter projects"
      query={store.query}
      initialActiveId={store.initialChoiceId}
      choices={store.choices.map((choice) => ({
        ...choice,
        icon: choice.id === "cake-chat" ? <CakeIcon /> : <FolderIcon />,
      }))}
      onQueryChange={(query) => store.setQuery(query)}
      onSelect={(id) => store.select(id)}
      onClose={() => store.close()}
    />
  );
});
