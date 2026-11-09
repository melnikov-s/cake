/** @vitest-environment jsdom */
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../../../src/renderer/client/Client";
import { sessionLink } from "../../../src/contracts/conversations/message-reference";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import type { ComposerInputElement } from "../../../src/renderer/lib/composer-input-element";
import { renderChatConfiguration } from "./chat-configuration-workflow-fixture";

afterEach(cleanup);

describe("composer session references", () => {
  it("reuses the capture destination rows and disclosures, replacing only the selection without changing either conversation", async () => {
    const showComposerContextMenu = vi.fn<Client["electron"]["showComposerContextMenu"]>(
      async () => "insert-session",
    );
    using fixture = renderChatConfiguration({
      secondaryModels: [],
      client: { electron: { showComposerContextMenu } },
    });
    const first = within(screen.getByRole("region", { name: "First conversation" }));
    const second = within(screen.getByRole("region", { name: "Second conversation" }));
    const composer = first.getByRole<HTMLTextAreaElement>("combobox");
    await fixture.user.type(second.getByRole("combobox"), "Other draft");
    await fixture.user.type(composer, "Before replace after");
    composer.setSelectionRange(7, 14);
    fireEvent.contextMenu(composer);
    const picker = await screen.findByRole("dialog", { name: "Session reference" });
    expect(showComposerContextMenu).toHaveBeenCalledWith(
      expect.objectContaining({ selection: "replace", canInsertSession: true }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await fixture.user.click(within(picker).getByRole("button", { name: "Collapse Project" }));
    expect(picker.querySelector('[data-session-id="second"]')).toBeNull();
    await fixture.user.click(within(picker).getByRole("button", { name: "Expand Project" }));
    const row = picker.querySelector<HTMLElement>('[data-session-id="second"]')!;
    await fixture.user.click(within(row).getByRole("button"));
    expect(screen.queryByRole("dialog", { name: "Session reference" })).toBeNull();
    expect(first.getByRole<ComposerInputElement>("combobox").value).toBe(
      `Before [Session](${sessionLink("second")}) after`,
    );
    expect(first.getByRole("button", { name: "Edit session reference: second" }).textContent).toBe(
      "second",
    );
    expect(second.getByRole<HTMLTextAreaElement>("combobox").value).toBe("Other draft");
    expect(first.getByRole<HTMLButtonElement>("button", { name: "Send" }).disabled).toBe(false);
  });

  it("renders named linked controls, reopens on click, replaces only that reference and sends canonical payloads", async () => {
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () =>
      TurnId.make("00000000-0000-4000-8000-000000000012"),
    );
    using fixture = renderChatConfiguration({
      secondaryModels: [],
      sessionTitles: { first: "Review implementation", second: "Check tests" },
      client: {
        electron: { showComposerContextMenu: async () => "insert-session" },
        sessionChats: { prompt },
      },
    });
    const first = within(screen.getByRole("region", { name: "First conversation" }));
    const input = () => first.getByRole<ComposerInputElement>("combobox");
    await fixture.user.type(input(), "Review here");
    input().setSelectionRange(7, 11);
    fireEvent.contextMenu(input());
    const picker = await screen.findByRole("dialog", { name: "Session reference" });
    await fixture.user.click(
      within(picker.querySelector<HTMLElement>('[data-session-id="second"]')!).getByRole("button"),
    );
    const chip = first.getByRole("button", { name: "Edit session reference: Check tests" });
    expect(chip.textContent).toBe("Check tests");
    expect(chip.getAttribute("aria-haspopup")).toBe("dialog");
    expect(chip.querySelectorAll("svg")).toHaveLength(2);
    expect(chip.className).toContain("rounded-full");
    expect(input().value).toBe(`Review [Session](${sessionLink("second")}) `);
    // Insert another reference and edit the first, preserving the second token verbatim.
    input().setSelectionRange(input().value.length, input().value.length);
    fireEvent.contextMenu(input());
    const secondPicker = await screen.findByRole("dialog", { name: "Session reference" });
    await fixture.user.click(
      within(secondPicker.querySelector<HTMLElement>('[data-session-id="second"]')!).getByRole(
        "button",
      ),
    );
    await fixture.user.click(
      first.getAllByRole("button", { name: "Edit session reference: Check tests" })[0]!,
    );
    const reopened = await screen.findByRole("dialog", { name: "Session reference" });
    await fixture.user.click(
      within(reopened.querySelector<HTMLElement>('[data-session-id="first"]')!).getByRole("button"),
    );
    expect(
      first.getByRole("button", { name: "Edit session reference: Review implementation" }),
    ).toBeTruthy();
    expect(first.getByRole("button", { name: "Edit session reference: Check tests" })).toBeTruthy();
    const text = `Review [Session](${sessionLink("first")}) [Session](${sessionLink("second")}) `;
    expect(input().value).toBe(text);
    expect(fixture.chatStore.draft).toBe(text);
    await fixture.user.click(first.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(prompt).toHaveBeenCalledOnce());
    expect(prompt.mock.calls[0]![0]).toMatchObject({ sessionId: "first", text: text.trim() });
    await waitFor(() => expect(fixture.chatStore.draft).toBe(""));
  });

  it("dismisses without changing the draft and does not overwrite edits made while the picker is open", async () => {
    using fixture = renderChatConfiguration({
      client: { electron: { showComposerContextMenu: async () => "insert-session" } },
    });
    const composer = screen.getByRole<HTMLTextAreaElement>("combobox");
    await fixture.user.type(composer, "Keep this draft");
    fireEvent.contextMenu(composer);
    await screen.findByRole("dialog", { name: "Session reference" });
    await fixture.user.keyboard("{Escape}");
    expect(composer.value).toBe("Keep this draft");
    expect(screen.queryByRole("dialog", { name: "Session reference" })).toBeNull();
    fireEvent.contextMenu(composer);
    const picker = await screen.findByRole("dialog", { name: "Session reference" });
    fireEvent.change(composer, { target: { value: "Newer draft" } });
    const row = picker.querySelector<HTMLElement>('[data-session-id="first"]')!;
    await fixture.user.click(within(row).getByRole("button"));
    expect(composer.value).toBe("Newer draft");
    expect(screen.queryByRole("dialog", { name: "Session reference" })).toBeNull();
  });
});
