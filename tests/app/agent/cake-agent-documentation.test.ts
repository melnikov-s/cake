import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
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
  for (const name of ["family-delegation", "family-coordination", "family-lifecycle"])
    expect(workgroups).toContain(`${name}.md`);
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

it("deploys a closed, reachable task-guide graph including section anchors", async () => {
  const agentDirectory = await mkdtemp(join(tmpdir(), "cake-guide-graph-"));
  directories.push(agentDirectory);
  const directory = await cakeAgentDocumentationDirectory(agentDirectory);
  const names = (await readdir(directory)).filter((name) => name.endsWith(".md"));
  const documents = new Map(
    await Promise.all(
      names.map(async (name) => [name, await readFile(join(directory, name), "utf8")] as const),
    ),
  );
  const reachable = new Set<string>();
  const pending = ["index.md"];
  while (pending.length) {
    const name = pending.pop()!;
    if (reachable.has(name)) continue;
    reachable.add(name);
    const source = documents.get(name);
    expect(source, name).toBeDefined();
    for (const [, target] of source!.matchAll(/\[[^\]]*\]\(([^)]+\.md(?:#[^)]+)?)\)/g)) {
      const [file, anchor] = target!.split("#");
      expect(documents.has(file!), `${name} -> ${target}`).toBe(true);
      if (anchor) {
        const headings = [...documents.get(file!)!.matchAll(/^#{1,6} (.+)$/gm)].map(([, heading]) =>
          heading!
            .toLowerCase()
            .replace(/[^\p{L}\p{N} -]/gu, "")
            .replace(/ /g, "-"),
        );
        expect(headings, `${name} -> ${target}`).toContain(anchor);
      }
      pending.push(file!);
    }
  }
  expect([...reachable].sort()).toEqual(names.sort());
});

it("keeps specialist detail behind discoverable task-specific doors", async () => {
  const agentDirectory = await mkdtemp(join(tmpdir(), "cake-guide-coverage-"));
  directories.push(agentDirectory);
  const directory = await cakeAgentDocumentationDirectory(agentDirectory);
  const coverage = {
    "artifact-designs": [
      "selected state",
      "not visual proof",
      "transitive shared dependencies",
      "deliberate recapture",
    ],
    "widget-authoring": [
      "Await hydration",
      "observed version",
      "window.open",
      "returns null",
      "sentence highlighting",
      "no speech",
      "No artifact/editor search",
    ],
    "widget-theme": [
      "before first paint",
      "System",
      "--card-foreground",
      "prefers-color-scheme",
      "Imperative canvases",
      "without recreating",
      "dark→light→dark",
      "reopened",
      "immutable evidence",
      "explicit source revision",
    ],
    "artifact-runtime": [
      "actual caller",
      "invent no session",
      "absolute cwd",
      "env.PATH",
      "own runtime",
      "catches up once",
      "does not silently resume",
    ],
    "delivery-details": [
      "one launch/message obligation",
      "Workboard completion",
      "interrupted-work review",
      "Opening selects",
      "not-requested",
      "cancel-scheduled",
    ],
    "family-details": [
      "unchanged assignment",
      "Targeted corrections",
      "intake",
      "None proves",
      "canceled batches never restart",
    ],
    "settings-voice": [
      "entire finalized",
      "1.5 seconds",
      "256ms",
      "Voice-submit wins",
      "pre-utterance draft/selection",
      "not backend acceptance",
    ],
    "settings-themes": ["without applying", "when-active", "visible", "supplied data"],
    "history-memory": [
      "power of two",
      "UTF-16",
      "inclusive archive entry IDs",
      "concatenate before parsing",
      "unrecoverable",
    ],
    "session-compaction": [
      "duplicateOf",
      "not aborted or queued",
      "inspectable tree/history",
      "Done is not session resolution",
    ],
    "session-prompt-files": [
      "20 UTF-8",
      "symlink targets",
      "cannot alter admitted content",
      "not model context",
    ],
    "session-discovery-details": [
      "not JSON",
      "invoking chat",
      "not proof of merge readiness",
      "No field proves cache hit/miss",
    ],
    "model-generation": [
      "excluding presetName",
      "billed substitution",
      "stopReason/errorMessage",
      "original generated bytes",
      "Never silently regenerate",
    ],
    "todo-details": [
      "Restore never reopens",
      "Associations replace",
      "genuinely new request",
      "Snooze changes visibility only",
      "exact original result-message ref",
      "snapshot",
      "atomic update-many",
    ],
  };
  for (const [name, facts] of Object.entries(coverage)) {
    const source = await readFile(join(directory, `${name}.md`), "utf8");
    for (const fact of facts) expect(source, `${name}: ${fact}`).toContain(fact);
  }
});

it("publishes static HTML styling and visual-verification guidance without losing source content", async () => {
  const agentDirectory = await mkdtemp(join(tmpdir(), "cake-static-html-docs-"));
  directories.push(agentDirectory);
  const directory = await cakeAgentDocumentationDirectory(agentDirectory);
  for (const [name, source] of Object.entries({ interactions, presentation })) {
    const published = await readFile(join(directory, `${name}.md`), "utf8");
    expect(published).toBe(source);
    expect(published).toContain("html.present");
    expect(published).toMatch(/no scripts\/network\/host styles/i);
    expect(published).toMatch(/pixel|visual/);
  }
});
