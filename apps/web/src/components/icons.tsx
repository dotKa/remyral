import type { ReactNode, SVGProps } from 'react';

/** Inline 20px stroke icons (no icon font, no CDN). Decorative: hidden from assistive tech. */
function Icon(
  props: Omit<SVGProps<SVGSVGElement>, 'd'> & { readonly d: string | readonly string[] },
): ReactNode {
  const { d, className, ...rest } = props;
  const paths = typeof d === 'string' ? [d] : d;
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className ?? 'size-5'}
      {...rest}
    >
      {paths.map((p) => (
        <path key={p} d={p} />
      ))}
    </svg>
  );
}

type P = { readonly className?: string };

/** p6-outputs: a tray with an arrow out of it. */
export const OutputsIcon = (p: P): ReactNode => (
  <Icon className={p.className} d={['M4 14v5h16v-5', 'M12 3v11', 'M8 7l4-4 4 4', 'M8 17h8']} />
);
/** p8-uptime: a pulse line. */
export const UptimeIcon = (p: P): ReactNode => (
  <Icon className={p.className} d={['M3 12h4l2-5 4 10 2-5h6']} />
);
/** p6-automations: a clock with a loop arrow. */
export const AutomationsIcon = (p: P): ReactNode => (
  <Icon className={p.className} d={['M20 12a8 8 0 1 1-2.34-5.66', 'M20 4v4h-4', 'M12 8v4l3 2']} />
);
export const ChatIcon = (p: P): ReactNode => (
  <Icon className={p.className} d={['M4 5h16v11H9l-5 4z', 'M8 9.5h8', 'M8 12.5h5']} />
);
export const FleetIcon = (p: P): ReactNode => (
  <Icon className={p.className} d={['M4 5h16v5H4z', 'M4 14h16v5H4z', 'M8 7.5h.01', 'M8 16.5h.01']} />
);
export const JobsIcon = (p: P): ReactNode => (
  <Icon
    className={p.className}
    d={['M9 6h11', 'M9 12h11', 'M9 18h11', 'M4 6l1 1 2-2', 'M4 12h2', 'M4 18h2']}
  />
);
export const ApprovalsIcon = (p: P): ReactNode => (
  <Icon className={p.className} d={['M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z', 'M9 12l2 2 4-4']} />
);
export const AuditIcon = (p: P): ReactNode => (
  <Icon className={p.className} d={['M7 3h8l4 4v14H7z', 'M15 3v4h4', 'M10 12h6', 'M10 16h6']} />
);
export const SettingsIcon = (p: P): ReactNode => (
  <Icon
    className={p.className}
    d={[
      'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
      'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
    ]}
  />
);
export const UsageIcon = (p: P): ReactNode => (
  <Icon className={p.className} d={['M4 20V10', 'M10 20V4', 'M16 20v-7', 'M22 20H2']} />
);
export const ProjectsIcon = (p: P): ReactNode => (
  <Icon className={p.className} d={['M3 7h7l2 2h9v10H3z', 'M3 7V5h6l2 2']} />
);
export const ContextIcon = (p: P): ReactNode => (
  <Icon className={p.className} d={['M5 4h11l3 3v13H5z', 'M8 9h8', 'M8 13h8', 'M8 17h5']} />
);
export const SkillsIcon = (p: P): ReactNode => (
  <Icon className={p.className} d={['M12 3l2.5 5 5.5.8-4 3.9.9 5.5L12 15.6 7.1 18.2 8 12.7 4 8.8 9.5 8z']} />
);
export const HomeIcon = (p: P): ReactNode => (
  <Icon className={p.className} d={['M4 11l8-7 8 7', 'M6 9.5V20h12V9.5', 'M10 20v-5h4v5']} />
);
/** Machines (formerly Fleet). */
export const MachinesIcon = FleetIcon;
