import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";

const renderer = resolve(import.meta.dirname, "../../../src/renderer");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.(tsx?|css)$/.test(path) ? [path] : [];
  });
}

test("small interface typography shares a root-relative readable floor", () => {
  const css = readFileSync(join(renderer, "styles.css"), "utf8");
  expect(css).toContain("--text-xs: 0.875rem;");
  expect(css).toContain("--text-xs--line-height: calc(1.25 / 0.875);");
  // Never pin the root size: browser/user font scaling must remain authoritative.
  const htmlRule = css.match(/\n {2}html \{([^}]+)\}/)?.[1];
  expect(htmlRule).toBeDefined();
  expect(htmlRule).not.toMatch(/font-size/);
});

test("interface font sizes use relative tokens rather than pixel or undersized overrides", () => {
  const violations = sourceFiles(renderer).flatMap((path) => {
    const source = readFileSync(path, "utf8");
    const sizes = [...source.matchAll(/text-\[([\d.]+)(px|rem|em)\]/g)];
    return sizes.flatMap(([utility, amount, unit]) =>
      unit === "px" || Number(amount) < 0.875 ? [`${path}: ${utility}`] : [],
    );
  });
  expect(violations).toEqual([]);
});
