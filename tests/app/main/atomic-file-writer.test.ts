import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AtomicFileWriter } from "../../../src/main/atomic-file-writer";

describe("AtomicFileWriter", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("orders concurrent atomic writes without sharing a temporary path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cake-state-writer-"));
    directories.push(directory);
    const target = join(directory, "application.json");
    const writer = new AtomicFileWriter();

    await Promise.all([
      writer.write(target, "first"),
      writer.write(target, "second"),
      writer.write(target, "latest"),
    ]);

    expect(await readFile(target, "utf8")).toBe("latest");
  });
});
