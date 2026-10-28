import {
  DefaultResourceLoader,
  formatSkillsForPrompt,
  loadSkillsFromDir,
} from "@earendil-works/pi-coding-agent";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ArtifactRecord,
  CakeArtifactV1,
} from "../../../src/contracts/artifacts/artifact-contract";
import type { ArtifactStagedState } from "../../../src/contracts/artifacts/artifact-state";
import { createCakeArtifactOperations } from "../../../src/domain/artifacts/cake-artifact-operations";
import { createProjectSessionRuntime } from "../../../src/layers/CakeOperations";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";
import { prepareSkillWidgetTemplates } from "../../../src/services/pi/runtime/skill-widget-templates";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cake-skill-templates-"));
  roots.push(root);
  const directory = join(root, ".agents/skills/excalidraw-artifacts");
  await cp(resolve(".agents/skills/excalidraw-artifacts"), directory, { recursive: true });
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: join(root, "agent"),
    noExtensions: true,
    noSkills: true,
    skillsOverride: () =>
      loadSkillsFromDir({ dir: join(root, ".agents/skills"), source: "project" }),
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  await loader.reload({ resolveProjectTrust: async () => true });
  const { skills, diagnostics } = loader.getSkills();
  expect(diagnostics).toEqual([]);
  const compile = vi.fn(async () => ({ digest: "a".repeat(64) }));
  const resolveWidgetTemplate = await prepareSkillWidgetTemplates(skills, compile);
  const records: { artifact: CakeArtifactV1; state?: ArtifactStagedState }[] = [];
  const persistArtifact = vi.fn(
    async (artifact: CakeArtifactV1, state?: ArtifactStagedState): Promise<ArtifactRecord> => {
      records.push({ artifact, state });
      return {
        artifact,
        workspacePath: root,
        digest: "b".repeat(64),
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      };
    },
  );
  const appendEntry = vi.fn();
  const captureWidgetInstance = vi.fn(async () => ({
    mimeType: "image/png" as const,
    data: "cG5n",
  }));
  const registry = new CakeOperationRegistry(
    createCakeArtifactOperations(
      { appendEntry },
      { persistArtifact, resolveWidgetTemplate, captureWidgetInstance },
    ),
  );
  const context = {
    signal: new AbortController().signal,
    toolCallId: "create-diagram",
    runtime: { sessionId: "cold-session", entryId: "assistant-1" },
  };
  return {
    root,
    directory,
    skills,
    compile,
    registry,
    records,
    appendEntry,
    captureWidgetInstance,
    persistArtifact,
    context,
  };
}

