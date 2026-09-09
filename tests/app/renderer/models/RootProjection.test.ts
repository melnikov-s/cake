import { findModelById, toSnapshot } from "r-state-tree";
import { describe, expect, it } from "vitest";
import type { ConversationSnapshot } from "../../../../src/domain/conversations/conversation-data";
import { Artifact } from "../../../../src/renderer/models/Artifact";
import { applyArtifactUpdate } from "../../../../src/renderer/reducers/ArtifactReducer";
import { RootProjection } from "../../../../src/renderer/models/RootProjection";
import { applyProjectSessionUpdate } from "../../../../src/renderer/reducers/ConversationReducer";
import { applyConversationSnapshot } from "../../../../src/renderer/reducers/ConversationReducer";

function conversation(sessionId: string, authenticated: boolean): ConversationSnapshot {
  return {
    sessionId,
    sessionFile: `/project/${sessionId}.jsonl`,
    workingDirectory: "/project",
    model: { provider: "amazon-bedrock", id: "amazon.nova-2-lite-v1:0", name: "Nova" },
    models: [
      {
        provider: "amazon-bedrock",
        providerName: "Bedrock",
        id: "amazon.nova-2-lite-v1:0",
        name: "Nova",
        reasoning: false,
        input: ["text"],
        authenticated,
        available: authenticated,
        availableThinkingLevels: ["off"],
        authTypes: ["api_key"],
      },
    ],
    parts: [
      { id: "shared-entry", kind: "text", role: "user", text: sessionId, status: "complete" },
    ],
    tree: [],
    commands: [],
    diagnostics: [],
    thinkingLevel: "off",
    availableThinkingLevels: ["off"],
    streaming: false,
    compatibility: {
      resources: [
        {
          id: "skill:/shared/SKILL.md",
          kind: "skill",
          name: "Shared skill",
          path: "/shared/SKILL.md",
          source: "local",
          scope: "user",
          origin: "top-level",
          commands: [],
          tools: [],
          enabled: authenticated,
        },
      ],
      diagnostics: [
        { id: "shared-diagnostic", severity: "warning", source: "skill", message: sessionId },
      ],
    },
    extensionUi: { statuses: [] },
  };
}

describe("RootProjection", () => {
  it("uses the artifact id as its unique identity across sessions and revisions", () => {
    const root = RootProjection.create();
    const record = (sessionId: string, revision: number) => ({
      artifact: {
        protocol: "cake.artifact/v1" as const,
        id: "report",
        sessionId,
        revision,
        kind: "markdown" as const,
        payload: { markdown: `Revision ${revision}` },
        fallback: { markdown: "Report" },
      },
      workspacePath: "/project",
      digest: "a".repeat(64),
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    });
    const first = root.projectSession("one", "/project");
    const second = root.projectSession("two", "/project");
    applyArtifactUpdate(first, record("one", 1));
    applyArtifactUpdate(second, record("two", 1));
    const artifact = first.artifacts[0]!;
    expect(artifact.id).toBe("one:report");
    expect(second.artifacts[0]!.id).toBe("two:report");
    expect(findModelById(root, Artifact, artifact.id)).toBe(artifact);
    applyArtifactUpdate(first, record("one", 2));
    expect(first.artifacts[0]).toBe(artifact);
    expect(artifact.artifact.revision).toBe(2);
    expect(second.artifacts[0]!.artifact.revision).toBe(1);
    root[Symbol.dispose]();
  });

  it("owns sessions and canonical LLM/resource entities through references", () => {
    const root = RootProjection.create();
    const sessions = [
      root.projectSession("one", "/project"),
      root.projectSession("two", "/project"),
      root.cakeChat("chat"),
    ];
    for (const [index, session] of sessions.entries()) {
      const snapshot = conversation(session.sessionId, index === 0);
      applyConversationSnapshot(session, snapshot);
    }
    expect(root.llmModels).toHaveLength(1);
    expect(root.resources).toHaveLength(1);
    for (const session of sessions) {
      expect(session.parent).toBe(root);
      expect(session.model).toBe(root.llmModels[0]);
      expect(session.modelOptions[0]!.llmModel).toBe(root.llmModels[0]);
      expect(session.resources[0]!.resource).toBe(root.resources[0]);
    }
    expect(sessions[0]!.modelOptions[0]!.authenticated).toBe(true);
    expect(sessions[1]!.modelOptions[0]!.authenticated).toBe(false);
    expect(sessions[0]!.resources[0]!.enabled).toBe(true);
    expect(sessions[1]!.resources[0]!.enabled).toBe(false);
    const option = sessions[0]!.modelOptions[0];
    const message = sessions[0]!.parts[0];
    const snapshot = conversation("one", false);
    applyProjectSessionUpdate(sessions[0]!, "one", {
      _tag: "Snapshot",
      revision: 2,
      snapshot: {
        identity: {
          _tag: "ProjectSession",
          sessionId: "one",
          projectPath: "/project",
          workingDirectory: "/project",
        },
        projectName: "Project",
        resolved: false,
        unread: false,
        conversation: snapshot,
      },
    });
    expect(sessions[0]!.modelOptions[0]).toBe(option);
    expect(sessions[0]!.parts[0]).toBe(message);
    applyProjectSessionUpdate(sessions[0]!, "one", {
      _tag: "Event",
      revision: 3,
      sessionId: "one",
      event: {
        _tag: "PartUpdated",
        sessionId: "one",
        part: {
          id: "shared-entry",
          kind: "text",
          role: "user",
          text: "Updated",
          status: "complete",
        },
      },
    });
    expect(sessions.map((session) => session.parts[0]!.text)).toEqual(["Updated", "two", "chat"]);
    const restored = RootProjection.create(toSnapshot(root));
    expect(restored.projectSessions[0]!.model).toBe(restored.llmModels[0]);
    expect(restored.cakeChats[0]!.resources[0]!.resource).toBe(restored.resources[0]);
    root.removeProjectSession("one");
    expect(root.projectSession("two", "/project")).toBe(sessions[1]);
    expect(sessions[1]!.model).toBe(root.llmModels[0]);
    restored[Symbol.dispose]();
    root[Symbol.dispose]();
  });
});
