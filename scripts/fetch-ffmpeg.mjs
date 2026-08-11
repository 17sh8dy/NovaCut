/**
 * Downloads the LGPL FFmpeg binaries the installer bundles.
 *
 *   npm run ffmpeg:fetch            no-op if they are already present
 *   npm run ffmpeg:fetch -- --force re-download regardless
 *
 * They live in `apps/desktop/resources/ffmpeg/` and are excluded from git — two ~110 MB
 * executables would be in the history permanently. This script is what makes that safe: it is
 * the reproducible way back to a shippable tree from a fresh clone.
 *
 * ── THE CHECK THAT MATTERS ───────────────────────────────────────────────────
 *
 * Open Cut is MIT. FFmpeg ships in two flavours and only one of them may be distributed
 * alongside MIT code: the GPL build contains x264 and x265 and would force the combined work to
 * GPL. So this does not trust the file name — it runs the downloaded binary and refuses it
 * unless its own `configuration:` line is free of `--enable-gpl` and `--enable-nonfree`.
 *
 * A licence guarantee that depends on someone having downloaded the right URL is not a
 * guarantee. This one fails loudly and deletes what it fetched.
 *
 * Zero dependencies: fetch, unzip via PowerShell's Expand-Archive on Windows, `unzip` elsewhere.
 */

import { mkdir, rm, writeFile, readFile, copyFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEST = join(ROOT, 'apps', 'desktop', 'resources', 'ffmpeg');

/** Only Windows is packaged today; the build name is the platform-specific part. */
const BUILD = 'ffmpeg-master-latest-win64-lgpl';
const URL = `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/${BUILD}.zip`;
const EXES = ['ffmpeg.exe', 'ffprobe.exe'];

const force = process.argv.includes('--force');
const say = (...a) => console.log(...a);

/** Reject anything whose own configuration says it is GPL or nonfree. */
function assertRedistributable(exePath) {
  const out = spawnSync(exePath, ['-hide_banner', '-version'], { encoding: 'utf8', timeout: 20_000 });
  const text = `${out.stdout ?? ''}${out.stderr ?? ''}`;
  if (!text.includes('configuration:')) {
    throw new Error(`could not read the configuration out of ${exePath} — refusing to use it`);
  }
  for (const flag of ['--enable-gpl', '--enable-nonfree']) {
    if (text.includes(flag)) {
      throw new Error(
        `this build reports ${flag}. It cannot be bundled with an MIT application — ` +
          'use the LGPL build. Nothing has been installed.',
      );
    }
  }
  return (text.split('\n')[0] ?? '').trim();
}

async function main() {
  const present = EXES.every((e) => existsSync(join(DEST, e)));
  if (present && !force) {
    say('FFmpeg is already present in apps/desktop/resources/ffmpeg/');
    for (const e of EXES) say(`  ${e}  ${assertRedistributable(join(DEST, e)) ? 'verified LGPL' : ''}`);
    say('Pass --force to re-download.');
    return;
  }

  const work = join(tmpdir(), `oc-ffmpeg-${Date.now()}`);
  await mkdir(work, { recursive: true });
  const zip = join(work, 'ffmpeg.zip');

  say(`Downloading ${URL}`);
  const res = await fetch(URL, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  await writeFile(zip, Buffer.from(await res.arrayBuffer()));
  say(`  ${((await stat(zip)).size / 1048576).toFixed(1)} MB`);

  say('Extracting…');
  const unzip =
    process.platform === 'win32'
      ? spawnSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${work}' -Force`], { encoding: 'utf8' })
      : spawnSync('unzip', ['-q', '-o', zip, '-d', work], { encoding: 'utf8' });
  if (unzip.status !== 0) throw new Error(`extract failed: ${unzip.stderr || unzip.stdout}`);

  const bin = join(work, BUILD, 'bin');
  for (const e of EXES) {
    if (!existsSync(join(bin, e))) throw new Error(`${e} not found in the archive`);
  }

  // Verify BEFORE installing, so a GPL build never lands in the tree at all.
  say('Verifying the licence…');
  for (const e of EXES) say(`  ${e}: ${assertRedistributable(join(bin, e))}`);

  await mkdir(DEST, { recursive: true });
  for (const e of EXES) await copyFile(join(bin, e), join(DEST, e));
  const licence = join(work, BUILD, 'LICENSE.txt');
  if (existsSync(licence)) await copyFile(licence, join(DEST, 'LICENSE.txt'));

  await rm(work, { recursive: true, force: true });

  say('');
  say('Installed into apps/desktop/resources/ffmpeg/:');
  for (const e of [...EXES, 'LICENSE.txt']) {
    const p = join(DEST, e);
    if (existsSync(p)) say(`  ${e.padEnd(14)} ${((await stat(p)).size / 1048576).toFixed(1)} MB`);
  }
  say('');
  say('Update the version and hashes in that folder\'s README, and re-check the codec matrix:');
  say('  an upstream build can drop an encoder, and the export dialog offers six of them.');
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
