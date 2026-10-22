# Nova Cut — To Do

## Full auto captions (generated SRTs)

Status: not started. Parked 2026-10-22 until after the first public release.

Goal: pick a clip, press **Generate captions**, get timed caption text on the timeline, and
export/import it as an `.srt`.

Why it is not a quick one:
- Nova Cut has no speech recognition. It needs a **local** speech-to-text engine (for example
  whisper.cpp). No cloud service, and no AI until a free local model is in place.
- The engine and a model have to ship or download on demand. Models run from about 75 MB (tiny)
  to over 1 GB (large), so decide: bundle a small one, or download on first use with a progress bar.
- Audio has to be extracted first (FFmpeg is already bundled) and resampled to what the engine wants.
- Needs language choice, a progress/cancel UI, and a way to re-time and edit the result.

Suggested order (each step is useful on its own):
1. **SRT import**: `.srt` file becomes timed text clips on a caption track.
2. **SRT export**: caption clips on the timeline written out as `.srt`.
3. A real **caption track** type, with styling shared across all captions at once.
4. **Auto-generate**: local transcription feeding step 3.
5. Word-level highlight / karaoke-style captions (later).
