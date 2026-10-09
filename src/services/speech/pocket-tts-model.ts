import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import manifest from "./pocket-tts-manifest.json";

export const pocketTtsBytes = manifest.files.reduce((total, file) => total + file.bytes, 0);
export interface PocketTtsInstallProgress {
  readonly downloadedBytes: number;
  readonly totalBytes: number;
}

const attribution =
  "Pocket TTS by Kyutai. Core ML conversion by FluidInference.\n" +
  "Model, tokenizer and Alba voice: https://huggingface.co/FluidInference/pocket-tts-coreml\n" +
  "Alba voice by Alba MacKenna (CC BY 4.0).\n" +
  "Voice source and license: https://huggingface.co/kyutai/tts-voices#alba-mackenna\n" +
  "Base model: https://huggingface.co/kyutai/pocket-tts\n" +
  "Creative Commons Attribution 4.0 International (CC BY 4.0).\n" +
  "https://creativecommons.org/licenses/by/4.0/\n" +
  "Cake does not modify the published model weights.\n";
const identity = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");

/** Installation marker plus exact file sizes; the native engine validates model graphs on load.
 * All bytes are SHA-256 verified before the marker is published. No startup network calls.
 */
export async function pocketTtsInstalled(directory: string): Promise<boolean> {
  try {
    if ((await readFile(join(directory, "installation.sha256"), "utf8")) !== identity) return false;
    for (const file of manifest.files) {
      const info = await stat(join(directory, manifest.modelDirectory, file.path));
      if (!info.isFile() || info.size !== file.bytes) return false;
    }
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function downloadFile(
  file: (typeof manifest.files)[number],
  destination: string,
  signal: AbortSignal,
  progress: (bytes: number) => void,
  fetchFile: typeof fetch,
) {
  const url = `https://huggingface.co/${manifest.repository}/resolve/${manifest.revision}/${manifest.remoteDirectory}/${file.path}`;
  const response = await fetchFile(url, { signal });
  if (!response.ok || !response.body)
    throw new Error(`Pocket TTS download failed: HTTP ${response.status}`);
  await mkdir(dirname(destination), { recursive: true });
  const output = await open(destination, "wx", 0o600);
  const reader = response.body.getReader();
  const digest = createHash("sha256");
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > file.bytes) throw new Error(`Unexpected Pocket TTS file size: ${file.path}`);
      digest.update(next.value);
      let offset = 0;
      while (offset < next.value.length)
        offset += (await output.write(next.value, offset)).bytesWritten;
      progress(bytes);
    }
    if (bytes !== file.bytes || digest.digest("hex") !== file.sha256)
      throw new Error(`Pocket TTS checksum did not match: ${file.path}. Please retry.`);
  } finally {
    await reader.cancel().catch(() => undefined);
    await output.close();
  }
}

/** Explicit download of pinned data only, never executable code. Caller serializes installs/removal.
 * Stage separately; an interrupted/corrupt download cannot replace a working installation.
 */
export async function installPocketTts(
  root: string,
  signal: AbortSignal,
  progress: (value: PocketTtsInstallProgress) => void,
  fetchFile: typeof fetch = fetch,
): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(root, ".download-"));
  const model = join(root, "model");
  const backup = join(root, "model.previous");
  let downloadedBytes = 0;
  try {
    for (const file of manifest.files) {
      await downloadFile(
        file,
        join(staging, manifest.modelDirectory, file.path),
        signal,
        (bytes) => {
          progress({ downloadedBytes: downloadedBytes + bytes, totalBytes: pocketTtsBytes });
        },
        fetchFile,
      );
      downloadedBytes += file.bytes;
    }
    await writeFile(join(staging, "ATTRIBUTION.txt"), attribution);
    await writeFile(join(staging, "installation.sha256"), identity);
    signal.throwIfAborted();
    await rm(backup, { recursive: true, force: true });
    let hadModel = false;
    try {
      await rename(model, backup);
      hadModel = true;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    try {
      await rename(staging, model);
    } catch (error) {
      if (hadModel) await rename(backup, model);
      throw error;
    }
    await rm(backup, { recursive: true, force: true });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function removePocketTts(root: string): Promise<void> {
  // Only Cake's managed data. Do not touch speech settings, keys, or the bundled executable.
  await rm(join(root, "model"), { recursive: true, force: true });
}
