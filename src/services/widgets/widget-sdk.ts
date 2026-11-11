/** Injected inside the artifact sandbox after its request/state/context bridges exist. */
export const widgetSdkBridge = `
  const updateListeners = new Map();
  let subscriptionId = 0;
  addEventListener("message", (event) => {
    const message = event.data;
    if (event.source !== parent || message?.source !== "cake-artifact-host" || message.token !== token || message.type !== "widget-update") return;
    const listener = updateListeners.get(message.value.id);
    if (listener) listener(message.value.update);
  });
  const subscribeUpdate = async (kind, options, listener) => {
    const id = String(++subscriptionId);
    updateListeners.set(id, listener);
    try { await requestCall("widget-subscribe", { subscriptionId: id, kind, ...options }); }
    catch (error) { updateListeners.delete(id); throw error; }
    return () => { updateListeners.delete(id); send("widget-unsubscribe", { subscriptionId: id }); };
  };
  const callCake = (command, input = {}) => requestCall("artifact-cake-call", { command, input });
  globalThis.cake = Object.freeze({
    call: callCake,
    tools: Object.freeze({ call: callCake }),
    session: Object.freeze({
      async getCurrent() { await contextReady; return contextSnapshot?.session ?? null; },
      async subscribeCurrent(listener) {
        await contextReady;
        listener(contextSnapshot?.session ?? null);
        let previous = JSON.stringify(contextSnapshot?.session ?? null);
        const receive = (context) => {
          const session = context?.session ?? null;
          const next = JSON.stringify(session);
          if (next !== previous) { previous = next; listener(session); }
        };
        contextListeners.add(receive);
        return () => contextListeners.delete(receive);
      },
    }),
    events: Object.freeze({ subscribe: (topic, filter, listener) => subscribeUpdate("event", { topic, filter }, listener) }),
    poll: Object.freeze({ subscribe: (options, listener) => subscribeUpdate("poll", { options }, listener) }),
    state: Object.freeze({
      read: () => globalThis.cakeArtifact.read(),
      replace: (value, version) => globalThis.cakeArtifact.replace(value, version),
      subscribe: (listener) => globalThis.cakeArtifact.subscribe(() => listener(globalThis.cakeArtifact.getSnapshot())),
    }),
  });
`;

export const widgetSdkHooks = [
  "export function useCake() { return globalThis.cake; }",
  "export function useCurrentSession() { const context = useSyncExternalStore(bridge.subscribeContext, bridge.getContext, bridge.getContext); return context?.session ?? null; }",
  "function useSubscription(subscribe, listener, dependencies) { const latest = useRef(listener); latest.current = listener; useEffect(() => { let disposed = false; let stop; subscribe((value) => { if (!disposed) latest.current(value); }).then((unsubscribe) => { if (disposed) unsubscribe(); else stop = unsubscribe; }).catch((error) => { if (!disposed) queueMicrotask(() => { throw error; }); }); return () => { disposed = true; stop?.(); }; }, dependencies); }",
  "export function useCakeEvent(topic, filter, listener) { const key = JSON.stringify(filter); useSubscription((receive) => filter === null ? Promise.resolve(() => {}) : globalThis.cake.events.subscribe(topic, filter, receive), listener, [topic, key]); }",
  "export function usePolling(options, listener) { const key = JSON.stringify(options); useSubscription((receive) => options === null ? Promise.resolve(() => {}) : globalThis.cake.poll.subscribe(options, receive), listener, [key]); }",
];
