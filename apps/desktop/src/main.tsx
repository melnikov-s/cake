import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { DesktopEvent } from "@cake/protocol";
import { mountWindowStore } from "@cake/state";
import "./styles.css";

const windowStore = mountWindowStore();

function App() {
  const [workerState, setWorkerState] = useState("starting");
  const [text, setText] = useState("");

  useEffect(() => {
    if (!window.cake) {
      setWorkerState("failed");
      setText("Cake's desktop bridge did not load. Restart the app and inspect the preload diagnostics.");
      return;
    }

    return window.cake.subscribe((event: DesktopEvent) => {
      if (event.type === "worker-state") setWorkerState(event.state);
      if (event.type === "text-delta") setText((current) => current + event.text);
    });
  }, []);

  async function startDemo() {
    if (!window.cake) return;
    setText("");
    await window.cake.request({ type: "start-demo" });
  }

  return (
    <main>
      <header>
        <span className={`status status-${workerState}`} aria-hidden="true" />
        <span>Worker {workerState}</span>
      </header>
      <section>
        <p className="eyebrow">Foundation</p>
        <h1>Cake</h1>
        <p className="intro">A focused desktop surface for a Pi-powered coding agent.</p>
        <button disabled={workerState !== "ready"} onClick={startDemo}>Test worker stream</button>
        <output aria-live="polite">{text || "The worker stream will appear here."}</output>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);

window.addEventListener("pagehide", () => windowStore[Symbol.dispose](), { once: true });
