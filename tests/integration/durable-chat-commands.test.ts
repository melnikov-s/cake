import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createDurableChatCommands } from "../../src/services/pi-durable/durable-chat-commands";
import {
  addSessionDigestReminder,
  formatSessionDigestReminder,
} from "../../src/contracts/cake-chats/session-digest-reminder";
import { durableInputText } from "../../src/services/pi-durable/durable-input-presentation";
import { openDurableChatEngine } from "../../src/services/pi-durable/durable-chat-engine";
import { readDurableOriginalPage } from "../../src/services/pi-durable/durable-chat-history";
import { durableModels } from "../fixtures/durable-chat";
import { MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cake-durable-commands-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  const file = async (path: string, content: string) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  };
  const skill = async (path: string, name: string, extra = "") => {
    await file(
      path,
      `---\nname: ${name}\ndescription: Instructions for ${name}\n${extra}---\nBody for ${name}.\n`,
    );
  };
  const skillFile = join(project, ".agents/skills/local-fixture/SKILL.md");
  await skill(skillFile, "local-fixture");
  await skill(join(agentDir, "skills/global-fixture/SKILL.md"), "global-fixture");
  const settings = SettingsManager.create(project, agentDir, { projectTrusted: true });
  const open = (cwd = project) =>
    createDurableChatCommands(
      cwd,
      agentDir,
      cwd === project ? settings : SettingsManager.create(cwd, agentDir, { projectTrusted: true }),
    );
  return { root, project, agentDir, file, skill, skillFile, open };
}

it("discovers Pi project and global skills without loading project executable extensions", async () => {
  const f = await fixture();
  const marker = join(f.root, "extension-executed");
  await f.file(
    join(f.project, ".pi/extensions/forbidden.ts"),
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran'); export default () => {};`,
  );
  const commands = await f.open();
  expect(commands.catalog()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "compact", source: "builtin" }),
      expect.objectContaining({ name: "model", source: "builtin" }),
      expect.objectContaining({
        name: "skill:local-fixture",
        source: "skill",
        sourceInfo: expect.objectContaining({ path: f.skillFile, scope: "project" }),
      }),
      expect.objectContaining({ name: "skill:global-fixture", source: "skill" }),
    ]),
  );
  expect(
    commands
      .catalog()
      .every((item) => item.source === "skill" || item.name === "model" || item.name === "compact"),
  ).toBe(true);
  expect(existsSync(marker)).toBe(false);
  expect(commands.instructions()).toContain(f.skillFile);
  expect(commands.compatibility().resources).toContainEqual(
    expect.objectContaining({ kind: "skill", path: f.skillFile }),
  );
  const other = await f.open(join(f.root, "other-project"));
  expect(other.catalog().some((item) => item.name === "skill:local-fixture")).toBe(false);
  expect(other.catalog().some((item) => item.name === "skill:global-fixture")).toBe(true);
});

it("expands current skill content with arguments and projects it through Durable originals", async () => {
  const f = await fixture();
  const commands = await f.open();
  await f.file(f.skillFile, "---\nname: local-fixture\ndescription: Updated\n---\nUpdated body.");
  const expanded = await commands.expand("/skill:local-fixture explain this project");
  expect(expanded).toBe(
    `<skill name="local-fixture" location="${f.skillFile}">\nReferences are relative to ${dirname(f.skillFile)}.\n\nUpdated body.\n</skill>\n\nexplain this project`,
  );
  expect(await commands.expand("/skill:local-fixture")).toBe(expanded.split("\n\nexplain")[0]);
  const engine = await openDurableChatEngine({
    storage: new MemoryStorage(),
    models: durableModels().models,
    registry: createRegistry(),
    agent: {
      model: { provider: "fixture", modelId: "fixture" },
      tools: [],
      instructions: commands.instructions(),
    },
    memory: { budget: () => 4_000, summarize: async () => "Summary" },
    onChanged: () => {},
    onReport: () => {},
  });
  cleanup.push(() => engine.close());
  const submitted = await engine.root.submit(
    { type: "input", content: durableInputText(expanded, [], false) },
    BACKGROUND_CONTEXT,
  );
  await submitted.wait(BACKGROUND_CONTEXT);
  const page = await readDurableOriginalPage(engine.root);
  expect(page.parts).toContainEqual(
    expect.objectContaining({
      kind: "skill",
      name: "local-fixture",
      content: expect.stringContaining("Updated body."),
    }),
  );
  expect(page.parts).toContainEqual(
    expect.objectContaining({ kind: "text", role: "user", text: "explain this project" }),
  );
});

it("expands skills even when a pending session digest precedes the user's command", async () => {
  const f = await fixture();
  const commands = await f.open();
  const reminder = formatSessionDigestReminder({ lines: [], running: 0, interruptedReport: true });
  const expanded = await commands.expand(
    addSessionDigestReminder("/skill:local-fixture next step", reminder),
  );
  expect(expanded).toBe(
    addSessionDigestReminder(await commands.expand("/skill:local-fixture next step"), reminder),
  );
  expect(await commands.expand("Discuss /skill:local-fixture")).toBe(
    "Discuss /skill:local-fixture",
  );
});

it("reloads skill discovery, honors Pi disabled resources and exposes explicit-only skills", async () => {
  const f = await fixture();
  const commands = await f.open();
  await f.skill(
    join(f.project, ".agents/skills/manual-fixture/SKILL.md"),
    "manual-fixture",
    "disable-model-invocation: true\n",
  );
  await f.file(
    join(f.project, ".pi/settings.json"),
    JSON.stringify({ skills: ["!local-fixture"] }),
  );
  await commands.reload();
  expect(commands.catalog().some((item) => item.name === "skill:manual-fixture")).toBe(true);
  expect(commands.instructions()).not.toContain("manual-fixture");
  expect(await commands.expand("/skill:manual-fixture")).toContain("Body for manual-fixture.");
  expect(commands.catalog().some((item) => item.name === "skill:local-fixture")).toBe(false);
});

it("does not discover project skills until the project is trusted", async () => {
  const f = await fixture();
  const commands = await createDurableChatCommands(
    f.project,
    f.agentDir,
    SettingsManager.create(f.project, f.agentDir, { projectTrusted: false }),
  );
  expect(commands.catalog().some((item) => item.name === "skill:local-fixture")).toBe(false);
  expect(commands.catalog().some((item) => item.name === "skill:global-fixture")).toBe(true);
  await expect(commands.expand("/skill:local-fixture")).rejects.toThrow("Unknown skill");
});

it("rejects unknown or unreadable skills rather than sending an unexpanded command to the model", async () => {
  const f = await fixture();
  const commands = await f.open();
  await expect(commands.expand("/skill:missing")).rejects.toThrow("Unknown skill: missing");
  await rm(f.skillFile);
  await expect(commands.expand("/skill:local-fixture")).rejects.toThrow();
});
