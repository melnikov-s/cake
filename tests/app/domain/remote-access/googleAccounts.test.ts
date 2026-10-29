import { it } from "@effect/vitest";
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { Effect, FileSystem, Layer } from "effect";
import { expect } from "vitest";
import { bindGoogleAccount } from "../../../../src/domain/remote-access/googleAccounts";
import { loadRemoteAccessBindings } from "../../../../src/services/storage/remote-access-bindings";

const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer);

it.effect(
  "pins a verified account to its Google subject durably and refuses an email reassigned to a different account",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cake-google-bindings-" });
      const account = { email: "owner@gmail.com", subject: "stable-google-id" };
      const empty = yield* loadRemoteAccessBindings(directory);
      const bound = yield* bindGoogleAccount(directory, empty, ["OWNER@gmail.com"], account);
      expect(bound).toEqual([account]);
      // A fresh disk read represents a restarted host, not an in-memory cache.
      const reloaded = yield* loadRemoteAccessBindings(directory);
      expect(yield* bindGoogleAccount(directory, reloaded, [account.email], account)).toEqual([
        account,
      ]);
      expect(
        (yield* bindGoogleAccount(directory, reloaded, [account.email], {
          ...account,
          subject: "other-account",
        }).pipe(Effect.flip)).message,
      ).toContain("does not match");
      expect(
        (yield* bindGoogleAccount(directory, reloaded, [], account).pipe(Effect.flip)).message,
      ).toContain("no longer allowed");
      expect(yield* loadRemoteAccessBindings(directory)).toEqual([account]);
      expect((yield* fs.stat(`${directory}/remote-access-bindings.json`)).mode & 0o777).toBe(0o600);
    }).pipe(Effect.scoped, Effect.provide(platform)),
);

it.effect("fails closed on corrupt persisted account identities", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cake-google-bindings-" });
    yield* fs.writeFileString(`${directory}/remote-access-bindings.json`, '{"invalid":true}');
    expect((yield* loadRemoteAccessBindings(directory).pipe(Effect.flip))._tag).toBe(
      "DesktopSharingError",
    );
  }).pipe(Effect.scoped, Effect.provide(platform)),
);
