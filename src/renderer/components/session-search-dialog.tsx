import { observer } from "r-state-tree/react";
import type { SidebarStore } from "../stores/SidebarStore";
import type { SessionMetadataStore } from "../stores/SessionMetadataStore";
import type { ProjectCatalogStore } from "../stores/ProjectCatalogStore";
import type { AppearanceSettingsStore } from "../stores/AppearanceSettingsStore";
import { SearchableChoiceDialog } from "./ui/searchable-choice-dialog";
import { SessionSearchResult } from "./session-search-result";
import { Switch } from "./ui/switch";

export const SessionSearchDialog = observer(function SessionSearchDialog({
  sidebar,
  sessionMetadata,
  projects,
  appearance,
  onOpenSession,
}: {
  sidebar: SidebarStore;
  sessionMetadata: SessionMetadataStore;
  projects: ProjectCatalogStore;
  appearance: AppearanceSettingsStore;
  onOpenSession(sessionId: string): void;
}) {
  const store = sidebar.sessionSearchStore;
  if (!store.open) return null;
  return (
    <SearchableChoiceDialog
      title="Search sessions"
      searchLabel="Search session titles"
      choicesLabel="Sessions"
      emptyMessage="No matching sessions."
      choices={store.search}
      filters={
        <label className="flex items-center gap-2 px-2 pt-3 text-xs text-muted-foreground">
          <Switch
            checked={store.includeResolved}
            onCheckedChange={(value) => store.setIncludeResolved(value)}
          />
          Include resolved
        </label>
      }
      renderChoice={(choice, optionProps, onSelect) => (
        <SessionSearchResult
          choice={choice}
          optionProps={optionProps}
          sidebar={sidebar}
          sessionMetadata={sessionMetadata}
          projects={projects}
          appearance={appearance}
          onSelect={onSelect}
        />
      )}
      onSelect={(id) => {
        if (store.select(id)) onOpenSession(id);
      }}
      onClose={() => store.close()}
    />
  );
});
