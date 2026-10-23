# AeroShell Desktop

AeroShell Desktop is an original, Windows-inspired desktop environment that runs inside a browser and can be installed as a Progressive Web App (PWA). It is a web application, not an official Microsoft product or a replacement for Windows.

## What is included

- A floating, centered taskbar with app indicators, Start launcher, app search, Task View and desktop context menus.
- Multi-window interactions including focus, dragging, minimize, maximize, restore and close.
- **Preinstalled core:** File Explorer, AeroShell Store and Settings. Optional apps—including Calculator, Paint, Clock, Calendar, Spreadsheet, Notes, games and developer tools—are installed from AeroShell Store on demand.
- Local persistence for settings, events, notes, spreadsheet content, game scores and virtual files.
- Safe spreadsheet formula handling for arithmetic, cell references, SUM, AVERAGE, MIN and MAX ranges, without executing arbitrary JavaScript.
- Light, dark and system themes; accent color and wallpaper personalization.
- A local web app manifest, original icon, service worker and build-generated offline app-shell asset list.
- Vercel static deployment configuration.

## Important boundaries

File Explorer includes a virtual filesystem and an optional real-device file panel. Real folders are never scanned silently: the user must choose a folder and grant the browser read/write permission, or choose individual files. Folder access stays in memory for the current session. Browser restrictions differ, especially on mobile. Wi-Fi, Bluetooth, brightness, volume and airplane controls only affect AeroShell's simulated interface. External websites and network-dependent content require connectivity.

## Requirements and local development

Install Node.js 20 or newer and npm. Clone the repository and check out the feature branch if it has not been merged. From the project folder, run:

- npm install
- npm run dev

Open the local URL printed by Vite. Production verification commands:

- npm test
- npm run typecheck
- npm run build
- npm run preview

## Install and use offline

Serve the production build over HTTPS, or use localhost during development. Open AeroShell online at least once, then use the install action in Chrome or Edge when available. The production build generates a cache list for the app's local shell assets.

Offline behavior depends on the browser's storage, service-worker support and a successful initial online load. External websites will not work offline. Saved user content is kept in the current browser profile; deleting browser site data may remove it.

## Deploy to Vercel

Import the GitHub repository into Vercel, choose the Vite preset, use npm install as the install command, npm run build as the build command, and dist as the output directory. The core desktop requires no API keys, user account, backend or paid API.

## Keyboard shortcuts

- Ctrl/Command + K opens app search.
- Ctrl/Command + Shift + N opens Notes.
- Escape dismisses open menus.

## Limitations

AeroShell is a browser simulation, not native Windows. The built-in formula grammar is intentionally limited and is not a full Excel replacement. Browser timer precision may be reduced while the tab is in the background. Browser-specific install and offline behavior must be verified in a real supported browser.

## Development conventions

See AGENTS.md for project architecture and coding standards.


## Opening the website

Visitors only need to open the public website in a modern browser. They do not need Git, Node.js, a terminal, build commands, an email address, or an account. The first-run setup is a browser simulation; it does not install Windows or modify the visitor's computer.

## Deployment

The application is built as a Vite static site. Vercel should use `npm install` for installation, `npm run build` for the build command, and `dist` as the output directory. The production branch should be `main`. Connect this repository to Vercel with `main` as the Production Branch and automatic deployments enabled; each successful commit to `main` can then deploy automatically.

## Data and accounts

AeroShell has no account system or sign-in requirement. Notes, events, settings, spreadsheet content, virtual files, and game scores are stored in the current browser. That data is not synchronized between devices; clearing browser site data may remove it.


## Expanded applications

