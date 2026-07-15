/**
 * Branded ID types + generator.
 *
 * Branding stops us from accidentally passing a ClipId where a TrackId is expected — the
 * compiler treats them as distinct even though both are strings at runtime.
 */

declare const brand: unique symbol;

/**
 * Nominal-typing helper. Exported so sibling domain packages (e.g. @opencut/photo) brand
 * their own ids off the same symbol instead of re-declaring one, which would make their
 * brands silently incomparable with these.
 */
export type Brand<T, B> = T & { readonly [brand]: B };

export type ProjectId = Brand<string, 'ProjectId'>;
export type SequenceId = Brand<string, 'SequenceId'>;
export type TrackId = Brand<string, 'TrackId'>;
export type ClipId = Brand<string, 'ClipId'>;
export type MediaId = Brand<string, 'MediaId'>;
export type EffectInstanceId = Brand<string, 'EffectInstanceId'>;
export type KeyframeId = Brand<string, 'KeyframeId'>;

let counter = 0;

/**
 * Generate a collision-resistant id with a type prefix. Uses time + counter + random so
 * ids are unique within a session and roughly sortable. `crypto.randomUUID` is avoided so
 * this stays usable in every runtime (node, browser, worker) without polyfills.
 */
export function newId<T extends string>(prefix: string): T {
  counter = (counter + 1) % 0xffff;
  const time = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 0xfffff).toString(36);
  const seq = counter.toString(36);
  return `${prefix}_${time}${seq}${rand}` as T;
}

export const newProjectId = () => newId<ProjectId>('prj');
export const newSequenceId = () => newId<SequenceId>('seq');
export const newTrackId = () => newId<TrackId>('trk');
export const newClipId = () => newId<ClipId>('clp');
export const newMediaId = () => newId<MediaId>('med');
export const newEffectId = () => newId<EffectInstanceId>('efx');
export const newKeyframeId = () => newId<KeyframeId>('key');
