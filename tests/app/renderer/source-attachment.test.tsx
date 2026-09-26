/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { SourceAttachment } from "../../../src/renderer/components/source-attachment";

const location = {
  path: "src/active.ts",
  range: { start: { line: 3 }, end: { line: 4 } },
};

afterEach(() => {
  document.body.replaceChildren();
});

it("opens a source attachment by clicking its surface, while removal stays separate", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onOpen = vi.fn();
  const onRemove = vi.fn();
  act(() =>
    root.render(
      <SourceAttachment
        attachment={{ name: "active.ts", location }}
        onOpen={onOpen}
        onRemove={onRemove}
      />,
    ),
  );

  const open = host.querySelector<HTMLButtonElement>('button[aria-label^="Open "]')!;
  expect(open.textContent).toContain("src/active.ts");
  expect(host.textContent).not.toContain("Open in VS Code");
  act(() => open.click());
  expect(onOpen).toHaveBeenCalledWith(location);
  const remove = host.querySelector<HTMLButtonElement>('button[aria-label^="Remove "]')!;
  act(() => remove.click());
  expect(onRemove).toHaveBeenCalledOnce();
  expect(onOpen).toHaveBeenCalledOnce();
  act(() => root.unmount());
});
