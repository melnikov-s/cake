import { observer } from "r-state-tree/react";
import type { SidebarStore } from "../stores/SidebarStore";
import type { SessionMetadataStore } from "../stores/SessionMetadataStore";
import type { ProjectCatalogStore } from "../stores/ProjectCatalogStore";
import type { AppearanceSettingsStore } from "../stores/AppearanceSettingsStore";
import type { SessionSearchStore } from "../stores/SessionSearchStore";
import type { SearchableChoiceOptionProps } from "./ui/searchable-choice-dialog";
import { SessionListItem } from "./ui/session-list-item";

/** Observe row metadata here, without invalidating the input or title ranking. */
export const SessionSearchResult = observer(function SessionSearchResult({
  choice: { session, label },
  optionProps,
  sidebar,
  sessionMetadata,
  projects,
  appearance,
  onSelect,
}: {
  choice: ReturnType<SessionSearchStore["search"]>[number];
  optionProps: SearchableChoiceOptionProps;
  sidebar: SidebarStore;
  sessionMetadata: SessionMetadataStore;
  projects: ProjectCatalogStore;
  appearance: AppearanceSettingsStore;
  onSelect(): void;
}) {
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
});
