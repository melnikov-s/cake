/** Presentation lane for active Project Sessions; never an ownership or authority boundary. */
export type SessionKind = "user" | "delegated";

export const sessionKinds: readonly SessionKind[] = ["user", "delegated"];

export const sessionKind = (
  session: { purpose?: "user" | "delegated" } | undefined,
): SessionKind => (session?.purpose === "delegated" ? "delegated" : "user");
