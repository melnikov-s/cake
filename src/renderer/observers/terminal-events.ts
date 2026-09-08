import type { Runtime } from "../runtime";
import type { RootStore } from "../stores/RootStore";

/** Routes window-focused terminal events to the Terminal Store. */
export const observeTerminalEvents = (runtime: Runtime, root: RootStore) =>
  runtime.observe(
    (client) => client.events.terminals(),
    (event) => {
      try {
        if (event.type === "renderer-events-ready") return;
        if (event.type === "terminal-toggle-requested") {
          void root.terminalStore.toggle();
          return;
        }
        root.terminalStore.receive(event);
      } catch (error) {
        root.projectWorkbenchStore.setError(error, `Terminal event: ${event.type}`);
      }
    },
    {
      reportFailure: (error) =>
        root.projectWorkbenchStore.setError(error, "Terminal event observation"),
    },
  );
