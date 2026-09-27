import { useState, type FormEvent } from "react";
import { Button } from "./ui/button";
import { Callout } from "./ui/callout";
import { Input } from "./ui/input";
import { Select } from "./ui/select";
import { Textarea } from "./ui/textarea";
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationDescription,
  ConfirmationRequest,
  ConfirmationTitle,
} from "./ai-elements/confirmation";
import type { ExtensionUiStore, UiRequestState } from "../stores/ExtensionUiStore";
import type { ProviderAuthNotice } from "../stores/ProviderSettingsStore";

export function UiDialog({
  request,
  extensionUi,
  authNotice,
  openAuthUrl,
}: {
  request: UiRequestState;
  extensionUi: ExtensionUiStore;
  authNotice?: ProviderAuthNotice;
  openAuthUrl?: (url: string) => void;
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
          {authNotice?.type === "device_code" && authNotice.verificationUri && (
            <Callout variant="info" className="mt-3 break-all">
              <p>Open the verification page on this device and enter this code:</p>
              <p className="select-text font-mono">{authNotice.userCode}</p>
              <p className="select-text font-mono">{authNotice.verificationUri}</p>
              <Button
                variant="outline"
                size="sm"
                type="button"
                className="justify-self-start"
                onClick={() => openAuthUrl?.(authNotice.verificationUri!)}
              >
                Open verification page on this device
              </Button>
            </Callout>
          )}
          {authNotice?.type === "auth_url" && authNotice.url && (
            <Callout variant="info" className="mt-3 break-all">
              <p className="break-normal">
                {authNotice.instructions ?? "Complete sign-in on this device."}
              </p>
              <p className="select-text font-mono">{authNotice.url}</p>
              <Button
                variant="outline"
                size="sm"
                type="button"
                className="justify-self-start"
                onClick={() => openAuthUrl?.(authNotice.url!)}
              >
                Open sign-in page on this device
              </Button>
            </Callout>
          )}
          {request.kind === "select" ? (
            <Select
              aria-label={request.title}
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
            </Select>
          ) : request.multiline ? (
            <Textarea
              aria-label={request.title}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={request.placeholder}
              autoFocus
            />
          ) : request.kind !== "confirm" ? (
            <Input
              aria-label={request.title}
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
