# Verification harnesses

Two headless checks that run the **real** engine and UI under Electron and assert on actual
rendered pixels. Run them after touching the compositor, the effect chain, or the photo flow.

```bash
npm run verify:orientation   # compositor renders upright at every effect count
npm run verify:photo         # the photo workspace, end to end
```

Each exits 0 on pass, 1 on failure, and prints a JSON result.

## Why these exist

The repo has no other tests, and that is exactly how a real bug shipped: the compositor's quad
sampled `v` top-down while FBO textures are bottom-up, so **every effect pass flipped the
frame**. Output was upside down at odd effect counts and self-cancelled at even ones — which is
why it went unnoticed, and why `verify:orientation` deliberately tests 0, 1, 2 **and 3**
effects. A check that only tried 0 and 2 would have passed against the broken code.

Both harnesses use a red-top / blue-bottom test image, so orientation is unambiguous rather
than a judgement call about a photo looking "about right".

## verify:photo

Drives the actual `EditorApp` through import → decode → layer → filter → GPU render → undo,
with no native file dialog involved. The `PlatformBridge` is what makes that possible: the stub
returns a data-URL image from `importDialog()`, so the whole flow runs headless through the
same components, store and compositor the app ships.

Its `probeMedia()` **throws on purpose**. The photo path must take image dimensions from the
decode rather than ffprobe — FFmpeg is optional per the README, and the video import path falls
back to a hardcoded 1920x1080 when it is missing. For a photo that fallback would be the canvas
size, silently letterboxing every import. The throwing stub keeps that regression caught.

## Notes

- Scripts build as **IIFE** and load over `file://`, where Chromium blocks module scripts as
  cross-origin. That is why there's a hand-written `run.html` / `ui.html` with a classic
  `<script>` rather than a vite-processed page.
- Aliases mirror `apps/desktop/electron.vite.config.ts` so the harnesses compile the same
  source the app ships. Keep them in sync when a workspace package is added.
- `main.cjs` is the Electron host: hidden window, captures the page's `__RESULT__` line,
  exits with the pass/fail code. It takes the page to load as its first argument.
