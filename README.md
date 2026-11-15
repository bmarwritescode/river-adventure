# Hyde Park Dog

A small stylized 3D browser game: explore Austin's Hyde Park as a dog. Vite + TypeScript + three.js.

## Setup

Requires Node 22 (pinned in `.nvmrc`).

```sh
nvm use
npm install
npx playwright install chromium webkit   # once, for tests
```

## Run

```sh
npm run dev      # http://localhost:5173 (hot reload)
npm run build    # type-check + production build to dist/
npm run preview  # serve the built dist/
npm test         # Playwright smoke test (Chromium + WebKit)
```

`dist/` is a static site (relative paths), so it can be shared by uploading it to any static host.

## Controls

| Key | Action |
| --- | --- |
| WASD / arrows | Move (camera-relative). Default pace = trot |
| Shift (hold) | Run |
| Alt/Option (hold) or C (toggle) | Walk |
| Space | Jump |
| E (hold) | Sniff (crawl, head down, camera low and close) |
| Click | Mouse look (pointer lock); Esc releases |
| Drag (left/right button) | Orbit without pointer lock |
| Mouse wheel | Zoom |
| P | Copy dog position as `{ x: …, z: … }` |
| T | Show/hide trigger zones |
| ` (backtick) | Tuning panel |

See `CLAUDE.md` for architecture contracts and conventions.
