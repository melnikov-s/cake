import { observer } from "r-state-tree/react";
import type { ChatConfigurationStore } from "../stores/ChatConfigurationStore";
import type { ProviderSettingsStore } from "../stores/ProviderSettingsStore";
import { Button } from "./ui/button";
import { StatusDot } from "./ui/status-dot";

export const SettingsProvidersSection = observer(function SettingsProvidersSection({
  providers,
  providerGroups,
  hasSession,
}: {
  providers: ProviderSettingsStore;
  providerGroups: ChatConfigurationStore["modelsByProvider"];
  hasSession: boolean;
}) {
  return (
    <section className="border-t border-border py-5" aria-labelledby="providers-title">
      <header className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 id="providers-title" className="text-[15px] font-semibold text-foreground">
            Providers
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Connect the accounts and API keys that make models available to Pi.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          type="button"
          disabled={!hasSession || providers.refreshingModels}
          onClick={() => void providers.refreshModels()}
        >
          {providers.refreshingModels ? "Refreshing…" : "Refresh models"}
        </Button>
      </header>
      {providerGroups.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Provider details will appear after a chat is open.
        </p>
      ) : (
        <div className="grid gap-3">
          {providerGroups.map((provider) => {
            const authenticated = provider.models.some((model) => model.authenticated);
            const authenticatedModel = provider.models.find((model) => model.authenticated);
            const authSource = authenticatedModel?.authSource;
            const connectionLabel =
              authenticatedModel?.authLabel ??
              (authSource === "environment" ? "environment" : undefined);
            const authTypes = [...new Set(provider.models.flatMap((model) => model.authTypes))];
            const operation = providers.providerOperation(provider.id);
            return (
              <article
                className="flex items-center justify-between gap-4 rounded-xl border border-border bg-muted/50 p-3"
                key={provider.id}
              >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-card font-mono text-xs font-bold text-accent">
                    {provider.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="min-w-0">
                    <strong className="block truncate text-xs font-semibold text-foreground">
                      {provider.name}
                    </strong>
                    <small className="block truncate text-[11px] text-muted-foreground">
                      {provider.models.length} {provider.models.length === 1 ? "model" : "models"}
                    </small>
                  </span>
                </div>
                <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                  <StatusDot
                    status={operation ? "running" : authenticated ? "complete" : "pending"}
                  />
                  <span className={authenticated ? "text-foreground font-medium" : ""}>
                    {operation === "login"
                      ? "Connecting…"
                      : operation === "logout"
                        ? "Disconnecting…"
                        : authenticated
                          ? `Connected${connectionLabel ? ` · ${connectionLabel}` : ""}`
                          : "Not connected"}
                  </span>
                </span>
                <div className="flex shrink-0 items-center gap-2">
                  {authenticated ? (
                    authSource === "stored" || authSource === "runtime" ? (
                      <Button
                        variant="outline"
                        size="sm"
                        type="button"
                        disabled={Boolean(operation)}
                        onClick={() => void providers.logout(provider.id)}
                      >
                        {operation === "logout" ? "Disconnecting…" : "Disconnect"}
                      </Button>
                    ) : (
                      <small
                        className="max-w-48 text-right font-mono text-[10px] text-muted-foreground"
                        title="Remove this credential from its environment or configuration source, then restart Cake."
                      >
                        Remove externally, then restart
                      </small>
                    )
                  ) : (
                    authTypes.map((authType) => (
                      <Button
                        key={authType}
                        variant={authType === "oauth" ? "default" : "outline"}
                        size="sm"
                        type="button"
                        disabled={Boolean(operation)}
                        onClick={() => void providers.authenticate(provider.id, authType)}
                      >
                        {operation === "login"
                          ? "Connecting…"
                          : authType === "oauth"
                            ? "Connect"
                            : "Add API key"}
                      </Button>
                    ))
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
});
