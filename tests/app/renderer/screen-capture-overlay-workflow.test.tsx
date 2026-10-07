/** @vitest-environment jsdom */
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createStore, mount } from "r-state-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScreenCaptureOverlay } from "../../../src/renderer/components/screen-capture-overlay";
import { ScreenCaptureOverlayStore } from "../../../src/renderer/stores/ScreenCaptureOverlayStore";

afterEach(cleanup);
const snapshot = {
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
    finishScreenCapture,
    [Symbol.dispose]() {
      view.unmount();
      store[Symbol.dispose]();
    },
  };
}

describe("Screen capture overlay completion", () => {
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
      "data:image/png;base64,composed",
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
      "data:image/png;base64,retry",
      expect.anything(),
    );
  });
});
