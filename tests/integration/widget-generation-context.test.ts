import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  getCurrentSystemPrompt,
  getCurrentTools,
  normalizeContext,
  type Message,
  type Model,
} from "@earendil-works/pi-ai";
import { streamSimple as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import {
  runInlineWidgetGeneration,
  runInlineWidgetRepair,
  runInlineWidgetVisualReview,
} from "../../src/services/pi/runtime/sidecar-runtime";
import type { WidgetCandidate } from "../../src/contracts/widgets/widget-candidate";
import { assembleWidgetSource } from "../../src/services/widgets/widget-files";
import { compileInlineWidget } from "../../src/services/widgets/inline-widget-service";
import { readPrototypeSource } from "../../src/services/widgets/prototype-source";
import { call, text, widgetSideChatFixture, type ScriptedReply } from "./fixtures/widget-side-chat";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
});

const anthropic: Model<"anthropic-messages"> = {
  id: "claude-fixture",
  name: "Claude fixture",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://anthropic.invalid",
  reasoning: false,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 128_000,
  compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true },
};

/** The exact Anthropic request body Pi would send for these messages, never sent. */
async function anthropicPayload(messages: Message[]) {
  let payload: Record<string, unknown> | undefined;
  const stream = anthropicStream(anthropic, normalizeContext({ messages }), {
    apiKey: "sk-ant-api03-fixture",
    onPayload: (body) => {
      payload = structuredClone(body) as Record<string, unknown>;
      throw new Error("captured");
    },
  });
  // The stream ends with the captured error once the request body is built.
  await stream.result();
  if (!payload) throw new Error("No Anthropic payload was built");
  return JSON.parse(
    JSON.stringify(payload, (key, value: unknown) => (key === "cache_control" ? undefined : value)),
  ) as { system: unknown; tools: unknown; messages: unknown[] };
}

function expectParentCacheReuse(
  requests: ReadonlyArray<{ messages: Message[] }>,
  inherited: Message[],
) {
  for (const request of requests) {
    // The parent's own next request would start with exactly these messages.
    expect(request.messages.slice(0, inherited.length)).toEqual(inherited);
    // A system update anywhere after them would make providers re-read everything.
    expect(
      request.messages.slice(inherited.length).filter((message) => message.role === "system"),
    ).toEqual([]);
    expect(getCurrentTools(request.messages)).toEqual(getCurrentTools(inherited));
    expect(getCurrentSystemPrompt(request.messages)).toBe(getCurrentSystemPrompt(inherited));
  }
}

