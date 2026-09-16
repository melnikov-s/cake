import React, { lazy, Suspense, useMemo, useState, type ComponentType } from "react";
import { observer } from "r-state-tree/react";
import type { JsonValue } from "../../ipc/json-contract";
import type { ExtensionCompanionProjection } from "../models/ExtensionUi";
import { Button } from "./ui/button";
import { Callout } from "./ui/callout";
import { LoadingState } from "./ui/loading-state";
import { ExtensionCompanionErrorBoundary } from "./extension-companion-error-boundary";

declare global {
  // Trusted extension companions share Cake's React instance so hooks remain valid.
  var __cakeExtensionReact: typeof React | undefined;
}

interface ExtensionCompanionComponentProps {
  readonly state: JsonValue;
  readonly dispatch: (action: string, value?: JsonValue) => Promise<void>;
  readonly ui: { readonly Button: typeof Button; readonly Callout: typeof Callout };
}

function companionModule(moduleUrl: string) {
  return lazy(async () => {
    globalThis.__cakeExtensionReact = React;
    const imported = await import(/* @vite-ignore */ moduleUrl);
    // SAFETY: main compiles a generated ESM wrapper that statically imports the
    // package's default export, so publication fails before a URL exists when
    // the companion does not provide that export.
    return imported as { default: ComponentType<ExtensionCompanionComponentProps> };
  });
}

export const ExtensionCompanionContribution = observer(function ExtensionCompanionContribution({
  companion,
  onAction,
}: {
  readonly companion: ExtensionCompanionProjection;
  readonly onAction: (action: string, value: JsonValue) => Promise<void>;
}) {
  const [actionError, setActionError] = useState<string>();
  const Companion = useMemo(() => companionModule(companion.moduleUrl), [companion.moduleUrl]);
  const dispatch = async (action: string, value: JsonValue = null) => {
    setActionError(undefined);
    if (!companion.actions.includes(action)) {
      setActionError(`Undeclared companion action: ${action}`);
      return;
    }
    try {
      await onAction(action, value);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <ExtensionCompanionErrorBoundary key={companion.moduleUrl} name={companion.name}>
      <Suspense fallback={<LoadingState label={`Loading ${companion.name}`} />}>
        <Companion
          // SAFETY: companion state entered the Model through the validated
          // ExtensionUi snapshot/event schemas; the Model uses unknown only
          // because r-state-tree's deep Snapshot mapping cannot represent
          // Effect's recursive readonly Json type.
          state={companion.state as JsonValue}
          dispatch={dispatch}
          ui={{ Button, Callout }}
        />
      </Suspense>
      {actionError && (
        <p className="m-0 px-2 pb-2 text-xs text-destructive" role="alert">
          {actionError}
        </p>
      )}
    </ExtensionCompanionErrorBoundary>
  );
});
