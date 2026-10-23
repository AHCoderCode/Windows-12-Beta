import { useEffect, useMemo, useRef, useState, type ComponentType, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import {
  AppWindow, ArrowRight, BatteryFull, Bell, Bluetooth, CalendarDays, Check, ChevronRight, Clock3, Grid2X2, Home, ListTodo, Lock, Moon, MoveRight, Music, Plus,
  Monitor, Power, RotateCcw, Search, Settings, ShieldCheck, Smartphone, Sun, Trash2, Unlock, Volume2, Wifi, X
} from 'lucide-react';
import { getAppCategories, normalizeAppCategory } from './app-catalog';

type Mode = 'windows12' | 'ios27';
export type IOSAppItem = {
  id: string;
  title: string;
  description: string;
  category: string;
  color: string;
  Icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  defaultInstalled?: boolean;
};
export type IOSRunningApp = { id: number; app: string; min: boolean };
export type IOSPrefs = {
  wallpaper: string;
  customWallpaper?: string;
  doNotDisturb: boolean;
  notifications: boolean;
  gestures: boolean;
  showBatteryPercent: boolean;
};
export type IOSSharedPrefs = {
  theme: 'dark' | 'light' | 'system';
  accent: string;
  volume: number;
  brightness: number;
  wifi: boolean;
  bluetooth: boolean;
  airplane: boolean;
  motion: boolean;
};
type IOSExperienceProps = {
  apps: IOSAppItem[];
  installed: string[];
  runningApps: IOSRunningApp[];
  activeApp: string | null;
  clock: Date;
  iosPrefs: IOSPrefs;
  sharedPrefs: IOSSharedPrefs;
  onUpdateIOSPrefs: (value: Partial<IOSPrefs>) => void;
  onUpdateSharedPrefs: (value: Partial<IOSSharedPrefs>) => void;
  onLaunchApp: (id: string) => void;
  onHome: () => void;
  onSwitchApp: (windowId: number, appId: string) => void;
  onCloseApp: (windowId: number, appId: string) => void;
  onUninstallApp: (appId: string) => void;
  onSwitchMode: (mode: Mode) => void;
};

const WALLPAPERS = [
  { id: 'aurora', name: 'Aurora', className: 'ios-wallpaper-aurora' },
  { id: 'ocean', name: 'Ocean', className: 'ios-wallpaper-ocean' },
  { id: 'sunset', name: 'Sunset', className: 'ios-wallpaper-sunset' },
  { id: 'forest', name: 'Forest', className: 'ios-wallpaper-forest' },
  { id: 'rose', name: 'Rose', className: 'ios-wallpaper-rose' },
  { id: 'midnight', name: 'Midnight', className: 'ios-wallpaper-midnight' },
];

function useSavedLocal<T>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  });
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage may be disabled */ }
  }, [key, value]);
  return [value, setValue] as const;
}

const formatClock = (date: Date, hour12 = false) =>
  date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12 });

