/** @vitest-environment jsdom */
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createStore, mount } from "r-state-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureRouting, captureSession } from "../../helpers/screen-capture";
import { ScreenCaptureOverlay } from "../../../src/renderer/components/screen-capture-overlay";
import { ScreenCaptureOverlayStore } from "../../../src/renderer/stores/ScreenCaptureOverlayStore";

afterEach(cleanup);
const snapshot = {
  routing: captureRouting,
  image: "data:image/png;base64,fixture",
  width: 1200,
  height: 800,
  maxDimension: 1024,
};

async function renderOverlay(
  renderImage: ScreenCaptureOverlayStore["props"]["renderImage"],
  routing = captureRouting,
) {
  const finishScreenCapture = vi.fn<
    ScreenCaptureOverlayStore["props"]["client"]["finishScreenCapture"]
  >(async () => {});
  const store = mount(
    createStore(ScreenCaptureOverlayStore, {
      client: { screenCaptureState: async () => ({ ...snapshot, routing }), finishScreenCapture },
      renderImage,
    }),
  );
  const view = render(<ScreenCaptureOverlay store={store} />);
  await act(async () => store.initialize());
  return {
    user: userEvent.setup(),
    store,
    finishScreenCapture,
    [Symbol.dispose]() {
      view.unmount();
      store[Symbol.dispose]();
    },
  };
}

