export type VscodeActionResult<Value> =
  | { readonly status: "completed"; readonly value: Value }
  | { readonly status: "mode-required" };
