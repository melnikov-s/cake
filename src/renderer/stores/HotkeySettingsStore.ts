import { snapshot, Store } from "r-state-tree";
import {
  defaultHotkeyBinding,
  hotkeyActionIds,
  hotkeyDefinitions,
  hotkeyFromKeyboardEvent,
  type HotkeyActionId,
} from "../lib/hotkeys";

/** Owns Cake's persisted, window-scoped application hotkey preferences. */
export class HotkeySettingsStore extends Store {
  @snapshot bindings: Partial<Record<HotkeyActionId, string>> = {};

  get definitions() {
    return hotkeyDefinitions;
  }

  bindingFor(id: HotkeyActionId) {
    return this.bindings[id] ?? defaultHotkeyBinding(id);
  }

  actionForEvent(event: KeyboardEvent): HotkeyActionId | undefined {
    const binding = hotkeyFromKeyboardEvent(event);
    return binding ? this.actionForBinding(binding) : undefined;
  }

  actionForBinding(binding: string): HotkeyActionId | undefined {
    return hotkeyActionIds.find((id) => this.bindingFor(id) === binding);
  }

  assign(id: HotkeyActionId, binding: string) {
    const bindings = { ...this.bindings };
    for (const actionId of hotkeyActionIds) {
      if (actionId !== id && this.bindingFor(actionId) === binding) bindings[actionId] = "";
    }
    bindings[id] = binding;
    this.bindings = bindings;
  }

  clear(id: HotkeyActionId) {
    this.bindings = { ...this.bindings, [id]: "" };
  }

  reset(id: HotkeyActionId) {
    const bindings = { ...this.bindings };
    delete bindings[id];
    const defaultBinding = defaultHotkeyBinding(id);
    for (const actionId of hotkeyActionIds) {
      if (actionId !== id && this.bindingFor(actionId) === defaultBinding) bindings[actionId] = "";
    }
    this.bindings = bindings;
  }

  resetAll() {
    this.bindings = {};
  }
}
