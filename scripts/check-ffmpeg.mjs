/**
 * Refuses to package unless the bundled FFmpeg is present and redistributable.
 *
 * Runs before `npm run dist`. It exists because of the shape of the failure it prevents:
 * electron-builder does not mind an empty `extraResources` folder. It produces a perfectly
 * normal-looking installer that is simply missing FFmpeg — and that installer works on the
 * machine that built it, because that machine has FFmpeg on PATH. The defect only appears on
 * someone else's computer, as a zero-length clip on import and an export that cannot start.
 *
 * That is precisely the class of bug a release checklist is supposed to catch and a human is
 * guaranteed to eventually forget, so it is a gate rather than a note.
 *
 * Two things are checked, both by asking the binary rather than trusting the filesystem:
 *   1. both executables exist and actually run
 *   2. neither reports --enable-gpl or --enable-nonfree, which would make shipping it alongside
 *      an MIT application a licensing problem rather than a packaging one
 */

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'apps', 'desktop', 'resources', 'ffmpeg');
const EXES = process.platform === 'win32' ? ['ffmpeg.exe', 'ffprobe.exe'] : ['ffmpeg', 'ffprobe'];

const fail = (msg) => {
  console.error(`\nCannot package: ${msg}\n`);
  console.error('Run `npm run ffmpeg:fetch` to download the LGPL build, then try again.');
  console.error('See apps/desktop/resources/ffmpeg/README.md for what is bundled and why.\n');
  process.exit(1);
};

const missing = EXES.filter((e) => !existsSync(join(DIR, e)));
if (missing.length) fail(`${missing.join(' and ')} missing from apps/desktop/resources/ffmpeg/`);

for (const e of EXES) {
  const p = join(DIR, e);
  const out = spawnSync(p, ['-hide_banner', '-version'], { encoding: 'utf8', timeout: 20_000 });
  const text = `${out.stdout ?? ''}${out.stderr ?? ''}`;
  if (!text.includes('configuration:')) fail(`${e} did not run, or reported no configuration`);
  for (const flag of ['--enable-gpl', '--enable-nonfree']) {
    if (text.includes(flag)) {
      fail(
        `${e} reports ${flag}.\n  Open Cut is MIT — shipping a GPL FFmpeg would force the ` +
          'combined work to GPL.\n  Replace it with the LGPL build.',
      );
    }
  }
}

if (!existsSync(join(DIR, 'LICENSE.txt'))) {
  fail('LICENSE.txt missing from apps/desktop/resources/ffmpeg/ — the LGPL requires it to ship');
}

console.log('FFmpeg: both binaries present, LGPL verified, licence text present.');
