import { defineConfig } from "@playwright/test";
import backgroundConfig from "./playwright.config";

export default defineConfig(backgroundConfig, {
  grep: /@foreground/,
  grepInvert: [],
});
