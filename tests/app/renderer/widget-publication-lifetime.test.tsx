/** @vitest-environment jsdom */
import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CakeArtifactV1 } from "../../../src/contracts/artifacts/artifact-contract";
import type { CompiledInlineWidget } from "../../../src/contracts/widgets/inline-widget-contract";
import { WidgetArtifact } from "../../../src/renderer/components/widget-artifact";
import { createRendererStoreFixture } from "./renderer-store-fixture";

const artifact = (revision = 1): Extract<CakeArtifactV1, { kind: "widget" }> => ({
  protocol: "cake.artifact/v1",
  id: "widget",
  sessionId: "session",
  revision,
  kind: "widget",
  title: "Mounted widget",
  payload: {
    language: "html",
    source: "<h1>Widget</h1>",
    browser: { digest: String(revision).repeat(64) },
    brief: "Fixture",
    generationSessionId: "generation",
  },
  fallback: { markdown: "Widget fallback" },
  interaction: { mode: "present" },
});
const publication = (sequence: number): CompiledInlineWidget => {
  const token = `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
  return { token, url: `cake-widget://document/${token}` };
};

describe("mounted widget publication lifetime", () => {
  it("releases a pending result after the Store tree and its Context have been disposed", async () => {
    let complete: ((value: CompiledInlineWidget) => void) | undefined;
    const open = vi.fn(
      () =>
        new Promise<CompiledInlineWidget>((resolve) => {
          complete = resolve;
        }),
    );
    const release = vi.fn(async () => {});
    const fixture = createRendererStoreFixture({ client: { inlineWidgets: { open, release } } });
    const view = render(
      <WidgetArtifact artifact={artifact()} inlineWidgets={fixture.root.inlineWidgetStore} />,
    );
    await waitFor(() => expect(open).toHaveBeenCalledOnce());
    view.unmount();
    fixture[Symbol.dispose]();
    const late = publication(99);
    await act(async () => {
      complete?.(late);
    });
    expect(release).toHaveBeenCalledExactlyOnceWith(late.token);
  });

  it("repeated mount/unmount bounds retained capabilities and one mount's release preserves another", async () => {
    const retained = new Set<string>();
    let sequence = 0;
    const open = vi.fn(async () => {
      const value = publication(++sequence);
      retained.add(value.token);
      return value;
    });
    const release = vi.fn(async (token: string) => {
      retained.delete(token);
    });
    using fixture = createRendererStoreFixture({ client: { inlineWidgets: { open, release } } });
    for (let iteration = 0; iteration < 5; iteration++) {
      const view = render(
        <>
          <WidgetArtifact
            key="first"
            artifact={artifact()}
            inlineWidgets={fixture.root.inlineWidgetStore}
          />
          <WidgetArtifact
            key="second"
            artifact={artifact()}
            inlineWidgets={fixture.root.inlineWidgetStore}
          />
        </>,
      );
      try {
        await waitFor(() => expect(view.container.querySelectorAll("iframe")).toHaveLength(2));
        expect(retained.size).toBe(2);
        const survivor = view.container.querySelectorAll("iframe")[1]?.getAttribute("src");
        view.rerender(
          <WidgetArtifact
            key="second"
            artifact={artifact()}
            inlineWidgets={fixture.root.inlineWidgetStore}
          />,
        );
        await waitFor(() => expect(retained.size).toBe(1));
        expect(view.container.querySelector("iframe")?.getAttribute("src")).toBe(survivor);
      } finally {
        view.unmount();
      }
      await waitFor(() => expect(retained.size).toBe(0));
    }
    expect(open).toHaveBeenCalledTimes(10);
    expect(release).toHaveBeenCalledTimes(10);
  });

  it("releases replacement and late unmounted results without revoking the current revision", async () => {
    const old = publication(1);
    const current = publication(2);
    const late = publication(3);
    let finishOld: ((value: CompiledInlineWidget) => void) | undefined;
    let finishLate: ((value: CompiledInlineWidget) => void) | undefined;
    const open = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<CompiledInlineWidget>((resolve) => {
            finishOld = resolve;
          }),
      )
      .mockResolvedValueOnce(current)
      .mockImplementationOnce(
        () =>
          new Promise<CompiledInlineWidget>((resolve) => {
            finishLate = resolve;
          }),
      );
    const release = vi.fn(async () => {});
    using fixture = createRendererStoreFixture({ client: { inlineWidgets: { open, release } } });
    const view = render(
      <WidgetArtifact artifact={artifact()} inlineWidgets={fixture.root.inlineWidgetStore} />,
    );
    try {
      await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
      view.rerender(
        <WidgetArtifact artifact={artifact(2)} inlineWidgets={fixture.root.inlineWidgetStore} />,
      );
      await waitFor(() =>
        expect(view.container.querySelector("iframe")?.getAttribute("src")).toContain(
          current.token,
        ),
      );
      await act(async () => {
        finishOld?.(old);
      });
      expect(release).toHaveBeenCalledWith(old.token);
      expect(release).not.toHaveBeenCalledWith(current.token);
      expect(view.container.querySelector("iframe")?.getAttribute("src")).toContain(current.token);
      view.rerender(
        <WidgetArtifact artifact={artifact(3)} inlineWidgets={fixture.root.inlineWidgetStore} />,
      );
      await waitFor(() => expect(open).toHaveBeenCalledTimes(3));
      expect(release).toHaveBeenCalledWith(current.token);
    } finally {
      view.unmount();
    }
    await act(async () => {
      finishLate?.(late);
    });
    expect(release).toHaveBeenCalledWith(late.token);
    expect(release).toHaveBeenCalledTimes(3);
  });
});
