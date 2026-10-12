import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  cakeWorkspaceSessionDirectory,
  loadDurableArtifactReferences,
} from "../../src/services/pi/runtime/session-discovery";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const pointer = (lineageId: string) => ({
  protocol: "cake.artifact/v1",
  lineageId,
  revision: 1,
  kind: "request",
  digest: "a".repeat(64),
  stableRef: `cake://artifact/${lineageId}`,
  exactRef: `cake://artifact/${lineageId}@r1`,
});

async function session() {
  const root = await mkdtemp(join(tmpdir(), "cake-durable-artifact-references-"));
  roots.push(root);
  const cwd = join(root, "project");
  const sessionRoot = join(root, "sessions");
  const manager = SessionManager.create(cwd, cakeWorkspaceSessionDirectory(cwd, sessionRoot));
  // Pi starts persisting after the first assistant message.
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Historical artifact" }],
    api: "openai-responses",
    provider: "openai",
    model: "fixture",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  });
  return { manager, sessionRoot };
}

describe("durable artifact reachability", () => {
  it("enumerates retired request references in old and current formats, including inactive branches", async () => {
    const { manager, sessionRoot } = await session();
    const branchPoint = manager.getLeafId();
    manager.appendCustomEntry("cake.artifact/v1", {
      protocol: "cake.artifact/v1",
      artifactId: "old-request",
      sessionId: manager.getSessionId(),
      revision: 1,
      kind: "request",
      digest: "a".repeat(64),
      fallback: { markdown: "Historical request" },
    });
    if (!branchPoint) throw new Error("Missing branch point");
    manager.branch(branchPoint);
    manager.appendCustomEntry("cake.artifact/v1", pointer("current-request"));

    const references = await loadDurableArtifactReferences([sessionRoot]);
    expect(references.sessionIds).toEqual([manager.getSessionId()]);
    expect([...references.lineageIds].sort()).toEqual(["current-request", "old-request"]);
  });

  it("still fails closed when a retired reference is actually malformed", async () => {
    const { manager, sessionRoot } = await session();
    manager.appendCustomEntry("cake.artifact/v1", {
      ...pointer("broken-request"),
      exactRef: "cake://artifact/other@r1",
    });
    await expect(loadDurableArtifactReferences([sessionRoot])).rejects.toThrow(
      "Malformed durable cake.artifact/v1 Pi entry",
    );
  });
});
