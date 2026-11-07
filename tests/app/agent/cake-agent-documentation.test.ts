import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { cakeAgentDocumentationDirectory } from "../../../src/services/pi/runtime/cake-agent-documentation";
import workgroups from "../../../docs/agent/workgroups.md?raw";
import startup from "../../../docs/agent/family-startup.md?raw";
import delegation from "../../../docs/agent/family-delegation.md?raw";
import coordination from "../../../docs/agent/family-coordination.md?raw";
import lifecycle from "../../../docs/agent/family-lifecycle.md?raw";
import communication from "../../../docs/agent/communication.md?raw";
import interactions from "../../../docs/agent/interactions.md?raw";
import presentation from "../../../docs/agent/presentation.md?raw";
import chatDelegation from "../../../docs/agent/delegation.md?raw";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

it("publishes the family entry guide and every linked task guide from repository sources", async () => {
  const agentDirectory = await mkdtemp(join(tmpdir(), "cake-family-docs-"));
  directories.push(agentDirectory);
  const directory = await cakeAgentDocumentationDirectory(agentDirectory);
  for (const [name, source] of Object.entries({
    workgroups,
    "family-startup": startup,
    "family-delegation": delegation,
    "family-coordination": coordination,
    "family-lifecycle": lifecycle,
    communication,
  })) {
    expect(await readFile(join(directory, `${name}.md`), "utf8"), name).toBe(source);
  }
  for (const name of [
    "family-delegation",
    "family-coordination",
    "family-lifecycle",
    "communication",
  ])
    expect(workgroups).toContain(`\`${name}.md\``);
  expect(await cakeAgentDocumentationDirectory(agentDirectory)).toBe(directory);
});

it("publishes the shipped fresh-task delegation default for installed backends", async () => {
  const agentDirectory = await mkdtemp(join(tmpdir(), "cake-delegation-docs-"));
  directories.push(agentDirectory);
  const directory = await cakeAgentDocumentationDirectory(agentDirectory);
  const published = await readFile(join(directory, "delegation.md"), "utf8");
  expect(published).toBe(chatDelegation);
  expect(published).toContain("Default to a fresh scoped session");
  expect(published).toContain("Reuse only for genuine continuation of the same task");
  expect(published).toContain("authorized worktree/concurrency limits");
});

it("publishes static HTML styling and visual-verification guidance without losing source content", async () => {
  const agentDirectory = await mkdtemp(join(tmpdir(), "cake-static-html-docs-"));
  directories.push(agentDirectory);
  const directory = await cakeAgentDocumentationDirectory(agentDirectory);
  for (const [name, source] of Object.entries({ interactions, presentation })) {
    const published = await readFile(join(directory, `${name}.md`), "utf8");
    expect(published).toBe(source);
    for (const fact of [
      "no host theme tokens, app CSS or fonts",
      "no unresolved required variables",
      "rendered",
      "every alternative",
      "published, visually unverified",
      "Publication alone is not visual verification",
    ])
      expect(published, name).toContain(fact);
  }
});
