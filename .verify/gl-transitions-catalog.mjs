/**
 * GL Transitions catalog checks that need no GPU: the registry, the flattened parameters, the
 * shader sources and the attribution. The GPU half is `verify:gltransitions`.
 *
 *   npm run verify:gltcatalog
 */

import { readFileSync } from 'node:fs';
import {
  addMedia,
  addTrack,
  addClip,
  addTransition,
  allTransitions,
  allTransitionsIncludingHidden,
  createClipFromMedia,
  deserializeProject,
  getTransitionDef,
  History,
  createProject,
  registerBuiltins,
  serializeProject,
  getActiveSequence,
  GL_TRANSITIONS,
  GL_TRANSITIONS_NOTICE,
  GL_TRANSITION_MAPS,
  GL_TRANSITIONS_UNSUPPORTED,
  GL_TRANSITIONS_VERSION,
  TICKS_PER_SECOND,
} from '@opencut/core';
import { GL_TRANSITION_SOURCES } from '../packages/engine/src/compositor/glTransitions.generated.ts';

const S = TICKS_PER_SECOND;
const results = {};
let failures = 0;
const check = (name, pass, detail) => {
  results[name] = { pass, ...(detail ?? {}) };
  if (!pass) failures++;
};

registerBuiltins();

const NOVA_CLASSIC_LABELS = ['Cross Dissolve', 'Fade Through', 'Wipe', 'Circle Reveal', 'Slide', 'Push', 'Zoom Punch', 'Spin', 'Whip Pan', 'Impact Shake', 'Blur Dissolve', 'Flash', 'Glitch', 'Luma Burn', 'Pixelize', '3D Flip', 'Cube', 'Page Turn'];
const NOVA_CLASSIC = [
  'cross-dissolve', 'fade', 'wipe', 'circle', 'slide', 'push', 'zoom', 'spin', 'whip', 'shake',
  'blur', 'flash', 'glitch', 'burn', 'pixelize', '3d-flip', 'cube', 'page-turn',
];

// ── The roster ────────────────────────────────────────────────────────────────────
const visible = allTransitions();
const all = allTransitionsIncludingHidden();
check('nova_classic_untouched', eq(visible.filter((t) => !t.gl).map((t) => t.type), NOVA_CLASSIC), { got: visible.filter((t) => !t.gl).map((t) => t.type) });
check('library_offers_classic_plus_gl', visible.length === NOVA_CLASSIC.length + GL_TRANSITIONS.length, { visible: visible.length });
check('gl_catalog_size', GL_TRANSITIONS.length === 125, { got: GL_TRANSITIONS.length });
check('total_is_classic_plus_gl', all.length === NOVA_CLASSIC.length + GL_TRANSITIONS.length, { all: all.length, classic: NOVA_CLASSIC.length });
check('gl_offered_in_the_library', GL_TRANSITIONS.every((m) => getTransitionDef(`gl:${m.name}`)?.hidden === false));
check('gl_still_resolves', GL_TRANSITIONS.every((m) => getTransitionDef(`gl:${m.name}`)?.gl?.name === m.name));
check('gl_namespaced_never_collides', GL_TRANSITIONS.every((m) => !NOVA_CLASSIC.includes(`gl:${m.name}`)) && new Set(all.map((t) => t.type)).size === all.length);
check('package_version_recorded', GL_TRANSITIONS_VERSION === '1.76.1', { got: GL_TRANSITIONS_VERSION });
check('every_shader_in_the_package_is_supported', GL_TRANSITIONS_UNSUPPORTED.length === 0, { unsupported: GL_TRANSITIONS_UNSUPPORTED });
{
  const tex = ['luma', 'displacement'].map((n) => getTransitionDef(`gl:${n}`));
  check('texture_shaders_are_registered', tex.every((d) => !!d));
  check('texture_shaders_pick_a_map_by_index',
    tex.every((d) => d.gl.bindings.some((b) => b.type === 'sampler2D' && b.keys.length === 1) && d.params.some((p) => p.key.endsWith('.map') && p.step === 1 && p.min === 0 && p.max === GL_TRANSITION_MAPS.length - 1)),
    { maps: GL_TRANSITION_MAPS });
  check('map_list_is_append_only_in_this_order', eq(GL_TRANSITION_MAPS.slice(0, 4), ['Left to Right', 'Top to Bottom', 'Diagonal', 'Center Out']) && GL_TRANSITION_MAPS.length === 8);
}

