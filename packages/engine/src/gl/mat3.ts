/**
 * 3x3 affine matrices, column-major to match `uniformMatrix3fv(loc, false, m)`.
 *
 * Column-major is the only real trap here: `m[3]` is row 0 of column 1, NOT row 1 of column 0.
 * Reading these as row-major transposes the matrix, which for an affine transform means
 * rotation still "works" while translation quietly moves along the wrong axis. Everything
 * below is written in terms of `mul`/`translate`/`rotate` for that reason — nothing outside
 * this file should index into the array.
 *
 * `mul(a, b)` applies b first, then a — standard matrix convention, so a composition reads
 * right-to-left in the order the operations physically happen.
 */

export type Mat3 = Float32Array;

export const identity = (): Mat3 => new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

/** a ∘ b — b's transform applied first. */
export function mul(a: Mat3, b: Mat3): Mat3 {
  const out = new Float32Array(9);
  for (let col = 0; col < 3; col++) {
    for (let row = 0; row < 3; row++) {
      out[col * 3 + row] =
        a[0 * 3 + row]! * b[col * 3 + 0]! +
        a[1 * 3 + row]! * b[col * 3 + 1]! +
        a[2 * 3 + row]! * b[col * 3 + 2]!;
    }
  }
  return out;
}

export const translate = (x: number, y: number): Mat3 =>
  new Float32Array([1, 0, 0, 0, 1, 0, x, y, 1]);

export const scale = (x: number, y: number): Mat3 =>
  new Float32Array([x, 0, 0, 0, y, 0, 0, 0, 1]);

/** Counter-clockwise in clip space, where +y is up. */
export function rotate(radians: number): Mat3 {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return new Float32Array([c, s, 0, -s, c, 0, 0, 0, 1]);
}

/** Compose left-to-right in application order: `compose(a, b)` applies a, then b. */
export const compose = (...ms: Mat3[]): Mat3 => ms.reduceRight((acc, m) => mul(acc, m), identity());
