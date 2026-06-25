// Volo · Cache —— 单色线性图标集（继承 currentColor），从原型 data.jsx 的 ICON_PATHS 移植。
import type { CSSProperties } from "react";

export const ICON_PATHS: Record<string, string> = {
  previz:
    '<path d="M3 5.5h14M3 10h14M3 14.5h9" /><circle cx="15.5" cy="14.5" r="1.6" fill="currentColor" stroke="none"/>',
  calibrate:
    '<rect x="3" y="3" width="14" height="14" rx="1.5"/><path d="M3 8h14M3 12h14M8 3v14M12 3v14"/><circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  color:
    '<path d="M10 3a7 7 0 1 0 0 14c1 0 1.6-.8 1.6-1.6 0-.5-.3-.9-.3-1.4 0-.6.5-1 1.1-1H14a3 3 0 0 0 3-3c0-3.6-3.1-6-7-6Z"/><circle cx="6.6" cy="9" r=".9" fill="currentColor" stroke="none"/><circle cx="10" cy="6.4" r=".9" fill="currentColor" stroke="none"/><circle cx="13.2" cy="8.6" r=".9" fill="currentColor" stroke="none"/>',
  cache:
    '<rect x="3" y="3.5" width="14" height="5" rx="1.2"/><rect x="3" y="11.5" width="14" height="5" rx="1.2"/><circle cx="6" cy="6" r=".9" fill="currentColor" stroke="none"/><circle cx="6" cy="14" r=".9" fill="currentColor" stroke="none"/>',
  live:
    '<circle cx="10" cy="10" r="2.4"/><path d="M5.4 5.4a6.5 6.5 0 0 0 0 9.2M14.6 5.4a6.5 6.5 0 0 1 0 9.2M3 3a9.5 9.5 0 0 0 0 14M17 3a9.5 9.5 0 0 1 0 14"/>',
  tools:
    '<path d="M12.5 3.2a3.3 3.3 0 0 0-1.3 5.2L4 15.6 5.4 17l7.2-7.2a3.3 3.3 0 0 0 4.2-4.3l-2 2-1.8-.4-.4-1.8 2-2a3.3 3.3 0 0 0-1.3-.3Z"/>',
  node:
    '<rect x="3" y="3" width="14" height="6" rx="1.4"/><rect x="3" y="11" width="14" height="6" rx="1.4"/><circle cx="6" cy="6" r="1" fill="currentColor" stroke="none"/><circle cx="6" cy="14" r="1" fill="currentColor" stroke="none"/>',
  cube:
    '<path d="M10 2.6 17 6.3v7.4L10 17.4 3 13.7V6.3Z"/><path d="M3 6.3 10 10l7-3.7M10 10v7.4"/>',
  camera:
    '<rect x="2.5" y="5.5" width="15" height="10" rx="1.8"/><circle cx="10" cy="10.5" r="3"/><path d="M6.5 5.5 7.6 3.5h4.8l1.1 2"/>',
  cpu:
    '<rect x="5.5" y="5.5" width="9" height="9" rx="1.4"/><rect x="8" y="8" width="4" height="4" rx=".6"/><path d="M8 2.5v2M12 2.5v2M8 15.5v2M12 15.5v2M2.5 8h2M2.5 12h2M15.5 8h2M15.5 12h2"/>',
  thermo:
    '<path d="M8 11V4.5a2 2 0 1 1 4 0V11a3.4 3.4 0 1 1-4 0Z"/><circle cx="10" cy="13.6" r="1.4" fill="currentColor" stroke="none"/>',
  net:
    '<path d="M2.5 7a10 10 0 0 1 15 0M5 9.6a6.5 6.5 0 0 1 10 0M7.6 12.2a3 3 0 0 1 4.8 0"/><circle cx="10" cy="15" r="1.1" fill="currentColor" stroke="none"/>',
  folder:
    '<path d="M2.6 5.5A1.5 1.5 0 0 1 4 4h3.2l1.4 1.7H16A1.5 1.5 0 0 1 17.4 7v7.5A1.5 1.5 0 0 1 16 16H4a1.5 1.5 0 0 1-1.4-1.5Z"/>',
  play: '<path d="M6 4.5 15 10l-9 5.5Z" fill="currentColor" stroke="none"/>',
  plus: '<path d="M10 4v12M4 10h12"/>',
  sync:
    '<path d="M15.5 6.5A6.5 6.5 0 0 0 4.2 8M4 4v3.5h3.5M4.5 13.5A6.5 6.5 0 0 0 15.8 12M16 16v-3.5h-3.5"/>',
  more:
    '<circle cx="5" cy="10" r="1.4" fill="currentColor" stroke="none"/><circle cx="10" cy="10" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="10" r="1.4" fill="currentColor" stroke="none"/>',
  chevd: '<path d="M5.5 8 10 12.5 14.5 8"/>',
  chevr: '<path d="M8 5.5 12.5 10 8 14.5"/>',
  search: '<circle cx="9" cy="9" r="5.2"/><path d="m13 13 4 4"/>',
  settings:
    '<circle cx="10" cy="10" r="2.6"/><path d="M10 2.5v2.2M10 15.3v2.2M3.4 6.2l1.9 1.1M14.7 12.7l1.9 1.1M16.6 6.2l-1.9 1.1M5.3 12.7l-1.9 1.1"/>',
  check: '<path d="M4.5 10.5 8 14l7.5-8"/>',
  alert:
    '<path d="M10 3.5 17.5 16.5h-15Z"/><path d="M10 8.5v3.5"/><circle cx="10" cy="14.3" r=".9" fill="currentColor" stroke="none"/>',
  x: '<path d="M5 5l10 10M15 5 5 15"/>',
  terminal:
    '<rect x="2.5" y="4" width="15" height="12" rx="1.6"/><path d="M5.5 8 8 10.5 5.5 13M10 13h4"/>',
  eye: '<path d="M2.5 10S5.5 5 10 5s7.5 5 7.5 5-3 5-7.5 5-7.5-5-7.5-5Z"/><circle cx="10" cy="10" r="2.2"/>',
  target:
    '<circle cx="10" cy="10" r="6.5"/><circle cx="10" cy="10" r="2.4"/><path d="M10 1.5v3M10 15.5v3M1.5 10h3M15.5 10h3"/>',
  power: '<path d="M10 3v6"/><path d="M6 6a6 6 0 1 0 8 0"/>',
  restart: '<path d="M15.5 6.5A6.5 6.5 0 1 0 16.5 11M16 3v4h-4"/>',
  trash: '<path d="M4.5 6h11M8 6V4.5h4V6M6 6l.7 9.5h6.6L14 6"/>',
  flush:
    '<path d="M3 7c1.5 1.4 3 1.4 4.5 0S10.5 5.6 12 7s3 1.4 4.5 0M3 12c1.5 1.4 3 1.4 4.5 0s3-1.4 4.5 0 3 1.4 4.5 0"/>',
  wave: '<path d="M2.5 10c1-3 2-3 3 0s2 3 3 0 2-3 3 0 2 3 3 0"/>',
  layers: '<path d="M10 3 17 6.5 10 10 3 6.5Z"/><path d="m3 10.5 7 3.5 7-3.5"/>',
  panel:
    '<rect x="3" y="3" width="14" height="14" rx="1.5"/><path d="M7 3v14M11 3v14M15 3v14M3 7h14M3 11h14"/>',
  link:
    '<path d="M8 12a3 3 0 0 0 4 0l2-2a3 3 0 0 0-4-4l-1 1M12 8a3 3 0 0 0-4 0l-2 2a3 3 0 0 0 4 4l1-1"/>',
  download: '<path d="M10 3v9M6.5 8.5 10 12l3.5-3.5M4 15.5h12"/>',
  bolt: '<path d="M11 2.5 4.5 11H9l-1 6.5L15.5 9H11Z"/>',
  film:
    '<rect x="3" y="4" width="14" height="12" rx="1.4"/><path d="M3 7.2h14M3 12.8h14M7 4v12M13 4v12"/>',
  pulse: '<path d="M2.5 10h3l2-5 3 10 2-5h5"/>',
  shield: '<path d="M10 2.5 16 5v4.5c0 4-2.6 6.7-6 8-3.4-1.3-6-4-6-8V5Z"/><path d="M7.4 10 9.3 12l3.3-3.6"/>',
  key: '<circle cx="6.5" cy="10" r="3.2"/><path d="M9.6 10H17M14 10v3M16.4 10v2.2"/>',
  doc: '<path d="M5 2.5h6l4 4V17a.5.5 0 0 1-.5.5h-9A.5.5 0 0 1 5 17Z"/><path d="M11 2.5V6.5h4M7.5 10h5M7.5 13h5"/>',
  reg: '<ellipse cx="10" cy="5" rx="6" ry="2.3"/><path d="M4 5v10c0 1.3 2.7 2.3 6 2.3s6-1 6-2.3V5M4 10c0 1.3 2.7 2.3 6 2.3s6-1 6-2.3"/>',
  undo: '<path d="M7 7 3.5 10 7 13M3.5 10H12a4 4 0 0 1 0 8h-1.5"/>',
  redo: '<path d="M13 7l3.5 3L13 13M16.5 10H8a4 4 0 0 0 0 8h1.5"/>',
  rotate:
    '<path d="M3.5 8.5A7 7 0 0 1 16 7M16 3.5V7h-3.5M16.5 11.5A7 7 0 0 1 4 13M4 16.5V13h3.5"/>',
  grid:
    '<rect x="3" y="3" width="14" height="14" rx="1.4"/><path d="M3 7.7h14M3 12.3h14M7.7 3v14M12.3 3v14"/>',
  pin: '<path d="M10 17.5c3-3.4 5-6 5-8.5a5 5 0 0 0-10 0c0 2.5 2 5.1 5 8.5Z"/><circle cx="10" cy="9" r="1.9" fill="currentColor" stroke="none"/>',
  ruler:
    '<rect x="3" y="6.5" width="14" height="7" rx="1.2" transform="rotate(-45 10 10)"/><path d="M8 6 9 7M10.5 8.5l1 1M6 8l1 1M13 11l1 1"/>',
  cube3: '<path d="M10 2.6 17 6.3v7.4L10 17.4 3 13.7V6.3Z"/><path d="M3 6.3 10 10l7-3.7M10 10v7.4"/>',
  list:
    '<path d="M6.5 5.5h9M6.5 10h9M6.5 14.5h9"/><circle cx="3.6" cy="5.5" r="1" fill="currentColor" stroke="none"/><circle cx="3.6" cy="10" r="1" fill="currentColor" stroke="none"/><circle cx="3.6" cy="14.5" r="1" fill="currentColor" stroke="none"/>',
  sun: '<circle cx="10" cy="10" r="3.6"/><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.6 4.6l1.4 1.4M14 14l1.4 1.4M15.4 4.6 14 6M6 14l-1.4 1.4"/>',
  moon: '<path d="M16 11.2A6.5 6.5 0 1 1 8.8 4a5.2 5.2 0 0 0 7.2 7.2Z"/>',
  wmin: '<path d="M4 10h12"/>',
  wmax: '<rect x="4.5" y="4.5" width="11" height="11" rx="1"/>',
  minus: '<path d="M4.5 10h11"/>',
  pause: '<path d="M7 4.5v11M13 4.5v11"/>',
  filter: '<path d="M3 4.5h14l-5.4 6.4V16L8.4 14v-3.1Z"/>',
  copy: '<rect x="6.5" y="6.5" width="9" height="9" rx="1.4"/><path d="M4.5 11.5v-6A1 1 0 0 1 5.5 4.5h6"/>',
  arrowr: '<path d="M4 10h11M11 6l4 4-4 4"/>',
  server:
    '<rect x="3" y="4" width="14" height="5" rx="1.3"/><rect x="3" y="11" width="14" height="5" rx="1.3"/><circle cx="6" cy="6.5" r=".9" fill="currentColor" stroke="none"/><circle cx="6" cy="13.5" r=".9" fill="currentColor" stroke="none"/>',
};

export type IconName = keyof typeof ICON_PATHS | (string & {});

export interface IconProps {
  name: IconName;
  size?: number;
  stroke?: number;
  style?: CSSProperties;
  className?: string;
}

export function Icon({ name, size = 18, stroke = 1.6, style, className }: IconProps) {
  const inner = ICON_PATHS[name] || "";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      dangerouslySetInnerHTML={{ __html: inner }}
    />
  );
}
