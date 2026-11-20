type PlaywrightLaunch = (typeof import("@playwright/test")._electron)["launch"];

export const _electron: {
  launch(
    options?: Parameters<PlaywrightLaunch>[0] & {
      /** Start while the run's current application stays open (several desktop clients). */
      alongsideCurrentApplication?: boolean;
    },
  ): ReturnType<PlaywrightLaunch>;
};
