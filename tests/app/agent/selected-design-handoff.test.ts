import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactLineageId } from "../../../src/contracts/artifacts/artifact-lineage";
import type { CakeArtifactV1 } from "../../../src/contracts/artifacts/artifact-contract";
import type { CakeArtifactOperationOptions } from "../../../src/contracts/artifacts/artifact-agent-control";
import {
  SelectedDesignReference,
  SelectedDesignSourceOutput,
} from "../../../src/contracts/widgets/prototype-source";
import { createCakeArtifactOperations } from "../../../src/domain/artifacts/cake-artifact-operations";
import * as access from "../../../src/domain/artifacts/agentArtifactAccess";
import * as workflows from "../../../src/domain/artifacts/artifactWorkflows";
import * as state from "../../../src/domain/artifacts/artifactState";
import { makeArtifactStorageLive } from "../../../src/services/storage/ArtifactStorageLive";
import { makeArtifactProjectionLive } from "../../../src/services/artifacts/ArtifactProjectionLive";
import { ArtifactProjection } from "../../../src/services/artifacts/ArtifactProjection";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { ClientEvents } from "../../../src/services/clients/ClientEvents";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";
import { coordinatorCakeOperations } from "../../../src/layers/CakeOperations";
import { encodePrototype, prototypeFixture } from "../../fixtures/prototype-source";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const id = Schema.decodeUnknownSync(ArtifactLineageId)("prototypes");
const exactRef = `cake://artifact/${id}@r1`;
const saved = (selectedOptionId: string | null) => ({
  schema: "cake.prototype-ui/v1",
  selectedOptionId,
});
const context = {
  signal: new AbortController().signal,
  toolCallId: "handoff",
  runtime: { sessionId: "receiver" },
};

