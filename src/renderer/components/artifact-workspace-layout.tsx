import type { ReactNode } from "react";
import { observer } from "r-state-tree/react";
import { ArtifactHost } from "@/components/artifact-host";
import { AccessoryPanelLayout } from "@/components/ui/accessory-panel-layout";
import { Button } from "@/components/ui/button";
import { ArtifactIcon, BackIcon, ForwardIcon } from "@/components/ui/icons";
import { IconButton } from "@/components/ui/icon-button";
import { NavItem } from "@/components/ui/nav-item";
import { SidePanel } from "@/components/ui/side-panel";
import type { SourceLocation } from "../../ipc/source-location";
import type { InlineWidgetStore } from "../stores/InlineWidgetStore";
import type { ProjectSessionStore } from "../stores/ProjectSessionStore";

export const ArtifactWorkspaceLayout = observer(function ArtifactWorkspaceLayout({
  session,
  inlineWidgets,
  onOpenSourceLocation,
  children,
}: {
  session: ProjectSessionStore;
  inlineWidgets: InlineWidgetStore;
  onOpenSourceLocation?(location: SourceLocation): void;
  children: ReactNode;
}) {
  const workspace = session.artifactWorkspaceStore;
  const selected = workspace.selectedRecord;
  const title = selected?.artifact.title ?? selected?.artifact.id ?? "Artifacts";
  return (
    <AccessoryPanelLayout
      dataSlot="artifact-workspace-layout"
      open={workspace.open && workspace.records.length > 0}
      width={workspace.width}
      resizeLabel="Resize artifact workspace"
      onWidthChange={(width) => workspace.setWidth(width)}
      panel={
        <SidePanel
          title={selected ? title : "Artifacts"}
          eyebrow="Artifacts"
          onClose={() => workspace.close()}
        >
          {selected ? (
            <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)]">
              <div className="flex items-center gap-1 border-b border-border/65 px-3 py-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-1.5 px-2"
                  onClick={() => workspace.showList()}
                >
                  <BackIcon /> All artifacts
                </Button>
                <span className="ml-auto flex items-center gap-1">
                  <IconButton
                    tooltip="Previous artifact"
                    disabled={!workspace.hasPrevious}
                    onClick={() => workspace.showPrevious()}
                  >
                    <BackIcon />
                  </IconButton>
                  <IconButton
                    tooltip="Next artifact"
                    disabled={!workspace.hasNext}
                    onClick={() => workspace.showNext()}
                  >
                    <ForwardIcon />
                  </IconButton>
                </span>
              </div>
              <div className="min-h-0 overflow-auto p-4">
                <ArtifactHost
                  record={selected}
                  inlineWidgets={inlineWidgets}
                  onOpenSourceLocation={onOpenSourceLocation}
                />
              </div>
            </div>
          ) : (
            <nav className="h-full overflow-auto p-2" aria-label="Session artifacts">
              {workspace.records.map((record) => (
                <NavItem
                  key={record.artifact.id}
                  icon={<ArtifactIcon />}
                  label={record.artifact.title ?? record.artifact.id}
                  description={record.artifact.kind}
                  onClick={() => workspace.openArtifact(record.artifact.id)}
                />
              ))}
            </nav>
          )}
        </SidePanel>
      }
    >
      {children}
    </AccessoryPanelLayout>
  );
});