export function IOSExperience({
  apps, installed, runningApps, activeApp, clock, iosPrefs, sharedPrefs,
  onUpdateIOSPrefs, onUpdateSharedPrefs, onLaunchApp, onHome, onSwitchApp, onCloseApp, onUninstallApp, onSwitchMode,
}: IOSExperienceProps) {
  const [panel, setPanel] = useState<'library' | 'control' | 'notifications' | 'switcher' | 'icon-menu' | 'widgets' | null>(null);
  const [libraryQuery, setLibraryQuery] = useState('');
  const [libraryCategory, setLibraryCategory] = useState('All');
  const [installedOnly, setInstalledOnly] = useState(false);
  const [page, setPage] = useState(0);
  const [hiddenHomeApps, setHiddenHomeApps] = useSavedLocal<string[]>('aeroshell.ios27.hidden-home-apps.v1', []);
  const [homeAppPages, setHomeAppPages] = useSavedLocal<Record<string, number>>('aeroshell.ios27.home-pages.v1', {});
  const [savedDockIds, setSavedDockIds] = useSavedLocal<string[]>('aeroshell.ios27.dock.v1', ['store', 'explorer', 'settings', 'notes']);
  const [widgetIds, setWidgetIds] = useSavedLocal<string[]>('aeroshell.ios27.widgets.v1', ['clock', 'calendar', 'reminders', 'music']);

  const [locked, setLocked] = useState(false);
  const [contextApp, setContextApp] = useState<string | null>(null);
  const gesture = useRef<{ x: number; y: number; target: string } | null>(null);
  const longPressTimer = useRef<number | null>(null);
  const longPressedRef = useRef(false);
  const indicatorSwipe = useRef<{ y: number } | null>(null);
  const didSwipeHomeIndicator = useRef(false);

  const safeHiddenApps = Array.isArray(hiddenHomeApps) ? hiddenHomeApps : [];
  const safeHomePages = homeAppPages && typeof homeAppPages === 'object' && !Array.isArray(homeAppPages) ? homeAppPages : {};
  const safeDockIds = Array.isArray(savedDockIds) ? savedDockIds : ['store', 'explorer', 'settings', 'notes'];
  const safeWidgetIds = Array.isArray(widgetIds) ? widgetIds.filter(id => ['clock', 'calendar', 'reminders', 'music', 'quick'].includes(id)) : ['clock', 'calendar', 'reminders', 'music'];
  const installedApps = useMemo(
    () => apps.filter(app => installed.includes(app.id)),
    [apps, installed],
  );
  const homeApps = useMemo(() => installedApps.filter(app => !safeHiddenApps.includes(app.id)), [installedApps, safeHiddenApps]);
  const homePages = useMemo(() => homeApps.map((app, index) => ({ app, page: Number.isInteger(safeHomePages[app.id]) && safeHomePages[app.id] >= 0 ? Math.min(50, safeHomePages[app.id]) : Math.floor(index / 16) })), [homeApps, safeHomePages]);
  const homePageCount = Math.max(1, Math.ceil(homeApps.length / 16), ...homePages.map(item => item.page + 1));
  const visibleHomeApps = homePages.filter(item => item.page === page).map(item => item.app);
  const dockIds = useMemo(() => safeDockIds.filter(id => installed.includes(id)).slice(-4), [safeDockIds, installed]);
  const openTaskCount = (() => { try { const value = JSON.parse(localStorage.getItem('aeroshell.tasks.v1') ?? '[]'); return Array.isArray(value) ? value.filter((task: { done?: boolean }) => !task.done).length : 0; } catch { return 0; } })();
  const categories = useMemo(() => ['All', ...getAppCategories(apps)], [apps]);
  const filteredApps = useMemo(() => apps.filter(app => {
    if (installedOnly && !installed.includes(app.id)) return false;
    if (libraryCategory !== 'All' && normalizeAppCategory(app.id, app.category) !== libraryCategory) return false;
    const needle = libraryQuery.trim().toLocaleLowerCase();
    return !needle || [app.title, app.description, normalizeAppCategory(app.id, app.category)].join(' ').toLocaleLowerCase().includes(needle);
  }), [apps, installed, installedOnly, libraryCategory, libraryQuery]);
  const activeAppDef = apps.find(app => app.id === activeApp);
  const wallpaperClass = iosPrefs.wallpaper==='custom'?'ios-wallpaper-custom':WALLPAPERS.find(item => item.id === iosPrefs.wallpaper)?.className ?? 'ios-wallpaper-aurora';
  const running = useMemo(() => [...runningApps].reverse(), [runningApps]);

  const showPanel = (next: typeof panel) => {
    setContextApp(null);
    setPanel(current => current === next ? null : next);
  };
  const launch = (appId: string) => {
    setPanel(null);
    setContextApp(null);
    setLibraryQuery('');
    onLaunchApp(appId);
  };
  const holdStart = (event: ReactPointerEvent<HTMLButtonElement>, appId: string) => {
    if (event.pointerType === 'mouse') return;
    longPressedRef.current = false;
    if (longPressTimer.current !== null) window.clearTimeout(longPressTimer.current);
    longPressTimer.current = window.setTimeout(() => {
      longPressedRef.current = true;
      setContextApp(appId);
      setPanel('icon-menu');
    }, 520);
  };
  const holdEnd = () => {
    if (longPressTimer.current !== null) window.clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
  };
  useEffect(() => () => {
    if (longPressTimer.current !== null) window.clearTimeout(longPressTimer.current);
  }, []);
  useEffect(() => {
    setHiddenHomeApps(current => Array.isArray(current) ? current.filter(id => installed.includes(id)) : []);
    setSavedDockIds(current => Array.isArray(current) ? current.filter(id => installed.includes(id)) : ['store', 'explorer', 'settings', 'notes']);
  }, [installed, setHiddenHomeApps, setSavedDockIds]);
  useEffect(() => { setPage(current => Math.max(0, Math.min(current, homePageCount - 1))); }, [homePageCount]);

  const homeGestureStart = (event: ReactPointerEvent<HTMLElement>) => {
    if (!iosPrefs.gestures) return;
    const target = event.target as HTMLElement;
    const onGrid = Boolean(target.closest('.ios-icon-grid'));
    if (target.closest('input,textarea,select,a,.ios-home-indicator,.ios-panel-overlay,.ios-home-scroll') || (target.closest('button') && !onGrid)) return;
    gesture.current = { x: event.clientX, y: event.clientY, target: onGrid ? 'grid' : 'background' };
  };
  const homeGestureEnd = (event: ReactPointerEvent<HTMLElement>) => {
    if (!iosPrefs.gestures) { gesture.current = null; return; }
    const start = gesture.current;
    gesture.current = null;
    if (!start || start.target === 'status' || panel || locked) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.2 && start.target === 'grid') {
      const pages = homePageCount;
      setPage(current => Math.max(0, Math.min(pages - 1, current + (dx < 0 ? 1 : -1))));
      return;
    }
    if (dy > 75 && start.y < 70) showPanel(start.x < window.innerWidth / 2 ? 'notifications' : 'control');
  };
  const statusGestureStart = (event: ReactPointerEvent<HTMLDivElement>) => { if (!iosPrefs.gestures) return; gesture.current = { x: event.clientX, y: event.clientY, target: 'status' }; };
  const statusGestureEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!iosPrefs.gestures) { gesture.current = null; return; }
    const start = gesture.current; gesture.current = null;
    if (!start || locked) return;
    if (event.clientY - start.y > 26) showPanel(start.x < window.innerWidth / 2 ? 'notifications' : 'control');
  };
  const indicatorStart = (event: ReactPointerEvent<HTMLButtonElement>) => { didSwipeHomeIndicator.current = false; indicatorSwipe.current = { y: event.clientY }; };
  const indicatorEnd = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!iosPrefs.gestures) { indicatorSwipe.current = null; return; }
    const start = indicatorSwipe.current; indicatorSwipe.current = null;
    if (!start) return;
    const delta = event.clientY - start.y;
    if (delta < -70) {
      didSwipeHomeIndicator.current = true;
      if (delta < -145) showPanel('switcher');
      else onHome();
    }
  };
  const shellStyle = {
    '--ios-accent': sharedPrefs.accent,
    '--ios-brightness': Math.max(20, Math.min(100, sharedPrefs.brightness)) / 100,
    backgroundImage: iosPrefs.wallpaper === 'custom' && iosPrefs.customWallpaper ? 'linear-gradient(#07101f22,#07101f44),url("' + iosPrefs.customWallpaper + '")' : undefined,
  } as CSSProperties;

  return <div className={'ios-shell '+(activeApp ? 'is-app-active ' : '')+(locked ? 'is-locked ' : '')+(panel==='icon-menu'?'is-editing ':'')+wallpaperClass} style={shellStyle} data-ios-shell="true"
    onPointerDown={homeGestureStart} onPointerUp={homeGestureEnd} onPointerCancel={() => { gesture.current = null; }}>
    <div className="ios-wallpaper-glow" aria-hidden="true"/>
    {(!activeApp || panel==='switcher') && !locked && <div className="ios-status-bar" onPointerDown={statusGestureStart} onPointerUp={statusGestureEnd}>
      <button className="ios-status-clock" title="Open lock screen" onClick={() => { setLocked(true); setPanel(null); }}>{formatClock(clock, false)}</button>
      <div className="ios-status-indicators">
        {sharedPrefs.airplane ? <Power size={13}/> : <><span className="ios-signal-bars" aria-label={sharedPrefs.wifi?'Wi-Fi simulation on':'Wi-Fi simulation off'}><i/><i/><i/><i/></span>{sharedPrefs.wifi && <Wifi size={13}/>}</>}
        {sharedPrefs.bluetooth && <Bluetooth size={13}/>}
        {iosPrefs.showBatteryPercent && <span className="ios-battery-percent">88%</span>}
        <span className="ios-battery"><BatteryFull size={17}/><i/></span>
      </div>
    </div>}

    {!activeApp && !locked && <main className="ios-home-screen" aria-label="iOS-inspired home screen">
      <div className="ios-greeting">
        <div className="ios-greeting-copy"><span>{clock.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</span><strong>{formatClock(clock, true)}</strong><small>AeroShell mobile experience</small></div>
        <div className="ios-home-utility-actions">
          <button onClick={() => showPanel('notifications')} aria-label="Open notifications" title="Notifications"><Bell size={15}/></button>
          <button onClick={() => showPanel('control')} aria-label="Open Control Center" title="Control Center"><Sun size={15}/></button>
          <button onClick={() => showPanel('library')} aria-label="Open App Library" title="App Library"><Grid2X2 size={15}/></button>
          <button onClick={() => showPanel('widgets')} aria-label="Edit Home Screen widgets" title="Edit widgets"><Plus size={15}/></button>
        </div>
      </div>
      <div className="ios-widget-grid" aria-label="Home screen widgets">
        {safeWidgetIds.map(id => id === 'clock' ? <button key={id} className="ios-widget ios-widget-clock" onClick={() => launch('clock')}><span className="ios-widget-label"><Clock3 size={14}/> World time</span><strong>{formatClock(clock, true)}</strong><small>{clock.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</small></button>
          : id === 'calendar' ? <button key={id} className="ios-widget ios-widget-calendar" onClick={() => launch('calendar')}><span className="ios-widget-label"><CalendarDays size={14}/> Calendar</span><strong>{clock.toLocaleDateString([], { day: '2-digit' })}</strong><small>{clock.toLocaleDateString([], { weekday: 'long', month: 'long' })}</small></button>
          : id === 'reminders' ? <button key={id} className="ios-widget ios-widget-reminders" onClick={() => launch('tasks')}><span className="ios-widget-label"><ListTodo size={14}/> Reminders</span><strong>{openTaskCount}</strong><small>{openTaskCount === 1 ? 'task to complete' : 'tasks to complete'}</small></button>
          : id === 'music' ? <button key={id} className="ios-widget ios-widget-music" onClick={() => launch('music')}><span className="ios-widget-label"><Music size={14}/> Now Playing</span><strong>Media Player</strong><small>Tap to open your audio library</small></button>
          : <button key={id} className="ios-widget ios-widget-quick" onClick={() => showPanel('control')}><span className="ios-widget-label"><Sun size={14}/> Quick controls</span><strong>Control Center</strong><small>Brightness, volume and appearance</small></button>)}
      </div>
      <div className="ios-icon-grid" aria-label="Installed applications">
        {visibleHomeApps.map(app => {
          const Icon = app.Icon;
          return <button className="ios-app-icon" key={app.id} onClick={() => { if (longPressedRef.current) { longPressedRef.current = false; return; } launch(app.id); }}
            onContextMenu={event => { event.preventDefault(); setContextApp(app.id); setPanel('icon-menu'); }}
            onPointerDown={event => holdStart(event, app.id)} onPointerUp={holdEnd} onPointerCancel={holdEnd} onPointerLeave={holdEnd}
            aria-label={'Open '+app.title} title={app.title}>
            <span className="ios-icon-art" style={{ '--app-color': app.color } as CSSProperties}><Icon size={24} strokeWidth={1.8}/></span><span className="ios-app-name">{app.title}</span>
          </button>;
        })}
      </div>
      <div className="ios-home-pagination" aria-label="Home screen pages">
        {Array.from({ length: homePageCount }, (_, index) => <button key={index} className={page === index ? 'active' : ''} aria-label={'Go to home page '+(index+1)} onClick={() => setPage(index)} />)}
      </div>
      <div className="ios-dock" aria-label="Application dock">
        {dockIds.map(id => { const app = apps.find(item => item.id === id); if (!app) return null; const Icon = app.Icon; return <button key={id} className="ios-dock-icon" aria-label={'Open '+app.title} title={app.title} onClick={() => launch(id)}><span className="ios-icon-art" style={{ '--app-color': app.color } as CSSProperties}><Icon size={24}/></span></button>; })}
        <button className="ios-dock-library" onClick={() => showPanel('library')} aria-label="Open App Library"><Grid2X2 size={19}/></button>
      </div>
    </main>}

    {activeApp && !locked && <div className="ios-app-topbar">
      <span className="ios-app-title">{activeAppDef?.title ?? activeApp}</span>
      <div className="ios-app-top-actions"><button onClick={onHome} aria-label="Return to home screen"><Home size={16}/> Home</button><button onClick={() => showPanel('switcher')} aria-label="Open app switcher"><AppWindow size={16}/> Apps</button></div>
    </div>}

    {locked && <div className="ios-lock-screen">
      <div className="ios-lock-top"><span>AEROSHELL · iOS 27 MODE</span><button onClick={() => setLocked(false)} aria-label="Unlock simulated lock screen"><Unlock size={17}/></button></div>
      <div className="ios-lock-clock"><strong>{formatClock(clock, true)}</strong><span>{clock.toLocaleDateString([], { weekday:'long', month:'long', day:'numeric' })}</span></div>
      <div className="ios-lock-notification"><Bell size={17}/><div><b>{iosPrefs.notifications ? 'Notifications' : 'Quiet mode'}</b><small>{iosPrefs.notifications ? 'Your AeroShell apps and workspace are ready.' : 'App notifications are hidden in Settings.'}</small></div></div>
      <button className="ios-unlock-button" onClick={() => setLocked(false)}><Unlock size={17}/> Tap to unlock</button>
    </div>}

    {panel && !locked && <div className={'ios-panel-overlay ios-panel-'+panel} role="dialog" aria-modal="true" aria-label={panel==='library'?'App Library':panel==='control'?'Control Center':panel==='notifications'?'Notification Center':panel==='switcher'?'App Switcher':'App actions'}>
      <button className="ios-panel-backdrop" aria-label="Close panel" onClick={() => { setPanel(null); setContextApp(null); }}/>
      <section className="ios-panel-card">
        <header className="ios-panel-heading"><div><span className="ios-panel-grabber"/><h2>{panel==='library'?'App Library':panel==='control'?'Control Center':panel==='notifications'?'Notification Center':panel==='switcher'?'App Switcher':panel==='widgets'?'Edit Home Widgets':contextApp ? apps.find(app=>app.id===contextApp)?.title : 'App actions'}</h2></div><button className="ios-panel-close" onClick={() => { setPanel(null); setContextApp(null); }} aria-label="Close panel"><X size={17}/></button></header>

        {panel==='library' && <>
          <label className="ios-library-search"><Search size={16}/><input value={libraryQuery} onChange={event=>setLibraryQuery(event.target.value)} placeholder="Search all apps" aria-label="Search apps"/></label>
          <div className="ios-library-filters"><div className="ios-category-row"><button className={libraryCategory==='All'?'active':''} onClick={()=>setLibraryCategory('All')}>All</button>{categories.map(category=><button key={category} className={libraryCategory===category?'active':''} onClick={()=>setLibraryCategory(category)}>{category}</button>)}</div><label className="ios-installed-toggle"><input type="checkbox" checked={installedOnly} onChange={event=>setInstalledOnly(event.target.checked)}/>Installed only</label></div>
          <div className="ios-library-grid">{filteredApps.map(app=>{const Icon=app.Icon;const isInstalled=installed.includes(app.id);return <article key={app.id} className="ios-library-app"><button className="ios-library-app-main" onClick={()=>launch(app.id)}><span className="ios-icon-art" style={{'--app-color':app.color} as CSSProperties}><Icon size={23}/></span><span><b>{app.title}</b><small>{normalizeAppCategory(app.id,app.category)}</small></span></button><p>{app.description}</p><div className="ios-library-actions">{isInstalled?<button onClick={()=>launch(app.id)}>Open</button>:<button onClick={()=>launch(app.id)}>Get</button>}{isInstalled&&<span><Check size={12}/> Installed</span>}</div></article>;})}{!filteredApps.length&&<div className="ios-empty"><Search size={22}/><b>No matching apps</b><span>Try a different name or category.</span></div>}</div>
        </>}

        {panel==='control' && <div className="ios-control-content">
          <div className="ios-control-grid">
            <button className={'ios-control-tile wide '+(sharedPrefs.wifi&&!sharedPrefs.airplane?'on':'')} onClick={()=>onUpdateSharedPrefs({wifi:!sharedPrefs.wifi})}><Wifi size={21}/><span><b>Wi-Fi</b><small>{sharedPrefs.wifi&&!sharedPrefs.airplane?'Simulation On':'Simulation Off'}</small></span></button>
            <button className={'ios-control-tile '+(sharedPrefs.bluetooth?'on':'')} onClick={()=>onUpdateSharedPrefs({bluetooth:!sharedPrefs.bluetooth})}><Bluetooth size={21}/><span><b>Bluetooth</b><small>{sharedPrefs.bluetooth?'On':'Off'}</small></span></button>
            <button className={'ios-control-tile '+(sharedPrefs.airplane?'on':'')} onClick={()=>onUpdateSharedPrefs({airplane:!sharedPrefs.airplane})}><Power size={21}/><span><b>Airplane</b><small>{sharedPrefs.airplane?'On':'Off'}</small></span></button>
            <button className={'ios-control-tile '+(iosPrefs.doNotDisturb?'on':'')} onClick={()=>onUpdateIOSPrefs({doNotDisturb:!iosPrefs.doNotDisturb})}><Moon size={21}/><span><b>Do Not Disturb</b><small>{iosPrefs.doNotDisturb?'On':'Off'}</small></span></button>
            <button className={'ios-control-tile '+(sharedPrefs.theme==='dark'?'on':'')} onClick={()=>onUpdateSharedPrefs({theme:sharedPrefs.theme==='dark'?'light':'dark'})}><Sun size={21}/><span><b>Appearance</b><small>{sharedPrefs.theme==='dark'?'Dark':'Light'}</small></span></button>
          </div>
          <label className="ios-range-row"><span><Sun size={16}/> Simulated brightness <b>{sharedPrefs.brightness}%</b></span><input type="range" min="20" max="100" value={sharedPrefs.brightness} onChange={event=>onUpdateSharedPrefs({brightness:Number(event.target.value)})}/></label>
          <label className="ios-range-row"><span><Volume2 size={16}/> Media volume <b>{sharedPrefs.volume}%</b></span><input type="range" min="0" max="100" value={sharedPrefs.volume} onChange={event=>onUpdateSharedPrefs({volume:Number(event.target.value)})}/></label>
          <div className="ios-control-actions"><button onClick={() => { setPanel(null); launch('settings'); }}><Settings size={15}/> Settings</button><button onClick={() => onSwitchMode('windows12')}><Monitor size={15}/> Windows 12</button><button onClick={() => { setLocked(true); setPanel(null); }}><Lock size={15}/> Lock screen</button></div>
          <p className="ios-hint">Connectivity controls are visual simulations only. They do not change your device radios or operating-system brightness.</p>
        </div>}

        {panel==='notifications' && <div className="ios-notification-list">
          {!iosPrefs.notifications || iosPrefs.doNotDisturb ? <div className="ios-empty"><Bell size={22}/><b>You're all caught up</b><span>Notifications are muted or disabled in AeroShell Settings.</span></div> : <>
            <article className="ios-notification-card"><span className="ios-notification-icon"><Smartphone size={18}/></span><div><b>AeroShell is ready</b><p>Your workspace and apps are available locally in this browser.</p><small>Just now · System</small></div></article>
            {runningApps.length>0&&<article className="ios-notification-card"><span className="ios-notification-icon"><AppWindow size={18}/></span><div><b>{runningApps.length} app{runningApps.length===1?'':'s'} running</b><p>Your open apps keep their current browser session when you move between them.</p><small>Workspace · Simulation</small></div></article>}
          </>}
          <button className="ios-secondary-action" onClick={()=>onUpdateIOSPrefs({notifications:!iosPrefs.notifications})}>{iosPrefs.notifications?'Turn notifications off':'Turn notifications on'}</button>
        </div>}

        {panel==='widgets' && <div className="ios-widget-editor">
          <p>Choose the glanceable widgets shown on your Home Screen. Tap a widget to open its app or controls.</p>
          {[
            {id:'clock',title:'Clock',description:'Current time and date',Icon:Clock3},
            {id:'calendar',title:'Calendar',description:'Today at a glance',Icon:CalendarDays},
            {id:'reminders',title:'Reminders',description:'Open tasks from your local list',Icon:ListTodo},
            {id:'music',title:'Now Playing',description:'Shortcut to Media Player',Icon:Music},
            {id:'quick',title:'Quick Controls',description:'Open simulated Control Center',Icon:Sun},
          ].map(widget=>{const Icon=widget.Icon;const enabled=safeWidgetIds.includes(widget.id);return <button key={widget.id} className={'ios-widget-option '+(enabled?'selected':'')} onClick={()=>setWidgetIds(current=>{const list=Array.isArray(current)?current:[];return list.includes(widget.id)?list.filter(id=>id!==widget.id):[...list,widget.id];})}><span className="ios-widget-option-icon"><Icon size={18}/></span><span><b>{widget.title}</b><small>{widget.description}</small></span>{enabled?<Check size={17}/>:<Plus size={17}/>}</button>;})}
          <p className="ios-hint">Widgets run locally and use your saved AeroShell data. Weather, device battery health and system sensors are not read from your actual device.</p>
        </div>}

        {panel==='switcher' && <div className="ios-switcher-grid">{running.map(win=>{const app=apps.find(item=>item.id===win.app);if(!app)return null;const Icon=app.Icon;return <article key={win.id} className="ios-switcher-card"><button className="ios-switcher-preview" onClick={()=>{onSwitchApp(win.id,win.app);setPanel(null);}}><div className="ios-preview-top"><span className="ios-icon-art" style={{'--app-color':app.color} as CSSProperties}><Icon size={21}/></span><span>{app.title}</span></div><div className="ios-preview-lines"><i/><i/><i/></div><div className="ios-preview-label">{app.description}</div></button><button className="ios-switcher-close" onClick={()=>onCloseApp(win.id,win.app)} aria-label={'Close '+app.title}><X size={15}/></button><button className="ios-switcher-return" onClick={()=>{onSwitchApp(win.id,win.app);setPanel(null);}}>Return to {app.title}</button></article>;})}{!running.length&&<div className="ios-empty"><AppWindow size={26}/><b>No open apps</b><span>Apps you open will appear here, ready to resume.</span><button onClick={()=>setPanel('library')}>Browse App Library</button></div>}</div>}

        {panel==='icon-menu' && contextApp && <div className="ios-icon-action-menu">
          <p>{apps.find(app=>app.id===contextApp)?.description}</p>
          <button onClick={()=>launch(contextApp)}><ArrowRight size={15}/> Open app</button>
          <button onClick={()=>{const index=homeApps.findIndex(app=>app.id===contextApp);const currentPage=Number.isInteger(safeHomePages[contextApp])?Math.min(50,safeHomePages[contextApp]):Math.max(0,Math.floor(index/16));const nextPage=Math.min(50,currentPage+1);setHomeAppPages(current=>({...((current&&typeof current==='object')?current:{}),[contextApp]:nextPage}));setPage(nextPage);setPanel(null);setContextApp(null);}}><MoveRight size={15}/> Move to next Home Screen page</button>
          <button onClick={()=>{const next=[...safeDockIds.filter(id=>id!==contextApp),contextApp].slice(-4);setSavedDockIds(next);setHiddenHomeApps(current=>Array.from(new Set([...(Array.isArray(current)?current:[]),contextApp])));setPanel(null);setContextApp(null);}}><Smartphone size={15}/> Move to dock</button>
          <button onClick={()=>{setHiddenHomeApps(current=>Array.from(new Set([...(Array.isArray(current)?current:[]),contextApp])));setSavedDockIds(current=>Array.isArray(current)?current.filter(id=>id!==contextApp):[]);setPanel(null);setContextApp(null);}}><X size={15}/> Remove from Home Screen</button>
          <button onClick={()=>{const id=contextApp;setPanel(null);setContextApp(null);onUninstallApp(id);}}><Trash2 size={15}/> Uninstall app</button>
          <button onClick={()=>{setPanel('library');setLibraryQuery(apps.find(app=>app.id===contextApp)?.title??'');}}><Search size={15}/> Find in App Library</button>
        </div>
      </section>
    </div>}

    {locked && <button className="ios-lock-exit" onClick={() => setLocked(false)} aria-label="Unlock AeroShell"><Unlock size={16}/> Unlock</button>}

    <button className={'ios-home-indicator '+(activeApp?'active':'')} aria-label={activeApp?'Return to home screen':'Open home screen'} onPointerDown={indicatorStart} onPointerUp={indicatorEnd} onPointerCancel={()=>{indicatorSwipe.current=null;}} onClick={()=>{if(didSwipeHomeIndicator.current){didSwipeHomeIndicator.current=false;return;}if(panel){setPanel(null);setContextApp(null);}else if(activeApp)onHome();else if(locked)setLocked(false);}}><span/></button>
    {!activeApp && !locked && <button className="ios-mode-label" onClick={() => onSwitchMode('windows12')} title="Switch back to Windows 12"><Monitor size={13}/> Windows 12</button>}
  </div>;
}


type IOSSettingsProps = {
  apps: IOSAppItem[];
  installed: string[];
  mode: Mode;
  iosPrefs: IOSPrefs;
  sharedPrefs: IOSSharedPrefs;
  onUpdateIOSPrefs: (value: Partial<IOSPrefs>) => void;
  onUpdateSharedPrefs: (value: Partial<IOSSharedPrefs>) => void;
  onSwitchMode: (mode: Mode) => void;
  onLaunchApp: (id: string) => void;
  onUninstallApp: (id: string) => void;
  onResetSettings: () => void;
};

export function IOSSettingsApp({apps, installed, mode, iosPrefs, sharedPrefs, onUpdateIOSPrefs, onUpdateSharedPrefs, onSwitchMode, onLaunchApp, onUninstallApp, onResetSettings}: IOSSettingsProps) {
  const [storage,setStorage] = useState<{usage?:number;quota?:number}|null>(null);
  const [storageError,setStorageError] = useState('');
  useEffect(() => {
    let live = true;
    const storageApi = navigator.storage as StorageManager & { estimate?: () => Promise<StorageEstimate> };
    if (!storageApi?.estimate) { setStorage(null); setStorageError('Storage estimates are not available in this browser.'); return; }
    void storageApi.estimate().then(result => { if (live) { setStorage({usage:result.usage,quota:result.quota}); setStorageError(''); } }).catch(() => { if (live) setStorageError('The browser did not provide a storage estimate.'); });
    return () => { live = false; };
  }, []);
  const formatBytes = (bytes?:number) => bytes === undefined ? 'Unknown' : bytes < 1024*1024 ? Math.round(bytes/1024)+' KB' : (bytes/(1024*1024)).toFixed(1)+' MB';
  const setWallpaper = (id:string) => onUpdateIOSPrefs({wallpaper:id,customWallpaper:undefined});
  return <div className="ios-settings-app"><header className="ios-settings-hero"><span className="ios-settings-gear"><Settings size={25}/></span><div><p className="eyebrow">AEROSHELL MOBILE</p><h2>Settings</h2><p>Personalize this browser-based mobile workspace.</p></div></header>
    <section className="ios-settings-group"><h3>Operating system</h3><div className="ios-mode-choices"><button className={mode==='windows12'?'active':''} onClick={()=>onSwitchMode('windows12')}><Monitor size={19}/><span><b>Windows 12</b><small>Desktop workspace</small></span>{mode==='windows12'&&<Check size={17}/>}</button><button className={mode==='ios27'?'active':''} onClick={()=>onSwitchMode('ios27')}><Smartphone size={19}/><span><b>iOS 27 mode</b><small>Mobile-first simulation</small></span>{mode==='ios27'&&<Check size={17}/>}</button></div></section>
    <section className="ios-settings-group"><h3>Wallpaper</h3><div className="ios-wallpaper-picker">{WALLPAPERS.map(wallpaper=><button key={wallpaper.id} className={'ios-wallpaper-choice '+(iosPrefs.wallpaper===wallpaper.id?'active':'')} onClick={()=>setWallpaper(wallpaper.id)}><span className={wallpaper.className}/><b>{wallpaper.name}</b></button>)}</div><label className="ios-wallpaper-upload">Choose a custom image<input type="file" accept="image/*" onChange={event=>{const file=event.target.files?.[0];event.currentTarget.value='';if(!file||!file.type.startsWith('image/'))return;const url=URL.createObjectURL(file);const image=new Image();image.onload=()=>{const scale=Math.min(1,1600/image.width,1600/image.height);const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.width*scale));canvas.height=Math.max(1,Math.round(image.height*scale));const context=canvas.getContext('2d');if(context){context.drawImage(image,0,0,canvas.width,canvas.height);onUpdateIOSPrefs({wallpaper:'custom',customWallpaper:canvas.toDataURL('image/jpeg',0.84)});}URL.revokeObjectURL(url);};image.onerror=()=>URL.revokeObjectURL(url);image.src=url;}}/></label>{iosPrefs.customWallpaper&&<button className="ios-secondary-action" onClick={()=>setWallpaper('aurora')}>Remove custom wallpaper</button>}</section>
    <section className="ios-settings-group"><h3>Appearance and accessibility</h3><label className="ios-setting-row"><span><b>Theme</b><small>Change the simulated interface appearance</small></span><select value={sharedPrefs.theme} onChange={event=>onUpdateSharedPrefs({theme:event.target.value as IOSSharedPrefs['theme']})}><option value="dark">Dark</option><option value="light">Light</option><option value="system">System</option></select></label><label className="ios-setting-row"><span><b>Accent color</b><small>Shared highlight color</small></span><input type="color" value={sharedPrefs.accent} onChange={event=>onUpdateSharedPrefs({accent:event.target.value})}/></label><label className="ios-setting-row"><span><b>Reduce motion</b><small>Respect a lower-motion preference</small></span><input type="checkbox" checked={!sharedPrefs.motion} onChange={event=>onUpdateSharedPrefs({motion:!event.target.checked})}/></label><label className="ios-setting-row"><span><b>Show battery percentage</b><small>Simulated battery indicator</small></span><input type="checkbox" checked={iosPrefs.showBatteryPercent} onChange={event=>onUpdateIOSPrefs({showBatteryPercent:event.target.checked})}/></label><label className="ios-setting-row"><span><b>Touch gestures</b><small>Enable swipe shortcuts; buttons remain available</small></span><input type="checkbox" checked={iosPrefs.gestures} onChange={event=>onUpdateIOSPrefs({gestures:event.target.checked})}/></label></section>
    <section className="ios-settings-group"><h3>Sounds and notifications</h3><label className="ios-setting-row"><span><b>Media volume</b><small>Changes AeroShell players, not device volume</small></span><strong>{sharedPrefs.volume}%</strong></label><input className="ios-settings-range" type="range" min="0" max="100" value={sharedPrefs.volume} onChange={event=>onUpdateSharedPrefs({volume:Number(event.target.value)})}/><label className="ios-setting-row"><span><b>Notifications</b><small>Simulated AeroShell notifications</small></span><input type="checkbox" checked={iosPrefs.notifications} onChange={event=>onUpdateIOSPrefs({notifications:event.target.checked})}/></label><label className="ios-setting-row"><span><b>Do Not Disturb</b><small>Mute the notification panel</small></span><input type="checkbox" checked={iosPrefs.doNotDisturb} onChange={event=>onUpdateIOSPrefs({doNotDisturb:event.target.checked})}/></label></section>
    <section className="ios-settings-group"><h3>Applications</h3><div className="ios-settings-stat"><b>{installed.length}</b><span>Installed AeroShell apps</span><button onClick={()=>onLaunchApp('store')}>Manage in Store</button></div><div className="ios-managed-apps">{installed.filter(id=>id!=='store').map(id=>{const app=apps.find(item=>item.id===id);if(!app)return null;const Icon=app.Icon;return <div key={id} className="ios-managed-app"><span className="ios-icon-art" style={{'--app-color':app.color} as CSSProperties}><Icon size={18}/></span><span><b>{app.title}</b><small>{normalizeAppCategory(app.id,app.category)}</small></span>{!app.defaultInstalled&&<button onClick={()=>onUninstallApp(id)}>Uninstall</button>}</div>;})}</div></section>
    <section className="ios-settings-group"><h3>Browser storage</h3><div className="ios-storage-grid"><div><small>Used by this site</small><b>{storage?formatBytes(storage.usage):'Not reported'}</b></div><div><small>Quota reported</small><b>{storage?formatBytes(storage.quota):'Not reported'}</b></div></div><p>{storageError||'Values are estimates provided by the browser and may be shared across site features.'}</p></section>
    <section className="ios-settings-group"><h3>Recovery</h3><p>Reset mobile-mode appearance and interaction preferences. Documents, drawings, app installation state and game scores are retained.</p><button className="ios-reset-settings" onClick={onResetSettings}><RotateCcw size={15}/> Reset iOS settings</button></section>
    <p className="ios-settings-footnote"><ShieldCheck size={14}/> iOS 27 is a visual simulation inside AeroShell. It does not install iOS or control real system radios, brightness, notifications or device settings.</p>
  </div>;
}

