import { observer } from "r-state-tree/react";
import { ErrorNotice } from "../../../src/renderer/components/error-notice";
import type { ProjectWorkbenchStore } from "../../../src/renderer/stores/ProjectWorkbenchStore";

/** The App's error surface for focused workflows mounted without the full application shell. */
export const WorkbenchErrorNotice = observer(function WorkbenchErrorNotice({
  store,
}: {
  store: ProjectWorkbenchStore;
}) {
  return store.error ? (
    <ErrorNotice title="Session operation" message={store.error} details={store.errorDetails} />
  ) : null;
});
