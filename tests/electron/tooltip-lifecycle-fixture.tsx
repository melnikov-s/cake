import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MarginRail } from "../../src/renderer/components/ui/margin-rail";
import { TooltipBubble, useTooltip } from "../../src/renderer/components/ui/tooltip";

function Fixture() {
  const [visible, setVisible] = useState(true);
  const [expanded, setExpanded] = useState(true);
  const [revision, setRevision] = useState(0);
  const { anchor, hide, show } = useTooltip();
  return (
    <main className="p-8 text-foreground">
      <h1 className="mb-4">Conversation tooltip lifecycle</h1>
      <div data-testid="scroll" style={{ overflow: "auto", height: 260, width: 640 }}>
        <div style={{ padding: 32, height: 1000 }}>
          {visible && (
            <MarginRail
              key={revision}
              title="Show all projects"
              start
              onOpen={() => {}}
              onFocus={() => {}}
              expanded={expanded}
              onToggle={() => setExpanded(!expanded)}
            />
          )}
          <p>Conversation text remains readable after the heading scrolls away.</p>
        </div>
      </div>
      <button data-testid="remove" onClick={() => setVisible(false)}>
        Remove heading
      </button>
      <button data-testid="replace" onClick={() => setRevision(revision + 1)}>
        Replace heading
      </button>
      <button data-testid="outside">Another control</button>
      {visible && (
        <button
          data-testid="conditional-trigger"
          onMouseEnter={(event) => show(event.currentTarget)}
          onMouseLeave={hide}
          onFocus={(event) => show(event.currentTarget)}
          onBlur={hide}
        >
          Conditional trigger
        </button>
      )}
      {anchor && <TooltipBubble label="Conditional tooltip" anchor={anchor} />}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
