import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  applyPromptCacheLineageKey,
  resolvePromptCacheLineageKey,
} from "../../../src/services/pi/runtime/prompt-cache-lineage";
import { cakeWorkspaceSessionDirectory } from "../../../src/services/pi/runtime/session-discovery";

const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function createTemporaryDirectory() {
  const path = await mkdtemp(join(tmpdir(), "cake-prompt-cache-lineage-"));
  temporaryDirectories.push(path);
  return path;
}

function createPersistedSession(cwd: string, sessionDir: string) {
  const manager = SessionManager.create(cwd, sessionDir);
  manager.appendMessage({ role: "user", content: "Hello", timestamp: Date.now() });
  const leafId = manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Hi" }],
    api: "openai-responses",
    provider: "openai",
    model: "fixture",
    usage: zeroUsage,
    stopReason: "stop",
    timestamp: Date.now(),
  });
  return { manager, leafId };
}

function forkPersisted(manager: SessionManager, leafId: string, sessionDir: string, cwd: string) {
  const forked = SessionManager.open(manager.getSessionFile()!, sessionDir, cwd);
  const file = forked.createBranchedSession(leafId);
  if (!file) throw new Error("fork was not persisted");
  return forked;
}

describe("prompt cache lineage", () => {
  it("uses the session's own ID when it has no fork ancestry", async () => {
    const directory = await createTemporaryDirectory();
    const sessionRoot = join(directory, "sessions");
    const sessionDir = cakeWorkspaceSessionDirectory(directory, sessionRoot);
    const { manager } = createPersistedSession(directory, sessionDir);

    await expect(
      resolvePromptCacheLineageKey({ sessionManager: manager, sessionRoot }),
    ).resolves.toBe(manager.getSessionId());
  });

  it("resolves the root ancestor across nested forks", async () => {
    const directory = await createTemporaryDirectory();
    const sessionRoot = join(directory, "sessions");
    const sessionDir = cakeWorkspaceSessionDirectory(directory, sessionRoot);
    const { manager: root, leafId } = createPersistedSession(directory, sessionDir);
    const child = forkPersisted(root, leafId, sessionDir, directory);
    const grandchild = forkPersisted(child, child.getLeafId()!, sessionDir, directory);

    expect(child.getSessionId()).not.toBe(root.getSessionId());
    expect(grandchild.getSessionId()).not.toBe(child.getSessionId());
    await expect(
      resolvePromptCacheLineageKey({ sessionManager: child, sessionRoot }),
    ).resolves.toBe(root.getSessionId());
    await expect(
      resolvePromptCacheLineageKey({ sessionManager: grandchild, sessionRoot }),
    ).resolves.toBe(root.getSessionId());
  });

  it("stops at the nearest readable ancestor when the chain breaks", async () => {
    const directory = await createTemporaryDirectory();
    const sessionRoot = join(directory, "sessions");
    const sessionDir = cakeWorkspaceSessionDirectory(directory, sessionRoot);
    const { manager: root, leafId } = createPersistedSession(directory, sessionDir);
    const child = forkPersisted(root, leafId, sessionDir, directory);
    const grandchild = forkPersisted(child, child.getLeafId()!, sessionDir, directory);
    await rm(root.getSessionFile()!);

    // Root is gone: the child is the oldest readable ancestor for both.
    await expect(
      resolvePromptCacheLineageKey({ sessionManager: child, sessionRoot }),
    ).resolves.toBe(child.getSessionId());
    await expect(
      resolvePromptCacheLineageKey({ sessionManager: grandchild, sessionRoot }),
    ).resolves.toBe(child.getSessionId());
  });

  it("refuses to follow a parent pointer outside the session root", async () => {
    const directory = await createTemporaryDirectory();
    const sessionRoot = join(directory, "sessions");
    const sessionDir = cakeWorkspaceSessionDirectory(directory, sessionRoot);
    const outsideFile = join(directory, "outside.jsonl");
    await writeFile(
      outsideFile,
      `${JSON.stringify({ type: "session", version: 3, id: "outside", timestamp: "t", cwd: directory })}\n`,
    );
    const manager = SessionManager.create(directory, sessionDir);
    manager.newSession({ parentSession: outsideFile });

    await expect(
      resolvePromptCacheLineageKey({ sessionManager: manager, sessionRoot }),
    ).resolves.toBe(manager.getSessionId());
  });

  it("rewrites only cache key fields pi-ai derived from this session", () => {
    const own = "child-session";
    const root = "root-session";
    const openai = { model: "gpt-5", input: [], prompt_cache_key: own, store: false };
    expect(applyPromptCacheLineageKey(openai, own, root)).toEqual({
      ...openai,
      prompt_cache_key: root,
    });

    const mistral = { model: "mistral-large", messages: [], promptCacheKey: own };
    expect(applyPromptCacheLineageKey(mistral, own, root)).toEqual({
      ...mistral,
      promptCacheKey: root,
    });

    // Caching disabled: pi-ai leaves the key undefined and so do we.
    const disabled = { model: "gpt-5", input: [], prompt_cache_key: undefined };
    expect(applyPromptCacheLineageKey(disabled, own, root)).toBe(disabled);

    // Another extension already chose a key: leave it alone.
    const foreign = { model: "gpt-5", input: [], prompt_cache_key: "custom" };
    expect(applyPromptCacheLineageKey(foreign, own, root)).toBe(foreign);

    // Providers without a cache key field are untouched.
    const anthropic = { model: "claude", messages: [], system: [] };
    expect(applyPromptCacheLineageKey(anthropic, own, root)).toBe(anthropic);

    // A session that is its own root never rewrites.
    expect(applyPromptCacheLineageKey(openai, own, own)).toBe(openai);
  });

  it("clamps the lineage key to OpenAI's maximum length", () => {
    const own = "child";
    const root = "r".repeat(80);
    const result = applyPromptCacheLineageKey({ prompt_cache_key: own }, own, root);
    expect(result.prompt_cache_key).toBe("r".repeat(64));
  });
});
