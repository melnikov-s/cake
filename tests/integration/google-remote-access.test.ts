import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Effect, Queue } from "effect";
import { expect } from "vitest";
import {
  makeGoogleRemoteAccess,
  type GoogleRemoteAccessOptions,
  type GoogleIdentityClaims,
} from "../../src/services/remote-access/GoogleRemoteAccess";
import { openNetworkListener } from "../../src/server/NetworkListener";
import * as cakeChatLocations from "../../src/domain/cake-chats/cakeChatLocations";
import { makeNetworkTestBackend } from "./fixtures/network-backend";
import { rawClient } from "./fixtures/network-client";

const origin = "https://laptop.tailnet.ts.net";
const host = new URL(origin).host;
const clientId = "test.apps.googleusercontent.com";
interface Reply {
  status: number;
  body: string;
  cookies: string[];
  location?: string;
}

const setup = Effect.fn("GoogleRemoteAccessTest.setup")(function* (
  overrides: Partial<GoogleRemoteAccessOptions> = {},
) {
  const directory = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "cake-google-access-"))),
    (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
  );
  yield* Effect.promise(async () => {
    await mkdir(join(directory, "assets"));
    await writeFile(join(directory, "index.html"), "<!doctype html><title>Private Cake</title>");
    await writeFile(join(directory, "assets", "app.js"), "// private application");
  });
  let identity: GoogleIdentityClaims | undefined;
  let time = 1000;
  const bindings = new Map<string, string>();
  const auth = makeGoogleRemoteAccess({
    clientId,
    origin,
    allowedEmails: ["owner@gmail.com"],
    now: () => time,
    verifyIdentity: async (credential) => {
      if (credential !== "valid-test-token") throw new Error("Invalid signature");
      return identity;
    },
    bindAccount: async ({ email, subject }) => {
      const previous = bindings.get(email);
      if (previous && previous !== subject) throw new Error("Changed Google subject");
      bindings.set(email, subject);
    },
    ...overrides,
  });
  const backend = yield* makeNetworkTestBackend();
  const listener = yield* openNetworkListener(
    {
      port: 0,
      bind: "127.0.0.1",
      browserAssetsDirectory: directory,
      allowedHosts: [host],
      allowedOrigins: [origin],
    },
    {
      homeDirectory: directory,
      cakeChat: {
        agentDirectory: directory,
        location: cakeChatLocations.make({ homeDirectory: directory, sessionDirectory: directory }),
      },
    },
    undefined,
    auth,
  ).pipe(Effect.provideContext(backend.context));
  assert.equal(listener.address._tag, "TcpAddress");
  const port = listener.address.port;
  const send = (
    path: string,
    options: {
      method?: string;
      cookie?: string;
      origin?: string;
      body?: string;
      host?: string;
      contentType?: string;
    } = {},
  ) =>
    Effect.promise(
      () =>
        new Promise<Reply>((resolve, reject) => {
          const request = httpRequest(
            {
              hostname: "127.0.0.1",
              port,
              path,
              method: options.method ?? "GET",
              headers: {
                Host: options.host ?? host,
                ...(options.origin ? { Origin: options.origin } : {}),
                ...(options.cookie ? { Cookie: options.cookie } : {}),
                ...(options.body
                  ? { "Content-Type": options.contentType ?? "application/x-www-form-urlencoded" }
                  : {}),
              },
            },
            (response) => {
              let body = "";
              response.setEncoding("utf8");
              response.on("data", (data: string) => {
                body += data;
              });
              response.on("end", () =>
                resolve({
                  status: response.statusCode ?? 0,
                  body,
                  cookies: response.headers["set-cookie"] ?? [],
                  location: response.headers.location,
                }),
              );
            },
          );
          request.on("error", reject);
          request.end(options.body);
        }),
    );
  const begin = Effect.fn("GoogleRemoteAccessTest.begin")(function* () {
    const login = yield* send("/auth/login");
    expect(login.status).toBe(200);
    const nonce = /data-nonce="([a-zA-Z0-9_-]+)"/.exec(login.body)?.[1];
    assert.ok(nonce);
    return { nonce, cookie: `__Host-cake-login=${nonce}; g_csrf_token=csrf-test` };
  });
  const complete = (
    flow: { nonce: string; cookie: string },
    claims = {},
    extras: { cookie?: string; credential?: string; csrf?: string; origin?: string } = {},
  ) => {
    identity = {
      sub: "google-subject-1",
      email: "owner@gmail.com",
      email_verified: true,
      nonce: flow.nonce,
      ...claims,
    };
    return send("/auth/google/callback", {
      method: "POST",
      origin: extras.origin ?? "https://accounts.google.com",
      cookie: extras.cookie ?? flow.cookie,
      body: new URLSearchParams({
        credential: extras.credential ?? "valid-test-token",
        g_csrf_token: extras.csrf ?? "csrf-test",
      }).toString(),
    });
  };
  const signIn = Effect.fn("GoogleRemoteAccessTest.signIn")(function* () {
    const flow = yield* begin();
    const response = yield* complete(flow);
    expect(response.status).toBe(303);
    const session = response.cookies.find((value) => value.startsWith("__Host-cake-session="));
    assert.ok(session);
    expect(session).toContain("HttpOnly; Secure; SameSite=Lax");
    return session.split(";")[0]!;
  });
  return {
    auth,
    listener,
    send,
    begin,
    complete,
    signIn,
    bindings,
    port,
    advance: (ms: number) => {
      time += ms;
    },
  };
});

