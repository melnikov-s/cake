import type { RootStore } from "../stores/RootStore";
import type { ArtifactNavigationContext } from "../../contracts/artifacts/artifact-navigation-context";
import { WidgetSlot } from "../components/widget-slot";

/** Each view receives its own session context, even when the instance/state is shared. */
export function chatWidgetsFor(
  root: RootStore,
  session: NonNullable<ArtifactNavigationContext["session"]>,
) {
  const render = (slot: "top" | "bottom" | "left" | "right") => (
    <WidgetSlot
      slot={slot}
      session={session}
      store={root.widgetAttachmentStore}
      widgets={root.inlineWidgetStore}
    />
  );
  return {
    top: render("top"),
    bottom: render("bottom"),
    left: render("left"),
    right: render("right"),
  };
}
