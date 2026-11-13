import { readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { runInlineWidgetRepair } from "../../src/services/pi/runtime/sidecar-runtime";
import { prepareWidgetConversation } from "../../src/services/pi/runtime/widget-conversation";
import { toolPruneEntryType } from "../../src/services/pi/runtime/tool-prune-provenance";
import { widgetBuildReplacementEntryType } from "../../src/services/pi/runtime/widget-build-context";
import type { WidgetCandidate } from "../../src/contracts/widgets/widget-candidate";
import { call, text, widgetSideChatFixture, type ScriptedReply } from "./fixtures/widget-side-chat";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
});

const provider = "anthropic";
const modelId = "claude-fixture";
type Captured = Awaited<ReturnType<typeof widgetSideChatFixture>>["requests"][number];
/** Pi's compaction request: its own summarization system message, not the build's. */
const summarizing = (request: Captured) => {
  const first = request.messages[0];
  return (
    first?.role === "system" &&
    JSON.stringify(first.content).includes("You are a context summarization assistant")
  );
};
const revisionMarker = "Requested durable revision: say Revised";

/** Summarizes when Pi compacts; otherwise writes the revised widget, then finishes. */
const builder = (request: number, captured: Captured): ScriptedReply => {
  if (summarizing(captured)) return text("## Goal\nRevise the PR tracker widget.");
  if (captured.messages.at(-1)?.role === "toolResult") return text("Revised");
  return {
    content: [
      call(`revise-${request}`, "write", {
        path: "widget/widget.tsx",
        content: "export default function Revised(){return <div>Revised</div>}",
      }),
    ],
  };
};

const filler = (label: string, characters: number) =>
  `${label} ${"x".repeat(Math.max(0, characters - label.length - 1))}`;