describe("skill-supplied widget templates", () => {
  it("advertises a portable drawing skill in a fresh project session and follows its two-call path without prior links", async () => {
    const f = await fixture();
    const prompt = formatSkillsForPrompt(f.skills);
    expect(prompt).toContain("create X diagram in Excalidraw");
    expect(prompt).toContain("exilidraw");
    const skill = f.skills.find((skill) => skill.name === "excalidraw-artifacts")!;
    expect(skill.disableModelInvocation).toBe(false);
    const calls: string[] = [];
    calls.push("read SKILL.md");
    const instructions = await readFile(skill.filePath, "utf8");
    const examples = [...instructions.matchAll(/```json\n([^`]+)```/g)]
      .slice(0, 2)
      .map((match) => JSON.parse(match[1]!));
    expect(examples).toHaveLength(2);
    expect(f.compile).toHaveBeenCalledTimes(1); // startup preparation, outside request path
    f.compile.mockClear();
    calls.push(examples[0].command);
    const first = await f.registry.invoke(examples[0], f.context);
    expect(calls).toEqual(["read SKILL.md", "widgets.instantiate"]);
    expect(f.compile).not.toHaveBeenCalled();
    expect(first.content[1]).toEqual({ type: "image", mimeType: "image/png", data: "cG5n" });
    expect(first.details).toMatchObject({
      result: {
        artifactId: "hello-world-diagram",
        execution: {
          reusedFrom: "skill:excalidraw-artifacts",
          generated: false,
          compiled: false,
          modelReviewed: false,
        },
      },
    });
    expect(f.appendEntry).toHaveBeenCalledWith(
      "cake.artifact/v1",
      expect.objectContaining({
        lineageId: "hello-world-diagram",
        origin: { assistantEntryId: "assistant-1", toolCallId: "create-diagram" },
      }),
    );
    await f.registry.invoke(examples[1], f.context);
    expect(f.compile).not.toHaveBeenCalled();
    expect(f.records).toHaveLength(2);
    const [a, b] = f.records;
    expect(a!.artifact.id).not.toBe(b!.artifact.id);
    expect(a!.artifact.payload).toEqual(b!.artifact.payload);
    expect(a!.state).not.toEqual(b!.state);
    expect(JSON.stringify(a!.artifact.payload)).not.toContain("Hello World");
    expect(a!.state).toMatchObject({
      expectedVersion: 0,
      value: { skeleton: [{ label: { text: "Hello World" } }] },
    });
    expect(b!.state).toMatchObject({
      expectedVersion: 0,
      value: {
        skeleton: expect.arrayContaining([
          expect.objectContaining({ type: "arrow", start: { id: "client" }, end: { id: "api" } }),
        ]),
      },
    });
  });

  it("wires prepared templates into a real fresh Pi session's directly exposed Cake gateway", async () => {
    const f = await fixture();
    vi.stubEnv("PI_CODING_AGENT_DIR", join(f.root, "agent"));
    const runtime = await createProjectSessionRuntime({
      cwd: f.root,
      agentDir: join(f.root, "agent"),
      sessionDir: join(f.root, "sessions"),
      newSession: true,
      trusted: true,
      requestUi: async () => undefined,
      compileArtifactBrowser: f.compile,
      captureWidgetInstance: f.captureWidgetInstance,
      persistArtifact: f.persistArtifact,
      onEvent: () => undefined,
    });
    try {
      expect(runtime.getReviewParentContext?.().activeTools).toContain("cake");
      expect(runtime.getReviewParentContext?.().systemPrompt).toContain(
        "create X diagram in Excalidraw",
      );
      expect(f.compile).toHaveBeenCalledWith(
        "react",
        expect.stringContaining("@excalidraw/excalidraw"),
      );
      f.compile.mockClear();
      const instructions = await readFile(join(f.directory, "SKILL.md"), "utf8");
      const example = JSON.parse(instructions.match(/```json\n([^`]+)```/)![1]!);
      const result = await runtime.callCakeOperation?.(
        example.command,
        example.input,
        new AbortController().signal,
      );
      expect(result).toMatchObject({
        artifactId: "hello-world-diagram",
        execution: { compiled: false, generated: false },
      });
      expect(f.compile).not.toHaveBeenCalled();
      expect(f.records).toHaveLength(1);
      expect(f.records[0]?.artifact.sessionId).toBe(runtime.getReviewParentContext?.().sessionId);
    } finally {
      await runtime.dispose();
    }
  });

  it("works for another library-free skill, without any application-specific template registration", async () => {
    const f = await fixture();
    const directory = join(f.root, "plain-skill");
    await mkdir(directory);
    await writeFile(
      join(directory, "widget.json"),
      JSON.stringify({ language: "html", source: "editor.html" }),
    );
    await writeFile(join(directory, "editor.html"), "<h1>Generic template</h1>");
    const skill = { ...f.skills[0]!, name: "plain", baseDir: directory };
    const compile = vi.fn(async () => ({ digest: "c".repeat(64) }));
    const lookup = await prepareSkillWidgetTemplates([skill], compile);
    expect(lookup("plain")).toMatchObject({
      language: "html",
      source: "<h1>Generic template</h1>",
    });
    expect(compile).toHaveBeenCalledExactlyOnceWith("html", "<h1>Generic template</h1>");
    expect(() => lookup("not-loaded")).toThrow("not loaded");
  });

  it("keeps missing-library setup failures explicit rather than installing or generating a replacement", async () => {
    const f = await fixture();
    const compile = vi.fn(async () => {
      throw new Error("Required widget dependency is not installed");
    });
    const lookup = await prepareSkillWidgetTemplates(f.skills, compile);
    expect(() => lookup("excalidraw-artifacts")).toThrow(
      "Required widget dependency is not installed",
    );
  });

  it("keeps template file access inside the discovered skill", async () => {
    const f = await fixture();
    const outside = join(f.root, "outside.tsx");
    await writeFile(outside, "export default function Outside() { return null; }");
    await symlink(outside, join(f.directory, "outside.tsx"));
    await writeFile(
      join(f.directory, "widget.json"),
      JSON.stringify({ language: "react", source: "outside.tsx" }),
    );
    f.compile.mockClear();
    const lookup = await prepareSkillWidgetTemplates(f.skills, f.compile);
    expect(() => lookup("excalidraw-artifacts")).toThrow("inside its skill directory");
    expect(f.compile).not.toHaveBeenCalled();
  });
});
