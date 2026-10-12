export type BrowserActionResult<Value> =
  | { readonly status: "completed"; readonly value: Value }
  | { readonly status: "mode-required" };
