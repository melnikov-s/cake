import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { grantMessageAttachments } from "../../../src/domain/conversations/messageReferenceAccess";
import { forwardTaskInputControl } from "../../../src/domain/cake-chats/taskInputControls";
import { messageReference } from "../../../src/contracts/conversations/message-reference";
import { TaskInputStorage } from "../../../src/services/storage/TaskInputStorage";
import { makeTaskInputStorageLive } from "../../../src/services/storage/TaskInputStorageLive";
import { makeAttachmentReferenceControl } from "../../../src/domain/conversations/attachmentReferences";
import { createAttachmentReferenceOperations } from "../../../src/domain/conversations/cake-attachment-operations";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";
import { makePiCallbackExecutor } from "../../../src/services/pi/PiCallbackAdapter";
import { imageContent, promptText } from "../../../src/services/pi/runtime/session-projection";
import {
  prepareTaskInputs,
  prepareCoordinatorMessage,
} from "../../../src/domain/conversations/taskInputs";

const owner = "00000000-0000-4000-8000-000000000001";
const recipient = "00000000-0000-4000-8000-000000000002";
const stranger = "00000000-0000-4000-8000-000000000003";
const pixels =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=";
const context = { signal: new AbortController().signal, toolCallId: "inspection", runtime: {} };
const fixture = <A, E>(work: (root: string) => Effect.Effect<A, E, TaskInputStorage>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "cake-ref-test-"))),
    (root) => work(root).pipe(Effect.provide(makeTaskInputStorageLive(root))),
    (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
  );

