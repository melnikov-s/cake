/** In-process provider diagnostics port. No SDK values, transport credentials or response
 * bodies cross it. Never exposed over RPC; observers must not modify outgoing content. */
interface ProviderRequestObserver {
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the untrusted SDK observation boundary, not a domain input. The observer serializes arbitrary provider payloads, including binary SDK blocks, without modifying them.
  payload(value: unknown): void;
  fetch(delegate?: typeof globalThis.fetch): typeof globalThis.fetch;
  settle(failed: boolean): void;
}
export type ProviderRequestObservation = (
  identity: {
    provider: string;
    id: string;
    api: string;
  },
  settings: { reasoning?: string; maxTokens: number; fastMode: boolean },
) => ProviderRequestObserver;
