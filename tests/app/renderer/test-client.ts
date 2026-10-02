import type { Client } from "../../../src/renderer/client/Client";

/** Typed service-boundary overrides for renderer integration tests. */
export type TestClientOverrides = {
  readonly [Group in keyof Client]?: Partial<Client[Group]>;
};

/**
 * Creates a typed renderer Client whose unconfigured methods fail on use.
 *
 * Tests configure only external service boundaries they intentionally exercise. An unexpected
 * service call is therefore a useful failure rather than an undefined-method accident.
 */
export function createTestClient(overrides: TestClientOverrides = {}): Client {
  const groups = new Map<PropertyKey, object>();
  const target = Object.create(null) as Client;

  return new Proxy(target, {
    get(_target, group: string | symbol) {
      const existing = groups.get(group);
      if (existing) return existing;

      const configured =
        typeof group === "string"
          ? (overrides[group as keyof TestClientOverrides] as object | undefined)
          : undefined;
      const service = new Proxy(configured ?? {}, {
        get(serviceTarget, operation: string | symbol, receiver) {
          if (Reflect.has(serviceTarget, operation))
            return Reflect.get(serviceTarget, operation, receiver);
          return () => {
            throw new Error(
              `Unexpected renderer Client call: ${String(group)}.${String(operation)}`,
            );
          };
        },
      });
      groups.set(group, service);
      return service;
    },
  });
}
