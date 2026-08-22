import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, constants, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream } from "node:stream/web";

export const VSCODE_SERVER_VERSION = "1.102.1";

const DOWNLOAD_TIMEOUT = 10 * 60_000;

/**
 * openvscode-server publishes Linux binaries only (verified against the
 * gitpod-io release assets); macOS servers must come from a local install,
 * typically `brew install code-server`.
 */
const RELEASE_BASE =
  process.env.CAKE_VSCODE_RELEASE_BASE ??
  "https://github.com/gitpod-io/openvscode-server/releases/download";

/** Which server distribution a resolved binary belongs to; their CLIs differ slightly. */
export type ServerFlavor = "openvscode" | "codeserver";

/**
 * Binary and archive plumbing for the embedded VS Code editor. Kept free of
 * Electron imports so the resolution rules are unit-testable in isolation.
 */

/** Classifies a resolved binary so the spawner can apply the right CLI flags and URL scheme. */
export function serverFlavor(binaryPath: string): ServerFlavor {
  return basename(binaryPath).startsWith("code-server") ? "codeserver" : "openvscode";
}

/** Confirms a download URL is live before handing it to the downloader. */
export async function verifyDownloadUrl(url: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, { method: "HEAD", redirect: "follow" });
  } catch (error) {
    throw new Error(
      `Could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!response.ok)
    throw new Error(
      `${url} is not available (HTTP ${response.status}). ` +
        "The pinned editor version may not publish assets for this platform.",
    );
}

export async function downloadFile(
  url: string,
  destination: string,
  onProgress: (fraction: number) => void,
): Promise<void> {
  await verifyDownloadUrl(url);
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

/**
 * Resolves the server launcher script. Order: explicit user setting, env
 * override, Cake's managed openvscode-server download (Linux), then
 * well-known locally installed servers such as Homebrew's code-server.
 */
export async function resolveServerBinary(root: string, customPath?: string): Promise<string> {
  const candidates: string[] = [];
  if (customPath) candidates.push(customPath);
  if (process.env.CAKE_VSCODE_SERVER_PATH) candidates.push(process.env.CAKE_VSCODE_SERVER_PATH);
  if (process.platform === "linux")
    candidates.push(
      join(root, `openvscode-server-v${VSCODE_SERVER_VERSION}`, "bin", "openvscode-server"),
    );
  candidates.push(
    "/opt/homebrew/bin/code-server",
    "/usr/local/bin/code-server",
    "/usr/bin/code-server",
  );
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  if (process.platform === "darwin")
    throw new Error(
      "No VS Code server is installed on this Mac. Run `brew install code-server`, then retry, or set CAKE_VSCODE_SERVER_PATH to an existing server binary.",
    );
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
    case "linux-x64":
    case "linux-arm64":
      return `openvscode-server-v${VSCODE_SERVER_VERSION}-${key}.tar.gz`;
    default:
      throw new Error(
        `openvscode-server publishes Linux builds only; on ${key}, install code-server locally (\`brew install code-server\`) and retry.`,
      );
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
