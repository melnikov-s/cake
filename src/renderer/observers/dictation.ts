import type { Runtime } from "../runtime";
import type { DictationStore } from "../stores/DictationStore";

export const observeDictation = (runtime: Runtime, store: DictationStore) =>
  runtime.observe(
    (client) => client.dictation.observeState(),
    (state) => store.applyState(state),
    { reportFailure: (error) => store.reportError(error) },
  );
