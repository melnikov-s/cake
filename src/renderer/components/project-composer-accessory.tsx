import { observer, useStore } from "r-state-tree/react";
import { Avatar } from "@/components/ui/avatar";
import { SessionAssistant } from "@/components/session-assistant";
import { RootStore } from "../stores/RootStore";
import type { ProjectSessionStore } from "../stores/ProjectSessionStore";

export const ProjectComposerAccessory = observer(function ProjectComposerAccessory({
  session: paneSession,
}: {
  session: ProjectSessionStore;
}) {
  const root = useStore(RootStore);
  const summary = root.sessionCatalogStore.find(paneSession.sessionId);
  return summary?.resolved ? (
    <Avatar
      kind="session"
      seed={paneSession.sessionId}
      resolved
      className="size-7"
      role="img"
      aria-label="Resolved session"
      title="Resolved session"
    />
  ) : (
    <SessionAssistant
      store={paneSession.sessionAssistantStore}
      animated
      seed={paneSession.sessionId}
      labels={root.sessionMetadataStore.availableSessionLabels(paneSession.sessionId)}
      value={root.sessionMetadataStore.sessionLabelIds(paneSession.sessionId)}
    />
  );
});
