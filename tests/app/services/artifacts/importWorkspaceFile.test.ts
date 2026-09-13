import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  importWorkspaceFile,
  MAX_FILE_ARTIFACT_BYTES,
} from "../../../../src/services/artifacts/importWorkspaceFile";

const directories: string[] = [];

const input = (workingDirectory: string, path: string) => ({
  workingDirectory,
  path,
  id: "file-1",
  sessionId: "session-1",
  revision: 1,
});

afterEach(async () =>
  Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))),
);

describe("importWorkspaceFile", () => {
  it("snapshots a workspace-relative file with inferred MIME and a Markdown fallback", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "cake-file-artifact-"));
    directories.push(workspace);
    await mkdir(join(workspace, "reports"));
    await writeFile(join(workspace, "reports", "result.json"), '{"ok":true}\n');

    const artifact = await Effect.runPromise(
      importWorkspaceFile({ ...input(workspace, "reports/result.json"), title: "Result" }),
    );

    expect(artifact).toMatchObject({
      kind: "file",
      title: "Result",
      payload: {
        name: "result.json",
        mimeType: "application/json",
        byteSize: 12,
        data: Buffer.from('{"ok":true}\n').toString("base64"),
      },
      fallback: { markdown: "File: `result.json` (application/json, 12 bytes)." },
    });
  });

  it("uses application/octet-stream for unknown extensions", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "cake-file-artifact-"));
    directories.push(workspace);
    await writeFile(join(workspace, "payload.unknown"), Buffer.from([0, 255]));

    const artifact = await Effect.runPromise(
      importWorkspaceFile(input(workspace, "payload.unknown")),
    );

    expect(artifact.kind === "file" && artifact.payload.mimeType).toBe("application/octet-stream");
  });

  it("rejects traversal, absolute and symlink escapes, and directories", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "cake-file-artifact-workspace-"));
    const outside = await mkdtemp(join(tmpdir(), "cake-file-artifact-outside-"));
    directories.push(workspace, outside);
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(join(outside, "secret.txt"), join(workspace, "link.txt"));
    await mkdir(join(workspace, "folder"));

    await expect(
      Effect.runPromise(importWorkspaceFile(input(workspace, "../secret.txt"))),
    ).rejects.toThrow("traversal");
    await expect(
      Effect.runPromise(importWorkspaceFile(input(workspace, join(outside, "secret.txt")))),
    ).rejects.toThrow("must be relative");
    await expect(
      Effect.runPromise(importWorkspaceFile(input(workspace, "link.txt"))),
    ).rejects.toThrow("outside the authorized Working Directory");
    await expect(
      Effect.runPromise(importWorkspaceFile(input(workspace, "folder"))),
    ).rejects.toThrow("must identify a file");
  });

  it("rejects an oversized file from stat before reading or encoding it", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "cake-file-artifact-"));
    directories.push(workspace);
    await writeFile(join(workspace, "large.bin"), Buffer.alloc(MAX_FILE_ARTIFACT_BYTES + 1));

    const failure = await Effect.runPromiseExit(importWorkspaceFile(input(workspace, "large.bin")));
    expect(failure._tag).toBe("Failure");
    if (failure._tag === "Failure") expect(String(failure.cause)).toContain("snapshot limit");
  });
});
