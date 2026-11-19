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
