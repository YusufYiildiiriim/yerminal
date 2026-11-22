// Inline copy of assets/brand/yerminal-icon.svg. tests/brand/brandMark.test.tsx keeps the paths in sync with the SVG source.
const markPaths = [
  { d: "M4 26 L16 26 L38 46 L16 66 L4 66 L26 46 Z", fill: "#1c7a48" },
  { d: "M46 28 L58 28 L82 66 L70 66 Z", fill: "#a3650f" },
  { d: "M96 28 L108 28 L68 92 L56 92 Z", fill: "#a3650f" },
];

export function BrandMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 560 560" aria-hidden="true" focusable="false">
      <rect x="2" y="2" width="556" height="556" rx="120" fill="#17161f" stroke="#2a2c36" strokeWidth="4" />
      <g transform="translate(60 80) scale(4)">
        {markPaths.map((path) => (
          <path key={path.fill + path.d} d={path.d} fill={path.fill} />
        ))}
      </g>
    </svg>
  );
}