async function fixture(source = encodePrototype(prototypeFixture())) {
  const root = await mkdtemp(join(tmpdir(), "cake-selected-design-"));
  const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      makeArtifactStorageLive(join(root, "artifacts")).pipe(Layer.provide(platform)),
      makeArtifactProjectionLive(join(root, "cache")).pipe(Layer.provide(platform)),
      Layer.mock(SessionFamilyStorage, {
        withMemberLock: (_id, effect) => effect,
        familyForMember: () => Effect.succeed(undefined),
      }),
      Layer.mock(ClientEvents, { broadcast: () => undefined, sendTo: () => true }),
    ),
  );
  cleanups.push(async () => {
    for (const sessionId of ["owner", "receiver", "project-chat:test"])
      await runtime.runPromise(
        Effect.flatMap(ArtifactProjection, (projection) => projection.cleanupSession(sessionId)),
      );
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const snapshot = (revision = 1, value = source): CakeArtifactV1 => ({
    protocol: "cake.artifact/v1",
    id,
    revision,
    sessionId: "owner",
    kind: "widget",
    payload: {
      language: "react",
      source: value,
      brief: "PRIVATE BRIEF",
      generationSessionId: "PRIVATE-HISTORY",
      browser: { digest: "b".repeat(64) },
      preview: { mimeType: "image/png", data: "cGl4ZWxz" },
    },
    fallback: { markdown: "ALL FIVE FALLBACK" },
  });
  await runtime.runPromise(
    workflows.create({
      sessionId: "owner",
      lineageId: id,
      snapshot: snapshot(),
      workingDirectory: "/project",
    }),
  );
  const registry = (
    sessionId: string,
    coordinator = false,
    overrides: Partial<CakeArtifactOperationOptions> = {},
  ) => {
    const options = {
      cwd: root,
      globalControl: { tools: [], invoke: async () => ({}) },
      persistArtifact: async () => {
        throw new Error("Unexpected publication");
      },
      resolveArtifact: (reference: string) =>
        runtime.runPromise(access.resolve(sessionId, reference)),
      linkArtifact: (reference: string) => runtime.runPromise(access.link(sessionId, reference)),
      readArtifactState: (lineageId: string) =>
        runtime.runPromise(
          state.read({
            sessionId,
            lineageId: Schema.decodeUnknownSync(ArtifactLineageId)(lineageId),
          }),
        ),
      ...overrides,
    };
    return new CakeOperationRegistry(
      coordinator
        ? coordinatorCakeOperations(options)({
            sessionId,
            resolveModel: () => ({
              provider: "p",
              modelId: "m",
              thinkingLevel: "off",
              fastMode: false,
            }),
            setModel: async () => undefined,
            info: async () => ({}),
            usage: async () => ({}),
            contextStatus: async () => ({}),
            compact: async () => ({}),
          })
        : createCakeArtifactOperations(
            {
              appendEntry: () => {
                throw new Error("Unexpected pointer");
              },
            },
            options,
          ),
    );
  };
  const choose = (value: string | null, expectedVersion = 0) =>
    runtime.runPromise(
      state.replace({ sessionId: "owner", lineageId: id, expectedVersion, value: saved(value) }),
    );
  const capture = async (version = 1) =>
    Schema.decodeUnknownSync(Schema.Struct({ result: SelectedDesignReference }))(
      (
        await registry("owner").invoke(
          {
            command: "artifacts.selection.capture",
            input: { reference: exactRef, expectedStateVersion: version },
          },
          context,
        )
      ).details,
    ).result;
  const read = async (
    selection: SelectedDesignReference,
    moduleId?: string,
    offset?: number,
    limit?: number,
  ) =>
    registry("receiver").invoke(
      {
        command: "artifacts.source",
        input: {
          selection,
          ...(moduleId === undefined ? {} : { moduleId }),
          ...(offset === undefined ? {} : { offset }),
          ...(limit === undefined ? {} : { limit }),
        },
      },
      context,
    );
  return { runtime, snapshot, registry, choose, capture, read };
}

describe("selected prototype handoff through real artifact permissions/state/revisions/projections", () => {
  it("forwards only a captured reference, then lazily retrieves chosen and transitive shared source across sessions", async () => {
    const f = await fixture();
    await f.choose("option-3");
    const selection = await f.capture();
    expect(selection).toEqual({
      schema: "cake.selected-design/v1",
      exactRef,
      digest: expect.any(String),
      optionId: "option-3",
      state: { version: 1, value: saved("option-3") },
    });
    expect(JSON.stringify(selection).length).toBeLessThan(400);
    await expect(f.read(selection, "option-3")).rejects.toThrow(); // An unlinked URI is no read grant.
    await f
      .registry("receiver")
      .invoke({ command: "artifacts.link", input: { reference: selection.exactRef } }, context);
    const discovery = await f.read(selection);
    const decoded = Schema.decodeUnknownSync(Schema.Struct({ result: SelectedDesignSourceOutput }))(
      discovery.details,
    ).result;
    expect(decoded.modules.map((module) => module.id)).toEqual(["option-3", "palette", "tokens"]);
    expect(decoded.module).toBeUndefined();
    for (const moduleId of ["option-3", "palette", "tokens"]) {
      const result = await f.read(selection, moduleId);
      const body = JSON.stringify(result);
      expect(result.content.every((block) => block.type === "text")).toBe(true);
      expect(body).not.toMatch(
        /PRIVATE|ALL FIVE|option-1|option-2|option-4|option-5|unused|cGl4ZWxz|\.png/,
      );
      expect(
        Schema.decodeUnknownSync(Schema.Struct({ result: SelectedDesignSourceOutput }))(
          result.details,
        ).result.module?.source,
      ).toBeTruthy();
    }
    for (const moduleId of ["chooser", "option-1", "unused", "unknown"])
      await expect(f.read(selection, moduleId)).rejects.toThrow("not authorized");
    const page = await f.read(selection, "option-3", 0, 12);
    expect(
      Schema.decodeUnknownSync(Schema.Struct({ result: SelectedDesignSourceOutput }))(page.details)
        .result.module,
    ).toMatchObject({ source: "import {pale", nextOffset: 12 });
    await expect(f.read(selection, "tokens", 99999)).rejects.toThrow("offset");
  });

  it("makes only the narrow handoff tools available in Project Chat coordinator composition", async () => {
    const f = await fixture();
    await f.choose("option-2");
    const selection = await f.capture();
    const chat = f.registry("project-chat:test", true);
    expect(
      chat
        .definitions()
        .filter((operation) => operation.topic === "artifacts")
        .map((operation) => operation.command)
        .sort(),
    ).toEqual([
      "artifacts.link",
      "artifacts.present",
      "artifacts.selection.capture",
      "artifacts.source",
      "artifacts.state.read",
    ]);
    await chat.invoke({ command: "artifacts.link", input: { reference: exactRef } }, context);
    const result = await chat.invoke(
      { command: "artifacts.source", input: { selection, moduleId: "option-2" } },
      context,
    );
    expect(JSON.stringify(result)).toContain("option-2 design");
    expect(result.content.every((block) => block.type === "text")).toBe(true);
    const captured = await chat.invoke(
      {
        command: "artifacts.selection.capture",
        input: { reference: exactRef, expectedStateVersion: 1 },
      },
      context,
    );
    expect(
      Schema.decodeUnknownSync(Schema.Struct({ result: SelectedDesignReference }))(captured.details)
        .result,
    ).toEqual(selection);
  });

  it("rejects state drift including same-choice resaves, mismatched evidence and source-revision drift", async () => {
    const f = await fixture();
    await f.choose("option-3");
    const selection = await f.capture();
    await f
      .registry("receiver")
      .invoke({ command: "artifacts.link", input: { reference: exactRef } }, context);
    await expect(f.read({ ...selection, digest: "0".repeat(64) })).rejects.toThrow(
      "does not match",
    );
    await expect(f.read({ ...selection, optionId: "option-1" })).rejects.toThrow();
    await expect(
      f.read({
        ...selection,
        optionId: "option-1",
        state: {
          ...selection.state,
          value: { schema: "cake.prototype-ui/v1", selectedOptionId: "option-1" },
        },
      }),
    ).rejects.toThrow("does not match");
    await f.choose("option-3", 1);
    await expect(f.read(selection)).rejects.toThrow("state version");
    const recaptured = await f.capture(2);
    await f.choose("option-4", 2);
    await expect(f.read(recaptured)).rejects.toThrow("state version");
    const beforeRevision = await f.capture(3);
    await f.runtime.runPromise(
      workflows.publish({
        sessionId: "owner",
        lineageId: id,
        snapshot: f.snapshot(2),
        workingDirectory: "/project",
        expectedLatestRevision: 1,
      }),
    );
    await expect(f.read(beforeRevision)).rejects.toThrow("revision is stale");
    await expect(f.capture(3)).rejects.toThrow("revision is stale");
    await expect(
      f.registry("owner").invoke(
        {
          command: "artifacts.selection.capture",
          input: { reference: `cake://artifact/${id}`, expectedStateVersion: 3 },
        },
        context,
      ),
    ).rejects.toThrow();
    await expect(
      f.registry("owner").invoke(
        {
          command: "artifacts.selection.capture",
          input: { reference: `cake://artifact/${id}@r9`, expectedStateVersion: 3 },
        },
        context,
      ),
    ).rejects.toThrow();
  });

  it.each([null, "unknown"])(
    "does not infer a choice from a visible/default option: %s",
    async (choice) => {
      const f = await fixture();
      await expect(f.capture()).rejects.toThrow("state version");
      await f.choose(choice);
      await expect(f.capture()).rejects.toThrow();
    },
  );

  it("rejects a refinement that removes the manifest or changes stable option IDs", async () => {
    const f = await fixture();
    await f.choose("option-3");
    const renamed = prototypeFixture();
    const renamedSource = encodePrototype(renamed).replaceAll("option-1", "new-option");
    for (const source of ["export default function Legacy(){return null}", renamedSource]) {
      const registry = f.registry("owner", false, {
        reviseInlineWidget: async () => ({
          language: "react",
          source,
          generationSessionId: "revised",
          preview: { mimeType: "image/png", data: "cG5n" },
          browser: { digest: "c".repeat(64) },
        }),
      });
      await expect(
        registry.invoke(
          {
            command: "artifacts.replace",
            input: { lineageId: id, expectedRevision: 1, instructions: "Refine chosen layout" },
          },
          { ...context, runtime: { sessionId: "owner", entryId: "assistant" } },
        ),
      ).rejects.toThrow("preserve the manifest");
    }
    expect((await f.capture()).optionId).toBe("option-3");
  });

  it("rejects missing React source explicitly", async () => {
    const f = await fixture("");
    await f.choose("option-3");
    await expect(f.capture()).rejects.toThrow("no available React source");
  });

  it("rejects legacy source and missing dependency manifests without returning the whole widget", async () => {
    const legacy = await fixture("export default function Legacy(){return <p>All five</p>}");
    await legacy.choose("option-3");
    await expect(legacy.capture()).rejects.toThrow("no prototype source manifest");
    const bundle = prototypeFixture();
    bundle.shared = [];
    const broken = await fixture(encodePrototype(bundle));
    await broken.choose("option-3");
    await expect(broken.capture()).rejects.toThrow("Missing prototype dependency");
  });
});
