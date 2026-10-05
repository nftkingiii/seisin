import type { SVGProps } from "react";

// A small stroke icon set, 1.5px on a 24px grid, so every icon reads the same weight.
function Svg(props: SVGProps<SVGSVGElement>) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...props} />;
}

export const IconRegistry = () => (
  <Svg>
    <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z" />
    <path d="M4 9.5h16M9.5 9.5V20" />
  </Svg>
);
export const IconVault = () => (
  <Svg>
    <rect x="3.5" y="5" width="17" height="14" rx="2" />
    <circle cx="12" cy="12" r="3" />
    <path d="M12 9v-.5M12 15.5V15M15 12h.5M8.5 12H9M6.5 19v1.5M17.5 19v1.5" />
  </Svg>
);
export const IconVerify = () => (
  <Svg>
    <path d="M12 3.5 5 6v5.5c0 4.2 2.9 7.6 7 9 4.1-1.4 7-4.8 7-9V6z" />
    <path d="m9 12 2.2 2.2L15.5 10" />
  </Svg>
);
export const IconOperator = () => (
  <Svg>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8" />
  </Svg>
);
export const IconCheck = () => (
  <Svg width="14" height="14" strokeWidth={2}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Svg>
);
export const IconCross = () => (
  <Svg width="14" height="14" strokeWidth={2}>
    <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
  </Svg>
);
export const IconCopy = () => (
  <Svg width="15" height="15">
    <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
    <path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" />
  </Svg>
);
export const IconArrow = () => (
  <Svg width="15" height="15">
    <path d="M5 12h14M13.5 6.5 19 12l-5.5 5.5" />
  </Svg>
);
export const IconSeal = () => (
  <Svg width="14" height="14">
    <circle cx="12" cy="10" r="6" />
    <path d="m9 15.2-1.5 5.3L12 18.5l4.5 2-1.5-5.3" />
  </Svg>
);
export const IconBook = () => (
  <Svg width="15" height="15">
    <path d="M4.5 5.5A1.5 1.5 0 0 1 6 4h12.5v14H6a1.5 1.5 0 0 0-1.5 1.5z" />
    <path d="M4.5 19.5A1.5 1.5 0 0 0 6 21h12.5v-3" />
  </Svg>
);
export const IconCode = () => (
  <Svg width="15" height="15">
    <path d="m8.5 7-5 5 5 5M15.5 7l5 5-5 5" />
  </Svg>
);

/**
 * The mark: a wax seal pressed with a sprig. "Livery of seisin" handed over title with a twig
 * or a clod of earth; the seal is the record that says it happened.
 */
export const Mark = ({ size = 30 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
    <defs>
      <linearGradient id="seal-gold" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#f1cf7a" />
        <stop offset="1" stopColor="#c3923a" />
      </linearGradient>
    </defs>
    <path d="M16.00 3.40 A2.75 2.75 0 0 1 20.82 4.36 A2.75 2.75 0 0 1 24.91 7.09 A2.75 2.75 0 0 1 27.64 11.18 A2.75 2.75 0 0 1 28.60 16.00 A2.75 2.75 0 0 1 27.64 20.82 A2.75 2.75 0 0 1 24.91 24.91 A2.75 2.75 0 0 1 20.82 27.64 A2.75 2.75 0 0 1 16.00 28.60 A2.75 2.75 0 0 1 11.18 27.64 A2.75 2.75 0 0 1 7.09 24.91 A2.75 2.75 0 0 1 4.36 20.82 A2.75 2.75 0 0 1 3.40 16.00 A2.75 2.75 0 0 1 4.36 11.18 A2.75 2.75 0 0 1 7.09 7.09 A2.75 2.75 0 0 1 11.18 4.36 A2.75 2.75 0 0 1 16.00 3.40Z" fill="url(#seal-gold)" />
    <circle cx="16" cy="16" r="9.9" fill="none" stroke="#0e0e11" strokeOpacity=".45" strokeWidth=".6" />
    <path d="M11.6 22.4Q15.7 17.4 20.4 9.6" fill="none" stroke="#0e0e11" strokeWidth="1.35" strokeLinecap="round" />
    <ellipse cx="12.9" cy="17.1" rx="2.8" ry="1.25" transform="rotate(-150 12.9 17.1)" fill="#0e0e11" />
    <ellipse cx="19.1" cy="15" rx="2.8" ry="1.25" transform="rotate(-35 19.1 15)" fill="#0e0e11" />
    <ellipse cx="15.3" cy="11.9" rx="2.4" ry="1.1" transform="rotate(-120 15.3 11.9)" fill="#0e0e11" />
  </svg>
);
