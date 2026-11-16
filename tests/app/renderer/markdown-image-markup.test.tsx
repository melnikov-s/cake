/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { mockImageClipboard } from "./image-clipboard-fixture";
import { renderMarkdown } from "./markdown-rendering-fixture";

const imagePath = "/tmp/retro.png";
const loadWorkspaceImage = async () => ({ data: "cG5n", mimeType: "image/png" });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Parsing must not close/reparent the paragraph around a preview descendant. */
function expectValidParagraph(element: Element) {
  const paragraph = element.closest("p");
  expect(paragraph).not.toBeNull();
  const parsed = new DOMParser().parseFromString(paragraph!.outerHTML, "text/html");
  expect(parsed.body.innerHTML).toBe(paragraph!.outerHTML);
  expect(paragraph!.querySelector("div, figure, figcaption, p")).toBeNull();
  return paragraph!;
}

it.each([
  ["standalone remote", "![Original](https://example.com/original.png)", ""],
  [
    "inline remote",
    "Before **bold** ![Original](https://example.com/original.png) after.",
    "Before bold  after.",
  ],
  ["standalone workspace", `![Original](${imagePath})`, ""],
  ["inline workspace", `Before **bold** ![Original](${imagePath}) after.`, "Before bold  after."],
])("keeps valid paragraph semantics for %s images", async (_name, source, text) => {
  const errors = vi.spyOn(console, "error");
  using fixture = renderMarkdown(source, { actions: { loadWorkspaceImage } });
  const image = await within(fixture.container).findByRole("img", { name: "Original" });
  const paragraph = expectValidParagraph(image);
  expect(fixture.container.querySelectorAll("p")).toHaveLength(1);
  expect(paragraph.textContent).toBe(text);
  expect(image.closest("button")?.parentElement?.tagName).toBe("SPAN");
  expect(errors).not.toHaveBeenCalled();
});

it("portals keyboard/pointer menus and fullscreen captions without changing the image paragraph", async () => {
  const errors = vi.spyOn(console, "error");
  using fixture = renderMarkdown(`Before ![Original](${imagePath}) after.`, {
    actions: { loadWorkspaceImage },
  });
  const preview = await screen.findByRole("button", { name: "View Original enlarged" });
  const paragraph = expectValidParagraph(preview);
  const markup = paragraph.outerHTML;
  const anchor = preview.parentElement!;

  act(() => preview.focus());
  await fixture.user.keyboard("{Shift>}{F10}{/Shift}");
  const menu = await screen.findByRole("menu", { name: "Image actions" });
  expect(menu.closest("p")).toBeNull();
  expect(fixture.container.contains(menu)).toBe(false);
  expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: "Copy image" }));
  await fixture.user.keyboard("{Escape}");
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(anchor);

  // The dedicated context-menu key still bubbles from the image button.
  fireEvent.keyDown(preview, { key: "ContextMenu" });
  expect(screen.getByRole("menu", { name: "Image actions" })).toBeDefined();
  await fixture.user.keyboard("{Escape}");
  fireEvent.contextMenu(preview, { clientX: 40, clientY: 60 });
  expect(screen.getByRole("menu", { name: "Image actions" }).closest("p")).toBeNull();
  await fixture.user.keyboard("{Escape}");

  act(() => preview.focus());
  await fixture.user.keyboard("{Enter}");
  const fullscreen = await screen.findByRole("dialog", { name: "Original" });
  expect(fixture.container.contains(fullscreen)).toBe(false);
  expect(fullscreen.closest("p")).toBeNull();
  expect(fullscreen.querySelector("figure > figcaption")?.textContent).toBe(imagePath);
  expect(within(fullscreen).getByRole("img", { name: "Original" }).getAttribute("src")).toBe(
    "data:image/png;base64,cG5n",
  );
  expect(paragraph.outerHTML).toBe(markup);
  await fixture.user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(preview);
  expectValidParagraph(preview);
  expect(errors).not.toHaveBeenCalled();
});

it("keeps failed-copy feedback valid inside prose and preserves the fullscreen caption", async () => {
  const errors = vi.spyOn(console, "error");
  mockImageClipboard();
  const copyImage = vi.fn().mockRejectedValue(new Error("Clipboard unavailable"));
  using fixture = renderMarkdown(`Before ![Original](${imagePath}) after.`, {
    actions: { loadWorkspaceImage },
    client: { electron: { copyImage } },
  });
  const preview = await screen.findByRole("button", { name: "View Original enlarged" });
  fireEvent.contextMenu(preview);
  await fixture.user.click(await screen.findByRole("menuitem", { name: "Copy image" }));
  const error = await screen.findByRole("alert");
  expect(error.textContent).toBe("Could not copy image: Clipboard unavailable");
  expect(error.tagName).toBe("SPAN");
  expectValidParagraph(error);
  expect(copyImage).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("menu")).toBeNull();

  await fixture.user.click(preview);
  const fullscreen = await screen.findByRole("dialog", { name: "Original" });
  expect(
    within(fullscreen).getByText("Could not copy image: Clipboard unavailable").closest("p"),
  ).toBeNull();
  expect(fullscreen.querySelector("figcaption")?.textContent).toBe(imagePath);
  expectValidParagraph(preview);
  await fixture.user.click(
    within(fullscreen).getByRole("button", { name: "Exit fullscreen Original" }),
  );
  expectValidParagraph(await screen.findByRole("alert"));

  copyImage.mockResolvedValue(undefined);
  fireEvent.contextMenu(preview);
  await fixture.user.click(await screen.findByRole("menuitem", { name: "Copy image" }));
  await waitFor(() => expect(copyImage).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("alert")).toBeNull();
  expectValidParagraph(preview);
  expect(errors).not.toHaveBeenCalled();
});
