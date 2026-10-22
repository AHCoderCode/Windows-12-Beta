import { describe, expect, it } from 'vitest';
import { filterCatalogApps, getAppCategories, normalizeAppCategory } from './app-catalog';

const apps = [
  { id: 'notes', title: 'Notes', description: 'Write', category: 'Productivity' },
  { id: 'typing-sprint', title: 'Typing Sprint', description: 'Practice', category: 'Study' },
  { id: 'password-kit', title: 'Password Kit', description: 'Generate locally', category: 'Security' },
  { id: 'paint', title: 'Paint', description: 'Draw', category: '@GitHub' },
  { id: 'unknown', title: 'Unknown tool', description: 'Local tool', category: '@GitHub' },
  { id: 'store', title: 'Store', description: 'Store', category: 'System' },
];

describe('app catalog categories', () => {
  it('normalizes invalid or repository-like metadata to a real category', () => {
    expect(normalizeAppCategory('paint', '@GitHub')).toBe('Creative');
    expect(normalizeAppCategory('unknown', '@GitHub')).toBe('Other');
    expect(normalizeAppCategory('notes', '  Productivity  ')).toBe('Productivity');
  });

  it('returns stable unique category labels without repository attribution', () => {
    expect(getAppCategories(apps)).toEqual(['Productivity', 'Study', 'Creative', 'Security', 'Other']);
    expect(getAppCategories(apps).some(category => category.includes('@'))).toBe(false);
  });

  it('filters by normalized category and by search across multiple apps', () => {
    expect(filterCatalogApps(apps, '', 'Creative', [], 'Discover').map(app => app.id)).toEqual(['paint']);
    expect(filterCatalogApps(apps, 'practice', 'Study', [], 'Discover').map(app => app.id)).toEqual(['typing-sprint']);
    expect(filterCatalogApps(apps, '', 'All', ['notes', 'password-kit'], 'Installed').map(app => app.id))
      .toEqual(['notes', 'password-kit']);
    expect(filterCatalogApps(apps, 'not-a-real-app', 'All', [], 'Discover')).toEqual([]);
  });

  it('supports categories with no matching apps without throwing', () => {
    expect(filterCatalogApps(apps, '', 'Nonexistent', [], 'Discover')).toEqual([]);
  });
});
