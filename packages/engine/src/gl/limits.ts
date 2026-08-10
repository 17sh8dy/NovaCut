/**
 * GPU upload limits, as a process-wide policy.
 *
 * A module-level value rather than a parameter threaded through every render call, because that
 * is genuinely what it is: one number describing what this machine's GPU should be asked to hold,
 * consulted at the single point where pixels cross into GL. Passing it down through the
 * compositor, the photo renderer, the effect chain and the frame pool would touch a dozen
 * signatures to deliver a constant.
 *
 * `0` means "no policy" — the hardware limit still applies, and always wins: asking for a texture
 * larger than MAX_TEXTURE_SIZE does not fail loudly, it silently produces a black texture, which
 * is exactly the kind of bug that gets blamed on the effect chain for a week.
 */

let configuredMax = 0;

/** Set the preferred cap (px, longest edge). 0 disables the policy. */
export function setMaxTextureSize(px: number): void {
  configuredMax = Number.isFinite(px) && px > 0 ? Math.floor(px) : 0;
}

export function getMaxTextureSize(): number {
  return configuredMax;
}

/**
 * The size a source should be uploaded at, or null when it can go up untouched.
 *
 * Takes the hardware limit as well as the preference so the caller never has to remember that
 * the two interact — the effective cap is the smaller of the two, and the aspect ratio is
 * preserved so nothing is ever distorted by this.
 */
export function uploadSize(
  srcWidth: number,
  srcHeight: number,
  hardwareMax: number,
): { width: number; height: number } | null {
  const limits = [hardwareMax, configuredMax].filter((n) => n > 0);
  if (limits.length === 0) return null;
  const cap = Math.min(...limits);
  const longest = Math.max(srcWidth, srcHeight);
  if (longest <= cap) return null;
  const scale = cap / longest;
  return {
    width: Math.max(1, Math.round(srcWidth * scale)),
    height: Math.max(1, Math.round(srcHeight * scale)),
  };
}
