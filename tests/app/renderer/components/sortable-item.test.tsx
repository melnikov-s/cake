/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SortableItem } from "../../../../src/renderer/components/ui/sortable-item";

function dragEvent(type: string, dataTransfer: DataTransfer) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  Object.defineProperty(event, "clientY", { value: 0 });
  return event;
}

describe("SortableItem", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("reorders during a drag while its payload is protected", () => {
    const onMove = vi.fn();
    act(() => {
      root.render(
        <>
          <SortableItem id="first" onMove={onMove}>
            {(dragHandleProps) => <button {...dragHandleProps}>First</button>}
          </SortableItem>
          <SortableItem id="second" onMove={onMove}>
            {(dragHandleProps) => <button {...dragHandleProps}>Second</button>}
          </SortableItem>
        </>,
      );
    });

    let source = "";
    let payloadProtected = true;
    let advertisedTypes: string[] = [];
    const dataTransfer = {
      effectAllowed: "uninitialized",
      dropEffect: "none",
      get types() {
        return advertisedTypes;
      },
      setData(type: string, value: string) {
        source = value;
        advertisedTypes = [type];
      },
      getData() {
        return payloadProtected ? "" : source;
      },
    } as unknown as DataTransfer;
    const [first, second] = container.querySelectorAll<HTMLDivElement>("[draggable=true]");

    act(() => first!.dispatchEvent(dragEvent("dragstart", dataTransfer)));
    const dragOver = dragEvent("dragover", dataTransfer);
    act(() => second!.dispatchEvent(dragOver));

    expect(source).toBe("first");
    expect(dragOver.defaultPrevented).toBe(true);
    expect(dataTransfer.dropEffect).toBe("move");
    expect(onMove).toHaveBeenCalledWith("first", "second", "after");

    payloadProtected = false;
    act(() => second!.dispatchEvent(dragEvent("drop", dataTransfer)));
    expect(onMove).toHaveBeenCalledTimes(1);
  });
});
