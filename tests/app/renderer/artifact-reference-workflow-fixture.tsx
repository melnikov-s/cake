import { act, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Schema } from "effect";
import { VirtuosoMockContext } from "react-virtuoso";
import {
  ArtifactReferenceMetadata,
  decodeArtifactLineageId,
  decodeArtifactRevisionNumber,
  formatArtifactRef,
  parseArtifactRef,
  type ArtifactRevision,
} from "../../../src/contracts/artifacts/artifact-lineage";
import type { ConversationSnapshot } from "../../../src/contracts/conversations/conversation-data";
import type { UiPart } from "../../../src/contracts/conversations/session-contract";
import type { Client } from "../../../src/renderer/client/Client";
import { RendererRoot } from "../../../src/renderer/components/renderer-root";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

export const reportId = decodeArtifactLineageId("report");
export const appendixId = decodeArtifactLineageId("appendix");
export const reportRef = formatArtifactRef({
  lineageId: reportId,
  revision: decodeArtifactRevisionNumber(1),
});

export function referenceMetadata(reference: string): ArtifactReferenceMetadata {
  const { lineageId, revision = decodeArtifactRevisionNumber(2) } = parseArtifactRef(reference);
  const metadata = (value: number) => ({
    revision: value,
    digest: "a".repeat(64),
    kind: "markdown",
    publishedAt: new Date(Date.UTC(2025, 0, value)).toISOString(),
    publishedBySessionId: "session-1",
    workingDirectory: "/project",
  });
  return Schema.decodeUnknownSync(ArtifactReferenceMetadata)({
    lineage: {
      id: lineageId,
      title:
        lineageId === reportId
          ? "Quarterly report"
          : lineageId === appendixId
            ? "Appendix"
            : `Artifact ${lineageId}`,
      createdAt: metadata(1).publishedAt,
      latestRevision: 2,
      latest: metadata(2),
      stableRef: formatArtifactRef({ lineageId }),
    },
    revision: metadata(revision),
    links: [],
    stableRef: formatArtifactRef({ lineageId }),
    exactRef: formatArtifactRef({ lineageId, revision }),
  });
}

export function artifactRevision(
  lineageId: Parameters<Client["artifacts"]["readExact"]>[0],
  value: number,
): ArtifactRevision {
  const reference = referenceMetadata(`${formatArtifactRef({ lineageId })}@r${value}`);
  return {
    lineageId,
    metadata: reference.revision,
    snapshot: {
      protocol: "cake.artifact/v1",
      id: lineageId,
      sessionId: "session-1",
      revision: value,
      title: reference.lineage.title,
      kind: "markdown",
      payload: { markdown: `${lineageId} content r${value}` },
      fallback: { markdown: `${lineageId} content r${value}` },
    },
  };
}

export function renderArtifactReferences(
  text: string,
  artifacts: Partial<Client["artifacts"]> = {},
  inlineParts: UiPart[] = [],
) {
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project", name: "Project" })],
    sessions: [
      sessionSummary({
        sessionId: "session-1",
        title: "Artifact discussion",
        projectPath: "/project",
      }),
    ],
    client: {
      projectSessions: { open: async () => undefined },
      workspaces: { loadStagedSlashCommands: async () => [] },
      artifacts: {
        effective: async () => [],
        catalog: async () => ({
          items: [
            referenceMetadata("cake://artifact/report").lineage,
            referenceMetadata("cake://artifact/appendix").lineage,
          ],
          offset: 0,
          limit: 50,
          total: 2,
          hasMore: false,
        }),
        referenceMetadata: async (reference) => referenceMetadata(reference),
        detail: async (id) => {
          const reference = referenceMetadata(formatArtifactRef({ lineageId: id }));
          return {
            lineage: reference.lineage,
            links: reference.links,
            stableRef: reference.stableRef,
          };
        },
        history: async ({ lineageId }) => ({
          items: [2, 1].map((value) => artifactRevision(lineageId, value).metadata),
          offset: 0,
          limit: 50,
          total: 2,
          hasMore: false,
        }),
        readExact: async (id, value) => artifactRevision(id, value),
        ...artifacts,
      },
    },
  });
  const session = fixture.root.sessionRegistry.load("session-1", "/project");
  const snapshot = (content: string): ConversationSnapshot => ({
    sessionId: "session-1",
    sessionFile: "/sessions/session-1.jsonl",
    parts: [
      ...inlineParts,
      { id: "response", kind: "text", role: "assistant", status: "complete", text: content },
    ],
    models: [],
    thinkingLevel: "off",
    availableThinkingLevels: ["off"],
    streaming: false,
    diagnostics: [],
    commands: [],
    compatibility: { resources: [], diagnostics: [] },
    extensionUi: { statuses: [] },
    tree: [],
  });
  const conversation = fixture.models.projectConversation("session-1", "/project");
  let revision = 1;
  applyConversationUpdate(conversation, { _tag: "Snapshot", revision, snapshot: snapshot(text) });
  fixture.root.navigationStore.selectProjectSession("session-1");
  fixture.root.projectWorkbenchStore.showLoadedSession("session-1");
  fixture.root.sessionLayoutStore.ensureSession("session-1");
  session.conversationSessionStore.chatStore.transcriptInteraction.setTranscriptScrollPosition({
    kind: "top",
  });
  const view = render(
    <VirtuosoMockContext.Provider value={{ viewportHeight: 900, itemHeight: 160 }}>
      <RendererRoot
        rootStore={fixture.root}
        openExternalUrl={() => {
          throw new Error("Unexpected external URL");
        }}
        openSession={() => {
          throw new Error("Unexpected session navigation");
        }}
      />
    </VirtuosoMockContext.Provider>,
  );
  let disposed = false;
  return {
    user: userEvent.setup(),
    async publishArtifactsChanged() {
      await act(async () => fixture.models.artifacts.invalidate());
    },
    async receiveTranscript(content: string) {
      await act(async () => {
        applyConversationUpdate(conversation, {
          _tag: "Snapshot",
          revision: ++revision,
          snapshot: snapshot(content),
        });
      });
    },
    [Symbol.dispose]() {
      if (disposed) return;
      disposed = true;
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}
