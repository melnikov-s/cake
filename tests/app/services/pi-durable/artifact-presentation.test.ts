import { CAKE_CHAT_SESSION_ID } from "../../../../src/contracts/cake-chats/cake-chat-identity";
import { copyJson } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Type } from "@earendil-works/pi-durable-ai";
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  decodeArtifactRevisionNumber,
  ArtifactLineageId,
} from "../../../../src/contracts/artifacts/artifact-lineage";
import { ArtifactProjectionMetadata } from "../../../../src/contracts/artifacts/artifact-projection-data";
import { SessionFamilyStorageError } from "../../../../src/contracts/storage/session-family-storage-errors";
import * as access from "../../../../src/domain/artifacts/agentArtifactAccess";
import * as workflows from "../../../../src/domain/artifacts/artifactWorkflows";
import { configureCakeSessionRuntime } from "../../../../src/layers/CakeOperations";
import { ClientEvents } from "../../../../src/services/clients/ClientEvents";
import { ArtifactProjection } from "../../../../src/services/artifacts/ArtifactProjection";
import { makeArtifactProjectionLive } from "../../../../src/services/artifacts/ArtifactProjectionLive";
import { makeArtifactStorageLive } from "../../../../src/services/storage/ArtifactStorageLive";
import { ArtifactStorage } from "../../../../src/services/storage/ArtifactStorage";
import { SessionFamilyStorage } from "../../../../src/services/storage/SessionFamilyStorage";
import { CakeOperationRegistry } from "../../../../src/services/pi/runtime/cake-operation-registry";
import { projectSessionEntries } from "../../../../src/services/pi/runtime/session-projection";
import { openDurableChatEngine } from "../../../../src/services/pi-durable/durable-chat-engine";
import { readDurableOriginalPage } from "../../../../src/services/pi-durable/durable-chat-history";
import { durableAnswer, durableModels } from "../../../fixtures/durable-chat";

