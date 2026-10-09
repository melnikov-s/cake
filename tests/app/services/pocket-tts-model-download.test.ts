import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installPocketTts,
  pocketTtsBytes,
  pocketTtsInstalled,
  removePocketTts,
} from "../../../src/services/speech/pocket-tts-model";

const fixture = vi.hoisted(() => ({
  content: "fixture weights\n",
  paths: [
    "cond_prefill.mlmodelc/weights/weight.bin",
    "flowlm_step.mlmodelc/weights/weight.bin",
    "constants_bin/tokenizer.model",
    "constants_bin/alba.safetensors",
  ],
}));
vi.mock("../../../src/services/speech/pocket-tts-manifest.json", async () => {
  const { createHash } = await import("node:crypto");
  return {
    default: {
      name: "Pocket TTS Core ML",
      license: "CC-BY-4.0",
      voice: "alba",
      repository: "fixture/pocket-tts",
      revision: "pinned-revision",
      remoteDirectory: "v2.1/english",
      modelDirectory: "Models/pocket-tts-coreml/v2.1/english",
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
  root = await mkdtemp(join(tmpdir(), "cake-pocket-download-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const goodFetch: typeof fetch = async () => new Response(fixture.content);

async function existingModel() {
  const model = join(root, "model");
  await mkdir(model);
  await writeFile(join(model, "model.safetensors"), "old weights");
  return model;
}

describe("Pocket TTS model installation", () => {
  it("downloads only pinned data, verifies it, reports progress, and publishes atomically", async () => {
    const model = await existingModel();
    const fetchFile = vi.fn<typeof fetch>(async (url) => {
      expect(String(url)).toContain(
        "https://huggingface.co/fixture/pocket-tts/resolve/pinned-revision/v2.1/english/",
      );
      expect(await readFile(join(model, "model.safetensors"), "utf8")).toBe("old weights");
      return new Response(fixture.content);
    });
    const progress = vi.fn();
    await installPocketTts(root, new AbortController().signal, progress, fetchFile);
    expect(fetchFile).toHaveBeenCalledTimes(4);
    expect(await pocketTtsInstalled(model)).toBe(true);
    expect(await readFile(join(model, "ATTRIBUTION.txt"), "utf8")).toContain("CC BY 4.0");
    expect(progress).toHaveBeenLastCalledWith({
      downloadedBytes: pocketTtsBytes,
      totalBytes: pocketTtsBytes,
    });
    expect(await readdir(root)).toEqual(["model"]);
  });

  it.each([
    { label: "same-size corrupt bytes", response: () => new Response("invalid weights\n") },
    { label: "truncated bytes", response: () => new Response("short") },
    { label: "oversized bytes", response: () => new Response(fixture.content.repeat(2)) },
    { label: "HTTP failure", response: () => new Response("error", { status: 503 }) },
  ])("rejects $label and preserves the working model", async ({ response }) => {
    const model = await existingModel();
    await expect(
      installPocketTts(
        root,
        new AbortController().signal,
        () => {},
        async () => response(),
      ),
    ).rejects.toThrow();
    expect(await readFile(join(model, "model.safetensors"), "utf8")).toBe("old weights");
    expect(await readdir(root)).toEqual(["model"]);
    await installPocketTts(root, new AbortController().signal, () => {}, goodFetch);
    expect(await pocketTtsInstalled(model)).toBe(true);
  });

  it("cancels during a download and removes all staging data without replacing the active model", async () => {
    const model = await existingModel();
    const controller = new AbortController();
    let count = 0;
    const fetchFile: typeof fetch = async () => {
      if (++count === 2) controller.abort();
      return new Response(fixture.content);
    };
    await expect(installPocketTts(root, controller.signal, () => {}, fetchFile)).rejects.toThrow();
    expect(count).toBe(2);
    expect(await readFile(join(model, "model.safetensors"), "utf8")).toBe("old weights");
    expect(await readdir(root)).toEqual(["model"]);
  });

  it("detects missing/truncated installed assets without accessing the network", async () => {
    const model = join(root, "model");
    expect(await pocketTtsInstalled(model)).toBe(false);
    await installPocketTts(root, new AbortController().signal, () => {}, goodFetch);
    expect(await pocketTtsInstalled(model)).toBe(true);
    await writeFile(
      join(model, "Models/pocket-tts-coreml/v2.1/english", fixture.paths[0]!),
      "truncated",
    );
    expect(await pocketTtsInstalled(model)).toBe(false);
    await rm(join(model, "installation.sha256"));
    expect(await pocketTtsInstalled(model)).toBe(false);
  });

  it("removes only managed model data, preserving settings and the bundled engine", async () => {
    await installPocketTts(root, new AbortController().signal, () => {}, goodFetch);
    await writeFile(join(root, "settings.json"), "private settings");
    await writeFile(join(root, "cake-speech"), "bundled engine");
    await removePocketTts(root);
    expect(await pocketTtsInstalled(join(root, "model"))).toBe(false);
    expect(await readFile(join(root, "settings.json"), "utf8")).toBe("private settings");
    expect(await readFile(join(root, "cake-speech"), "utf8")).toBe("bundled engine");
  });
});