- **Spreadsheet:** multiple worksheets, up to 16 visible columns and 30 rows in the grid, direct cell editing, CSV import/export, workbook JSON backup, and safe numeric formulas including arithmetic, cell references, SUM, AVERAGE, MIN, MAX, COUNT, COUNTA, PRODUCT, MEDIAN, ROUND, ABS, SQRT, POWER and a numeric IF.
- **Code Studio:** edit HTML, CSS and JavaScript with a live preview inside a sandboxed iframe; Python runs locally in a separate browser worker through Pyodide. First-time Python execution needs internet to load the runtime. The workspace does not provide a real operating-system shell or direct access to your computer's files.
- **File Explorer:** browse the virtual workspace, or use the **Device files** panel to connect to a user-selected folder on supported browsers, list nested entries, edit text/code files, save edits to the real original file, and preview images/audio/video/PDFs. Folder handles are session-only; reselect the folder after reloading.
- **Custom wallpaper:** choose an image file in Settings; the image is resized and stored locally in the current browser.
- **Writer:** write text and export TXT or Markdown files using the browser's native save picker when available, with a safer download-link fallback.
- **Markdown Studio:** edit Markdown with a safe live preview, headings, lists, quotes and code blocks, plus `.md` export.
- **Clock & Timer:** live local clock, stopwatch, and configurable countdowns with whole-minute and second inputs. Enter one second or a duration such as 2 minutes 30 seconds; a generated multi-tone beep plays when the countdown reaches zero unless sound is turned off.
- **Focus Timer:** use 25-minute focus, 5-minute short-break or 15-minute long-break presets, or specify any custom duration down to one second (for example, 2 minutes 30 seconds). A generated multi-tone beep plays when the timer reaches zero unless sound is turned off; completed focus sessions are tracked locally.
- **Unit Converter:** convert length, weight, temperature, speed, data and volume units.
- **Color Studio:** select colors, browse a curated palette, and copy HEX, RGB or HSL values.
- **Media Player:** play audio files selected by the visitor.
- **PDF Reader:** preview a selected PDF using the browser's built-in viewer when available.
- **To Do:** create tasks, set priorities, mark them complete, filter the list and delete tasks.
- **Games:** Memory, Tic-tac-toe, Snake, 2048 and Minesweeper.

## Browser-only capabilities

AeroShell is a website, not a real Windows installation or native desktop application. It cannot run arbitrary Windows applications, control the actual Windows shell, access the full local filesystem without an explicit file picker, or change hardware settings directly. Browser-local notes, files, workbooks, code, wallpaper preferences and tasks are not synchronized across devices. Python code runs in a Web Worker, and web code runs in a sandboxed iframe.


## Advanced desktop features

### App Store and optional installation
Core desktop apps are included. Additional apps such as Code Studio, Writer, Media Player, To Do, PDF Reader, Focus Spaces, Theme Studio, AI Studio, Time Machine, Terminal & Script Lab, System Health, and the Vexel AI launcher appear in the in-app Store and must be installed there before launch. This installation process adds the browser app to AeroShell's local installed-app list; it does not install an executable on Windows. Installed app choices persist in the current browser.

### Fluid taskbar and smart tiling
The floating taskbar shows a compact audio waveform/player status while media is playing and an animated progress indicator for installation, saving, copying into Clipboard Hub, and snapshot restoration. When at least two desktop windows are open, AeroShell offers a side-by-side or stacked snap layout. It remembers locally which app pairs the visitor has snapped before and labels frequently reused pairs as a usual workspace.

### Clipboard Hub
Clipboard Hub is a local holding shelf for text, URLs, images and small supported files. Visitors can drag items into the shelf, drag shelf cards into File Explorer, Notes, Writer or Code Studio, copy text back to the operating-system clipboard with the browser's permission, and remove individual clips. The shelf is limited to 20 items to reduce browser-storage pressure. Larger selected files are represented as file references/instructions rather than copied wholesale into localStorage.

### Focus Spaces and Theme Studio
Focus Spaces provide Code, Writing, Deep Work and Relax presets that update the browser desktop's wallpaper, accent, brightness, translucency and motion settings and open relevant apps/folders. Exit Focus restores the previous appearance settings. Theme Studio offers built-in palettes; Settings can additionally import a custom image, resize it and store it locally as a wallpaper.

### AI Studio
AI Studio offers a UI for a stylized SVG/gradient concept illustration, language-specific starter-code templates and browser canvas upscaling. These are deliberately local simulations; no real image-generation model, AI inference service or photo-reconstruction model is called. Resizing increases pixel dimensions but does not create missing image detail.

### Time Machine
Time Machine records up to 24 snapshots of the AeroShell virtual file list as it changes. A slider previews a selected snapshot and shows added/removed/edited counts; restoring it replaces the current virtual file list after confirmation. This timeline is local to the current browser and starts tracking from the time snapshots become available; it cannot reconstruct previous real Windows files.

### Terminal & Script Lab
The terminal is an allowlisted command simulator, not a shell. Supported commands include help, pwd, ls, cat, echo, date, cd, and open; they operate only on the virtual filesystem or AeroShell apps. Commands such as mkdir, touch, rm and cp display a dry-run explanation; they do not execute or alter the host computer. Use Code Studio to run Python with Pyodide or web code in the sandboxed preview.

### System Health dashboard
The dashboard reports browser storage quota/usage and browser JavaScript heap or battery values only if the browser exposes those APIs. Hardware CPU temperature and total system storage may not be available to websites, and the app displays those limitations instead of fabricating readings.

### Vexel AI
The App Store includes a launcher and Web Links includes a direct link to https://vexelai-zeta.vercel.app/.