// ── Labels ────────────────────────────────────────────────────────────────────────
{
  const labels = GL_TRANSITIONS.map((m) => m.label);
  const dup = labels.filter((l, i) => labels.indexOf(l) !== i);
  check('no_two_transitions_share_a_label', dup.length === 0 && new Set([...labels, ...NOVA_CLASSIC_LABELS]).size === labels.length + NOVA_CLASSIC_LABELS.length, { dup });
  const ugly = GL_TRANSITIONS.filter((m) => /_|\d$|\b[a-z]{2,}[A-Z]/.test(m.label) || m.label !== m.label.trim() || /Colour|Rigth/.test(m.label)).map((m) => `${m.name}: ${m.label}`);
  check('labels_read_as_names_not_file_names', ugly.length === 0, { ugly });
  const lower = GL_TRANSITIONS.filter((m) => /^[a-z]/.test(m.label)).map((m) => m.label);
  check('labels_start_with_a_capital', lower.length === 0, { lower });
  const badParam = [];
  for (const m of GL_TRANSITIONS) for (const b of m.bindings) if (!b.label || /[_]|^[a-z]/.test(b.label) || /Colour/.test(b.label)) badParam.push(`${m.name}.${b.uniform}: ${b.label}`);
  check('parameter_labels_are_clean', badParam.length === 0, { badParam: badParam.slice(0, 10) });
  const comp = (n, u) => getTransitionDef(`gl:${n}`).gl.bindings.find((b) => b.uniform === u)?.componentLabels;
  check('vector_components_are_named_when_the_author_named_them', eq(comp('GridFlip', 'size'), ['Columns', 'Rows']) && eq(comp('colorphase', 'fromStep'), ['R', 'G', 'B', 'A']), { grid: comp('GridFlip', 'size') });
  check('spot_check_curated_names',
    ['gl:fadecolor', 'gl:ZoomRigthWipe', 'gl:HSVfade', 'gl:TVStatic', 'gl:cube', 'gl:dissolve'].map((t) => getTransitionDef(t).label).join('|') ===
      'Fade Through Color|Zoom Right Wipe|HSV Fade|TV Static|Cube Reflection|Glow Dissolve');
}

// ── Sources and attribution ───────────────────────────────────────────────────────
check('every_entry_has_source', GL_TRANSITIONS.every((m) => /vec4\s+transition\s*\(\s*vec2\s+\w+\s*\)/.test(GL_TRANSITION_SOURCES[m.name] ?? '')),
  { missing: GL_TRANSITIONS.filter((m) => !GL_TRANSITION_SOURCES[m.name]).map((m) => m.name) });
check('sources_carry_licence_headers', GL_TRANSITIONS.filter((m) => !/License:/i.test(GL_TRANSITION_SOURCES[m.name])).length === 0,
  { without: GL_TRANSITIONS.filter((m) => !/License:/i.test(GL_TRANSITION_SOURCES[m.name])).map((m) => m.name) });
