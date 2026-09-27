import { Context, Effect, Layer } from "effect";

/** Trusted process-local identity. Native WebContents IDs and socket IDs are never client IDs. */
export class ClientConnections extends Context.Service<
  ClientConnections,
  {
    readonly desktop: (nativeId: number) => number;
    readonly socket: () => number;
    readonly remoteDesktop: (connectionId: number) => void;
    readonly nativeId: (connectionId: number) => number | undefined;
    readonly forNative: (nativeId: number) => number | undefined;
    readonly kind: (connectionId: number) => "desktop" | "browser" | undefined;
    readonly release: (connectionId: number) => void;
  }
>()("cake/services/clients/ClientConnections") {}

export const ClientConnectionsLive = Layer.effect(
  ClientConnections,
  Effect.gen(function* () {
    let sequence = 0;
    const clients = new Map<number, { kind: "desktop"; nativeId?: number } | { kind: "browser" }>();
    const natives = new Map<number, number>();
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        clients.clear();
        natives.clear();
      }),
    );
    const allocate = () => {
      if (sequence === Number.MAX_SAFE_INTEGER)
        throw new Error("Client connection identity exhausted");
      return ++sequence;
    };
    return ClientConnections.of({
      desktop: (nativeId) => {
        const existing = natives.get(nativeId);
        if (existing !== undefined) return existing;
        const id = allocate();
        clients.set(id, { kind: "desktop", nativeId });
        natives.set(nativeId, id);
        return id;
      },
      socket: () => {
        const id = allocate();
        clients.set(id, { kind: "browser" });
        return id;
      },
      remoteDesktop: (id) => {
        if (clients.get(id)?.kind === "browser") clients.set(id, { kind: "desktop" });
      },
      nativeId: (id) => {
        const client = clients.get(id);
        return client?.kind === "desktop" ? client.nativeId : undefined;
      },
      forNative: (id) => natives.get(id),
      kind: (id) => clients.get(id)?.kind,
      release: (id) => {
        const client = clients.get(id);
        if (client?.kind === "desktop" && client.nativeId !== undefined)
          natives.delete(client.nativeId);
        clients.delete(id);
      },
    });
  }),
);
