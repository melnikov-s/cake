import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  constants,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, dirname } from "node:path";
import { createInterface } from "node:readline";
import { Schema } from "effect";
import manifest from "./parakeet-coreml-manifest.json";
import type { DictationAudio } from "../../domain/dictation/dictation-data";

const modelBase = `https://huggingface.co/${manifest.repository}/resolve/${manifest.revision}`;
const modelBytes = manifest.files.reduce((total, file) => total + file.bytes, 0);
export interface InstallProgress {
  message: string;
  downloadedBytes: number;
  totalBytes: number;
}
const WorkerReply = Schema.Union([
  Schema.Struct({ ready: Schema.Literal(true) }),
  Schema.Struct({ text: Schema.String }),
  Schema.Struct({ error: Schema.String }),
]);
const Config = Schema.Struct({ modelPath: Schema.String });

async function exists(path: string) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function helperAvailable(path: string) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "EACCES")
    )
      return false;
    throw error;
  }
}

export async function loadModelPath(root: string): Promise<string | undefined> {
  const path = join(root, "settings.json");
  if (!(await exists(path))) return undefined;
  return Schema.decodeUnknownSync(Config)(JSON.parse(await readFile(path, "utf8"))).modelPath;
}

export async function saveModelPath(root: string, modelPath: string) {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "settings.json.tmp"), JSON.stringify({ modelPath }));
  await rename(join(root, "settings.json.tmp"), join(root, "settings.json"));
}

export async function validateModel(path: string) {
  if (!isAbsolute(path))
    throw new Error("Choose an absolute path to a Core ML Parakeet TDT v2 model folder.");
  const files = ["parakeet_vocab.json"];
  for (const component of ["Preprocessor", "Encoder", "Decoder", "JointDecision"]) {
    for (const file of ["coremldata.bin", "model.mil", "weights/weight.bin"])
      files.push(`${component}.mlmodelc/${file}`);
  }
  for (const file of files) {
    if (!(await stat(join(path, file))).isFile())
      throw new Error(`Missing Core ML model file: ${file}`);
  }
  // Core ML and FluidAudio validate the graph and vocabulary before Listening is shown.
}

async function download(
  file: (typeof manifest.files)[number],
  destination: string,
  signal: AbortSignal,
  progress: (bytes: number) => void,
) {
  const response = await fetch(`${modelBase}/${file.path}`, { signal });
  if (!response.ok || !response.body)
    throw new Error(`Model download failed: HTTP ${response.status}`);
  await mkdir(dirname(destination), { recursive: true });
  const handle = await open(destination, "w");
  const digest = createHash("sha256");
  let bytes = 0;
  try {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      signal.throwIfAborted();
      bytes += value.length;
      if (bytes > file.bytes) {
        await reader.cancel();
        throw new Error(`Unexpected model file size: ${file.path}`);
      }
      digest.update(value);
      let offset = 0;
      while (offset < value.length) offset += (await handle.write(value, offset)).bytesWritten;
      progress(bytes);
    }
    if (bytes !== file.bytes || digest.digest("hex") !== file.sha256)
      throw new Error(`Model checksum did not match: ${file.path}. Please retry.`);
  } finally {
    await handle.close();
  }
}

/** Download data only. The executable and frameworks are supplied by Cake and macOS. */
export async function installParakeet(
  root: string,
  signal: AbortSignal,
  progress: (value: InstallProgress) => void,
) {
  const staging = join(root, "model.download");
  const model = join(root, "model");
  const backup = join(root, "model.previous");
  await mkdir(root, { recursive: true });
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging);
  let downloadedBytes = 0;
  try {
    for (const file of manifest.files) {
      signal.throwIfAborted();
      await download(file, join(staging, file.path), signal, (bytes) =>
        progress({
          message: "Downloading Parakeet Core ML…",
          downloadedBytes: downloadedBytes + bytes,
          totalBytes: modelBytes,
        }),
      );
      downloadedBytes += file.bytes;
    }
    await writeFile(
      join(staging, "ATTRIBUTION.txt"),
      "NVIDIA Parakeet TDT 0.6B v2. Core ML conversion by FluidInference.\nModel: https://huggingface.co/FluidInference/parakeet-tdt-0.6b-v2-coreml\nBase model: https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2\nLicense: Creative Commons Attribution 4.0 International (CC BY 4.0)\nhttps://creativecommons.org/licenses/by/4.0/\nCake does not modify the downloaded model weights.\n",
    );
    await validateModel(staging);
    signal.throwIfAborted();
    // Publish only a complete, verified directory; preserve the existing model if rename fails.
    const hadModel = await exists(model);
    await rm(backup, { recursive: true, force: true });
    if (hadModel) await rename(model, backup);
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

/** Serialized NDJSON over stdio to the bundled native helper. No shell or runtime installation. */
export class ParakeetWorker {
  private readonly process: ChildProcessWithoutNullStreams;
  private pending?: {
    resolve(value: Schema.Schema.Type<typeof WorkerReply>): void;
    reject(error: Error): void;
  };
  private failure?: Error;
  private errors = "";
  readonly ready: Promise<void>;

  constructor(executable: string, modelPath: string) {
    this.process = spawn(executable, [modelPath], { stdio: "pipe" });
    this.ready = this.response(180_000).then((reply) => {
      if (!("ready" in reply)) throw new Error("Invalid native dictation startup response");
    });
    const lines = createInterface({ input: this.process.stdout });
    lines.on("line", (line) => {
      try {
        const decoded = Schema.decodeUnknownResult(WorkerReply)(JSON.parse(line));
        if (decoded._tag === "Failure") throw new Error("Invalid native dictation response");
        const reply = decoded.success;
        const pending = this.pending;
        this.pending = undefined;
        if ("error" in reply) pending?.reject(new Error(reply.error));
        else pending?.resolve(reply);
      } catch {
        this.fail(new Error("Invalid response from the native speech engine"));
        this.process.kill("SIGKILL");
      }
    });
    this.process.stderr.on("data", (data: Buffer) => {
      this.errors = (this.errors + data.toString()).slice(-4000);
    });
    this.process.stdin.on("error", (error) => this.fail(error));
    this.process.once("error", (error) => this.fail(error));
    this.process.once("exit", () => {
      lines.close();
      this.fail(new Error(this.errors || "Native speech engine stopped"));
    });
  }

  private fail(error: Error) {
    this.failure = error;
    this.pending?.reject(error);
    this.pending = undefined;
  }
  private response(timeoutMs: number): Promise<Schema.Schema.Type<typeof WorkerReply>> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(
          new Error(
            "The native speech engine stopped responding. Disable dictation and enable it again to retry.",
          ),
        );
        this.process.kill("SIGKILL");
      }, timeoutMs);
      this.pending = {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
    });
  }
  async transcribe(audio: DictationAudio) {
    if (this.failure) throw this.failure;
    const response = this.response(30_000);
    this.process.stdin.write(`${JSON.stringify(audio)}\n`);
    const reply = await response;
    if (!("text" in reply)) throw new Error("Invalid native transcription response");
    return reply.text;
  }
  close() {
    this.fail(new Error("Dictation stopped"));
    this.process.kill("SIGKILL");
  }
}
