/** @vitest-environment jsdom */
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import type { Client } from "../../../src/renderer/client/Client";
import {
  renderSelectionUi,
  selectionSessionId,
  selectionWorkspace,
} from "./editor-selection-ui-workflow-fixture";

beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  // Register production observers; jsdom cannot measure a native editor.
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
  vi.unstubAllGlobals();
});

const revealTour = () => screen.getByRole("button", { name: /^Reveal src\/tour\.ts/ });
const removeTour = () => screen.getByRole("button", { name: /^Remove src\/tour\.ts/ });
const revealNext = () => screen.getByRole("button", { name: /^Reveal src\/next\.ts/ });
const removeNext = () => screen.getByRole("button", { name: /^Remove src\/next\.ts/ });

// Real App, session composition and command-authorized tour setup. No claims
// about native editor navigation, manual text selection, focus or geometry.
// Manual editor-context events and annotation payloads have composer coverage.
describe("Editor selection pills workflow", () => {
  it("keeps each session's pills and native highlights isolated across sidebar navigation", async () => {
    using fixture = await renderSelectionUi({}, { secondary: true });
    await fixture.user.click(screen.getByRole("button", { name: /^other-tour / }));
    expect(screen.queryByRole("button", { name: /^Reveal src\// })).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Open VS Code" }));
    await waitFor(() =>
      expect(fixture.highlights).toHaveBeenLastCalledWith(
        selectionWorkspace,
        { locations: [] },
        expect.any(Object),
      ),
    );
    await act(async () => {
      await fixture.invoke("vscode.open", { path: "src/other.ts", line: 4 }, "other-tour");
    });
    expect(screen.getByRole("button", { name: /^Reveal src\/other.ts/ })).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: /^tour-session / }));
    await waitFor(() => expect(revealTour()).toBeDefined());
    expect(revealNext()).toBeDefined();
    expect(screen.queryByRole("button", { name: /^Reveal src\/other.ts/ })).toBeNull();
    await waitFor(() =>
      expect(fixture.highlights).toHaveBeenLastCalledWith(
        selectionWorkspace,
        {
          locations: [
            expect.objectContaining({ path: "src/tour.ts" }),
            expect.objectContaining({ path: "src/next.ts" }),
          ],
        },
        expect.any(Object),
      ),
    );
  });

  it("honors agent removal and clear while hidden, then resends only retained highlights on reopen", async () => {
    using fixture = await renderSelectionUi();
    const listed = await fixture.invoke("vscode.selections.list");
    if (!listed.ok || listed.command !== "vscode.selections.list")
      throw new Error("Missing selection reply");
    const tour = listed.state.selections.find(({ location }) => location.path === "src/tour.ts")!;
    await fixture.user.click(screen.getByRole("button", { name: "Back to agent" }));
    const sends = fixture.highlights.mock.calls.length;
    await act(async () => {
      await fixture.invoke("vscode.selections.remove", { id: tour.id });
    });
    expect(fixture.highlights).toHaveBeenCalledTimes(sends);
    await fixture.user.click(screen.getByRole("button", { name: "Open VS Code" }));
    expect(screen.queryByRole("button", { name: /^Reveal src\/tour.ts/ })).toBeNull();
    expect(revealNext()).toBeDefined();
    await waitFor(() =>
      expect(fixture.highlights).toHaveBeenLastCalledWith(
        selectionWorkspace,
        { locations: [expect.objectContaining({ path: "src/next.ts" })] },
        expect.any(Object),
      ),
    );
    await fixture.user.click(screen.getByRole("button", { name: "Back to agent" }));
    await act(async () => {
      await fixture.invoke("vscode.selections.clear");
    });
    await fixture.user.click(screen.getByRole("button", { name: "Open VS Code" }));
    expect(screen.queryByLabelText("Editor selections")).toBeNull();
    await waitFor(() =>
      expect(fixture.highlights).toHaveBeenLastCalledWith(
        selectionWorkspace,
        { locations: [] },
        expect.any(Object),
      ),
    );
  });

  it("retains tour selections when the user removes attachments and sends a message", async () => {
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () =>
      TurnId.make("10000000-0000-4000-8000-000000000001"),
    );
    using fixture = await renderSelectionUi({
      sessionChats: { prompt },
    });
    expect(revealTour()).toBeDefined();
    expect(revealNext()).toBeDefined();
    await fixture.user.click(screen.getByRole("combobox", { name: "Message" }));
    await fixture.user.paste("notes\n".repeat(50));
    await fixture.user.click(await screen.findByRole("button", { name: /^Remove Pasted text/ }));
    expect(revealTour()).toBeDefined();
    expect(revealNext()).toBeDefined();
    await fixture.user.type(screen.getByRole("combobox", { name: "Message" }), "Continue the tour");
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(prompt).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          sessionId: selectionSessionId,
          text: "Continue the tour",
          attachments: [],
        }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    expect(revealTour()).toBeDefined();
    expect(revealNext()).toBeDefined();
    expect(screen.getByRole("combobox", { name: "Message" })).toHaveProperty("value", "");
  });

  it("reports a failed reveal without dropping or duplicating pills and permits retry", async () => {
    using fixture = await renderSelectionUi();
    fixture.reveal.mockRejectedValueOnce(new Error("File missing"));
    await fixture.user.click(revealTour());
    expect(await screen.findByText("Could not open editor location: File missing")).toBeDefined();
    expect(screen.getAllByRole("button", { name: /^Reveal src\// })).toHaveLength(2);
    expect(revealNext()).toBeDefined();
    await fixture.user.click(revealTour());
    await waitFor(() =>
      expect(screen.queryByText("Could not open editor location: File missing")).toBeNull(),
    );
    expect(fixture.reveal).toHaveBeenLastCalledWith(
      selectionWorkspace,
      {
        kind: "working-directory",
        path: "src/tour.ts",
        range: { start: { line: 1 }, end: { line: 2 } },
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(screen.getAllByRole("button", { name: /^Reveal src\// })).toHaveLength(2);
  });

  it("keeps dismissal effective after a highlight failure and recovers on the next dismissal", async () => {
    using fixture = await renderSelectionUi();
    // Both the active-editor observer and the selection command refresh this
    // external authority. Keep it unavailable for the whole failed dismissal.
    fixture.highlights.mockRejectedValue(new Error("Editor disconnected"));
    await fixture.user.click(removeTour());
    expect(
      await screen.findByText("Could not refresh selection highlights: Editor disconnected"),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: /^Reveal src\/tour\.ts/ })).toBeNull();
    expect(revealNext()).toBeDefined();
    expect(fixture.highlights).toHaveBeenLastCalledWith(
      selectionWorkspace,
      { locations: [expect.objectContaining({ path: "src/next.ts" })] },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    fixture.highlights.mockResolvedValue(undefined);
    await fixture.user.click(removeNext());
    await waitFor(() =>
      expect(
        screen.queryByText("Could not refresh selection highlights: Editor disconnected"),
      ).toBeNull(),
    );
    expect(screen.queryByLabelText("Editor selections")).toBeNull();
    expect(fixture.highlights).toHaveBeenLastCalledWith(
      selectionWorkspace,
      { locations: [] },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
