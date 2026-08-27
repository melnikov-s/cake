/** @vitest-environment jsdom */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore, mount } from "r-state-tree";

vi.mock("mermaid", () => ({
  default: { initialize: vi.fn(), render: vi.fn(async () => ({ svg: "<svg role='img'></svg>" })) },
}));
import { ArtifactHost } from "../../../src/renderer/components/artifact-host";
import { ArtifactsPanel } from "../../../src/renderer/components/artifacts-panel";
import type { ArtifactRecord } from "../../../src/ipc/artifact-contract";
import type { DesktopClient } from "../../../src/renderer/desktop-client";
import { InlineWidgetStore } from "../../../src/renderer/stores/InlineWidgetStore";
import type { ProjectSessionStore } from "../../../src/renderer/stores/ProjectSessionStore";

function record(artifact: ArtifactRecord["artifact"]): ArtifactRecord {
  return {
    artifact,
    workspacePath: "/project",
    digest: "a".repeat(64),
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

describe("ArtifactHost", () => {
  let container: HTMLDivElement;
  let root: Root;
  let widgets: InlineWidgetStore | undefined;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    widgets?.[Symbol.dispose]();
    widgets = undefined;
    container.remove();
  });

  it("sorts and filters table rows", () => {
    const artifact = record({
      protocol: "cake.artifact/v1",
      id: "table",
      sessionId: "session",
      revision: 1,
      kind: "table",
      payload: {
        columns: [{ id: "score", label: "Score", type: "number" }],
        rows: [
          { id: "a", score: 2 },
          { id: "b", score: 1 },
        ],
        selectable: false,
      },
      fallback: { markdown: "Scores" },
      interaction: { mode: "present" },
    });
    act(() => root.render(<ArtifactHost record={artifact} />));
    expect([...container.querySelectorAll("tbody td")].map((cell) => cell.textContent)).toEqual([
      "2",
      "1",
    ]);
    act(() => (container.querySelector("th button") as HTMLButtonElement).click());
    expect([...container.querySelectorAll("tbody td")].map((cell) => cell.textContent)).toEqual([
      "1",
      "2",
    ]);
    act(() => {
      const input = container.querySelector('[aria-label="Filter table"]') as HTMLInputElement;
      setInputValue(input, "2");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelectorAll("tbody tr")).toHaveLength(1);
  });

  it("submits a structured form once through its host callback and isolates raw HTML", () => {
    const submit = vi.fn();
    const request = {
      protocol: "cake.request/v1" as const,
      id: "form",
      title: "Answer",
      responseSchema: { type: "object" as const },
      view: {
        type: "form" as const,
        fields: [{ id: "answer", label: "Answer", type: "text" as const }],
      },
      fallback: { markdown: "Answer" },
    };
    const form = record({
      protocol: "cake.artifact/v1",
      id: "form",
      sessionId: "session",
      revision: 1,
      kind: "request",
      payload: { request },
      fallback: request.fallback,
      interaction: { mode: "request", responseSchema: request.responseSchema },
    });
    act(() => root.render(<ArtifactHost record={form} requested onSubmit={submit} />));
    act(() => {
      const input = container.querySelector("input") as HTMLInputElement;
      setInputValue(input, "yes");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() =>
      (container.querySelector("form") as HTMLFormElement).dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      ),
    );
    expect(submit).toHaveBeenCalledWith({ answer: "yes" });
    const submittedInput = container.querySelector("input") as HTMLInputElement;
    expect(submittedInput.disabled).toBe(true);
    expect(submittedInput.value).toBe("yes");
    expect(container.textContent).toContain("Submitted");
    expect([...container.querySelectorAll("button")].map((b) => b.textContent)).not.toContain(
      "Submit",
    );

    const html = record({
      protocol: "cake.artifact/v1",
      id: "html",
      sessionId: "session",
      revision: 1,
      kind: "html",
      payload: { html: "<script>parent.document.body.textContent='owned'</script>" },
      fallback: { markdown: "HTML fallback" },
      interaction: { mode: "present" },
    });
    act(() => root.render(<ArtifactHost record={html} />));
    const frame = container.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("srcdoc")).toContain("default-src 'none'");
    expect(document.body.textContent).not.toContain("owned");
  });

  it("does not float a request from another branch to the transcript footer", () => {
    const request = {
      protocol: "cake.request/v1" as const,
      id: "branch-request",
      title: "Branch request",
      responseSchema: { type: "object" as const },
      view: {
        type: "form" as const,
        fields: [{ id: "answer", label: "Answer", type: "text" as const }],
      },
      fallback: { markdown: "Answer." },
    };
    const artifact = record({
      protocol: "cake.artifact/v1",
      id: request.id,
      sessionId: "session",
      revision: 1,
      kind: "request",
      payload: { request },
      fallback: request.fallback,
      interaction: { mode: "request", responseSchema: request.responseSchema },
    });
    const session = {
      canonicalParts: [],
      model: { artifacts: [{ value: artifact }] },
      artifactInteractionStore: { request: undefined },
    } as unknown as ProjectSessionStore;

    act(() =>
      root.render(<ArtifactsPanel session={session} inlineWidgets={{} as InlineWidgetStore} />),
    );
    expect(container.querySelector('[data-artifact-id="branch-request"]')).toBeNull();
  });

  it("renders select fields as radios and shows the submitted answers once", () => {
    const submit = vi.fn();
    const request = {
      protocol: "cake.request/v1" as const,
      id: "optional-select",
      title: "Choose or type",
      responseSchema: {
        type: "object" as const,
        properties: { choice: { type: "string" as const } },
      },
      view: {
        type: "form" as const,
        fields: [
          {
            id: "choice",
            label: "Choice",
            type: "select" as const,
            options: [{ value: "listed", label: "Listed option" }],
          },
        ],
      },
      fallback: { markdown: "Choose or type." },
    };
    const artifact = record({
      protocol: "cake.artifact/v1",
      id: request.id,
      sessionId: "session",
      revision: 1,
      kind: "request",
      payload: { request },
      fallback: request.fallback,
      interaction: { mode: "request", responseSchema: request.responseSchema },
    });

    act(() => root.render(<ArtifactHost record={artifact} requested onSubmit={submit} />));
    const radios = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    const customInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="Choice other option"]',
    )!;
    expect(radios).toHaveLength(2);
    expect(customInput).not.toBeNull();
    expect(container.querySelector("form")).not.toBeNull();
    act(() => {
      radios[0]!.click();
      (container.querySelector("form") as HTMLFormElement).dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    expect(submit).toHaveBeenCalledWith({ choice: "listed" });
    expect((container.querySelector('input[type="radio"]') as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(customInput.disabled).toBe(true);
    expect(container.textContent).toContain("Submitted");
    expect([...container.querySelectorAll("button")].map((b) => b.textContent)).not.toContain(
      "Submit",
    );
  });

  it("always offers a deterministic other option for select fields", () => {
    const submit = vi.fn();
    const request = {
      protocol: "cake.request/v1" as const,
      id: "other-select",
      title: "Choose or type",
      responseSchema: {
        type: "object" as const,
        properties: { choice: { type: "string" as const } },
      },
      view: {
        type: "form" as const,
        fields: [
          {
            id: "choice",
            label: "Choice",
            type: "select" as const,
            options: [
              { value: "a", label: "Option A" },
              { value: "b", label: "Option B" },
            ],
          },
        ],
      },
      fallback: { markdown: "Choose or type." },
    };
    const artifact = record({
      protocol: "cake.artifact/v1",
      id: request.id,
      sessionId: "session",
      revision: 1,
      kind: "request",
      payload: { request },
      fallback: request.fallback,
      interaction: { mode: "request", responseSchema: request.responseSchema },
    });

    act(() => root.render(<ArtifactHost record={artifact} onSubmit={submit} />));
    const customInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="Choice other option"]',
    )!;
    const otherRadio = container.querySelector<HTMLInputElement>(
      'input[type="radio"][aria-label="Other"]',
    )!;
    act(() => otherRadio.click());
    expect(otherRadio.checked).toBe(true);
    expect(document.activeElement).toBe(customInput);
    act(() => {
      setInputValue(customInput, "my own answer");
      customInput.dispatchEvent(new Event("input", { bubbles: true }));
      (container.querySelector("form") as HTMLFormElement).dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    expect(submit).toHaveBeenCalledWith({ choice: "my own answer" });
    expect(otherRadio.checked).toBe(true);
    expect(customInput.value).toBe("my own answer");
  });

  it("renders a custom request in the script sandbox and accepts its token-bound submission", async () => {
    const token = "00000000-0000-4000-8000-000000000001";
    const client = {
      compileInlineWidget: vi.fn(async () => ({ token, url: `cake-widget://document/${token}` })),
      repairInlineWidget: vi.fn(),
    } as unknown as DesktopClient;
    widgets = mount(createStore(InlineWidgetStore, { client }));
    const submit = vi.fn();
    const request = {
      protocol: "cake.request/v1" as const,
      id: "visual",
      title: "Visual choice",
      responseSchema: { type: "object" as const },
      view: {
        type: "widget" as const,
        language: "html" as const,
        source: "<button onclick=\"cakeRequest.submit({choice:'yes'})\">Yes</button>",
      },
      fallback: { markdown: "Choose yes." },
    };
    const artifact = record({
      protocol: "cake.artifact/v1",
      id: request.id,
      sessionId: "session",
      revision: 1,
      kind: "request",
      payload: { request },
      fallback: request.fallback,
      interaction: { mode: "request", responseSchema: request.responseSchema },
    });

    await act(async () => {
      root.render(
        <ArtifactHost record={artifact} requested onSubmit={submit} inlineWidgets={widgets} />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(client.compileInlineWidget).toHaveBeenCalledWith("html", request.view.source, "request");
    const frame = container.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("src")).toBe(`cake-widget://document/${token}`);
    act(() =>
      (container.querySelector(".inline-widget-actions button") as HTMLButtonElement).click(),
    );
    expect(
      container.querySelector('.inline-widget-source [data-streamdown="code-block"]'),
    ).not.toBeNull();
    expect(container.querySelector(".inline-widget-source")?.textContent).toContain(
      "cakeRequest.submit",
    );
    act(() =>
      window.dispatchEvent(
        new MessageEvent("message", {
          source: frame.contentWindow,
          data: { source: "cake-inline-widget", token, type: "submit", value: { choice: "yes" } },
        }),
      ),
    );
    expect(submit).toHaveBeenCalledWith({ choice: "yes" });
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="View Visual choice fullscreen"]')!
        .click(),
    );
    const fullscreenFrame = document.body.querySelector<HTMLIFrameElement>(
      ".fullscreen-surface-canvas iframe",
    )!;
    act(() =>
      window.dispatchEvent(
        new MessageEvent("message", {
          source: fullscreenFrame.contentWindow,
          data: {
            source: "cake-inline-widget",
            token,
            type: "submit",
            value: { choice: "fullscreen" },
          },
        }),
      ),
    );
    expect(submit).toHaveBeenLastCalledWith({ choice: "fullscreen" });
  });

  it("compiles delegated widget artifacts without placing their source in transcript text", async () => {
    const token = "00000000-0000-4000-8000-000000000002";
    const source = "export default () => <strong>Generated</strong>";
    const client = {
      compileInlineWidget: vi.fn(async () => ({ token, url: `cake-widget://document/${token}` })),
      repairInlineWidget: vi.fn(async () => ({ source, repairSessionId: "repair-session" })),
    } as unknown as DesktopClient;
    widgets = mount(createStore(InlineWidgetStore, { client }));
    const artifact = record({
      protocol: "cake.artifact/v1",
      id: "comparison",
      sessionId: "session",
      revision: 1,
      kind: "widget",
      title: "Comparison",
      payload: {
        language: "react",
        source,
        brief: '{"brief":"Compare"}',
        generationSessionId: "generation-1",
      },
      fallback: { markdown: "Comparison fallback." },
      interaction: { mode: "present" },
    });

    await act(async () => {
      root.render(<ArtifactHost record={artifact} inlineWidgets={widgets} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(client.compileInlineWidget).toHaveBeenCalledWith("react", source, "display");
    expect(container.querySelector("iframe")?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(container.textContent).not.toContain("export default");
    const fullscreenButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="View Comparison fullscreen"]',
    )!;
    expect(fullscreenButton.closest(".artifact > header")).not.toBeNull();
    expect(fullscreenButton.querySelector("svg")).not.toBeNull();
    expect(
      container.querySelector('.inline-widget-rail [aria-label="View Comparison fullscreen"]'),
    ).toBeNull();
    act(() =>
      (container.querySelector(".inline-widget-actions button") as HTMLButtonElement).click(),
    );
    expect(container.textContent).toContain("export default");
    act(() => fullscreenButton.click());
    const fullscreen = document.body.querySelector<HTMLElement>(".fullscreen-surface-canvas");
    const fullscreenFrame = fullscreen?.querySelector<HTMLIFrameElement>("iframe");
    expect(fullscreen?.textContent).toContain("Comparison");
    expect(fullscreenFrame?.getAttribute("src")).toBe(`cake-widget://document/${token}`);
    expect(fullscreenFrame?.getAttribute("sandbox")).toBe("allow-scripts");
    act(() =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(document.body.querySelector(".fullscreen-surface")).toBeNull();

    act(() =>
      (
        container.querySelector(".inline-widget-actions button:last-child") as HTMLButtonElement
      ).click(),
    );
    expect(container.querySelector(".inline-widget-repair-form")).not.toBeNull();
    const repairInput = container.querySelector(
      ".inline-widget-repair-form textarea",
    ) as HTMLTextAreaElement;
    act(() => setTextValue(repairInput, "Make the result easier to scan on a narrow window."));
    await act(async () => {
      (
        container.querySelector(
          ".inline-widget-repair-form button[type='submit']",
        ) as HTMLButtonElement
      ).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(client.repairInlineWidget).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.stringContaining("Make the result easier to scan on a narrow window."),
      }),
    );
  });
});

function setInputValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
}

function setTextValue(input: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
