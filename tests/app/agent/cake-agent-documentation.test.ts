import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { cakeAgentDocumentationDirectory } from "../../../src/services/pi/runtime/cake-agent-documentation";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

it("publishes every shipped guide at a stable readable path with resolvable local references", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cake-published-guides-"));
  directories.push(directory);
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
  for (const rule of [
    "Ordinary session messages and passive notices need no acknowledgment-only reply or per-message tool acknowledgment",
    "Only for pending reports actually communicated",
    "exact already-emitted communicatedText",
    "do not emit another notice just to acknowledge",
    "persisted visible text, not semantic adequacy",
    "Dismiss only when the user says so",
    "interruption leaves obligations pending",
    "Listing/reading does not handle reports",
    "visible communication alone does not mark them handled automatically",
  ])
    expect(reports).toContain(rule);
  expect(reports).toContain("Scope complete + relevant checks passed = ready");
  expect(reports).toContain(
    "known relevant failures and uncommitted/unvalidated task changes block readiness",
  );
  expect(await readFile(join(docs, "artifacts.md"), "utf8")).toContain("exact @rN preview pixels");
  expect(await readFile(join(docs, "presentation.md"), "utf8")).toContain("Images:");
});

it("publishes the shipped fresh-task delegation default for installed backends", async () => {
  const agentDirectory = await mkdtemp(join(tmpdir(), "cake-delegation-docs-"));
  directories.push(agentDirectory);
  const directory = await cakeAgentDocumentationDirectory(agentDirectory);
  const published = await readFile(join(directory, "delegation.md"), "utf8");
  expect(published).toContain("Default to a fresh scoped session");
  expect(published).toContain("Reuse only for genuine continuation of the same task");
  expect(published).toContain("authorized worktree/concurrency limits");
  for (const name of ["cake-chat", "delegation", "sessions"]) {
    const guidance = await readFile(join(directory, `${name}.md`), "utf8");
    for (const rule of [
      "sessions.create",
      "fresh independent Project Session",
      "sessions.fork",
      "read-only",
      "explicitly requested different model",
      "private subagent directly with",
      "not helpful",
      "otherwise use the contextual fork for investigation",
      "notification by default",
    ])
      expect(guidance.toLowerCase(), `${name}: ${rule}`).toContain(rule.toLowerCase());
    expect(guidance).toContain("Fresh-context subagents require an explicit request");
    expect(guidance).toContain("only when explicitly authorized");
  }
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
      "sessions.tool-prune",
      "/toolprune",
      "no model call or summary",
      "never substitute model compaction",
      "duplicateOf",
      "not aborted or queued",
      "inspectable tree/history",
      "Done never triggers compaction",
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
      "Restore reopens session-linked Done, except Human Done",
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

it("publishes static HTML styling and visual-verification guidance", async () => {
  const agentDirectory = await mkdtemp(join(tmpdir(), "cake-static-html-docs-"));
  directories.push(agentDirectory);
  const directory = await cakeAgentDocumentationDirectory(agentDirectory);
  for (const name of ["interactions", "presentation"]) {
    const published = await readFile(join(directory, `${name}.md`), "utf8");
    expect(published).toContain("html.present");
    expect(published).toMatch(/no scripts\/network\/host styles/i);
    expect(published).toMatch(/pixel|visual/);
  }
});
