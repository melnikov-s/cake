/** @vitest-environment jsdom */
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../../../src/renderer/client/Client";
import type { CakeArtifactV1 } from "../../../src/contracts/artifacts/artifact-contract";
import { decodeArtifactLineageId } from "../../../src/contracts/artifacts/artifact-lineage";
import { artifactBase as base, renderArtifactHost } from "./artifact-host-rendering-fixture";

import { DiagramTestWorker, installDiagramMeasurement } from "./diagram-browser-fixture";
beforeEach(() => {
  // jsdom adapter; native iframe retention is verified in Electron.
  Object.defineProperty(Element.prototype, "moveBefore", {
    configurable: true,
    value(this: Element, node: Node, child: Node | null) {
      this.insertBefore(node, child);
    },
  });
  installDiagramMeasurement();
  vi.stubGlobal("Worker", DiagramTestWorker);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
  vi.restoreAllMocks();
});

function documentIn(frame: HTMLIFrameElement) {
  return new DOMParser().parseFromString(frame.getAttribute("srcdoc")!, "text/html");
}

function widget(source: string, language: "html" | "react" = "react"): CakeArtifactV1 {
  return {
    ...base,
    kind: "widget",
    title: "Comparison",
    payload: {
      language,
      source,
      brief: "Compare",
      generationSessionId: "generation-1",
      browser: { digest: "b".repeat(64) },
    },
  };
}

function postWidgetMessage(
  frame: HTMLIFrameElement,
  token: string,
  value: string,
  source = frame.contentWindow,
) {
  act(() =>
    window.dispatchEvent(
      new MessageEvent("message", {
        source,
        data: { source: "cake-inline-widget", token, type: "error", value },
      }),
    ),
  );
}

