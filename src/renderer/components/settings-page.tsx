import { observer } from "r-state-tree/react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Callout } from "./ui/callout";
import { Select } from "./ui/select";
import { ChatConfigurationSelector } from "./chat-configuration-selector";
import { ModelPicker } from "./model-picker";
import { ModelPresetSettings } from "./model-preset-settings";
import { PluginSettings } from "./plugin-settings";
import { SettingsLinesField } from "./settings/settings-lines-field";
import { SettingsPackagesField } from "./settings/settings-packages-field";
import { SettingsTextField } from "./settings/settings-text-field";

function queueMode(value: string) {
  if (value === "one-at-a-time" || value === "all") return value;
  throw new Error("Unsupported queue mode");
}

function transportMode(value: string) {
  if (value === "sse" || value === "websocket" || value === "websocket-cached" || value === "auto")
    return value;
  throw new Error("Unsupported transport mode");
}

function projectTrust(value: string) {
  if (value === "ask" || value === "always" || value === "never") return value;
  throw new Error("Unsupported project trust mode");
}
import { SettingsToggle } from "./settings/settings-toggle";
import { SettingsAppearanceSection } from "./settings-appearance-section";
import { SettingsProvidersSection } from "./settings-providers-section";
import type { ChatConfigurationStore } from "../stores/ChatConfigurationStore";
import type { CustomizationStore } from "../stores/CustomizationStore";
import type { ProjectWorkbenchStore } from "../stores/ProjectWorkbenchStore";
import type { SettingsStore } from "../stores/SettingsStore";

