import { observer, useStore } from "r-state-tree/react";
import { WindowStore } from "./window-store";

export const App = observer(function App() {
  const store = useStore(WindowStore);

  return (
    <main>
      <header>
        <span className={`status status-${store.agentState}`} aria-hidden="true" />
        <span>Agent {store.agentState}</span>
      </header>
      <section>
        <p className="eyebrow">Foundation</p>
        <h1>Cake</h1>
        <p className="intro">A focused desktop surface for a Pi-powered coding agent.</p>
        <button
          disabled={store.agentState !== "ready" || store.isRunning}
          onClick={() => void store.startFoundationCheck()}
        >
          {store.isRunning ? "Pi session running…" : "Test Pi session"}
        </button>
        <output aria-live="polite">
          {store.error ?? (store.text || "The Pi session stream will appear here.")}
        </output>
        {store.confirmRequest && (
          <div className="dialog" role="alertdialog" aria-labelledby="confirm-title" aria-describedby="confirm-message">
            <p className="eyebrow">Pi extension</p>
            <h2 id="confirm-title">{store.confirmRequest.title}</h2>
            <p id="confirm-message">{store.confirmRequest.message}</p>
            <div className="dialog-actions">
              <button className="secondary" onClick={() => void store.respondToConfirmation(false)}>Decline</button>
              <button onClick={() => void store.respondToConfirmation(true)}>Confirm</button>
            </div>
          </div>
        )}
      </section>
    </main>
  );
});
