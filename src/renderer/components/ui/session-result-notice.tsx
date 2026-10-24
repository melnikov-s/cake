import type { ReactNode } from "react";

/** One integrated list of application-delivered report and batch-note disclosures. */
export function SessionResultNotice({ children }: { children: ReactNode }) {
  return (
    <section
      role="status"
      aria-label="Session results"
      className="w-full min-w-0 rounded-lg bg-background px-5 py-2"
    >
      {children}
    </section>
  );
}
