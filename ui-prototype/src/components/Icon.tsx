interface IconProps {
  name: string;
  size?: number;
  filled?: boolean;
  className?: string;
}

/** Material Symbols Outlined glyph, used the same way as the Stitch markup. */
export function Icon({ name, size = 18, filled = false, className = '' }: IconProps) {
  return (
    <span
      aria-hidden="true"
      className={`material-symbols-outlined shrink-0 ${className}`}
      style={{
        fontSize: size,
        width: size,
        height: size,
        fontVariationSettings: `'FILL' ${filled ? 1 : 0}, 'wght' 400, 'GRAD' 0, 'opsz' 20`,
      }}
    >
      {name}
    </span>
  );
}
