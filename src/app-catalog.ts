export const APP_CATEGORY_ORDER = [
  'Productivity',
  'Study',
  'Utilities',
  'Creative',
  'Entertainment',
  'Developer',
  'Security',
  'Personalization',
  'Education',
  'Internet',
  'System',
  'Other',
] as const;

export type AppCategory = (typeof APP_CATEGORY_ORDER)[number];

const VALID_CATEGORIES = new Set<string>(APP_CATEGORY_ORDER);

/** Local fallback labels for known apps. Bad metadata never becomes a visible category. */
const CATEGORY_FALLBACKS: Record<string, AppCategory> = {
  calendar: 'Productivity',
  sheets: 'Productivity',
  notes: 'Productivity',
  calculator: 'Utilities',
  explorer: 'Utilities',
  paint: 'Creative',
  photos: 'Creative',
  clock: 'Utilities',
  games: 'Entertainment',
  code: 'Developer',
  documents: 'Productivity',
  markdown: 'Productivity',
  pomodoro: 'Productivity',
  music: 'Entertainment',
  tasks: 'Productivity',
  pdf: 'Productivity',
  clipboard: 'Productivity',
  focus: 'Productivity',
  themes: 'Personalization',
  'ai-studio': 'Creative',
  'time-machine': 'Utilities',
  terminal: 'Developer',
  health: 'System',
  vexel: 'Internet',
  'unit-converter': 'Utilities',
  'color-studio': 'Creative',
  'world-clock': 'Utilities',
  'typing-sprint': 'Study',
  'password-kit': 'Security',
  store: 'System',
  browser: 'Internet',
  widgets: 'System',
  settings: 'System',
};

export function normalizeAppCategory(appId: string, value: unknown): AppCategory {
  if (typeof value === 'string') {
    const candidate = value.trim();
    if (VALID_CATEGORIES.has(candidate)) return candidate as AppCategory;
  }
  return CATEGORY_FALLBACKS[appId] ?? 'Other';
}

export type CatalogAppMetadata = {
  id: string;
  title: string;
  description: string;
  category: string;
  words?: string;
};

export function getAppCategories<T extends CatalogAppMetadata>(apps: T[], includeStore = false): AppCategory[] {
  const unique = new Set<AppCategory>();
  for (const app of apps) {
    if (!includeStore && app.id === 'store') continue;
    unique.add(normalizeAppCategory(app.id, app.category));
  }
  return APP_CATEGORY_ORDER.filter(category => unique.has(category));
}

export function filterCatalogApps<T extends CatalogAppMetadata>(
  apps: T[],
  query: string,
  category: string,
  installedIds: string[],
  view: 'Discover' | 'Installed',
): T[] {
  const needle = query.trim().toLocaleLowerCase();
  return apps.filter(app => {
    if (app.id === 'store') return false;
    if (view === 'Installed' && !installedIds.includes(app.id)) return false;
    if (category !== 'All' && normalizeAppCategory(app.id, app.category) !== category) return false;
    const searchable = [app.title, app.description, app.words ?? '', normalizeAppCategory(app.id, app.category)]
      .join(' ')
      .toLocaleLowerCase();
    return !needle || searchable.includes(needle);
  });
}
