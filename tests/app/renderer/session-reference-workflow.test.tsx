/** @vitest-environment jsdom */
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../../../src/renderer/client/Client";
import { sessionLink } from "../../../src/contracts/conversations/message-reference";
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
    expect(composer.value).toBe(`Before [Session](${sessionLink("second")}) after`);
    expect(second.getByRole<HTMLTextAreaElement>("combobox").value).toBe("Other draft");
    expect(first.getByRole<HTMLButtonElement>("button", { name: "Send" }).disabled).toBe(false);
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
