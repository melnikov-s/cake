import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build, createLogger } from "vite";
import { expect, test, vi } from "vitest";

test("production CSS retains native comment highlights without optimizer warnings", async () => {
  const root = resolve(import.meta.dirname, "../..");
  const fixture = await mkdtemp(join(root, ".css-build-test-"));
  const warnings: string[] = [];
  const logger = createLogger("silent");
  logger.warn = (message) => warnings.push(message);
  const consoleWarnings = vi.spyOn(console, "warn").mockImplementation((message) => {
    warnings.push(String(message));
  });
  try {
    await writeFile(
      join(fixture, "index.html"),
      '<html><head></head><body><script type="module" src="./entry.js"></script></body></html>',
    );
    await writeFile(
      join(fixture, "entry.js"),
      `import ${JSON.stringify(join(root, "src/renderer/styles.css"))};`,
    );
    // Use the actual production configuration, not a separate CSS transform.
    const result = await build({
      configFile: join(root, "vite.browser.config.ts"),
      root: fixture,
      customLogger: logger,
      build: { write: false },
    });
    if (Array.isArray(result) || !("output" in result)) throw new Error("Expected one CSS build");
    const css = result.output.find(
      (asset) => asset.type === "asset" && asset.fileName.endsWith(".css"),
    );
    expect(css?.type).toBe("asset");
    if (css?.type !== "asset") throw new Error("Missing stylesheet");
    expect(css.source).toContain("::highlight(cake-message-comment)");
    expect(css.source).toContain("text-decoration:underline");
    expect(css.source).toContain("var(--accent)");
    expect(warnings).toEqual([]);
  } finally {
    consoleWarnings.mockRestore();
    await rm(fixture, { recursive: true, force: true });
  }
});
