import { Config, Effect, Schema } from "effect";
import { fileURLToPath } from "node:url";
import { NetworkListenerOptions } from "./NetworkListener";

/** No socket is acquired by reading configuration. Malformed explicit values fail closed. */
export const networkConfiguration = Effect.fn("Server.networkConfiguration")(function* () {
  const enabled = yield* Config.boolean("CAKE_SERVER_ENABLED").pipe(Config.withDefault(false));
  if (!enabled) return undefined;
  const bind = yield* Config.nonEmptyString("CAKE_SERVER_BIND").pipe(
    Config.withDefault("127.0.0.1"),
  );
  const port = yield* Config.number("CAKE_SERVER_PORT").pipe(Config.withDefault(4317));
  const allowedHosts = yield* Config.string("CAKE_SERVER_ALLOWED_HOSTS").pipe(
    Config.withDefault(""),
  );
  const allowedOrigins = yield* Config.string("CAKE_SERVER_ALLOWED_ORIGINS").pipe(
    Config.withDefault(""),
  );
  const allowMissingOrigin = yield* Config.boolean("CAKE_SERVER_ALLOW_MISSING_ORIGIN").pipe(
    Config.withDefault(false),
  );
  const maxPayloadBytes = yield* Config.number("CAKE_SERVER_MAX_PAYLOAD_BYTES").pipe(
    Config.withDefault(1024 * 1024),
  );
  const browserEnabled = yield* Config.boolean("CAKE_SERVER_BROWSER_ENABLED").pipe(
    Config.withDefault(false),
  );
  const options = { bind, port, allowMissingOrigin, maxPayloadBytes };
  if (browserEnabled)
    Object.assign(options, {
      browserAssetsDirectory: fileURLToPath(new URL("../browser/", import.meta.url)),
    });
  if (allowedOrigins !== "" || !browserEnabled)
    Object.assign(options, {
      allowedOrigins:
        allowedOrigins === "" ? [] : allowedOrigins.split(",").map((origin) => origin.trim()),
    });
  if (allowedHosts !== "") {
    Object.assign(options, { allowedHosts: allowedHosts.split(",").map((host) => host.trim()) });
  }
  return yield* Schema.decodeUnknownEffect(NetworkListenerOptions)(options);
});
