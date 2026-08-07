import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationDeclined,
  ConfirmationRequest
} from "./confirmation";

describe("Cake confirmation presentation", () => {
  it("renders only the content for its Cake-owned state", () => {
    const markup = renderToStaticMarkup(
      <Confirmation state="requested">
        <ConfirmationRequest>Waiting for response</ConfirmationRequest>
        <ConfirmationAccepted>Accepted</ConfirmationAccepted>
        <ConfirmationDeclined>Declined</ConfirmationDeclined>
      </Confirmation>
    );

    expect(markup).toContain("Waiting for response");
    expect(markup).not.toContain("Accepted");
    expect(markup).not.toContain("Declined");
  });
});
