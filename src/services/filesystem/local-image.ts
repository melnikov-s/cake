import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import { expandHomePath } from "./local-path";

// Cake shows every image through an <img> element. Browsers run no scripts and
// load no external resources for SVG in that context, so SVG is as safe as PNG.
const imageMimeTypes = new Map([
  [".avif", "image/avif"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml"],
]);

const maxImageBytes = 8 * 1_024 * 1_024;

export function isImagePath(path: string) {
  return imageMimeTypes.has(extname(path).toLowerCase());
}

class ImageNotFound extends Error {
  constructor(readonly path: string) {
    super(`File not found: ${path}`);
  }
}

/** Short, user-facing reasons for the image placeholder. */
function imageReadFailure(cause: unknown, target: string) {
  const code = cause instanceof Error && "code" in cause ? cause.code : undefined;
  if (code === "ENOENT" || code === "ENOTDIR") return new ImageNotFound(target);
  if (code === "EACCES" || code === "EPERM") return new Error("Permission denied");
  return cause;
}

/** Reads any local image file; only type and size are restricted. */
export async function readLocalImage(target: string) {
  const mimeType = imageMimeTypes.get(extname(target).toLowerCase());
  if (!mimeType) throw new Error(`Unsupported image type: ${extname(target) || "no extension"}`);
  const metadata = await stat(target).catch((cause: unknown) => {
    throw imageReadFailure(cause, target);
  });
  if (!metadata.isFile()) throw new Error("Not a file");
  if (metadata.size > maxImageBytes) throw new Error("Image is larger than 8 MB");
  const data = await readFile(target).catch((cause: unknown) => {
    throw imageReadFailure(cause, target);
  });
  if (data.byteLength > maxImageBytes) throw new Error("Image is larger than 8 MB");
  return { data: data.toString("base64"), mimeType };
}

/**
 * Reads an image an agent referenced. Agents write relative paths against their own
 * working directory, so relative paths try each candidate directory in order. A miss
 * names every absolute path tried, so the placeholder shows where Cake looked.
 */
export async function readReferencedImage(
  path: string,
  directories: ReadonlyArray<string | undefined>,
) {
  const expanded = expandHomePath(path);
  const candidates = isAbsolute(expanded)
    ? [expanded]
    : [
        ...new Set(
          directories.flatMap((directory) => (directory ? [resolve(directory, expanded)] : [])),
        ),
      ];
  for (const candidate of candidates) {
    try {
      return await readLocalImage(candidate);
    } catch (cause) {
      if (!(cause instanceof ImageNotFound)) throw cause;
    }
  }
  const [only, ...others] = candidates;
  if (!only) throw new Error("No directory to resolve a relative image path against");
  if (!others.length) throw new ImageNotFound(only);
  throw new Error(`File not found. Tried:\n${candidates.join("\n")}`);
}
