import { useState, type FormEvent } from "react";
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationDescription,
  ConfirmationRequest,
  ConfirmationTitle,
} from "./ai-elements/confirmation";
import type { ExtensionUiStore, UiRequestState } from "../stores/ExtensionUiStore";

export function UiDialog({
  request,
  extensionUi,
}: {
  request: UiRequestState;
  extensionUi: ExtensionUiStore;
}) {
  const [value, setValue] = useState(
    request.kind === "confirm" ? "true" : (request.initialValue ?? ""),
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void extensionUi.respond(value);
  };
  return (
    <Confirmation
      state="requested"
      role="alertdialog"
      aria-labelledby="ui-title"
      aria-describedby="ui-message"
    >
      <ConfirmationRequest>
        <form onSubmit={submit}>
          <ConfirmationTitle id="ui-title">{request.title}</ConfirmationTitle>
          <ConfirmationDescription id="ui-message">{request.message}</ConfirmationDescription>
          {request.kind === "select" ? (
            <select
              className="dialog-field"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              required
            >
              <option value="">Select…</option>
              {request.options?.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : request.multiline ? (
            <textarea
              className="dialog-field dialog-editor"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={request.placeholder}
              autoFocus
            />
          ) : request.kind !== "confirm" ? (
            <input
              className="dialog-field"
              type={request.kind === "secret" ? "password" : "text"}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={request.placeholder}
              autoFocus
            />
          ) : null}
          <ConfirmationActions>
            <ConfirmationAction
              variant="outline"
              onClick={() => void extensionUi.respond(undefined, true)}
            >
              Cancel
            </ConfirmationAction>
            {request.kind === "confirm" && (
              <ConfirmationAction
                variant="outline"
                onClick={() => void extensionUi.respond("false")}
              >
                Decline
              </ConfirmationAction>
            )}
            <ConfirmationAction type="submit">
              {request.kind === "confirm" ? "Confirm" : "Continue"}
            </ConfirmationAction>
          </ConfirmationActions>
        </form>
      </ConfirmationRequest>
    </Confirmation>
  );
}
