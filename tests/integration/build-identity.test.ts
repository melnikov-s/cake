import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { buildIdentity } from "../../scripts/build-identity.mjs";

it("fingerprints canonical source paths and ordering identically across build hosts", async () => {
  const root = await mkdtemp(join(tmpdir(), "cake-build-identity-"));
  try {
    await mkdir(join(root, "src", "nested"), { recursive: true });
    // Intentionally create in a different order than canonical code-point sorting.
    await writeFile(join(root, "src", "a.ts"), "lowercase");
    await writeFile(join(root, "src", "Z.ts"), "uppercase");
    await writeFile(join(root, "src", "nested", "module.ts"), "nested source");
    await writeFile(join(root, "pnpm-lock.yaml"), "dependencies");
    const expected = createHash("sha256")
      .update("src/Z.ts")
      .update("uppercase")
      .update("src/a.ts")
      .update("lowercase")
      .update("src/nested/module.ts")
      .update("nested source")
      .update("dependencies")
      .digest("hex");
    expect(buildIdentity(root)).toBe(expected);
    await writeFile(join(root, "src", "a.ts"), "changed source");
    expect(buildIdentity(root)).not.toBe(expected);
    const changedSource = buildIdentity(root);
    await writeFile(join(root, "pnpm-lock.yaml"), "changed dependencies");
    expect(buildIdentity(root)).not.toBe(changedSource);

    // The companion is bundled as raw source for both hosts, not an external Electron-only asset.
    const companion = join(root, "src", "assets", "vscode-companion");
    await mkdir(join(companion, "themes"), { recursive: true });
    await writeFile(join(companion, "extension.js"), "module.exports.activate = () => {};\n");
    await writeFile(join(companion, "themes", "cake-dark-color-theme.json"), "{}\n");
    const originalCompanion = buildIdentity(root);
    await writeFile(join(companion, "extension.js"), "module.exports.activate = () => 1;\n");
    expect(buildIdentity(root)).not.toBe(originalCompanion);
    const changedCompanion = buildIdentity(root);
    await writeFile(join(companion, "themes", "cake-dark-color-theme.json"), '{"colors":{}}\n');
    expect(buildIdentity(root)).not.toBe(changedCompanion);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
