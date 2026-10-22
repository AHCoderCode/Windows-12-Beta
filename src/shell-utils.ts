export type WindowFrame = { x: number; y: number; w: number; h: number };
export type InitialWindowFrame = WindowFrame & { max: boolean };

/** Creates usable, viewport-aware window geometry on desktop, tablet and narrow screens. */
export function createInitialWindowFrame(
  viewportWidth: number,
  viewportHeight: number,
  openWindowCount = 0,
): InitialWindowFrame {
  const width = Math.max(240, viewportWidth);
  const height = Math.max(220, viewportHeight);
  if (viewportWidth <= 620) {
    return {
      x: 8,
      y: 8,
      w: Math.max(180, viewportWidth - 16),
      h: Math.max(160, viewportHeight - 82),
      max: true,
    };
  }

  const w = Math.min(920, Math.max(300, width - 40));
  const h = Math.min(650, Math.max(240, height - 104));
  const offset = (Math.max(0, openWindowCount) % 5) * 22;
  const x = Math.max(8, Math.min(width - w - 8, Math.round((width - w) / 2 + offset)));
  const y = Math.max(8, Math.min(height - h - 78, Math.round((height - h) / 2 + offset)));
  return { x, y, w, h, max: false };
}

/** Clamps restored/moved/resized windows so the title bar remains reachable. */
export function clampWindowFrame(
  frame: WindowFrame,
  viewportWidth: number,
  viewportHeight: number,
): WindowFrame {
  const availableWidth = Math.max(180, viewportWidth - 16);
  const availableHeight = Math.max(160, viewportHeight - 76);
  const minWidth = Math.min(300, availableWidth);
  const minHeight = Math.min(220, availableHeight);
  const w = Math.max(minWidth, Math.min(frame.w, availableWidth));
  const h = Math.max(minHeight, Math.min(frame.h, availableHeight));
  return {
    x: Math.max(0, Math.min(frame.x, viewportWidth - w)),
    y: Math.max(0, Math.min(frame.y, viewportHeight - h - 64)),
    w,
    h,
  };
}

/** Upgrades the old preinstalled catalog while preserving apps explicitly installed later. */
export function migrateInstalledApps(current: string[]): string[] {
  const legacyDefaults = new Set([
    'calendar', 'sheets', 'notes', 'calculator', 'explorer', 'paint',
    'photos', 'clock', 'games', 'store', 'browser', 'widgets', 'settings', 'clipboard',
  ]);
  return Array.from(new Set([
    'explorer',
    'store',
    'settings',
    ...current.filter((id) => !legacyDefaults.has(id)),
  ]));
}
