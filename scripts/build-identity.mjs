import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";

/** Same source checkout => same desktop/server identity, including uncommitted source changes. */
export function buildIdentity(root = fileURLToPath(new URL("../", import.meta.url))) {
  const hash = createHash("sha256");
  const visit = (path) => {
    for (const entry of readdirSync(join(root, path), { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      // Hash portable source names, not OS-specific separators or locale-dependent ordering.
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) visit(child);
      else {
        hash.update(child);
        hash.update(readFileSync(join(root, child)));
      }
    }
  };
  visit("src");
  hash.update(readFileSync(join(root, "pnpm-lock.yaml")));
  return hash.digest("hex");
}
