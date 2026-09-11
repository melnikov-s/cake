export const workflowStatusPalette = {
  slate: "#64748b",
  gray: "#888b92",
  brown: "#986b4b",
  red: "#dc4c4c",
  crimson: "#d94662",
  rose: "#df7180",
  pink: "#e56aa6",
  fuchsia: "#d85ad8",
  magenta: "#c653c8",
  purple: "#a85ad4",
  violet: "#9a78d7",
  indigo: "#766fd2",
  blue: "#638bdc",
  azure: "#4d96db",
  sky: "#4ba8cc",
  cyan: "#3cb5c3",
  teal: "#36a69a",
  turquoise: "#3daf92",
  mint: "#4eae83",
  emerald: "#42a96f",
  green: "#61a957",
  lime: "#8db64b",
  chartreuse: "#a7bd45",
  olive: "#8d9244",
  yellow: "#d5bd3e",
  amber: "#daa836",
  gold: "#d69b38",
  orange: "#df873f",
  peach: "#e79568",
  coral: "#e47a68",
  sand: "#b99b72",
  lavender: "#ad91d2",
} as const;

export type WorkflowStatusColor = keyof typeof workflowStatusPalette;

const workflowStatusColors = Object.keys(workflowStatusPalette).filter(
  (value): value is WorkflowStatusColor => Object.hasOwn(workflowStatusPalette, value),
);
const firstWorkflowStatusColor = workflowStatusColors[0];
if (firstWorkflowStatusColor === undefined) throw new Error("The workflow status palette is empty");
export const WORKFLOW_STATUS_COLORS: [WorkflowStatusColor, ...WorkflowStatusColor[]] = [
  firstWorkflowStatusColor,
  ...workflowStatusColors.slice(1),
];
