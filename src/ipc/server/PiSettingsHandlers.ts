import { Effect } from "effect";
import { PiSessions } from "../../services/pi/PiSessions";
import { PiSettings, PiSettingsError } from "../../services/pi/PiSettings";
import { PiSettingsRpc } from "../protocol/PiSettingsRpc";

const reloadSessions = (operation: string) =>
  Effect.flatMap(PiSessions, (sessions) => sessions.reloadAll()).pipe(
    Effect.mapError((error) => new PiSettingsError({ operation, message: error.message })),
  );

export const piSettingsHandlers = PiSettingsRpc.of({
  "piSettings.get": () => Effect.flatMap(PiSettings, (settings) => settings.load()),
  "piSettings.update": ({ update }) =>
    Effect.gen(function* () {
      const settings = yield* PiSettings;
      const value = yield* settings.update(update);
      yield* reloadSessions("update");
      return value;
    }),
  "piSettings.reload": () =>
    Effect.gen(function* () {
      yield* reloadSessions("reload");
      return yield* Effect.flatMap(PiSettings, (settings) => settings.load());
    }),
});
