# AeroShell Desktop — Agent Notes

## Product
Build an original Windows-inspired browser desktop and installable PWA. Do not describe the app as an official Microsoft release. Simulated settings and files must be labeled honestly.

## Stack
- React and TypeScript with Vite.
- Lucide React for interface icons.
- Shared design tokens and responsive layouts in src/styles.css.
- Browser-local storage for preferences, notes, calendar events, spreadsheet cells, game scores and the virtual filesystem.
- Vitest for automated checks.
- A local manifest and service worker for PWA installation and offline shell caching.

## Commands
- npm run dev
- npm test
- npm run typecheck
- npm run build
- npm run preview

## Engineering standards
- Keep app behavior in typed React components and share reusable primitives when practical.
- Visible controls should perform their advertised action, provide a useful disabled state or explain the limitation.
- Never use eval, execute arbitrary user-entered JavaScript, inject unsafe HTML, expose secrets or silently access the host filesystem.
- Treat File Explorer as virtual. Import and export require explicit user action.
- Keep persisted state backward compatible; do not silently reset user data.
- Respect focus visibility, keyboard access, reduced-motion preferences, narrower screens and touch input.
- Add focused tests for logic fixes; run available tests, typecheck and production build before release.
- Preserve unrelated edits and do not merge the feature branch without authorization.

## Architecture
- src/App.tsx: desktop shell and app modules.
- src/formulas.ts: safe spreadsheet formula parser.
- src/formulas.test.ts: formula evaluator test coverage.
- src/styles.css: shared visual design system and responsive layouts.
- src/main.tsx: application bootstrap and service-worker registration.
- public/: manifest, application icon and service worker.
- scripts/postbuild.mjs: generates a cache manifest of local build assets.
