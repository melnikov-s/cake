import { observer } from "r-state-tree/react";
import type { SidebarStore } from "../stores/SidebarStore";
import type { SessionMetadataStore } from "../stores/SessionMetadataStore";
import type { ProjectCatalogStore } from "../stores/ProjectCatalogStore";
import type { AppearanceSettingsStore } from "../stores/AppearanceSettingsStore";
import { SearchableChoiceDialog } from "./ui/searchable-choice-dialog";
import { SessionListItem } from "./ui/session-list-item";

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
      description={store.description}
      searchLabel="Search session titles"
      choicesLabel="Sessions"
      emptyMessage="No matching sessions."
      query={store.query}
      choices={store.choices}
      renderChoice={({ session, label }, optionProps, onSelect) => {
        const projectName = projects.nameForPath(session.projectPath);
        return (
          <SessionListItem
            session={{ ...session, title: label }}
            selected={optionProps["aria-selected"]}
            actionProps={optionProps}
            resolved={session.resolved}
            managedWorktree={sidebar.managedWorktree(session.workingDirectory)}
            activity={sidebar.sessionListStore.sessionActivityForDisplay(session)}
            activityTime={sidebar.sessionActivityTime(session.modifiedAt)}
            labels={sessionMetadata.sessionLabels(session.sessionId)}
            avatarSeed={session.sessionId}
            avatarsEnabled={appearance.sessionAvatarsEnabled}
            charactersEnabled={appearance.sidebarCharactersEnabled}
            source={{
              kind: "project",
              name: projectName,
              avatarSeed: projectName,
              customIcon: projects.find(session.projectPath)?.settings.icon,
              showAvatar: appearance.projectAvatarsEnabled,
            }}
            onOpen={onSelect}
          />
        );
      }}
      onQueryChange={(query) => store.setQuery(query)}
      onSelect={(id) => {
        if (store.select(id)) onOpenSession(id);
      }}
      onClose={() => store.close()}
    />
  );
});
