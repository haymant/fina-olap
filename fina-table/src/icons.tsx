import type { SVGProps } from "react";

/** Tiny dependency-free icon set (16px grid, currentColor). */

type IP = SVGProps<SVGSVGElement>;

const base = (props: IP): IP => ({
  width: 14,
  height: 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
  ...props,
});

export const ConfigIcon = (props: IP) => (
  <svg {...base(props)}>
    <path d="M4 6h16M4 12h16M4 18h16" />
    <circle cx="9" cy="6" r="2" fill="var(--ft-bg)" strokeWidth="1.6" />
    <circle cx="15" cy="12" r="2" fill="var(--ft-bg)" strokeWidth="1.6" />
    <circle cx="7" cy="18" r="2" fill="var(--ft-bg)" strokeWidth="1.6" />
  </svg>
);

export const ChevronDown = (props: IP) => (
  <svg {...base(props)}>
    <path d="m6 9 6 6 6-6" />
  </svg>
);

export const ChevronRight = (props: IP) => (
  <svg {...base(props)}>
    <path d="m9 6 6 6-6 6" />
  </svg>
);

export const ChevronsUpDown = (props: IP) => (
  <svg {...base(props)}>
    <path d="m7 14 5 5 5-5M7 10l5-5 5 5" />
  </svg>
);

export const ArrowUp = (props: IP) => (
  <svg {...base(props)}>
    <path d="M12 19V5m-6 6 6-6 6 6" />
  </svg>
);

export const ArrowDown = (props: IP) => (
  <svg {...base(props)}>
    <path d="M12 5v14m-6-6 6 6 6-6" />
  </svg>
);

export const FilterIcon = (props: IP) => (
  <svg {...base(props)}>
    <path d="M3 5h18l-7 8v6l-4-2v-4L3 5Z" />
  </svg>
);

export const RefreshIcon = (props: IP) => (
  <svg {...base(props)}>
    <path d="M20 11a8 8 0 1 0-1.4 6.4" />
    <path d="M20 5v6h-6" />
  </svg>
);

export const SunIcon = (props: IP) => (
  <svg {...base(props)}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </svg>
);

export const MoonIcon = (props: IP) => (
  <svg {...base(props)}>
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
  </svg>
);

export const TableIcon = (props: IP) => (
  <svg {...base(props)}>
    <path d="M3 3h18v18H3z" />
    <path d="M3 9h18M3 15h18M9 3v18" />
  </svg>
);

export const ChartIcon = (props: IP) => (
  <svg {...base(props)}>
    <path d="M3 3v18h18" />
    <path d="M7 15l4-5 3 3 5-7" />
  </svg>
);

export const SettingsIcon = (props: IP) => (
  <svg {...base(props)}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a1.7 1.7 0 0 0-1.7-1H1a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 3 9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 9 3a1.7 1.7 0 0 0 1-1.7V1a2 2 0 1 1 4 0v.1A1.7 1.7 0 0 0 15 3a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 9h.1a2 2 0 1 1 0 4H21a1.7 1.7 0 0 0-1.6 1Z" />
  </svg>
);

export const StackIcon = (props: IP) => (
  <svg {...base(props)}>
    <path d="M12 2 2 7l10 5 10-5-10-5Z" />
    <path d="m2 17 10 5 10-5M2 12l10 5 10-5" />
  </svg>
);

export const SlidersIcon = (props: IP) => (
  <svg {...base(props)}>
    <path d="M4 21v-7m0-4V3m8 18v-9m0-4V3m8 18v-5m0-4V3" />
    <circle cx="4" cy="14" r="1.6" strokeWidth="1.6" />
    <circle cx="12" cy="9" r="1.6" strokeWidth="1.6" />
    <circle cx="20" cy="14" r="1.6" strokeWidth="1.6" />
  </svg>
);

export const PlusIcon = (props: IP) => (
  <svg {...base(props)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const XIcon = (props: IP) => (
  <svg {...base(props)}>
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
);