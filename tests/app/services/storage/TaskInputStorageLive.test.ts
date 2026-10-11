import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { inputRefsSchema } from "../../../../src/contracts/conversations/task-input";
import { jsonObjectSchema } from "../../../../src/ipc/json-contract";
import { TestClock } from "effect/testing";
import { TaskInputStorage } from "../../../../src/services/storage/TaskInputStorage";
import { makeTaskInputStorageLive } from "../../../../src/services/storage/TaskInputStorageLive";
import {
  inheritTaskInputProtection,
  prepareCoordinatorMessage,
  prepareTaskInputs,
} from "../../../../src/domain/conversations/taskInputs";
import type { SessionChatPromptInput } from "../../../../src/ipc/conversation-data";
import {
  forwardTaskInputControl,
  safeCoordinatorProjection,
} from "../../../../src/domain/cake-chats/taskInputControls";
import { durableInputText } from "../../../../src/services/pi-durable/durable-input-presentation";
import {
  imageContent,
  promptText,
  parseContextAttachmentBlocks,
  projectSessionEntries,
  createLiveMessageProjector,
} from "../../../../src/services/pi/runtime/session-projection";
import type { Attachment } from "../../../../src/ipc/session-contract";
import { encodeCrossSessionMessage } from "../../../../src/contracts/conversations/cross-session-message";

const owner = "00000000-0000-4000-8000-000000000001";
const target = "00000000-0000-4000-8000-000000000002";
const other = "00000000-0000-4000-8000-000000000003";
const forwarded = (reference: string): Attachment => ({
  kind: "forwarded-input",
  name: "Attachment",
  reference,
});
const fixture = <A, E>(work: (root: string) => Effect.Effect<A, E, TaskInputStorage>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "cake-input-test-"))),
    (root) => work(root).pipe(Effect.provide(makeTaskInputStorageLive(root))),
    (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
  );

