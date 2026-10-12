import type { ReactNode } from "react";
import { observer } from "r-state-tree/react";
import type { SourceLocation } from "../../contracts/editor/source-location";
import type { ArtifactPaneStore } from "../stores/ArtifactPaneStore";
import type { ArtifactReferencePreviewStore } from "../stores/ArtifactReferencePreviewStore";
import type { SessionCatalogStore } from "../stores/SessionCatalogStore";
import type { InlineWidgetStore } from "../stores/InlineWidgetStore";
import { AccessoryPanelLayout } from "@/components/ui/accessory-panel-layout";
import { SidePanel } from "@/components/ui/side-panel";
import { ArtifactLineageDetail } from "./artifact-lineage-detail";

export const ArtifactPaneLayout = observer(function ArtifactPaneLayout({
  store,
  sessionId,
  referencePreviews,
  sessions,
  inlineWidgets,
  onOpenSourceLocation,
  wrapArtifact,
  children,
}: {
  store: ArtifactPaneStore;
  sessionId: string;
  referencePreviews: ArtifactReferencePreviewStore;
  sessions: SessionCatalogStore;
  inlineWidgets: InlineWidgetStore;
  onOpenSourceLocation?(location: SourceLocation): void;
  wrapArtifact?(artifactId: string, children: ReactNode): ReactNode;
  children: ReactNode;
}) {
  return (
    <AccessoryPanelLayout
      dataSlot="artifact-pane-layout"
      open={store.sessionId === sessionId}
      width={store.width}
      resizeLabel="Resize artifact pane"
      onWidthChange={(width) => store.setWidth(width)}
      panel={
        <SidePanel title="Artifact" eyebrow="Session artifact" onClose={() => store.close()}>
          <ArtifactLineageDetail
            store={store.detailStore}
            referencePreviews={referencePreviews}
            activeSessionId={sessionId}
            sessions={sessions}
            inlineWidgets={inlineWidgets}
            compact
            onOpenSourceLocation={onOpenSourceLocation}
            wrapArtifact={wrapArtifact}
          />
        </SidePanel>
      }
    >
      {children}
    </AccessoryPanelLayout>
  );
});
