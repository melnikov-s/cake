import { observer, useStore } from "r-state-tree/react";
import type { CakeArtifactV1 } from "../../contracts/artifacts/artifact-contract";
import { decodeArtifactLineageId } from "../../contracts/artifacts/artifact-lineage";
import { RootStore } from "../stores/RootStore";
import { Button } from "./ui/button";
import { Callout } from "./ui/callout";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

const destinations = [
  ["top", "Top"],
  ["bottom", "Bottom"],
  ["left", "Left"],
  ["right", "Right"],
  ["tab", "Workspace tab"],
] as const;

/** Placement belongs to the existing attachment authority, not the artifact renderer. */
export const ArtifactAttachmentMenu = observer(function ArtifactAttachmentMenu({
  artifact,
  sessionId,
}: {
  artifact: CakeArtifactV1;
  sessionId?: string;
}) {
  const root = useStore(RootStore);
  if (artifact.kind !== "widget") return null;
  const store = root.widgetAttachmentStore;
  const lineageId = decodeArtifactLineageId(artifact.id);
  const request = store.placementRequests.get(lineageId);
  return (
    <div className="flex min-w-0 items-center gap-2">
      {request?.pending && (
        <span role="status" className="text-xs text-muted-foreground">
          Attaching…
        </span>
      )}
      <Popover>
        <PopoverTrigger
          size="sm"
          variant="ghost"
          aria-haspopup="menu"
          aria-label={`Attach ${artifact.title ?? artifact.id} to`}
        >
          Attach to
        </PopoverTrigger>
        <PopoverContent
          role="menu"
          aria-label="Attach to"
          align="end"
          className={request?.error ? "w-72 p-1" : "w-44 p-1"}
          dismissOnEscapeCapture
        >
          {request?.error && (
            <Callout role="alert" variant="error" className="m-1">
              {request.error}
            </Callout>
          )}
          {destinations.map(([slot, label]) => (
            <Button
              key={slot}
              role="menuitem"
              variant="ghost"
              size="sm"
              className="w-full justify-start"
              disabled={request?.pending || (slot !== "tab" && !sessionId)}
              onClick={() => void store.attachViewedWidget(lineageId, slot, sessionId)}
            >
              {label}
            </Button>
          ))}
          {!sessionId && (
            <p className="px-2 py-1 text-xs text-muted-foreground">
              Open a conversation for chat slots.
            </p>
          )}
          {request?.slot && !request.pending && !request.error && (
            <p role="status" className="px-2 py-1 text-xs text-muted-foreground">
              Attached to {destinations.find(([slot]) => slot === request.slot)?.[1]}.
            </p>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
});
