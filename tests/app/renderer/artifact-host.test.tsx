/** @vitest-environment jsdom */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "r-state-tree";
import mermaid from "mermaid";

vi.mock("mermaid", () => ({
  default: { initialize: vi.fn(), render: vi.fn(async () => ({ svg: "<svg role='img'></svg>" })) },
}));
import { ArtifactHost } from "../../../src/renderer/components/artifact-host";
import { BlockingArtifactRequest } from "../../../src/renderer/components/blocking-artifact-request";
import type { ArtifactRecord } from "../../../src/ipc/artifact-contract";
import type { Client } from "../../../src/renderer/client/Client";
import { InlineWidgetStore } from "../../../src/renderer/stores/InlineWidgetStore";
import type { ProjectSessionStore } from "../../../src/renderer/stores/ProjectSessionStore";
import { ArtifactInteractionStore } from "../../../src/renderer/stores/ArtifactInteractionStore";
import { SessionOperationCoordinatorStore } from "../../../src/renderer/stores/SessionOperationCoordinatorStore";
import { TranscriptPart } from "../../../src/renderer/components/chat-transcript-part";
import type { CanonicalTranscriptBehavior } from "../../../src/renderer/components/chat-message";
import { FullscreenSurfaceFixture } from "./fullscreen-surface-fixture";
import { mountWithClient } from "./mount-with-client";

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
  let widgetRoot: Disposable | undefined;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    widgetRoot?.[Symbol.dispose]();
    widgetRoot = undefined;
    widgets = undefined;
    container.remove();
  });

  it("loads Mermaid only when rendering a diagram artifact", async () => {
    const artifact = record({
      protocol: "cake.artifact/v1",
      id: "diagram",
      sessionId: "session",
      revision: 1,
      kind: "diagram",
      payload: { source: "graph LR\nA --> B" },
      fallback: { markdown: "A diagram" },
      interaction: { mode: "present" },
    });

    act(() => root.render(<ArtifactHost record={artifact} />));
    expect(container.textContent).toContain("Rendering diagram");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mermaid.render).toHaveBeenCalledOnce();
    expect(container.querySelector("iframe")).not.toBeNull();
    expect(mermaid.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ securityLevel: "strict" }),
    );
    expect(mermaid.render).toHaveBeenCalledWith(
      expect.stringContaining("cake-diagram-diagram"),
      "graph LR\nA --> B",
    );
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

  it("renders an unlinked blocking request once and yields when its transcript pointer arrives", () => {
    const request = {
      protocol: "cake.request/v1" as const,
      id: "moving-request",
      title: "Moving request",
      view: { type: "confirmation" as const, message: "Continue?" },
      fallback: { markdown: "Continue?" },
    };
    const artifact = record({
      protocol: "cake.artifact/v1",
      id: request.id,
      sessionId: "session",
      revision: 1,
      kind: "request",
      payload: { request },
      fallback: request.fallback,
      interaction: { mode: "request" },
    });
    const canonicalParts: Array<{ kind: "tool"; artifactId: string }> = [];
    const session = {
      canonicalParts,
      artifactInteractionStore: {
        request: { record: artifact },
        submittedAnswer: () => undefined,
        answer: vi.fn(),
        respond: vi.fn(),
      },
    } as unknown as ProjectSessionStore;

    act(() =>
      root.render(
        <BlockingArtifactRequest session={session} inlineWidgets={{} as InlineWidgetStore} />,
      ),
    );
    expect(container.querySelectorAll('[data-artifact-id="moving-request"]')).toHaveLength(1);

    canonicalParts.push({ kind: "tool", artifactId: "moving-request" });
    act(() =>
      root.render(
        <BlockingArtifactRequest session={session} inlineWidgets={{} as InlineWidgetStore} />,
      ),
    );
    expect(container.querySelector('[data-artifact-id="moving-request"]')).toBeNull();
  });

  it("renders a tool-linked interview request in its transcript part and resolves it", async () => {
    const request = {
      protocol: "cake.request/v1" as const,
      id: "linked-interview",
      title: "Linked interview",
      responseSchema: {
        type: "object" as const,
        properties: { region: { type: "string" as const } },
      },
      view: {
        type: "form" as const,
        fields: [
          {
            id: "region",
            label: "Region",
            type: "select" as const,
            options: [{ value: "us-east-1", label: "US East" }],
          },
        ],
      },
      fallback: { markdown: "Choose a region." },
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
    const respond = vi.fn(async () => ({ artifactRequestId: "artifact-request" }));
    const { root: storeRoot, subject: interaction } = mountWithClient(
      createStore(ArtifactInteractionStore, {
        sessionContext: () => ({ sessionId: "session" }),
        operations: createStore(SessionOperationCoordinatorStore, {}),
        operationOwner: "test",
        isStreaming: () => true,
      }),
      { artifacts: { respond } } as unknown as Client,
    );
    const behavior = {
      store: {},
      renderChat: () => null,
      artifacts: { records: [], interaction },
    } as unknown as CanonicalTranscriptBehavior;
    const part = {
      id: "tool-call",
      kind: "tool" as const,
      name: "cake",
      command: "interview.open",
      input: "",
      artifactId: request.id,
      state: "running" as const,
    };
    const render = () => root.render(<TranscriptPart part={part} behavior={behavior} />);

    // Request artifacts are never in the session catalog, so the linked tool
    // part must render from the live request itself.
    act(() =>
      interaction.receive({
        type: "artifact-requested",
        operationId: "operation",
        artifactRequestId: "artifact-request",
        record: artifact,
      }),
    );
    act(render);
    const form = container.querySelector<HTMLFormElement>(
      '[data-artifact-id="linked-interview"] form',
    );
    expect(form).not.toBeNull();
    await act(async () => {
      form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactRequestId: "artifact-request",
        value: { region: "us-east-1" },
      }),
    );
    expect(interaction.request).toBeUndefined();
    act(render);
    expect(container.querySelector('[data-artifact-id="linked-interview"]')?.textContent).toContain(
      "Submitted",
    );
    storeRoot[Symbol.dispose]();
  });

  it("steps through a multi-question interview and submits only from the user's submit", () => {
    const submit = vi.fn();
    const request = {
      protocol: "cake.request/v1" as const,
      id: "stepped",
      title: "Stepped interview",
      responseSchema: { type: "object" as const },
      view: {
        type: "form" as const,
        fields: [
          {
            id: "region",
            label: "Region",
            type: "select" as const,
            options: [
              { value: "us", label: "US" },
              { value: "eu", label: "EU" },
            ],
          },
          { id: "name", label: "Name", type: "text" as const },
          { id: "notes", label: "Notes", type: "text" as const },
        ],
      },
      fallback: { markdown: "Answer three questions." },
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
    const button = (name: string) =>
      [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (candidate) => candidate.textContent === name,
      );
    const form = () => container.querySelector<HTMLFormElement>("form")!;
    const pressEnter = () =>
      act(() => form().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));

    expect(container.textContent).toContain("Question 1 of 3");
    expect(container.querySelector('[role="radiogroup"][aria-label="Region"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Name");
    act(() => container.querySelector<HTMLInputElement>('input[value="eu"]')!.click());
    // Enter advances rather than sending the interview.
    pressEnter();
    expect(submit).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Question 2 of 3");
    const name = container.querySelector<HTMLInputElement>('input[type="text"]')!;
    act(() => {
      setInputValue(name, "Ada");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => button("Back")!.click());
    expect(container.querySelector<HTMLInputElement>('input[value="eu"]')!.checked).toBe(true);
    act(() => button("Next")!.click());
    act(() => button("Next")!.click());
    expect(container.querySelector<HTMLInputElement>('input[type="text"]')!.value).toBe("");
    expect(button("Review")).toBeDefined();
    act(() => button("Review")!.click());

    expect(container.textContent).toContain("Review answers");
    const answers = container.querySelector('dl[aria-label="Answers"]')!.textContent;
    expect(answers).toContain("EU");
    expect(answers).toContain("Ada");
    expect(answers).toContain("No answer");
    expect(submit).not.toHaveBeenCalled();
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Edit Name"]')!.click());
    expect(container.textContent).toContain("Question 2 of 3");
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Review answers"]')!.click());
    pressEnter();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith({ region: "eu", name: "Ada" });
    // The settled form shows every question for the record.
    expect(container.textContent).toContain("Submitted");
    expect(container.querySelectorAll('input[type="text"]').length).toBeGreaterThanOrEqual(2);
    expect(button("Next")).toBeUndefined();
  });

  it("submits only from the review page, which the progress bar can reach early", () => {
    const submit = vi.fn();
    const request = {
      protocol: "cake.request/v1" as const,
      id: "early",
      title: "Early submit",
      responseSchema: { type: "object" as const },
      view: {
        type: "form" as const,
        fields: [
          { id: "first", label: "First", type: "text" as const },
          { id: "second", label: "Second", type: "text" as const },
        ],
      },
      fallback: { markdown: "Two questions." },
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
    const input = container.querySelector<HTMLInputElement>('input[type="text"]')!;
    act(() => {
      setInputValue(input, "only this");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const submitButton = () =>
      [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (candidate) => candidate.textContent === "Submit",
      );
    expect(submitButton()).toBeUndefined();
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Review answers"]')!.click());
    expect(container.textContent).toContain("Review answers");
    act(() => submitButton()!.click());
    expect(submit).toHaveBeenCalledWith({ first: "only this" });
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

    act(() =>
      root.render(
        <FullscreenSurfaceFixture>
          <ArtifactHost record={artifact} requested onSubmit={submit} />
        </FullscreenSurfaceFixture>,
      ),
    );
    const radios = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    const customInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="Choice other option"]',
    )!;
    expect(radios).toHaveLength(2);
    expect(radios[0]!.checked).toBe(true);
    expect(customInput).not.toBeNull();
    expect(container.querySelector("form")).not.toBeNull();
    act(() =>
      (container.querySelector("form") as HTMLFormElement).dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      ),
    );
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
              { value: "other", label: "Other" },
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
    expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(3);
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
      compile: vi.fn(async () => ({ token, url: `cake-widget://document/${token}` })),
      repair: vi.fn(),
    } as unknown as Client["inlineWidgets"];
    ({ root: widgetRoot, subject: widgets } = mountWithClient(createStore(InlineWidgetStore), {
      inlineWidgets: client,
    } as unknown as Client));
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
        <FullscreenSurfaceFixture>
          <ArtifactHost record={artifact} requested onSubmit={submit} inlineWidgets={widgets} />
        </FullscreenSurfaceFixture>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(client.compile).toHaveBeenCalledWith("html", request.view.source, "request");
    const frame = container.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("src")).toBe(`cake-widget://document/${token}`);
    expect(container.textContent).not.toContain("cakeRequest.submit");
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
    const fullscreenFrame =
      document.body.querySelector<HTMLIFrameElement>('[role="dialog"] iframe')!;
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
      compile: vi.fn(async () => ({ token, url: `cake-widget://document/${token}` })),
    } as unknown as Client["inlineWidgets"];
    ({ root: widgetRoot, subject: widgets } = mountWithClient(createStore(InlineWidgetStore), {
      inlineWidgets: client,
    } as unknown as Client));
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
      root.render(
        <FullscreenSurfaceFixture>
          <ArtifactHost record={artifact} inlineWidgets={widgets} />
        </FullscreenSurfaceFixture>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(client.compile).toHaveBeenCalledWith("react", source, "display");
    const frame = container.querySelector<HTMLIFrameElement>("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(container.textContent).not.toContain("export default");
    const fullscreenButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="View Comparison fullscreen"]',
    )!;
    expect(fullscreenButton.closest("header")).toBeNull();
    expect(fullscreenButton.querySelector("svg")).not.toBeNull();
    expect(container.textContent).not.toContain("Source");
    expect(container.textContent).not.toContain("Repair");
    expect(container.textContent).not.toContain("Readable fallback");
    act(() => fullscreenButton.click());
    const fullscreen = document.body.querySelector<HTMLElement>('[role="dialog"]');
    const fullscreenFrame = fullscreen?.querySelector<HTMLIFrameElement>("iframe");
    expect(fullscreen?.textContent).toContain("Comparison");
    expect(fullscreenFrame?.getAttribute("src")).toBe(`cake-widget://document/${token}`);
    expect(fullscreenFrame?.getAttribute("sandbox")).toBe("allow-scripts");
    act(() =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();

    act(() =>
      window.dispatchEvent(
        new MessageEvent("message", {
          source: frame.contentWindow,
          data: { source: "cake-inline-widget", token, type: "error", value: "boom" },
        }),
      ),
    );
    expect(container.textContent).toContain("Comparison fallback.");
    expect(container.textContent).not.toContain("boom");
  });

  it("renders an imported Markdown file as its readable document", () => {
    const artifact = record({
      protocol: "cake.artifact/v1",
      id: "imported-notes",
      sessionId: "session",
      revision: 1,
      kind: "file",
      title: "Imported notes",
      payload: {
        name: "notes.md",
        mimeType: "text/markdown",
        data: btoa("# Imported notes\n\nReadable content."),
        byteSize: 35,
      },
      fallback: { markdown: "Imported notes file." },
      interaction: { mode: "present" },
    });

    act(() => root.render(<ArtifactHost record={artifact} />));

    expect(container.textContent).toContain("Imported notes");
    expect(container.textContent).toContain("Readable content.");
    expect(container.textContent).not.toContain("Readable fallback");
  });

  it("offers fullscreen for non-widget artifacts", () => {
    const artifact = record({
      protocol: "cake.artifact/v1",
      id: "notes",
      sessionId: "session",
      revision: 1,
      kind: "markdown",
      title: "Release notes",
      payload: { markdown: "# Shipped" },
      fallback: { markdown: "Shipped" },
      interaction: { mode: "present" },
    });

    act(() =>
      root.render(
        <FullscreenSurfaceFixture>
          <ArtifactHost record={artifact} />
        </FullscreenSurfaceFixture>,
      ),
    );
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="View Release notes fullscreen"]')!
        .click(),
    );
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain("Shipped");
  });
});

function setInputValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
}
