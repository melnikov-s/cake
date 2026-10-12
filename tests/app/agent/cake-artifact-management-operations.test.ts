import type * as fsPromises from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { ArtifactProjectionMetadata } from "../../../src/contracts/artifacts/artifact-projection-data";
import type {
  ArtifactRecord,
  CakeArtifactV1,
} from "../../../src/contracts/artifacts/artifact-contract";
import {
  createCakeArtifactOperations,
  type CakeArtifactOperationOptions,
} from "../../../src/services/pi/runtime/cake-artifact-operations";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";

// Pi's mutation queue canonicalizes paths; artifact I/O itself stays in memory.
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof fsPromises>()),
  realpath: vi.fn(async (path: string) => path),
}));

const runtime = {
  sessionManager: { getSessionId: () => "session-1", getLeafId: () => "assistant-1" },
  model: { provider: "provider", id: "model" },
};
const context = (toolCallId = "tool-1") => ({
  signal: new AbortController().signal,
  toolCallId,
  runtime,
});
const record = (artifact: CakeArtifactV1): ArtifactRecord => ({
  artifact,
  workspacePath: "/workspace",
  digest: String(artifact.revision).padStart(64, "a").slice(-64),
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});
const metadata = (artifact: CakeArtifactV1): ArtifactProjectionMetadata => ({
  lineageId: artifact.id,
  ...(artifact.title === undefined ? null : { title: artifact.title }),
  kind: artifact.kind,
  selectedRevision: artifact.revision,
  latestRevision: artifact.revision,
  digest: record(artifact).digest,
  linkMode: "follow-latest",
  stableRef: `cake://artifact/${artifact.id}`,
  exactRef: `cake://artifact/${artifact.id}@r${artifact.revision}`,
  exactPath: `/cache/${artifact.id}/r${artifact.revision}`,
  latestPath: `/cache/${artifact.id}/r${artifact.revision}`,
  files: [
    {
      name: "content.md",
      path: `/cache/${artifact.id}/r${artifact.revision}/content.md`,
      byteSize: 4,
      sha256: "b".repeat(64),
    },
  ],
});
const markdown = (revision: number, value: string): CakeArtifactV1 => ({
  protocol: "cake.artifact/v1",
  id: "design-plan",
  sessionId: "session-1",
  revision,
  kind: "markdown",
  title: "Design plan",
  payload: { markdown: value },
  fallback: { markdown: value },
  interaction: { mode: "present" },
});

function makeHarness(initial: CakeArtifactV1 = markdown(1, "one")) {
  let current = initial;
  const revisions = new Map([[initial.revision, initial]]);
  const appendEntry = vi.fn();
  const callbacks: CakeArtifactOperationOptions = {
    persistArtifact: vi.fn(async (artifact) => {
      current = artifact;
      revisions.set(artifact.revision, artifact);
      return record(artifact);
    }),
    resolveArtifact: vi.fn(async (reference) => {
      const match = /@r(\d+)$/.exec(reference);
      const selected = match ? revisions.get(Number(match[1])) : current;
      if (!selected) throw new Error(`Unknown artifact revision: ${reference}`);
      return { record: record(selected), metadata: metadata(selected) };
    }),
    listArtifactMetadata: vi.fn(async () => [metadata(current)]),
    historyArtifact: vi.fn(async () => [...revisions.values()].map(metadata)),
    restoreArtifact: vi.fn(async ({ sourceRevision, expectedRevision }) => {
      current = markdown(expectedRevision + 1, sourceRevision === 1 ? "one" : "two");
      revisions.set(current.revision, current);
      return { record: record(current), metadata: metadata(current) };
    }),
    linkArtifact: vi.fn(async () => metadata(current)),
    unlinkArtifact: vi.fn(async () => undefined),
  };
  return {
    appendEntry,
    callbacks,
    registry: new CakeOperationRegistry(createCakeArtifactOperations({ appendEntry }, callbacks)),
  };
}

