import { usePhoneLayout } from "../lib/phone-layout";
import { SettingsCakeChatSection } from "./settings-cake-chat-section";
import { SettingsCakeChatOverlaySection } from "./settings-cake-chat-overlay-section";
import { SettingsMcpSection } from "./settings-mcp-section";
import { SettingsWidgetPackagesSection } from "./settings-widget-packages-section";
import { SettingsDictationSection } from "./settings-dictation-section";
import { SettingsSpeechSection } from "./settings-speech-section";
import { SettingsSpeechInputSection } from "./settings-speech-input-section";
import { SettingsScreenCaptureSection } from "./settings-screen-capture-section";
import { SettingsDesktopHostSection } from "./settings-desktop-host-section";
import { useEffect, useState } from "react";
import { observer } from "r-state-tree/react";
import { Button } from "./ui/button";
import { Callout } from "./ui/callout";
import { NavItem } from "./ui/nav-item";
import { Select } from "./ui/select";
import { ChatConfigurationSelector } from "./chat-configuration-selector";
import { ModelPicker } from "./model-picker";
import { ModelPresetSettings } from "./model-preset-settings";
import { SettingsLinesField } from "./settings/settings-lines-field";
import { SettingsPackagesField } from "./settings/settings-packages-field";
import { SettingsExtensionsSection } from "./settings-extensions-section";
import { SettingsTextField } from "./settings/settings-text-field";
import { Input } from "./ui/input";
import { SearchIcon } from "./ui/icons";
import { SETTINGS_NAV_GROUPS, searchSettings } from "../lib/settings-search";
import { defaultCakePrompts } from "../../contracts/application/cake-prompt-defaults";
import { SettingsPromptField } from "./settings/settings-prompt-field";

const cakePromptDefaults = defaultCakePrompts();

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
import { SettingsDesktopSharingSection } from "./settings-desktop-sharing-section";
import { SettingsAppearanceSection } from "./settings-appearance-section";
import { SettingsEmbeddedEditorSection } from "./settings-embedded-editor-section";
import { SettingsHotkeysSection } from "./settings-hotkeys-section";
import { SettingsProvidersSection } from "./settings-providers-section";
import type { SettingsStore } from "../stores/SettingsStore";
import { LabelSettings } from "./label-settings";
import { SettingsNonChatModelsSection } from "./settings-non-chat-models-section";
import { SettingsNativeToolsSection } from "./settings-native-tools-section";
import { SettingsExperimentalSection } from "./settings-experimental-section";
import { SettingsAgentNavigationSection } from "./settings-agent-navigation-section";

