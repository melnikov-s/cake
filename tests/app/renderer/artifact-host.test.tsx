/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import mermaid from "mermaid";
import type {
  ArtifactRecord,
  CakeArtifactV1,
} from "../../../src/contracts/artifacts/artifact-contract";
import { ArtifactHost } from "../../../src/renderer/components/artifact-host";
import { FullscreenSurfaceFixture } from "./fullscreen-surface-fixture";
import { createRendererStoreFixture } from "./renderer-store-fixture";

vi.mock("mermaid", () => ({
  default: { initialize: vi.fn(), render: vi.fn(async () => ({ svg: "<svg role='img'></svg>" })) },
}));

function record(artifact: CakeArtifactV1): ArtifactRecord {
  return {
    artifact,
    workspacePath: "/project",
    digest: "a".repeat(64),
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}
const base = {
  protocol: "cake.artifact/v1" as const,
  id: "artifact",
  sessionId: "session",
  revision: 1,
  fallback: { markdown: "Readable fallback" },
  interaction: { mode: "present" as const },
};
afterEach(cleanup);

describe("ArtifactHost", () => {
  it("loads Mermaid only when rendering a diagram artifact", async () => {
    const { container } = render(
      <ArtifactHost
        record={record({
          ...base,
          id: "diagram",
          kind: "diagram",
          payload: { source: "graph LR\nA --> B" },
        })}
      />,
    );
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    expect(mermaid.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ securityLevel: "strict" }),
    );
    expect(mermaid.render).toHaveBeenCalledWith(
      expect.stringContaining("cake-diagram-diagram"),
      "graph LR\nA --> B",
    );
  });

  it("sorts and filters table rows", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ArtifactHost
        record={record({
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
        })}
      />,
    );
    expect([...container.querySelectorAll("tbody td")].map((cell) => cell.textContent)).toEqual([
      "2",
      "1",
    ]);
    await user.click(container.querySelector("th button")!);
    expect([...container.querySelectorAll("tbody td")].map((cell) => cell.textContent)).toEqual([
      "1",
      "2",
    ]);
    await user.type(screen.getByRole("textbox", { name: "Filter table" }), "2");
    expect(container.querySelectorAll("tbody tr")).toHaveLength(1);
  });

  it("isolates raw HTML", () => {
    const { container } = render(
      <ArtifactHost
        record={record({
          ...base,
          kind: "html",
          payload: { html: "<script>parent.document.body.textContent='owned'</script>" },
        })}
      />,
    );
    const frame = container.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("srcdoc")).toContain("default-src 'none'");
    expect(document.body.textContent).not.toContain("owned");
  });

  it("renders an imported Markdown file as its readable document", () => {
    render(
      <ArtifactHost
        record={record({
          ...base,
          kind: "file",
          title: "Imported notes",
          payload: {
            name: "notes.md",
            mimeType: "text/markdown",
            data: btoa("# Imported notes\n\nReadable content."),
            byteSize: 35,
          },
        })}
      />,
    );
    expect(screen.getByText("Readable content.")).toBeDefined();
  });

  it("offers fullscreen for non-widget artifacts", async () => {
    render(
      <FullscreenSurfaceFixture>
        <ArtifactHost
          record={record({
            ...base,
            kind: "markdown",
            title: "Release notes",
            payload: { markdown: "# Shipped" },
          })}
        />
      </FullscreenSurfaceFixture>,
    );
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "View Release notes fullscreen" }));
    expect(screen.getByRole("dialog").textContent).toContain("Shipped");
  });

  it("opens retained widget artifacts and presents fullscreen without exposing their private source", async () => {
    const token = "00000000-0000-4000-8000-000000000002";
    const source = "export default () => <strong>Generated</strong>";
    const open = vi.fn(async () => ({ token, url: `cake-widget://document/${token}` }));
    using fixture = createRendererStoreFixture({ client: { inlineWidgets: { open } } });
    const view = render(
      <FullscreenSurfaceFixture>
        <ArtifactHost
          record={record({
            ...base,
            kind: "widget",
            title: "Comparison",
            payload: {
              language: "react",
              source,
              brief: "Compare",
              generationSessionId: "generation-1",
              browser: { digest: "b".repeat(64) },
            },
          })}
          inlineWidgets={fixture.root.inlineWidgetStore}
        />
      </FullscreenSurfaceFixture>,
    );
    try {
      await waitFor(() => expect(view.container.querySelector("iframe")).not.toBeNull());
      expect(open).toHaveBeenCalledWith({ digest: "b".repeat(64) });
      const frame = view.container.querySelector("iframe")!;
      expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-downloads");
      expect(view.container.textContent).not.toContain(source);
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "View Comparison fullscreen" }));
      expect(screen.getByRole("dialog").querySelector("iframe")?.getAttribute("sandbox")).toBe(
        "allow-scripts allow-downloads",
      );
      await userEvent.setup().keyboard("{Escape}");
      act(() =>
        window.dispatchEvent(
          new MessageEvent("message", {
            source: frame.contentWindow,
            data: { source: "cake-inline-widget", token, type: "error", value: "boom" },
          }),
        ),
      );
      expect(view.container.textContent).toContain("Readable fallback");
    } finally {
      view.unmount();
    }
  });

  it("reopens a mounted widget after backend reconnect and ignores an old completion", async () => {
    const firstToken = "00000000-0000-4000-8000-000000000003";
    const nextToken = "00000000-0000-4000-8000-000000000004";
    let finishOld!: (value: { token: string; url: string }) => void;
    const open = vi
      .fn()
      .mockResolvedValueOnce({ token: firstToken, url: `cake-widget://document/${firstToken}` })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOld = resolve;
          }),
      )
      .mockResolvedValueOnce({ token: nextToken, url: `cake-widget://document/${nextToken}` });
    using fixture = createRendererStoreFixture({ client: { inlineWidgets: { open } } });
    const widgets = fixture.root.inlineWidgetStore;
    const view = render(
      <ArtifactHost
        record={record({
          ...base,
          kind: "widget",
          payload: {
            language: "html",
            source: "<p>Still here</p>",
            brief: "Test",
            generationSessionId: "generation",
            browser: { digest: "b".repeat(64) },
          },
        })}
        inlineWidgets={widgets}
      />,
    );
    try {
      await waitFor(() =>
        expect(view.container.querySelector("iframe")?.getAttribute("src")).toContain(firstToken),
      );
      act(() => widgets.backendReconnected());
      expect(view.container.querySelector("iframe")).toBeNull();
      act(() => widgets.backendReconnected());
      await waitFor(() =>
        expect(view.container.querySelector("iframe")?.getAttribute("src")).toContain(nextToken),
      );
      await act(async () =>
        finishOld({ token: firstToken, url: `cake-widget://document/${firstToken}` }),
      );
      expect(view.container.querySelector("iframe")?.getAttribute("src")).toContain(nextToken);
      expect(open).toHaveBeenCalledTimes(3);
    } finally {
      view.unmount();
    }
  });
});
