import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { createCakeSessionRuntimeCapabilities } from "../../../src/services/pi/runtime/cake-session-runtime-capabilities";
import { cakeAgentDocumentationDirectory } from "../../../src/services/pi/runtime/cake-agent-documentation";
import { sessionAssistantSystemPrompt } from "../../../src/services/pi/session-assistant";
import type * as WorktreePrompt from "../../../src/services/pi/runtime/worktree-system-prompt";

vi.mock("../../../src/services/pi/runtime/worktree-system-prompt", async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreePrompt>()),
  detectGitWorktree: async () => undefined,
}));

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "cake-role-prompts-"));
  directories.push(directory);
  return directory;
}

describe("role-specific prompt assembly", () => {
  it.each([false, true])(
    "loads investigator project resources without ordinary session authority (mutations=%s)",
    async (allowMutations) => {
      const directory = await temporaryDirectory();
      const instructions = "User project instructions: preserve these exact words.";
      await writeFile(join(directory, "AGENTS.md"), instructions);
      const capabilities = await createCakeSessionRuntimeCapabilities({
        options: {
          cwd: directory,
          agentDir: join(directory, "agent"),
          sessionDir: join(directory, "sessions"),
          auxiliary: true,
          ephemeral: true,
          projectInvestigation: true,
          allowMutations,
          trusted: true,
          requestUi: async () => undefined,
          onEvent: () => undefined,
        },
        agentDir: join(directory, "agent"),
        settingsManager: SettingsManager.inMemory(),
        modelRuntime: { getAvailableOfType: async () => [] },
        publishSnapshot: async () => undefined,
        requestExtensions: [],
      });
      const prompt = capabilities.resourceLoader.getAppendSystemPrompt().join("\n");
      expect(prompt).toContain("hidden, temporary project investigator reporting to Cake Chat");
      expect(prompt).toContain(allowMutations ? "Mutation mode:" : "Investigations only:");
      expect(prompt).toContain("Do not create Project Sessions or delegate recursively");
      expect(prompt).toContain("Cake delivers that final report to the parent automatically");
      expect(prompt).not.toContain("<cake_system_prompt>");
      expect(prompt).not.toContain("Workboard");
      expect(capabilities.resourceLoader.getAgentsFiles().agentsFiles).toEqual(
        expect.arrayContaining([expect.objectContaining({ content: instructions })]),
      );
    },
  );

  it("deploys all deferred Cake Chat guidance to a stable readable directory", async () => {
    const directory = await temporaryDirectory();
    const docs = await cakeAgentDocumentationDirectory(directory);
    expect(await cakeAgentDocumentationDirectory(directory)).toBe(docs);
    const sourceDirectory = new URL("../../../docs/agent/", import.meta.url);
    const names = (await readdir(sourceDirectory)).filter((name) => name.endsWith(".md"));
    expect((await readdir(docs)).sort()).toEqual(names.sort());
    for (const name of names) {
      const content = await readFile(join(docs, name), "utf8");
      expect(content, name).toBe(await readFile(new URL(name, sourceDirectory), "utf8"));
      // Every local read trigger must resolve in the deployed bundle.
      for (const [, reference] of content.matchAll(/`([a-z-]+\.md)`/g)) {
        expect(names, `${name} -> ${reference}`).toContain(reference);
      }
    }
    expect(await readFile(join(docs, "cake-chat.md"), "utf8")).toContain("Read the matching guide");
    expect(await readFile(join(docs, "reports.md"), "utf8")).toContain(
      "## Project Session decisions",
    );
    expect(await readFile(join(docs, "artifacts.md"), "utf8")).toContain(
      "approved exact @rN preview",
    );
    expect(await readFile(join(docs, "presentation.md"), "utf8")).toContain(
      "Always present images",
    );
  });

  it("keeps parent context and identity but discovers session-assistant operation contracts lazily", () => {
    const prompt = sessionAssistantSystemPrompt({
      parentSessionId: "parent-session",
      parentContextPrompt: "Exact parent projection and annotation context.",
      tools: [
        {
          command: "sessions.info",
          topic: "sessions",
          summary: "Inspect the authoritative parent session",
          parameters: {
            type: "object",
            properties: {
              sessionId: { type: "string", description: "SCHEMA_SENTINEL_".repeat(1_000) },
            },
          },
          guidance: ["GUIDANCE_SENTINEL_".repeat(1_000)],
        },
      ],
    });
    expect(prompt).toContain("Exact parent projection and annotation context.");
    expect(prompt).toContain("attached to Cake Project Session parent-session");
    expect(prompt).toContain('"this session" means that parent');
    expect(prompt).toContain("sessions.cake");
    expect(prompt).toContain("<operation>.help");
    expect(prompt).toContain("<operation>.output-schema");
    expect(prompt).toContain("Available Cake topics");
    expect(prompt).toContain("sessions");
    expect(prompt).not.toContain("SCHEMA_SENTINEL");
    expect(prompt).not.toContain("GUIDANCE_SENTINEL");
    expect(prompt.length).toBeLessThan(5_000);
  });
});
