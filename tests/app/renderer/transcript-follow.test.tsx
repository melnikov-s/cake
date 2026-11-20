/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { LegendListRef } from "@legendapp/list/react";
import { useTranscriptFollow } from "../../../src/renderer/lib/transcript-follow";

afterEach(cleanup);

function fakeList() {
  // SAFETY: the follow hook only calls cancelScroll, scrollToEnd and getState().listen.
  return {
    cancelScroll: vi.fn(),
    scrollToEnd: vi.fn(async () => undefined),
    getState: () => ({ listen: () => () => undefined }),
  } as unknown as LegendListRef;
}

function Transcript({ list }: { list: LegendListRef }) {
  const ref = useRef<LegendListRef | null>(list);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const follow = useTranscriptFollow({
    list: ref,
    scroller,
    paused: false,
    initiallyFollowing: true,
  });
  return (
    <div ref={setScroller} data-testid="scroller">
      <output>{follow.maintainScrollAtEnd ? "following" : "released"}</output>
      <button type="button" aria-expanded="false">
        Long report
      </button>
      <button type="button" aria-expanded="true">
        Open report
      </button>
      <details>
        <summary>Work log</summary>
      </details>
    </div>
  );
}

it("stops following when the reader expands a disclosure, so its header stays in place", () => {
  const list = fakeList();
  render(<Transcript list={list} />);
  expect(screen.getByRole("status")).toHaveProperty("textContent", "following");
  act(() => fireEvent.click(screen.getByRole("button", { name: "Long report" })));
  expect(screen.getByRole("status")).toHaveProperty("textContent", "released");
  expect(list.cancelScroll).toHaveBeenCalledOnce();
});

it("stops following when the reader opens a details summary", () => {
  render(<Transcript list={fakeList()} />);
  act(() => fireEvent.click(screen.getByText("Work log")));
  expect(screen.getByRole("status")).toHaveProperty("textContent", "released");
});

it("keeps following when the reader collapses content", () => {
  render(<Transcript list={fakeList()} />);
  act(() => fireEvent.click(screen.getByRole("button", { name: "Open report" })));
  expect(screen.getByRole("status")).toHaveProperty("textContent", "following");
});
