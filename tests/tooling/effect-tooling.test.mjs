import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

test("workspace tsc accepts yielded Effects and rejects floating Effects", (t) => {
  const root = mkdtempSync(resolve(".workflow-node-test-effect-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "program.ts");
  const project = join(root, "tsconfig.json");
  writeFileSync(
    project,
    JSON.stringify({
      extends: resolve("tsconfig.json"),
      include: ["program.ts"],
    }),
  );
  const check = () => {
    const result = spawnSync(
      resolve("node_modules/.bin/tsc"),
      ["-p", project, "--pretty", "false"],
      {
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return { status: result.status, output: result.stdout + result.stderr };
  };

  writeFileSync(
    source,
    'import { Effect } from "effect";\nexport const program = Effect.gen(function* () { yield* Effect.log("executed"); });\n',
  );
  const valid = check();
  assert.equal(valid.status, 0, valid.output);

  writeFileSync(source, 'import { Effect } from "effect";\nEffect.log("never executed");\n');
  const invalid = check();
  assert.equal(invalid.status, 1, invalid.output);
  assert.match(invalid.output, /floatingEffect|must.*(?:yield|assign)/i);
});
