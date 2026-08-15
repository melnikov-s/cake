/** @vitest-environment jsdom */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore, mount } from "r-state-tree";

vi.mock("mermaid", () => ({ default: { initialize: vi.fn(), render: vi.fn(async () => ({ svg: "<svg role='img'></svg>" })) } }));
import { ArtifactHost } from "../../../src/renderer/components/artifact-host";
import type { ArtifactRecord } from "../../../src/ipc/artifact-contract";
import type { DesktopClient } from "../../../src/renderer/desktop-client";
import { InlineWidgetStore } from "../../../src/renderer/stores/InlineWidgetStore";

function record(artifact: ArtifactRecord["artifact"]): ArtifactRecord { return { artifact, workspacePath: "/project", digest: "a".repeat(64), createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }; }

describe("ArtifactHost", () => {
  let container: HTMLDivElement; let root: Root; let widgets: InlineWidgetStore | undefined;
  beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); });
  afterEach(() => { act(() => root.unmount()); widgets?.[Symbol.dispose](); widgets = undefined; container.remove(); });

  it("sorts and filters table rows", () => {
    const artifact = record({ protocol: "cake.artifact/v1", id: "table", sessionId: "session", revision: 1, kind: "table", payload: { columns: [{ id: "score", label: "Score", type: "number" }], rows: [{ id: "a", score: 2 }, { id: "b", score: 1 }], selectable: false }, fallback: { markdown: "Scores" }, interaction: { mode: "present" } });
    act(() => root.render(<ArtifactHost record={artifact} />));
    expect([...container.querySelectorAll("tbody td")].map((cell) => cell.textContent)).toEqual(["2", "1"]);
    act(() => (container.querySelector("th button") as HTMLButtonElement).click());
    expect([...container.querySelectorAll("tbody td")].map((cell) => cell.textContent)).toEqual(["1", "2"]);
    act(() => { const input = container.querySelector('[aria-label="Filter table"]') as HTMLInputElement; setInputValue(input, "2"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(container.querySelectorAll("tbody tr")).toHaveLength(1);
  });

  it("submits a structured form once through its host callback and isolates raw HTML", () => {
    const submit = vi.fn();
    const request = { protocol: "cake.request/v1" as const, id: "form", title: "Answer", responseSchema: { type: "object" as const }, view: { type: "form" as const, fields: [{ id: "answer", label: "Answer", type: "text" as const, required: true }], submitLabel: "Send" }, fallback: { markdown: "Answer" } };
    const form = record({ protocol: "cake.artifact/v1", id: "form", sessionId: "session", revision: 1, kind: "request", payload: { request }, fallback: request.fallback, interaction: { mode: "request", responseSchema: request.responseSchema } });
    act(() => root.render(<ArtifactHost record={form} requested onSubmit={submit} />));
    act(() => { const input = container.querySelector("input") as HTMLInputElement; setInputValue(input, "yes"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    act(() => (container.querySelector("form") as HTMLFormElement).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(submit).toHaveBeenCalledWith({ answer: "yes" });

    const html = record({ protocol: "cake.artifact/v1", id: "html", sessionId: "session", revision: 1, kind: "html", payload: { html: "<script>parent.document.body.textContent='owned'</script>" }, fallback: { markdown: "HTML fallback" }, interaction: { mode: "present" } });
    act(() => root.render(<ArtifactHost record={html} />));
    const frame = container.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("srcdoc")).toContain("default-src 'none'");
    expect(document.body.textContent).not.toContain("owned");
  });

  it("renders a custom request in the script sandbox and accepts its token-bound submission", async () => {
    const token = "00000000-0000-4000-8000-000000000001";
    const client = { compileInlineWidget: vi.fn(async () => ({ token, url: `cake-widget://document/${token}` })), repairInlineWidget: vi.fn() } as unknown as DesktopClient;
    widgets = mount(createStore(InlineWidgetStore, { client }));
    const submit = vi.fn();
    const request = { protocol: "cake.request/v1" as const, id: "visual", title: "Visual choice", responseSchema: { type: "object" as const }, view: { type: "widget" as const, language: "html" as const, source: "<button onclick=\"cakeRequest.submit({choice:'yes'})\">Yes</button>" }, fallback: { markdown: "Choose yes." } };
    const artifact = record({ protocol: "cake.artifact/v1", id: request.id, sessionId: "session", revision: 1, kind: "request", payload: { request }, fallback: request.fallback, interaction: { mode: "request", responseSchema: request.responseSchema } });

    await act(async () => { root.render(<ArtifactHost record={artifact} requested onSubmit={submit} inlineWidgets={widgets} />); await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(client.compileInlineWidget).toHaveBeenCalledWith("html", request.view.source, "request");
    const frame = container.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("src")).toBe(`cake-widget://document/${token}`);
    act(() => (container.querySelector(".inline-widget-actions button") as HTMLButtonElement).click());
    expect(container.querySelector('.inline-widget-source [data-streamdown="code-block"]')).not.toBeNull();
    expect(container.querySelector(".inline-widget-source")?.textContent).toContain("cakeRequest.submit");
    act(() => window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, data: { source: "cake-inline-widget", token, type: "submit", value: { choice: "yes" } } })));
    expect(submit).toHaveBeenCalledWith({ choice: "yes" });
  });
});

function setInputValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
}