describe("task-input isolation", () => {
  it.effect("authorizes forwarding from metadata without opening or previewing payloads", () =>
    fixture((root) =>
      Effect.gen(function* () {
        const storage = yield* TaskInputStorage;
        const [ref] = yield* storage.isolate(owner, [
          {
            kind: "image",
            name: "screenshot.png",
            mimeType: "image/png",
            data: Buffer.from("PRIVATE_ORIGINAL_IMAGE").toString("base64"),
          },
        ]);
        if (!ref) throw new Error("Missing reference");
        const metadata = yield* Effect.promise(() =>
          readFile(join(root, "task-inputs", "inputs", `${ref.id}.json`), "utf8"),
        );
        expect(metadata).not.toContain("PRIVATE_ORIGINAL_IMAGE");
        expect(metadata).not.toContain("attachment");
        yield* Effect.promise(() =>
          rm(join(root, "task-inputs", "inputs", ref.id, "payload.json")),
        );
        const grants = yield* storage.authorizeForward(owner, [ref.id], target);
        expect(grants).toHaveLength(1);
        expect(yield* storage.isolate(owner, [ref])).toEqual([ref]);
        const grant = grants[0];
        if (!grant) throw new Error("Missing grant");
        expect((yield* Effect.result(storage.resolve(target, [forwarded(grant)])))._tag).toBe(
          "Failure",
        );
      }),
    ),
  );

  it.effect(
    "isolates original image, Markdown file, text and selected-source payloads before global admission; forwards selected inputs with exact fidelity",
    () =>
      fixture((root) =>
        Effect.gen(function* () {
          const storage = yield* TaskInputStorage;
          const markdown = "# PRIVATE_MARKDOWN\n\nOriginal requirements\n";
          const log = "PRIVATE_LOG\r\n" + "log line  ".repeat(1000) + "\n  ";
          const image = {
            kind: "image" as const,
            name: "screenshot.png",
            mimeType: "image/png",
            data: Buffer.from("PRIVATE_IMAGE_BYTES").toString("base64"),
          };
          const path = join(root, "requirements.md");
          yield* Effect.promise(() => writeFile(path, markdown));
          const raw: Attachment[] = [
            image,
            { kind: "file", name: "requirements.md", path },
            { kind: "text", name: "Pasted text", text: log },
            {
              kind: "source",
              name: "selection",
              location: { path: "src/app.ts", range: { start: { line: 1 }, end: { line: 2 } } },
              selectedText: "PRIVATE_SELECTED_SOURCE",
              comment: "PRIVATE_COMMENT",
            },
          ];
          const refs = yield* prepareTaskInputs(owner, true, raw);
          const globalText = durableInputText("Research the inputs", refs, false);
          expect(imageContent([...refs])).toEqual([]);
          for (const sentinel of [
            markdown,
            "PRIVATE_MARKDOWN",
            "PRIVATE_LOG",
            "PRIVATE_SELECTED_SOURCE",
            "PRIVATE_COMMENT",
            image.data,
            path,
          ])
            expect(globalText).not.toContain(sentinel);
          expect(
            parseContextAttachmentBlocks(promptText("Research", [...refs])).attachments,
          ).toEqual(refs);
          yield* Effect.promise(() => writeFile(path, "Changed after submission"));
          const invocation = yield* forwardTaskInputControl(owner, {
            name: "sessions.create",
            arguments: {
              inputRefs: refs.slice(0, 3).flatMap((ref) => (ref.kind === "input" ? [ref.id] : [])),
            },
          });
          const args = yield* Schema.decodeUnknownEffect(jsonObjectSchema)(invocation.arguments);
          const inputRefs = yield* Schema.decodeUnknownEffect(inputRefsSchema)(args.inputRefs);
          const recipient = yield* prepareTaskInputs(target, false, inputRefs.map(forwarded));
          expect(recipient[0]).toMatchObject(image);
          const recipientImage = recipient[0];
          if (recipientImage?.kind !== "image" || !recipientImage.originalPath)
            throw new Error("Missing original image file");
          const originalPath = recipientImage.originalPath;
          expect((yield* Effect.promise(() => readFile(originalPath))).toString("base64")).toBe(
            image.data,
          );
          expect(promptText("Inspect", [...recipient])).toContain(recipientImage.originalPath);
          for (const [index, expected] of [
            [1, markdown],
            [2, log],
          ] as const) {
            const file = recipient[index];
            if (file?.kind !== "file") throw new Error("Expected readable file");
            expect(yield* Effect.promise(() => readFile(file.path, "utf8"))).toBe(expected);
          }
          expect(imageContent([...recipient])).toEqual([
            { type: "image", data: image.data, mimeType: image.mimeType },
          ]);
          // Resolved forwards use the same live and durable attachment presentation
          // as direct user inputs, including inside a Cake Chat assignment envelope.
          const sender = {
            version: 1 as const,
            messageId: other,
            threadId: owner,
            sequence: 1,
            expectsResponse: true,
            sender: { kind: "cake-chat" as const, sessionId: owner, title: "Cake Chat" },
          };
          const recipientText = promptText("Inspect", [...recipient]);
          const projectInput = (text: string) => {
            const message = {
              role: "user" as const,
              content: [{ type: "text" as const, text }, ...imageContent([...recipient])],
              timestamp: 1,
            };
            return {
              live: createLiveMessageProjector()({ type: "message_start", message }),
              settled: projectSessionEntries([
                {
                  type: "message",
                  id: "assignment",
                  parentId: null,
                  timestamp: new Date(0).toISOString(),
                  message,
                },
              ]),
            };
          };
          const direct = projectInput(recipientText);
          const forwardedInput = projectInput(encodeCrossSessionMessage(recipientText, sender));
          for (const phase of ["live", "settled"] as const) {
            expect(forwardedInput[phase][0]).toMatchObject({
              kind: "text",
              role: "user",
              text: "Inspect",
              crossSession: sender,
            });
            expect(forwardedInput[phase].filter((part) => part.kind === "attachment")).toEqual(
              direct[phase].filter((part) => part.kind === "attachment"),
            );
            expect(forwardedInput[phase]).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  kind: "attachment",
                  attachmentKind: "image",
                  data: image.data,
                }),
                expect.objectContaining({ kind: "attachment", name: "requirements.md" }),
                expect.objectContaining({ kind: "attachment", name: "Pasted text" }),
              ]),
            );
          }
          expect(yield* storage.isRecipient(target)).toBe(true);
          const projection = yield* safeCoordinatorProjection({
            sessions: [
              { sessionId: target, title: "PRIVATE_DERIVED_SUMMARY", firstUserMessage: log },
              { sessionId: other, title: "Unrelated session" },
            ],
          });
          expect(JSON.stringify(projection)).not.toContain("PRIVATE_");
          expect(JSON.stringify(projection)).toContain("Unrelated session");
          expect(
            JSON.stringify(
              yield* safeCoordinatorProjection({
                sessionId: target,
                status: "PRIVATE_DERIVED_STATUS",
                resolved: null,
                text: log,
              }),
            ),
          ).not.toContain("PRIVATE_");
          expect(
            JSON.stringify(
              yield* safeCoordinatorProjection({
                target: { sessionId: target },
                targetTitle: "PRIVATE_DERIVED_TITLE",
                status: "accepted",
              }),
            ),
          ).not.toContain("PRIVATE_");
          const report: SessionChatPromptInput = {
            sessionId: owner,
            text: "PRIVATE_DERIVED_REPORT",
            renderUserMessageAsMarkdown: false,
            attachments: [
              { kind: "text", name: "PRIVATE_DERIVED_LABEL", text: "PRIVATE_DERIVED_ATTACHMENT" },
            ],
            crossSession: {
              version: 1,
              messageId: other,
              threadId: owner,
              sequence: 1,
              expectsResponse: false,
              sender: {
                sessionId: target,
                title: "PRIVATE_DERIVED_TITLE",
                kind: "project-session",
              },
            },
          };
          const safeReport = yield* prepareCoordinatorMessage(report);
          expect(JSON.stringify(safeReport)).not.toContain("PRIVATE_");
          expect(safeReport.attachments).toEqual([]);
          expect(safeReport.text).toContain("Open the Project Session");
          if (!report.crossSession) throw new Error("Expected cross-session report");
          expect(
            yield* prepareCoordinatorMessage({
              ...report,
              crossSession: {
                ...report.crossSession,
                sender: { sessionId: other, title: "Ordinary session", kind: "project-session" },
              },
            }),
          ).toMatchObject({ text: "PRIVATE_DERIVED_REPORT" });
          yield* inheritTaskInputProtection(target, other);
          expect(yield* storage.isRecipient(other)).toBe(true);
          expect(
            JSON.stringify(
              yield* prepareCoordinatorMessage({
                ...report,
                crossSession: {
                  ...report.crossSession,
                  sender: {
                    sessionId: other,
                    title: "PRIVATE_CHILD_TITLE",
                    kind: "project-session",
                  },
                },
              }),
            ),
          ).not.toContain("PRIVATE_");
          expect((yield* Effect.result(storage.resolve(other, refs)))._tag).toBe("Failure");
        }),
      ),
  );

  it.effect(
    "rejects naked IDs, guessed or cross-owner refs, duplicates, wrong recipients and expired unbound grants; allows same-recipient retries",
    () =>
      fixture(() =>
        Effect.gen(function* () {
          const storage = yield* TaskInputStorage;
          const [ref] = yield* storage.isolate(owner, [
            { kind: "text", name: "log", text: "private" },
          ]);
          if (!ref) throw new Error("Missing reference");
          for (const request of [
            storage.resolve(target, [ref]).pipe(Effect.asVoid),
            storage.authorizeForward(other, [ref.id]).pipe(Effect.asVoid),
            storage.authorizeForward(owner, [other]).pipe(Effect.asVoid),
            storage.authorizeForward(owner, [ref.id, ref.id]).pipe(Effect.asVoid),
          ])
            expect((yield* Effect.result(request))._tag).toBe("Failure");
          const [grant] = yield* storage.authorizeForward(owner, [ref.id]);
          if (!grant) throw new Error("Missing grant");
          const first = yield* storage.resolve(target, [forwarded(grant)]);
          expect(yield* storage.resolve(target, [forwarded(grant)])).toEqual(first);
          expect((yield* Effect.result(storage.resolve(other, [forwarded(grant)])))._tag).toBe(
            "Failure",
          );
          const [abandoned] = yield* storage.authorizeForward(owner, [ref.id]);
          if (!abandoned) throw new Error("Missing grant");
          yield* TestClock.adjust("11 minutes");
          expect((yield* Effect.result(storage.resolve(other, [forwarded(abandoned)])))._tag).toBe(
            "Failure",
          );
          expect(yield* storage.resolve(target, [forwarded(grant)])).toEqual(first);
        }),
      ),
  );

  it.effect(
    "retains originals and recipient grants across backend restart without referencing a checkout",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "cake-input-restart-"))),
        (root) =>
          Effect.gen(function* () {
            const grant = yield* Effect.scoped(
              Effect.gen(function* () {
                const storage = yield* TaskInputStorage;
                const [ref] = yield* storage.isolate(owner, [
                  { kind: "text", name: "log", text: "REPLAY_ORIGINAL" },
                ]);
                if (!ref) throw new Error("Missing reference");
                const [value] = yield* storage.authorizeForward(owner, [ref.id], target);
                if (!value) throw new Error("Missing grant");
                yield* storage.resolve(target, [forwarded(value)]);
                return value;
              }).pipe(Effect.provide(makeTaskInputStorageLive(root), { local: true })),
            );
            yield* Effect.scoped(
              Effect.gen(function* () {
                const storage = yield* TaskInputStorage;
                const [file] = yield* storage.resolve(target, [forwarded(grant)]);
                if (file?.kind !== "file") throw new Error("Expected file");
                expect(yield* Effect.promise(() => readFile(file.path, "utf8"))).toBe(
                  "REPLAY_ORIGINAL",
                );
                expect(yield* storage.isRecipient(target)).toBe(true);
              }).pipe(Effect.provide(makeTaskInputStorageLive(root), { local: true })),
            );
          }),
        (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
      ),
  );
});
