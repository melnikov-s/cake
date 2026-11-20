import type { ElectronApplication } from "@playwright/test";

/**
 * Chooses `label` from the next native menu Cake pops up. Hidden test windows cannot drive
 * OS popup menus, so this replaces only the popup; the menu template, enabled state and the
 * item's real click handler remain the application's own.
 */
export async function chooseNextNativeMenuItem(application: ElectronApplication, label: string) {
  await application.evaluate(({ Menu }, label) => {
    const build = Menu.buildFromTemplate.bind(Menu);
    Menu.buildFromTemplate = (template) => {
      const menu = build(template);
      const item = menu.items.find((entry) => entry.label === label);
      if (item) {
        Menu.buildFromTemplate = build;
        Reflect.set(
          globalThis,
          "cakeChosenNativeMenuLabels",
          menu.items.map((entry) => entry.label),
        );
        menu.popup = (options) => {
          // Never throw in the main process: a disabled item is simply not chosen.
          if (item.enabled) item.click(item, options?.window, { triggeredByAccelerator: false });
          else console.error(`[native-menu] ${label} is disabled`);
          options?.callback?.();
        };
      }
      return menu;
    };
  }, label);
}

/** Labels of the menu most recently handled by `chooseNextNativeMenuItem`. */
export function chosenNativeMenuLabels(application: ElectronApplication) {
  return application.evaluate(
    () => (Reflect.get(globalThis, "cakeChosenNativeMenuLabels") ?? []) as string[],
  );
}
