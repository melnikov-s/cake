import { Schema } from "effect";
import { cakeHotkeyActionIds, cakeSettingsSectionIds } from "./cake-settings-data";

const CakeSettingsSectionId = Schema.Literals(cakeSettingsSectionIds);

export const CakeSettingsGetInput = Schema.Struct({
  section: CakeSettingsSectionId,
});

const AppearanceChanges = Schema.Struct({
  theme: Schema.optionalKey(Schema.Literals(["system", "light", "dark"])),
  projectAvatarsEnabled: Schema.optionalKey(Schema.Boolean),
  sessionAvatarsEnabled: Schema.optionalKey(Schema.Boolean),
  workLogViewMode: Schema.optionalKey(Schema.Literals(["auto", "diff", "log"])),
  workLogsExpansion: Schema.optionalKey(
    Schema.Literals(["collapsed", "expanded", "fully-expanded"]),
  ),
}).check(
  Schema.makeFilter((changes) => Object.values(changes).some((value) => value !== undefined), {
    expected: "at least one appearance setting",
  }),
);

const EditorChanges = Schema.Struct({
  sidebarAutoHide: Schema.optionalKey(Schema.Literals(["never", "always", "below-width"])),
  sidebarAutoHideWidth: Schema.optionalKey(Schema.Literals([1024, 1280, 1440, 1728, 1920])),
}).check(
  Schema.makeFilter((changes) => Object.values(changes).some((value) => value !== undefined), {
    expected: "at least one editor setting",
  }),
);

const HotkeyBindingChange = Schema.Struct({
  action: Schema.Literals(cakeHotkeyActionIds),
  binding: Schema.NullOr(Schema.String.check(Schema.isMaxLength(128))),
});

const HotkeyChanges = Schema.Struct({
  bindings: Schema.Array(HotkeyBindingChange)
    .check(Schema.isMinLength(1), Schema.isMaxLength(cakeHotkeyActionIds.length))
    .check(
      Schema.makeFilter(
        (bindings) => new Set(bindings.map((binding) => binding.action)).size === bindings.length,
        { expected: "unique hotkey actions" },
      ),
    ),
});

export const CakeSettingsUpdateInput = Schema.Union([
  Schema.Struct({ section: Schema.Literal("appearance"), changes: AppearanceChanges }),
  Schema.Struct({ section: Schema.Literal("editor"), changes: EditorChanges }),
  Schema.Struct({ section: Schema.Literal("hotkeys"), changes: HotkeyChanges }),
]);
