/** @vitest-environment jsdom */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("mermaid", () => ({ default: { initialize: vi.fn(), render: vi.fn(async () => ({ svg: "<svg role='img'></svg>" })) } }));
import { ArtifactHost } from "../../../src/renderer/components/artifact-host";
import type { ArtifactRecord } from "../../../src/ipc/artifact-contract";

function record(artifact: ArtifactRecord["artifact"]): ArtifactRecord { return { artifact, workspacePath: "/project", digest: "a".repeat(64), createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }; }

describe("ArtifactHost", () => {
  let container: HTMLDivElement; let root: Root;
  beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

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
    const form = record({ protocol: "cake.artifact/v1", id: "form", sessionId: "session", revision: 1, kind: "form", payload: { fields: [{ id: "answer", label: "Answer", type: "text", required: true }], submitLabel: "Send" }, fallback: { markdown: "Answer" }, interaction: { mode: "request" } });
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
});

function setInputValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
}
