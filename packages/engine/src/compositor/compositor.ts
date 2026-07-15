/**
 * Compositor — the WebGL2 renderer.
 *
 * Given a Sequence and a playhead time, it draws the composited frame to a canvas:
 * for each visible video track (bottom-up), it finds the active clip, uploads its current
 * frame to a texture, runs the clip's enabled effects through a ping-pong FBO chain, then
 * composites the result with its transform (position/scale/rotation) and opacity.
 *
 * The SAME code path renders preview and export — export just points it at an offscreen
 * canvas and reads pixels per frame. That guarantees "what you see is what you render."
 */

import {
  getEffectDef,
  sample,
  toSeconds,
  videoTracksTopDown,
  type Clip,
  type EffectInstance,
  type MediaAsset,
  type Sequence,
  type Ticks,
} from '@opencut/core';
import type { FrameBitmap, FrameSourcePool } from '../media/frameSource.js';
import { COLOR_ADJUST_KEYS, COMPOSITE_FRAGMENT, EFFECT_FRAGMENTS, VERTEX_SHADER } from './shaders.js';
import { dlog, dthrottle } from '../debug.js';

interface Program {
  program: WebGLProgram;
  uniforms: Map<string, WebGLUniformLocation | null>;
}

interface Fbo {
  fbo: WebGLFramebuffer;
  tex: WebGLTexture;
}

export interface RenderContext {
  sequence: Sequence;
  time: Ticks;
  getMedia: (id: string) => MediaAsset | undefined;
  /** True during live playback: video sources play instead of seeking per frame. Omit
   * (or false) for scrubbing/export, where each frame is seeked exactly. */
  playing?: boolean;
  /** Global preview speed from the transport (e.g. 2 for ×2). The playhead already advances
   * at this rate, so the decoded element must run at clipSpeed × this to keep pace. Default 1. */
  speed?: number;
}

/**
 * One layer of a still composite. Pixels are passed in decoded rather than looked up by id:
 * the photo document stores no bitmaps (History snapshots it), so the caller resolves media
 * and hands the engine the frame it should draw.
 */
export interface StillLayer {
  frame: FrameBitmap;
  /** Natural pixel size of `frame`, used to fit it into the canvas without stretching. */
  width: number;
  height: number;
  /** Applied bottom-up, same as a clip's chain. Disabled entries are skipped. */
  effects: readonly EffectInstance[];
  /** 0..1 */
  opacity: number;
}

export interface StillRenderContext {
  width: number;
  height: number;
  /** Background behind all layers, as hex. */
  background: string;
  /** Bottom-to-top; the last layer paints on top. Hidden layers are filtered out by the caller. */
  layers: readonly StillLayer[];
}

