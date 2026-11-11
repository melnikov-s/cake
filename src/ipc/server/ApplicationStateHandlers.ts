import { Effect, Stream } from "effect";
import { RendererRequestCoordinator } from "../../services/renderer-requests/RendererRequestCoordinator";
import { RendererConnection } from "../protocol/RendererConnectionMiddleware";
import { getState, observeState } from "../../domain/application/application";
import * as widgetAttachments from "../../domain/widgets/widgetAttachments";
import { AgentAvailability } from "../../services/pi/AgentAvailability";
import {
  ApplicationRpc,
  WidgetAttachmentMutationError,
  ApplicationSettingsMutationError,
} from "../protocol/ApplicationRpc";

const mutationError = Effect.mapError(
  (cause: unknown) =>
    new WidgetAttachmentMutationError({
      message: cause instanceof Error ? cause.message : String(cause),
    }),
);

export const applicationStateHandlers = ApplicationRpc.of({
  "application.respondWindowControl": ({ controlRequestId, result }) =>
    Effect.gen(function* () {
      const { connectionId } = yield* RendererConnection;
      yield* (yield* RendererRequestCoordinator).respondWindowControl(
        connectionId,
        controlRequestId,
        result,
      );
    }).pipe(
      Effect.mapError((cause) => new ApplicationSettingsMutationError({ message: cause.message })),
    ),
  "application.getState": () => getState(),
  "application.observeState": () => Stream.unwrap(observeState()),
  "application.observeAgentAvailability": () =>
    Stream.unwrap(Effect.map(AgentAvailability, (availability) => availability.changes())),
  "application.attachWidget": (input) =>
    widgetAttachments.attach(input).pipe(Effect.asVoid, mutationError),
  "application.setWidgetAttachmentHidden": ({ id, hidden }) =>
    widgetAttachments.setHidden(id, hidden).pipe(Effect.asVoid, mutationError),
  "application.detachWidget": ({ id }) =>
    widgetAttachments.detach(id).pipe(Effect.asVoid, mutationError),
});
