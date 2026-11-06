import { observer, useStore } from "r-state-tree/react";
import { ArtifactCatalogMenu } from "@/components/artifact-catalog-menu";
import { RootStore } from "../stores/RootStore";
import type { ProjectSessionStore } from "../stores/ProjectSessionStore";

export const SessionArtifactMenu = observer(function SessionArtifactMenu({
  session,
  onOpen,
}: {
  session: Pick<
    ProjectSessionStore,
    "sessionId" | "sessionArtifactsStore" | "conversationSessionStore"
  >;
  onOpen?: () => void;
}) {
  const root = useStore(RootStore);
  const secondaryFocused = Boolean(
    session.conversationSessionStore.sideChatStore.target?.chatStore,
  );
  const ownerTitle =
    root.sessionCatalogStore.find(session.sessionId)?.title ||
    root.cakeChatCollectionStore.summaries.find((chat) => chat.sessionId === session.sessionId)
      ?.title ||
    "Session";
  return (
    <ArtifactCatalogMenu
      store={root.artifactLibraryStore}
      sessionArtifacts={session.sessionArtifactsStore}
      ownerLabel={secondaryFocused ? ownerTitle : undefined}
      onOpen={onOpen}
      onOpenArtifact={(lineageId) =>
        root.navigationStore.openArtifact(
          session.sessionId,
          lineageId,
          session.sessionArtifactsStore.associations.find(
            (association) => association.lineage?.id === lineageId,
          )?.link?.pinnedRevision,
        )
      }
      onOpenLibrary={() => root.navigationStore.showArtifactLibrary(session.sessionId)}
    />
  );
});