describe("ArtifactHost rendering integration", () => {
  it("renders real Pele SVG with live theme variables through the shared Markdown path", async () => {
    document.documentElement.dataset.theme = "light";
    using fixture = renderArtifactHost({
      ...base,
      id: "diagram",
      kind: "diagram",
      title: "Flow",
      payload: { source: "graph LR\nA[Start] --> B[Finish]" },
    });
    await waitFor(() => expect(fixture.container.querySelector("svg.pele")).not.toBeNull());
    const svg = fixture.container.querySelector("svg.pele")!;
    expect(svg.textContent).toContain("Start");
    expect(svg.textContent).toContain("Finish");
    expect(svg.getAttribute("style")).toContain("var(--pele-fg");
    expect(svg.querySelector("script, image, foreignObject, [onclick]")).toBeNull();
    await act(async () => {
      document.documentElement.dataset.theme = "dark";
    });
    expect(fixture.container.querySelector("svg.pele")).toBe(svg);
    expect(screen.getAllByRole("button", { name: /View .*fullscreen/ })).toHaveLength(1);
    const copy = vi.spyOn(navigator.clipboard, "writeText");
    await fixture.user.click(screen.getByRole("button", { name: "Copy Code" }));
    expect(copy).toHaveBeenCalledWith("graph LR\nA[Start] --> B[Finish]\n");
    await fixture.user.click(screen.getByRole("button", { name: "View diagram fullscreen" }));
    const fullscreen = screen.getByRole("dialog", { name: "Diagram" });
    await waitFor(() =>
      expect(fullscreen.querySelector("svg.pele")?.textContent).toContain("Finish"),
    );
  });

  it("reports real Pele parse errors and recovers for a corrected artifact revision", async () => {
    using fixture = renderArtifactHost({
      ...base,
      kind: "diagram",
      payload: { source: "this is not a diagram" },
    });
    expect(await screen.findByText("Diagram could not render")).toBeDefined();
    await fixture.update({
      ...base,
      revision: 2,
      kind: "diagram",
      payload: { source: "graph TD\nA[Recovered] --> B[Done]" },
    });
    await waitFor(() =>
      expect(fixture.container.querySelector("svg.pele")?.textContent).toContain("Recovered"),
    );
    expect(screen.queryByText("Diagram could not render")).toBeNull();
  });

  it("sorts in both directions and filters rendered table rows", async () => {
    using fixture = renderArtifactHost({
      ...base,
      kind: "table",
      payload: {
        columns: [{ id: "score", label: "Score", type: "number" }],
        rows: [
          { id: "a", score: 2 },
          { id: "b", score: 1 },
        ],
        selectable: false,
      },
    });
    const cells = () =>
      Array.from(fixture.container.querySelectorAll("tbody td"), (cell) => cell.textContent);
    expect(cells()).toEqual(["2", "1"]);
    await fixture.user.click(screen.getByRole("button", { name: "Score" }));
    expect(cells()).toEqual(["1", "2"]);
    await fixture.user.click(screen.getByRole("button", { name: "Score ↑" }));
    expect(cells()).toEqual(["2", "1"]);
    await fixture.user.type(screen.getByRole("textbox", { name: "Filter table" }), "2");
    expect(cells()).toEqual(["2"]);
    await fixture.user.clear(screen.getByRole("textbox", { name: "Filter table" }));
    expect(cells()).toEqual(["2", "1"]);
  });

  it.each([undefined, 120, 360])(
    "places authored HTML at height %s behind an empty sandbox and deny-by-default CSP",
    (height) => {
      using fixture = renderArtifactHost({
        ...base,
        kind: "html",
        payload: {
          html: "<script>parent.document.body.textContent='owned'</script>",
          ...(height === undefined ? null : { height }),
        },
      });
      const frame = fixture.container.querySelector("iframe")!;
      expect(frame.style.height).toBe(`${height ?? 240}px`);
      expect(frame.getAttribute("sandbox")).toBe("");
      expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
      const policy = documentIn(frame)
        .querySelector('meta[http-equiv="Content-Security-Policy"]')
        ?.getAttribute("content");
      expect(policy).toContain("default-src 'none'");
      expect(policy).toContain("form-action 'none'");
      expect(policy).toContain("base-uri 'none'");
      // Asserts document construction only, not jsdom enforcement of a sandbox.
      expect(document.body.textContent).not.toContain("owned");
    },
  );

  it("renders an imported Markdown file as a readable document", () => {
    using fixture = renderArtifactHost({
      ...base,
      kind: "file",
      title: "Imported notes",
      payload: {
        name: "notes.md",
        mimeType: "text/markdown",
        data: btoa("# Imported notes\n\nReadable content."),
        byteSize: 35,
      },
    });
    expect(
      within(fixture.container).getByRole("heading", { name: "Imported notes" }),
    ).toBeDefined();
    expect(screen.getByText("Readable content.")).toBeDefined();
  });

  it("opens the real fullscreen surface for a document artifact", async () => {
    using fixture = renderArtifactHost({
      ...base,
      kind: "markdown",
      title: "Release notes",
      payload: { markdown: "# Shipped" },
    });
    await fixture.user.click(screen.getByRole("button", { name: "View Release notes fullscreen" }));
    const fullscreen = screen.getByRole("dialog", { name: "Release notes" });
    expect(within(fullscreen).getByRole("heading", { name: "Shipped" })).toBeDefined();
    await fixture.user.click(
      within(fullscreen).getByRole("button", { name: "Exit fullscreen Release notes" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens widgets through the typed service and accepts runtime errors only from their own frame and token", async () => {
    const token = "00000000-0000-4000-8000-000000000002";
    const source = "export default () => <strong>Generated</strong>";
    const open = vi.fn<Client["inlineWidgets"]["open"]>(async () => ({
      token,
      url: `cake-widget://document/${token}`,
    }));
    const stateRead = vi.fn<Client["artifacts"]["stateRead"]>(async () => ({
      lineageId: decodeArtifactLineageId(base.id),
      version: 7,
      value: { scene: "user edits" },
    }));
    const stateReplace = vi.fn<Client["artifacts"]["stateReplace"]>();
    using fixture = renderArtifactHost(widget(source), {
      inlineWidgets: { open },
      artifacts: { stateRead, stateReplace },
    });
    await waitFor(() => expect(fixture.container.querySelector("iframe")).not.toBeNull());
    expect(open).toHaveBeenCalledExactlyOnceWith({ digest: "b".repeat(64) });
    const frame = fixture.container.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-downloads");
    expect(fixture.container.textContent).not.toContain(source);
    const surface = frame.parentElement!.parentElement!.parentElement!;
    expect(surface.style.height).toBe("600px");
    screen.getByRole("separator", { name: "Resize Comparison" }).focus();
    await fixture.user.keyboard("{ArrowDown}{ArrowDown}");
    expect(surface.style.height).toBe("632px");
    await fixture.user.keyboard("{Home}");
    expect(surface.style.height).toBe("240px");
    await fixture.user.keyboard("{End}");
    expect(surface.style.height).toBe("1200px");
    await fixture.user.click(screen.getByRole("button", { name: "View Comparison fullscreen" }));
    const fullscreen = screen.getByRole("dialog", { name: "Comparison" });
    expect(fullscreen.querySelector("iframe")?.getAttribute("sandbox")).toBe(
      "allow-scripts allow-downloads",
    );
    expect(fullscreen.querySelector("iframe")).toBe(frame);
    await fixture.user.click(
      within(fullscreen).getByRole("button", { name: "Exit fullscreen Comparison" }),
    );
    expect(fixture.container.querySelector("iframe")).toBe(frame);
    expect(surface.style.height).toBe("1200px");
    expect(open).toHaveBeenCalledTimes(1);
    expect(stateRead).toHaveBeenCalledTimes(1);
    expect(stateReplace).not.toHaveBeenCalled();
    postWidgetMessage(frame, token, "Wrong window", window);
    postWidgetMessage(frame, "00000000-0000-4000-8000-000000000099", "Wrong token");
    expect(fixture.container.querySelector("iframe")).toBe(frame);
    postWidgetMessage(frame, token, "boom");
    expect(screen.getByText("Readable fallback")).toBeDefined();
    expect(fixture.container.querySelector("iframe")).toBeNull();
  });

  it("renders readable fallback after a widget compilation failure", async () => {
    const open = vi.fn<Client["inlineWidgets"]["open"]>(async () => {
      throw new Error("Compiler unavailable");
    });
    using fixture = renderArtifactHost(widget("<p>Widget</p>", "html"), {
      inlineWidgets: { open },
    });
    expect(await screen.findByText("Readable fallback")).toBeDefined();
    expect(fixture.container.querySelector("iframe")).toBeNull();
  });

  it("reopens after backend reconnect and ignores an obsolete open completion", async () => {
    const firstToken = "00000000-0000-4000-8000-000000000003";
    const nextToken = "00000000-0000-4000-8000-000000000004";
    type Compiled = Awaited<ReturnType<Client["inlineWidgets"]["open"]>>;
    let finishOld!: (value: Compiled) => void;
    const open = vi
      .fn<Client["inlineWidgets"]["open"]>()
      .mockResolvedValueOnce({ token: firstToken, url: `cake-widget://document/${firstToken}` })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOld = resolve;
          }),
      )
      .mockResolvedValueOnce({ token: nextToken, url: `cake-widget://document/${nextToken}` });
    using fixture = renderArtifactHost(widget("<p>Still here</p>", "html"), {
      inlineWidgets: { open },
    });
    await waitFor(() =>
      expect(fixture.container.querySelector("iframe")?.getAttribute("src")).toContain(firstToken),
    );
    fixture.publishBackendReconnect();
    expect(fixture.container.querySelector("iframe")).toBeNull();
    fixture.publishBackendReconnect();
    await waitFor(() =>
      expect(fixture.container.querySelector("iframe")?.getAttribute("src")).toContain(nextToken),
    );
    await act(async () =>
      finishOld({ token: firstToken, url: `cake-widget://document/${firstToken}` }),
    );
    expect(fixture.container.querySelector("iframe")?.getAttribute("src")).toContain(nextToken);
    expect(open).toHaveBeenCalledTimes(3);
  });
});
