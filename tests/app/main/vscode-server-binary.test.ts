import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  extractArchive,
  platformAssetName,
  releaseAssetUrl,
  resolveServerBinary,
  VSCODE_SERVER_VERSION,
} from "../../../src/main/vscode-server-binary";

const run = promisify(execFile);

describe("releaseAssetUrl", () => {
  it("points at the pinned release tag with the given asset", () => {
    const url = releaseAssetUrl(platformAssetName("linux", "x64"));
    expect(url).toContain(`releases/download/v${VSCODE_SERVER_VERSION}/`);
    expect(url.endsWith(`openvscode-server-v${VSCODE_SERVER_VERSION}-linux-x64.tar.gz`)).toBe(true);
  });
});

describe("platformAssetName", () => {
  it("maps supported desktop platforms to release archives", () => {
    expect(platformAssetName("darwin", "arm64")).toBe(
      `openvscode-server-v${VSCODE_SERVER_VERSION}-darwin-arm64.tar.gz`,
    );
    expect(platformAssetName("linux", "x64")).toBe(
      `openvscode-server-v${VSCODE_SERVER_VERSION}-linux-x64.tar.gz`,
    );
    expect(platformAssetName("win32", "x64")).toBe(
      `openvscode-server-v${VSCODE_SERVER_VERSION}-win32-x64.zip`,
    );
  });

  it("rejects unsupported platforms", () => {
    expect(() => platformAssetName("freebsd", "x64")).toThrow(/freebsd-x64/);
  });
});

describe("resolveServerBinary", () => {
  let root: string;
  let executablePath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cake-vscode-binary-"));
    executablePath = join(root, "custom-server");
    await writeFile(executablePath, "#!/bin/sh\n");
    await chmod(executablePath, 0o755);
    delete process.env.CAKE_VSCODE_SERVER_PATH;
  });

  afterEach(async () => {
    delete process.env.CAKE_VSCODE_SERVER_PATH;
    await rm(root, { recursive: true, force: true });
  });

  it("prefers the user-configured path over the managed download", async () => {
    const managedDir = join(root, `openvscode-server-v${VSCODE_SERVER_VERSION}`, "bin");
    await mkdir(managedDir, { recursive: true });
    const managed = join(managedDir, "openvscode-server");
    await writeFile(managed, "#!/bin/sh\n");
    await chmod(managed, 0o755);

    expect(await resolveServerBinary(root, executablePath)).toBe(executablePath);
    expect(await resolveServerBinary(root)).toBe(managed);
  });

  it("falls back to the CAKE_VSCODE_SERVER_PATH environment override", async () => {
    process.env.CAKE_VSCODE_SERVER_PATH = executablePath;
    expect(await resolveServerBinary(root)).toBe(executablePath);
  });

  it("throws an actionable error when no binary exists", async () => {
    await expect(resolveServerBinary(root)).rejects.toThrow(/not installed yet/);
  });
});

describe("extractArchive", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "cake-vscode-archive-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("normalizes the archive's top-level directory into the destination", async () => {
    const payloadDir = join(workDir, "payload", "openvscode-server-v1");
    await mkdir(payloadDir, { recursive: true });
    await writeFile(join(payloadDir, "bin"), "launcher");
    const archive = join(workDir, "release.tar.gz");
    await run("tar", ["-czf", archive, "-C", join(workDir, "payload"), "openvscode-server-v1"]);

    const destination = join(workDir, "app");
    await extractArchive(archive, destination, false);

    // The wrapper directory is replaced by its contents at `destination`.
    expect(await import("node:fs/promises").then((fs) => fs.readdir(destination))).toEqual(["bin"]);
  });

  it("rejects archives with more than one top-level entry", async () => {
    await writeFile(join(workDir, "loose.txt"), "first");
    await writeFile(join(workDir, "stray.txt"), "second");
    const archive = join(workDir, "flat.tar.gz");
    await run("tar", ["-czf", archive, "-C", workDir, "loose.txt", "stray.txt"]);

    await expect(extractArchive(archive, join(workDir, "out"), false)).rejects.toThrow(
      /Unexpected archive layout/,
    );
  });
});
