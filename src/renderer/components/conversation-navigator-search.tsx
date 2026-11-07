import { useDeferredValue, useEffect, useState } from "react";
import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import { SearchInput } from "./ui/search-input";

/** Keep urgent input renders separate from the observable query's recursive list work. */
export const ConversationNavigatorSearch = observer(function ConversationNavigatorSearch({
  projectPath,
}: {
  projectPath: string | undefined;
}) {
  const store = useStore(RootStore).conversationNavigatorStore;
  const [query, setQuery] = useState(() => store.query(projectPath));
  const deferredQuery = useDeferredValue(query);

  useEffect(() => {
    // External signal updates are synchronous, even inside startTransition.
    // Publish only after the deferred input render commits, not during typing.
    if (store.query(projectPath) !== deferredQuery) store.setQuery(projectPath, deferredQuery);
  }, [store, projectPath, deferredQuery]);

  return (
    <SearchInput
      className="min-w-0 flex-1"
      label="Search sessions"
      placeholder="Search sessions…"
      value={query}
      onValueChange={setQuery}
    />
  );
});
