import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

const eslint = new ESLint();
const piFile = "src/services/pi/import-boundary-fixture.ts";
const storageFile = "src/services/storage/import-boundary-fixture.ts";

// Loading the repository's TS lint configuration is setup, not the import rule under test.
beforeAll(async () => {
  await eslint.calculateConfigForFile(piFile);
  await eslint.calculateConfigForFile(storageFile);
}, 30_000);

async function restrictedImports(code: string, filePath = piFile) {
  const results = await eslint.lintText(code, { filePath });
  return results.flatMap((result) =>
    result.messages.filter((message) => message.ruleId === "no-restricted-imports"),
  );
}

describe("Service dependency direction", () => {
  it.each([
    'import { operation } from "../../domain/example"; export { operation };',
    'import type { Value } from "../../domain/example"; export type { Value };',
    'export { operation } from "../../domain/example";',
    'export type { Value } from "../../domain/example";',
    'import { wire } from "../../layers/example"; export { wire };',
  ])("rejects reverse dependency: %s", async (code) => {
    expect(await restrictedImports(code)).toHaveLength(1);
    expect(await restrictedImports(code, storageFile)).toHaveLength(1);
  });

  it("permits Service and IPC contracts", async () => {
    expect(
      await restrictedImports(
        'import type { Value } from "../../ipc/example"; export type { Value };',
      ),
    ).toHaveLength(0);
    expect(
      await restrictedImports(
        'import { capability } from "../storage/example"; export { capability };',
      ),
    ).toHaveLength(0);
  });

  it("keeps Pi SDK imports restricted to Pi Services", async () => {
    const code =
      'import type { AgentSession } from "@earendil-works/pi-coding-agent"; export type { AgentSession };';
    expect(await restrictedImports(code)).toHaveLength(0);
    expect(await restrictedImports(code, storageFile)).toHaveLength(1);
  });
});
