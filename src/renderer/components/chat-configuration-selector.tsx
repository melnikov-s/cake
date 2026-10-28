import { observer } from "r-state-tree/react";
import type { ChatConfigurationStore } from "../stores/ChatConfigurationStore";
import { ModelPicker } from "./model-picker";

export const ChatConfigurationSelector = observer(function ChatConfigurationSelector({
  configuration,
  className,
}: {
  configuration: ChatConfigurationStore;
  className?: string;
}) {
  const session = configuration.session;
  const selectedModel = session?.model;
  const sessionConfiguration = selectedModel
    ? {
        provider: selectedModel.provider,
        modelId: selectedModel.modelId,
        thinkingLevel: session?.thinkingLevel,
        fastMode: configuration.fastMode,
        preset: session?.preset,
      }
    : undefined;
  const effectiveConfiguration = configuration.deferred
    ? (configuration.effectiveConfiguration ?? sessionConfiguration)
    : sessionConfiguration;

  return (
    <ModelPicker
      className={className}
      groups={() => configuration.connectedModelsByProvider}
      currentModelName={
        effectiveConfiguration?.provider === selectedModel?.provider &&
        effectiveConfiguration?.modelId === selectedModel?.modelId
          ? selectedModel?.name
          : configuration.deferredModelName
      }
      onOpen={() => {
        if (configuration.deferred) void configuration.catalog.ensureLoaded();
      }}
      presets={configuration.presets}
      activePreset={configuration.activePreset}
      utilityModel={configuration.utilityModel}
      value={effectiveConfiguration}
      error={
        configuration.error ??
        (configuration.deferred ? configuration.catalog.error?.message : undefined)
      }
      openPresetSettings={
        configuration.canOpenPresetSettings ? () => configuration.openPresetSettings() : undefined
      }
      onSelect={(next) => {
        if (
          selectedModel &&
          next.provider === selectedModel.provider &&
          next.modelId === selectedModel.modelId &&
          next.fastMode === configuration.fastMode &&
          next.preset?.id === session?.preset?.id &&
          next.thinkingLevel !== session?.thinkingLevel
        ) {
          void configuration.selectThinkingLevel(next.thinkingLevel);
        } else if (
          selectedModel &&
          next.provider === selectedModel.provider &&
          next.modelId === selectedModel.modelId &&
          next.thinkingLevel === session?.thinkingLevel &&
          next.preset?.id === session?.preset?.id &&
          next.fastMode !== configuration.fastMode
        ) {
          void configuration.selectFastMode(next.fastMode);
        } else {
          void configuration.selectConfiguration(next);
        }
      }}
      onSelectPreset={(preset) => void configuration.selectPreset(preset)}
    />
  );
});
