/** @vitest-environment jsdom */
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../../../src/renderer/client/Client";
import type { CakeArtifactV1 } from "../../../src/contracts/artifacts/artifact-contract";
import { decodeArtifactLineageId } from "../../../src/contracts/artifacts/artifact-lineage";
import { artifactBase as base, renderArtifactHost } from "./artifact-host-rendering-fixture";

let restoreSvgMeasurement: () => void;
beforeEach(() => {
  // jsdom adapter; native iframe retention is verified in Electron.
  Object.defineProperty(Element.prototype, "moveBefore", {
    configurable: true,
    value(this: Element, node: Node, child: Node | null) {
      this.insertBefore(node, child);
    },
  });
  // Browser API adapter only: no Mermaid/parser replacement and no geometry
  // assertions. SVG layout and iframe sandbox enforcement require Electron.
  const original = Object.getOwnPropertyDescriptor(SVGElement.prototype, "getBBox");
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => new DOMRect(0, 0, 100, 30),
  });
  restoreSvgMeasurement = () => {
    if (original) Object.defineProperty(SVGElement.prototype, "getBBox", original);
    else Reflect.deleteProperty(SVGElement.prototype, "getBBox");
  };
});
afterEach(() => {
  cleanup();
  restoreSvgMeasurement();
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
  it("renders actual Mermaid into an isolated themed document and rerenders when theme changes", async () => {
    document.documentElement.dataset.theme = "light";
    using fixture = renderArtifactHost({
      ...base,
      id: "diagram",
      kind: "diagram",
      title: "Flow",
      payload: { source: "graph LR\nA[Start] --> B[Finish]" },
    });
    await waitFor(() => expect(fixture.container.querySelector("iframe")).not.toBeNull());
    const frame = fixture.container.querySelector("iframe")!;
    const light = documentIn(frame);
    expect(light.querySelector("svg")).not.toBeNull();
    expect(light.body.textContent).toContain("Start");
    expect(light.body.textContent).toContain("Finish");
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(
      light.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content"),
    ).toContain("default-src 'none'");
    expect(light.querySelector("script, [onclick]")).toBeNull();
    expect(light.head.textContent).toContain("color-scheme:light");
    expect(light.querySelector("svg style")?.textContent).toContain("fill:#eee");
    await act(async () => {
      document.documentElement.dataset.theme = "dark";
    });
    await waitFor(() =>
      expect(fixture.container.querySelector("iframe")?.getAttribute("srcdoc")).toContain(
        "color-scheme:dark",
      ),
    );
    const dark = documentIn(fixture.container.querySelector("iframe")!);
    expect(dark.querySelector("svg style")?.textContent).toContain("fill:#1f2020");
  });

  it("reports real Mermaid parse errors and recovers for a corrected artifact revision", async () => {
    using fixture = renderArtifactHost({
      ...base,
      kind: "diagram",
      payload: { source: "this is not a diagram" },
    });
    expect(await screen.findByText("Diagram could not render")).toBeDefined();
    expect(fixture.container.querySelector("iframe")).toBeNull();
    await fixture.update({
      ...base,
      revision: 2,
      kind: "diagram",
      payload: { source: "graph TD\nA[Recovered] --> B[Done]" },
    });
    await waitFor(() => expect(fixture.container.querySelector("iframe")).not.toBeNull());
    expect(screen.queryByText("Diagram could not render")).toBeNull();
    expect(documentIn(fixture.container.querySelector("iframe")!).body.textContent).toContain(
      "Recovered",
    );
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

  it("places authored HTML behind an empty sandbox, no-referrer policy and deny-by-default CSP", () => {
    using fixture = renderArtifactHost({
      ...base,
      kind: "html",
      payload: { html: "<script>parent.document.body.textContent='owned'</script>" },
    });
    const frame = fixture.container.querySelector("iframe")!;
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
  });

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
