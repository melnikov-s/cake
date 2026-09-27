import { Effect, Stream } from "effect";
import * as savedDrafts from "../../domain/project-sessions/savedDrafts";
import { SavedDraftRpc } from "../protocol/SavedDraftRpc";
import { RendererConnection } from "../protocol/RendererConnectionMiddleware";

export const savedDraftHandlers = SavedDraftRpc.of({
  "savedDrafts.list": () => Effect.flatMap(RendererConnection, () => savedDrafts.list()),
  "savedDrafts.observe": () => Stream.unwrap(Effect.as(RendererConnection, savedDrafts.observe)),
  "savedDrafts.create": (input) =>
    Effect.flatMap(RendererConnection, () => savedDrafts.create(input)),
  "savedDrafts.update": ({ record, expectedRevision }) =>
    Effect.flatMap(RendererConnection, () => savedDrafts.update(record, expectedRevision)),
  "savedDrafts.remove": ({ sessionId, expectedRevision }) =>
    Effect.flatMap(RendererConnection, () => savedDrafts.remove(sessionId, expectedRevision)),
  "savedDrafts.recoverUncertain": ({ sessionId, expectedRevision }) =>
    Effect.flatMap(RendererConnection, () =>
      savedDrafts.recoverUncertain(sessionId, expectedRevision),
    ),
  "savedDrafts.activate": (input) =>
    Effect.flatMap(RendererConnection, () => Effect.scoped(savedDrafts.activate(input))),
});