export const SettingsPage = observer(function SettingsPage({
  settings,
  browserMode = false,
}: {
  settings: SettingsStore;
  browserMode?: boolean;
}) {
  const session = settings.activeSession;
  const configuration = settings.configuration;
  const pi = settings.piSettings;
  const authNotice = settings.authNotice;
  const providers = settings.providers;
  const utility = settings.utilityModel;
  const appearance = settings.appearance;
  const phone = usePhoneLayout();
  const activePage = phone && settings.activePage === "editor" ? "appearance" : settings.activePage;
  const navigationGroups = SETTINGS_NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => !phone || item.page !== "editor"),
  }));
  const pageMetadata = SETTINGS_NAV_GROUPS.flatMap((group) => group.items).find(
    (page) => page.page === activePage,
  );
  if (!pageMetadata) throw new Error(`Settings page is not registered: ${activePage}`);
  const error = settings.error;
  const providerGroups = providers.catalog.modelsByProvider;
  const utilityModel = utility.model;
  const piSettingsStatus = providers.loadingSettings
    ? "Loading Pi’s settings…"
    : "Pi’s settings are unavailable.";
  const [searchQuery, setSearchQuery] = useState("");
  const [scrollRequest, setScrollRequest] = useState<{ targetId: string }>();
  const hotkeySearchItems = settings.hotkeys.definitions.map((definition) => ({
    page: "hotkeys" as const,
    label: definition.label,
    targetId: `setting-hotkey-${definition.id}`,
    keywords: definition.description,
  }));
  const searchResults = searchSettings(searchQuery, hotkeySearchItems);
  const searching = searchQuery.trim().length > 0;
  const searchResultCount = searchResults.reduce((count, group) => count + group.items.length, 0);

  useEffect(() => {
    if (!scrollRequest) return;
    const target = document.getElementById(scrollRequest.targetId);
    if (target) {
      target.scrollIntoView?.({ behavior: "smooth", block: "start" });
      return;
    }
    document.getElementById("settings-content-scroll")?.scrollTo?.({ top: 0, behavior: "smooth" });
  }, [activePage, scrollRequest]);

  const selectSearchResult = (page: (typeof searchResults)[number]["page"], targetId: string) => {
    settings.selectPage(page);
    setScrollRequest({ targetId });
  };
  return (
    <div className="grid h-full min-h-0 min-w-0 grid-cols-[220px_minmax(0,1fr)] max-[620px]:grid-cols-1 max-[620px]:grid-rows-[auto_minmax(0,1fr)] phone:grid-cols-1 phone:grid-rows-[auto_minmax(0,1fr)]">
      <div className="hidden border-b border-border px-4 py-2 max-[620px]:block phone:block">
        <Select
          aria-label="Settings section"
          value={activePage}
          className="[@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:text-base"
          onChange={(event) => {
            const page = SETTINGS_NAV_GROUPS.flatMap((group) => group.items).find(
              (item) => item.page === event.target.value,
            );
            if (page) settings.selectPage(page.page);
          }}
        >
          {navigationGroups.map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.items.map((item) => (
                <option key={item.page} value={item.page}>
                  {item.label}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
      </div>
      <aside
        aria-label="Settings sections"
        className="min-h-0 overflow-y-auto border-r border-border/65 bg-sidebar px-3 py-5 max-[620px]:hidden phone:hidden"
      >
        <h1 className="px-2 text-lg font-bold text-foreground">Settings</h1>
        <p className="mb-4 mt-1 px-2 text-[11px] leading-relaxed text-muted-foreground">
          Cake and Pi preferences
        </p>
        <div className="relative mb-6">
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground">
            <SearchIcon size={13} />
          </span>
          <Input
            type="search"
            size="sm"
            aria-label="Search settings"
            placeholder="Search settings…"
            className="pl-8"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setSearchQuery("");
            }}
          />
        </div>
        <nav className="grid gap-5" aria-label="Settings pages">
          {searching
            ? searchResults.map((group) => (
                <div key={group.page}>
                  <p className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/75">
                    {group.label}
                  </p>
                  <div className="grid gap-0.5">
                    {group.items.map((item) => (
                      <NavItem
                        key={item.targetId}
                        label={item.label}
                        active={
                          activePage === item.page && scrollRequest?.targetId === item.targetId
                        }
                        onClick={() => selectSearchResult(item.page, item.targetId)}
                      />
                    ))}
                  </div>
                </div>
              ))
            : navigationGroups.map((group) => (
                <div key={group.label}>
                  <p className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/75">
                    {group.label}
                  </p>
                  <div className="grid gap-0.5">
                    {group.items.map((item) => (
                      <NavItem
                        key={item.page}
                        label={item.label}
                        description={item.description}
                        active={activePage === item.page}
                        onClick={() => settings.selectPage(item.page)}
                      />
                    ))}
                  </div>
                </div>
              ))}
          {searching && searchResultCount === 0 && (
            <p className="px-2 text-xs leading-relaxed text-muted-foreground" role="status">
              No settings found for “{searchQuery.trim()}”.
            </p>
          )}
        </nav>
      </aside>
      <div
        id="settings-content-scroll"
        className="min-h-0 overflow-y-auto [scrollbar-gutter:stable]"
      >
        <div className="mx-auto max-w-4xl px-8 py-8 pb-16 max-[620px]:px-4 max-[620px]:py-4">
          <div className="mb-6">
            <h2 className="text-xl font-semibold text-foreground">{pageMetadata.label}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {pageMetadata.introduction ??
                "Configure the same Pi runtime used by the CLI. Pi preferences follow you across projects."}
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

          {activePage === "mcp" && <SettingsMcpSection settings={settings.mcp} />}
          {activePage === "widget-packages" && (
            <SettingsWidgetPackagesSection settings={settings.widgetPackages} />
          )}
          {(activePage === "images" || activePage === "classifiers") && (
            <SettingsNonChatModelsSection
              type={activePage === "images" ? "image" : "classifier"}
              preferences={settings.nonChatModels}
              providers={providers}
            />
          )}

          {activePage === "models" && (
            <div className="grid gap-5">
              <section className="grid gap-1.5" aria-labelledby="pi-settings-title">
                <h2 id="pi-settings-title" className="px-0.5 text-xs font-semibold text-foreground">
                  Current chat
                </h2>
                <div className="divide-y divide-border/60 rounded-lg border border-border/80 bg-card/50">
                  {session && configuration ? (
                    <div className="flex items-center justify-between gap-4 px-3.5 py-2.5 text-sm">
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <strong className="text-xs font-medium text-foreground">
                          Model configuration
                        </strong>
                        <small className="text-[11px] text-muted-foreground">
                          Model, reasoning effort, and priority mode for this chat.
                        </small>
                      </span>
                      <ChatConfigurationSelector configuration={configuration} />
                    </div>
                  ) : (
                    <p className="px-3.5 py-2.5 text-xs text-muted-foreground">
                      Open a project or start a one-off chat to choose a model and reasoning level.
                    </p>
                  )}
                </div>
              </section>

              <ModelPresetSettings settings={settings.modelPresets} />

              <section className="grid gap-1.5" aria-labelledby="default-model-title">
                <h2
                  id="default-model-title"
                  className="px-0.5 text-xs font-semibold text-foreground"
                >
                  Default agent model
                </h2>
                {pi ? (
                  <div className="divide-y divide-border/60 rounded-lg border border-border/80 bg-card/50">
                    <div className="flex items-center justify-between gap-4 px-3.5 py-2.5 text-sm">
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <strong className="text-xs font-medium text-foreground">
                          Model & reasoning
                        </strong>
                        <small className="text-[11px] text-muted-foreground">
                          Default model and reasoning profile for new project chats.
                        </small>
                      </span>
                      <ModelPicker
                        ariaLabel="Default agent model"
                        placeholder="Choose default model"
                        groups={() => providerGroups}
                        currentModelName={
                          providerGroups
                            .find((group) => group.id === pi.defaultProvider)
                            ?.models.find((model) => model.id === pi.defaultModel)?.name
                        }
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
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">{piSettingsStatus}</p>
                )}
              </section>

              <section className="grid gap-1.5" aria-labelledby="utility-model-title">
                <h2
                  id="utility-model-title"
                  className="px-0.5 text-xs font-semibold text-foreground"
                >
                  Utility model
                </h2>
                <div className="divide-y divide-border/60 rounded-lg border border-border/80 bg-card/50">
                  <div className="flex items-center justify-between gap-4 px-3.5 py-2.5 text-sm">
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <strong className="text-xs font-medium text-foreground">
                        Model & reasoning
                      </strong>
                      <small className="text-[11px] text-muted-foreground">
                        Runs lightweight background tasks such as naming sessions.
                      </small>
                    </span>
                    <ModelPicker
                      ariaLabel="Utility model"
                      placeholder="No utility model"
                      allowClear
                      showFastMode={false}
                      groups={() => providerGroups}
                      currentModelName={
                        providerGroups
                          .find((group) => group.id === utilityModel?.provider)
                          ?.models.find((model) => model.id === utilityModel?.modelId)?.name
                      }
                      value={
                        utilityModel
                          ? {
                              provider: utilityModel.provider,
                              modelId: utilityModel.modelId,
                              thinkingLevel: utilityModel.thinkingLevel,
                            }
                          : undefined
                      }
                      onClear={() => void utility.clear()}
                      onSelect={({ provider, modelId, thinkingLevel }) => {
                        void utility.select(`${provider}/${modelId}`, thinkingLevel);
                      }}
                    />
                  </div>
                </div>
              </section>
            </div>
          )}

          {activePage === "agent" && (
            <div className="grid gap-5">
              <SettingsAgentNavigationSection navigation={settings.agentNavigation} />

              <section className="grid gap-1.5" aria-labelledby="behavior-title">
                <h2 id="behavior-title" className="px-0.5 text-xs font-semibold text-foreground">
                  Agent behavior
                </h2>
                {pi ? (
                  <div className="divide-y divide-border/60 rounded-lg border border-border/80 bg-card/50">
                    <SettingsToggle
                      id="setting-auto-compact"
                      label="Auto-compact"
                      description="Compact context automatically when it gets too large."
                      checked={pi.autoCompact}
                      onChange={(value) =>
                        void providers.setPiSetting({ key: "autoCompact", value })
                      }
                    />
                    <SettingsToggle
                      id="setting-automatic-retry"
                      label="Automatic retry"
                      description="Retry transient provider failures automatically."
                      checked={pi.retryEnabled}
                      onChange={(value) =>
                        void providers.setPiSetting({ key: "retryEnabled", value })
                      }
                    />
                    <SettingsToggle
                      id="setting-hide-thinking"
                      label="Hide thinking"
                      description="Hide reasoning blocks in assistant responses."
                      checked={pi.hideThinkingBlock}
                      onChange={(value) =>
                        void providers.setPiSetting({ key: "hideThinkingBlock", value })
                      }
                    />
                    <label
                      id="setting-steering-mode"
                      className="scroll-mt-8 flex items-center justify-between gap-4 px-3.5 py-2.5 text-sm max-[620px]:flex-col max-[620px]:items-stretch max-[620px]:gap-2"
                    >
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <strong className="text-xs font-medium text-foreground">
                          Steering mode
                        </strong>
                        <small className="text-[11px] text-muted-foreground">
                          How steering messages are delivered while Pi is working.
                        </small>
                      </span>
                      <Select
                        aria-label="Steering mode"
                        className="h-8 w-44 rounded-sm text-xs max-[620px]:w-full"
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
                    <label
                      id="setting-follow-up-mode"
                      className="scroll-mt-8 flex items-center justify-between gap-4 px-3.5 py-2.5 text-sm max-[620px]:flex-col max-[620px]:items-stretch max-[620px]:gap-2"
                    >
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <strong className="text-xs font-medium text-foreground">
                          Follow-up mode
                        </strong>
                        <small className="text-[11px] text-muted-foreground">
                          How queued follow-ups are delivered after Pi stops.
                        </small>
                      </span>
                      <Select
                        aria-label="Follow-up mode"
                        className="h-8 w-44 rounded-sm text-xs max-[620px]:w-full"
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
                  <p className="text-xs text-muted-foreground">{piSettingsStatus}</p>
                )}
              </section>

              <section className="grid gap-1.5" aria-labelledby="content-title">
                <h2 id="content-title" className="px-0.5 text-xs font-semibold text-foreground">
                  Content
                </h2>
                {pi ? (
                  <div className="divide-y divide-border/60 rounded-lg border border-border/80 bg-card/50">
                    <SettingsToggle
                      id="setting-auto-resize-images"
                      label="Auto-resize images"
                      description="Resize large images for better model compatibility."
                      checked={pi.autoResizeImages}
                      onChange={(value) =>
                        void providers.setPiSetting({ key: "autoResizeImages", value })
                      }
                    />
                    <SettingsToggle
                      id="setting-block-images"
                      label="Block images"
                      description="Prevent images from being sent to model providers."
                      checked={pi.blockImages}
                      onChange={(value) =>
                        void providers.setPiSetting({ key: "blockImages", value })
                      }
                    />
                    <SettingsToggle
                      id="setting-skill-commands"
                      label="Skill commands"
                      description="Register discovered skills as /skill:name commands."
                      checked={pi.enableSkillCommands}
                      onChange={(value) =>
                        void providers.setPiSetting({ key: "enableSkillCommands", value })
                      }
                    />
                    <SettingsToggle
                      id="setting-cache-miss-notices"
                      label="Cache miss notices"
                      description="Show notices for significant prompt-cache misses."
                      checked={pi.showCacheMissNotices}
                      onChange={(value) =>
                        void providers.setPiSetting({ key: "showCacheMissNotices", value })
                      }
                    />
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">{piSettingsStatus}</p>
                )}
              </section>
            </div>
          )}

          {activePage === "runtime" && (
            <div className="grid gap-5">
              <section className="grid gap-1.5" aria-labelledby="execution-title">
                <h2 id="execution-title" className="px-0.5 text-xs font-semibold text-foreground">
                  Execution
                </h2>
                {pi ? (
                  <div className="divide-y divide-border/60 rounded-lg border border-border/80 bg-card/50">
                    <SettingsTextField
                      id="setting-shell-path"
                      label="Shell path"
                      description="Custom shell executable. Leave empty for platform default."
                      value={pi.shellPath}
                      placeholder="/bin/zsh"
                      onApply={(value) => void providers.setPiSetting({ key: "shellPath", value })}
                    />
                    <SettingsTextField
                      id="setting-shell-command-prefix"
                      label="Shell command prefix"
                      description="Command prepended to every Pi shell invocation."
                      value={pi.shellCommandPrefix}
                      placeholder="Optional"
                      onApply={(value) =>
                        void providers.setPiSetting({ key: "shellCommandPrefix", value })
                      }
                    />
                    <SettingsLinesField
                      id="setting-npm-command"
                      label="npm command"
                      description="Command and arguments used for package operations, one per line."
                      value={pi.npmCommand}
                      onApply={(value) => void providers.setPiSetting({ key: "npmCommand", value })}
                    />
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">{piSettingsStatus}</p>
                )}
              </section>

              <SettingsNativeToolsSection providers={providers} />
              <SettingsExtensionsSection providers={providers} />

              <section className="grid gap-1.5" aria-labelledby="resources-title">
                <header className="flex items-center justify-between gap-3 px-0.5">
                  <h2 id="resources-title" className="text-xs font-semibold text-foreground">
                    Resources
                  </h2>
                  <Button
                    variant="outline"
                    size="sm"
                    type="button"
                    className="rounded-sm"
                    onClick={() => void providers.reloadPi()}
                  >
                    {pi?.reloadPending ? "Reload queued" : "Reload Pi"}
                  </Button>
                </header>
                {pi ? (
                  <div className="divide-y divide-border/60 rounded-lg border border-border/80 bg-card/50">
                    <SettingsPackagesField
                      id="setting-packages"
                      value={pi.packages}
                      onApply={(value) => void providers.setPiSetting({ key: "packages", value })}
                    />
                    <SettingsLinesField
                      id="setting-extension-paths"
                      label="Extension paths"
                      description="One path, glob, inclusion, or exclusion per line."
                      value={pi.extensions}
                      onApply={(value) => void providers.setPiSetting({ key: "extensions", value })}
                    />
                    <SettingsLinesField
                      id="setting-skill-paths"
                      label="Skill paths"
                      description="One path, glob, inclusion, or exclusion per line."
                      value={pi.skills}
                      onApply={(value) => void providers.setPiSetting({ key: "skills", value })}
                    />
                    <SettingsLinesField
                      id="setting-prompt-paths"
                      label="Prompt paths"
                      description="One path, glob, inclusion, or exclusion per line."
                      value={pi.prompts}
                      onApply={(value) => void providers.setPiSetting({ key: "prompts", value })}
                    />
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">{piSettingsStatus}</p>
                )}
              </section>
            </div>
          )}

          {activePage === "network" && (
            <div className="grid gap-5">
              {settings.desktopConnection && (
                <SettingsDesktopHostSection connection={settings.desktopConnection} />
              )}
              {browserMode ? (
                <Callout variant="info">
                  Desktop sharing is managed in the Cake desktop app and is unavailable in this
                  browser.
                </Callout>
              ) : !settings.desktopConnection?.remote ? (
                <SettingsDesktopSharingSection sharing={settings.desktopSharing} />
              ) : null}
              <section className="grid gap-1.5" aria-labelledby="network-title">
                <h2 id="network-title" className="px-0.5 text-xs font-semibold text-foreground">
                  Network
                </h2>
                {pi ? (
                  <div className="divide-y divide-border/60 rounded-lg border border-border/80 bg-card/50">
                    <label
                      id="setting-transport"
                      className="scroll-mt-8 flex items-center justify-between gap-4 px-3.5 py-2.5 text-sm max-[620px]:flex-col max-[620px]:items-stretch max-[620px]:gap-2"
                    >
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <strong className="text-xs font-medium text-foreground">Transport</strong>
                        <small className="text-[11px] text-muted-foreground">
                          Preferred transport when a provider supports more than one.
                        </small>
                      </span>
                      <Select
                        aria-label="Provider transport"
                        className="h-8 w-44 rounded-sm text-xs max-[620px]:w-full"
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
                    <label
                      id="setting-http-idle-timeout"
                      className="scroll-mt-8 flex items-center justify-between gap-4 px-3.5 py-2.5 text-sm max-[620px]:flex-col max-[620px]:items-stretch max-[620px]:gap-2"
                    >
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <strong className="text-xs font-medium text-foreground">
                          HTTP idle timeout
                        </strong>
                        <small className="text-[11px] text-muted-foreground">
                          Maximum pause while Pi waits for HTTP data.
                        </small>
                      </span>
                      <Select
                        aria-label="HTTP idle timeout"
                        className="h-8 w-44 rounded-sm text-xs max-[620px]:w-full"
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
                  <p className="text-xs text-muted-foreground">{piSettingsStatus}</p>
                )}
              </section>

              <section className="grid gap-1.5" aria-labelledby="safety-title">
                <h2 id="safety-title" className="px-0.5 text-xs font-semibold text-foreground">
                  Safety & privacy
                </h2>
                {pi ? (
                  <div className="divide-y divide-border/60 rounded-lg border border-border/80 bg-card/50">
                    <label
                      id="setting-default-project-trust"
                      className="scroll-mt-8 flex items-center justify-between gap-4 px-3.5 py-2.5 text-sm max-[620px]:flex-col max-[620px]:items-stretch max-[620px]:gap-2"
                    >
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
                        className="h-8 w-44 rounded-sm text-xs max-[620px]:w-full"
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
                      id="setting-anthropic-extra-usage-warning"
                      label="Anthropic extra usage warning"
                      description="Warn when subscription authentication may use paid extra usage."
                      checked={pi.anthropicExtraUsageWarning}
                      onChange={(value) =>
                        void providers.setPiSetting({ key: "anthropicExtraUsageWarning", value })
                      }
                    />
                    <SettingsToggle
                      id="setting-install-telemetry"
                      label="Install telemetry"
                      description="Send Pi’s anonymous version/update ping after detected updates."
                      checked={pi.enableInstallTelemetry}
                      onChange={(value) =>
                        void providers.setPiSetting({ key: "enableInstallTelemetry", value })
                      }
                    />
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">{piSettingsStatus}</p>
                )}
              </section>
            </div>
          )}

          {activePage === "cake-chat" && (
            <div className="grid gap-5">
              <SettingsCakeChatSection settings={settings} />
              {!browserMode && <SettingsCakeChatOverlaySection store={settings.cakeChatOverlay} />}
            </div>
          )}

          {activePage === "prompts" && (
            <div className="grid gap-5">
              <section className="grid gap-1.5" aria-labelledby="global-instructions-title">
                <h2
                  id="global-instructions-title"
                  className="px-0.5 text-xs font-semibold text-foreground"
                >
                  Global custom instructions
                </h2>
                <div className="divide-y divide-border/60 rounded-lg border border-border/80 bg-card/50">
                  <SettingsPromptField
                    id="setting-global-custom-instructions"
                    label="Global instructions"
                    description="Personal guidance added to every Project Session system prompt. Saved when you leave the field."
                    value={settings.globalInstructions.instructions}
                    defaultValue=""
                    onApply={(value) => void settings.globalInstructions.update(value)}
                  />
                </div>
              </section>

              {settings.cakePrompts.prompts && (
                <section className="grid gap-1.5" aria-labelledby="cake-prompts-title">
                  <h2
                    id="cake-prompts-title"
                    className="px-0.5 text-xs font-semibold text-foreground"
                  >
                    Worktree automation
                  </h2>
                  <div className="divide-y divide-border/60 rounded-lg border border-border/80 bg-card/50">
                    <SettingsPromptField
                      id="setting-prompt-worktree-commit"
                      label="Commit before merge"
                      description="Sent when a worktree has uncommitted changes before landing."
                      variables="{{target}}"
                      value={settings.cakePrompts.prompts.worktreeCommit ?? ""}
                      defaultValue={cakePromptDefaults.worktreeCommit}
                      onApply={(value) => void settings.cakePrompts.update("worktreeCommit", value)}
                    />
                    <SettingsPromptField
                      id="setting-prompt-worktree-rebase-conflict"
                      label="Rebase conflict"
                      description="Sent when a standalone worktree rebase stops on conflicts."
                      variables="{{target}}, {{files}}"
                      value={settings.cakePrompts.prompts.worktreeRebaseConflict ?? ""}
                      defaultValue={cakePromptDefaults.worktreeRebaseConflict}
                      onApply={(value) =>
                        void settings.cakePrompts.update("worktreeRebaseConflict", value)
                      }
                    />
                    <SettingsPromptField
                      id="setting-prompt-worktree-preserve-conflict"
                      label="Merge conflict"
                      description="Sent when preserving commits requires conflict resolution."
                      variables="{{target}}, {{files}}"
                      value={settings.cakePrompts.prompts.worktreePreserveConflict ?? ""}
                      defaultValue={cakePromptDefaults.worktreePreserveConflict}
                      onApply={(value) =>
                        void settings.cakePrompts.update("worktreePreserveConflict", value)
                      }
                    />
                    <SettingsPromptField
                      id="setting-prompt-worktree-squash-conflict"
                      label="Squash conflict"
                      description="Sent when a squash landing requires conflict resolution."
                      variables="{{target}}, {{files}}"
                      value={settings.cakePrompts.prompts.worktreeSquashConflict ?? ""}
                      defaultValue={cakePromptDefaults.worktreeSquashConflict}
                      onApply={(value) =>
                        void settings.cakePrompts.update("worktreeSquashConflict", value)
                      }
                    />
                    <SettingsPromptField
                      id="setting-prompt-worktree-squash-message"
                      label="Squash commit message"
                      description="Sent when Cake needs the agent to propose the squash commit message."
                      variables="{{target}}"
                      value={settings.cakePrompts.prompts.worktreeSquashMessage ?? ""}
                      defaultValue={cakePromptDefaults.worktreeSquashMessage}
                      onApply={(value) =>
                        void settings.cakePrompts.update("worktreeSquashMessage", value)
                      }
                    />
                  </div>
                </section>
              )}
            </div>
          )}

          {activePage === "labels" && (
            <LabelSettings
              store={settings.globalLabels}
              title="Global labels"
              description="Available in every project. Choose them from a session avatar; changes save immediately."
              placeholder="New global label"
            />
          )}

          {activePage === "providers" && (
            <SettingsProvidersSection
              providers={providers}
              providerGroups={providers.catalog.allModelsByProvider}
            />
          )}
          {activePage === "voice" &&
            (browserMode ? (
              <Callout variant="info">
                Native voice and dictation controls are available only in the Cake desktop app.
              </Callout>
            ) : (
              <div className="grid gap-5">
                <SettingsDictationSection
                  store={settings.dictation}
                  prompts={settings.cakePrompts}
                />
                <SettingsSpeechSection speech={settings.speech} />
                <SettingsSpeechInputSection store={settings.speechInput} />
              </div>
            ))}
          {activePage === "experimental" && (
            <SettingsExperimentalSection experimental={settings.experimental} />
          )}
          {activePage === "appearance" && <SettingsAppearanceSection appearance={appearance} />}
          {activePage === "screen-capture" &&
            (browserMode ? (
              <Callout>Screen capture is available only in the Cake desktop app.</Callout>
            ) : (
              <SettingsScreenCaptureSection capture={settings.screenCapture} />
            ))}
          {activePage === "hotkeys" && <SettingsHotkeysSection hotkeys={settings.hotkeys} />}
          {activePage === "editor" && (
            <SettingsEmbeddedEditorSection settings={settings.embeddedEditor} />
          )}
        </div>
      </div>
    </div>
  );
});
