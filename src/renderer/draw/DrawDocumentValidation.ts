import type { DrawDocumentSnapshot } from "../../domain/draw/draw-editor";
import type { JsonObject, JsonValue } from "../../ipc/json-contract";

export interface ValidatedDrawDocument extends JsonObject {
  readonly type: typeof DRAW_SNAPSHOT_TYPE;
  readonly version: typeof DRAW_SNAPSHOT_VERSION;
  readonly source: "cake";
  readonly elements: readonly JsonValue[];
  readonly appState: JsonObject;
  readonly files: JsonObject;
}

export const DRAW_SNAPSHOT_TYPE = "cake-excalidraw";
export const DRAW_SNAPSHOT_VERSION = 1;

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return (
    value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value)
  );
}

export function assertPersistableDrawDocument(
  snapshot: DrawDocumentSnapshot,
): asserts snapshot is ValidatedDrawDocument {
  if (
    !isJsonObject(snapshot) ||
    snapshot.type !== DRAW_SNAPSHOT_TYPE ||
    snapshot.version !== DRAW_SNAPSHOT_VERSION ||
    snapshot.source !== "cake" ||
    !Array.isArray(snapshot.elements) ||
    !isJsonObject(snapshot.appState) ||
    !isJsonObject(snapshot.files)
  )
    throw new Error("Invalid Cake Draw Excalidraw document snapshot");

  for (const file of Object.values(snapshot.files)) {
    if (!isJsonObject(file)) throw new Error("Invalid Cake Draw image");
    const mimeType = file.mimeType;
    const dataURL = file.dataURL;
    if (
      typeof mimeType !== "string" ||
      typeof dataURL !== "string" ||
      !["image/png", "image/jpeg", "image/webp"].includes(mimeType) ||
      !dataURL.startsWith(`data:${mimeType};base64,`)
    )
      throw new Error("Draw images must be inline PNG, JPEG, or WebP data URLs");
  }
}
