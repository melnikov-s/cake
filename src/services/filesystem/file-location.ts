import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  PrepareFileLocation,
  PreparedFileLocation,
} from "../../contracts/filesystem/file-location";

/** Both inputs must be canonical absolute paths. Directory equality is not a file. */
function containsFile(directory: string, target: string): boolean {
  const path = relative(directory, target);
  return Boolean(path) && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/** Classify before starting VS Code; only already-authorized roots can grant a text read. */
export async function prepareFileLocation(
  request: PrepareFileLocation,
  allowedDirectories: readonly string[],
  signal?: AbortSignal,
): Promise<PreparedFileLocation> {
  const workspace = request.workspacePath ? await realpath(request.workspacePath) : undefined;
  if (!request.originatingDirectory) throw new Error("A file origin is required");
  const origin = await realpath(request.originatingDirectory);
  let path = request.location.path.trim();
  if (path.startsWith("vscode-remote://")) path = decodeURIComponent(new URL(path).pathname);
  if (request.location.kind === "absolute-file" && !isAbsolute(path))
    throw new Error("An absolute file path is required");
  if (!path) throw new Error("A file path is required");
  const target = await realpath(resolve(origin, path));
  if (workspace && containsFile(workspace, target)) {
    return {
      viewer: "vscode",
      location: {
        ...request.location,
        path: relative(workspace, target).split(sep).join("/"),
        kind: "working-directory",
      },
    };
  }
  const roots = await Promise.all(
    allowedDirectories.map((directory) => realpath(directory).catch(() => undefined)),
  );
  if (!roots.some((root) => root !== undefined && containsFile(root, target)))
    throw new Error("File is not within an authorized project or working directory");

  // Bounded read from the opened handle; directories, devices, binary and invalid UTF-8 are not text.
  const handle = await open(
    target,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("The text viewer requires a regular file");
    if (metadata.size > 2_000_000) throw new Error("File is too large to display");
    signal?.throwIfAborted();
    const bytes = Buffer.alloc(2_000_001);
    let total = 0;
    while (total < bytes.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(bytes, total, bytes.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > 2_000_000) throw new Error("File is too large to display");
    const data = bytes.subarray(0, total);
    if (data.includes(0)) throw new Error("Binary files are not supported by the text viewer");
    const content = new TextDecoder("utf-8", { fatal: true }).decode(data);
    signal?.throwIfAborted();
    return { viewer: "text", path: target, content };
  } finally {
    await handle.close();
  }
}