export const SettingsPage = observer(function SettingsPage({
  store,
  settings,
  configuration,
  customization,
}: {
  store: ProjectWorkbenchStore;
  settings: SettingsStore;
  configuration?: ChatConfigurationStore;
  customization: CustomizationStore;
}) {
  const pi = store.session?.piSettings;
  const authNotice = store.activeSession?.canonicalParts.find(
    (part) => part.kind === "notice" && part.id === "auth-status",
  );
  const providers = settings.providers;
  const utility = settings.utilityModel;
  const appearance = settings.appearance;
  const error = settings.error ?? configuration?.error ?? store.error;
  const providerGroups = configuration?.modelsByProvider ?? [];
  const utilityModel = utility.model;
  return (
    <div className="mx-auto max-w-4xl px-6 py-8 pb-16">
      <div className="mb-8">
        <span className="text-xs font-medium text-accent">Cake / Pi</span>
        <h1 className="mt-1 text-2xl font-bold text-foreground">Settings</h1>
        <p className="mt-1.5 text-xs text-muted-foreground">
          Configure the same Pi runtime used by the CLI. These preferences are saved by Pi and
          follow you across projects.
        </p>
      </div>
      {error && (
        <Callout variant="error" className="mb-4">
          <strong>Operation failed</strong>
          <span className="text-xs">{error}</span>
        </Callout>
      )}
      {authNotice?.kind === "notice" && (
        <Callout
          variant={
            authNotice.tone === "error"
              ? "error"
              : authNotice.tone === "warning"
                ? "warning"
                : "default"
          }
          className="mb-4"
        >
          <strong>{authNotice.title}</strong>
          <span className="text-xs">{authNotice.detail}</span>
        </Callout>
      )}

      <section className="border-t border-border py-5" aria-labelledby="pi-settings-title">
        <header className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 id="pi-settings-title" className="text-[15px] font-semibold text-foreground">
              Current chat
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Model and reasoning changes apply to this chat and become Pi’s defaults.
            </p>
          </div>
        </header>
        {store.session && configuration ? (
          <div className="flex items-center justify-between gap-6 text-sm">
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <strong className="text-xs font-medium text-foreground">Model configuration</strong>
              <small className="text-[11px] text-muted-foreground">
                The model, reasoning effort, and priority mode for this chat.
              </small>
            </span>
            <ChatConfigurationSelector configuration={configuration} />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Open a project or start a one-off chat to choose a model and reasoning level.
          </p>
        )}
      </section>

      <ModelPresetSettings settings={settings.modelPresets} />

      <section className="border-t border-border py-5" aria-labelledby="default-model-title">
        <header className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 id="default-model-title" className="text-[15px] font-semibold text-foreground">
              Default agent model
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Pi’s own default profile for new project chats and plugin agents.
            </p>
          </div>
          <Badge variant="outline" size="xs" className="text-muted-foreground">
            Pi global
          </Badge>
        </header>
        {pi ? (
          <div className="flex items-center justify-between gap-6 text-sm">
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <strong className="text-xs font-medium text-foreground">Model & reasoning</strong>
              <small className="text-[11px] text-muted-foreground">
                The default model and reasoning profile for new project chats and plugin agents.
              </small>
            </span>
            <ModelPicker
              ariaLabel="Default agent model"
              placeholder="Choose default model"
              groups={configuration?.connectedModelsByProvider ?? []}
              value={
                pi.defaultProvider && pi.defaultModel
                  ? {
                      provider: pi.defaultProvider,
                      modelId: pi.defaultModel,
                      thinkingLevel: pi.defaultThinkingLevel,
                    }
                  : undefined
              }
              showFastMode={false}
              onSelect={({ provider, modelId, thinkingLevel }) => {
                void providers.setPiSetting({
                  key: "defaultModel",
                  provider,
                  modelId,
                });
                void providers.setPiSetting({
                  key: "defaultThinkingLevel",
                  value: thinkingLevel,
                });
              }}
            />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Open a chat to load Pi’s defaults.</p>
        )}
      </section>

      <section className="border-t border-border py-5" aria-labelledby="utility-model-title">
        <header className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 id="utility-model-title" className="text-[15px] font-semibold text-foreground">
              Utility model
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Runs user-configured, lightweight background tasks such as naming sessions.
            </p>
          </div>
          <Badge variant="outline" size="xs" className="text-muted-foreground">
            Cake
          </Badge>
        </header>
        <div className="flex items-center justify-between gap-6 text-sm">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <strong className="text-xs font-medium text-foreground">Model & reasoning</strong>
            <small className="text-[11px] text-muted-foreground">
              When unset, Cake makes no utility calls and session lists use the truncated first
              message.
            </small>
          </span>
          <ModelPicker
            ariaLabel="Utility model"
            placeholder="No utility model"
            allowClear
            showFastMode={false}
            groups={providerGroups}
            value={
              utilityModel
                ? {
                    provider: utilityModel.provider,
                    modelId: utilityModel.modelId,
                    thinkingLevel: utilityModel.thinkingLevel,
                  }
                : undefined
            }
            disabled={utility.saving}
            onClear={() => void utility.clear()}
            onSelect={({ provider, modelId, thinkingLevel }) => {
              void utility.select(`${provider}/${modelId}`, thinkingLevel);
            }}
          />
        </div>
      </section>

      <section className="border-t border-border py-5" aria-labelledby="behavior-title">
        <header className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 id="behavior-title" className="text-[15px] font-semibold text-foreground">
              Agent behavior
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Context, reasoning display, and queued message delivery.
            </p>
          </div>
          <Badge variant="outline" size="xs" className="text-muted-foreground">
            Pi global
          </Badge>
        </header>
        {pi ? (
          <div className="grid gap-4">
            <SettingsToggle
              label="Auto-compact"
              description="Compact context automatically when it gets too large."
              checked={pi.autoCompact}
              onChange={(value) => void providers.setPiSetting({ key: "autoCompact", value })}
            />
            <SettingsToggle
              label="Automatic retry"
              description="Retry transient provider failures automatically."
              checked={pi.retryEnabled}
              onChange={(value) => void providers.setPiSetting({ key: "retryEnabled", value })}
            />
            <SettingsToggle
              label="Hide thinking"
              description="Hide reasoning blocks in assistant responses."
              checked={pi.hideThinkingBlock}
              onChange={(value) => void providers.setPiSetting({ key: "hideThinkingBlock", value })}
            />
            <label className="flex items-center justify-between gap-6 text-sm">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <strong className="text-xs font-medium text-foreground">Steering mode</strong>
                <small className="text-[11px] text-muted-foreground">
                  How steering messages are delivered while Pi is working.
                </small>
              </span>
              <Select
                aria-label="Steering mode"
                className="h-8 max-w-xs text-xs"
                value={pi.steeringMode}
                onChange={(event) =>
                  void providers.setPiSetting({
                    key: "steeringMode",
                    value: queueMode(event.target.value),
                  })
                }
              >
                <option value="one-at-a-time">One at a time</option>
                <option value="all">All at once</option>
              </Select>
            </label>
            <label className="flex items-center justify-between gap-6 text-sm">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <strong className="text-xs font-medium text-foreground">Follow-up mode</strong>
                <small className="text-[11px] text-muted-foreground">
                  How queued follow-ups are delivered after Pi stops.
                </small>
              </span>
              <Select
                aria-label="Follow-up mode"
                className="h-8 max-w-xs text-xs"
                value={pi.followUpMode}
                onChange={(event) =>
                  void providers.setPiSetting({
                    key: "followUpMode",
                    value: queueMode(event.target.value),
                  })
                }
              >
                <option value="one-at-a-time">One at a time</option>
                <option value="all">All at once</option>
              </Select>
            </label>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Open a chat to load Pi’s settings.</p>
        )}
      </section>

      <section className="border-t border-border py-5" aria-labelledby="execution-title">
        <header className="mb-4">
          <div>
            <h2 id="execution-title" className="text-[15px] font-semibold text-foreground">
              Execution
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Configure the shell and package command used by Pi.
            </p>
          </div>
        </header>
        {pi ? (
          <div className="grid gap-4">
            <SettingsTextField
              label="Shell path"
              description="Custom shell executable. Leave empty to use Pi’s platform default."
              value={pi.shellPath}
              placeholder="/bin/zsh"
              onApply={(value) => void providers.setPiSetting({ key: "shellPath", value })}
            />
            <SettingsTextField
              label="Shell command prefix"
              description="Command prepended to every Pi shell invocation."
              value={pi.shellCommandPrefix}
              placeholder="Optional"
              onApply={(value) => void providers.setPiSetting({ key: "shellCommandPrefix", value })}
            />
            <SettingsLinesField
              label="npm command"
              description="Command and arguments used for package operations, one argument per line."
              value={pi.npmCommand}
              onApply={(value) => void providers.setPiSetting({ key: "npmCommand", value })}
            />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Open a chat to load Pi’s settings.</p>
        )}
      </section>

      <section className="border-t border-border py-5" aria-labelledby="resources-title">
        <header className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 id="resources-title" className="text-[15px] font-semibold text-foreground">
              Resources
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Configure global Pi packages, extensions, skills, and prompt paths. Changes reload
              automatically.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            type="button"
            disabled={!store.session}
            onClick={() => void providers.reloadPi()}
          >
            {pi?.reloadPending ? "Reload queued" : "Reload Pi"}
          </Button>
        </header>
        {pi ? (
          <div className="grid gap-4">
            <SettingsPackagesField
              value={pi.packages}
              onApply={(value) => void providers.setPiSetting({ key: "packages", value })}
            />
            <SettingsLinesField
              label="Extension paths"
              description="One path, glob, inclusion, or exclusion per line."
              value={pi.extensions}
              onApply={(value) => void providers.setPiSetting({ key: "extensions", value })}
            />
            <SettingsLinesField
              label="Skill paths"
              description="One path, glob, inclusion, or exclusion per line."
              value={pi.skills}
              onApply={(value) => void providers.setPiSetting({ key: "skills", value })}
            />
            <SettingsLinesField
              label="Prompt paths"
              description="One path, glob, inclusion, or exclusion per line."
              value={pi.prompts}
              onApply={(value) => void providers.setPiSetting({ key: "prompts", value })}
            />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Open a chat to load Pi’s settings.</p>
        )}
      </section>

      <PluginSettings store={customization} />

      <section className="border-t border-border py-5" aria-labelledby="content-title">
        <header className="mb-4">
          <div>
            <h2 id="content-title" className="text-[15px] font-semibold text-foreground">
              Content
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Control images, skills, and transcript diagnostics.
            </p>
          </div>
        </header>
        {pi ? (
          <div className="grid gap-4">
            <SettingsToggle
              label="Auto-resize images"
              description="Resize large images for better model compatibility."
              checked={pi.autoResizeImages}
              onChange={(value) => void providers.setPiSetting({ key: "autoResizeImages", value })}
            />
            <SettingsToggle
              label="Block images"
              description="Prevent images from being sent to model providers."
              checked={pi.blockImages}
              onChange={(value) => void providers.setPiSetting({ key: "blockImages", value })}
            />
            <SettingsToggle
              label="Skill commands"
              description="Register discovered skills as /skill:name commands."
              checked={pi.enableSkillCommands}
              onChange={(value) =>
                void providers.setPiSetting({ key: "enableSkillCommands", value })
              }
            />
            <SettingsToggle
              label="Cache miss notices"
              description="Show notices for significant prompt-cache misses."
              checked={pi.showCacheMissNotices}
              onChange={(value) =>
                void providers.setPiSetting({ key: "showCacheMissNotices", value })
              }
            />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Open a chat to load Pi’s settings.</p>
        )}
      </section>

      <section className="border-t border-border py-5" aria-labelledby="network-title">
        <header className="mb-4">
          <div>
            <h2 id="network-title" className="text-[15px] font-semibold text-foreground">
              Network
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Choose Pi’s provider transport and idle timeout.
            </p>
          </div>
        </header>
        {pi ? (
          <div className="grid gap-4">
            <label className="flex items-center justify-between gap-6 text-sm">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <strong className="text-xs font-medium text-foreground">Transport</strong>
                <small className="text-[11px] text-muted-foreground">
                  Preferred transport when a provider supports more than one.
                </small>
              </span>
              <Select
                aria-label="Provider transport"
                className="h-8 max-w-xs text-xs"
                value={pi.transport}
                onChange={(event) =>
                  void providers.setPiSetting({
                    key: "transport",
                    value: transportMode(event.target.value),
                  })
                }
              >
                <option value="auto">Automatic</option>
                <option value="sse">SSE</option>
                <option value="websocket">WebSocket</option>
                <option value="websocket-cached">WebSocket cached</option>
              </Select>
            </label>
            <label className="flex items-center justify-between gap-6 text-sm">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <strong className="text-xs font-medium text-foreground">HTTP idle timeout</strong>
                <small className="text-[11px] text-muted-foreground">
                  Maximum pause while Pi waits for HTTP data.
                </small>
              </span>
              <Select
                aria-label="HTTP idle timeout"
                className="h-8 max-w-xs text-xs"
                value={pi.httpIdleTimeoutMs}
                onChange={(event) =>
                  void providers.setPiSetting({
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
              </Select>
            </label>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Open a chat to load Pi’s settings.</p>
        )}
      </section>

      <section className="border-t border-border py-5" aria-labelledby="safety-title">
        <header className="mb-4">
          <div>
            <h2 id="safety-title" className="text-[15px] font-semibold text-foreground">
              Safety & privacy
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Trust defaults, warnings, and Pi’s optional update telemetry.
            </p>
          </div>
        </header>
        {pi ? (
          <div className="grid gap-4">
            <label className="flex items-center justify-between gap-6 text-sm">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <strong className="text-xs font-medium text-foreground">
                  Default project trust
                </strong>
                <small className="text-[11px] text-muted-foreground">
                  Fallback when no saved trust decision applies.
                </small>
              </span>
              <Select
                aria-label="Default project trust"
                className="h-8 max-w-xs text-xs"
                value={pi.defaultProjectTrust}
                onChange={(event) =>
                  void providers.setPiSetting({
                    key: "defaultProjectTrust",
                    value: projectTrust(event.target.value),
                  })
                }
              >
                <option value="ask">Ask</option>
                <option value="always">Always trust</option>
                <option value="never">Never trust</option>
              </Select>
            </label>
            <SettingsToggle
              label="Anthropic extra usage warning"
              description="Warn when subscription authentication may use paid extra usage."
              checked={pi.anthropicExtraUsageWarning}
              onChange={(value) =>
                void providers.setPiSetting({ key: "anthropicExtraUsageWarning", value })
              }
            />
            <SettingsToggle
              label="Install telemetry"
              description="Send Pi’s anonymous version/update ping after detected updates."
              checked={pi.enableInstallTelemetry}
              onChange={(value) =>
                void providers.setPiSetting({ key: "enableInstallTelemetry", value })
              }
            />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Open a chat to load Pi’s settings.</p>
        )}
      </section>

      <SettingsProvidersSection
        providers={providers}
        providerGroups={providerGroups}
        hasSession={Boolean(store.session)}
      />
      <SettingsAppearanceSection appearance={appearance} />
    </div>
  );
});