describe("Cake artifact management operations", () => {
  it("keeps create help aligned with the chat-first text artifact policy", async () => {
    const { registry } = makeHarness();
    const help = await registry.invoke({ command: "artifacts.create.help" }, context());
    expect(help.text).toContain(
      "Keep investigations, explanations, ordinary implementation details, progress, and reports in chat by default",
    );
    expect(help.text).toContain(
      "Create text/Markdown artifacts only when the user explicitly requests them, except for a spec serving as a shared, durable reference",
    );
    expect(help.text).toContain("this session can read after compaction");
    expect(help.text).toContain("child sessions can read for coordinated implementation");
    expect(help.text).toContain("Shared-reference usefulness, not length or formatting");
    expect(help.text).toContain("merely being an investigation does not qualify");
    expect(help.text).toContain(
      "This text/Markdown policy does not restrict non-text visual artifacts or explicitly requested file deliverables",
    );
    expect(help.text).toContain(
      "Import a workspace file when the file itself is the reusable deliverable",
    );
  });

  it("exposes bounded metadata operations without a payload-returning read command", async () => {
    const { registry } = makeHarness();
    expect(registry.definitions().map((item) => item.command)).not.toContain("artifacts.read");
    const listed = await registry.invoke({ command: "artifacts.list" }, context());
    expect(listed.details).toMatchObject({
      result: {
        total: 1,
        artifacts: [{ lineageId: "design-plan", exactPath: "/cache/design-plan/r1" }],
      },
    });
    const resolved = await registry.invoke(
      { command: "artifacts.resolve-reference", input: { reference: "design-plan@r1" } },
      context(),
    );
    expect(JSON.stringify(resolved.details)).not.toContain('"payload"');
    expect(resolved.details).toMatchObject({
      result: { exactRef: "cake://artifact/design-plan@r1" },
    });
  });

  it("requires expectedRevision, publishes one exact pointer, and rejects a stale update", async () => {
    const { registry, appendEntry, callbacks } = makeHarness();
    await registry.invoke(
      {
        command: "artifacts.update",
        input: {
          lineageId: "design-plan",
          expectedRevision: 1,
          edits: [{ oldText: "one", newText: "two" }],
        },
      },
      context("tool-update"),
    );
    expect(callbacks.persistArtifact).toHaveBeenCalledOnce();
    expect(appendEntry).toHaveBeenCalledOnce();
    expect(appendEntry).toHaveBeenCalledWith(
      "cake.artifact/v1",
      expect.objectContaining({
        lineageId: "design-plan",
        revision: 2,
        stableRef: "cake://artifact/design-plan",
        exactRef: "cake://artifact/design-plan@r2",
      }),
    );
    expect(JSON.stringify(appendEntry.mock.calls[0]?.[1])).not.toContain("fallback");
    await expect(
      registry.invoke(
        {
          command: "artifacts.update",
          input: {
            lineageId: "design-plan",
            expectedRevision: 1,
            edits: [{ oldText: "two", newText: "stale" }],
          },
        },
        context(),
      ),
    ).rejects.toThrow("expected 1");
  });

  it("applies disjoint edits against the original revision and retains historical content", async () => {
    const initial = { ...markdown(1, "α\r\nfirst middle last\r\nω"), sessionId: "original-parent" };
    const { registry, callbacks } = makeHarness(initial);
    const result = await registry.invoke(
      {
        command: "artifacts.update",
        input: {
          lineageId: "design-plan",
          expectedRevision: 1,
          title: "Updated plan",
          edits: [
            { oldText: "last", newText: "first" },
            { oldText: "first", newText: "last" },
            { oldText: " middle", newText: "" },
          ],
        },
      },
      context(),
    );
    expect(callbacks.persistArtifact).toHaveBeenCalledWith({
      ...initial,
      sessionId: "session-1",
      revision: 2,
      title: "Updated plan",
      payload: { markdown: "α\r\nlast first\r\nω" },
      fallback: { markdown: "α\r\nlast first\r\nω" },
    });
    expect(result.details).toMatchObject({
      result: { selectedRevision: 2, title: "Updated plan" },
    });
    expect(JSON.stringify(result.details)).not.toContain("last first");
    expect(
      (await callbacks.resolveArtifact!("cake://artifact/design-plan@r1")).record.artifact,
    ).toEqual(initial);
  });

  it.each([
    {
      name: "BOM and CRLF preservation with LF edit input",
      value: "\uFEFF# Plan\r\n\r\nOld paragraph.\r\nTail\r\n",
      edits: [{ oldText: "Old paragraph.\nTail", newText: "New paragraph.\nTail" }],
      expected: "\uFEFF# Plan\r\n\r\nNew paragraph.\r\nTail\r\n",
    },
    {
      name: "fuzzy whitespace and typography matching without rewriting untouched lines",
      value: "Untouched “quote”  \nUse “old”—label.  \nUntouched ‘tail’  \n",
      edits: [{ oldText: 'Use "old"-label.', newText: "Use new label." }],
      expected: "Untouched “quote”  \nUse new label.\nUntouched ‘tail’  \n",
    },
    {
      name: "prepend and append through boundary anchors",
      value: "# Plan\n\nFinal paragraph.",
      edits: [
        { oldText: "Final paragraph.", newText: "Final paragraph.\n\nAppended." },
        { oldText: "# Plan", newText: "Prepended.\n\n# Plan" },
      ],
      expected: "Prepended.\n\n# Plan\n\nFinal paragraph.\n\nAppended.",
    },
    {
      name: "Pi's non-overlapping occurrence-count behavior",
      value: "aaa",
      edits: [{ oldText: "aa", newText: "x" }],
      expected: "xa",
    },
  ])("uses Pi's edit behavior for $name", async ({ value, edits, expected }) => {
    const initial = markdown(1, value);
    const { registry, callbacks, appendEntry } = makeHarness(initial);
    await registry.invoke(
      {
        command: "artifacts.update",
        input: { lineageId: "design-plan", expectedRevision: 1, edits },
      },
      context(),
    );
    expect(callbacks.persistArtifact).toHaveBeenCalledWith(markdown(2, expected));
    expect(appendEntry).toHaveBeenCalledOnce();
    expect(
      (await callbacks.resolveArtifact!("cake://artifact/design-plan@r1")).record.artifact,
    ).toEqual(initial);
  });

  it("does not publish a cancelled edit", async () => {
    const { registry, callbacks, appendEntry } = makeHarness();
    const controller = new AbortController();
    controller.abort();
    await expect(
      registry.invoke(
        {
          command: "artifacts.update",
          input: {
            lineageId: "design-plan",
            expectedRevision: 1,
            edits: [{ oldText: "one", newText: "two" }],
          },
        },
        { ...context(), signal: controller.signal },
      ),
    ).rejects.toThrow("aborted");
    expect(callbacks.persistArtifact).not.toHaveBeenCalled();
    expect(appendEntry).not.toHaveBeenCalled();
  });

  it("allows adjacent matches and literal replacement text across successive revisions", async () => {
    const { registry, callbacks, appendEntry } = makeHarness(markdown(1, "abcdef"));
    await registry.invoke(
      {
        command: "artifacts.update",
        input: {
          lineageId: "design-plan",
          expectedRevision: 1,
          edits: [
            { oldText: "def", newText: "" },
            { oldText: "abc", newText: "$&\nα" },
          ],
        },
      },
      context(),
    );
    expect(callbacks.persistArtifact).toHaveBeenLastCalledWith(markdown(2, "$&\nα"));
    await registry.invoke(
      {
        command: "artifacts.update",
        input: {
          lineageId: "design-plan",
          expectedRevision: 2,
          edits: [{ oldText: "$&\nα", newText: "" }],
        },
      },
      context(),
    );
    expect(callbacks.persistArtifact).toHaveBeenLastCalledWith(markdown(3, ""));
    expect(appendEntry).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: "missing match after a valid edit",
      value: "first second",
      edits: [
        { oldText: "first", newText: "changed" },
        { oldText: "missing", newText: "x" },
      ],
      error: "Could not find",
    },
    {
      name: "no-op edit",
      value: "one",
      edits: [{ oldText: "one", newText: "one" }],
      error: "No changes made",
    },
    {
      name: "ambiguity after Pi's typography normalization",
      value: 'Use “label”.\nUse "label".',
      edits: [{ oldText: 'Use "label".', newText: "New label." }],
      error: "must be unique",
    },
    {
      name: "ambiguous match",
      value: "repeat repeat",
      edits: [{ oldText: "repeat", newText: "x" }],
      error: "must be unique",
    },
    {
      name: "overlapping edits",
      value: "abcdef",
      edits: [
        { oldText: "abc", newText: "x" },
        { oldText: "cde", newText: "y" },
      ],
      error: "overlap",
    },
    {
      name: "nested edits",
      value: "abcdef",
      edits: [
        { oldText: "abcde", newText: "x" },
        { oldText: "bcd", newText: "y" },
      ],
      error: "overlap",
    },
    {
      name: "duplicate edits",
      value: "abcdef",
      edits: [
        { oldText: "abc", newText: "x" },
        { oldText: "abc", newText: "y" },
      ],
      error: "overlap",
    },
    {
      name: "match introduced by an earlier edit",
      value: "first",
      edits: [
        { oldText: "first", newText: "second" },
        { oldText: "second", newText: "third" },
      ],
      error: "Could not find",
    },
  ])("rejects $name without publishing any partial update", async ({ value, edits, error }) => {
    const initial = markdown(1, value);
    const { registry, callbacks, appendEntry } = makeHarness(initial);
    await expect(
      registry.invoke(
        {
          command: "artifacts.update",
          input: { lineageId: "design-plan", expectedRevision: 1, edits },
        },
        context(),
      ),
    ).rejects.toThrow(error);
    expect(callbacks.persistArtifact).not.toHaveBeenCalled();
    expect(appendEntry).not.toHaveBeenCalled();
    expect(
      (await callbacks.resolveArtifact!("cake://artifact/design-plan")).record.artifact,
    ).toEqual(initial);
  });

  it.each([
    { expectedRevision: 1, edits: [] },
    { expectedRevision: 1, edits: [{ oldText: "", newText: "x" }] },
    { edits: [{ oldText: "one", newText: "two" }] },
    { expectedRevision: 1, markdown: "two" },
    { expectedRevision: 1, path: "replacement.pdf" },
    { expectedRevision: 1, instructions: "Revise it" },
  ])("validates targeted update inputs before resolving or persisting", async (input) => {
    const { registry, callbacks, appendEntry } = makeHarness();
    await expect(
      registry.invoke(
        {
          command: "artifacts.update",
          input: { lineageId: "design-plan", ...input },
        },
        context(),
      ),
    ).rejects.toThrow();
    expect(callbacks.resolveArtifact).not.toHaveBeenCalled();
    expect(callbacks.persistArtifact).not.toHaveBeenCalled();
    expect(appendEntry).not.toHaveBeenCalled();
  });

  it("rejects updates whose resulting snapshot exceeds the artifact byte limit", async () => {
    const { registry, callbacks, appendEntry } = makeHarness(markdown(1, "prefix one suffix"));
    await expect(
      registry.invoke(
        {
          command: "artifacts.update",
          input: {
            lineageId: "design-plan",
            expectedRevision: 1,
            edits: [{ oldText: "one", newText: "é".repeat(524_200) }],
          },
        },
        context(),
      ),
    ).rejects.toThrow("byte limit");
    expect(callbacks.persistArtifact).not.toHaveBeenCalled();
    expect(appendEntry).not.toHaveBeenCalled();
  });

  it("replaces complete Markdown and rejects stale replacements", async () => {
    const { registry, callbacks, appendEntry } = makeHarness();
    const result = await registry.invoke(
      {
        command: "artifacts.replace",
        input: {
          lineageId: "design-plan",
          expectedRevision: 1,
          title: "Replacement",
          markdown: "two",
        },
      },
      context(),
    );
    expect(callbacks.persistArtifact).toHaveBeenCalledWith({
      ...markdown(2, "two"),
      title: "Replacement",
    });
    expect(result.details).toMatchObject({ result: { selectedRevision: 2 } });
    expect(appendEntry).toHaveBeenCalledOnce();
    await expect(
      registry.invoke(
        {
          command: "artifacts.replace",
          input: { lineageId: "design-plan", expectedRevision: 1, markdown: "stale" },
        },
        context(),
      ),
    ).rejects.toThrow("expected 1");
    expect(callbacks.persistArtifact).toHaveBeenCalledOnce();
    expect(appendEntry).toHaveBeenCalledOnce();
  });

  it("snapshots replacement files and directs targeted updates to Markdown only", async () => {
    const initial: CakeArtifactV1 = {
      ...markdown(1, "Report"),
      kind: "file",
      payload: { name: "report.txt", mimeType: "text/plain", data: "b25l", byteSize: 3 },
    };
    const { registry, callbacks, appendEntry } = makeHarness(initial);
    await expect(
      registry.invoke(
        {
          command: "artifacts.update",
          input: {
            lineageId: "design-plan",
            expectedRevision: 1,
            edits: [{ oldText: "one", newText: "two" }],
          },
        },
        context(),
      ),
    ).rejects.toThrow("not markdown");
    expect(callbacks.persistArtifact).not.toHaveBeenCalled();
    const replacement: CakeArtifactV1 = {
      ...initial,
      revision: 2,
      title: "New report",
      payload: { ...initial.payload, data: "dHdv" },
    };
    callbacks.importArtifactFile = vi.fn(async () => replacement);
    await registry.invoke(
      {
        command: "artifacts.replace",
        input: {
          lineageId: "design-plan",
          expectedRevision: 1,
          title: "New report",
          path: "report.txt",
        },
      },
      context(),
    );
    expect(callbacks.importArtifactFile).toHaveBeenCalledWith({
      id: "design-plan",
      revision: 2,
      title: "New report",
      path: "report.txt",
    });
    expect(callbacks.persistArtifact).toHaveBeenCalledWith(replacement);
    expect(appendEntry).toHaveBeenCalledOnce();
  });

  it("advertises targeted updates separately from full replacements", async () => {
    const { registry } = makeHarness();
    const updateHelp = await registry.invoke({ command: "artifacts.update.help" }, context());
    expect(updateHelp.text).toContain("not incrementally");
    expect(updateHelp.text).toContain('"edits"');
    expect(updateHelp.text).toContain("artifacts.replace");
    const replaceHelp = await registry.invoke({ command: "artifacts.replace.help" }, context());
    expect(replaceHelp.text).toContain('"markdown"');
    expect(replaceHelp.text).toContain('"path"');
    expect(replaceHelp.text).toContain('"instructions"');
  });

  it("revises from the accepted widget generation branch and publishes its new branch identity", async () => {
    const initial: CakeArtifactV1 = {
      protocol: "cake.artifact/v1",
      id: "chart",
      sessionId: "original-parent",
      revision: 1,
      kind: "widget",
      payload: {
        language: "react",
        source: "export default function Chart(){return null}",
        brief: "Verified chart",
        generationSessionId: "accepted-generation",
      },
      fallback: { markdown: "Chart" },
      interaction: { mode: "present" },
    };
    const { registry, callbacks } = makeHarness(initial);
    const revise = vi.fn(async () => ({
      language: "react" as const,
      source: "export default function Revised(){return null}",
      generationSessionId: "revision-branch",
      preview: { mimeType: "image/png" as const, data: "cG5n" },
    }));
    callbacks.reviseInlineWidget = revise;
    const result = await registry.invoke(
      {
        command: "artifacts.replace",
        input: { lineageId: "chart", expectedRevision: 1, instructions: "Use clearer labels" },
      },
      context(),
    );
    expect(result.content[1]).toEqual({ type: "image", mimeType: "image/png", data: "cG5n" });
    expect(result.details).toMatchObject({ result: { exactRef: "cake://artifact/chart@r2" } });
    await expect(
      registry.invoke(
        { command: "artifacts.preview", input: { reference: "chart@r1" } },
        context(),
      ),
    ).rejects.toThrow("No retained rendered preview");
    await expect(
      registry.invoke({ command: "artifacts.preview", input: { reference: "chart" } }, context()),
    ).rejects.toThrow();
    expect(revise).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        generationSessionId: "accepted-generation",
        source: initial.payload.source,
        instructions: "Use clearer labels",
      }),
    );
    expect(callbacks.persistArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        revision: 2,
        payload: expect.objectContaining({ generationSessionId: "revision-branch" }),
      }),
    );
  });

  it("appends one restore pointer while link and unlink append none", async () => {
    const { registry, appendEntry, callbacks } = makeHarness(markdown(2, "two"));
    await registry.invoke(
      { command: "artifacts.link", input: { reference: "cake://artifact/design-plan@r1" } },
      context(),
    );
    await registry.invoke(
      { command: "artifacts.unlink", input: { lineageId: "design-plan" } },
      context(),
    );
    expect(appendEntry).not.toHaveBeenCalled();
    expect(callbacks.linkArtifact).toHaveBeenCalledWith("cake://artifact/design-plan@r1");
    await registry.invoke(
      {
        command: "artifacts.restore",
        input: { lineageId: "design-plan", sourceRevision: 1, expectedRevision: 2 },
      },
      context("tool-restore"),
    );
    expect(appendEntry).toHaveBeenCalledOnce();
    expect(appendEntry).toHaveBeenCalledWith(
      "cake.artifact/v1",
      expect.objectContaining({ revision: 3, exactRef: "cake://artifact/design-plan@r3" }),
    );
  });

  it("adds only metadata-free system guidance when effective links currently exist", async () => {
    let linked = false;
    let beforeAgentStart:
      | ((event: {
          systemPrompt: string;
        }) => void | { systemPrompt: string } | Promise<void | { systemPrompt: string }>)
      | undefined;
    const listArtifactMetadata = vi.fn(async () => [metadata(markdown(1, "secret payload"))]);
    const registry = new CakeOperationRegistry(
      createCakeArtifactOperations(
        {
          appendEntry: vi.fn(),
          on: (_event, handler) => {
            beforeAgentStart = handler;
          },
        },
        {
          persistArtifact: vi.fn(),
          hasLinkedArtifacts: vi.fn(async () => linked),
          listArtifactMetadata,
          linkArtifact: vi.fn(async () => {
            linked = true;
            return metadata(markdown(1, "secret payload"));
          }),
          unlinkArtifact: vi.fn(async () => {
            linked = false;
          }),
        },
      ),
    );
    if (!beforeAgentStart) throw new Error("Expected artifact system-guidance handler");

    await expect(beforeAgentStart({ systemPrompt: "base" })).resolves.toBeUndefined();
    await registry.invoke(
      { command: "artifacts.link", input: { reference: "cake://artifact/design-plan" } },
      context(),
    );
    await expect(beforeAgentStart({ systemPrompt: "base" })).resolves.toEqual({
      systemPrompt:
        "base\n\nThis session has linked artifacts. Use artifacts.list to inspect them when relevant.",
    });
    await registry.invoke(
      { command: "artifacts.unlink", input: { lineageId: "design-plan" } },
      context(),
    );
    await expect(beforeAgentStart({ systemPrompt: "base" })).resolves.toBeUndefined();
    expect(listArtifactMetadata).not.toHaveBeenCalled();
  });
});
