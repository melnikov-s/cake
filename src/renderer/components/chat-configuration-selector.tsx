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
        modelId: selectedModel.id,
        thinkingLevel: session?.thinkingLevel,
        fastMode: configuration.fastMode,
      }
    : undefined;
  const effectiveConfiguration = configuration.deferred
    ? (configuration.effectiveConfiguration ?? sessionConfiguration)
    : sessionConfiguration;

  return (
    <div onClick={() => configuration.ensureCatalog()} className="contents">
      <ModelPicker
        className={className}
        groups={configuration.connectedModelsByProvider}
        presets={configuration.presets}
        activePreset={configuration.activePreset}
        value={effectiveConfiguration}
        error={configuration.error}
        openPresetSettings={() => configuration.openPresetSettings()}
        onSelect={(next) => {
          if (
            selectedModel &&
            next.provider === selectedModel.provider &&
            next.modelId === selectedModel.id &&
            next.fastMode === configuration.fastMode &&
            next.thinkingLevel !== session?.thinkingLevel
          ) {
            void configuration.selectThinkingLevel(next.thinkingLevel);
          } else {
            void configuration.selectConfiguration(next);
          }
        }}
        onSelectPreset={(preset) => void configuration.selectPreset(preset)}
      />
    </div>
  );
});
