import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { cakeAgentDocumentationDirectory } from "../../../src/services/pi/runtime/cake-agent-documentation";
import workgroups from "../../../docs/agent/workgroups.md?raw";
import delegation from "../../../docs/agent/family-delegation.md?raw";
import coordination from "../../../docs/agent/family-coordination.md?raw";
import lifecycle from "../../../docs/agent/family-lifecycle.md?raw";
import communication from "../../../docs/agent/communication.md?raw";

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
