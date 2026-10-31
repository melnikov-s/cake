import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileInlineWidget } from "../../../../src/services/widgets/inline-widget-service";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(entry: string) {
  const directory = await mkdtemp(join(tmpdir(), "cake-widget-resolution-"));
  directories.push(directory);
  const packageDirectory = join(directory, "packages");
  const dependency = join(packageDirectory, "node_modules", "fixture");
  await mkdir(dependency, { recursive: true });
  await writeFile(
    join(packageDirectory, "package.json"),
    JSON.stringify({ dependencies: { fixture: "1.0.0" } }),
  );
  await writeFile(join(dependency, "package.json"), JSON.stringify({ main: "index.js" }));
  await writeFile(join(dependency, "index.js"), entry);
  const compile = () =>
    compileInlineWidget(
      "react",
      'import { value } from "fixture"; export default function Widget() { return <p>{value}</p>; }',
      "display",
      { packageDirectory },
    );
  return { packageDirectory, dependency, compile };
}

describe("widget package resolution", () => {
  it("loads internal dependency files through the native resolver", async () => {
    const f = await fixture('export { value } from "./nested.js";');
    await writeFile(
      join(f.dependency, "nested.js"),
      'export const value = "internal-package-value";',
    );
    expect((await f.compile()).document).toContain("internal-package-value");
  });

  it.each(["relative", "symlink"] as const)(
    "rejects a %s transitive import outside node_modules",
    async (kind) => {
      const f = await fixture(
        `export { value } from "${kind === "relative" ? "../../outside.js" : "./linked.js"}";`,
      );
      const outside = join(f.packageDirectory, "outside.js");
      await writeFile(outside, 'export const value = "host-file-value";');
      if (kind === "symlink") await symlink(outside, join(f.dependency, "linked.js"));
      await expect(f.compile()).rejects.toThrow(
        "Widget dependencies cannot resolve outside the shared widget package environment",
      );
    },
  );
});