it.each([CAKE_CHAT_SESSION_ID, `project-chat:${"a".repeat(64)}`])(
  "%s presents a non-owned artifact through a real Durable tool loop, preserving exact source and persisted replay",
  async (sessionId) => {
    const root = await mkdtemp(join(tmpdir(), "cake-chat-artifact-"));
    let denied = false;
    const runtime = ManagedRuntime.make(
      Layer.mergeAll(
        makeArtifactStorageLive(join(root, "artifacts")),
        makeArtifactProjectionLive(join(root, "projections")),
        Layer.mock(SessionFamilyStorage, {
          withMemberLock: (_id, effect) => effect,
          familyForMember: () =>
            denied
              ? Effect.fail(
                  new SessionFamilyStorageError({ operation: "read", message: "Access denied" }),
                )
              : Effect.succeed(undefined),
        }),
        Layer.mock(ClientEvents, { broadcast: () => undefined, sendTo: () => true }),
      ).pipe(Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))),
    );
    const id = Schema.decodeUnknownSync(ArtifactLineageId)("prototype");
    const snapshot = (revision: number) => ({
      protocol: "cake.artifact/v1" as const,
      id,
      sessionId: "closed-producing-session",
      revision,
      kind: "widget" as const,
      title: "Interactive prototype",
      payload: {
        language: "react" as const,
        source: `export default function Prototype() { return <h1>Source ${revision}</h1> }`,
        brief: "private generation brief",
        generationSessionId: "private-generation-lineage",
        browser: { digest: "b".repeat(64) },
      },
      fallback: { markdown: "Interactive prototype" },
    });
    const configured = configureCakeSessionRuntime({
      cwd: root,
      trusted: true,
      agentDir: root,
      sessionDir: root,
      requestUi: async () => {
        throw new Error("Unexpected UI request");
      },
      onEvent: () => undefined,
      globalControl: { tools: [], invoke: async () => ({}) },
      resolveArtifact: (reference) => runtime.runPromise(access.resolve(sessionId, reference)),
      resolveArtifactForPresentation: (reference) =>
        runtime.runPromise(access.resolveForPresentation(sessionId, reference)),
    });
    if (!configured.coordinator) throw new Error("Missing coordinator operations");
    const operations = new CakeOperationRegistry(
      configured.coordinator.operations({
        sessionId,
        resolveModel: () => ({
          provider: "fixture",
          modelId: "fixture",
          thinkingLevel: "off",
          fastMode: false,
        }),
        info: async () => ({}),
        usage: async () => ({}),
        contextStatus: async () => ({}),
        compact: async () => ({}),
        setModel: async () => undefined,
      }),
    );
    const context = {
      runtime: { sessionId },
      signal: new AbortController().signal,
      toolCallId: "error-check",
    };
    const registry = createRegistry();
    const tool = defineTool({
      name: "cake",
      description: "Cake controls",
      parameters: Type.Object({
        command: Type.String(),
        input: Type.Object({ reference: Type.String() }),
      }),
      replay: "unsafe",
      executionMode: "sequential",
      async execute(input, api, ctx) {
        const result = await operations.invoke(input, {
          runtime: { sessionId },
          toolCallId: api.callId,
          signal: ctx.abortSignal ?? new AbortController().signal,
        });
        return { output: result.content, details: copyJson(result.details) };
      },
    });
    registry.install(defineExtension({ name: "cake", tools: [tool] }));
    const references = ["cake://artifact/prototype@r1", "prototype", "prototype", "prototype@r1"];
    const models = durableModels((_request, index) => {
      const reference = references[index - 1];
      return reference
        ? durableAnswer("", [
            {
              type: "toolCall",
              name: "cake",
              id: `present-${index}`,
              arguments: { command: "artifacts.present", input: { reference } },
            },
          ])
        : durableAnswer("Here is the existing artifact.");
    }).models;
    const database = join(root, "coordinator.sqlite");
    const open = async () => {
      const storage = await openNodeSqliteStorage(database);
      return openDurableChatEngine({
        storage,
        models,
        registry,
        agent: { model: { provider: "fixture", modelId: "fixture" }, tools: [tool] },
        memory: { budget: () => 20_000, summarize: async () => "summary" },
        settings: { compaction: { enabled: false } },
        onChanged: () => undefined,
        onReport: () => undefined,
      });
    };
    let engine: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await runtime.runPromise(
        workflows.create({
          sessionId: "closed-producing-session",
          lineageId: id,
          snapshot: snapshot(1),
          workingDirectory: root,
        }),
      );
      await runtime.runPromise(
        workflows.publish({
          sessionId: "closed-producing-session",
          lineageId: id,
          snapshot: snapshot(2),
          expectedLatestRevision: 1,
          workingDirectory: root,
        }),
      );
      const storage = await runtime.runPromise(ArtifactStorage);
      await runtime.runPromise(
        storage.replaceState({
          lineageId: id,
          expectedVersion: 0,
          value: { selectedOptionId: "option-3" },
        }),
      );
      const before = await readFile(join(root, "artifacts", "catalog.json"), "utf8");
      expect(
        (await operations.invoke({ command: "artifacts.present.help" }, context)).text,
      ).toContain("fresh inline surface");
      expect((await operations.invoke({ command: "artifacts" }, context)).text).toContain(
        "artifacts.present",
      );
      await expect(
        operations.invoke(
          { command: "artifacts.present", input: { reference: "missing" } },
          context,
        ),
      ).rejects.toThrow();
      await expect(
        operations.invoke(
          { command: "artifacts.present", input: { reference: "prototype@r99" } },
          context,
        ),
      ).rejects.toThrow();
      expect(await readFile(join(root, "artifacts", "catalog.json"), "utf8")).toBe(before);
      denied = true;
      await expect(
        operations.invoke(
          { command: "artifacts.present", input: { reference: "prototype" } },
          context,
        ),
      ).rejects.toThrow("Access denied");
      denied = false;
      engine = await open();
      const input = await engine.root.submit(
        { type: "input", content: "Here is the artifact", requestId: "present-existing" },
        BACKGROUND_CONTEXT,
      );
      await input.wait(BACKGROUND_CONTEXT);
      const parts = (await readDurableOriginalPage(engine.root)).parts;
      const surfaces = parts.filter((part) => part.kind === "tool" && part.artifactId);
      expect(
        surfaces.map(
          (part) =>
            part.kind === "tool" && [
              part.artifactId,
              part.artifactRevision,
              part.artifactReference,
            ],
        ),
      ).toEqual([
        [id, 1, "cake://artifact/prototype@r1"],
        [id, 2, "cake://artifact/prototype@r2"],
        [id, 2, "cake://artifact/prototype@r2"],
        [id, 1, "cake://artifact/prototype@r1"],
      ]);
      // Original-history pagination may separate the result from its assistant call.
      const conversation = engine.root;
      const resultOnlyPage = await readDurableOriginalPage({
        entries: async (...args) => {
          const page = await conversation.entries(...args);
          return { ...page, items: page.items.filter((entry) => entry.kind === "pi.tool-result") };
        },
      });
      expect(resultOnlyPage.parts).toMatchObject(
        surfaces.map((part) => ({
          id: part.id,
          kind: "tool",
          artifactId: part.kind === "tool" ? part.artifactId : undefined,
          artifactRevision: part.kind === "tool" ? part.artifactRevision : undefined,
          artifactReference: part.kind === "tool" ? part.artifactReference : undefined,
        })),
      );
      const after = await readFile(join(root, "artifacts", "catalog.json"), "utf8");
      await operations.invoke(
        { command: "artifacts.present", input: { reference: "prototype" } },
        context,
      );
      expect(await readFile(join(root, "artifacts", "catalog.json"), "utf8")).toBe(after);
      expect(await runtime.runPromise(storage.readState(id))).toMatchObject({
        version: 1,
        value: { selectedOptionId: "option-3" },
      });
      expect(
        await runtime.runPromise(storage.read(id, decodeArtifactRevisionNumber(1))),
      ).toMatchObject({
        snapshot: snapshot(1),
      });
      expect(
        await runtime.runPromise(storage.read(id, decodeArtifactRevisionNumber(2))),
      ).toMatchObject({
        snapshot: snapshot(2),
      });
      expect(
        (await runtime.runPromise(storage.catalog())).links.filter(
          (link) => link.target.type === "session" && link.target.sessionId === sessionId,
        ),
      ).toMatchObject([{ selection: { mode: "pinned", revision: 1 } }]);
      expect(JSON.stringify(surfaces)).not.toMatch(
        /private-generation|private generation|export default/,
      );
      const metadata = Schema.decodeUnknownSync(ArtifactProjectionMetadata)(
        JSON.parse(surfaces[0]!.kind === "tool" ? surfaces[0]!.output! : ""),
      );
      expect(metadata.digest).toHaveLength(64);
      await engine.close();
      engine = await open();
      expect((await readDurableOriginalPage(engine.root)).parts).toEqual(parts);
      expect(await readFile(join(root, "artifacts", "catalog.json"), "utf8")).toBe(after);
    } finally {
      await engine?.close();
      await runtime.runPromise(
        Effect.flatMap(ArtifactProjection, (projection) => projection.cleanupSession(sessionId)),
      );
      await runtime.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("does not render a presentation surface from failed or malformed tool results", () => {
  for (const isError of [true, false]) {
    const parts = projectSessionEntries([
      {
        type: "message",
        id: "tool",
        parentId: null,
        timestamp: new Date(0).toISOString(),
        message: {
          role: "toolResult",
          toolName: "cake",
          toolCallId: "bad",
          content: [{ type: "text", text: "Missing artifact" }],
          details: { command: "artifacts.present", result: { lineageId: "missing" } },
          isError,
          timestamp: 0,
        },
      },
    ]);
    expect(parts[0]).toMatchObject({ kind: "tool", artifactId: undefined });
  }
});
