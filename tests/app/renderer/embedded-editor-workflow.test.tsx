/** @vitest-environment jsdom */
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../../../src/renderer/client/Client";
import {
  deferredEditorOpen,
  editorLease,
  editorSessionId,
  editorWorkingDirectory,
  renderEmbeddedEditor,
} from "./embedded-editor-workflow-fixture";

beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  // Register observers without fabricating native geometry or an editor implementation.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 24, height: 24 }),
  });
  vi.stubGlobal("matchMedia", (query: string): MediaQueryList => ({
    media: query,
    matches: query === "(prefers-reduced-motion: reduce)",
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
  }));
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(SVGElement.prototype, "getBBox");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function workspaceFrame() {
  return screen.queryByTitle<HTMLIFrameElement>("VS Code workspace");
}
function backToAgentButton() {
  // The workspace toolbar and error card both expose the production return action.
  return screen.getAllByRole("button", { name: "Back to agent" })[0]!;
}

describe("Embedded editor workflow", () => {
  it("offers backend setup when missing, displays a failed download and retries before explicitly reopening", async () => {
    // Only the viewing-device capability is controlled; no editor implementation is mocked.
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Linux");
    const lease = editorLease("b");
    const open = vi
      .fn<Client["vscode"]["open"]>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(lease);
    let finishInstall!: () => void;
    const installing = new Promise<void>((resolve) => {
      finishInstall = resolve;
    });
    const install = vi
      .fn<Client["vscode"]["install"]>()
      .mockRejectedValueOnce(new Error("Download unavailable"))
      .mockImplementationOnce(async () => {
        fixture.state({ status: "downloading", message: "Fetching backend editor" });
        await installing;
        fixture.state({ status: "ready" });
      });
    using fixture = renderEmbeddedEditor({ vscode: { open, install } });
    fixture.state({ status: "missing" });

    await fixture.user.click(screen.getByRole("button", { name: "Open VS Code" }));
    expect(screen.getByText("Full VS Code editing")).toBeDefined();
    expect(screen.getByText(/The editor runs on Cake’s backend/)).toBeDefined();
    expect(screen.getByRole("button", { name: "Ask Cake to set this up" })).toBeDefined();
    expect(workspaceFrame()).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Download openvscode-server" }));
    expect(await screen.findByText("Download unavailable")).toBeDefined();
    expect(install).toHaveBeenCalledWith(
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(screen.getByRole("button", { name: "Ask Cake to set this up" })).toBeDefined();

    await fixture.user.click(screen.getByRole("button", { name: "Download openvscode-server" }));
    expect(await screen.findByText("Installing VS Code")).toBeDefined();
    expect(screen.getByText("Fetching backend editor")).toBeDefined();
    expect(screen.queryByText("Download unavailable")).toBeNull();
    expect(install).toHaveBeenCalledTimes(2);
    await act(async () => {
      finishInstall();
      await installing;
    });
    await waitFor(() => expect(screen.queryByText("Installing VS Code")).toBeNull());
    expect(open).toHaveBeenCalledTimes(1);
    await fixture.user.click(backToAgentButton());
    await fixture.user.click(screen.getByRole("button", { name: "Open VS Code" }));
    await waitFor(() => expect(workspaceFrame()?.getAttribute("src")).toBe(lease.endpoint));
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("opens the workspace, tolerates advisory sync failures and requires an explicit reopen after disconnect", async () => {
    const first = editorLease("a");
    const second = editorLease("b");
    const open = vi
      .fn<Client["vscode"]["open"]>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const release = vi.fn<Client["vscode"]["release"]>(async () => undefined);
    const setTheme = vi
      .fn<Client["vscode"]["setTheme"]>()
      .mockRejectedValueOnce(new Error("Theme RPC disconnected"))
      .mockResolvedValue(undefined);
    const updateAnnotations = vi
      .fn<Client["vscode"]["updateAnnotations"]>()
      .mockRejectedValueOnce(new Error("annotation unavailable"))
      .mockResolvedValue(undefined);
    using fixture = renderEmbeddedEditor({
      vscode: { open, release, setTheme, updateAnnotations },
    });

    await fixture.user.click(screen.getByRole("button", { name: "Open VS Code" }));
    await waitFor(() => expect(workspaceFrame()?.getAttribute("src")).toBe(first.endpoint));
    expect(open).toHaveBeenCalledWith(
      editorWorkingDirectory,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await waitFor(() => expect(setTheme).toHaveBeenCalledTimes(1));
    expect(setTheme).toHaveBeenCalledWith(
      "light",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(updateAnnotations).toHaveBeenCalledWith(
      editorWorkingDirectory,
      { sessionId: editorSessionId, annotations: [] },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(screen.queryByText("Theme RPC disconnected")).toBeNull();
    expect(screen.queryByText("annotation unavailable")).toBeNull();
    expect(workspaceFrame()?.getAttribute("src")).toBe(first.endpoint);

    fixture.disconnected();
    expect(workspaceFrame()).toBeNull();
    expect(
      screen.getByText("Connection lost. Return to agent and reopen VS Code after reconnecting."),
    ).toBeDefined();
    fixture.state({ status: "ready" });
    expect(open).toHaveBeenCalledTimes(1);
    expect(workspaceFrame()).toBeNull();

    await fixture.user.click(backToAgentButton());
    expect(screen.getByRole("button", { name: "Open VS Code" })).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Open VS Code" }));
    await waitFor(() => expect(workspaceFrame()?.getAttribute("src")).toBe(second.endpoint));
    expect(open).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(updateAnnotations).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(setTheme).toHaveBeenCalledTimes(2));
    await fixture.user.click(backToAgentButton());
    expect(workspaceFrame()).toBeNull();
    expect(release).toHaveBeenCalledWith(second.id);
    // The disconnected transport already revoked the first scoped lease.
    expect(release).not.toHaveBeenCalledWith(first.id);
  });

  it.each(["rejected open", "malformed endpoint"] as const)(
    "shows a %s failure and retries through the agent toolbar",
    async (failure) => {
      const good = editorLease("c");
      const malformed = {
        ...editorLease("d"),
        endpoint: `${editorLease("d").endpoint}?redirect=elsewhere`,
      };
      const open = vi.fn<Client["vscode"]["open"]>();
      if (failure === "rejected open")
        open.mockRejectedValueOnce(new Error("Editor service unavailable"));
      else open.mockResolvedValueOnce(malformed);
      open.mockResolvedValueOnce(good);
      const release = vi.fn<Client["vscode"]["release"]>(async () => undefined);
      using fixture = renderEmbeddedEditor({ vscode: { open, release } });

      await fixture.user.click(screen.getByRole("button", { name: "Open VS Code" }));
      const message =
        failure === "rejected open"
          ? "Editor service unavailable"
          : "Invalid editor lease endpoint";
      expect(await screen.findByText(message)).toBeDefined();
      expect(screen.getByText("VS Code could not open")).toBeDefined();
      expect(screen.queryByRole("button", { name: "Ask Cake to set this up" })).toBeNull();
      expect(workspaceFrame()).toBeNull();
      if (failure === "malformed endpoint") expect(release).toHaveBeenCalledWith(malformed.id);
      // Exercise the failure card's own return action, not just the workspace toolbar.
      await fixture.user.click(
        within(screen.getByRole("alert")).getByRole("button", { name: "Back to agent" }),
      );
      expect(screen.queryByText("VS Code could not open")).toBeNull();
      await fixture.user.click(screen.getByRole("button", { name: "Open VS Code" }));
      await waitFor(() => expect(workspaceFrame()?.getAttribute("src")).toBe(good.endpoint));
      expect(screen.queryByText(message)).toBeNull();
      expect(open).toHaveBeenCalledTimes(2);
    },
  );

  it("releases a late acquisition after disconnect without presenting it over the reconnected workspace", async () => {
    const pending = deferredEditorOpen();
    const stale = editorLease("e");
    const current = editorLease("f");
    const open = vi
      .fn<Client["vscode"]["open"]>()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce(current);
    const release = vi.fn<Client["vscode"]["release"]>(async () => undefined);
    using fixture = renderEmbeddedEditor({ vscode: { open, release } });

    await fixture.user.click(screen.getByRole("button", { name: "Open VS Code" }));
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(workspaceFrame()).toBeNull();
    fixture.disconnected();
    await fixture.user.click(backToAgentButton());
    await fixture.user.click(screen.getByRole("button", { name: "Open VS Code" }));
    await waitFor(() => expect(workspaceFrame()?.getAttribute("src")).toBe(current.endpoint));
    await act(async () => {
      pending.resolve(stale);
      await pending.promise;
    });
    await waitFor(() => expect(release).toHaveBeenCalledWith(stale.id));
    expect(workspaceFrame()?.getAttribute("src")).toBe(current.endpoint);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("keeps the reconnected workspace visible when an older acquisition rejects", async () => {
    const pending = deferredEditorOpen();
    const current = editorLease("a");
    const open = vi
      .fn<Client["vscode"]["open"]>()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce(current);
    using fixture = renderEmbeddedEditor({ vscode: { open } });

    await fixture.user.click(screen.getByRole("button", { name: "Open VS Code" }));
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    fixture.disconnected();
    await fixture.user.click(backToAgentButton());
    await fixture.user.click(screen.getByRole("button", { name: "Open VS Code" }));
    await waitFor(() => expect(workspaceFrame()?.getAttribute("src")).toBe(current.endpoint));
    await act(async () => {
      pending.reject(new Error("stale transport rejection"));
      await pending.promise.catch(() => undefined);
    });
    expect(workspaceFrame()?.getAttribute("src")).toBe(current.endpoint);
    expect(screen.queryByText("stale transport rejection")).toBeNull();
    expect(open).toHaveBeenCalledTimes(2);
  });
});
