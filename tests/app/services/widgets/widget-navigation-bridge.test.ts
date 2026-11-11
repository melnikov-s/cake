import { createRequire } from "node:module";
import { Option, Schema } from "effect";
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

it("runs the shared SDK's structured calls, hydrated current-session API and event disposal", async () => {
  const compiled = await compileInlineWidget("html", "<p>SDK</p>", "artifact");
  const wire = Schema.Struct({
    type: Schema.Literals(["widget-subscribe", "widget-unsubscribe", "artifact-cake-call"]),
    value: Schema.Struct({
      id: Schema.optionalKey(Schema.String),
      subscriptionId: Schema.optionalKey(Schema.String),
    }),
  });
  const sent: (typeof wire.Type)[] = [];
  const { window } = new JSDOM(compiled.document, {
    runScripts: "dangerously",
    beforeParse(window) {
      window.postMessage = (message) => {
        const parsed = Schema.decodeUnknownOption(wire)(message);
        if (Option.isSome(parsed)) sent.push(parsed.value);
      };
      window.ResizeObserver = class {
        observe() {}
        disconnect() {}
      };
    },
  });
  try {
    // SAFETY: compiled source under test installs this public SDK.
    const cake = Reflect.get(window, "cake") as unknown as {
      tools: { call(command: string, input: object): Promise<unknown> };
      session: {
        getCurrent(): Promise<unknown>;
        subscribeCurrent(listener: (session: unknown) => void): Promise<() => void>;
      };
      events: {
        subscribe(
          topic: string,
          filter: object,
          listener: (event: unknown) => void,
        ): Promise<() => void>;
      };
    };
    const host = (type: string, value: unknown, token = compiled.token) =>
      window.dispatchEvent(
        new window.MessageEvent("message", {
          source: window,
          data: { source: "cake-artifact-host", token, type, value },
        }),
      );
    let hydrated = false;
    const current = cake.session.getCurrent().then((value) => {
      hydrated = true;
      return value;
    });
    await Promise.resolve();
    expect(hydrated).toBe(false);
    host("context", { session: { sessionId: "one", kind: "project-session" } });
    expect(await current).toEqual({ sessionId: "one", kind: "project-session" });
    const sessions = vi.fn();
    const stopSession = await cake.session.subscribeCurrent(sessions);
    host("context", { session: null });
    expect(sessions).toHaveBeenLastCalledWith(null);
    stopSession();
    host("context", { session: { sessionId: "two", kind: "project-chat" } });
    expect(sessions).toHaveBeenCalledTimes(2);

    const call = cake.tools.call("sessions.list", {});
    const callId = sent.find((entry) => entry.type === "artifact-cake-call")!.value.id;
    host("call-result", {
      id: callId,
      ok: true,
      result: { sessions: [{ sessionId: "canonical" }], total: 1 },
    });
    expect(await call).toEqual({ sessions: [{ sessionId: "canonical" }], total: 1 });

    const listener = vi.fn();
    const subscription = cake.events.subscribe("session.changed", {}, listener);
    const request = sent.find((entry) => entry.type === "widget-subscribe")!.value;
    host("call-result", { id: request.id, ok: true, result: { subscribed: true } });
    const unsubscribe = await subscription;
    host(
      "widget-update",
      { id: request.subscriptionId, update: { kind: "ready", topic: "session.changed" } },
      "wrong-token",
    );
    expect(listener).not.toHaveBeenCalled();
    host("widget-update", {
      id: request.subscriptionId,
      update: { kind: "ready", topic: "session.changed" },
    });
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    expect(sent.at(-1)).toMatchObject({
      type: "widget-unsubscribe",
      value: { subscriptionId: request.subscriptionId },
    });
    host("widget-update", {
      id: request.subscriptionId,
      update: { kind: "ready", topic: "session.changed" },
    });
    expect(listener).toHaveBeenCalledOnce();
  } finally {
    window.close();
  }
});
