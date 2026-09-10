import { snapshot, Store } from "r-state-tree";
import {
  cakeHotkeyActionIds,
  type CakeHotkeyActionId,
} from "../../domain/application/cake-settings-data";
import { defaultHotkeyBinding, hotkeyDefinitions, hotkeyFromKeyboardEvent } from "../lib/hotkeys";

/** Owns Cake's persisted, window-scoped application hotkey preferences. */
export class HotkeySettingsStore extends Store {
  @snapshot bindings: Partial<Record<CakeHotkeyActionId, string>> = {};

  get definitions() {
    return hotkeyDefinitions;
  }

  bindingFor(id: CakeHotkeyActionId) {
    return this.bindings[id] ?? defaultHotkeyBinding(id);
  }

  actionForEvent(event: KeyboardEvent): CakeHotkeyActionId | undefined {
    const binding = hotkeyFromKeyboardEvent(event);
    return binding ? this.actionForBinding(binding) : undefined;
  }

  actionForBinding(binding: string): CakeHotkeyActionId | undefined {
    return cakeHotkeyActionIds.find((id) => this.bindingFor(id) === binding);
  }

  assign(id: CakeHotkeyActionId, binding: string) {
    const bindings = { ...this.bindings };
    for (const actionId of cakeHotkeyActionIds) {
      if (actionId !== id && this.bindingFor(actionId) === binding) bindings[actionId] = "";
    }
    bindings[id] = binding;
    this.bindings = bindings;
  }

  clear(id: CakeHotkeyActionId) {
    this.bindings = { ...this.bindings, [id]: "" };
  }

  reset(id: CakeHotkeyActionId) {
    const bindings = { ...this.bindings };
    delete bindings[id];
    const defaultBinding = defaultHotkeyBinding(id);
    for (const actionId of cakeHotkeyActionIds) {
      if (actionId !== id && this.bindingFor(actionId) === defaultBinding) bindings[actionId] = "";
    }
    this.bindings = bindings;
  }

  resetAll() {
    this.bindings = {};
  }
}
