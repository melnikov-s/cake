import { Buffer } from "node:buffer";
import { Schema } from "effect";

export type DrawExportFormat = "png" | "svg" | "excalidraw";

const ExcalidrawDocument = Schema.Struct({
  type: Schema.Literal("excalidraw"),
  version: Schema.Number,
  source: Schema.String,
  elements: Schema.Array(Schema.Json),
  appState: Schema.Record(Schema.String, Schema.Json),
  files: Schema.Record(Schema.String, Schema.Json),
});

const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const pngPrefix = "data:image/png;base64,";

export const drawExportExtension = (format: DrawExportFormat) =>
  format === "excalidraw" ? ".excalidraw" : `.${format}`;

export const drawExportFilters = (format: DrawExportFormat) => [
  {
    name: format === "excalidraw" ? "Excalidraw document" : `${format.toUpperCase()} image`,
    extensions: [format],
  },
];

/** Validates untrusted renderer export content and converts it to native file bytes. */
export function decodeDrawExportData(format: DrawExportFormat, data: string): Uint8Array | string {
  if (format === "png") {
    if (!data.startsWith(pngPrefix)) throw new Error("Draw export is not a PNG data URL");
    const encoded = data.slice(pngPrefix.length);
    if (!base64Pattern.test(encoded)) throw new Error("Draw export contains malformed PNG data");
    const bytes = Buffer.from(encoded, "base64");
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (bytes.length < signature.length || signature.some((value, index) => bytes[index] !== value))
      throw new Error("Draw export contains invalid PNG bytes");
    return bytes;
  }
  if (format === "svg") {
    const source = data.trimStart();
    if (!/^(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/u.test(source) || !source.includes("</svg>"))
      throw new Error("Draw export contains invalid SVG source");
    return data;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new Error("Draw export contains invalid Excalidraw JSON");
  }
  try {
    Schema.decodeUnknownSync(ExcalidrawDocument)(parsed);
  } catch {
    throw new Error("Draw export is not an editable Excalidraw document");
  }
  return data;
}
