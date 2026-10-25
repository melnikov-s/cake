import type { ReactNode } from "react";

/** One integrated list of application-delivered report and batch-note disclosures. */
export function SessionResultNotice({ children }: { children: ReactNode }) {
  return (
    <section
      role="status"
      aria-label="Session results"
      className="flex w-full min-w-0 flex-col gap-3 rounded-lg bg-background py-2"
    >
      {children}
    </section>
  );
}
