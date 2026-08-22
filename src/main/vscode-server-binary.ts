import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, constants, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream } from "node:stream/web";

export const VSCODE_SERVER_VERSION = "1.102.1";

const DOWNLOAD_TIMEOUT = 10 * 60_000;

const RELEASE_BASE =
  process.env.CAKE_VSCODE_RELEASE_BASE ??
  "https://github.com/openvscode-server/org/openvscode-server/releases/download";

/**
 * Binary and archive plumbing for the embedded VS Code editor. Kept free of
 * Electron imports so the resolution rules are unit-testable in isolation.
 */

export async function downloadFile(
  url: string,
  destination: string,
  onProgress: (fraction: number) => void,
): Promise<void> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body)
    throw new Error(`Download failed with HTTP ${response.status}`);
  const total = Number(response.headers.get("content-length") ?? 0);
  const body: unknown = response.body;
  // SAFETY: undici fetch bodies use the same web ReadableStream layout that
  // node:stream/web declares; the cast only reconciles duplicate lib definitions.
  const stream = Readable.fromWeb(body as ReadableStream);
  const file = createWriteStream(destination);
  let received = 0;
  stream.on("data", (chunk: Buffer) => {
    received += chunk.length;
    if (total > 0) onProgress(Math.min(received / total, 1));
  });
  const timeout = setTimeout(
    () => stream.destroy(new Error("Download timed out")),
    DOWNLOAD_TIMEOUT,
  );
  await new Promise<void>((resolvePromise, reject) => {
    stream.pipe(file);
    stream.on("error", reject);
    file.on("error", reject);
    file.on("finish", () => resolvePromise());
  }).finally(() => clearTimeout(timeout));
}

/** Extracts a downloaded release archive and normalizes its top-level directory into `destination`. */
export async function extractArchive(archivePath: string, destination: string, isZip: boolean) {
  const staging = await mkdtemp(join(tmpdir(), "cake-vscode-"));
  try {
    await promisifiedExec("tar", [isZip ? "-xf" : "-xzf", archivePath, "-C", staging], {
      timeout: 5 * 60_000,
    });
    const entries = await readdir(staging);
    if (entries.length !== 1)
      throw new Error(`Unexpected archive layout in ${basename(archivePath)}`);
    await rm(destination, { recursive: true, force: true });
    await rename(join(staging, entries[0]!), destination);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Resolves the server launcher script, preferring explicit overrides over the managed download. */
export async function resolveServerBinary(root: string, customPath?: string): Promise<string> {
  const candidates: string[] = [];
  if (customPath) candidates.push(customPath);
  if (process.env.CAKE_VSCODE_SERVER_PATH) candidates.push(process.env.CAKE_VSCODE_SERVER_PATH);
  const binaryName = process.platform === "win32" ? "openvscode-server.cmd" : "openvscode-server";
  candidates.push(join(root, `openvscode-server-v${VSCODE_SERVER_VERSION}`, "bin", binaryName));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error(
    "The VS Code editor is not installed yet. Download it from within Cake or choose an existing installation.",
  );
}

export function releaseAssetUrl(asset: string): string {
  return `${RELEASE_BASE}/v${VSCODE_SERVER_VERSION}/${asset}`;
}

export function platformAssetName(platform = process.platform, arch = process.arch): string {
  const key = `${platform}-${arch}`;
  switch (key) {
    case "darwin-arm64":
    case "darwin-x64":
    case "linux-x64":
    case "linux-arm64":
      return `openvscode-server-v${VSCODE_SERVER_VERSION}-${key}.tar.gz`;
    case "win32-x64":
      return `openvscode-server-v${VSCODE_SERVER_VERSION}-win32-x64.zip`;
    default:
      throw new Error(`Cake does not support an embedded editor on ${key}`);
  }
}

function promisifiedExec(
  command: string,
  args: string[],
  options: { timeout: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolvePromise({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}