const assistant = (
  content: AssistantMessage["content"],
  timestamp: number,
  totalTokens = 0,
): AssistantMessage => ({
  role: "assistant",
  content,
  api: "openai-responses",
  provider,
  model: modelId,
  usage: {
    input: totalTokens ? 4 : 0,
    output: 0,
    cacheRead: totalTokens ? totalTokens - 4 : 0,
    cacheWrite: 0,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
  timestamp,
});

/**
 * A published widget's build session as Cake leaves it: a fork of the parent
 * conversation followed by one assignment, file writes and accepted review per revision.
 * The final accepted reply records provider usage for the whole context.
 */
async function buildSession(
  fixture: Awaited<ReturnType<typeof widgetSideChatFixture>>,
  shape: {
    readonly revisions: number;
    readonly promptCharacters: number;
    readonly writesPerRevision: number;
    readonly writeCharacters: number;
    readonly lastReplyAt: number;
  },
) {
  const manager = await prepareWidgetConversation({
    ...fixture.options,
    conversation: { type: "parent", origin: fixture.origin },
  });
  const at = shape.lastReplyAt;
  for (let revision = 1; revision <= shape.revisions; revision += 1) {
    manager.appendMessage({
      role: "user",
      content: filler(`Revision ${revision} assignment and brief.`, shape.promptCharacters),
      timestamp: at,
    });
    for (let write = 1; write <= shape.writesPerRevision; write += 1) {
      const id = `r${revision}-w${write}`;
      manager.appendMessage(
        assistant(
          [
            call(id, "write", {
              path: "widget/widget.tsx",
              content: filler(`revision ${revision} source`, shape.writeCharacters),
            }),
          ],
          at,
        ),
      );
      manager.appendMessage({
        role: "toolResult",
        toolCallId: id,
        toolName: "write",
        content: [{ type: "text", text: "Wrote widget/widget.tsx" }],
        isError: false,
        timestamp: at,
      });
    }
    if (revision < shape.revisions)
      manager.appendMessage(assistant([{ type: "text", text: "ACCEPT_CURRENT" }], at));
  }
  const tokens = Math.ceil(JSON.stringify(manager.buildSessionContext().messages).length / 4);
  manager.appendMessage(assistant([{ type: "text", text: "ACCEPT_CURRENT" }], at, tokens));
  return {
    sessionId: manager.getSessionId(),
    sessionFile: manager.getSessionFile()!,
    tokens,
  };
}

async function fixtureWithCompactionDisabled(contextWindow: number) {
  const fixture = await widgetSideChatFixture(builder, { provider, id: modelId, contextWindow });
  disposers.push(fixture.dispose);
  // The user's Cake setting that left delta-pr-tracker's build session uncompacted.
  await writeFile(
    join(fixture.cwd, "agent", "settings.json"),
    JSON.stringify({ compaction: { enabled: false } }),
  );
  return fixture;
}

const acceptedSource = "export default function Accepted(){return <div>Accepted</div>}";

const revise = (
  fixture: Awaited<ReturnType<typeof widgetSideChatFixture>>,
  sessionId: string,
  context = "Show blocked CI as its own lane.",
  source = acceptedSource,
) => {
  const candidate: WidgetCandidate = { files: { "widget/widget.tsx": source }, state: null };
  return {
    candidate,
    result: runInlineWidgetRepair({
      ...fixture.options,
      candidate,
      allowState: true,
      conversation: { type: "revision", sessionId },
      language: "react",
      capability: "artifact",
      context,
      diagnostic: revisionMarker,
    }),
  };
};

const revisionRequests = (fixture: Awaited<ReturnType<typeof widgetSideChatFixture>>) =>
  fixture.requests.filter(
    (request) => !summarizing(request) && JSON.stringify(request.messages).includes("say Revised"),
  );

const rejected = (sessionFile: string) =>
  SessionManager.open(sessionFile)
    .getEntries()
    .filter(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "assistant" &&
        entry.message.errorMessage?.includes("prompt is too long"),
    );

describe("widget revision build-session context", () => {
  it("sends a warm revision to the same build session, which auto-compacts before overflowing", async () => {
    const fixture = await fixtureWithCompactionDisabled(120_000);
    const build = await buildSession(fixture, {
      revisions: 6,
      promptCharacters: 4_000,
      writesPerRevision: 3,
      writeCharacters: 24_000,
      lastReplyAt: Date.now() - 60_000,
    });
    // Without compaction, history plus this request exceeds the 120k window.
    expect(build.tokens).toBeGreaterThan(120_000 - 16_384);
    expect(build.tokens).toBeLessThan(120_000);
    const { candidate, result } = revise(fixture, build.sessionId, filler("Context", 40_000));
    const revised = await result;

    expect(revised.sessionId).toBe(build.sessionId);
    expect(revised.sessionFile).toBe(build.sessionFile);
    expect(revised.changed).toBe(true);
    expect(candidate.files["widget/widget.tsx"]).toContain("Revised");
    const summary = fixture.requests.findIndex((request) => summarizing(request));
    const firstRevision = fixture.requests.indexOf(revisionRequests(fixture)[0]!);
    expect(summary).toBeGreaterThanOrEqual(0);
    expect(summary).toBeLessThan(firstRevision);
    const session = SessionManager.open(build.sessionFile);
    expect(session.getBranch().some((entry) => entry.type === "compaction")).toBe(true);
    expect(
      session
        .getEntries()
        .some((entry) => entry.type === "custom" && entry.customType === toolPruneEntryType),
    ).toBe(false);
    expect(rejected(build.sessionFile)).toEqual([]);
  });

  it("tool-prunes a cold build session in place before sending the revision", async () => {
    const fixture = await fixtureWithCompactionDisabled(120_000);
    const build = await buildSession(fixture, {
      revisions: 4,
      promptCharacters: 4_000,
      writesPerRevision: 3,
      writeCharacters: 20_000,
      lastReplyAt: Date.now() - 3 * 60 * 60_000,
    });
    expect(build.tokens).toBeGreaterThan(50_000);
    const { result } = revise(fixture, build.sessionId);
    const revised = await result;

    expect(revised.sessionId).toBe(build.sessionId);
    expect(revised.sessionFile).toBe(build.sessionFile);
    expect(revised.changed).toBe(true);
    expect(fixture.requests.some((request) => summarizing(request))).toBe(false);
    const [first] = revisionRequests(fixture);
    const history = JSON.stringify(first!.messages);
    expect(history).not.toContain("revision 1 source");
    expect(history).toContain("Revision 1 assignment and brief.");
    expect(first!.messages.some((message) => message.role === "toolResult")).toBe(false);
    const session = SessionManager.open(build.sessionFile);
    expect(
      session
        .getBranch()
        .some((entry) => entry.type === "custom" && entry.customType === toolPruneEntryType),
    ).toBe(true);
    expect(await readdir(fixture.options.sessionDir)).toHaveLength(1);
  });

  describe("a 17-revision, 4.5 MB build session like delta-pr-tracker's", () => {
    const deltaShape = {
      revisions: 17,
      promptCharacters: 40_000,
      writesPerRevision: 4,
      writeCharacters: 56_000,
    };

    it("publishes a cold revision without 'prompt is too long'", async () => {
      const fixture = await fixtureWithCompactionDisabled(1_000_000);
      // f2c7a473 retried 22 minutes after rev17 was accepted.
      const build = await buildSession(fixture, {
        ...deltaShape,
        lastReplyAt: Date.now() - 22 * 60_000,
      });
      expect((await stat(build.sessionFile)).size).toBeGreaterThan(4_500_000);
      expect(build.tokens).toBeGreaterThan(1_000_000);
      const revised = await revise(fixture, build.sessionId).result;

      expect(revised.sessionId).toBe(build.sessionId);
      expect(revised.changed).toBe(true);
      expect(rejected(build.sessionFile)).toEqual([]);
    });

    it("tool-prunes the same session and retries once when warm auto-compaction cannot fit it", async () => {
      const fixture = await fixtureWithCompactionDisabled(1_000_000);
      const build = await buildSession(fixture, {
        ...deltaShape,
        lastReplyAt: Date.now() - 60_000,
      });
      const revised = await revise(fixture, build.sessionId).result;

      expect(revised.sessionId).toBe(build.sessionId);
      expect(revised.changed).toBe(true);
      // Compaction was attempted first; its oversized summary request was rejected.
      expect(fixture.requests.some((request) => summarizing(request))).toBe(true);
      const session = SessionManager.open(build.sessionFile);
      expect(
        session
          .getBranch()
          .some((entry) => entry.type === "custom" && entry.customType === toolPruneEntryType),
      ).toBe(true);
      expect(await readdir(fixture.options.sessionDir)).toHaveLength(1);
    });
  });

  describe("a build session whose pruned dialogue alone exceeds a 250k model", () => {
    // Like delta-pr-tracker rev18: ~469k tokens after pruning against a 233,616-token budget.
    const oversized = {
      revisions: 17,
      promptCharacters: 110_000,
      writesPerRevision: 2,
      writeCharacters: 56_000,
    };

    it.each([
      // Cold: pruning shows it cannot fit before anything is sent.
      ["cold", 22 * 60_000, false],
      // Warm: auto-compaction is tried first and overflows, then the forced prune.
      ["warm", 60_000, true],
    ])(
      "moves a %s revision to a fresh build session seeded with the current widget",
      async (_cache, age, triedOldSession) => {
        const fixture = await fixtureWithCompactionDisabled(250_000);
        const build = await buildSession(fixture, { ...oversized, lastReplyAt: Date.now() - age });
        const { candidate, result } = revise(fixture, build.sessionId);
        const revised = await result;

        expect(revised.sessionId).not.toBe(build.sessionId);
        expect(revised.changed).toBe(true);
        expect(fixture.requests.some((request) => request.sessionId === build.sessionId)).toBe(
          triedOldSession,
        );
        expect(candidate.files["widget/widget.tsx"]).toContain("Revised");
        const [seeded, ...rest] = fixture.requests.filter(
          (request) => request.sessionId === revised.sessionId,
        );
        const seed = JSON.stringify(seeded!.messages);
        // Seeded from the current source plus the unchanged revision request and brief.
        expect(seed).toContain(acceptedSource.replaceAll('"', '\\"'));
        expect(seed).toContain("say Revised");
        expect(seed).toContain("Show blocked CI as its own lane.");
        expect(seed).toContain(build.sessionId);
        expect(seed).not.toContain("Revision 1 assignment and brief.");
        expect(rest.length).toBeGreaterThan(0);
        expect(rejected(revised.sessionFile!)).toEqual([]);
        const replacement = SessionManager.open(revised.sessionFile!);
        expect(replacement.getEntries()).toContainEqual(
          expect.objectContaining({
            type: "custom",
            customType: widgetBuildReplacementEntryType,
            data: expect.objectContaining({ replacedSessionId: build.sessionId }),
          }),
        );
        // The old build session is kept, not rewritten into the replacement.
        expect(SessionManager.open(build.sessionFile).getSessionId()).toBe(build.sessionId);
        expect(await readdir(fixture.options.sessionDir)).toHaveLength(2);

        // The next revision reopens the replacement on the normal path.
        const next = await revise(fixture, revised.sessionId).result;
        expect(next.sessionId).toBe(revised.sessionId);
        expect(await readdir(fixture.options.sessionDir)).toHaveLength(2);
      },
    );

    it("fails with a caller-actionable error when even the seeded session cannot fit", async () => {
      const fixture = await fixtureWithCompactionDisabled(250_000);
      const build = await buildSession(fixture, {
        ...oversized,
        lastReplyAt: Date.now() - 3 * 60 * 60_000,
      });
      const huge = filler("export default function Huge(){return <div>", 1_200_000);
      const { candidate, result } = revise(fixture, build.sessionId, undefined, huge);

      await expect(result).rejects.toThrow(
        /Widget revision did not fit: a fresh build session seeded with only the current widget source.*about [\d,]+ tokens, over the 233,616-token budget of anthropic\/claude-fixture\. Nothing was published/,
      );
      expect(fixture.requests).toEqual([]);
      expect(candidate.files["widget/widget.tsx"]).toBe(huge);
      // No replacement session was persisted.
      expect(await readdir(fixture.options.sessionDir)).toHaveLength(1);
    });
  });
});
