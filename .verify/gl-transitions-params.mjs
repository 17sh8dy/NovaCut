/**
 * GL Transitions, Phase B: parameters, the controls derived from them, and everything that must
 * keep working around them (undo/redo, deletion, saving and reopening, switching type).
 *
 * Drives the real app store and the real commands in node. The picture a parameter produces is
 * covered by the GPU harness (verify:gltransitions); the Inspector's DOM by verify:gltui.
 *
 *   npm run verify:gltparams
 */

import {
  addClip,
  addMedia,
  addTrack,
  addTransition,
  allTransitions,
  allTransitionsIncludingHidden,
  createClipFromMedia,
  deleteClips,
  deserializeProject,
  getTransitionDef,
  GL_TRANSITIONS,
  registerBuiltins,
  removeTransition,
  resetTransitionParams,
  rippleDeleteClips,
  serializeProject,
  setTransitionParams,
  setTransitionType,
  TICKS_PER_SECOND,
} from '@opencut/core';
import { createAppStore } from '@opencut/ui';
import { controlKeys, describeTransitionControls, hexToRgb, rgbToHex } from '../packages/ui/src/panels/transitionControls.ts';

const S = TICKS_PER_SECOND;
const results = {};
let failures = 0;
const check = (name, pass, detail) => {
  results[name] = { pass, ...(detail ?? {}) };
  if (!pass) failures++;
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

registerBuiltins();
const stubBridge = new Proxy({}, { get: () => async () => undefined });
const media = { id: 'm1', name: 'a.mp4', kind: 'video', path: '/tmp/a.mp4', duration: 60 * S, width: 1920, height: 1080, fps: 30, hasAudio: false };

/** Two butt-joined clips with one transition between them. */
function fixture(type) {
  const store = createAppStore(stubBridge);
  const s = store.getState();
  s.dispatch(addMedia([media]));
  s.dispatch(addTrack('video'));
  const trackId = store.getState().sequence().tracks.find((t) => t.kind === 'video').id;
  for (const [id, start] of [['A', 0], ['B', 5], ['C', 10]]) {
    s.dispatch(addClip(trackId, { ...createClipFromMedia(media, start * S), id, start: start * S, duration: 5 * S, sourceOut: 5 * S }));
  }
  s.dispatch(addTransition(trackId, 'A', 'B', type, S));
  const tr = () => store.getState().sequence().tracks.find((t) => t.id === trackId).transitions;
  return { store, trackId, tr, id: tr()[0].id };
}
const snap = (store) => JSON.stringify(store.getState().project);

// ═══ 1. Controls derived from the definitions ═══════════════════════════════
const all = GL_TRANSITIONS.map((m) => getTransitionDef(`gl:${m.name}`));
{
  const bad = [];
  const counts = { slider: 0, integer: 0, toggle: 0, vector: 0, color: 0 };
  for (const def of all) {
    const controls = describeTransitionControls(def);
    const keys = controlKeys(controls);
    const want = def.params.map((p) => p.key);
    if (!eq([...keys].sort(), [...want].sort())) bad.push(`${def.gl.name}: ${keys.length} vs ${want.length}`);
    for (const c of controls) counts[c.kind]++;
  }
  check('every_param_has_exactly_one_control', bad.length === 0, { bad: bad.slice(0, 8) });
  check('control_kinds_cover_the_catalog', counts.slider > 0 && counts.integer > 0 && counts.toggle > 0 && counts.vector > 0 && counts.color > 0, counts);
}
{
  const kind = (name, uniform) => describeTransitionControls(getTransitionDef(`gl:${name}`)).find((c) => c.uniform === uniform);
  check('texture_map_is_a_dropdown', kind('luma', 'luma')?.kind === 'map' && kind('displacement', 'displacementMap')?.kind === 'map');
  check('bool_is_a_toggle', kind('Rolls', 'RotDown')?.kind === 'toggle');
  check('int_is_a_whole_number_control', kind('Box', 'location')?.kind === 'integer');
  check('vec2_is_a_two_component_vector', kind('Directional', 'direction')?.kind === 'vector' && kind('Directional', 'direction').params.length === 2);
  check('ivec2_is_an_integer_vector', kind('GridFlip', 'size')?.kind === 'vector' && kind('GridFlip', 'size').integer === true);
  check('vec4_colour_has_opacity', kind('CircleCrop', 'bgcolor')?.kind === 'color' && kind('CircleCrop', 'bgcolor').alpha === true);
  check('vec3_colour_has_no_opacity', kind('burn', 'color')?.kind === 'color' && kind('burn', 'color').alpha === false);
  check('plain_vec4_is_not_a_colour', kind('colorphase', 'fromStep')?.kind === 'vector');
  check('colour_count_matches_catalog', describeTransitionControls === describeTransitionControls &&
    all.reduce((n, d) => n + describeTransitionControls(d).filter((c) => c.kind === 'color').length, 0) ===
    all.reduce((n, d) => n + d.gl.bindings.filter((b) => b.color).length, 0));
  check('classic_transitions_keep_plain_sliders',
    allTransitions().filter((t) => !t.gl).every((t) => describeTransitionControls(t).every((c) => c.kind === 'slider') && controlKeys(describeTransitionControls(t)).length === t.params.length));
  check('unknown_type_has_no_controls', describeTransitionControls(undefined).length === 0);
  check('control_kinds_include_maps', describeTransitionControls(getTransitionDef('gl:luma')).some((c) => c.kind === 'map'));
  check('hex_round_trip', eq(rgbToHex(...hexToRgb('#12ab9f')), '#12ab9f') && eq(hexToRgb('nonsense'), [0, 0, 0]));
}

// ═══ 2. Seeding: every GL transition starts on its own defaults ═════════════
{
  const bad = [];
  for (const def of all) {
    const f = fixture(def.type);
    const p = f.tr()[0].params;
    if (!def.params.every((x) => p[x.key] === x.default) || Object.keys(p).length !== def.params.length) bad.push(def.gl.name);
  }
  check('every_gl_transition_seeds_its_defaults', bad.length === 0, { bad: bad.slice(0, 8), checked: all.length });
}

// ═══ 3. Editing parameters ═════════════════════════════════════════════════
{
  const f = fixture('gl:CircleCrop'); // vec4 colour bgcolor.{r,g,b,a}
  const before = snap(f.store);
  f.store.getState().dispatch(setTransitionParams(f.trackId, f.id, { 'bgcolor.r': 1, 'bgcolor.g': 0.5, 'bgcolor.b': 0.25 }, 'k'));
  const p = f.tr()[0].params;
  check('patch_sets_several_keys_at_once', p['bgcolor.r'] === 1 && p['bgcolor.g'] === 0.5 && p['bgcolor.b'] === 0.25 && p['bgcolor.a'] === 1, { p });
  f.store.getState().undo();
  check('one_undo_reverts_a_whole_colour_change', snap(f.store) === before);
  f.store.getState().redo();
  check('redo_reapplies_it', f.tr()[0].params['bgcolor.g'] === 0.5);
  f.store.getState().undo();

  const prev = f.store.getState().project;
  f.store.getState().dispatch(setTransitionParams(f.trackId, f.id, { 'bgcolor.r': 0 })); // already 0
  check('setting_the_same_value_is_a_noop', f.store.getState().project === prev);
  f.store.getState().dispatch(setTransitionParams(f.trackId, f.id, { nonsense: 5, 'bgcolor.r': Number.NaN, 'bgcolor.g': Infinity }));
  check('unknown_keys_and_non_finite_values_are_ignored', f.store.getState().project === prev || (f.tr()[0].params.nonsense === undefined && Number.isFinite(f.tr()[0].params['bgcolor.g'])));
  f.store.getState().dispatch(setTransitionParams(f.trackId, f.id, { 'bgcolor.r': 99, 'bgcolor.g': -4 }));
  check('values_are_clamped_to_the_declared_range', f.tr()[0].params['bgcolor.r'] === 1 && f.tr()[0].params['bgcolor.g'] === 0, { p: f.tr()[0].params });
}
{
  // integer / bool uniforms are rounded; a grid size can never be 0
  const f = fixture('gl:GridFlip');
  f.store.getState().dispatch(setTransitionParams(f.trackId, f.id, { 'size.x': 6.6, 'size.y': -3 }));
  const p = f.tr()[0].params;
  check('integer_uniforms_are_rounded_and_never_below_their_minimum', p['size.x'] === 7 && p['size.y'] >= 1 && Number.isInteger(p['size.y']), { p });
  const r = fixture('gl:Rolls');
  r.store.getState().dispatch(setTransitionParams(r.trackId, r.id, { RotDown: 0.7 }));
  check('bool_uniforms_are_rounded_to_0_or_1', r.tr()[0].params.RotDown === 1, { v: r.tr()[0].params.RotDown });
}
{
  // a slider drag is dozens of dispatches: one undo step
  const f = fixture('gl:cube');
  const before = snap(f.store);
  for (let i = 1; i <= 30; i++) f.store.getState().dispatch(setTransitionParams(f.trackId, f.id, { persp: i / 100 }, 'trn-params:drag:persp'));
  check('slider_drag_reached_the_end_value', Math.abs(f.tr()[0].params.persp - 0.3) < 1e-9);
  f.store.getState().undo();
  check('slider_drag_is_one_undo_step', snap(f.store) === before);
  // two different parameters are two steps
  f.store.getState().dispatch(setTransitionParams(f.trackId, f.id, { persp: 0.5 }, 'trn-params:x:persp'));
  f.store.getState().dispatch(setTransitionParams(f.trackId, f.id, { unzoom: 0.9 }, 'trn-params:x:unzoom'));
  f.store.getState().undo();
  check('different_params_are_separate_steps', f.tr()[0].params.persp === 0.5 && f.tr()[0].params.unzoom === 0.3, { p: f.tr()[0].params });
}
{
  const f = fixture('gl:cube');
  const seeded = JSON.stringify(f.tr()[0].params);
  f.store.getState().dispatch(setTransitionParams(f.trackId, f.id, { persp: 0.9, unzoom: 0.8, floating: 7 }));
  f.store.getState().dispatch(resetTransitionParams(f.trackId, f.id));
  check('reset_restores_every_default', JSON.stringify(f.tr()[0].params) === seeded, { p: f.tr()[0].params });
  const prev = f.store.getState().project;
  f.store.getState().dispatch(resetTransitionParams(f.trackId, f.id));
  check('reset_when_already_default_is_a_noop', f.store.getState().project === prev);
  f.store.getState().undo();
  check('undo_reset_brings_the_edits_back', f.tr()[0].params.persp === 0.9);
}
{
  // two transitions of the same type keep their own values
  const f = fixture('gl:cube');
  f.store.getState().dispatch(addTransition(f.trackId, 'B', 'C', 'gl:cube', S));
  const second = f.tr().find((t) => t.id !== f.id).id;
  f.store.getState().dispatch(setTransitionParams(f.trackId, second, { persp: 0.11 }));
  const a = f.tr().find((t) => t.id === f.id).params.persp;
  const b = f.tr().find((t) => t.id === second).params.persp;
  check('two_instances_are_independent', a === 0.7 && b === 0.11, { a, b });
}

// ═══ 3b. Texture shaders: the map is an index ═══════════════════════════════
{
  const f = fixture('gl:luma');
  const dflt = f.tr()[0].params['luma.map'];
  check('map_defaults_to_center_out', dflt === 3, { dflt });
  f.store.getState().dispatch(setTransitionParams(f.trackId, f.id, { 'luma.map': 5.4 }));
  check('map_index_is_rounded', f.tr()[0].params['luma.map'] === 5);
  f.store.getState().dispatch(setTransitionParams(f.trackId, f.id, { 'luma.map': 99 }));
  check('map_index_is_clamped_to_the_list', f.tr()[0].params['luma.map'] === 7);
  f.store.getState().dispatch(setTransitionParams(f.trackId, f.id, { 'luma.map': -3 }));
  check('map_index_never_goes_below_zero', f.tr()[0].params['luma.map'] === 0);
  const reopened = deserializeProject(serializeProject(f.store.getState().project));
  check('chosen_map_survives_save_and_reopen', reopened.sequences[0].tracks.find((x) => x.id === f.trackId).transitions[0].params['luma.map'] === 0);
}

// ═══ 4. Type changes ═══════════════════════════════════════════════════════
{
  const f = fixture('gl:cube');
  f.store.getState().dispatch(setTransitionParams(f.trackId, f.id, { persp: 0.9 }));
  f.store.getState().dispatch(setTransitionType(f.trackId, f.id, 'wipe'));
  const w = getTransitionDef('wipe');
  check('gl_to_classic_reseeds_params', eq(Object.keys(f.tr()[0].params).sort(), w.params.map((p) => p.key).sort()) && f.tr()[0].params.angle === w.params.find((p) => p.key === 'angle').default, { p: f.tr()[0].params });
  f.store.getState().dispatch(setTransitionType(f.trackId, f.id, 'gl:CircleCrop'));
  check('classic_to_gl_seeds_gl_defaults', getTransitionDef('gl:CircleCrop').params.every((p) => f.tr()[0].params[p.key] === p.default));
  f.store.getState().dispatch(setTransitionType(f.trackId, f.id, 'gl:NotAThing'));
  check('switching_to_an_unknown_type_is_refused', f.tr()[0].type === 'gl:CircleCrop');
  f.store.getState().undo();
  f.store.getState().undo();
  check('type_changes_undo', f.tr()[0].type === 'gl:cube' && f.tr()[0].params.persp === 0.9, { type: f.tr()[0].type });
}

// ═══ 5. Deletion ═══════════════════════════════════════════════════════════
{
  const f = fixture('gl:CircleCrop');
  f.store.getState().dispatch(setTransitionParams(f.trackId, f.id, { 'bgcolor.r': 0.9, 'bgcolor.b': 0.2 }));
  const edited = JSON.stringify(f.tr()[0]);
  f.store.getState().dispatch(removeTransition(f.trackId, f.id));
  check('remove_transition_removes_it', f.tr().length === 0);
  f.store.getState().undo();
  check('undo_remove_restores_the_edited_params_exactly', JSON.stringify(f.tr()[0]) === edited);
  f.store.getState().dispatch(deleteClips(['B']));
  check('deleting_a_joined_clip_removes_its_transition', f.tr().length === 0);
  f.store.getState().undo();
  check('undo_delete_clip_restores_transition_with_edits', JSON.stringify(f.tr()[0]) === edited);
  f.store.getState().dispatch(rippleDeleteClips(['A']));
  check('ripple_deleting_a_joined_clip_removes_its_transition', f.tr().length === 0);
}

// ═══ 6. Saving and reopening ═══════════════════════════════════════════════
{
  const f = fixture('gl:CircleCrop');
  f.store.getState().dispatch(setTransitionParams(f.trackId, f.id, { 'bgcolor.r': 0.1, 'bgcolor.g': 0.2, 'bgcolor.b': 0.3, 'bgcolor.a': 0.5 }));
  const reopened = deserializeProject(serializeProject(f.store.getState().project));
  const t = reopened.sequences[0].tracks.find((x) => x.id === f.trackId).transitions[0];
  check('edited_params_survive_save_and_reopen', eq(t, f.tr()[0]) && t.params['bgcolor.a'] === 0.5, { t });
  const text = serializeProject(f.store.getState().project);
  check('saved_file_stays_flat_numbers', Object.values(JSON.parse(text).project.sequences[0].tracks.find((x) => x.id === f.trackId).transitions[0].params).every((v) => typeof v === 'number'));
}

// ═══ 7. The library ═══════════════════════════════════════════════════════
{
  check('library_offers_every_transition', allTransitions().length === 18 + GL_TRANSITIONS.length && allTransitionsIncludingHidden().length === 18 + GL_TRANSITIONS.length, { n: allTransitions().length });
  check('classics_still_listed_first_class', allTransitions().filter((t) => !t.gl).length === 18);
  const f = fixture('gl:cube');
  check('gl_type_resolves_for_existing_projects', getTransitionDef(f.tr()[0].type)?.gl?.name === 'cube');
  const featured = allTransitions().filter((t) => t.featured);
  check('featured_shelf_is_populated', featured.length >= 30 && featured.every((t) => t.gl), { n: featured.length });
}

console.log(JSON.stringify({ ...results, ok: failures === 0, failures, total: Object.keys(results).length }, null, 2));
process.exit(failures === 0 ? 0 : 1);
