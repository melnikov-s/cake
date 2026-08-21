export function EditorIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h8.25L20 10.25V18.5A1.5 1.5 0 0 1 18.5 20h-13A1.5 1.5 0 0 1 4 18.5z" />
      <path d="M13.5 4v6.5H20M8 16h2M8 12.5h2" />
      <path d="m14.5 17.5 4.25-4.25a1.06 1.06 0 0 1 1.5 1.5L16 19h-1.5z" />
    </svg>
  );
}
