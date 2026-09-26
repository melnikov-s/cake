import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installParakeet, validateModel } from "../../../src/services/dictation/local-parakeet";

const fixture = vi.hoisted(() => ({
  content: "fixture model data\n",
  paths: [
    "parakeet_vocab.json",
    ...["Preprocessor", "Encoder", "Decoder", "JointDecision"].flatMap((component) =>
      ["coremldata.bin", "model.mil", "weights/weight.bin"].map(
        (file) => `${component}.mlmodelc/${file}`,
      ),
    ),
  ],
}));
vi.mock("../../../src/services/dictation/parakeet-coreml-manifest.json", async () => {
  const { createHash } = await import("node:crypto");
  return {
    default: {
      repository: "fixture/parakeet",
      revision: "pinned-revision",
      files: fixture.paths.map((path) => ({
        path,
        bytes: Buffer.byteLength(fixture.content),
        sha256: createHash("sha256").update(fixture.content).digest("hex"),
      })),
    },
  };
});
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cake-model-download-"));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

async function existingModel() {
  const path = join(root, "model");
  for (const file of fixture.paths) {
    await mkdir(dirname(join(path, file)), { recursive: true });
    await writeFile(join(path, file), "previous model");
  }
  return path;
}

describe("native model installation", () => {
  it("downloads only pinned model data, verifies every file, and publishes the complete directory", async () => {
    const model = await existingModel();
    const fetch = vi.fn(async (url: string) => {
      expect(url).toContain("https://huggingface.co/fixture/parakeet/resolve/pinned-revision/");
      // No incomplete bundle becomes the active managed model while downloads are in flight.
      expect(await readFile(join(model, "parakeet_vocab.json"), "utf8")).toBe("previous model");
      return new Response(fixture.content);
    });
    vi.stubGlobal("fetch", fetch);
    const progress = vi.fn();
    await installParakeet(root, new AbortController().signal, progress);
    await validateModel(model);
    expect(fetch).toHaveBeenCalledTimes(fixture.paths.length);
    expect(await readFile(join(model, "parakeet_vocab.json"), "utf8")).toBe(fixture.content);
    expect(await readFile(join(model, "ATTRIBUTION.txt"), "utf8")).toContain("CC BY 4.0");
    const bytes = fixture.paths.length * Buffer.byteLength(fixture.content);
    expect(progress).toHaveBeenLastCalledWith({
      message: "Downloading Parakeet Core ML…",
      downloadedBytes: bytes,
      totalBytes: bytes,
    });
    await expect(stat(join(root, "model.download"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a same-sized checksum mismatch without replacing existing weights, then retries", async () => {
    const model = await existingModel();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("invalid model data\n")),
    );
    await expect(installParakeet(root, new AbortController().signal, () => {})).rejects.toThrow(
      "checksum",
    );
    expect(await readFile(join(model, "parakeet_vocab.json"), "utf8")).toBe("previous model");
    await expect(stat(join(root, "model.download"))).rejects.toMatchObject({ code: "ENOENT" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(fixture.content)),
    );
    await installParakeet(root, new AbortController().signal, () => {});
    expect(await readFile(join(model, "parakeet_vocab.json"), "utf8")).toBe(fixture.content);
  });

  it("cancels between files, discards partial data, and preserves the selected managed model", async () => {
    const model = await existingModel();
    const controller = new AbortController();
    let requests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (++requests === 2) {
          expect(await readFile(join(root, "model.download", fixture.paths[0]!), "utf8")).toBe(
            fixture.content,
          );
          controller.abort();
        }
        return new Response(fixture.content);
      }),
    );
    await expect(installParakeet(root, controller.signal, () => {})).rejects.toThrow();
    expect(requests).toBe(2);
    expect(await readFile(join(model, "parakeet_vocab.json"), "utf8")).toBe("previous model");
    await expect(stat(join(root, "model.download"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("validates all four local Core ML components before persisting a custom selection", async () => {
    const model = await existingModel();
    await validateModel(model);
    await rm(join(model, "JointDecision.mlmodelc", "weights", "weight.bin"));
    await expect(validateModel(model)).rejects.toThrow();
    await expect(validateModel("relative/model")).rejects.toThrow("absolute path");
  });
});
