import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import {
  messageNavigationTarget,
  messageReference,
} from "../../src/contracts/conversations/message-reference";
import {
  readMessageReference,
  listMessageReferences,
} from "../../src/services/pi/runtime/message-references";
import { appendToolCompactedBranch } from "../../src/services/pi/runtime/session-tool-compaction";

it("reads the same exact Pi message after persisting, compacting, and reopening the transcript", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cake-message-references-"));
  try {
    const session = SessionManager.create(directory, directory);
    const entryId = session.appendMessage({
      role: "user",
      content: "Original evidence survives restart",
      timestamp: 1,
    });
    const finalId = session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Completed response" }],
      api: "openai-responses",
      provider: "openai",
      model: "test",
      stopReason: "stop",
      timestamp: 2,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    const ref = messageReference(session.getSessionId(), entryId);
    appendToolCompactedBranch(session, finalId);
    session.appendCompaction("Only a summary", session.getLeafId()!, 10_000);
    const reopened = SessionManager.open(session.getSessionFile()!, directory, directory);
    const target = messageNavigationTarget(ref);
    expect(reopened.getSessionId()).toBe(target.sessionId);
    expect(readMessageReference(reopened, { entryId: target.messageId })).toMatchObject({
      message: { ref, active: false },
      text: "Original evidence survives restart",
      truncated: false,
    });
    expect(
      listMessageReferences(reopened, { branch: "all" }).messages.some(
        (message) => message.ref === ref,
      ),
    ).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
