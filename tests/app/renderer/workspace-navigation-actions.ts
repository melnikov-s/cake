import { screen, waitFor, within } from "@testing-library/react";
import type userEvent from "@testing-library/user-event";
import { expect } from "vitest";

type User = ReturnType<typeof userEvent.setup>;

/** Cross-project navigation through the real global session picker, not hidden source-list rows. */
export async function openSessionFromSearch(user: User, name: RegExp) {
  await user.click(screen.getByRole("button", { name: "Search sessions" }));
  const dialog = within(screen.getByRole("dialog", { name: "Search sessions" }));
  const option = dialog.getByRole("option", { name });
  const sessionId = option.closest<HTMLElement>("[data-session-id]")?.dataset.sessionId;
  await user.click(option);
  await waitFor(() =>
    expect(
      document.querySelector('[data-slot="session-pane"]')?.getAttribute("data-session-id"),
    ).toBe(sessionId),
  );
}

export async function createSessionInProject(user: User, name: RegExp) {
  await showSessions(user);
  await user.click(screen.getByRole("button", { name: "New Session" }));
  await user.click(
    within(screen.getByRole("dialog", { name: "New session" })).getByRole("option", { name }),
  );
}

export async function showSessions(user: User) {
  const back = screen.queryByRole("button", { name: "Back to chat" });
  if (back) await user.click(back);
  const open = screen.queryByRole("button", { name: "Open Workspace" });
  if (open) await user.click(open);
  await user.click(screen.getByRole("button", { name: /^Sessions / }));
  return within(screen.getByRole("region", { name: "Sessions" }));
}
