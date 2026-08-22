declare module "*.png?asset" {
  const assetPath: string;
  export default assetPath;
}

declare module "*?asset" {
  const assetPath: string;
  export default assetPath;
}
