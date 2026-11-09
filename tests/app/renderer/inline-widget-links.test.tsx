/** @vitest-environment jsdom */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InlineWidgetFrame } from "../../../src/renderer/components/inline-widget-frame";
import { MarkdownLinkProvider } from "../../../src/renderer/components/ai-elements/markdown";

afterEach(cleanup);

const token = "00000000-0000-4000-8000-000000000001";
const nextToken = "00000000-0000-4000-8000-000000000002";

function setup() {
  const actions = {
    openExternalUrl: vi.fn(),
    openArtifact: vi.fn(),
    openSession: vi.fn(),
    openSubagent: vi.fn(),
    sessionIds: () => ["session-full-id"],
  };
  const content = (activeToken: string) => (
    <MarkdownLinkProvider actions={actions}>
      <InlineWidgetFrame
        title="Links"
        compiled={{ token: activeToken, url: `cake-widget://document/${activeToken}` }}
      />
    </MarkdownLinkProvider>
  );
  const view = render(content(token));
  const frame = view.container.querySelector("iframe")!;
  const post = (data: unknown, source: MessageEventSource | null = frame.contentWindow) =>
    act(() => window.dispatchEvent(new MessageEvent("message", { source, data })));
  const request = (url: string, activeToken = token) => ({
    source: "cake-inline-widget",
    token: activeToken,
    type: "open-link",
    value: { url },
  });
  return { actions, frame, post, request, replace: () => view.rerender(content(nextToken)) };
}

describe("inline widget scroll intent host binding", () => {
  it("forwards only authenticated directions from the mounted frame, without link capabilities", () => {
    const view = render(
      <InlineWidgetFrame
        title="Input"
        compiled={{ token, url: `cake-widget://document/${token}` }}
      />,
    );
    const frame = view.container.querySelector("iframe")!;
    const readerInput = vi.fn();
    view.container.addEventListener("transcript-reader-input", readerInput);
    const post = (
      value: unknown,
      activeToken = token,
      source: MessageEventSource | null = frame.contentWindow,
    ) =>
      act(() =>
        window.dispatchEvent(
          new MessageEvent("message", {
            source,
            data: { source: "cake-inline-widget", token: activeToken, type: "scroll-input", value },
          }),
        ),
      );
    post(-1, token, window);
    post(-1, nextToken);
    for (const value of [null, "up", -100, {}, true]) post(value);
    expect(readerInput).not.toHaveBeenCalled();
    for (const value of [-1, 0, 1]) post(value);
    expect(readerInput.mock.calls.map(([event]) => event.detail)).toEqual([-1, 0, 1]);
    expect(readerInput.mock.calls.every(([event]) => event.target === frame)).toBe(true);
    view.unmount();
    post(-1);
    expect(readerInput).toHaveBeenCalledTimes(3);
  });
});

describe("inline widget link host binding", () => {
  it("opens once through the hosting view and ignores other sources, tokens and malformed URLs", () => {
    const { actions, post, request, frame } = setup();
    post(request("https://example.com/docs"), window);
    post(request("https://example.com/docs", nextToken));
    post(request("not a URL"));
    post({ ...request("https://example.com/docs"), value: { url: 42 } });
    expect(actions.openExternalUrl).not.toHaveBeenCalled();
    post(request("https://example.com/docs"));
    expect(actions.openExternalUrl).toHaveBeenCalledExactlyOnceWith("https://example.com/docs");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  });

  it("rejects replaced compilation tokens and unmounted frames", () => {
    const { actions, post, request, replace } = setup();
    replace();
    post(request("https://example.com/old"));
    post(request("https://example.com/current", nextToken));
    expect(actions.openExternalUrl).toHaveBeenCalledExactlyOnceWith("https://example.com/current");
    cleanup();
    post(request("https://example.com/unmounted", nextToken));
    expect(actions.openExternalUrl).toHaveBeenCalledTimes(1);
  });

  it("keeps Cake artifact, session, message and attachment navigation in the hosting view", () => {
    const { actions, post, request } = setup();
    post(request("cake://artifact/report@r2"));
    post(request("cake://session/session-full-id?message=entry"));
    post(request("cake://session/session-full-id?attachment=00000000-0000-4000-8000-000000000003"));
    expect(actions.openArtifact).toHaveBeenCalledExactlyOnceWith("cake://artifact/report@r2");
    expect(actions.openSession.mock.calls).toEqual([
      ["session-full-id", "entry", undefined],
      ["session-full-id", undefined, "00000000-0000-4000-8000-000000000003"],
    ]);
    expect(actions.openExternalUrl).not.toHaveBeenCalled();
  });

  it("leaves scheme policy to the existing external host capability", () => {
    const { actions, post, request } = setup();
    for (const url of ["mailto:hello@example.com", "file:///tmp/file", "javascript:alert(1)"])
      post(request(url));
    expect(actions.openExternalUrl.mock.calls.map(([url]) => url)).toEqual([
      "mailto:hello@example.com",
      "file:///tmp/file",
      "javascript:alert(1)",
    ]);
  });
});
