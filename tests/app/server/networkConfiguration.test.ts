import { it } from "@effect/vitest";
import { ConfigProvider, Effect, Exit } from "effect";
import { expect } from "vitest";
import { networkConfiguration } from "../../../src/server/networkConfiguration";

const read = (values: Record<string, unknown>) =>
  networkConfiguration().pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(values))),
  );

it.effect("network_is_disabled_unless_explicitly_enabled", () =>
  Effect.gen(function* () {
    expect(yield* read({})).toBeUndefined();
    expect(
      yield* read({ CAKE_SERVER_ENABLED: "false", CAKE_SERVER_PORT: "not-read" }),
    ).toBeUndefined();
  }),
);

it.effect("enabled_network_defaults_to_loopback_with_no_browser_or_native_origin_exception", () =>
  Effect.gen(function* () {
    expect((yield* read({ CAKE_SERVER_ENABLED: "true", CAKE_SERVER_BIND: "" }))?.bind).toBe(
      "127.0.0.1",
    );
    expect(yield* read({ CAKE_SERVER_ENABLED: "true" })).toEqual({
      bind: "127.0.0.1",
      port: 4317,
      allowedOrigins: [],
      allowMissingOrigin: false,
      maxPayloadBytes: 1048576,
    });
  }),
);

it.effect("browser_serving_requires_both_opt_ins_and_defaults_to_exact_same_origin", () =>
  Effect.gen(function* () {
    expect(yield* read({ CAKE_SERVER_BROWSER_ENABLED: "true" })).toBeUndefined();
    const browser = yield* read({
      CAKE_SERVER_ENABLED: "true",
      CAKE_SERVER_BROWSER_ENABLED: "true",
    });
    expect(browser?.browserAssetsDirectory).toMatch(/\/browser\/$/);
    expect(browser?.allowedOrigins).toBeUndefined();
    expect(browser?.allowMissingOrigin).toBe(false);
    const explicit = yield* read({
      CAKE_SERVER_ENABLED: "true",
      CAKE_SERVER_BROWSER_ENABLED: "true",
      CAKE_SERVER_ALLOWED_ORIGINS: "https://cake.example",
    });
    expect(explicit?.allowedOrigins).toEqual(["https://cake.example"]);
  }),
);

it.effect("explicit_remote_hosts_origins_and_ephemeral_port_are_decoded", () =>
  Effect.gen(function* () {
    expect(
      yield* read({
        CAKE_SERVER_ENABLED: "true",
        CAKE_SERVER_BIND: "0.0.0.0",
        CAKE_SERVER_PORT: "0",
        CAKE_SERVER_ALLOWED_HOSTS: "cake.example, cake.example:4317",
        CAKE_SERVER_ALLOWED_ORIGINS: "https://cake.example, http://localhost:3000",
        CAKE_SERVER_ALLOW_MISSING_ORIGIN: "true",
        CAKE_SERVER_MAX_PAYLOAD_BYTES: "4096",
      }),
    ).toEqual({
      bind: "0.0.0.0",
      port: 0,
      allowedHosts: ["cake.example", "cake.example:4317"],
      allowedOrigins: ["https://cake.example", "http://localhost:3000"],
      allowMissingOrigin: true,
      maxPayloadBytes: 4096,
    });
  }),
);

it.effect.each([
  { CAKE_SERVER_PORT: "-1" },
  { CAKE_SERVER_PORT: "1.5" },
  { CAKE_SERVER_PORT: "65536" },
  { CAKE_SERVER_MAX_PAYLOAD_BYTES: "0" },
  { CAKE_SERVER_ALLOWED_HOSTS: "*" },
  { CAKE_SERVER_ALLOWED_HOSTS: "https://cake.example" },
  { CAKE_SERVER_ALLOWED_ORIGINS: "*" },
  { CAKE_SERVER_ALLOWED_ORIGINS: "null" },
  { CAKE_SERVER_ALLOWED_ORIGINS: "https://cake.example/path" },
  { CAKE_SERVER_ALLOWED_ORIGINS: "https://cake.example/" },
])("rejects malformed explicit network configuration %j", (invalid) =>
  Effect.gen(function* () {
    expect(
      Exit.isFailure(yield* read({ CAKE_SERVER_ENABLED: "true", ...invalid }).pipe(Effect.exit)),
    ).toBe(true);
  }),
);
