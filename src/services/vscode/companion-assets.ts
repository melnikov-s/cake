import companionManifest from "../../assets/vscode-companion/companion-manifest.json";
import companionSource from "../../assets/vscode-companion/extension.js?raw";
import lightTheme from "../../assets/vscode-companion/themes/cake-light-color-theme.json?raw";
import darkTheme from "../../assets/vscode-companion/themes/cake-dark-color-theme.json?raw";

/** The existing raw-asset loaders bundle identical companion bytes for Electron and Node. */
export const companionAssets = {
  companionManifest,
  companionSource,
  companionThemes: [
    { path: "./themes/cake-light-color-theme.json", content: lightTheme },
    { path: "./themes/cake-dark-color-theme.json", content: darkTheme },
  ],
};
