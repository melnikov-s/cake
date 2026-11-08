/** Acknowledgement of actual Pi input consumption, not admission or response completion. */
export type ScheduledInputReceipt =
  | { readonly status: "consumed"; readonly consumedAt: number }
  | { readonly status: "pending" }
  | { readonly status: "canceled" }
  | { readonly status: "failed"; readonly message: string };
