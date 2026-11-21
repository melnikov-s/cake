import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import {
  CanvasImage,
  CanvasPin,
  CanvasPinInput,
  CanvasProject,
  CanvasRead,
  CanvasSnapshot,
  ProjectCanvasError,
} from "../../contracts/project-canvas/project-canvas";

export const ProjectCanvasRpc = RpcGroup.make(
  Rpc.make("projectCanvas.observe", {
    payload: CanvasProject,
    success: CanvasSnapshot,
    error: ProjectCanvasError,
    stream: true,
  }),
  Rpc.make("projectCanvas.preview", {
    payload: { ...CanvasProject.fields, ...CanvasRead.fields },
    success: Schema.NullOr(CanvasImage),
    error: ProjectCanvasError,
  }),
  Rpc.make("projectCanvas.pin", {
    payload: { ...CanvasProject.fields, ...CanvasPinInput.fields },
    success: CanvasPin,
    error: ProjectCanvasError,
  }),
);
