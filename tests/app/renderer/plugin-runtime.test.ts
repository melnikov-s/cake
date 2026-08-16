/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { definePlugin, Slot } from "../../../src/renderer/cake";
import { dispatchPluginCommand, pluginCommandSnapshot } from "../../../src/renderer/plugin-runtime";

describe("plugin command runtime", () => {
  it("uses friendly aliases when unique and qualified names on collision", async () => {
    const first = vi.fn(); const second = vi.fn();
    definePlugin({ id: "test.alpha", contributions: {}, commands: { open: { description: "Open alpha", run: first } } });
    expect(pluginCommandSnapshot().some((command) => command.name === "open")).toBe(true);
    definePlugin({ id: "test.beta", contributions: {}, commands: { open: { description: "Open beta", run: second } } });
    const names = pluginCommandSnapshot().map((command) => command.name);
    expect(names).toContain("test.alpha.open"); expect(names).toContain("test.beta.open"); expect(names).not.toContain("open");
    expect(await dispatchPluginCommand("/test.beta.open tomorrow")).toBe(true);
    expect(second).toHaveBeenCalledWith("tomorrow", expect.objectContaining({ signal: expect.any(AbortSignal), reveal: expect.any(Function) }));
  });

  it("bridges command reveal requests to the active scene", async () => {
    const listener = vi.fn(); window.addEventListener("cake:reveal-contribution", listener);
    definePlugin({ id: "test.reveal", contributions: {}, commands: { show: { description: "Show", run: (_args, context) => context.reveal("test.reveal.panel", { tab: 2 }) } } });
    await dispatchPluginCommand("/show");
    expect(listener).toHaveBeenCalledOnce();
    expect((listener.mock.calls[0]![0] as CustomEvent).detail).toEqual({ contributionId: "test.reveal.panel", input: { tab: 2 } });
    window.removeEventListener("cake:reveal-contribution", listener);
  });

  it("renders automatically registered slot contributions in deterministic order", () => {
    const Later = () => createElement("span", null, "later");
    const Earlier = () => createElement("span", null, "earlier");
    definePlugin({ id: "test.slots", contributions: { Later, Earlier }, slots: {
      "project-session.right.top": [
        { id: "later", component: Later, order: 20 },
        { id: "earlier", component: Earlier, order: 10 }
      ]
    } });
    expect(renderToStaticMarkup(createElement(Slot, { name: "project-session.right.top" }))).toBe("<span>earlier</span><span>later</span>");
  });
});