export class Compositor {
  private gl: WebGL2RenderingContext;
  private quad: WebGLVertexArrayObject;
  private programs = new Map<string, Program>();
  private textures = new Map<string, WebGLTexture>();
  /**
   * Where every decoded frame is uploaded. Deliberately NOT an FBO attachment: texImage2D's
   * DOM-source overload re-specifies the texture at the frame's natural size, so uploading
   * into ping.tex would silently resize ping.fbo's attachment away from the render size —
   * and any second effect pass would then draw into a mis-sized target under the old
   * viewport, writing one corner and leaving stale pixels around it.
   */
  private source!: WebGLTexture;
  private ping!: Fbo;
  private pong!: Fbo;
  private width = 0;
  private height = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private pool: FrameSourcePool,
  ) {
    const gl = canvas.getContext('webgl2', {
      premultipliedAlpha: false,
      preserveDrawingBuffer: true, // needed so export can readPixels
      alpha: true,
    });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    dlog('gl', 'Compositor created — WebGL2 acquired', {
      canvasW: canvas.width,
      canvasH: canvas.height,
      clientW: canvas.clientWidth,
      clientH: canvas.clientHeight,
      renderer: gl.getParameter(gl.RENDERER),
      maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    });
    this.quad = this.createQuad();
    this.source = gl.createTexture()!;
    this.resize(canvas.width || 1920, canvas.height || 1080);
  }

  /** Resize the render targets to the sequence resolution. */
  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    dlog('gl', 'resize render targets', {
      from: `${this.width}x${this.height}`,
      to: `${width}x${height}`,
      canvasClient: `${this.canvas.clientWidth}x${this.canvas.clientHeight}`,
    });
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    if (this.ping) this.deleteFbo(this.ping);
    if (this.pong) this.deleteFbo(this.pong);
    this.ping = this.createFbo(width, height);
    this.pong = this.createFbo(width, height);
  }

  /** Render one composited frame to the canvas. */
  render(ctx: RenderContext): void {
    const { gl } = this;
    const { sequence } = ctx;
    if (sequence.width !== this.width || sequence.height !== this.height) {
      this.resize(sequence.width, sequence.height);
    }

    // Clear to the sequence background, then composite tracks top-over-bottom.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    const [br, bg, bb] = hexToRgb(sequence.background);
    gl.clearColor(br, bg, bb, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // videoTracksTopDown returns top-first; reverse so we paint bottom → top.
    const tracks = videoTracksTopDown(sequence).reverse();
    let active = 0;
    for (const track of tracks) {
      if (track.hidden) continue;
      const clip = track.clips.find(
        (c) => c.enabled && ctx.time >= c.start && ctx.time < c.start + c.duration,
      );
      if (!clip) continue;
      active++;
      this.renderClip(ctx, clip);
    }
    dthrottle('render', 400, 'render', () => [
      'render()',
      {
        time: ctx.time,
        canvas: `${this.canvas.width}x${this.canvas.height}`,
        canvasClient: `${this.canvas.clientWidth}x${this.canvas.clientHeight}`,
        videoTracks: tracks.length,
        activeClips: active,
        bg: sequence.background,
      },
    ]);
  }

  /**
   * Render a still-image layer stack to the canvas — the photo editor's entry point.
   *
   * An additive sibling of render(), not a replacement: it skips the track walk, the clip
   * time-window search and the source seek (a still has no time to seek to), but runs the
   * exact same upload → effect chain → composite path, so filters behave identically in
   * both products. Effects are sampled at t=0, where AnimatedValue params with no keyframes
   * read straight through to their static value.
   */
  renderStill(ctx: StillRenderContext): void {
    const { gl } = this;
    if (ctx.width !== this.width || ctx.height !== this.height) {
      this.resize(ctx.width, ctx.height);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    const [br, bg, bb] = hexToRgb(ctx.background);
    gl.clearColor(br, bg, bb, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // Layers arrive bottom-up, so painting in order lands later layers on top.
    let drawn = 0;
    for (const layer of ctx.layers) {
      this.uploadFrame(this.source, layer.frame);
      const processed = this.runEffectChain(layer.effects, 0, 0 as Ticks);
      this.compositeStill(processed, layer);
      drawn++;
    }
    dthrottle('renderStill', 400, 'render', () => [
      'renderStill()',
      { canvas: `${this.width}x${this.height}`, layers: ctx.layers.length, drawn },
    ]);
  }

  /** Composite one still layer: aspect-fit into the canvas, apply opacity. */
  private compositeStill(tex: WebGLTexture, layer: StillLayer): void {
    const { gl } = this;
    const prog = this.getProgram('__composite', COMPOSITE_FRAGMENT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.enable(gl.BLEND);
    gl.useProgram(prog.program);
    this.setUniform1f(prog, 'u_opacity', layer.opacity);

    // Fit without stretching. The common case — the canvas sized to the image on import —
    // makes this exactly identity, so the base layer renders 1:1 with no resampling.
    let fitX = 1;
    let fitY = 1;
    if (layer.width && layer.height) {
      const canvasAspect = this.width / this.height;
      const mediaAspect = layer.width / layer.height;
      if (mediaAspect > canvasAspect) fitY = canvasAspect / mediaAspect;
      else fitX = mediaAspect / canvasAspect;
    }
    const loc = prog.uniforms.get('u_model');
    // Column-major 3x3: scale only, centered.
    if (loc) gl.uniformMatrix3fv(loc, false, new Float32Array([fitX, 0, 0, 0, fitY, 0, 0, 0, 1]));

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(prog.uniforms.get('u_texture')!, 0);
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Render a single clip: raw frame → effect chain → composite onto the canvas. */
  private renderClip(ctx: RenderContext, clip: Clip): void {
    const media = clip.mediaId ? ctx.getMedia(clip.mediaId) : undefined;

    // 1. Get the source frame and upload it to the dedicated source texture.
    let uploaded = false;
    if (media && media.kind !== 'audio') {
      const source = this.pool.get(media);
      // Map timeline time → source time honoring trim + speed.
      const localTicks = ctx.time - clip.start;
      const speedRate = clip.speed.reverse ? -clip.speed.rate : clip.speed.rate;
      const sourceTicks = clip.sourceIn + localTicks * speedRate;
      // Run the element at clipSpeed × previewSpeed. sourceTicks (above) is already correct
      // because ctx.time — the playhead — advances at the preview speed; it's only the
      // element's own playbackRate that must be scaled up, or it lags the playhead and the
      // drift-correction seek fires every frame (the black flash on sped-up preview).
      // Reverse/zero rates fall back to per-frame seeking inside sync().
      source.sync(sourceTicks, !!ctx.playing, speedRate * (ctx.speed ?? 1));
      const frame = source.getFrame();
      if (frame) {
        this.uploadFrame(this.source, frame);
        uploaded = true;
      }
      dthrottle(`clip:${clip.id}`, 400, 'render', () => [
        'renderClip',
        { clip: clip.id, mediaId: clip.mediaId, hasMedia: !!media, gotFrame: !!frame, uploaded },
      ]);
    } else {
      dthrottle(`clip:${clip.id}`, 1000, 'render', () => [
        'renderClip skipped (no visual media)',
        { clip: clip.id, kind: clip.kind, mediaId: clip.mediaId },
      ]);
    }
    if (!uploaded) return; // text/shape clips are drawn by the DOM overlay layer for now

    // 2. Run enabled effects as a ping-pong chain, starting from the source texture.
    const localSeconds = toSeconds(ctx.time - clip.start);
    const processed = this.runEffectChain(clip.effects, localSeconds, ctx.time - clip.start);

    // 3. Composite the processed texture to the canvas with the clip transform + opacity.
    this.composite(ctx.sequence, clip, processed, ctx.time - clip.start, media);
  }

  /**
   * Run the enabled effects as a ping-pong chain over `this.source`, returning the texture
   * holding the result (the source itself when nothing is enabled).
   *
   * The chain reads from a texture and writes to an FBO, never both ends of the same FBO,
   * and the uploaded frame lives in its own texture rather than borrowing ping's attachment —
   * that separation is what keeps ping/pong pinned at the render size. Sharing this between
   * the video and still paths is what makes every filter land in both products at once.
   */
  private runEffectChain(
    effects: readonly EffectInstance[],
    timeSeconds: number,
    localTicks: Ticks,
  ): WebGLTexture {
    let inputTex = this.source;
    let target = this.ping;
    let spare = this.pong;
    for (const fx of effects) {
      if (!fx.enabled) continue;
      const def = getEffectDef(fx.type);
      if (!def) continue;
      this.applyEffect(def.render, fx, inputTex, target, timeSeconds, localTicks);
      inputTex = target.tex;
      [target, spare] = [spare, target];
    }
    return inputTex;
  }

  private applyEffect(
    renderKey: string,
    fx: { params: Record<string, { static: number; keyframes: unknown[] }> },
    inputTex: WebGLTexture,
    output: Fbo,
    timeSeconds: number,
    localTicks: Ticks,
  ): void {
    const { gl } = this;
    const source = EFFECT_FRAGMENTS[renderKey] ?? EFFECT_FRAGMENTS['passthrough']!;
    const prog = this.getProgram(renderKey, source);

    gl.bindFramebuffer(gl.FRAMEBUFFER, output.fbo);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.BLEND);
    gl.useProgram(prog.program);
    this.setCommonUniforms(prog, timeSeconds, 1);
    this.setIdentityModel(prog);

    // Bind every param as u_<key>. Zero-fill the color-adjust family so its shared shader
    // ignores channels this particular effect doesn't expose.
    const seen = new Set<string>();
    for (const [key, val] of Object.entries(fx.params)) {
      this.setUniform1f(prog, `u_${key}`, sample(val as never, localTicks));
      seen.add(key);
    }
    if (renderKey === 'colorAdjust') {
      for (const key of COLOR_ADJUST_KEYS) {
        if (!seen.has(key)) this.setUniform1f(prog, `u_${key}`, 0);
      }
    }

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(prog.uniforms.get('u_texture')!, 0);
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private composite(
    sequence: Sequence,
    clip: Clip,
    tex: WebGLTexture,
    localTicks: Ticks,
    media?: MediaAsset,
  ): void {
    const { gl } = this;
    const prog = this.getProgram('__composite', COMPOSITE_FRAGMENT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.enable(gl.BLEND);
    gl.useProgram(prog.program);

    const opacity = sample(clip.transform.opacity, localTicks);
    this.setUniform1f(prog, 'u_opacity', opacity);

    // Build the model matrix: fit media into frame, then apply user transform.
    const model = this.buildModelMatrix(sequence, clip, localTicks, media);
    const loc = prog.uniforms.get('u_model');
    if (loc) gl.uniformMatrix3fv(loc, false, model);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(prog.uniforms.get('u_texture')!, 0);
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    dthrottle('composite', 400, 'gl', () => [
      'composite draw → canvas',
      { clip: clip.id, opacity, viewport: `${this.width}x${this.height}`, glError: gl.getError() || 'none' },
    ]);
  }

  /** Column-major 3x3 model matrix in clip space (-1..1). */
  private buildModelMatrix(sequence: Sequence, clip: Clip, localTicks: Ticks, media?: MediaAsset): Float32Array {
    const t = clip.transform;
    const sx = sample(t.scaleX, localTicks);
    const sy = sample(t.scaleY, localTicks);
    const rot = (sample(t.rotation, localTicks) * Math.PI) / 180;
    const tx = sample(t.x, localTicks);
    const ty = sample(t.y, localTicks);

    // Aspect-fit the media inside the frame so it isn't stretched (default "fit").
    let fitX = 1;
    let fitY = 1;
    if (media && media.width && media.height) {
      const seqAspect = sequence.width / sequence.height;
      const mediaAspect = media.width / media.height;
      if (mediaAspect > seqAspect) fitY = seqAspect / mediaAspect;
      else fitX = mediaAspect / seqAspect;
    }

    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const scaleX = sx * fitX;
    const scaleY = sy * fitY;
    // Translate in clip space: sequence px → clip units (2 / dimension).
    const ndcX = (tx / sequence.width) * 2;
    const ndcY = -(ty / sequence.height) * 2;

    // M = T * R * S, column-major.
    return new Float32Array([
      cos * scaleX, sin * scaleX, 0,
      -sin * scaleY, cos * scaleY, 0,
      ndcX, ndcY, 1,
    ]);
  }

  /** Read the current canvas pixels — the export path uses this per frame. */
  readPixels(): Uint8Array {
    const { gl } = this;
    const pixels = new Uint8Array(this.width * this.height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return pixels;
  }

  // ── WebGL plumbing ──────────────────────────────────────────────────────────

  private createQuad(): WebGLVertexArrayObject {
    const { gl } = this;
    // pos(x,y), uv(u,v) as a triangle strip.
    //
    // v runs bottom-up (v=0 at pos.y=-1), matching GL's native orientation for BOTH texture
    // kinds this quad samples: uploaded frames (flipped once at upload, see uploadFrame) and
    // FBO colour attachments (texel row 0 == framebuffer row 0 == the bottom). That shared
    // convention is what makes the effect chain orientation-neutral.
    //
    // It must stay in sync with UNPACK_FLIP_Y_WEBGL in uploadFrame: flipping the pixels at
    // upload and flipping v here are alternative ways to correct a direct upload, but only
    // the former also holds for FBO textures. Doing it here instead would leave uploads and
    // FBOs on opposite conventions, so each effect pass would flip the frame — upside-down
    // output at odd effect counts, self-cancelling at even ones.
    const data = new Float32Array([
      -1, -1, 0, 0,
      1, -1, 1, 0,
      -1, 1, 0, 1,
      1, 1, 1, 1,
    ]);
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
    gl.bindVertexArray(null);
    return vao;
  }

  private getProgram(key: string, fragmentSource: string): Program {
    let prog = this.programs.get(key);
    if (prog) return prog;
    const { gl } = this;
    const program = linkProgram(gl, VERTEX_SHADER, fragmentSource);
    const uniforms = new Map<string, WebGLUniformLocation | null>();
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(program, i);
      if (info) uniforms.set(info.name, gl.getUniformLocation(program, info.name));
    }
    prog = { program, uniforms };
    this.programs.set(key, prog);
    return prog;
  }

  private setCommonUniforms(prog: Program, timeSeconds: number, opacity: number): void {
    const { gl } = this;
    const texel = prog.uniforms.get('u_texel');
    if (texel) gl.uniform2f(texel, 1 / this.width, 1 / this.height);
    const time = prog.uniforms.get('u_time');
    if (time) gl.uniform1f(time, timeSeconds);
    const op = prog.uniforms.get('u_opacity');
    if (op) gl.uniform1f(op, opacity);
  }

  private setIdentityModel(prog: Program): void {
    const loc = prog.uniforms.get('u_model');
    if (loc) this.gl.uniformMatrix3fv(loc, false, IDENTITY3);
  }

  private setUniform1f(prog: Program, name: string, value: number): void {
    const loc = prog.uniforms.get(name);
    if (loc) this.gl.uniform1f(loc, value);
  }

  private uploadFrame(tex: WebGLTexture, frame: TexImageSource): void {
    const { gl } = this;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // Flip at upload so the texture is bottom-up like every FBO attachment downstream —
    // see createQuad for why the two must agree. DOM sources decode top-down, so without
    // this the uploaded frame would be the one texture in the pipeline reading top-down.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const err = gl.getError();
    const fw = (frame as { videoWidth?: number; naturalWidth?: number; width?: number });
    dthrottle('upload', 400, 'gl', () => [
      'texImage2D frame→texture',
      {
        srcW: fw.videoWidth ?? fw.naturalWidth ?? fw.width,
        srcH: (frame as { videoHeight?: number; naturalHeight?: number; height?: number }).videoHeight ??
          (frame as { naturalHeight?: number }).naturalHeight ??
          (frame as { height?: number }).height,
        glError: err === gl.NO_ERROR ? 'none' : err,
      },
    ]);
  }

  private createFbo(width: number, height: number): Fbo {
    const { gl } = this;
    const tex = gl.createTexture()!;
    dlog('gl', 'GPU texture + FBO created', { width, height });
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fbo, tex };
  }

  private deleteFbo(fbo: Fbo): void {
    this.gl.deleteFramebuffer(fbo.fbo);
    this.gl.deleteTexture(fbo.tex);
  }

  dispose(): void {
    for (const p of this.programs.values()) this.gl.deleteProgram(p.program);
    for (const t of this.textures.values()) this.gl.deleteTexture(t);
    this.gl.deleteTexture(this.source);
    this.deleteFbo(this.ping);
    this.deleteFbo(this.pong);
  }
}

const IDENTITY3 = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(v.slice(0, 6), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile error: ${log}\n${source}`);
  }
  return shader;
}

function linkProgram(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const program = gl.createProgram()!;
  const v = compileShader(gl, gl.VERTEX_SHADER, vs);
  const f = compileShader(gl, gl.FRAGMENT_SHADER, fs);
  gl.attachShader(program, v);
  gl.attachShader(program, f);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`Program link error: ${gl.getProgramInfoLog(program)}`);
  }
  gl.deleteShader(v);
  gl.deleteShader(f);
  return program;
}
