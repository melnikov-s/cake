import type { ReactNode } from "react";

function Icon({
  children,
  size = 16,
  className,
}: {
  children: ReactNode;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export const FolderIcon = () => (
  <Icon>
    <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z" />
  </Icon>
);
export const CakeIcon = () => (
  <Icon>
    <path d="M4 12.5h16v6A1.5 1.5 0 0 1 18.5 20h-13A1.5 1.5 0 0 1 4 18.5z" />
    <path d="M4 12.5c0-1.7 1.6-3 3.5-3s3.5 1.3 3.5 3c0-1.7 1.6-3 3.5-3s3.5 1.3 3.5 3c0-1.7 1.6-3 3.5-3" />
    <path d="M8 6v2M12 4v2M16 6v2M4 16h16" />
  </Icon>
);
export const PlusIcon = () => (
  <Icon>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);
export const ChatIcon = () => (
  <Icon>
    <path d="M20 15a3 3 0 0 1-3 3H8l-5 3 1.7-5.1A7 7 0 0 1 4 13V8a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3z" />
  </Icon>
);
export const BackIcon = () => (
  <Icon>
    <path d="m15 18-6-6 6-6" />
  </Icon>
);
export const ForwardIcon = () => (
  <Icon>
    <path d="m9 18 6-6-6-6" />
  </Icon>
);
export const SidebarIcon = () => (
  <Icon>
    <rect x="3.5" y="4" width="17" height="16" rx="3" />
    <path d="M9 4v16" />
  </Icon>
);
export const ChevronIcon = ({ className }: { className?: string }) => (
  <Icon size={13} className={className}>
    <path d="m8 10 4 4 4-4" />
  </Icon>
);
export const ResolveIcon = () => (
  <Icon size={14}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="m8.5 12 2.25 2.25L15.8 9.2" />
  </Icon>
);
export const RestoreIcon = () => (
  <Icon size={14}>
    <path d="M4.5 9A8 8 0 1 1 4 14" />
    <path d="M4.5 4.5V9H9" />
  </Icon>
);
export const SettingsIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06-2.83 2.83-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21h-4v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06-2.83-2.83.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3v-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06 2.83-2.83.06.06A1.65 1.65 0 0 0 9 4.68h.08a1.65 1.65 0 0 0 1-1.51V3h4v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06 2.83 2.83-.06.06A1.65 1.65 0 0 0 19.32 9v.08a1.65 1.65 0 0 0 1.51 1H21v4h-.09A1.65 1.65 0 0 0 19.4 15z" />
  </Icon>
);
export const ChangesIcon = () => (
  <Icon size={15}>
    <path d="M4 7h10M4 17h10M17 4v6M14 7l3 3 3-3M17 14v6M14 17l3 3 3-3" />
  </Icon>
);
export const BrowseIcon = () => (
  <Icon size={15}>
    <path d="M4 5.5h6l1.8 2H20v11H4z" />
    <path d="M4 9h16" />
  </Icon>
);
export const TreeIcon = () => (
  <Icon size={15}>
    <circle cx="6" cy="5" r="2" />
    <circle cx="6" cy="19" r="2" />
    <path d="M6 7v10" />
    <path d="M8 5h4a2 2 0 0 1 2 2v3.5" />
    <path d="M8 19h4a2 2 0 0 0 2-2v-3.5" />
  </Icon>
);
export const SparkleIcon = () => (
  <Icon size={14}>
    <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z" />
  </Icon>
);
export const DiffIcon = () => (
  <Icon size={14}>
    <rect x="4" y="4" width="16" height="16" rx="2" />
    <path d="M12 4v16M7 9h3M8.5 7.5v3M14 9h3M14 15h3" />
  </Icon>
);
export const LogIcon = () => (
  <Icon size={14}>
    <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />
  </Icon>
);
export const WorkLogCollapsedIcon = () => (
  <Icon size={13}>
    <path d="m9 6 6 6-6 6" />
  </Icon>
);
export const WorkLogSemiExpandedIcon = () => (
  <Icon size={13}>
    <path d="m6 9 6 6 6-6" />
  </Icon>
);
export const WorkLogFullyExpandedIcon = () => (
  <Icon size={13}>
    <path d="m7 7 5 5 5-5M7 13l5 5 5-5" />
  </Icon>
);
