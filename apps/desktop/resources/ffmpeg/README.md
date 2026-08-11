# Bundled FFmpeg

`ffmpeg.exe` and `ffprobe.exe` in this folder are shipped inside the installer, and
`electron/ffmpeg.ts` resolves them from `process.resourcesPath/ffmpeg/` when the app is packaged.
They are why a downloaded Open Cut can import and export without the user installing anything.

**The two executables are not in git** — they are ~110 MB each and would be in the history
forever. `npm run ffmpeg:fetch` downloads and verifies them; see below.

---

## Which build, and why that one

| | |
| --- | --- |
| Build | `ffmpeg-master-latest-win64-lgpl` |
| Version | `N-126039-g6bbc22dc09-20260810` |
| Source | [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) release `latest` |
| Licence | **LGPL v3** (`--enable-version3`, no `--enable-gpl`, no `--enable-nonfree`) |

**The LGPL build specifically, not the GPL one.** Open Cut is MIT. The GPL build includes x264
and x265, and distributing GPL components alongside the application would force the combined work
to GPL — which would contradict the licence Open Cut declares. The LGPL build can be shipped
beside MIT code provided the licence text travels with it, which is what `LICENSE.txt` here is
for.

Verified on the exact binaries in use:

```
sha256  ffmpeg.exe   a8a5274d0c5db42be41fe5d78ba27a346f65c4dbd83cf2cc322b1a4b794afa59
sha256  ffprobe.exe  3c44e846f625c231e4163633076d6f1edc94f8090d5ceb6d6239480ec383db49
```

## What it costs, in codecs

No x264 and no x265. Every codec Open Cut offers still works, from different encoders:

| Codec | Encoder in this build | Note |
| --- | --- | --- |
| H.264 | `libopenh264` | Cisco OpenH264, BSD |
| H.265 | `libkvazaar` | kvazaar, LGPL |
| VP9 | `libvpx-vp9` | unchanged |
| AV1 | `libsvtav1` | unchanged |
| ProRes | `prores_ks` | unchanged |
| GIF | `gif` | unchanged |
| AAC audio | `aac` | unchanged |

All seven were tested through the application's own encoder pipeline — raw RGBA on stdin, the
same filter chain and colour flags — before this was written.

`videoEncoder()` in `electron/ffmpeg.ts` does not hard-code these. It reads the encoder list out
of whichever binary is in use and takes the first name it actually has, preferring x264/x265 when
they are present. So a user who points `OPENCUT_FFMPEG` at their own GPL build transparently gets
the better encoder, and this folder does not have to be the only supported configuration.

## Refreshing it

```bash
npm run ffmpeg:fetch          # download, verify it is LGPL, place the binaries
npm run ffmpeg:fetch -- --force   # re-download even if the files are already here
```

The script refuses any build whose `configuration:` line contains `--enable-gpl` or
`--enable-nonfree`, so the licence guarantee is checked rather than assumed. After refreshing,
update the version and hashes above, and re-run the codec check before shipping — an upstream
build can drop an encoder.

## LGPL obligations

Shipping LGPL binaries means:

- **`LICENSE.txt` must travel with them.** It is in this folder and is copied into the installer
  by the same `extraResources` rule as the executables.
- **The user must be able to replace the library.** They can: `OPENCUT_FFMPEG` and
  `OPENCUT_FFPROBE` point the application at any other build, and dropping different executables
  into this folder in the installed app works too.
- **Source must be obtainable.** FFmpeg's own sources are at <https://ffmpeg.org/download.html>,
  and the exact build recipe is public at the BtbN repository linked above.

Nothing here modifies FFmpeg. It is redistributed unmodified, as separate executables invoked as
child processes — not linked into the application.