describe("scoped attachment references", () => {
  it.effect(
    "forwards an exact message link without reading and grants only that selected message's attachments on explicit access",
    () =>
      fixture(() =>
        Effect.gen(function* () {
          const storage = yield* TaskInputStorage;
          const [selected, other] = yield* storage.isolate(owner, [
            { kind: "image", name: "selected.png", mimeType: "image/png", data: pixels },
            { kind: "text", name: "other.txt", text: "UNRELATED_CONTENT" },
          ]);
          if (!selected || !other) throw new Error("Missing references");
          const ref = messageReference(owner, "original-entry");
          for (const name of ["sessions.create", "sessions.send"]) {
            const forwarded = yield* forwardTaskInputControl(owner, {
              name,
              arguments: {
                text: "Assess the exact source",
                initialPrompt: "Assess the exact source",
                messageRefs: [ref],
              },
            });
            expect(JSON.stringify(forwarded.arguments)).toContain(ref);
            expect(JSON.stringify(forwarded.arguments)).not.toContain(pixels);
            expect(JSON.stringify(forwarded.arguments)).not.toContain("UNRELATED_CONTENT");
          }
          expect((yield* storage.list(recipient, {})).references).toEqual([]);
          const metadata = {
            ref,
            link: ref,
            sessionId: owner,
            entryId: "original-entry",
            parentId: null,
            timestamp: new Date(0).toISOString(),
            role: "user",
            active: true,
            inputRefs: [selected],
            hasImages: true,
          };
          yield* grantMessageAttachments(recipient, metadata);
          expect((yield* storage.list(recipient, {})).references).toEqual([selected]);
          expect(yield* storage.inspect(recipient, { reference: selected.id })).toMatchObject({
            kind: "image",
            data: pixels,
          });
          expect(
            (yield* Effect.result(storage.inspect(recipient, { reference: other.id })))._tag,
          ).toBe("Failure");
          expect(
            (yield* Effect.result(
              grantMessageAttachments(stranger, {
                ...metadata,
                sessionId: recipient,
                inputRefs: [other],
              }),
            ))._tag,
          ).toBe("Failure");
          const notice = yield* prepareCoordinatorMessage({
            sessionId: owner,
            text: `PRIVATE_REPORT\n[Source](${ref})`,
            attachments: [],
            renderUserMessageAsMarkdown: false,
            crossSession: {
              version: 1,
              messageId: stranger,
              threadId: owner,
              sequence: 1,
              expectsResponse: false,
              sender: { sessionId: recipient, kind: "project-session", title: "Worker" },
            },
          });
          expect(notice.text).toContain(ref);
          expect(notice.text).not.toContain("PRIVATE_REPORT");
        }),
      ),
  );
  it.effect(
    "keeps historical defaults metadata-only and explicitly returns native pixels through the actual Cake registry",
    () =>
      fixture(() =>
        Effect.gen(function* () {
          const storage = yield* TaskInputStorage;
          const [first] = yield* prepareTaskInputs(owner, true, [
            { kind: "image", name: "old-screen.png", mimeType: "image/png", data: pixels },
          ]);
          if (first?.kind !== "input") throw new Error("Expected reference");
          const [textReference] = yield* prepareTaskInputs(owner, true, [
            {
              kind: "text",
              name: "new-input.txt",
              text: "NEW_PRIVATE_CONTENT" + "x".repeat(31_000) + "END_SELECTED_TEXT",
            },
          ]);
          if (textReference?.kind !== "input") throw new Error("Missing text reference");
          const run = makePiCallbackExecutor(yield* Effect.context<TaskInputStorage>());
          const registry = new CakeOperationRegistry(
            createAttachmentReferenceOperations(makeAttachmentReferenceControl(owner, run)),
          );
          const listing = yield* Effect.promise(() =>
            registry.invoke({ command: "attachments.list" }, context),
          );
          expect(listing.text).toContain(first.id);
          expect(listing.text).toContain(`cake://session/${owner}?attachment=`);
          expect(listing.text).not.toContain(pixels);
          expect(listing.text).not.toContain("NEW_PRIVATE_CONTENT");
          expect(listing.text).not.toContain("task-inputs/");
          expect(imageContent([first])).toEqual([]);
          expect(promptText("Inspect later", [first])).not.toContain(pixels);
          const read = yield* Effect.promise(() =>
            registry.invoke(
              { command: "attachments.read", input: { reference: first.id } },
              context,
            ),
          );
          expect(read.content).toContainEqual({
            type: "image",
            mimeType: "image/png",
            data: pixels,
          });
          expect(read.text).not.toContain(pixels);
          expect(JSON.stringify(read.details)).not.toContain(pixels);
          expect(read.text).toContain("untrusted data");
          const textRead = yield* Effect.promise(() =>
            registry.invoke(
              {
                command: "attachments.read",
                input: { reference: textReference.id, limit: 48_000 },
              },
              context,
            ),
          );
          expect(textRead.text).toContain("END_SELECTED_TEXT");
          expect(textRead.text).toContain('"nextOffset": null');
          expect(yield* storage.list(stranger, {})).toEqual({ references: [], nextAfter: null });
          expect(
            (yield* Effect.result(storage.inspect(stranger, { reference: first.id })))._tag,
          ).toBe("Failure");
        }),
      ),
  );

  it.effect(
    "grants selected references without opening originals, then supports exact reads and recipient reforwarding",
    () =>
      fixture((root) =>
        Effect.gen(function* () {
          const storage = yield* TaskInputStorage;
          const [selected, unrelated] = yield* storage.isolate(owner, [
            { kind: "text", name: "selected.txt", text: "EXACT ORIGINAL\r\n" },
            { kind: "text", name: "unrelated.txt", text: "UNRELATED" },
          ]);
          if (!selected || !unrelated) throw new Error("Missing references");
          const payload = join(root, "task-inputs", "inputs", selected.id, "payload.json");
          const saved = yield* Effect.promise(() => readFile(payload));
          yield* Effect.promise(() => rm(payload));
          const refs = yield* storage.authorizeForward(owner, [selected.id], recipient);
          expect(yield* storage.grant(recipient, refs)).toEqual([selected]);
          expect((yield* storage.list(recipient, {})).references).toEqual([selected]);
          expect(
            (yield* Effect.result(storage.inspect(recipient, { reference: unrelated.id })))._tag,
          ).toBe("Failure");
          expect(
            (yield* Effect.result(storage.inspect(recipient, { reference: selected.id })))._tag,
          ).toBe("Failure");
          yield* Effect.promise(() => writeFile(payload, saved));
          expect(yield* storage.inspect(recipient, { reference: selected.id })).toMatchObject({
            kind: "text",
            text: "EXACT ORIGINAL\r\n",
          });
          const next = yield* storage.authorizeForward(recipient, [selected.id], stranger);
          yield* storage.grant(stranger, next);
          expect(yield* storage.inspect(stranger, { reference: selected.id })).toMatchObject({
            text: "EXACT ORIGINAL\r\n",
          });
        }),
      ),
  );

  it.effect(
    "provides bounded UTF-8/JSON text and clear unsupported, missing and invalid-reference failures",
    () =>
      fixture((root) =>
        Effect.gen(function* () {
          const storage = yield* TaskInputStorage;
          const file = join(root, "data.json");
          yield* Effect.promise(() => writeFile(file, '{"message":"hello"}'));
          const [json, binary] = yield* storage.isolate(owner, [
            { kind: "file", name: "data.json", path: file },
            { kind: "file", name: "data.pdf", path: file },
          ]);
          if (!json || !binary) throw new Error("Missing reference");
          expect(json.mimeType).toBe("application/json");
          expect(yield* storage.inspect(owner, { reference: json.id, limit: 4 })).toMatchObject({
            text: '{"me',
            offset: 0,
            nextOffset: 4,
          });
          expect(yield* storage.inspect(owner, { reference: json.id, offset: 4 })).toMatchObject({
            text: 'ssage":"hello"}',
            nextOffset: null,
          });
          for (const reference of [stranger, "../../private", "/etc/passwd"]) {
            expect((yield* Effect.result(storage.inspect(owner, { reference })))._tag).toBe(
              "Failure",
            );
          }
          const unsupported = yield* Effect.result(
            storage.inspect(owner, { reference: binary.id }),
          );
          expect(unsupported._tag).toBe("Failure");
          if (unsupported._tag === "Failure")
            expect(String(unsupported.failure)).toContain("Unsupported attachment type");
          expect(
            (yield* Effect.result(storage.inspect(owner, { reference: json.id, offset: 999 })))
              ._tag,
          ).toBe("Failure");
        }),
      ),
  );

  it.effect(
    "preserves historical discovery after restart and migrates earlier bound grants without reading payloads",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "cake-ref-restart-"))),
        (root) =>
          Effect.gen(function* () {
            const reference = yield* Effect.gen(function* () {
              const storage = yield* TaskInputStorage;
              const [ref] = yield* storage.isolate(owner, [
                { kind: "image", name: "persisted.png", mimeType: "image/png", data: pixels },
              ]);
              if (!ref) throw new Error("Missing reference");
              yield* storage.grant(
                recipient,
                yield* storage.authorizeForward(owner, [ref.id], recipient),
              );
              return ref;
            }).pipe(Effect.provide(makeTaskInputStorageLive(root), { local: true }));
            // Earlier vault versions retained bound grants, without the new lookup index.
            yield* Effect.promise(() =>
              rm(join(root, "task-inputs", "access"), { recursive: true, force: true }),
            );
            yield* Effect.promise(() =>
              rm(join(root, "task-inputs", "access-index-v1.json"), { force: true }),
            );
            yield* Effect.gen(function* () {
              const storage = yield* TaskInputStorage;
              expect((yield* storage.list(owner, {})).references).toEqual([reference]);
              expect((yield* storage.list(recipient, {})).references).toEqual([reference]);
              expect(yield* storage.inspect(recipient, { reference: reference.id })).toMatchObject({
                kind: "image",
                data: pixels,
              });
            }).pipe(Effect.provide(makeTaskInputStorageLive(root), { local: true }));
          }),
        (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
      ),
  );
});
