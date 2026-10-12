import { observer, useStore } from "r-state-tree/react";
import { ArtifactCatalogMenu } from "@/components/artifact-catalog-menu";
import { RootStore } from "../stores/RootStore";
import type { ProjectSessionStore } from "../stores/ProjectSessionStore";

export const SessionArtifactMenu = observer(function SessionArtifactMenu({
  session,
  onOpen,
}: {
  session: Pick<ProjectSessionStore, "sessionId" | "sessionArtifactsStore">;
  onOpen?: () => void;
}) {
  const root = useStore(RootStore);
  return (
    <ArtifactCatalogMenu
      store={root.artifactLibraryStore}
      sessionArtifacts={session.sessionArtifactsStore}
      onOpen={onOpen}
      onOpenArtifact={(lineageId) =>
        root.navigationStore.openArtifact(
          session.sessionId,
          lineageId,
          session.sessionArtifactsStore.associations.find(
            (association) => association.lineage?.id === lineageId,
          )?.selectedRevision,
        )
      }
      onOpenLibrary={() => root.navigationStore.showArtifactLibrary(session.sessionId)}
    />
  );
});
