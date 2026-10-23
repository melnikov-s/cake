import type { DiagramRequest } from "../lib/diagram-contract";
import { renderDiagram } from "../lib/diagram-engine";

self.addEventListener("message", (event: MessageEvent<DiagramRequest>) => {
  self.postMessage(renderDiagram(event.data));
});
