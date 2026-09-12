# Navigation component catalog

Authoritative primitives live in `src/renderer/components/ui/`.

| Component             | Responsibility                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NavItem`             | Accessible row action, label, description, badges, and trailing controls. Opt-in `motionFeedback` gives titles a springy hover/selection offset and press response. |
| `NavigationHighlight` | Shared moving selection and hover backgrounds across descendant navigation rows, including separate groups.                                                         |
| `AnimatedList`        | Position transitions when keyed list items reorder; composes with `NavigationHighlight`.                                                                            |
| `Avatar`              | Deterministic project/session artwork and opt-in disposable avatar interactions.                                                                                    |

## Moving navigation backgrounds

Wrap the scrolling **content** in `NavigationHighlight`. Mark each row with
`data-navigation-item` and set `data-navigation-active` from its existing selected
prop. Keep row backgrounds transparent; the shared layers supply the semantic
`sidebar-active` and `sidebar-hover` fills. Continue using `NavItem` for actions
and `aria-current`—the highlight is decorative, not a navigation controller.

Selection settles with a subtle overshoot; pointer/focus preview glides more
quickly and fades into selection. Retargeting starts at the displayed position.
Geometry stays local to the mounted primitive, follows row/layout changes, and
scrolls with its content. Motion reduction makes movement immediate. No Store,
selection copy, persistence, or per-frame React updates are introduced.