describe("Screen capture overlay completion", () => {
  it("pins New chat above shared sidebar rows and chooses its Project inside the popup", async () => {
    using fixture = await renderOverlay(async () => "data:image/png;base64,new");
    const picker = screen.getByRole("button", { name: "Screenshot destination" });
    expect(picker.textContent).toContain("Session A");
    await fixture.user.click(picker);
    const popup = screen.getByRole("dialog", { name: "Screenshot destination" });
    expect(popup.querySelector("button")?.textContent).toBe("New chat");
    expect(
      [...popup.querySelectorAll("[data-session-id]")].map((row) =>
        row.getAttribute("data-session-id"),
      ),
    ).toEqual(["alpha", "beta", "gamma"]);
    expect(popup.querySelector('[data-session-id="alpha"] [data-slot="avatar"]')).not.toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: /Session C/ }));
    expect(picker.textContent).toContain("Session C");
    await fixture.user.click(picker);
    await fixture.user.click(screen.getByRole("button", { name: /^New chat$/ }));
    await fixture.user.click(screen.getByRole("button", { name: /^New chat in Project$/ }));
    expect(picker.textContent).toContain("New chat · Project");
    await fixture.user.click(screen.getByRole("button", { name: "Attach full display" }));
    expect(fixture.finishScreenCapture).toHaveBeenCalledWith(
      {
        image: "data:image/png;base64,new",
        destination: { kind: "new-session", projectPath: "/project" },
      },
      expect.anything(),
    );
  });

  it("shares family disclosure, labels, branch and activity presentation with sidebar rows", async () => {
    const parent = captureSession("parent", "Family parent", {
      familyChildSessionIds: ["child"],
      familyCollapsed: true,
      worktreeName: "capture-polish",
      labels: [{ id: "review", name: "Review", color: "blue" }],
      activity: "running",
    });
    const child = captureSession("child", "Family child", {
      familyParentSessionId: "parent",
      familyDepth: 1,
    });
    using fixture = await renderOverlay(async () => "data:image/png;base64,new", {
      ...captureRouting,
      projects: [{ path: "/project", name: "Project", sessions: [parent, child] }],
      defaultDestination: { kind: "project-session", sessionId: "parent" },
    });
    await fixture.user.click(screen.getByRole("button", { name: "Screenshot destination" }));
    expect(screen.queryByRole("button", { name: /Family child/ })).toBeNull();
    expect(screen.getByText("capture-polish")).toBeDefined();
    expect(screen.getByRole("img", { name: "Labels: Review" })).toBeDefined();
    await fixture.user.click(
      screen.getByRole("button", { name: "Expand children of Family parent" }),
    );
    await fixture.user.click(screen.getByRole("button", { name: /Family child/ }));
    expect(screen.getByRole("button", { name: "Screenshot destination" }).textContent).toContain(
      "Family child",
    );
    await fixture.user.click(screen.getByRole("button", { name: "Attach full display" }));
    expect(fixture.finishScreenCapture).toHaveBeenCalledWith(
      {
        image: "data:image/png;base64,new",
        destination: { kind: "project-session", sessionId: "child" },
      },
      expect.anything(),
    );
  });

  it("puts preview and committed arrowheads at the first click and labels at the tail", async () => {
    using fixture = await renderOverlay(async () => "data:image/png;base64,arrow");
    await fixture.user.click(screen.getByRole("button", { name: "Annotate" }));
    const head = { x: 100, y: 200 };
    const tail = { x: 400, y: 500 };
    // Pixel gesture policy belongs to the Store; actual pointer/focus is covered in Electron.
    act(() => {
      fixture.store.begin(head);
      fixture.store.move(tail);
    });
    expect(fixture.store.visibleArrows).toEqual([{ start: tail, end: head, label: "" }]);
    act(() => fixture.store.end(tail));
    expect(fixture.store.arrows).toEqual([{ start: tail, end: head, label: "" }]);
    expect(fixture.store.labelPoint).toEqual(tail);
  });
  it("discards only the unfinished arrow on Escape, preserving earlier arrows until the next Escape", async () => {
    using fixture = await renderOverlay(async () => "data:image/png;base64,arrow");
    await fixture.user.click(screen.getByRole("button", { name: "Annotate" }));
    act(() => {
      fixture.store.begin({ x: 100, y: 200 });
      fixture.store.end({ x: 400, y: 500 });
    });
    await fixture.user.type(screen.getByRole("textbox", { name: "Arrow label" }), "Keep this");
    await fixture.user.keyboard("{Enter}");
    act(() => {
      fixture.store.begin({ x: 200, y: 200 });
      fixture.store.end({ x: 500, y: 500 });
    });
    await fixture.user.type(screen.getByRole("textbox", { name: "Arrow label" }), "Discard this");
    await fixture.user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: "Arrow label" })).toBeNull();
    expect(fixture.store.arrows.map((arrow) => arrow.label)).toEqual(["Keep this"]);
    expect(fixture.finishScreenCapture).not.toHaveBeenCalled();
    await fixture.user.keyboard("{Escape}");
    expect(fixture.finishScreenCapture).toHaveBeenCalledWith(undefined, expect.anything());
  });

  it("closes the destination popup on Escape before cancelling capture", async () => {
    using fixture = await renderOverlay(async () => "data:image/png;base64,new");
    await fixture.user.click(screen.getByRole("button", { name: "Screenshot destination" }));
    await fixture.user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Screenshot destination" })).toBeNull();
    expect(fixture.finishScreenCapture).not.toHaveBeenCalled();
    await fixture.user.keyboard("{Escape}");
    expect(fixture.finishScreenCapture).toHaveBeenCalledOnce();
  });

  it("switches between editing modes and attaches the whole screenshot through the native operation", async () => {
    const renderImage = vi.fn<ScreenCaptureOverlayStore["props"]["renderImage"]>(
      async () => "data:image/png;base64,composed",
    );
    using fixture = await renderOverlay(renderImage);
    // The capture-specific default overrides the shared floating toolbar's top-4 inset.
    // Actual screen coordinates, dragging and clipping are checked in the Electron smoke test.
    expect(
      screen.getByRole("toolbar", { name: "Screen capture tools" }).classList.contains("top-14"),
    ).toBe(true);
    await fixture.user.click(screen.getByRole("button", { name: "Annotate" }));
    expect(screen.getByRole("button", { name: "Annotate" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    await fixture.user.click(screen.getByRole("button", { name: "Crop" }));
    await fixture.user.click(screen.getByRole("button", { name: "Attach full display" }));
    expect(renderImage).toHaveBeenCalledWith(
      snapshot.image,
      [],
      undefined,
      1024,
      expect.anything(),
    );
    expect(fixture.finishScreenCapture).toHaveBeenCalledWith(
      { image: "data:image/png;base64,composed", destination: captureRouting.defaultDestination },
      expect.anything(),
    );
  });

  it("cancels while flattening and never attaches a late completed render", async () => {
    let complete!: (value: string) => void;
    const pending = new Promise<string>((resolve) => {
      complete = resolve;
    });
    using fixture = await renderOverlay(async () => pending);
    await fixture.user.click(screen.getByRole("button", { name: "Attach full display" }));
    expect(
      screen.getByRole("button", { name: "Attach full display" }).hasAttribute("disabled"),
    ).toBe(true);
    await fixture.user.click(screen.getByRole("button", { name: "Cancel" }));
    await act(async () => complete("data:image/png;base64,late"));
    expect(fixture.finishScreenCapture).toHaveBeenCalledOnce();
    expect(fixture.finishScreenCapture).toHaveBeenCalledWith(undefined, expect.anything());
  });

  it("keeps the overlay usable after a failed render", async () => {
    const renderImage = vi
      .fn<ScreenCaptureOverlayStore["props"]["renderImage"]>()
      .mockRejectedValueOnce(new Error("Cannot render image"))
      .mockResolvedValueOnce("data:image/png;base64,retry");
    using fixture = await renderOverlay(renderImage);
    await fixture.user.click(screen.getByRole("button", { name: "Attach full display" }));
    expect(await screen.findByText("Cannot render image")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Attach full display" }));
    expect(fixture.finishScreenCapture).toHaveBeenCalledWith(
      { image: "data:image/png;base64,retry", destination: captureRouting.defaultDestination },
      expect.anything(),
    );
  });
});
