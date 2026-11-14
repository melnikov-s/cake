import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";

const root = resolve(import.meta.dirname, "../../..");

test("the supported Oxlint pipeline enables all five published r-state-tree rules", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "cake-rst-lint-"));
  try {
    const fixture = join(temporary, "fixture.ts");
    await writeFile(
      fixture,
      `
import { Store, child, createStore, observable } from "r-state-tree";
class Worker extends Store {}
export class Example extends Store {
  plain = [];
  wrapped = observable([]);
  @child get worker() { return createStore(Worker); }
  get invalid() { this.plain.push(1); return this.plain; }
  run() { this.plain.push(1); this.wrapped = []; void this.worker; }
}
export const invalidConstruction = new Example();
`,
    );
    const result = spawnSync(
      join(root, "node_modules/.bin/oxlint"),
      ["--config", join(root, "oxlint.config.ts"), "--format", "json", fixture],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(1);
    const diagnostics = JSON.parse(result.stdout).diagnostics;
    const codes = diagnostics.map((diagnostic: { code: string }) => diagnostic.code);
    for (const rule of [
      "no-computed-mutation",
      "no-direct-construction",
      "no-plain-collection-mutation",
      "no-observable-collection-replacement",
      "no-discarded-child-read",
    ])
      expect(
        codes.some((code: string) => code.includes(rule)),
        result.stdout,
      ).toBe(true);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
