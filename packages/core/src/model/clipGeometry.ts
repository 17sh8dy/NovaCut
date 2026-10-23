/**
 * Where a clip's picture lands in the frame, in sequence pixels, and whether a point is on it.
 *
 * Mirrors `Compositor.buildModelMatrix`, which is the source of truth for what is drawn: the quad is
 * centred on the middle of the frame plus the clip's x/y (y grows DOWN, in pixels), is
 * `rasterWidth x rasterHeight` pixels before scaling, is scaled about its centre by scaleX/scaleY and
 * is rotated by `rotation` degrees counter-clockwise. The preview uses this to decide which text
 * the pointer is over and to draw its outline, so the two have to agree with the compositor.
 */

export interface ClipQuad {
  /** Centre of the quad, in sequence pixels from the top-left. */
  cx: number;
  cy: number;
  /** Half the quad's size along its own axes, after scaling. */
  halfW: number;
  halfH: number;
  /** Counter-clockwise rotation in degrees. */
  rotation: number;
}

export function clipQuad(
  frame: { width: number; height: number },
  transform: { x: number; y: number; scaleX: number; scaleY: number; rotation: number },
  raster: { width: number; height: number },
): ClipQuad {
  return {
    cx: frame.width / 2 + transform.x,
    cy: frame.height / 2 + transform.y,
    halfW: (raster.width * Math.abs(transform.scaleX)) / 2,
    halfH: (raster.height * Math.abs(transform.scaleY)) / 2,
    rotation: transform.rotation,
  };
}

/** Is the point (x, y) — sequence pixels from the top-left — inside the quad? */
export function quadContains(q: ClipQuad, x: number, y: number): boolean {
  const rad = (q.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  // Into the quad's own space: undo the centre, flip y to "up" (the matrix's convention), undo the rotation.
  const dx = x - q.cx;
  const dy = -(y - q.cy);
  const lx = cos * dx + sin * dy;
  const ly = -sin * dx + cos * dy;
  return Math.abs(lx) <= q.halfW && Math.abs(ly) <= q.halfH;
}
