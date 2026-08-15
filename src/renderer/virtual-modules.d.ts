declare module "virtual:cake-global-scene" {
  import type { ComponentType, ReactNode } from "react";
  const GlobalScene: ComponentType<{ children: ReactNode }>;
  export default GlobalScene;
}

declare const __CAKE_CUSTOMIZATION_REVISION__: string | undefined;
