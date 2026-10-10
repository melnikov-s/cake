/** @vitest-environment jsdom */
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createStore, mount } from "r-state-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureRouting } from "../../helpers/screen-capture";
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

async function renderOverlay(renderImage: ScreenCaptureOverlayStore["props"]["renderImage"]) {
  const finishScreenCapture = vi.fn<
    ScreenCaptureOverlayStore["props"]["client"]["finishScreenCapture"]
  >(async () => {});
  const store = mount(
    createStore(ScreenCaptureOverlayStore, {
      client: { screenCaptureState: async () => snapshot, finishScreenCapture },
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
  it("groups all sessions by Project, pins New session first, and chooses its Project", async () => {
    using fixture = await renderOverlay(async () => "data:image/png;base64,new");
    const picker = screen.getByRole("combobox", { name: "Screenshot destination" });
    expect((picker as HTMLSelectElement).value).toBe("alpha");
    expect(picker.querySelector("option")?.textContent).toBe("New session");
    expect(screen.getByRole("group", { name: "Project" }).textContent).toContain("Session B");
    expect(screen.getByRole("group", { name: "Other Project" }).textContent).toContain("Session C");
    await fixture.user.selectOptions(picker, "gamma");
    await fixture.user.selectOptions(picker, "new");
    const project = screen.getByRole("combobox", { name: "New session Project" });
    expect((project as HTMLSelectElement).value).toBe("/other");
    await fixture.user.selectOptions(project, "/project");
    await fixture.user.click(screen.getByRole("button", { name: "Attach full display" }));
    expect(fixture.finishScreenCapture).toHaveBeenCalledWith(
      {
        image: "data:image/png;base64,new",
        destination: { kind: "new-session", projectPath: "/project" },
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
  it("switches between editing modes and attaches the whole screenshot through the native operation", async () => {
    const renderImage = vi.fn<ScreenCaptureOverlayStore["props"]["renderImage"]>(
      async () => "data:image/png;base64,composed",
    );
    using fixture = await renderOverlay(renderImage);
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
