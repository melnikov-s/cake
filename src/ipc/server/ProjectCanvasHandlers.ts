import * as canvas from "../../domain/project-canvas/projectCanvas";
import { ProjectCanvasRpc } from "../protocol/ProjectCanvasRpc";

export const projectCanvasHandlers = ProjectCanvasRpc.of({
  "projectCanvas.observe": ({ projectChatId }) => canvas.observe(projectChatId),
  "projectCanvas.preview": ({ projectChatId, link }) => canvas.preview(projectChatId, link),
  "projectCanvas.pin": ({ projectChatId, ...pin }) => canvas.pin(projectChatId, pin),
});
