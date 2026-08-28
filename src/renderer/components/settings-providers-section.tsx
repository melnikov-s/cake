import { observer } from "r-state-tree/react";
import type { ChatConfigurationStore } from "../stores/ChatConfigurationStore";
import type { ProviderSettingsStore } from "../stores/ProviderSettingsStore";
import { Button } from "./ui/button";

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
    <section className="settings-section" aria-labelledby="providers-title">
      <header>
        <div>
          <h2 id="providers-title">Providers</h2>
          <p>Connect the accounts and API keys that make models available to Pi.</p>
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
        <p className="settings-empty">Provider details will appear after a chat is open.</p>
      ) : (
        <div className="provider-list">
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
              <article className="provider-row" key={provider.id}>
                <div className="provider-identity">
                  <span className="provider-monogram">
                    {provider.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span>
                    <strong>{provider.name}</strong>
                    <small>
                      {provider.models.length} {provider.models.length === 1 ? "model" : "models"}
                    </small>
                  </span>
                </div>
                <span className={authenticated ? "provider-state connected" : "provider-state"}>
                  <i />
                  {operation === "login"
                    ? "Connecting…"
                    : operation === "logout"
                      ? "Disconnecting…"
                      : authenticated
                        ? `Connected${connectionLabel ? ` · ${connectionLabel}` : ""}`
                        : "Not connected"}
                </span>
                <div className="provider-actions">
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
