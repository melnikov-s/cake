import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { createCakeSessionRuntimeCapabilities } from "../../../src/services/pi/runtime/cake-session-runtime-capabilities";
import { cakeAgentDocumentationDirectory } from "../../../src/services/pi/runtime/cake-agent-documentation";
import type * as WorktreePrompt from "../../../src/services/pi/runtime/worktree-system-prompt";
import { detectGitWorktree } from "../../../src/services/pi/runtime/worktree-system-prompt";
import { researchSystemPrompt } from "../../../src/services/pi/subagent-system-prompt";

vi.mock("../../../src/services/pi/runtime/worktree-system-prompt", async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreePrompt>()),
  detectGitWorktree: vi.fn(async () => undefined),
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
  it("keeps project instructions, scoped session guidance and authorized landing together", async () => {
    const directory = await temporaryDirectory();
    const agentDir = join(directory, "agent");
    const instructions = "Project policy: keep the repository's required acceptance checks.";
    const sessionInstructions =
      "Personal policy and worktree setup: preserve the shared dependencies.";
    await writeFile(join(directory, "AGENTS.md"), instructions);
    vi.mocked(detectGitWorktree).mockResolvedValueOnce({
      worktreePath: directory,
      mainCheckoutPath: "/project",
      branch: "agent/change",
    });
    const capabilities = await createCakeSessionRuntimeCapabilities({
      options: {
        cwd: directory,
        agentDir,
        sessionDir: join(directory, "sessions"),
        additionalSystemPrompt: sessionInstructions,
        worktreeLanding: "merge",
        requestUi: async () => undefined,
        onEvent: () => undefined,
      },
      agentDir,
      settingsManager: SettingsManager.inMemory(),
      modelRuntime: { getAvailableOfType: async () => [] },
      publishSnapshot: async () => undefined,
      requestExtensions: [],
    });
    const append = capabilities.resourceLoader.getAppendSystemPrompt().join("\n");
    expect(append).toContain(sessionInstructions);
    expect(append).toContain(`Checkout: ${directory}`);
    expect(append).toContain("When authorized to land:");
    expect(append).toContain("worktrees.merge without sessionId");
    expect(append).toContain("no fallback");
    expect(append).toContain("Reports/completion grant no merge/resolve approval");
    expect(append).toContain("task done + scoped checks passed = ready, not repo-wide green");
    expect(append).not.toContain("Cake development");
    expect(append).not.toContain("pnpm typecheck");
    expect(append).not.toContain("plugins.present");
    expect(append).not.toContain("hello-sample");
    expect(append.match(/Pi owns execution\/history/g)).toHaveLength(1);
    expect(capabilities.resourceLoader.getAgentsFiles().agentsFiles).toEqual(
      expect.arrayContaining([expect.objectContaining({ content: instructions })]),
    );
  });

  it.each([false, true])(
    "keeps isolated general research free of project/family authority (mutations=%s)",
    async (allowMutations) => {
      const directory = await temporaryDirectory();
      const agentDir = join(directory, "agent");
      await writeFile(join(directory, "AGENTS.md"), "Unrelated project policy must not leak.");
      const systemPrompt = researchSystemPrompt({ allowMutations });
      const capabilities = await createCakeSessionRuntimeCapabilities({
        options: {
          cwd: directory,
          agentDir,
          sessionDir: join(directory, "sessions"),
          auxiliary: true,
          isolatedSystemPrompt: systemPrompt,
          requestUi: async () => undefined,
          onEvent: () => undefined,
        },
        agentDir,
        settingsManager: SettingsManager.inMemory(),
        modelRuntime: { getAvailableOfType: async () => [] },
        publishSnapshot: async () => undefined,
        requestExtensions: [],
      });
      expect(capabilities.resourceLoader.getSystemPrompt()).toBe(systemPrompt);
      expect(capabilities.resourceLoader.getAppendSystemPrompt()).toEqual([]);
      expect(capabilities.resourceLoader.getAgentsFiles().agentsFiles).toEqual([]);
      expect(systemPrompt).toContain(allowMutations ? "Mutation mode:" : "Investigations only:");
      expect(systemPrompt).not.toMatch(/Workboard|worktrees\.merge|sessions\.create-child/);
      expect(Buffer.byteLength(systemPrompt)).toBeLessThan(1000);
    },
  );

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
      expect(prompt).toContain("Cake delivers the final report automatically");
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
    expect(await readFile(join(docs, "cake-chat.md"), "utf8")).toContain("no prerequisite reads");
    const reports = await readFile(join(docs, "reports.md"), "utf8");
    expect(reports).toContain("sessions.completions");
    expect(reports).toContain("Scope complete + relevant checks passed = ready");
    expect(reports).toContain(
      "known relevant failures and uncommitted/unvalidated task changes block readiness",
    );
    expect(await readFile(join(docs, "artifacts.md"), "utf8")).toContain(
      "exact @rN preview pixels",
    );
    expect(await readFile(join(docs, "presentation.md"), "utf8")).toContain("Images:");
  });
});
