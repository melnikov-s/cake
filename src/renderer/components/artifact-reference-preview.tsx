import { useEffect, type ReactNode } from "react";
import { observer } from "r-state-tree/react";
import { Link } from "@/components/ui/link";
import type { ArtifactStableRef } from "../../contracts/artifacts/artifact-lineage";
import { parseArtifactRef } from "../../contracts/artifacts/artifact-lineage";
import type { ArtifactReferencePreviewStore } from "../stores/ArtifactReferencePreviewStore";

export const ArtifactReferencePreview = observer(function ArtifactReferencePreview({
  reference,
  children,
  store,
  onOpen,
}: {
  reference: ArtifactStableRef;
  children?: ReactNode;
  store: ArtifactReferencePreviewStore;
  onOpen(lineageId: string, revision?: number): void;
}) {
  useEffect(() => {
    store.retainReference(reference);
    return () => store.releaseReference(reference);
  }, [reference, store]);
  const lineage = store.lineage(reference);
  const parsed = parseArtifactRef(reference);
  return (
    <Link
      data-artifact-reference={reference}
      href={reference}
      onClick={(event) => {
        event.preventDefault();
        onOpen(parsed.lineageId, parsed.revision);
      }}
    >
      {children ?? lineage?.title ?? parsed.lineageId}
    </Link>
  );
});
