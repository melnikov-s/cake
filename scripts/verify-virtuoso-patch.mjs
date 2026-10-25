import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";

/** Refuse to bundle an installed virtualizer that predates the checked-in fix. */
export function verifyVirtuosoPatch(root = fileURLToPath(new URL("../", import.meta.url))) {
  const patch = readFileSync(join(root, "patches/react-virtuoso@4.18.11.patch"), "utf8");
  for (const file of ["dist/index.mjs", "dist/index.cjs"]) {
    const header = `+++ b/${file}\n`;
    const section = patch.slice(0, patch.indexOf(header)).split("\n");
    const expected = section.at(-3)?.match(/^index [a-f0-9]{40}\.\.([a-f0-9]{40}) /)?.[1];
    if (!patch.includes(header) || !expected)
      throw new Error(`Missing patched file identity for react-virtuoso/${file}`);
    let actual;
    try {
      const bytes = readFileSync(join(root, "node_modules/react-virtuoso", file));
      // The patch's index records Git blob hashes, including the length prefix.
      actual = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (actual !== expected)
      throw new Error(
        `Installed react-virtuoso/${file} does not match Cake's transcript patch. ` +
          "Run pnpm install --frozen-lockfile, then rebuild. " +
          "In a managed worktree, remove only the node_modules symlink before installing; " +
          "do not install through the shared symlink.",
      );
  }
}