## Browser security and data scope
AeroShell is not a native Windows shell. It cannot run arbitrary Windows apps, access all laptop files without an explicit file picker, control real Wi-Fi/Bluetooth/volume settings, or mute the host operating system. Local data is not synced across devices. Clipboard images and custom wallpapers are resized before being stored in browser storage. Python execution loads Pyodide from its CDN on first run and executes in a web worker; network access is needed to fetch that runtime.


## Store-first desktop startup

The launch screen appears when AeroShell starts. It features animated audio-visualizer styling and a short synthesized welcome tune that begins only when the user clicks to enter (browser audio autoplay restrictions apply). Startup sound can be switched off on the launch screen. First-time visitors then see the existing guided setup wizard; returning visitors can launch directly into their saved desktop after the intro.

Only **File Explorer**, **AeroShell Store**, and **Settings** are installed by default. A one-time upgrade migration moves prior default-app lists to this core set without deleting saved app data. The Store itself is pinned and cannot be uninstalled. Optional apps are shown in Discover and Installed views, can be searched by name/category, installed into AeroShell's browser-local app list, opened and uninstalled. No native Windows program is downloaded or installed.

The timer's sound alert uses the Web Audio API after the visitor starts the countdown, which unlocks audio from a user gesture. If sound is disabled or the browser does not support audio, the visible countdown still works. Custom values accept 0–999 whole minutes and 0–59 seconds, with a minimum duration of one second.


## Final cross-device pass

The desktop uses viewport-aware window geometry, Pointer Events for drag/resize on mouse, stylus and touch-compatible browsers, installed-app desktop shortcuts, and responsive taskbar/menu layouts for phone portrait/landscape, tablet and laptop/Chromebook sizes. The production build fingerprints the shipped shell assets and generates a matching service-worker cache name, so a content-changing release can replace the prior cache cleanly. The app also checks for a service-worker update on launch.

New Store apps: World Clock (live city time zones), Typing Sprint (speed and accuracy practice), and Password Kit (client-side random password generation using the browser cryptography API). Passwords are generated locally and aren't uploaded or saved by the generator.


## Media, editing, audio, and coding improvements

- **Saved media library:** Photos and Media Player save chosen uploads in browser IndexedDB so they remain available after reloading or reopening AeroShell. Remove individual photos/tracks from their app to delete them from the shared local media library. AI Studio's source image can also be restored and removed; removing a shared image removes it from the Photos library too. Files stay in this browser and are not uploaded to an AeroShell server. Browser storage quotas and private-browsing settings can limit persistence.
- **System media volume:** the desktop starts at full AeroShell volume for new/default settings and upgrades the original 65% default once. Settings, the music player slider and browser/device volume still affect final loudness. Synthesized startup and timer sounds respect the AeroShell volume.
- **Paint:** pointer movement is batched with animation frames, drawing events are coalesced when the browser supports it, and undo memory is capped. PNG export avoids constructing a large base64 string.
- **Snake:** choose a saved speed and use on-screen directional controls on touchscreen devices, or use keyboard arrows.
- **Long setup flow:** region/language, keyboard hints, theme, accent, wallpaper, starting volume/accessibility, privacy information, optional app installation, and profile name are configurable before the browser desktop opens. This remains a simulation and does not change OS settings.
- **Python:** Code Studio reuses its Pyodide worker between runs during the same open editor session and provides lines of input values for the input() function. The first runtime load still requires an internet connection; stopping the worker forces the next run to reload it. Run limits protect the tab from endlessly-running code.
- **Terminal:** commands such as mkdir, touch, write, cat, cp, mv, rm, cd, and ls work on AeroShell's virtual files. This does not expose or run a real Windows/macOS/Linux shell.
- **File Explorer text editing:** text, Markdown, CSV and log files can be opened in a built-in editor, changed, saved, or reverted. Code files open in Code Studio.


## iOS-inspired mobile mode

AeroShell includes a separate browser-based iOS-inspired mobile mode alongside its Windows-style desktop. The mobile Home Screen supports saved wallpaper, configurable local widgets, app pages, an app dock, an app library, simulated Control Center and notifications, a lock screen, and a recent-app switcher. Long-press an app icon to show the top Home Screen editing bar; drag icons to reorder them within a page, move them between pages or into/out of the dock, remove them from the Home Screen, or uninstall optional apps. Swipe horizontally anywhere on the Home Screen to move between pages, and swipe up from the bottom edge of an open app to open the recent-app switcher. Button alternatives remain available for the main actions.

This remains a web simulation, not Apple iOS. Radio, battery and device-status indicators are simulated; browser storage and site permissions remain controlled by the browser.