describe("widget side chat through the real Pi runtime", () => {
  it("reuses the parent's prompt cache across generation, repair and screenshot review", async () => {
    const replies: ScriptedReply[] = [];
    const fixture = await widgetSideChatFixture((request) => replies[request - 1]!);
    disposers.push(fixture.dispose);
    replies.push(
      {
        content: [
          call("skill", "read", { path: join(fixture.skillDir, "template.tsx") }),
          call("secret", "read", { path: join(fixture.cwd, "secret.txt") }),
          call("shell", "bash", { command: "cat secret.txt" }),
          call("outside", "write", { path: join(fixture.cwd, "escape.tsx"), content: "x" }),
          call("source", "write", {
            path: "widget/widget.tsx",
            content: "export default function Chart(){return <div>Initial</div>}",
          }),
          call("state", "write", { path: "widget/state.json", content: '{"quarter":"Q1"}' }),
        ],
      },
      text("Done"),
      {
        content: [
          call("fix", "edit", {
            path: "widget/widget.tsx",
            edits: [{ oldText: "Initial", newText: "Repaired" }],
          }),
        ],
      },
      text("Fixed"),
      text("ACCEPT_CURRENT"),
    );
    const candidate: WidgetCandidate = { files: {}, state: null };
    const branch = { ...fixture.options, candidate, allowState: true };

    const generated = await runInlineWidgetGeneration({
      ...branch,
      conversation: { type: "parent", origin: fixture.origin },
      brief: "Make the chart",
      fallback: "Quarterly revenue",
    });
    const conversation = { type: "continue" as const, sessionId: generated.sessionId };
    const repaired = await runInlineWidgetRepair({
      ...branch,
      conversation,
      language: "react",
      capability: "artifact",
      context: "Quarterly revenue",
      diagnostic: "Compilation failed: example",
    });
    const reviewed = await runInlineWidgetVisualReview({
      ...branch,
      conversation,
      context: "Quarterly revenue",
      diagnostic: "Readable",
      pngBase64: "cG5n",
      model: fixture.options.model,
    });

    expect(fixture.requests).toHaveLength(5);
    expectParentCacheReuse(fixture.requests, fixture.inherited);
    expect(generated.changed).toBe(true);
    expect(repaired.changed).toBe(true);
    expect(reviewed).toMatchObject({ response: "ACCEPT_CURRENT", changed: false });
    expect(candidate).toEqual({
      files: { "widget/widget.tsx": "export default function Chart(){return <div>Repaired</div>}" },
      state: { quarter: "Q1" },
    });
    for (const request of fixture.requests)
      expect(request.payload).toMatchObject({ prompt_cache_key: fixture.parent.getSessionId() });

    // Refused tools fail without touching anything; skill resources stay readable.
    const results = fixture.requests[1]!.messages.filter(
      (message) => message.role === "toolResult",
    );
    expect(results.filter((result) => result.isError).map((result) => result.toolCallId)).toEqual([
      "secret",
      "shell",
      "outside",
    ]);
    expect(results.find((result) => result.toolCallId === "skill")?.content).toEqual([
      { type: "text", text: "domain-template-resource" },
    ]);
    expect(JSON.stringify(results)).not.toContain("private-secret");

    // The persisted branch never records a system update either.
    const persisted = SessionManager.open(generated.sessionFile!).getBranch();
    const systemEntries = persisted.filter(
      (entry) => entry.type === "message" && entry.message.role === "system",
    );
    expect(systemEntries).toHaveLength(1);
    expect(reviewed.sessionId).toBe(generated.sessionId);
    expect(generated.sessionId).not.toBe(fixture.parent.getSessionId());

    // On Anthropic, the side chat's request bytes start with the parent's request bytes.
    const parentRequest = await anthropicPayload(fixture.inherited);
    const sideChatRequest = await anthropicPayload(fixture.requests[0]!.messages);
    expect(sideChatRequest.system).toEqual(parentRequest.system);
    expect(sideChatRequest.tools).toEqual(parentRequest.tools);
    expect(sideChatRequest.messages.slice(0, parentRequest.messages.length)).toEqual(
      parentRequest.messages,
    );
  });

  it("refuses to start rather than miss the cache when the parent lacks file tools", async () => {
    const fixture = await widgetSideChatFixture(() => text("Done"));
    disposers.push(fixture.dispose);
    fixture.parent.appendMessage({
      role: "system",
      content: "",
      toolsRemoved: [{ name: "write" }],
      timestamp: 2,
    });
    await expect(
      runInlineWidgetGeneration({
        ...fixture.options,
        candidate: { files: {}, state: null },
        allowState: true,
        conversation: {
          type: "parent",
          origin: {
            ...fixture.origin,
            entryId: fixture.parent.getLeafId()!,
          },
        },
        brief: "Chart",
        fallback: "Chart",
      }),
    ).rejects.toThrow("does not declare write");
    expect(fixture.requests).toEqual([]);
  });

  it("builds a five-prototype widget the size of the failed session over many short turns", async () => {
    const ids = ["dense-list", "split-pane", "card-grid", "timeline", "minimal"];
    // About 12 KB per option: the whole widget would not fit one reasoning-heavy reply.
    const option = (id: string, index: number) =>
      [
        'import { gap, palette } from "cake:prototype/tokens";',
        `const rows = ${JSON.stringify(
          Array.from({ length: 110 }, (_, row) => ({
            id: `${id}-${row}`,
            title: `Goal ${row + 1}: restore the self-healing workflow for tenant ${index}`,
            status: row % 3 === 0 ? "blocked" : "done",
          })),
        )};`,
        `export default function Option${index}() {`,
        "  return (",
        `    <section aria-label="${id}" style={{ display: "grid", gap, color: palette.text }}>`,
        "      {rows.map((row) => <article key={row.id}><h3>{row.title}</h3><p>{row.status}</p></article>)}",
        "    </section>",
        "  );",
        "}",
      ].join("\n");
    const chooser = [
      'import { useState } from "react";',
      'import { useArtifactState } from "@cake/artifact-sdk";',
      ...ids.map((id, index) => `import Option${index} from "cake:prototype/${id}";`),
      `const options = [${ids.map((id, index) => `{ id: "${id}", View: Option${index} }`).join(", ")}];`,
      "export default function Chooser() {",
      '  const { value, hydrated, save } = useArtifactState({ schema: "cake.prototype-ui/v1", selectedOptionId: null });',
      "  const [active, setActive] = useState(options[0].id);",
      "  const current = options.find((option) => option.id === active) ?? options[0];",
      "  return (",
      "    <main>",
      "      <nav>{options.map((option) => <button key={option.id} onClick={() => setActive(option.id)}>{option.id}</button>)}</nav>",
      "      <current.View />",
      "      <button disabled={!hydrated} onClick={() => save({ ...value, selectedOptionId: current.id })}>Choose this</button>",
      "    </main>",
      "  );",
      "}",
    ].join("\n");
    const writes = [
      call("tokens", "write", {
        path: "widget/shared/tokens.tsx",
        content:
          'export const gap = 8;\nexport const palette = { text: "var(--foreground)", border: "var(--border)" };',
      }),
      ...ids.map((id, index) =>
        call(`option-${index}`, "write", {
          path: `widget/options/${id}.tsx`,
          content: option(id, index),
        }),
      ),
      call("chooser", "write", { path: "widget/chooser.tsx", content: chooser }),
    ];
    // One file per reply, each with a modest output, exactly as the assignment asks.
    const replies: ScriptedReply[] = [
      ...writes.map((write) => ({ content: [write], outputTokens: 4_000 })),
      { ...text("All files written."), outputTokens: 50 },
    ];
    const fixture = await widgetSideChatFixture((request) => replies[request - 1]!);
    disposers.push(fixture.dispose);
    const candidate: WidgetCandidate = { files: {}, state: null };
    const generated = await runInlineWidgetGeneration({
      ...fixture.options,
      candidate,
      allowState: true,
      conversation: { type: "parent", origin: fixture.origin },
      brief: `# Goal History tab: five prototypes\n${"Show goal history with readable states. ".repeat(400)}`,
      data: {
        goals: Array.from({ length: 240 }, (_, index) => ({
          id: `goal-${index}`,
          title: `Goal ${index}`,
          status: index % 4 === 0 ? "blocked" : "done",
          visits: index * 3,
        })),
      },
      fallback: "Five Goal History prototypes",
    });

    expect(generated.changed).toBe(true);
    expect(fixture.requests).toHaveLength(writes.length + 1);
    expectParentCacheReuse(fixture.requests, fixture.inherited);
    expect(fixture.requests[0]!.messages.at(-1)!.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining("Goal History tab") }),
    ]);
    expect(JSON.stringify(fixture.requests[0]!.messages.at(-1)).length).toBeGreaterThan(30_000);

    const source = assembleWidgetSource(candidate.files, "react");
    expect(source.length).toBeGreaterThan(60_000);
    for (const write of writes)
      expect(String(write.arguments.content).length).toBeLessThan(source.length / 4);
    const manifest = readPrototypeSource(source)!;
    expect(manifest.options.map((module) => module.id)).toEqual(ids);
    expect(manifest.options[0]!.dependencies).toEqual(["cake:prototype/tokens"]);
    const compiled = await compileInlineWidget("react", source, "artifact");
    expect(compiled.document).toContain("Choose this");
  });
});
