import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { createCakeSessionRuntimeCapabilities } from "../../../src/services/pi/runtime/cake-session-runtime-capabilities";
import type * as WorktreePrompt from "../../../src/services/pi/runtime/worktree-system-prompt";
import { detectGitWorktree } from "../../../src/services/pi/runtime/worktree-system-prompt";
import {
  projectInvestigationSystemPrompt,
  researchSystemPrompt,
} from "../../../src/services/pi/subagent-system-prompt";
import common from "../../../src/services/pi/runtime/prompts/common.md?raw";
import mergeLanding from "../../../src/services/pi/runtime/prompts/worktree-landing-merge.md?raw";
import mutationPolicy from "../../../src/services/pi/runtime/prompts/worker-mutations.md?raw";
import investigationOnlyPolicy from "../../../src/services/pi/runtime/prompts/worker-investigation-only.md?raw";

/** The selected worker policy template is included; the other mode's is not. */
const expectWorkerPolicy = (prompt: string, allowMutations: boolean) => {
  const [selected, other] = allowMutations
    ? [mutationPolicy, investigationOnlyPolicy]
    : [investigationOnlyPolicy, mutationPolicy];
  expect(prompt).toContain(selected.trim());
  expect(prompt).not.toContain(other.trim());
};
const commonFirstLine = common.split("\n")[0]!;

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
    expect(append).toContain(mergeLanding.trim());
    expect(append).toContain("## Deliver and revise");
    expect(append).not.toContain("## Execution stewardship");
    expect(append).not.toContain("plugins.present");
    expect(append.split(commonFirstLine)).toHaveLength(2);
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
      expectWorkerPolicy(systemPrompt, allowMutations);
      expect(systemPrompt).not.toContain("## Deliver and revise");
      expect(systemPrompt).not.toMatch(/worktrees\.merge|sessions\.create-child/);
      // Ratchet at the current size: growth requires a deliberate budget edit.
      expect(Buffer.byteLength(systemPrompt)).toBeLessThanOrEqual(allowMutations ? 991 : 789);
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
      expect(prompt).toContain(projectInvestigationSystemPrompt({ allowMutations }));
      expectWorkerPolicy(prompt, allowMutations);
      expect(prompt).not.toContain("## Deliver and revise");
      expect(prompt).not.toContain("<cake_system_prompt>");
      expect(capabilities.resourceLoader.getAgentsFiles().agentsFiles).toEqual(
        expect.arrayContaining([expect.objectContaining({ content: instructions })]),
      );
    },
  );
});