it.live(
  "gates application assets, resource routes and upgrades; allows approved sign-in and immediately revokes open sockets",
  () =>
    Effect.gen(function* () {
      const f = yield* setup();
      expect(f.listener.editorPort).toBeUndefined();
      expect((yield* f.send("/")).location).toBe("/auth/login");
      for (const path of [
        "/assets/app.js",
        "/widget-assets/document/secret",
        "/rpc",
        "/preview/lease/",
        "/editor/lease/",
      ])
        expect((yield* f.send(path)).status).toBe(401);
      expect(
        yield* rawClient(`ws://127.0.0.1:${f.port}/rpc`, { origin, headers: { Host: host } }).pipe(
          Effect.flip,
        ),
      ).toBeInstanceOf(Error);
      const cookie = yield* f.signIn();
      expect((yield* f.send("/", { cookie })).body).toContain("Private Cake");
      expect((yield* f.send("/assets/app.js", { cookie })).status).toBe(200);
      expect((yield* f.send("/editor/lease/", { cookie })).status).toBe(403);
      expect((yield* f.send("/preview/lease/", { cookie })).status).toBe(403);
      expect((yield* f.send("/", { cookie, origin: "https://evil.example" })).status).toBe(403);
      expect((yield* f.send("/", { cookie, host: "127.0.0.1" })).status).toBe(403);
      const socket = yield* rawClient(`ws://127.0.0.1:${f.port}/rpc`, {
        origin,
        headers: { Host: host, Cookie: cookie },
      });
      f.auth.setAllowedEmails([]);
      yield* Queue.take(socket.closed);
      expect((yield* f.send("/assets/app.js", { cookie })).status).toBe(401);
      f.auth.setAllowedEmails(["owner@gmail.com"]);
      expect((yield* f.send("/assets/app.js", { cookie })).status).toBe(401);
    }),
);

it.live(
  "denies unapproved, unverified, forged, mismatched-nonce and mismatched-subject identities without granting a Cake session",
  () =>
    Effect.gen(function* () {
      const f = yield* setup();
      for (const claims of [
        { email: "other@gmail.com" },
        { email_verified: false },
        { nonce: "wrong" },
        { sub: "" },
      ]) {
        const result = yield* f.complete(yield* f.begin(), claims);
        expect(result.status).toBe(403);
        expect(result.cookies.some((value) => value.startsWith("__Host-cake-session="))).toBe(
          false,
        );
      }
      expect((yield* f.complete(yield* f.begin(), {}, { credential: "forged-token" })).status).toBe(
        403,
      );
      const cookie = yield* f.signIn();
      expect(f.bindings.get("owner@gmail.com")).toBe("google-subject-1");
      expect((yield* f.complete(yield* f.begin(), { sub: "different-account" })).status).toBe(403);
      expect((yield* f.send("/assets/app.js", { cookie })).status).toBe(200);
    }),
);

it.live(
  "requires browser-bound single-use login state and Google's CSRF token; expires flows and sessions and supports logout",
  () =>
    Effect.gen(function* () {
      const f = yield* setup();
      expect(
        (yield* f.complete(yield* f.begin(), {}, { cookie: "g_csrf_token=csrf-test" })).status,
      ).toBe(403);
      expect((yield* f.complete(yield* f.begin(), {}, { csrf: "wrong" })).status).toBe(403);
      const flow = yield* f.begin();
      expect((yield* f.complete(flow)).status).toBe(303);
      expect((yield* f.complete(flow)).status).toBe(403);
      const expired = yield* f.begin();
      f.advance(10 * 60 * 1000 + 1);
      expect((yield* f.complete(expired)).status).toBe(403);
      const cookie = yield* f.signIn();
      const socket = yield* rawClient(`ws://127.0.0.1:${f.port}/rpc`, {
        origin,
        headers: { Host: host, Cookie: cookie },
      });
      expect(
        (yield* f.send("/auth/logout", { method: "POST", cookie, origin: "https://evil.example" }))
          .status,
      ).toBe(403);
      expect((yield* f.send("/auth/logout", { method: "POST", cookie, origin })).status).toBe(303);
      yield* Queue.take(socket.closed);
      expect((yield* f.send("/assets/app.js", { cookie })).status).toBe(401);
      const timed = yield* f.signIn();
      f.advance(7 * 24 * 60 * 60 * 1000 + 1);
      expect((yield* f.send("/assets/app.js", { cookie: timed })).status).toBe(401);
    }),
);

it.live("admits new sign-ins at the pending-flow limit by evicting only the oldest flow", () =>
  Effect.gen(function* () {
    const f = yield* setup();
    const session = yield* f.signIn();
    const oldest = yield* f.begin();
    const retained = yield* f.begin();
    for (let index = 0; index < 254; index++)
      expect((yield* f.send("/auth/login")).status).toBe(200);

    const newest = yield* f.begin();
    expect((yield* f.complete(oldest)).status).toBe(403);
    expect((yield* f.complete(retained)).status).toBe(303);
    expect((yield* f.complete(newest)).status).toBe(303);
    expect((yield* f.send("/assets/app.js", { cookie: session })).status).toBe(200);
  }),
);

it.live(
  "fails closed when durable account binding fails and does not return verifier details",
  () =>
    Effect.gen(function* () {
      const f = yield* setup({
        bindAccount: async () => {
          throw new Error("disk is unavailable; private-details");
        },
      });
      const reply = yield* f.complete(yield* f.begin());
      expect(reply.status).toBe(403);
      expect(reply.body).not.toContain("private-details");
      expect(reply.cookies.some((value) => value.startsWith("__Host-cake-session="))).toBe(false);
    }),
);
