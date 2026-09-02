import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { ProjectCatalogUpdate } from "../../domain/catalog-data";
import {
  WindowStateEncodeError,
  WindowStateMalformedDocumentError,
  WindowStateReadError,
  WindowStateUnsupportedVersionError,
  WindowStateWriteError,
} from "../../services/storage/WindowStateStorage";
import { applicationEventSchema } from "../cake-rpc-contract";

export class FoundationFailure extends Schema.TaggedError<FoundationFailure>()(
  "FoundationFailure",
  { message: Schema.String },
) {}

const WindowStateLoadError = Schema.Union([
  WindowStateReadError,
  WindowStateMalformedDocumentError,
  WindowStateUnsupportedVersionError,
  WindowStateEncodeError,
  WindowStateWriteError,
]);

const WindowStateSaveError = Schema.Union([WindowStateEncodeError, WindowStateWriteError]);

export const FoundationRpc = RpcGroup.make(
  Rpc.make("application.getHomeDirectory", { success: Schema.String }),
  Rpc.make("windowState.load", {
    success: Schema.Json,
    error: WindowStateLoadError,
  }),
  Rpc.make("windowState.save", {
    payload: { snapshot: Schema.Json },
    error: WindowStateSaveError,
  }),
  Rpc.make("projects.observeCatalog", {
    success: ProjectCatalogUpdate,
    stream: true,
  }),
  Rpc.make("application.observeEvents", {
    success: applicationEventSchema,
    stream: true,
  }),
  Rpc.make("foundation.typedFailure", { error: FoundationFailure }),
  Rpc.make("foundation.stream", {
    payload: {
      count: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
      intervalMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 })),
    },
    success: Schema.Int,
    stream: true,
  }),
  Rpc.make("foundation.delay", {
    payload: {
      durationMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60_000 })),
    },
  }),
  Rpc.make("foundation.activeRequests", {
    success: Schema.Struct({ delays: Schema.Int, streams: Schema.Int }),
  }),
);
