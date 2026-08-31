/** @vitest-environment jsdom */
import React, { Suspense, act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePluginGlobalState } from "../../../src/renderer/plugin-persistence";
import type { RendererClient } from "../../../src/renderer/client/RendererClient";
import { RendererInfrastructureFixture } from "./renderer-infrastructure";
import { z } from "zod";

describe("plugin persistence hooks", () => {
  const containers: HTMLDivElement[] = [];
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  });
  afterEach(() => {
    for (const container of containers.splice(0)) container.remove();
  });

  it("hydrates through Suspense before dependent effects run", async () => {
    let resolveLoad!: (value: unknown) => void;
    const request = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveLoad = resolve;
        }),
    );
    const effect = vi.fn();
    function Probe() {
      const [value] = usePluginGlobalState("test.persistence", "hydration", z.string(), "default");
      useEffect(() => effect(value), [value]);
      return <span>{value}</span>;
    }
    const container = document.createElement("div");
    containers.push(container);
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() =>
      root.render(
        <RendererInfrastructureFixture
          pluginInvoke={request as RendererClient["plugins"]["invoke"]}
        >
          <Suspense fallback={<i>loading</i>}>
            <Probe />
          </Suspense>
        </RendererInfrastructureFixture>,
      ),
    );
    expect(container.textContent).toBe("loading");
    expect(effect).not.toHaveBeenCalled();

    await act(async () =>
      resolveLoad({
        type: "plugin-state",
        record: {
          schemaVersion: 1,
          pluginId: "test.persistence",
          key: "hydration",
          scope: { kind: "global" },
          value: "stored",
          version: 3,
          updatedAt: new Date(0).toISOString(),
        },
      }),
    );

    expect(container.textContent).toBe("stored");
    expect(effect).toHaveBeenCalledWith("stored");
    act(() => root.unmount());
  });
});
