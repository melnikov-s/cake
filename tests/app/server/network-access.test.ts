import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { exactHost, exactOrigin } from "../../../src/contracts/desktop/network-access";
import { DesktopSharingInput } from "../../../src/contracts/desktop/desktop-sharing-data";

describe("exact network access boundaries", () => {
  it.each(["laptop.tailnet.ts.net", "laptop.tailnet.ts.net:8443", "[::1]:4317"])(
    "accepts exact Host %s",
    (host) => {
      expect(Schema.decodeUnknownSync(exactHost)(host)).toBe(host);
    },
  );
  it.each([
    "*",
    "*.ts.net",
    "https://cake.example",
    "cake.example/",
    "cake.example?x",
    "user@cake.example",
    "cake.example#x",
    "",
    "cake.example:0/path",
  ])("rejects ambiguous or non-authority Host %s", (host) => {
    expect(() => Schema.decodeUnknownSync(exactHost)(host)).toThrow();
  });
  it.each([
    "*",
    "null",
    "https://*.example",
    "https://cake.example/",
    "https://cake.example/path",
    "https://cake.example?x",
    "https://user:pass@cake.example",
    "https://cake.example#x",
    "wss://cake.example",
    "https://CAKE.example",
  ])("rejects non-exact Origin %s", (origin) => {
    expect(() => Schema.decodeUnknownSync(exactOrigin)(origin)).toThrow();
  });
  it("allows an exact non-default HTTPS port without opting into a network bind", () => {
    const input = Schema.decodeUnknownSync(DesktopSharingInput)({
      enabled: true,
      bind: "127.0.0.1",
      port: 4317,
      publicOrigin: "https://laptop.tailnet.ts.net:8443",
    });
    expect(input.publicOrigin).toBe("https://laptop.tailnet.ts.net:8443");
    expect(input.bind).toBe("127.0.0.1");
  });
  it.each([
    "http://cake.example",
    "https://cake.example/",
    "",
    "https://cake.example:443",
    "https://cake.example/rpc",
    "https://cake.example,https://other.example",
  ])("desktop refuses invalid HTTPS origin %s", (publicOrigin) => {
    expect(() =>
      Schema.decodeUnknownSync(DesktopSharingInput)({
        enabled: true,
        bind: "127.0.0.1",
        port: 4317,
        publicOrigin,
      }),
    ).toThrow();
  });
  it("still refuses automatic all-interface binding", () => {
    expect(() =>
      Schema.decodeUnknownSync(DesktopSharingInput)({
        enabled: true,
        bind: "0.0.0.0",
        port: 4317,
        publicOrigin: "https://cake.example",
      }),
    ).toThrow();
  });
});
