import { createRequire } from "node:module";
import { expect, it, vi } from "vitest";
import { compileInlineWidget } from "../../../../src/services/widgets/inline-widget-service";
import type { ArtifactNavigationContext } from "../../../../src/contracts/artifacts/artifact-navigation-context";

interface BridgeWindow extends Window {
  ResizeObserver: unknown;
  MessageEvent: typeof MessageEvent;
}
// SAFETY: jsdom's documented public constructor; the package has no installed declarations.
const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (
    html: string,
    options: { runScripts: "dangerously"; beforeParse(window: BridgeWindow): void },
  ) => { window: BridgeWindow };
};
interface ContextApi {
  getContext(): ArtifactNavigationContext | null;
  subscribeContext(listener: (context: ArtifactNavigationContext | null) => void): () => void;
}

it("runs the authored HTML context subscription with authenticated initial/live snapshots and unsubscribe, independently of saved state", async () => {
  const compiled = await compileInlineWidget("html", "<p>PR dashboard</p>", "artifact");
  const { window } = new JSDOM(compiled.document, {
    runScripts: "dangerously",
    beforeParse(window) {
      window.postMessage = () => {};
      window.ResizeObserver = class {
        observe() {}
        disconnect() {}
      };
    },
  });
  try {
    // SAFETY: this is the API installed by the compiled document under test.
    const api = Reflect.get(window, "cakeArtifact") as ContextApi;
    expect(api.getContext()).toBeNull();
    const changes = vi.fn();
    const unsubscribe = api.subscribeContext(changes);
    const context: ArtifactNavigationContext = {
      windowId: "window-a",
      project: { path: "/a", name: "A" },
      session: null,
    };
    const send = (
      value: ArtifactNavigationContext,
      token = compiled.token,
      source: Window | null = window,
    ) =>
      window.dispatchEvent(
        new window.MessageEvent("message", {
          source,
          data: { source: "cake-artifact-host", token, type: "context", value },
        }),
      );
    send(context, "wrong-token");
    send(context, compiled.token, null);
    expect(api.getContext()).toBeNull();
    send(context);
    expect(api.getContext()).toEqual(context);
    expect(changes).toHaveBeenCalledExactlyOnceWith(context);
    expect(Object.isFrozen(api.getContext())).toBe(true);
    expect(Object.isFrozen(api.getContext()?.project)).toBe(true);
    send(context);
    expect(changes).toHaveBeenCalledTimes(1);
    const next = {
      ...context,
      project: { path: "/b", name: "B" },
      session: { sessionId: "b1", kind: "project-session" as const },
    };
    send(next);
    expect(changes).toHaveBeenLastCalledWith(next);
    unsubscribe();
    send(context);
    expect(changes).toHaveBeenCalledTimes(2);
    expect(api.getContext()).toEqual(context);
  } finally {
    window.close();
  }
});

it("rerenders the real React useArtifact context hook on navigation without remounting the authored view", async () => {
  const compiled = await compileInlineWidget(
    "react",
    `
    import { useArtifact } from "@cake/artifact-sdk";
    import { useState } from "react";
    export default function Dashboard() {
      const { context } = useArtifact();
      const [mount] = useState(() => "same mount");
      return <p>{mount}: {context?.project?.path ?? "no project"}/{context?.session?.sessionId ?? "no session"}</p>;
    }
  `,
    "artifact",
  );
  const { window } = new JSDOM(compiled.document, {
    runScripts: "dangerously",
    beforeParse(window) {
      window.postMessage = () => {};
      window.ResizeObserver = class {
        observe() {}
        disconnect() {}
      };
    },
  });
  try {
    const send = (project: string, sessionId: string) =>
      window.dispatchEvent(
        new window.MessageEvent("message", {
          source: window,
          data: {
            source: "cake-artifact-host",
            token: compiled.token,
            type: "context",
            value: {
              windowId: "window-a",
              project: { path: project, name: project },
              session: { sessionId, kind: "project-session" },
            },
          },
        }),
      );
    send("/a", "a1");
    await vi.waitFor(() => expect(window.document.body.textContent).toContain("same mount: /a/a1"));
    const element = window.document.querySelector("p");
    send("/b", "b1");
    await vi.waitFor(() => expect(window.document.body.textContent).toContain("same mount: /b/b1"));
    expect(window.document.querySelector("p")).toBe(element);
  } finally {
    window.close();
  }
});
