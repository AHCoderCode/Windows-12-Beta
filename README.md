# AeroShell Desktop

AeroShell Desktop is an original, Windows-inspired desktop environment that runs inside a browser and can be installed as a Progressive Web App (PWA). It is a web application, not an official Microsoft product or a replacement for Windows.

## What is included

- A floating, centered taskbar with app indicators, Start launcher, app search, Task View and desktop context menus.
- Multi-window interactions including focus, dragging, minimize, maximize, restore and close.
- Calendar, Notes, Sheets, Calculator, a virtual File Explorer, Paint, Photos, Clock, Games, an App Library, Web Links, Widgets and Settings.
- Local persistence for settings, events, notes, spreadsheet content, game scores and virtual files.
- Safe spreadsheet formula handling for arithmetic, cell references, SUM, AVERAGE, MIN and MAX ranges, without executing arbitrary JavaScript.
- Light, dark and system themes; accent color and wallpaper personalization.
- A local web app manifest, original icon, service worker and build-generated offline app-shell asset list.
- Vercel static deployment configuration.

## Important boundaries

File Explorer displays a simulated filesystem; it cannot silently browse or modify real Windows folders. Import and export require explicit user action. Wi-Fi, Bluetooth, brightness, volume and airplane controls only affect AeroShell's simulated interface. External websites and network-dependent content require connectivity.

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
