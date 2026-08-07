import { observer, useStore } from "r-state-tree/react";
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationDescription,
  ConfirmationRequest,
  ConfirmationTitle
} from "@/components/ai-elements/confirmation";
import { Button } from "@/components/ui/button";
import { WindowStore } from "./window-store";

export const App = observer(function App() {
  const store = useStore(WindowStore);

  return (
    <main className="grid min-h-screen grid-rows-[auto_1fr] bg-background text-foreground">
      <header className="flex items-center justify-between border-b border-border/70 px-5 py-3 font-mono text-[0.69rem] uppercase tracking-[0.12em] text-muted-foreground">
        <span className="font-semibold text-foreground">Cake / S0</span>
        <span className="flex items-center gap-2">
          <span className={`status-dot status-${store.agentState}`} aria-hidden="true" />
          Agent {store.agentState}
        </span>
      </header>
      <section className="mx-auto grid w-full max-w-5xl content-center gap-10 px-6 py-16 sm:px-10 lg:grid-cols-[minmax(0,0.82fr)_minmax(22rem,1.18fr)] lg:gap-16">
        <div className="self-center">
          <p className="mb-4 font-mono text-[0.69rem] font-semibold uppercase tracking-[0.16em] text-accent">Foundation circuit</p>
          <h1 className="font-display text-[clamp(4.8rem,16vw,9.5rem)] font-black leading-[0.72] tracking-[-0.09em]">Cake</h1>
          <p className="mt-8 max-w-sm text-base leading-7 text-muted-foreground">
            A focused desktop surface for a Pi-powered coding agent.
          </p>
          <Button
            className="mt-7"
            size="lg"
            disabled={store.agentState !== "ready" || store.isRunning}
            onClick={() => void store.startFoundationCheck()}
          >
            {store.isRunning ? "Pi session running…" : "Test Pi session"}
          </Button>
        </div>
        <div className="relative self-center pl-4 before:absolute before:inset-y-0 before:left-0 before:w-px before:bg-border after:absolute after:left-[-2px] after:top-0 after:h-14 after:w-[5px] after:rounded-full after:bg-accent">
          <div className="mb-3 flex items-center justify-between font-mono text-[0.66rem] uppercase tracking-[0.12em] text-muted-foreground">
            <span>Pi event stream</span>
            <span>{store.isRunning ? "Live" : "Standby"}</span>
          </div>
          <output
            className="block min-h-44 rounded-xl border border-border bg-card p-5 font-mono text-[0.78rem] leading-6 text-card-foreground shadow-[0_18px_60px_-40px_rgba(18,22,27,0.45)]"
            aria-live="polite"
          >
            {store.error ?? (store.text || "The Pi session stream will appear here.")}
          </output>
          {store.confirmRequest && (
            <Confirmation
              className="mt-4"
              state="requested"
              role="alertdialog"
              aria-labelledby="confirm-title"
              aria-describedby="confirm-message"
            >
              <ConfirmationRequest>
                <p className="mb-2 font-mono text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-accent">Pi extension</p>
                <ConfirmationTitle id="confirm-title">{store.confirmRequest.title}</ConfirmationTitle>
                <ConfirmationDescription id="confirm-message">{store.confirmRequest.message}</ConfirmationDescription>
                <ConfirmationActions>
                  <ConfirmationAction variant="outline" onClick={() => void store.respondToConfirmation(false)}>
                    Decline
                  </ConfirmationAction>
                  <ConfirmationAction onClick={() => void store.respondToConfirmation(true)}>Confirm</ConfirmationAction>
                </ConfirmationActions>
              </ConfirmationRequest>
            </Confirmation>
          )}
        </div>
      </section>
    </main>
  );
});
