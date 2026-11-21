/** @vitest-environment jsdom */
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StoreProvider } from "r-state-tree/react";
import { expect, it, vi } from "vitest";
import type { Client } from "../../../src/renderer/client/Client";
import { ExtensionRequestDialog } from "../../../src/renderer/components/extension-request-dialog";
import { createRendererStoreFixture, unmountOnDispose } from "./renderer-store-fixture";

it("binds allow, deny and cancel to the displayed request across overlapping dialogs", async () => {
  const respondToUi = vi.fn<Client["artifacts"]["respondToUi"]>(async () => undefined);
  using fixture = createRendererStoreFixture({ client: { artifacts: { respondToUi } } });
  const ui = fixture.root.extensionUiStore;
  using _view = unmountOnDispose(
    render(
      <StoreProvider store={fixture.root}>
        <ExtensionRequestDialog />
      </StoreProvider>,
    ),
  );
  const user = userEvent.setup();
  const first = {
    type: "ui-requested",
    sessionId: "project-chat-a",
    operationId: "operation-a",
    uiRequestId: "request-a",
    kind: "select",
    title: "Share first synthetic result?",
    message: "First operation",
    options: [
      { id: "allow", label: "Allow once" },
      { id: "deny", label: "Deny" },
    ],
  } as const;
  const second = {
    ...first,
    sessionId: "project-chat-b",
    operationId: "operation-b",
    uiRequestId: "request-b",
    title: "Share second synthetic result?",
    message: "Second operation",
  } as const;
  act(() => ui.receive(first));
  const firstDialog = within(screen.getByRole("alertdialog", { name: first.title }));
  await user.selectOptions(firstDialog.getByRole("combobox"), "allow");
  act(() => ui.receive(second));
  expect(screen.queryByRole("alertdialog", { name: second.title })).toBeNull();
  expect(firstDialog.getByRole("combobox")).toHaveProperty("value", "allow");
  await user.click(firstDialog.getByRole("button", { name: "Continue" }));
  expect(respondToUi).toHaveBeenNthCalledWith(1, {
    sessionId: first.sessionId,
    operationId: first.operationId,
    uiRequestId: first.uiRequestId,
    value: "allow",
    cancelled: false,
  });

  await act(async () => {
    // Old callbacks and async settlement can arrive after the next dialog mounts.
    await ui.respond(first, "allow");
    await ui.respond(first, undefined, true);
    ui.receive({
      type: "ui-request-settled",
      requestId: first.operationId,
      uiRequestId: first.uiRequestId,
      sessionId: first.sessionId,
    });
  });
  expect(respondToUi).toHaveBeenCalledTimes(1);
  const secondDialog = within(screen.getByRole("alertdialog", { name: second.title }));
  expect(secondDialog.getByRole("combobox")).toHaveProperty("value", "");
  await user.selectOptions(secondDialog.getByRole("combobox"), "deny");
  await user.click(secondDialog.getByRole("button", { name: "Continue" }));
  expect(respondToUi).toHaveBeenNthCalledWith(2, {
    sessionId: second.sessionId,
    operationId: second.operationId,
    uiRequestId: second.uiRequestId,
    value: "deny",
    cancelled: false,
  });
  expect(screen.queryByRole("alertdialog")).toBeNull();
});
