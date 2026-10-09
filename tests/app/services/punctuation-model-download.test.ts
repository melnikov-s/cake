import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installPunctuation,
  punctuationInstalled,
} from "../../../src/services/dictation/local-punctuation";

const fixture = vi.hoisted(() => ({ content: "fixture model data\n", file: "fixture.onnx" }));
vi.mock("../../../src/services/dictation/punctuation-manifest.json", async () => {
  const { createHash } = await import("node:crypto");
  return {
    default: {
      repository: "fixture/punctuation",
      revision: "pinned-revision",
      file: fixture.file,
      bytes: Buffer.byteLength(fixture.content),
      sha256: createHash("sha256").update(fixture.content).digest("hex"),
    },
  };
});
let root: string;
const punctuationRoot = () => join(root, "punctuation");
const weightPath = () => join(punctuationRoot(), "model", fixture.file);
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cake-punctuation-download-"));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});
async function previousModel() {
  await mkdir(join(punctuationRoot(), "model"), { recursive: true });
  await writeFile(weightPath(), "previous model");
}
const install = (controller = new AbortController(), progress = vi.fn()) =>
  installPunctuation(punctuationRoot(), controller.signal, progress);

describe("optional punctuation data installation", () => {
  it("downloads pinned weights explicitly, publishes only verified data and carries attribution/license", async () => {
    await previousModel();
    const fetch = vi.fn(async (url: string) => {
      expect(url).toBe(
        `https://huggingface.co/fixture/punctuation/resolve/pinned-revision/${fixture.file}`,
      );
      expect(await readFile(weightPath(), "utf8")).toBe("previous model");
      return new Response(fixture.content);
    });
    vi.stubGlobal("fetch", fetch);
    const progress = vi.fn();
    await install(new AbortController(), progress);
    expect(fetch).toHaveBeenCalledOnce();
    expect(await punctuationInstalled(punctuationRoot())).toBe(true);
    expect(await readFile(weightPath(), "utf8")).toBe(fixture.content);
    expect(await readFile(join(punctuationRoot(), "model", "ATTRIBUTION.txt"), "utf8")).toContain(
      "Apache-2.0",
    );
    expect(await readFile(join(punctuationRoot(), "model", "LICENSE.txt"), "utf8")).toContain(
      "Apache License",
    );
    expect(progress).toHaveBeenLastCalledWith({
      message: "Downloading local punctuation…",
      downloadedBytes: Buffer.byteLength(fixture.content),
      totalBytes: Buffer.byteLength(fixture.content),
    });
    await expect(stat(join(punctuationRoot(), "model.download"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects same-sized corrupt data without replacing weights, cleans staging and permits retry", async () => {
    await previousModel();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("x".repeat(Buffer.byteLength(fixture.content)))),
    );
    await expect(install()).rejects.toThrow("checksum");
    expect(await readFile(weightPath(), "utf8")).toBe("previous model");
    await expect(stat(join(punctuationRoot(), "model.download"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(fixture.content)),
    );
    await install();
    expect(await punctuationInstalled(punctuationRoot())).toBe(true);
  });

  it.each(["short", fixture.content + "extra"])(
    "rejects an incorrect byte count (%s)",
    async (content) => {
      await previousModel();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(content)),
      );
      await expect(install()).rejects.toThrow(/size|checksum/);
      expect(await readFile(weightPath(), "utf8")).toBe("previous model");
    },
  );

  it("cancels before publication, retains previous weights and clears staged data", async () => {
    await previousModel();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(fixture.content)),
    );
    const controller = new AbortController();
    await expect(
      install(
        controller,
        vi.fn(() => controller.abort()),
      ),
    ).rejects.toThrow();
    expect(await readFile(weightPath(), "utf8")).toBe("previous model");
    await expect(stat(join(punctuationRoot(), "model.download"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
