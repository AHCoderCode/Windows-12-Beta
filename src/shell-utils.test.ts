import { describe, expect, it } from 'vitest';
import { clampWindowFrame, createInitialWindowFrame, migrateInstalledApps } from './shell-utils';

describe('cross-device desktop geometry', () => {
  it('opens app windows maximized on narrow mobile screens', () => {
    const frame = createInitialWindowFrame(320, 568);
    expect(frame.max).toBe(true);
    expect(frame.x).toBe(8);
    expect(frame.w).toBeLessThanOrEqual(304);
    expect(frame.h).toBeLessThanOrEqual(486);
  });

  it('keeps normal desktop windows inside a Chromebook-sized viewport', () => {
    const frame = createInitialWindowFrame(768, 600);
    expect(frame.max).toBe(false);
    expect(frame.x).toBeGreaterThanOrEqual(0);
    expect(frame.y).toBeGreaterThanOrEqual(0);
    expect(frame.x + frame.w).toBeLessThanOrEqual(768);
    expect(frame.y + frame.h).toBeLessThanOrEqual(600);
  });

  it('clamps restored windows after a device rotates or resizes', () => {
    expect(clampWindowFrame({ x: 900, y: 700, w: 900, h: 700 }, 320, 568))
      .toEqual({ x: 0, y: 0, w: 304, h: 492 });
  });
});

describe('preinstalled app migration', () => {
  it('keeps only the core preinstalled apps and preserves optional installs', () => {
    expect(migrateInstalledApps(['calendar', 'explorer', 'store', 'settings', 'code', 'color-studio']))
      .toEqual(['explorer', 'store', 'settings', 'code', 'color-studio']);
  });

  it('adds missing core apps and removes duplicates', () => {
    expect(migrateInstalledApps(['calculator', 'calculator', 'password-kit']))
      .toEqual(['explorer', 'store', 'settings', 'password-kit']);
  });
});
