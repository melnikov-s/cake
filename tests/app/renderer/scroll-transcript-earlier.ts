import { fireEvent } from "@testing-library/react";

/** Supply native geometry at the jsdom boundary, then make a reader approach.
 * Real Virtuoso measurement and offset preservation live in the Electron smoke. */
export function scrollTranscriptEarlier(indicator: HTMLElement) {
  const scroller = indicator.closest<HTMLElement>(".transcript")!;
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, value: 600 },
    scrollHeight: { configurable: true, value: 4000 },
  });
  const list = scroller.querySelector<HTMLElement>('[aria-label="Conversation"]');
  if (list) list.style.visibility = "visible";
  scroller.scrollTop = 800;
  fireEvent.scroll(scroller);
  fireEvent.wheel(scroller, { deltaY: -680 });
  scroller.scrollTop = 120;
  fireEvent.scroll(scroller);
}
