import type { ReactNode } from "react";
import rawCakeIconMarkup from "../../../assets/cake-icon.svg?raw";

const cakeIconMarkup = rawCakeIconMarkup.replace(/>\s+</g, "><").trim();

function Icon({
  children,
  size = 16,
  className,
  strokeWidth = 1.8,
}: {
  children: ReactNode;
  size?: number;
  className?: string;
  strokeWidth?: number;
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
      strokeWidth={strokeWidth}
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
export const FolderPlusIcon = () => (
  <Icon>
    <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z" />
    <path strokeWidth={2.2} d="M12 10v6M9 13h6" />
  </Icon>
);
export const CakeIcon = () => (
  <span className="contents" dangerouslySetInnerHTML={{ __html: cakeIconMarkup }} />
);
export const PlusIcon = () => (
  <Icon>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);
export const ExpandIcon = () => (
  <Icon size={15}>
    <path d="M9 4H4v5M15 4h5v5M20 15v5h-5M4 15v5h5" />
  </Icon>
);
export const LightningIcon = () => (
  <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
    <path d="M13.4 2 4 13.1h6.6L9.7 22 20 9.7h-6.8L13.4 2Z" />
  </svg>
);
export const BranchIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <circle cx="4" cy="3.5" r="1.8" stroke="currentColor" strokeWidth="1.4" />
    <circle cx="4" cy="12.5" r="1.8" stroke="currentColor" strokeWidth="1.4" />
    <circle cx="12" cy="5" r="1.8" stroke="currentColor" strokeWidth="1.4" />
    <path d="M4 5.3v5.4M12 6.8c0 2.5-2.5 3.2-5.5 3.6" stroke="currentColor" strokeWidth="1.4" />
  </svg>
);
export const PullRequestIcon = () => (
  <Icon size={14} strokeWidth={1.8}>
    <circle cx="6" cy="5" r="2" />
    <circle cx="18" cy="19" r="2" />
    <path d="M6 7v10M18 17v-5a4 4 0 0 0-4-4h-3" />
    <path d="m13 5-3 3 3 3" />
  </Icon>
);
export const ChatIcon = ({ size = 16 }: { size?: number }) => (
  <Icon size={size}>
    <path d="M20 15a3 3 0 0 1-3 3H8l-5 3 1.7-5.1A7 7 0 0 1 4 13V8a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3z" />
  </Icon>
);
export const AnnotationIcon = ({ size = 16 }: { size?: number }) => (
  <Icon size={size}>
    <path d="M19 15a3 3 0 0 1-3 3H8l-4 2 1.2-4A5 5 0 0 1 5 14V8a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3z" />
    <path d="M9 9h6M9 13h4" />
  </Icon>
);
export const CopyIcon = () => (
  <Icon size={15}>
    <rect x="8" y="8" width="11" height="11" rx="2" />
    <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
  </Icon>
);
export const ForkIcon = () => (
  <Icon size={15}>
    <circle cx="6" cy="5" r="2" />
    <circle cx="18" cy="5" r="2" />
    <circle cx="12" cy="19" r="2" />
    <path d="M6 7v2a4 4 0 0 0 4 4h2M18 7v2a4 4 0 0 1-4 4h-2v4" />
  </Icon>
);
export const HandoffIcon = () => (
  <Icon size={15}>
    <path d="M4 7h10M11 4l3 3-3 3M20 17H10M13 14l-3 3 3 3" />
  </Icon>
);
export const CheckIcon = () => (
  <Icon size={15}>
    <path d="m5 12 4 4L19 6" />
  </Icon>
);
export const SteerIcon = () => (
  <Icon size={13} strokeWidth={2}>
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
  </Icon>
);
export const EditIcon = () => (
  <Icon size={13} strokeWidth={2}>
    <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
  </Icon>
);
export const RemoveIcon = () => (
  <Icon size={13} strokeWidth={2}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Icon>
);
export const TrashIcon = ({ size = 15 }: { size?: number } = {}) => (
  <Icon size={size}>
    <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
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
export const ChevronDownIcon = ({ size = 14 }: { size?: number }) => (
  <Icon size={size} strokeWidth={2}>
    <path d="m6 9 6 6 6-6" />
  </Icon>
);
export const MarkdownIcon = () => (
  <svg aria-hidden="true" width="18" height="16" viewBox="0 0 18 16" fill="currentColor">
    <path d="M1 3.25A1.25 1.25 0 0 1 2.25 2h13.5A1.25 1.25 0 0 1 17 3.25v9.5A1.25 1.25 0 0 1 15.75 14H2.25A1.25 1.25 0 0 1 1 12.75zm2 2v5.5h1.5V7.5L6 9.35 7.5 7.5v3.25H9v-5.5H7.5L6 7.2 4.5 5.25zm8 0v3h-1.5L12.75 11l3.25-2.75h-1.5v-3z" />
  </svg>
);
export const PaperclipIcon = () => (
  <Icon>
    <path d="m20.5 11.5-8.9 8.9a6 6 0 0 1-8.5-8.5l9.6-9.6a4 4 0 0 1 5.7 5.7l-9.6 9.6a2 2 0 1 1-2.8-2.8l8.9-8.9" />
  </Icon>
);
export const SendIcon = () => (
  <Icon>
    <path d="m5 12 7-7 7 7M12 19V5" />
  </Icon>
);
export const StopIcon = () => (
  <Icon>
    <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />
  </Icon>
);
export const CloseIcon = ({
  size = 20,
  strokeWidth = 1.8,
}: {
  size?: number;
  strokeWidth?: number;
}) => (
  <Icon size={size} strokeWidth={strokeWidth}>
    <path d="m6 6 12 12M18 6 6 18" />
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
export const SkillIcon = () => (
  <Icon size={14}>
    <path d="m12 3 1.4 4.1L17.5 8.5l-4.1 1.4L12 14l-1.4-4.1-4.1-1.4 4.1-1.4z" />
    <path d="m18.5 14 .8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" />
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
export const SearchIcon = ({ size = 14, className }: { size?: number; className?: string }) => (
  <Icon size={size} className={className}>
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" />
  </Icon>
);
