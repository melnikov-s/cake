import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import {
  WindowStateEncodeError,
  WindowStateMalformedDocumentError,
  WindowStateReadError,
  WindowStateUnsupportedVersionError,
  WindowStateWriteError,
} from "../../contracts/storage/window-state-storage-errors";

/** Desktop-local presentation persistence, never shared backend state. */
export const WindowStateRpc = RpcGroup.make(
  Rpc.make("windowState.load", {
    success: Schema.Json,
    error: Schema.Union([
      WindowStateReadError,
      WindowStateMalformedDocumentError,
      WindowStateUnsupportedVersionError,
    ]),
  }),
  Rpc.make("windowState.save", {
    payload: { snapshot: Schema.Json },
    error: Schema.Union([WindowStateEncodeError, WindowStateWriteError]),
  }),
);
