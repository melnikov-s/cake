import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";

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

/** Short, user-facing reasons for the image placeholder. */
function imageReadFailure(cause: unknown) {
  const code = cause instanceof Error && "code" in cause ? cause.code : undefined;
  if (code === "ENOENT" || code === "ENOTDIR") return new Error("File not found");
  if (code === "EACCES" || code === "EPERM") return new Error("Permission denied");
  return cause;
}

/** Reads any local image file; only type and size are restricted. */
export async function readLocalImage(target: string) {
  const mimeType = imageMimeTypes.get(extname(target).toLowerCase());
  if (!mimeType) throw new Error(`Unsupported image type: ${extname(target) || "no extension"}`);
  const metadata = await stat(target).catch((cause: unknown) => {
    throw imageReadFailure(cause);
  });
  if (!metadata.isFile()) throw new Error("Not a file");
  if (metadata.size > maxImageBytes) throw new Error("Image is larger than 8 MB");
  const data = await readFile(target).catch((cause: unknown) => {
    throw imageReadFailure(cause);
  });
  if (data.byteLength > maxImageBytes) throw new Error("Image is larger than 8 MB");
  return { data: data.toString("base64"), mimeType };
}
