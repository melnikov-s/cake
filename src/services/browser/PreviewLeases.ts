import { Context, Effect, Layer, Schema, Semaphore } from "effect";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { ClientConnections } from "../clients/ClientConnections";

export class PreviewError extends Schema.TaggedError<PreviewError>()("PreviewError", {
  message: Schema.String,
}) {}

export interface PreviewLease {
  readonly id: string;
  readonly secret: string;
  readonly sessionId: string;
  readonly connectionId: number;
  readonly port: number;
  readonly revocation: AbortController;
}

/** A secret is only delivered to the trusted desktop renderer and native bridge, never to
 * an untrusted preview page. A bare URL on Cake's origin cannot load a preview document. */
export class PreviewLeases extends Context.Service<
  PreviewLeases,
  {
    readonly acquire: (
      connectionId: number,
      sessionId: string,
      port: number,
    ) => Effect.Effect<{ port: number; endpoint: string; secret: string }, PreviewError>;
    readonly find: (id: string, secret: string) => PreviewLease | undefined;
    readonly releaseConnection: (connectionId: number) => Effect.Effect<void>;
    readonly releaseSession: (sessionId: string) => Effect.Effect<void>;
    readonly configure: () => Effect.Effect<void>;
    readonly shutdown: () => Effect.Effect<void>;
  }
>()("cake/services/browser/PreviewLeases") {}

export const PreviewLeasesLive = Layer.effect(
  PreviewLeases,
  Effect.gen(function* () {
    const clients = yield* ClientConnections;
    const leases = new Map<string, PreviewLease>();
    let listening = false;
    const lock = yield* Semaphore.make(1);
    const revoke = (predicate: (lease: PreviewLease) => boolean) => {
      for (const [id, lease] of leases) {
        if (!predicate(lease)) continue;
        leases.delete(id);
        lease.revocation.abort();
      }
    };
    yield* Effect.addFinalizer(() => Effect.sync(() => revoke(() => true)));
    return PreviewLeases.of({
      acquire: Effect.fn("PreviewLeases.acquire")((connectionId, sessionId, port) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            if (clients.kind(connectionId) !== "desktop")
              return yield* new PreviewError({ message: "A desktop renderer is required" });
            if (!listening)
              return yield* new PreviewError({ message: "Preview listener is unavailable" });
            if (!Number.isInteger(port) || port < 1024 || port > 9999)
              return yield* new PreviewError({
                message: "Preview port must be between 1024 and 9999",
              });
            const active = [...leases.values()].filter(
              (lease) => lease.connectionId === connectionId,
            );
            const existing = active.find(
              (lease) => lease.sessionId === sessionId && lease.port === port,
            );
            if (existing)
              return { port, endpoint: `/preview/${existing.id}/`, secret: existing.secret };
            if (active.length >= 8)
              return yield* new PreviewError({
                message: "Too many active previews for this desktop",
              });
            const lease: PreviewLease = {
              id: randomBytes(32).toString("hex"),
              secret: randomBytes(32).toString("hex"),
              sessionId,
              connectionId,
              port,
              revocation: new AbortController(),
            };
            leases.set(lease.id, lease);
            return { port, endpoint: `/preview/${lease.id}/`, secret: lease.secret };
          }),
        ),
      ),
      find: (id, secret) => {
        const lease = leases.get(id);
        if (!lease || lease.revocation.signal.aborted || !/^[0-9a-f]{64}$/.test(secret)) return;
        return timingSafeEqual(Buffer.from(lease.secret, "hex"), Buffer.from(secret, "hex"))
          ? lease
          : undefined;
      },
      releaseConnection: Effect.fn("PreviewLeases.releaseConnection")((id) =>
        Effect.sync(() => revoke((lease) => lease.connectionId === id)),
      ),
      releaseSession: Effect.fn("PreviewLeases.releaseSession")((id) =>
        Effect.sync(() => revoke((lease) => lease.sessionId === id)),
      ),
      configure: Effect.fn("PreviewLeases.configure")(() =>
        Effect.sync(() => {
          listening = true;
        }),
      ),
      shutdown: Effect.fn("PreviewLeases.shutdown")(() =>
        Effect.sync(() => {
          listening = false;
          revoke(() => true);
        }),
      ),
    });
  }),
);
