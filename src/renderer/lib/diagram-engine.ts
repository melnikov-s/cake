import { render } from "pele";
import {
  diagramEdgeLimit,
  diagramOutputLimit,
  diagramSourceLimit,
  type DiagramRequest,
  type DiagramResponse,
} from "./diagram-contract";

/** Runs only in the terminable worker. Authors never supply render options or
 * trusted icon/math markup. Unresolved math remains readable TeX. */
export function renderDiagram(request: DiagramRequest): DiagramResponse {
  try {
    const context = !("OffscreenCanvas" in globalThis)
      ? null
      : new OffscreenCanvas(1, 1).getContext("2d");
    const { svg } = render(request.source, {
      // Pele's TextMeasurer style bits: bold=1, italic=2, mono=4. Workers
      // cannot use document.createElement, but Chromium can measure host fonts
      // with an offscreen canvas. Pele uses its metrics table elsewhere.
      measurer: context
        ? {
            width(text, size, style) {
              context.font = `${style & 2 ? "italic " : ""}${style & 1 ? "bold " : ""}${size}px ${style & 4 ? request.fontFamilyMono : request.fontFamily}`;
              return context.measureText(text).width;
            },
          }
        : undefined,
      maxWidth: request.maxWidth,
      fontFamily: request.fontFamily,
      fontFamilyMono: request.fontFamilyMono,
      idPrefix: request.idPrefix,
      limit: diagramSourceLimit,
      outputLimit: diagramOutputLimit,
      maxEdges: diagramEdgeLimit,
      images: false,
      linkSchemes: ["https", "http", "cake"],
      linkRel: "noopener noreferrer",
    });
    return { svg };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
