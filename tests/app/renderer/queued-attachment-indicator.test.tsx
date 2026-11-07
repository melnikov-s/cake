/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { Attachment } from "../../../src/contracts/conversations/session-contract";
import { QueuedAttachmentIndicator } from "../../../src/renderer/components/queued-attachment-indicator";
import { queuePart, renderQueue } from "./prompt-queue-workflow-fixture";

const image: Attachment = {
  kind: "image",
  name: "capture.png",
  mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1sAAAAASUVORK5CYII=",
};
const text: Attachment = { kind: "text", name: "notes.txt", text: "Original attachment" };
const file: Attachment = { kind: "file", name: "report.pdf", path: "/tmp/report.pdf" };

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("omits empty payloads and shows the exact live count, including large counts", () => {
  const { rerender } = render(<QueuedAttachmentIndicator attachments={[]} />);
  expect(screen.queryByRole("button")).toBeNull();
  rerender(<QueuedAttachmentIndicator attachments={[image, text]} />);
  expect(screen.getByRole("button", { name: "View 2 attachments" }).textContent).toBe("2");
  rerender(<QueuedAttachmentIndicator attachments={Array.from({ length: 123 }, () => file)} />);
  expect(screen.getByRole("button", { name: "View 123 attachments" }).textContent).toBe("123");
  rerender(<QueuedAttachmentIndicator attachments={[file]} />);
  expect(screen.getByRole("button", { name: "View 1 attachment" }).textContent).toBe("1");
  rerender(<QueuedAttachmentIndicator attachments={[]} />);
  expect(screen.queryByRole("button")).toBeNull();
});

it("uses normal image thumbnails and filename tiles on hover without stealing focus", () => {
  render(<QueuedAttachmentIndicator attachments={[image, text, file]} />);
  const button = screen.getByRole("button", { name: "View 3 attachments" });
  const focusBefore = document.activeElement;
  fireEvent.mouseEnter(button);
  const preview = screen.getByRole("dialog", { name: "Queued message 3 attachments" });
  expect(button.getAttribute("aria-expanded")).toBe("true");
  expect(document.activeElement).toBe(focusBefore);
  const thumbnail = within(preview).getByRole("img", { name: image.name });
  expect(thumbnail.getAttribute("src")).toBe(`data:${image.mimeType};base64,${image.data}`);
  expect(thumbnail.closest('[data-slot="attachment-tile"]')).not.toBeNull();
  expect(within(preview).getAllByRole("img")).toHaveLength(1);
  expect(within(preview).getByText(text.name)).toBeDefined();
  expect(within(preview).getByText(file.name)).toBeDefined();
  expect(preview.querySelectorAll('[data-slot="attachment-tile"]')).toHaveLength(3);
});

it("keeps the preview reachable across the portal gap and dismisses after leaving", () => {
  vi.useFakeTimers();
  render(<QueuedAttachmentIndicator attachments={[image]} />);
  const button = screen.getByRole("button", { name: "View 1 attachment" });
  fireEvent.mouseEnter(button);
  fireEvent.mouseLeave(button);
  act(() => vi.advanceTimersByTime(100));
  fireEvent.mouseEnter(screen.getByRole("dialog"));
  act(() => vi.advanceTimersByTime(200));
  expect(screen.getByRole("dialog")).toBeDefined();
  fireEvent.mouseLeave(screen.getByRole("dialog"));
  act(() => vi.advanceTimersByTime(151));
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("supports keyboard activation, Escape focus return, and click/touch without hover", async () => {
  const user = userEvent.setup();
  render(<QueuedAttachmentIndicator attachments={[file]} />);
  const button = screen.getByRole("button", { name: "View 1 attachment" });
  await user.tab();
  expect(document.activeElement).toBe(button);
  await user.keyboard("{Enter}");
  expect(screen.getByRole("dialog")).toBeDefined();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(button);
  // No preceding mouseenter: the same click activation is used by a touch tap.
  fireEvent.click(button);
  expect(screen.getByRole("dialog")).toBeDefined();
  fireEvent.click(button);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("pins a clicked hover preview until explicit dismissal", () => {
  vi.useFakeTimers();
  render(<QueuedAttachmentIndicator attachments={[image]} />);
  const button = screen.getByRole("button", { name: "View 1 attachment" });
  fireEvent.mouseEnter(button);
  fireEvent.click(button);
  fireEvent.mouseLeave(button);
  act(() => vi.advanceTimersByTime(200));
  expect(screen.getByRole("dialog")).toBeDefined();
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it.each(["queued", "steering"] as const)(
  "leads %s rows, reflects payload edits, and leaves queue actions unchanged",
  async (lane) => {
    const steer = vi.fn().mockResolvedValue({ steering: [], followUp: [] });
    const remove = vi.fn().mockResolvedValue({ steering: [], followUp: [] });
    using fixture = renderQueue(
      [
        queuePart(1, "Inspect these", { lane, attachments: [image, file] }),
        queuePart(2, "No files", { lane }),
      ],
      { sessionChats: { steerQueuedMessage: steer, removeQueuedMessage: remove } },
    );
    const row = screen
      .getAllByRole("listitem")
      .find((row) => row.textContent?.includes("Inspect these"))!;
    const badge = within(row).getByRole("button", { name: "View 2 attachments" });
    expect(row.firstElementChild).toBe(badge);
    fireEvent.mouseEnter(badge);
    expect(screen.getByRole("dialog", { name: "Queued message 2 attachments" })).toBeDefined();
    expect(steer).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    fixture.publish([queuePart(1, "Edited", { lane, attachments: [file] })]);
    expect(screen.getByRole("button", { name: "View 1 attachment" })).toBeDefined();
    expect(screen.queryByRole("img", { name: image.name })).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    await fixture.user.click(screen.getByRole("button", { name: /^Cancel .*: Edited$/ }));
    expect(remove).toHaveBeenCalledOnce();
    expect(steer).not.toHaveBeenCalled();
  },
);
