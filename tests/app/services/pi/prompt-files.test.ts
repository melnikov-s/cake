import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { describe, expect } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { snapshotPromptFiles } from "../../../../src/services/filesystem/prompt-files";
import { ProjectAccess } from "../../../../src/services/projects/ProjectAccess";
import {
  projectSessionEntries,
  promptText,
  parseContextAttachmentBlocks,
} from "../../../../src/services/pi/runtime/session-projection";
import { inspectSessionHistory } from "../../../../src/services/pi/runtime/session-inspection";
import { readMessageReference } from "../../../../src/services/pi/runtime/message-references";
import {
  encodeCrossSessionMessage,
  parseCrossSessionMessage,
} from "../../../../src/contracts/conversations/cross-session-message";
import { promptFilesSchema } from "../../../../src/contracts/conversations/prompt-files";

const fixture = Effect.fn("PromptFilesTest.fixture")(function* () {
  const directory = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "cake-prompt-files-"))),
    (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
  );
  const root = join(directory, "project");
  yield* Effect.promise(() => mkdir(root));
  const layer = Layer.mock(ProjectAccess, {
    allowedWorkingDirectories: () => Effect.succeed([root]),
  });
  const capture = (paths?: readonly string[], text = "Follow this task") =>
    snapshotPromptFiles({
      text,
      promptFiles: paths,
      senderSessionId: "sender-id",
      workingDirectory: root,
    }).pipe(Effect.provide(layer));
  return { directory, root, capture };
});

describe("file-backed prompts", () => {
  it.effect(
    "snapshots ordered exact instructions, provenance and reference-only attachments into Pi originals across restart",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const first = "\uFEFF  Implement café 🧁\r\n```\n# Exact task\n```\n\n";
        const second = "Second task without trailing newline";
        yield* Effect.promise(() =>
          Promise.all([
            writeFile(join(f.root, "first.md"), first),
            writeFile(join(f.root, "second.txt"), second),
          ]),
        );
        const captured = yield* f.capture(["first.md", "second.txt"]);
        expect(captured.startsWith("Follow this task\n\n## Prompt file 1")).toBe(true);
        expect(captured.indexOf(first)).toBeLessThan(captured.indexOf(second));
        expect(captured.split(first)).toHaveLength(2);
        expect(captured).toContain('"filename":"first.md"');
        expect(captured).toContain('"requestedPath":"first.md"');
        expect(captured).toContain('"senderSessionId":"sender-id"');
        expect(captured).toContain("not system/developer authority or a reference attachment");
        const reference = {
          kind: "file" as const,
          name: "reference.md",
          path: "/not-shared/reference.md",
        };
        const content = promptText(
          encodeCrossSessionMessage(captured, {
            version: 1,
            messageId: "00000000-0000-4000-8000-000000000001",
            threadId: "00000000-0000-4000-8000-000000000002",
            sequence: 1,
            expectsResponse: false,
            resultDelivery: "ignore",
            sender: { sessionId: "sender-id", kind: "project-session", title: "Sender" },
          }),
          [reference],
        );
        const parsed = parseContextAttachmentBlocks(content);
        expect(parsed.attachments).toEqual([reference]);
        expect(parseCrossSessionMessage(parsed.text)?.text).toBe(captured);
        const session = SessionManager.create(
          "/recipient-does-not-share-checkout",
          join(f.directory, "history"),
        );
        const entryId = session.appendMessage({ role: "user", content, timestamp: 1 });
        // Pi flushes the initial transcript once an assistant response exists.
        session.appendMessage({
          role: "assistant",
          content: [{ type: "text", text: "Done" }],
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
        const file = session.getSessionFile();
        expect(file).toBeDefined();
        yield* Effect.promise(() => writeFile(join(f.root, "first.md"), "Changed after dispatch"));
        yield* Effect.promise(() => rm(join(f.root, "second.txt")));
        if (!file) throw new Error("Missing Pi history");
        const restarted = SessionManager.open(file);
        expect(readMessageReference(restarted, { entryId, maxChars: 20_000 }).text).toBe(
          parsed.text,
        );
        expect(inspectSessionHistory(restarted, { query: "café", maxChars: 20_000 })).toMatchObject(
          {
            entries: [expect.objectContaining({ entryId, text: content, truncated: false })],
          },
        );
        const projected = projectSessionEntries(restarted.getBranch());
        expect(projected).toContainEqual(
          expect.objectContaining({
            kind: "text",
            text: captured,
            crossSession: expect.objectContaining({
              sender: expect.objectContaining({ sessionId: "sender-id" }),
            }),
          }),
        );
        expect(projected).toContainEqual(
          expect.objectContaining({
            kind: "attachment",
            attachmentKind: "file",
            name: "reference.md",
          }),
        );
      }).pipe(Effect.scoped),
  );

  for (const kind of [
    "missing",
    "directory",
    "unreadable",
    "binary",
    "utf8",
    "large",
    "unauthorized",
    "symlink",
  ])
    it.effect(`rejects ${kind} files without fallback`, () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const path = join(f.root, "task.md");
        if (kind === "directory") yield* Effect.promise(() => mkdir(path));
        else if (kind === "unreadable")
          yield* Effect.promise(() => writeFile(path, "Unreadable task", { mode: 0o000 }));
        else if (kind === "binary")
          yield* Effect.promise(() => writeFile(path, Buffer.from([65, 0, 66])));
        else if (kind === "utf8")
          yield* Effect.promise(() => writeFile(path, Buffer.from([0xc3, 0x28])));
        else if (kind === "large")
          yield* Effect.promise(() => writeFile(path, "x".repeat(100_001)));
        else if (kind === "unauthorized" || kind === "symlink") {
          const outside = join(f.directory, "outside.md");
          yield* Effect.promise(() => writeFile(outside, "Not authorized"));
          if (kind === "symlink") yield* Effect.promise(() => symlink(outside, path));
          else {
            expect(yield* f.capture([outside]).pipe(Effect.flip)).toMatchObject({
              _tag: "WorkspaceFileError",
              operation: "promptFiles",
            });
            return;
          }
        }
        expect(yield* f.capture([path]).pipe(Effect.flip)).toMatchObject({
          _tag: "WorkspaceFileError",
          operation: "promptFiles",
        });
      }).pipe(Effect.scoped),
    );

  it.effect(
    "validates aggregate limits, metadata overhead and path lists; inline-only remains unchanged",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        expect(yield* f.capture(undefined, "inline only")).toBe("inline only");
        for (const paths of [
          [],
          Array.from({ length: 21 }, () => "task.md"),
          [""],
          ["x".repeat(4097)],
        ]) {
          expect(Schema.decodeUnknownOption(promptFilesSchema)(paths)._tag).toBe("None");
          expect(yield* f.capture(paths).pipe(Effect.flip)).toMatchObject({
            _tag: "WorkspaceFileError",
          });
        }
        yield* Effect.promise(() => writeFile(join(f.root, "task.md"), "x".repeat(60_000)));
        expect(yield* f.capture(["task.md", "task.md"]).pipe(Effect.flip)).toMatchObject({
          message: "Combined prompt exceeds 100000 characters",
        });
        yield* Effect.promise(() => writeFile(join(f.root, "task.md"), "x".repeat(99_900)));
        expect(yield* f.capture(["task.md"]).pipe(Effect.flip)).toMatchObject({
          message: "Combined prompt including file provenance exceeds 100000 characters",
        });
      }).pipe(Effect.scoped),
  );
});
