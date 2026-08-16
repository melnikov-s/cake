declare module "virtual:cake-scene" {
  import type { ComponentType } from "react";
  const Scene: ComponentType;
  export default Scene;
}

declare module "virtual:cake-plugins" {}

declare const __CAKE_CUSTOMIZATION_REVISION__: string | undefined;
