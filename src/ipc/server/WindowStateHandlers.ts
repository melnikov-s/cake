import { Effect } from "effect";
import { WindowStateStorage } from "../../services/storage/WindowStateStorage";
import { WindowStateRpc } from "../protocol/WindowStateRpc";

export const windowStateHandlers = WindowStateRpc.of({
  "windowState.load": () => Effect.flatMap(WindowStateStorage, (storage) => storage.load()),
  "windowState.save": ({ snapshot }) =>
    Effect.flatMap(WindowStateStorage, (storage) => storage.save(snapshot)),
});
