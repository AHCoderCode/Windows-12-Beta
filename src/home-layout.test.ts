import { describe, expect, it } from 'vitest';
import { reorderHomeAppIds } from './home-layout';

describe('iOS-style home-screen app ordering', () => {
  it('moves an icon before the selected icon on the same page', () => {
    expect(reorderHomeAppIds(
      ['calendar', 'paint', 'notes'],
      'calendar',
      'notes',
      0,
      { calendar: 0, paint: 0, notes: 0 },
    )).toEqual(['paint', 'calendar', 'notes']);
  });

  it('moves an icon after the selected icon when dropped on its trailing half', () => {
    expect(reorderHomeAppIds(
      ['calendar', 'paint', 'notes'],
      'notes',
      'paint',
      0,
      { calendar: 0, paint: 0, notes: 0 },
      true,
    )).toEqual(['calendar', 'paint', 'notes']);
  });

  it('places a dropped icon at the end of the target page before later pages', () => {
    expect(reorderHomeAppIds(
      ['calendar', 'paint', 'clock'],
      'notes',
      null,
      1,
      { calendar: 0, paint: 0, clock: 2 },
    )).toEqual(['calendar', 'paint', 'notes', 'clock']);
  });

  it('handles an empty destination page and de-duplicates saved IDs', () => {
    expect(reorderHomeAppIds(
      ['calendar', 'calendar', 'paint'],
      'notes',
      null,
      4,
      { calendar: 0, paint: 0 },
    )).toEqual(['calendar', 'paint', 'notes']);
  });

  it('ignores a target that no longer exists and keeps all unrelated icon IDs', () => {
    expect(reorderHomeAppIds(
      ['calendar', 'paint', 'notes'],
      'paint',
      'removed-app',
      0,
      { calendar: 0, notes: 0 },
    )).toEqual(['calendar', 'notes', 'paint']);
  });
});
