/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { MarkdownLinkProvider } from "../../../src/renderer/components/ai-elements/markdown";
import { SessionIdLink } from "../../../src/renderer/components/ui/session-id-link";

afterEach(cleanup);

it("links bare identity metadata with canonical destinations, including collisions outside the displayed page", async () => {
  const id = "01957936-0000-7000-8000-0001f80c961e";
  const other = "01957936-0000-7000-8000-0002f80c961e";
  const openSession = vi.fn();
  render(
    <MarkdownLinkProvider
      actions={{
        openSession,
        openExternalUrl: vi.fn(),
        sessionIds: () => [id, other],
      }}
    >
      <SessionIdLink sessionId={id} knownSessionIds={[id]} />
    </MarkdownLinkProvider>,
  );
  const link = screen.getByRole("link", { name: "1f80c961e" });
  expect(link.getAttribute("href")).toBe(`cake://session/${id}`);
  expect(link.getAttribute("aria-description")).toBe(`cake://session/${id}`);
  await userEvent.setup().click(link);
  expect(openSession).toHaveBeenCalledWith(id);
});

it("retains a full destination when no conversation navigation provider is mounted", () => {
  const id = "01957936-0000-7000-8000-0001f80c961e";
  render(<SessionIdLink sessionId={id} />);
  expect(screen.getByRole("link", { name: "f80c961e" }).getAttribute("href")).toBe(
    `cake://session/${id}`,
  );
});
