/** @vitest-environment jsdom */
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createStore, mount } from "r-state-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureRouting, captureSession } from "../../helpers/screen-capture";
import { ScreenCaptureOverlay } from "../../../src/renderer/components/screen-capture-overlay";
import { ScreenCaptureOverlayStore } from "../../../src/renderer/stores/ScreenCaptureOverlayStore";
import { createTestClient } from "./test-client";

afterEach(cleanup);
const snapshot = {
  routing: captureRouting,
  image: "data:image/png;base64,fixture",
  width: 1200,
  height: 800,
  maxDimension: 1024,
};
async function renderOverlay(
  renderImage: ScreenCaptureOverlayStore["props"]["renderImage"] = async () =>
    "data:image/png;base64,new",
  routing = captureRouting,
  copy = vi.fn<ScreenCaptureOverlayStore["props"]["copy"]>(async () => {}),
) {
  const finishScreenCapture = vi.fn<
    ScreenCaptureOverlayStore["props"]["client"]["finishScreenCapture"]
  >(async () => {});
  const client = createTestClient({});
  const store = mount(
    createStore(ScreenCaptureOverlayStore, {
      client: { screenCaptureState: async () => ({ ...snapshot, routing }), finishScreenCapture },
      speech: {
        client: client.dictation,
        postProcess: client.workspaces.postProcessDictation,
        microphone: {
          open: async () => {
            throw new Error("No microphone in this test");
          },
          devices: async () => [],
        },
      },
      renderImage,
      copy,
    }),
  );
  const view = render(<ScreenCaptureOverlay store={store} />);
  await act(async () => store.initialize());
  return {
    user: userEvent.setup(),
    store,
    finishScreenCapture,
    copy,
    [Symbol.dispose]() {
      view.unmount();
      store[Symbol.dispose]();
    },
  };
}
const comment = () => screen.getByRole("textbox", { name: "Annotation comment" });
function draw(store: ScreenCaptureOverlayStore) {
  // Native pointer capture and touch routing are exercised by the Electron test.
  act(() => {
    store.begin({ x: 100, y: 200 });
    store.move({ x: 250, y: 400 });
    store.end({ x: 400, y: 500 });
  });
}

