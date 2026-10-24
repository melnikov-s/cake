import { useCallback, useContext, useMemo, type ComponentProps, type ReactNode } from "react";
import { formatArtifactRef, parseArtifactRef } from "../../contracts/artifacts/artifact-lineage";
import { MarkdownLinkProvider, useMarkdownLinkActions } from "./ai-elements/markdown";
import { ConversationMarkdownResourceContext } from "./conversation-markdown-resource-context";
import { InlineArtifactPreview } from "./inline-artifact-preview";

type MarkdownActions = ComponentProps<typeof MarkdownLinkProvider>["actions"];

/** Resource reads follow the displayed conversation, never the window's focused pane. */
export function ConversationMarkdownProvider({
  workspacePath,
  stateSessionId,
  loadWorkspaceImage: sourceWorkspaceImage,
  loadAttachmentImage,
  children,
}: {
  workspacePath?: string;
  /** Public, addressable session identity. A private worker's display ID is not a session ID. */
  stateSessionId?: string;
  loadWorkspaceImage?: MarkdownActions["loadWorkspaceImage"];
  loadAttachmentImage?: MarkdownActions["loadAttachmentImage"];
  children: ReactNode;
}) {
  const inherited = useMarkdownLinkActions();
  const resources = useContext(ConversationMarkdownResourceContext);
  const filesystem = resources?.filesystem;
  const loadWorkspaceImage = useCallback(
    (path: string, signal: AbortSignal) => {
      if (sourceWorkspaceImage) return sourceWorkspaceImage(path, signal);
      if (!workspacePath || !filesystem)
        return Promise.reject(new Error("This conversation has no image Working Directory"));
      return filesystem.readImage(workspacePath, path, { signal });
    },
    [filesystem, sourceWorkspaceImage, workspacePath],
  );
  const actions = useMemo<MarkdownActions>(
    () => ({
      openExternalUrl: (url) => inherited?.openExternalUrl(url),
      openSession: (sessionId, messageId, attachmentId) =>
        inherited?.openSession(sessionId, messageId, attachmentId),
      ...inherited,
      loadWorkspaceImage,
      // An absent child attachment reader must not inherit a parent's reader.
      loadAttachmentImage,
      renderArtifactEmbed: resources
        ? (reference, label, surfaceId) => (
            <InlineArtifactPreview
              reference={formatArtifactRef(parseArtifactRef(reference))}
              label={label}
              surfaceId={surfaceId}
              stateSessionId={stateSessionId}
              store={resources.inlineArtifacts}
              inlineWidgets={resources.inlineWidgets}
            />
          )
        : undefined,
    }),
    [inherited, loadAttachmentImage, loadWorkspaceImage, resources, stateSessionId],
  );
  return <MarkdownLinkProvider actions={actions}>{children}</MarkdownLinkProvider>;
}
