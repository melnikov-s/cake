import { Effect } from "effect";
import { CakeSessionRuntimes } from "../../services/pi/CakeSessionRuntimes";
import { PiSettings } from "../../services/pi/PiSettings";
import { PiSettingsError } from "../../contracts/pi/pi-settings-errors";
import { PiSettingsRpc } from "../protocol/PiSettingsRpc";

const reloadSessions = (operation: string) =>
  Effect.flatMap(CakeSessionRuntimes, (sessions) => sessions.reloadAll()).pipe(
    Effect.mapError((error) => new PiSettingsError({ operation, message: error.message })),
  );

export const piSettingsHandlers = PiSettingsRpc.of({
  "piSettings.extensions": () => Effect.flatMap(PiSettings, (settings) => settings.extensions()),
  "piSettings.setExtensionEnabled": (toggle) =>
    Effect.gen(function* () {
      const settings = yield* PiSettings;
      const value = yield* settings.setExtensionEnabled(toggle);
      yield* reloadSessions("setExtensionEnabled");
      return value;
    }),
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
