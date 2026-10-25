import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { verifyVirtuosoPatch } from "../../scripts/verify-virtuoso-patch.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function installation() {
  const root = mkdtempSync(join(tmpdir(), "cake-virtuoso-patch-"));
  roots.push(root);
  mkdirSync(join(root, "patches"));
  mkdirSync(join(root, "node_modules/react-virtuoso/dist"), { recursive: true });
  const contents = "patched virtualizer\n";
  const hash = createHash("sha1")
    .update(`blob ${Buffer.byteLength(contents)}\0`)
    .update(contents)
    .digest("hex");
  const patch = ["mjs", "cjs"]
    .map(
      (extension) =>
        `diff --git a/dist/index.${extension} b/dist/index.${extension}\n` +
        `index ${"0".repeat(40)}..${hash} 100644\n` +
        `--- a/dist/index.${extension}\n+++ b/dist/index.${extension}\n@@ -1 +1 @@\n-old\n+${contents}`,
    )
    .join("");
  writeFileSync(join(root, "patches/react-virtuoso@4.18.11.patch"), patch);
  for (const extension of ["mjs", "cjs"])
    writeFileSync(join(root, `node_modules/react-virtuoso/dist/index.${extension}`), contents);
  return root;
}

it("accepts both installed module builds matching the checked-in patch", () => {
  expect(() => verifyVirtuosoPatch(installation())).not.toThrow();
});

it.each(["mjs", "cjs"])(
  "rejects a stale %s runtime even with an up-to-date source patch",
  (extension) => {
    const root = installation();
    writeFileSync(join(root, `node_modules/react-virtuoso/dist/index.${extension}`), "old runtime");
    expect(() => verifyVirtuosoPatch(root)).toThrow(/pnpm install --frozen-lockfile, then rebuild/);
  },
);

it("explains how to recover from missing installed dependencies", () => {
  const root = installation();
  rmSync(join(root, "node_modules"), { recursive: true });
  expect(() => verifyVirtuosoPatch(root)).toThrow(/remove only the node_modules symlink/);
});

it("checks the actual installed runtime, not just the source lockfile", () => {
  expect(() => verifyVirtuosoPatch()).not.toThrow();
});
