import { observer } from "r-state-tree/react";
import { Button } from "./ui/button";
import { ModelCombobox } from "./model-combobox";
import { ThinkingLevelSelect } from "./thinking-level-select";
import { PluginSettings } from "./plugin-settings";
import { SettingsLinesField } from "./settings/settings-lines-field";
import { SettingsPackagesField } from "./settings/settings-packages-field";
import { SettingsTextField } from "./settings/settings-text-field";
import { SettingsToggle } from "./settings/settings-toggle";
import { piSettingsSchema, thinkingLevelSchema } from "../../ipc/session-contract";
import type { ChatConfigurationStore } from "../stores/ChatConfigurationStore";
import type { CustomizationStore } from "../stores/CustomizationStore";
import type { ProjectWorkbenchStore } from "../stores/ProjectWorkbenchStore";
import type { SettingsStore } from "../stores/SettingsStore";

export const SettingsPage = observer(function SettingsPage({
  store,
  settings,
  configuration,
  customization,
  onViewStateChange,
}: {
  store: ProjectWorkbenchStore;
  settings: SettingsStore;
  configuration?: ChatConfigurationStore;
  customization: CustomizationStore;
  onViewStateChange(): void;
}) {
  const selectedModel = store.session?.model;
  const pi = store.session?.piSettings;
  const authNotice = store.activeSession?.canonicalParts.find(
    (part) => part.kind === "notice" && part.id === "auth-status",
  );
  const error = settings.error ?? configuration?.error ?? store.error;
  const providerGroups = configuration?.modelsByProvider ?? [];
  const utilityModel = settings.utilityModel;
  const utilityModelValue = utilityModel ? `${utilityModel.provider}/${utilityModel.modelId}` : "";
  const defaultModelValue =
    pi?.defaultProvider && pi.defaultModel ? `${pi.defaultProvider}/${pi.defaultModel}` : "";
  return (
    <div className="settings-page">
      <div className="settings-intro">
        <span className="settings-kicker">Cake / Pi</span>
        <h1>Settings</h1>
        <p>
          Configure the same Pi runtime used by the CLI. These preferences are saved by Pi and
          follow you across projects.
        </p>
      </div>
      {error && (
        <div className="notice notice-error" role="alert">
          <strong>Operation failed</strong>
          <span>{error}</span>
        </div>
      )}
      {authNotice?.kind === "notice" && (
        <div className={`notice notice-${authNotice.tone}`} role="status">
          <strong>{authNotice.title}</strong>
          <span>{authNotice.detail}</span>
        </div>
      )}

      <section className="settings-section" aria-labelledby="pi-settings-title">
        <header>
          <div>
            <h2 id="pi-settings-title">Current chat</h2>
            <p>Model and reasoning changes apply to this chat and become Pi’s defaults.</p>
          </div>
          <span className={`settings-runtime status-${store.piState}`}>
            <i />
            {store.piState}
          </span>
        </header>
        {store.session ? (
          <div className="settings-fields">
            <div className="settings-field">
              <span>
                Model<small>The model Pi uses for its next response.</small>
              </span>
              <ModelCombobox
                ariaLabel="Settings model"
                groups={configuration?.connectedModelsByProvider ?? []}
                value={selectedModel ? `${selectedModel.provider}/${selectedModel.id}` : ""}
                onSelect={(value) => void configuration?.selectModel(value)}
                variant="settings"
              />
            </div>
            <label>
              <span>
                Reasoning<small>Controls how much time Pi spends thinking.</small>
              </span>
              <ThinkingLevelSelect
                ariaLabel="Settings thinking level"
                value={store.session.thinkingLevel}
                levels={store.session.availableThinkingLevels}
                onSelect={(level) => void configuration?.selectThinkingLevel(level)}
              />
            </label>
          </div>
        ) : (
          <p className="settings-empty">
            Open a project or start a one-off chat to choose a model and reasoning level.
          </p>
        )}
      </section>

      <section className="settings-section" aria-labelledby="default-model-title">
        <header>
          <div>
            <h2 id="default-model-title">Default agent model</h2>
            <p>Pi’s own default profile for new project chats and plugin agents.</p>
          </div>
          <span className="settings-source">Pi global</span>
        </header>
        {pi ? (
          <div className="settings-fields">
            <div className="settings-field">
              <span>
                Model<small>Used when a plugin requests the default profile.</small>
              </span>
              <ModelCombobox
                ariaLabel="Default agent model"
                groups={configuration?.connectedModelsByProvider ?? []}
                value={defaultModelValue}
                onSelect={(value) => {
                  const separator = value.indexOf("/");
                  if (separator > 0)
                    void settings.setPiSetting({
                      key: "defaultModel",
                      provider: value.slice(0, separator),
                      modelId: value.slice(separator + 1),
                    });
                }}
                variant="settings"
              />
            </div>
            <label>
              <span>
                Reasoning<small>The reasoning effort attached to Pi’s default profile.</small>
              </span>
              <ThinkingLevelSelect
                ariaLabel="Default agent thinking level"
                value={pi.defaultThinkingLevel ?? "off"}
                levels={thinkingLevelSchema.options}
                onSelect={(value) =>
                  void settings.setPiSetting({ key: "defaultThinkingLevel", value })
                }
              />
            </label>
          </div>
        ) : (
          <p className="settings-empty">Open a chat to load Pi’s defaults.</p>
        )}
      </section>

      <section className="settings-section" aria-labelledby="utility-model-title">
        <header>
          <div>
            <h2 id="utility-model-title">Utility model</h2>
            <p>Runs user-configured, lightweight background tasks such as naming sessions.</p>
          </div>
          <span className="settings-source">Cake</span>
        </header>
        <div className="settings-fields">
          <div className="settings-field">
            <span>
              Model
              <small>
                When unset, Cake makes no utility calls and session lists use the truncated first
                message.
              </small>
            </span>
            <span className="settings-inline-action">
              <ModelCombobox
                ariaLabel="Utility model"
                groups={providerGroups}
                value={utilityModelValue}
                onSelect={(value) => void settings.selectUtilityModel(value)}
                variant="settings"
              />
              {utilityModel && (
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  disabled={settings.utilityModelSaving}
                  onClick={() => void settings.clearUtilityModel()}
                >
                  Clear
                </Button>
              )}
            </span>
          </div>
          <label>
            <span>
              Reasoning<small>The reasoning effort sent with utility requests.</small>
            </span>
            <ThinkingLevelSelect
              ariaLabel="Utility model thinking level"
              value={utilityModel?.thinkingLevel ?? "off"}
              levels={thinkingLevelSchema.options}
              disabled={!utilityModel || settings.utilityModelSaving}
              onSelect={(level) => void settings.selectUtilityThinkingLevel(level)}
            />
          </label>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="behavior-title">
        <header>
          <div>
            <h2 id="behavior-title">Agent behavior</h2>
            <p>Context, reasoning display, and queued message delivery.</p>
          </div>
          <span className="settings-source">Pi global</span>
        </header>
        {pi ? (
          <div className="settings-fields">
            <SettingsToggle
              label="Auto-compact"
              description="Compact context automatically when it gets too large."
              checked={pi.autoCompact}
              onChange={(value) => void settings.setPiSetting({ key: "autoCompact", value })}
            />
            <SettingsToggle
              label="Automatic retry"
              description="Retry transient provider failures automatically."
              checked={pi.retryEnabled}
              onChange={(value) => void settings.setPiSetting({ key: "retryEnabled", value })}
            />
            <SettingsToggle
              label="Hide thinking"
              description="Hide reasoning blocks in assistant responses."
              checked={pi.hideThinkingBlock}
              onChange={(value) => void settings.setPiSetting({ key: "hideThinkingBlock", value })}
            />
            <label>
              <span>
                Steering mode<small>How steering messages are delivered while Pi is working.</small>
              </span>
              <select
                aria-label="Steering mode"
                value={pi.steeringMode}
                onChange={(event) =>
                  void settings.setPiSetting({
                    key: "steeringMode",
                    value: piSettingsSchema.shape.steeringMode.parse(event.target.value),
                  })
                }
              >
                <option value="one-at-a-time">One at a time</option>
                <option value="all">All at once</option>
              </select>
            </label>
            <label>
              <span>
                Follow-up mode<small>How queued follow-ups are delivered after Pi stops.</small>
              </span>
              <select
                aria-label="Follow-up mode"
                value={pi.followUpMode}
                onChange={(event) =>
                  void settings.setPiSetting({
                    key: "followUpMode",
                    value: piSettingsSchema.shape.followUpMode.parse(event.target.value),
                  })
                }
              >
                <option value="one-at-a-time">One at a time</option>
                <option value="all">All at once</option>
              </select>
            </label>
          </div>
        ) : (
          <p className="settings-empty">Open a chat to load Pi’s settings.</p>
        )}
      </section>

      <section className="settings-section" aria-labelledby="execution-title">
        <header>
          <div>
            <h2 id="execution-title">Execution</h2>
            <p>Configure the shell and package command used by Pi.</p>
          </div>
        </header>
        {pi ? (
          <div className="settings-fields">
            <SettingsTextField
              label="Shell path"
              description="Custom shell executable. Leave empty to use Pi’s platform default."
              value={pi.shellPath}
              placeholder="/bin/zsh"
              onApply={(value) => void settings.setPiSetting({ key: "shellPath", value })}
            />
            <SettingsTextField
              label="Shell command prefix"
              description="Command prepended to every Pi shell invocation."
              value={pi.shellCommandPrefix}
              placeholder="Optional"
              onApply={(value) => void settings.setPiSetting({ key: "shellCommandPrefix", value })}
            />
            <SettingsLinesField
              label="npm command"
              description="Command and arguments used for package operations, one argument per line."
              value={pi.npmCommand}
              onApply={(value) => void settings.setPiSetting({ key: "npmCommand", value })}
            />
          </div>
        ) : (
          <p className="settings-empty">Open a chat to load Pi’s settings.</p>
        )}
      </section>

      <section className="settings-section" aria-labelledby="resources-title">
        <header>
          <div>
            <h2 id="resources-title">Resources</h2>
            <p>
              Configure global Pi packages, extensions, skills, and prompt paths. Changes reload
              automatically.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            type="button"
            disabled={!store.session}
            onClick={() => void settings.reloadPi()}
          >
            {pi?.reloadPending ? "Reload queued" : "Reload Pi"}
          </Button>
        </header>
        {pi ? (
          <div className="settings-fields">
            <SettingsPackagesField
              value={pi.packages}
              onApply={(value) => void settings.setPiSetting({ key: "packages", value })}
            />
            <SettingsLinesField
              label="Extension paths"
              description="One path, glob, inclusion, or exclusion per line."
              value={pi.extensions}
              onApply={(value) => void settings.setPiSetting({ key: "extensions", value })}
            />
            <SettingsLinesField
              label="Skill paths"
              description="One path, glob, inclusion, or exclusion per line."
              value={pi.skills}
              onApply={(value) => void settings.setPiSetting({ key: "skills", value })}
            />
            <SettingsLinesField
              label="Prompt paths"
              description="One path, glob, inclusion, or exclusion per line."
              value={pi.prompts}
              onApply={(value) => void settings.setPiSetting({ key: "prompts", value })}
            />
          </div>
        ) : (
          <p className="settings-empty">Open a chat to load Pi’s settings.</p>
        )}
      </section>

      <PluginSettings store={customization} />

      <section className="settings-section" aria-labelledby="content-title">
        <header>
          <div>
            <h2 id="content-title">Content</h2>
            <p>Control images, skills, and transcript diagnostics.</p>
          </div>
        </header>
        {pi ? (
          <div className="settings-fields">
            <SettingsToggle
              label="Auto-resize images"
              description="Resize large images for better model compatibility."
              checked={pi.autoResizeImages}
              onChange={(value) => void settings.setPiSetting({ key: "autoResizeImages", value })}
            />
            <SettingsToggle
              label="Block images"
              description="Prevent images from being sent to model providers."
              checked={pi.blockImages}
              onChange={(value) => void settings.setPiSetting({ key: "blockImages", value })}
            />
            <SettingsToggle
              label="Skill commands"
              description="Register discovered skills as /skill:name commands."
              checked={pi.enableSkillCommands}
              onChange={(value) =>
                void settings.setPiSetting({ key: "enableSkillCommands", value })
              }
            />
            <SettingsToggle
              label="Cache miss notices"
              description="Show notices for significant prompt-cache misses."
              checked={pi.showCacheMissNotices}
              onChange={(value) =>
                void settings.setPiSetting({ key: "showCacheMissNotices", value })
              }
            />
          </div>
        ) : (
          <p className="settings-empty">Open a chat to load Pi’s settings.</p>
        )}
      </section>

      <section className="settings-section" aria-labelledby="network-title">
        <header>
          <div>
            <h2 id="network-title">Network</h2>
            <p>Choose Pi’s provider transport and idle timeout.</p>
          </div>
        </header>
        {pi ? (
          <div className="settings-fields">
            <label>
              <span>
                Transport<small>Preferred transport when a provider supports more than one.</small>
              </span>
              <select
                aria-label="Provider transport"
                value={pi.transport}
                onChange={(event) =>
                  void settings.setPiSetting({
                    key: "transport",
                    value: piSettingsSchema.shape.transport.parse(event.target.value),
                  })
                }
              >
                <option value="auto">Automatic</option>
                <option value="sse">SSE</option>
                <option value="websocket">WebSocket</option>
                <option value="websocket-cached">WebSocket cached</option>
              </select>
            </label>
            <label>
              <span>
                HTTP idle timeout<small>Maximum pause while Pi waits for HTTP data.</small>
              </span>
              <select
                aria-label="HTTP idle timeout"
                value={pi.httpIdleTimeoutMs}
                onChange={(event) =>
                  void settings.setPiSetting({
                    key: "httpIdleTimeoutMs",
                    value: Number(event.target.value),
                  })
                }
              >
                <option value={30_000}>30 seconds</option>
                <option value={60_000}>1 minute</option>
                <option value={120_000}>2 minutes</option>
                <option value={300_000}>5 minutes</option>
                <option value={0}>Disabled</option>
              </select>
            </label>
          </div>
        ) : (
          <p className="settings-empty">Open a chat to load Pi’s settings.</p>
        )}
      </section>

      <section className="settings-section" aria-labelledby="safety-title">
        <header>
          <div>
            <h2 id="safety-title">Safety & privacy</h2>
            <p>Trust defaults, warnings, and Pi’s optional update telemetry.</p>
          </div>
        </header>
        {pi ? (
          <div className="settings-fields">
            <label>
              <span>
                Default project trust<small>Fallback when no saved trust decision applies.</small>
              </span>
              <select
                aria-label="Default project trust"
                value={pi.defaultProjectTrust}
                onChange={(event) =>
                  void settings.setPiSetting({
                    key: "defaultProjectTrust",
                    value: piSettingsSchema.shape.defaultProjectTrust.parse(event.target.value),
                  })
                }
              >
                <option value="ask">Ask</option>
                <option value="always">Always trust</option>
                <option value="never">Never trust</option>
              </select>
            </label>
            <SettingsToggle
              label="Anthropic extra usage warning"
              description="Warn when subscription authentication may use paid extra usage."
              checked={pi.anthropicExtraUsageWarning}
              onChange={(value) =>
                void settings.setPiSetting({ key: "anthropicExtraUsageWarning", value })
              }
            />
            <SettingsToggle
              label="Install telemetry"
              description="Send Pi’s anonymous version/update ping after detected updates."
              checked={pi.enableInstallTelemetry}
              onChange={(value) =>
                void settings.setPiSetting({ key: "enableInstallTelemetry", value })
              }
            />
          </div>
        ) : (
          <p className="settings-empty">Open a chat to load Pi’s settings.</p>
        )}
      </section>

      <section className="settings-section" aria-labelledby="providers-title">
        <header>
          <div>
            <h2 id="providers-title">Providers</h2>
            <p>Connect the accounts and API keys that make models available to Pi.</p>
          </div>
        </header>
        {providerGroups.length === 0 ? (
          <p className="settings-empty">Provider details will appear after a chat is open.</p>
        ) : (
          <div className="provider-list">
            {providerGroups.map((provider) => {
              const authenticated = provider.models.some((model) => model.authenticated);
              const authenticatedModel = provider.models.find((model) => model.authenticated);
              const authSource = authenticatedModel?.authSource;
              const externallyManaged = Boolean(
                authenticated && authSource && authSource !== "stored" && authSource !== "runtime",
              );
              const connectionLabel =
                authenticatedModel?.authLabel ??
                (authSource === "environment" ? "environment" : undefined);
              const authTypes = [...new Set(provider.models.flatMap((model) => model.authTypes))];
              const operation = settings.providerOperation(provider.id);
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
                      externallyManaged ? (
                        <small
                          className="provider-managed"
                          title="Remove this credential from its environment or configuration source, then restart Cake."
                        >
                          Remove externally, then restart
                        </small>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          type="button"
                          disabled={Boolean(operation)}
                          onClick={() => void settings.logout(provider.id)}
                        >
                          {operation === "logout" ? "Disconnecting…" : "Disconnect"}
                        </Button>
                      )
                    ) : (
                      authTypes.map((authType) => (
                        <Button
                          key={authType}
                          variant={authType === "oauth" ? "default" : "outline"}
                          size="sm"
                          type="button"
                          disabled={Boolean(operation)}
                          onClick={() => void settings.authenticate(provider.id, authType)}
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

      <section className="settings-section" aria-labelledby="appearance-title">
        <header>
          <div>
            <h2 id="appearance-title">Appearance</h2>
            <p>Choose how Cake looks on this device.</p>
          </div>
        </header>
        <div className="settings-fields">
          <label>
            <span>
              Theme<small>Follow your system or use a fixed appearance.</small>
            </span>
            <select
              aria-label="Color theme"
              value={settings.theme}
              onChange={(event) => {
                const theme = (["system", "light", "dark"] as const).find(
                  (candidate) => candidate === event.target.value,
                );
                if (theme) settings.setTheme(theme);
                onViewStateChange();
              }}
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
        </div>
      </section>
    </div>
  );
});
