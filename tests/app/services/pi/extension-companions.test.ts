import type { ResourceLoader } from "@earendil-works/pi-coding-agent";
import { Schema } from "effect";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resourceDiagnosticSchema } from "../../../../src/ipc/session-contract";

const protocol = vi.hoisted(() => ({
  release: vi.fn(),
  publish: vi.fn(() => ({
    token: "fixture-token",
    url: "cake-extension://module/fixture-token",
    release: () => protocol.release(),
  })),
}));

vi.mock("../../../../src/services/pi/runtime/extension-companion-protocol", () => ({
  publishExtensionCompanionModule: protocol.publish,
}));

import { loadExtensionCompanions } from "../../../../src/services/pi/runtime/extension-companions";

const temporaryRoots: string[] = [];

afterEach(async () => {
  protocol.publish.mockClear();
  protocol.release.mockClear();
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(packageName: string): Promise<ResourceLoader> {
  const baseDir = await mkdtemp(join(tmpdir(), "cake-extension-companion-"));
  temporaryRoots.push(baseDir);
  await mkdir(join(baseDir, "cake"));
  await writeFile(
    join(baseDir, "cake", "fixture.tsx"),
    "export default function Fixture() { return null; }",
  );
  await writeFile(
    join(baseDir, "package.json"),
    JSON.stringify({
      name: packageName,
      cake: {
        companions: [
          {
            id: "fixture",
            extension: "extension.ts",
            entry: "cake/fixture.tsx",
            slot: "composer.above",
          },
        ],
      },
    }),
  );
  return {
    getExtensions: () => ({
      extensions: [
        {
          resolvedPath: join(baseDir, "extension.ts"),
          sourceInfo: { baseDir },
        },
      ],
      errors: [],
      runtime: undefined,
    }),
  } as unknown as ResourceLoader;
}

describe("loadExtensionCompanions", () => {
  it("rejects companion metadata that cannot cross the IPC boundary", async () => {
    const loaded = await loadExtensionCompanions(await fixture(""));

    expect(loaded.companions).toEqual([]);
    expect(loaded.diagnostics).toHaveLength(1);
    expect(() =>
      Schema.decodeUnknownSync(resourceDiagnosticSchema)(loaded.diagnostics[0]),
    ).not.toThrow();
    expect(loaded.diagnostics[0]?.message.length).toBeLessThanOrEqual(4_096);
    expect(protocol.release).toHaveBeenCalledOnce();
  });

  it("releases published modules when its loaded generation is disposed", async () => {
    const loaded = await loadExtensionCompanions(await fixture("Fixture"));

    expect(loaded.companions).toHaveLength(1);
    expect(protocol.release).not.toHaveBeenCalled();

    loaded.dispose();
    loaded.dispose();

    expect(protocol.release).toHaveBeenCalledOnce();
  });
});
