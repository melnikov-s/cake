/** @vitest-environment jsdom */
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Attachment, UiPart } from "../../../src/contracts/conversations/session-contract";
import { projectSessionEntries } from "../../../src/services/pi/runtime/session-projection";
import { promptText } from "../../../src/services/pi/runtime/user-message-transport";
import {
  transcriptItemParts,
  groupTranscriptParts,
} from "../../../src/renderer/components/chat-transcript-items";
import { orderingAnnotation, orderingFile } from "../../fixtures/user-message-content";
import { renderTranscriptRendering } from "./transcript-rendering-workflow-fixture";

afterEach(cleanup);

function parts(body: string, file: boolean, annotation: boolean): UiPart[] {
  const attachments: Attachment[] = [
    // Deliberately put annotations first in transport; display order is semantic.
    ...(annotation ? [{ kind: "annotation" as const, annotations: [orderingAnnotation] }] : []),
    ...(file ? [orderingFile] : []),
  ];
  return projectSessionEntries([
    {
      type: "message",
      id: "input",
      parentId: null,
      timestamp: new Date(0).toISOString(),
      message: { role: "user", timestamp: 0, content: promptText(body, attachments) },
    },
  ]);
}

function assertOrder(container: HTMLElement, file: boolean, annotation: boolean, body: string) {
  const message = container.querySelector('[data-slot="message"]')!;
  expect(message).not.toBeNull();
  expect(within(message as HTMLElement).getAllByText("You", { exact: true })).toHaveLength(1);
  const actual = Array.from(
    message.querySelectorAll(
      '[data-slot="message-label"], [data-part-id], [data-slot="message-content"]',
    ),
    (element) => {
      if (element.getAttribute("data-slot") === "message-label") return "author";
      if (element.getAttribute("data-slot") === "message-content") return "body";
      return element.querySelector('[aria-label="View 1 annotation"]')
        ? "annotations"
        : "attachments";
    },
  );
  expect(actual).toEqual([
    "author",
    ...(file ? ["attachments"] : []),
    ...(annotation ? ["annotations"] : []),
    ...(body.trim() ? ["body"] : []),
  ]);
  expect(message.querySelectorAll('[data-slot="message-content"]')).toHaveLength(
    body.trim() ? 1 : 0,
  );
  if (!body.trim()) {
    const actions = message.querySelector('[aria-label="User actions"]');
    if (actions) expect(actions.classList.contains("absolute")).toBe(true);
  }
}

describe("shared human message content order", () => {
  it.each([
    ["annotation only", false, true, ""],
    ["attachment only", true, false, ""],
    ["both without body", true, true, ""],
    ["both with body", true, true, "Read this content"],
    ["annotation with body", false, true, "Read this annotation"],
    ["attachment with body", true, false, "Read this file"],
    ["ordinary text", false, false, "Just text"],
    ["whitespace body", true, true, "   "],
  ] as const)(
    "%s: author, attachments, annotations, optional body, once",
    async (_name, file, annotation, body) => {
      using fixture = renderTranscriptRendering(parts(body, file, annotation));
      assertOrder(fixture.container, file, annotation, body);
      expect(screen.queryAllByRole("button", { name: "Copy message" })).toHaveLength(
        body.trim() ? 1 : 0,
      );
      if (annotation) {
        await fixture.user.click(screen.getByRole("button", { name: "View 1 annotation" }));
        expect(screen.getByText(orderingAnnotation.comment!)).toBeDefined();
      }
    },
  );

  it.each(["original", "imported"] as const)(
    "uses the same composition in %s history",
    async (context) => {
      const input = parts("Read this content", true, true).map((part) => ({
        ...part,
        ...(context === "original"
          ? { originalHistory: true }
          : {
              sideChatImport: {
                groupId: "merge",
                threadId: "thread",
                title: "Notes",
                sourceSessionId: "side",
                sourceEntryId: "input",
                sourceTimestamp: 0,
                importedAt: 1,
              },
            }),
      }));
      using fixture = renderTranscriptRendering(input);
      if (context === "imported")
        await fixture.user.click(
          screen.getByRole("button", { name: "Merged from Notes 1 messages" }),
        );
      else expect(screen.queryByText("Original history")).toBeNull();
      assertOrder(fixture.container, true, true, "Read this content");
    },
  );

  it("suppresses truly empty human rows without suppressing submitted annotations", () => {
    using fixture = renderTranscriptRendering([
      { id: "empty", kind: "text", role: "user", text: "", status: "complete" },
      { id: "whitespace", kind: "text", role: "user", text: "   ", status: "complete" },
      ...parts("", false, true),
    ]);
    expect(fixture.container.querySelectorAll('[data-slot="transcript-item"]')).toHaveLength(1);
    assertOrder(fixture.container, false, true, "");
  });

  it("keeps each original part identity discoverable for selection and navigation", () => {
    const input = parts("Read this content", true, true);
    const grouped = groupTranscriptParts(input);
    expect(grouped).toHaveLength(1);
    expect(new Set(transcriptItemParts(grouped[0]!).map((part) => part.id))).toEqual(
      new Set(input.map((part) => part.id)),
    );
    expect(input[0]?.kind === "text" && input[0].text).toBe("Read this content");
  });
});
