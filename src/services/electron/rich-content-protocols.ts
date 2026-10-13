import { protocol } from "electron";
import { inlineWidgetScheme } from "../widgets/inline-widget-document-registry";
import { extensionCompanionScheme } from "../pi/runtime/extension-companion-module-registry";

/** Electron accepts one privileged scheme registration, before app readiness. */
export function registerRichContentSchemes() {
  protocol.registerSchemesAsPrivileged(
    [inlineWidgetScheme, extensionCompanionScheme].map((scheme) => ({
      scheme,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
    })),
  );
}
