import { Effect, Option } from "effect";
import type {
  PiSettingUpdate,
  PiSettings as PiSettingsValue,
} from "../../contracts/conversations/session-contract";
import { PiSettingsError } from "../../contracts/pi/pi-settings-errors";
import { PiSettings } from "../../services/pi/PiSettings";
import { CakeSessionRuntimes } from "../../services/pi/CakeSessionRuntimes";
import { ClientEvents } from "../../services/clients/ClientEvents";

const reloadSessions = (operation: string) =>
  Effect.flatMap(CakeSessionRuntimes, (sessions) => sessions.reloadAll()).pipe(
    Effect.mapError((error) => new PiSettingsError({ operation, message: error.message })),
  );

const publish = Effect.fn("PiSettings.publish")(function* (settings: PiSettingsValue) {
  const events = yield* Effect.serviceOption(ClientEvents);
  if (Option.isSome(events)) events.value.broadcast({ type: "pi-settings-changed", settings });
  return settings;
});

export const update = Effect.fn("PiSettings.update")(function* (input: PiSettingUpdate) {
  const value = yield* (yield* PiSettings).update(input);
  yield* reloadSessions("update");
  return yield* publish(value);
});

export const reload = Effect.fn("PiSettings.reload")(function* () {
  yield* reloadSessions("reload");
  return yield* publish(yield* (yield* PiSettings).load());
});
