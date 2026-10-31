export function vscodeColorThemeFixture(type: "light" | "dark") {
  const dark = type === "dark";
  return {
    name: dark ? "Sea glass" : "Warm paper",
    type,
    colors: {
      "editor.background": dark ? "#10252b" : "#fff8e8",
      "editor.foreground": dark ? "#d6edf0" : "#433b2f",
      "sideBar.background": dark ? "#0b1d23" : "#f3ebd9",
      "sideBar.foreground": dark ? "#c6e0e4" : "#433b2f",
      "editorWidget.background": dark ? "#19333b" : "#fffcef",
      "input.background": dark ? "#19333b" : "#fffcef",
      "input.foreground": dark ? "#d6edf0" : "#433b2f",
      descriptionForeground: dark ? "#9dbbc2" : "#766c5c",
      "button.background": "#006b73",
      "button.foreground": "#ffffff",
      focusBorder: dark ? "#60c6c8" : "#007a81",
      "panel.border": dark ? "#32525c" : "#d3c6ab",
      "list.activeSelectionBackground": dark ? "#23505b" : "#ccdfdb",
      "list.activeSelectionForeground": dark ? "#e1f7fa" : "#183b3f",
      "editor.selectionBackground": dark ? "#306372aa" : "#9fcbc688",
      "gitDecoration.addedResourceForeground": dark ? "#b3d68c" : "#3c7654",
      "editorWarning.foreground": dark ? "#e6c277" : "#936018",
      errorForeground: dark ? "#f09286" : "#b23e3e",
    },
    tokenColors: [
      { scope: ["keyword", "storage"], settings: { foreground: dark ? "#c792ea" : "#8355b5" } },
      { scope: "string", settings: { foreground: dark ? "#b3d68c" : "#3c7654" } },
      {
        scope: "comment",
        settings: { foreground: dark ? "#8aa6ad" : "#7e7868", fontStyle: "italic" },
      },
      { scope: "constant.numeric", settings: { foreground: dark ? "#f2b782" : "#995c2c" } },
    ],
  };
}