check('every_entry_names_author_and_licence', GL_TRANSITIONS.every((m) => m.author && m.license));
check('licence_set_is_known', eq([...new Set(GL_TRANSITIONS.map((m) => m.license))].sort(), ['BSD 2 Clause', 'BSD 3 Clause', 'MIT']));
{
  const notice = readFileSync('licenses/gl-transitions.md', 'utf8');
  check('notice_lists_every_shader', GL_TRANSITIONS.every((m) => notice.includes(`| ${m.name} |`)),
    { missing: GL_TRANSITIONS.filter((m) => !notice.includes(`| ${m.name} |`)).map((m) => m.name) });
  check('about_notice_matches_the_notice_file', GL_TRANSITIONS_NOTICE.trim() === notice.trim() && GL_TRANSITIONS_NOTICE.includes('Hewlett-Packard'));
  check('notice_has_package_licence', notice.includes('Copyright (c) 2017-present gl-transitions contributors'));
  check('notice_has_both_bsd_shaders',
    notice.includes('Hewlett-Packard Development Company') && notice.includes('Ted Schundler') && notice.includes('InvertedPageCurl') && notice.includes('StereoViewer'));
  check('hp_notice_is_verbatim',
    GL_TRANSITION_SOURCES.InvertedPageCurl.match(/\/\*([\s\S]*?)\*\//)?.[1].trim().split('\n').every((l) => notice.includes(l.trim())) === true);
}

// ── Parameters ────────────────────────────────────────────────────────────────────
const badRange = [];
const badBinding = [];
const badDefault = [];
for (const m of GL_TRANSITIONS) {
  const keys = m.params.map((p) => p.key);
  if (new Set(keys).size !== keys.length) badBinding.push(`${m.name}: duplicate keys`);
  const bound = m.bindings.flatMap((b) => b.keys);
  if (!eq([...bound].sort(), [...keys].sort())) badBinding.push(`${m.name}: bindings do not cover params`);
  for (const b of m.bindings) {
    const want = { float: 1, int: 1, bool: 1, sampler2D: 1, vec2: 2, vec3: 3, vec4: 4, ivec2: 2, ivec3: 3, ivec4: 4 }[b.type];
    if (b.keys.length !== want || b.defaults.length !== want) badBinding.push(`${m.name}.${b.uniform}: ${b.type} has ${b.keys.length} keys`);
  }
  for (const p of m.params) {
    if (![p.min, p.max, p.default, p.step].every(Number.isFinite) || !(p.step > 0) || p.min > p.max) badRange.push(`${m.name}.${p.key}`);
    if (p.default < p.min || p.default > p.max) badDefault.push(`${m.name}.${p.key}`);
  }
}
check('params_flattened_and_bound', badBinding.length === 0, { bad: badBinding.slice(0, 8) });
check('param_ranges_finite_and_ordered', badRange.length === 0, { bad: badRange.slice(0, 8) });
check('param_defaults_inside_range', badDefault.length === 0, { bad: badDefault.slice(0, 8) });

// Defaults must equal the shader's own `// = value` comments (the author's stated default).
{
  const wrong = [];
  for (const m of GL_TRANSITIONS) {
    const src = GL_TRANSITION_SOURCES[m.name];
    for (const b of m.bindings) {
      if (!['float', 'int', 'bool'].includes(b.type)) continue;
      const re = new RegExp(`uniform\\s+${b.type}\\s+${b.uniform}\\s*;\\s*//\\s*=\\s*([-\\w.]+)`);
      const hit = re.exec(src);
      if (!hit) continue;
      const want = hit[1] === 'true' ? 1 : hit[1] === 'false' ? 0 : Number(hit[1]);
      if (Number.isFinite(want) && Math.abs(want - b.defaults[0]) > 1e-4) wrong.push(`${m.name}.${b.uniform}: ${want} vs ${b.defaults[0]}`);
    }
  }
  check('defaults_match_shader_comments', wrong.length === 0, { wrong: wrong.slice(0, 8) });
}

// ── Seeding, saving and reopening ─────────────────────────────────────────────────
{
  const history = new History(createProject());
  const media = { id: 'm1', name: 'a.mp4', kind: 'video', path: '/tmp/a.mp4', duration: 20 * S, width: 1920, height: 1080, fps: 30, hasAudio: false };
  history.dispatch(addMedia([media]));
  history.dispatch(addTrack('video'));
  const trackId = getActiveSequence(history.current).tracks.find((t) => t.kind === 'video').id;
  history.dispatch(addClip(trackId, { ...createClipFromMedia(media, 0), id: 'A', duration: 5 * S, sourceOut: 5 * S }));
  history.dispatch(addClip(trackId, { ...createClipFromMedia(media, 5 * S), id: 'B', start: 5 * S, duration: 5 * S, sourceOut: 5 * S }));
  const withParams = GL_TRANSITIONS.find((m) => m.name === 'CircleCrop');
  history.dispatch(addTransition(trackId, 'A', 'B', 'gl:CircleCrop', S));
  const tr = () => getActiveSequence(history.current).tracks.find((t) => t.id === trackId).transitions;
  check('gl_transition_added_with_default_params',
    tr().length === 1 && tr()[0].type === 'gl:CircleCrop' && withParams.params.every((p) => tr()[0].params[p.key] === p.default),
    { params: tr()[0]?.params });
  const reopened = deserializeProject(serializeProject(history.current));
  const rt = getActiveSequence(reopened).tracks.find((t) => t.id === trackId).transitions;
  check('gl_transition_survives_save_and_reopen', eq(rt, tr()), { saved: rt });
  history.undo();
  check('gl_transition_undo_removes_it', tr().length === 0);
  history.redo();
  check('gl_transition_redo_restores_it', tr().length === 1 && tr()[0].type === 'gl:CircleCrop');
  // A project that names a transition this build does not know must still load.
  const alien = serializeProject(history.current).replace('gl:CircleCrop', 'gl:FromTheFuture');
  const loaded = deserializeProject(alien);
  check('unknown_transition_type_still_loads',
    getActiveSequence(loaded).tracks.find((t) => t.id === trackId).transitions[0].type === 'gl:FromTheFuture' && getTransitionDef('gl:FromTheFuture') === undefined);
}

function eq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

console.log(JSON.stringify({ ...results, ok: failures === 0, failures, total: Object.keys(results).length }, null, 2));
process.exit(failures === 0 ? 0 : 1);
