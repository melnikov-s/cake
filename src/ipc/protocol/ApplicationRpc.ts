import { Schema } from "effect";
import { WindowControlResponse } from "../../contracts/application/window-control";
import { Rpc, RpcGroup } from "effect/rpc";
import {
  RendererApplicationProjection,
  RendererApplicationState,
} from "../../contracts/application/application-data";
import { AgentAvailabilitySnapshot } from "../../contracts/pi/agent-availability-data";
import { widgetAttachmentContracts } from "../../contracts/widgets/widget-attachment";

export class WidgetAttachmentMutationError extends Schema.TaggedError<WidgetAttachmentMutationError>()(
  "WidgetAttachmentMutationError",
  { message: Schema.String },
) {}

export class ApplicationSettingsMutationError extends Schema.TaggedError<ApplicationSettingsMutationError>()(
  "ApplicationSettingsMutationError",
  { message: Schema.String },
) {}

export const ApplicationRpc = RpcGroup.make(
  Rpc.make("application.respondWindowControl", {
    payload: { controlRequestId: Schema.String, result: WindowControlResponse },
    success: Schema.Void,
    error: ApplicationSettingsMutationError,
  }),
  Rpc.make("application.getState", { success: RendererApplicationState }),
  Rpc.make("application.observeState", { success: RendererApplicationProjection, stream: true }),
  Rpc.make("application.observeAgentAvailability", {
    success: AgentAvailabilitySnapshot,
    stream: true,
  }),
  Rpc.make("application.attachWidget", {
    payload: widgetAttachmentContracts[0].inputSchema,
    success: Schema.Void,
    error: WidgetAttachmentMutationError,
  }),
  Rpc.make("application.setWidgetAttachmentHidden", {
    payload: { id: Schema.String, hidden: Schema.Boolean },
    success: Schema.Void,
    error: WidgetAttachmentMutationError,
  }),
  Rpc.make("application.detachWidget", {
    payload: { id: Schema.String },
    success: Schema.Void,
    error: WidgetAttachmentMutationError,
  }),
);