describe("Screen capture overlay", () => {
  it.each(["light", "dark"] as const)(
    "picks explicit annotation ink in %s and passes it to copy/export and cancellation",
    async (theme) => {
      const renderImage = vi.fn<ScreenCaptureOverlayStore["props"]["renderImage"]>(
        async () => "data:image/png;base64,color",
      );
      using fixture = await renderOverlay(renderImage, {
        ...captureRouting,
        annotationColor: "pink",
        appearance: { ...captureRouting.appearance, theme },
      });
      const trigger = screen.getByRole("button", { name: "Annotation color" });
      expect(
        trigger.querySelector("[data-annotation-color]")?.getAttribute("data-annotation-color"),
      ).toBe("pink");
      await fixture.user.click(trigger);
      expect(screen.getAllByRole("menuitemradio")).toHaveLength(6);
      expect(screen.getByRole("menuitemradio", { name: "pink" }).getAttribute("aria-checked")).toBe(
        "true",
      );
      await fixture.user.click(screen.getByRole("menuitemradio", { name: "cyan" }));
      expect(screen.queryByRole("menu", { name: "Annotation color" })).toBeNull();
      expect(
        trigger.querySelector("[data-annotation-color]")?.getAttribute("data-annotation-color"),
      ).toBe("cyan");
      await fixture.user.click(screen.getByRole("button", { name: "Copy image and text" }));
      expect(renderImage).toHaveBeenLastCalledWith(
        snapshot.image,
        [],
        undefined,
        snapshot.maxDimension,
        "cyan",
      );
      await fixture.user.click(trigger);
      await fixture.user.keyboard("{Escape}");
      expect(fixture.finishScreenCapture).not.toHaveBeenCalled();
      await fixture.user.click(screen.getByRole("button", { name: "Cancel" }));
      expect(fixture.finishScreenCapture).toHaveBeenCalledWith(
        undefined,
        "cyan",
        expect.anything(),
      );
    },
  );

  it("uses sidebar project icons and session rows, keeps selection and creates a chat in a Project", async () => {
    using fixture = await renderOverlay();
    const picker = screen.getByRole("button", { name: "Screenshot destination" });
    await fixture.user.click(picker);
    const popup = screen.getByRole("dialog", { name: "Screenshot destination" });
    expect(popup.querySelector("button")?.textContent).toBe("New chat");
    expect(
      [...popup.querySelectorAll("[data-session-id]")].map((row) =>
        row.getAttribute("data-session-id"),
      ),
    ).toEqual(["alpha", "beta", "gamma"]);
    expect(
      screen
        .getByRole("button", { name: "Collapse Project" })
        .querySelector('[data-slot="avatar"]'),
    ).not.toBeNull();
    expect(popup.querySelector('[data-session-id="alpha"] [data-slot="avatar"]')).not.toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Collapse Project" }));
    expect(screen.queryByRole("button", { name: /Session A/ })).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Expand Project" }));
    await fixture.user.click(screen.getByRole("button", { name: /Session C/ }));
    expect(picker.textContent).toContain("Session C");
    await fixture.user.click(picker);
    await fixture.user.click(screen.getByRole("button", { name: /^New chat$/ }));
    const project = screen.getByRole("button", { name: /^New chat in Project$/ });
    expect(project.querySelector('[data-slot="avatar"]')).not.toBeNull();
    await fixture.user.click(project);
    await fixture.user.click(screen.getByRole("button", { name: "Attach full display" }));
    expect(fixture.finishScreenCapture).toHaveBeenCalledWith(
      {
        image: "data:image/png;base64,new",
        annotationText: "",
        destination: { kind: "new-session", projectPath: "/project" },
      },
      "yellow",
      expect.anything(),
    );
  });

  it("shares family disclosure, branch, labels and activity with sidebar rows", async () => {
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
    using fixture = await renderOverlay(undefined, {
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
    await fixture.user.click(screen.getByRole("button", { name: "Attach full display" }));
    expect(fixture.finishScreenCapture).toHaveBeenCalledWith(
      expect.objectContaining({ destination: { kind: "project-session", sessionId: "child" } }),
      "yellow",
      expect.anything(),
    );
  });

  it.each(["Annotate", "Freehand"])(
    "opens the exact shared annotation composer on %s release and exports multiline numbered text",
    async (tool) => {
      const renderImage = vi.fn<ScreenCaptureOverlayStore["props"]["renderImage"]>(
        async () => "data:image/png;base64,drawing",
      );
      using fixture = await renderOverlay(renderImage);
      await fixture.user.click(screen.getByRole("button", { name: tool }));
      draw(fixture.store);
      expect(
        screen
          .getByRole("dialog", { name: "Add annotation" })
          .querySelector('[data-slot="composer-dictation"]'),
      ).not.toBeNull();
      expect(comment().closest('[data-slot="dictation-field"]')).not.toBeNull();
      await fixture.user.type(comment(), "First line{Shift>}{Enter}{/Shift}Second line");
      await fixture.user.click(screen.getByRole("button", { name: "Add annotation" }));
      await fixture.user.click(screen.getByRole("button", { name: "Attach full display" }));
      expect(renderImage.mock.calls[0]![1]).toEqual([
        tool === "Annotate"
          ? {
              kind: "arrow",
              start: { x: 400, y: 500 },
              end: { x: 100, y: 200 },
              label: "First line\nSecond line",
            }
          : {
              kind: "freehand",
              points: [
                { x: 100, y: 200 },
                { x: 250, y: 400 },
                { x: 400, y: 500 },
              ],
              label: "First line\nSecond line",
            },
      ]);
      expect(fixture.finishScreenCapture).toHaveBeenCalledWith(
        {
          image: "data:image/png;base64,drawing",
          annotationText: "1. First line\n   Second line",
          destination: captureRouting.defaultDestination,
        },
        "yellow",
        expect.anything(),
      );
      expect(fixture.store.dictationStore.enabled).toBe(false);
      expect(screen.queryByRole("button", { name: "Mute dictation" })).toBeNull();
    },
  );

  it("retains dictation enablement, microphone and processing preference in the shared composer", async () => {
    using fixture = await renderOverlay(undefined, {
      ...captureRouting,
      dictation: {
        ...captureRouting.dictation,
        enabled: true,
        deviceId: "chosen-mic",
        textProcessingMode: "utility",
      },
    });
    await fixture.user.click(screen.getByRole("button", { name: "Freehand" }));
    draw(fixture.store);
    expect(fixture.store.dictationStore.enabled).toBe(true);
    expect(fixture.store.dictationStore.deviceId).toBe("chosen-mic");
    expect(fixture.store.dictationStore.textProcessingMode).toBe("utility");
    await fixture.user.click(await screen.findByRole("button", { name: "Mute dictation" }));
    expect(screen.getByRole("button", { name: "Unmute dictation" })).toBeDefined();
    expect(
      screen
        .getByRole("dialog", { name: "Add annotation" })
        .querySelector('[data-slot="composer-dictation"]'),
    ).not.toBeNull();
  });

  it("keeps numeric identity on editing/cancel, and renumbers on delete and undo", async () => {
    using fixture = await renderOverlay();
    await fixture.user.click(screen.getByRole("button", { name: "Annotate" }));
    draw(fixture.store);
    await fixture.user.type(comment(), "First{Enter}");
    draw(fixture.store);
    await fixture.user.type(comment(), "Second{Enter}");
    act(() => fixture.store.editLabel(0));
    expect(screen.getByText("First")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Edit annotation" }));
    const edit = () => screen.getByRole("textbox", { name: "Edit annotation comment" });
    await fixture.user.clear(edit());
    await fixture.user.type(edit(), "Discard change{Escape}");
    expect(screen.getByText("First")).toBeDefined();
    expect(fixture.finishScreenCapture).not.toHaveBeenCalled();
    await fixture.user.click(screen.getByRole("button", { name: "Edit annotation" }));
    expect((edit() as HTMLTextAreaElement).value).toBe("First");
    await fixture.user.clear(edit());
    await fixture.user.type(edit(), "Edited{Enter}");
    act(() => fixture.store.editLabel(1));
    await fixture.user.click(screen.getByRole("button", { name: "Delete annotation" }));
    draw(fixture.store);
    await fixture.user.type(comment(), "Third{Enter}");
    await fixture.user.click(screen.getByRole("button", { name: "Undo drawing" }));
    await fixture.user.click(screen.getByRole("button", { name: "Attach full display" }));
    expect(fixture.finishScreenCapture).toHaveBeenCalledWith(
      expect.objectContaining({ annotationText: "1. Edited" }),
      "yellow",
      expect.anything(),
    );
  });

  it("discards a new unfinished drawing on Escape but not the capture or saved annotations", async () => {
    using fixture = await renderOverlay();
    await fixture.user.click(screen.getByRole("button", { name: "Freehand" }));
    draw(fixture.store);
    await fixture.user.type(comment(), "Keep{Enter}");
    draw(fixture.store);
    await fixture.user.type(comment(), "Discard{Escape}");
    expect(screen.queryByRole("textbox", { name: "Annotation comment" })).toBeNull();
    expect(fixture.store.drawings.map((drawing) => drawing.label)).toEqual(["Keep"]);
    expect(fixture.finishScreenCapture).not.toHaveBeenCalled();
    await fixture.user.keyboard("{Escape}");
    expect(fixture.finishScreenCapture).toHaveBeenCalledWith(
      undefined,
      "yellow",
      expect.anything(),
    );
  });

  it("copies image plus numbered text, commits open input and reports clipboard failure without closing", async () => {
    const copy = vi
      .fn<ScreenCaptureOverlayStore["props"]["copy"]>(async () => {})
      .mockRejectedValueOnce(new Error("Clipboard cannot write both formats"));
    using fixture = await renderOverlay(undefined, undefined, copy);
    await fixture.user.click(screen.getByRole("button", { name: "Annotate" }));
    draw(fixture.store);
    await fixture.user.type(comment(), "Still editing");
    await fixture.user.click(screen.getByRole("button", { name: "Copy image and text" }));
    expect(await screen.findByText("Clipboard cannot write both formats")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Copy image and text" }));
    expect(copy).toHaveBeenLastCalledWith("data:image/png;base64,new", "1. Still editing");
    expect(fixture.finishScreenCapture).not.toHaveBeenCalled();
  });

  it("closes destination popup before cancelling capture on Escape", async () => {
    using fixture = await renderOverlay();
    await fixture.user.click(screen.getByRole("button", { name: "Screenshot destination" }));
    await fixture.user.keyboard("{Escape}");
    expect(fixture.finishScreenCapture).not.toHaveBeenCalled();
    await fixture.user.keyboard("{Escape}");
    expect(fixture.finishScreenCapture).toHaveBeenCalledOnce();
  });

  it("cancels during flattening and never delivers the late render", async () => {
    let complete!: (value: string) => void;
    const pending = new Promise<string>((resolve) => {
      complete = resolve;
    });
    using fixture = await renderOverlay(async () => pending);
    await fixture.user.click(screen.getByRole("button", { name: "Attach full display" }));
    await fixture.user.click(screen.getByRole("button", { name: "Cancel" }));
    await act(async () => complete("data:image/png;base64,late"));
    expect(fixture.finishScreenCapture).toHaveBeenCalledExactlyOnceWith(
      undefined,
      "yellow",
      expect.anything(),
    );
  });

  it("recovers after a render error", async () => {
    const renderImage = vi
      .fn<ScreenCaptureOverlayStore["props"]["renderImage"]>()
      .mockRejectedValueOnce(new Error("Cannot render image"))
      .mockResolvedValueOnce("data:image/png;base64,retry");
    using fixture = await renderOverlay(renderImage);
    await fixture.user.click(screen.getByRole("button", { name: "Attach full display" }));
    expect(await screen.findByText("Cannot render image")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Attach full display" }));
    expect(fixture.finishScreenCapture).toHaveBeenCalledWith(
      {
        image: "data:image/png;base64,retry",
        annotationText: "",
        destination: captureRouting.defaultDestination,
      },
      "yellow",
      expect.anything(),
    );
  });
});
