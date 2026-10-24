import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { VirtuosoMockContext } from "react-virtuoso";

/** Content proof only. Native layout, alignment and scrolling belong in Electron tests. */
export function renderTranscriptContent(content: ReactElement) {
  return render(
    <VirtuosoMockContext.Provider value={{ viewportHeight: 2400, itemHeight: 100 }}>
      {content}
    </VirtuosoMockContext.Provider>,
  );
}
