import { serializeAsJSON } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";

export interface ExcalidrawDocumentSource {
  readonly elements: readonly ExcalidrawElement[];
  readonly appState: Partial<AppState>;
  readonly files: BinaryFiles;
}

/** Uses Excalidraw's native serializer so exported boards remain editable outside Cake. */
export function serializeExcalidrawDocument(source: ExcalidrawDocumentSource): string {
  return serializeAsJSON(source.elements, source.appState, source.files, "local");
}
