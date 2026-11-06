import { it } from "@effect/vitest";
import { describe, expect } from "vitest";
import { Effect, Schema } from "effect";
import { SessionFamilyDocument } from "../../../../src/contracts/session-families/session-family-document";
import {
  DOCUMENT_VERSION,
  decodeSessionFamilyDocument,
} from "../../../../src/services/storage/sessionFamilyDocumentCodec";

const child = {
  sessionId: "child",
  parentSessionId: "root",
  requestId: "creation",
  createdAt: "2026-01-01",
  workingDirectory: "/child",
  managedWorktreePath: "/child",
  resultDelivery: "notification",
};
const family = {
  familyId: "family",
  parentSessionId: "root",
  projectPath: "/project",
  workingDirectory: "/root",
  managedWorktreePath: "/root",
  createdAt: "2026-01-01",
  children: [child],
};
const turn = {
  sessionId: "child",
  senderSessionId: "root",
  turnId: "turn",
  requestMessageId: "request",
  threadId: "thread",
  reported: false,
  resultDelivery: "notification",
};
const spawn = {
  sessionId: "child",
  projectPath: "/project",
  workingDirectory: "/child",
  requester: { sessionId: "chat", kind: "cake-chat", title: "Cake Chat" },
  reportDelivered: false,
  handoffSettled: false,
};

const persistedData = (version: number) => ({
  families: [
    {
      ...family,
      children: [
        version <= 2
          ? {
              sessionId: child.sessionId,
              requestId: child.requestId,
              createdAt: child.createdAt,
            }
          : child,
      ],
    },
  ],
  transitions: [],
  turns: [
    version <= 3
      ? {
          sessionId: "child",
          parentSessionId: "root",
          turnId: "turn",
          reported: false,
        }
      : { ...turn, ...(version <= 6 ? { expectsResponse: true } : {}) },
  ],
  ...(version >= 6 ? { spawnedSessions: [spawn] } : {}),
});

describe("session family persisted codec", () => {
  it.effect.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])(
    "migrates v%i membership and obligations to a current roundtrip",
    (version) =>
      Effect.gen(function* () {
        const document = yield* decodeSessionFamilyDocument(
          JSON.stringify({ version, data: persistedData(version) }),
        );
        expect(document.families[0]?.children[0]).toEqual(
          version <= 2
            ? {
                ...child,
                workingDirectory: "/root",
                managedWorktreePath: "/root",
                resultDelivery: "reply",
              }
            : child,
        );
        expect(document.turns).toEqual([
          version <= 3
            ? {
                ...turn,
                requestMessageId: "turn",
                threadId: "turn",
                resultDelivery: "reply",
              }
            : turn,
        ]);
        expect(document.spawnedSessions).toEqual(
          version < 6
            ? []
            : [
                {
                  ...spawn,
                  ...(version < 8 ? { resultDelivery: "reply" } : {}),
                },
              ],
        );
        const encoded = yield* Schema.encodeEffect(SessionFamilyDocument)(document);
        const reopened = yield* decodeSessionFamilyDocument(
          JSON.stringify({ version: DOCUMENT_VERSION, data: encoded }),
        );
        expect(reopened).toEqual(document);
      }),
  );

  it.effect.each([4, 5, 6])(
    "drops non-response turns from v%i journals but keeps explicit obligations",
    (version) =>
      Effect.gen(function* () {
        const data = persistedData(version);
        const document = yield* decodeSessionFamilyDocument(
          JSON.stringify({
            version,
            data: {
              ...data,
              turns: [...data.turns, { ...turn, turnId: "quiet", expectsResponse: false }],
            },
          }),
        );
        expect(document.turns.map((item) => item.turnId)).toEqual(["turn"]);
      }),
  );

  it.effect.each([
    { children: [{ ...child, parentSessionId: "later" }], message: "must precede child" },
    {
      children: [child, { ...child, requestId: "another" }],
      message: "belongs to more than one family",
    },
    {
      children: [child, { ...child, sessionId: "another" }],
      message: "Duplicate child creation request",
    },
  ])("rejects invalid current family membership: $message", ({ children, message }) =>
    Effect.gen(function* () {
      const error = yield* decodeSessionFamilyDocument(
        JSON.stringify({
          version: DOCUMENT_VERSION,
          data: { families: [{ ...family, children }], turns: [], spawnedSessions: [] },
        }),
      ).pipe(Effect.flip);
      expect(error.operation).toBe("load");
      expect(error.message).toContain(message);
    }),
  );

  it.effect("rejects malformed and future documents as typed load failures", () =>
    Effect.gen(function* () {
      for (const text of [
        "not JSON",
        JSON.stringify({ version: DOCUMENT_VERSION + 1, data: {} }),
      ]) {
        const error = yield* decodeSessionFamilyDocument(text).pipe(Effect.flip);
        expect(error._tag).toBe("SessionFamilyStorageError");
        expect(error.operation).toBe("load");
      }
    }),
  );
});
