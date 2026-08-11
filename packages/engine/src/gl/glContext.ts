/**
 * GLContext — the WebGL2 plumbing both renderers stand on.
 *
 * Extracted from Compositor when the photo editor grew a render graph of its own. The two
 * renderers answer different questions (a Sequence at time t vs. a layer tree) but ask the GPU
 * the same handful of things: cache a program, upload a frame, draw a quad, ping-pong an FBO.
 * Keeping that in one place is what lets the photo graph reuse the video effect chain verbatim
 * — which is the whole reason a filter written for video appears in both products for free.
 *
 * It owns exactly one piece of policy, and it is the one that has already cost this codebase a
 * real bug: **every texture in the pipeline is bottom-up**. Uploaded frames are flipped once
 * at upload (UNPACK_FLIP_Y_WEBGL) because DOM sources decode top-down, while FBO colour
 * attachments are natively bottom-up. Agreeing on one convention here is what makes the effect
 * chain orientation-neutral. Break it and output flips at ODD effect counts and self-cancels
 * at even ones — which is exactly how it shipped unnoticed the first time. See `createQuad`.
 */

import { dlog, dthrottle } from '../debug.js';
import { uploadSize } from './limits.js';

export interface Program {
  program: WebGLProgram;
  uniforms: Map<string, WebGLUniformLocation | null>;
}

/** A colour-attachment framebuffer: render into `fbo`, sample the result from `tex`. */
export interface Fbo {
  fbo: WebGLFramebuffer;
  tex: WebGLTexture;
  width: number;
  height: number;
}

export const IDENTITY3 = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

export class GLContext {
  readonly gl: WebGL2RenderingContext;
  private quad: WebGLVertexArrayObject;
  private programs = new Map<string, Program>();

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      premultipliedAlpha: false,
      preserveDrawingBuffer: true, // needed so export can readPixels
      alpha: true,
    });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    dlog('gl', 'GLContext created — WebGL2 acquired', {
      renderer: gl.getParameter(gl.RENDERER),
      maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    });
    this.quad = this.createQuad();
  }

  /** The largest square texture this GPU will allocate. The tile planner reads this. */
  get maxTextureSize(): number {
    return this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) as number;
  }

  // ── Programs ────────────────────────────────────────────────────────────────

  /**
   * Fetch-or-compile a program, cached by `key`. Callers pass a stable key (an effect's render
   * key, '__composite', …) so a shader compiles at most once per context.
   */
  getProgram(key: string, vertexSource: string, fragmentSource: string): Program {
    let prog = this.programs.get(key);
    if (prog) return prog;
    const { gl } = this;
    const program = linkProgram(gl, vertexSource, fragmentSource);
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

  setUniform1f(prog: Program, name: string, value: number): void {
    const loc = prog.uniforms.get(name);
    if (loc) this.gl.uniform1f(loc, value);
  }

  setUniform1i(prog: Program, name: string, value: number): void {
    const loc = prog.uniforms.get(name);
    if (loc) this.gl.uniform1i(loc, value);
  }

  setUniform2f(prog: Program, name: string, x: number, y: number): void {
    const loc = prog.uniforms.get(name);
    if (loc) this.gl.uniform2f(loc, x, y);
  }

  setUniformMat3(prog: Program, name: string, m: Float32Array): void {
    const loc = prog.uniforms.get(name);
    if (loc) this.gl.uniformMatrix3fv(loc, false, m);
  }

  /** Bind `tex` to texture unit `unit` and point `name` at it. */
  bindTexture(prog: Program, name: string, tex: WebGLTexture, unit: number): void {
    const { gl } = this;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const loc = prog.uniforms.get(name);
    if (loc) gl.uniform1i(loc, unit);
  }

  // ── Drawing ─────────────────────────────────────────────────────────────────

  useProgram(prog: Program): void {
    this.gl.useProgram(prog.program);
  }

  /**
   * Turn GL's fixed-function blending off.
   *
   * The photo graph does its whole compositing formula in the fragment shader, so leaving this
   * on would blend the shader's already-composited output a second time against the target.
   */
  disableBlend(): void {
    this.gl.disable(this.gl.BLEND);
  }

  /** Standard source-over for unpremultiplied textures. The video composite path uses this. */
  enableSourceOver(): void {
    const { gl } = this;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  deleteTexture(tex: WebGLTexture): void {
    this.gl.deleteTexture(tex);
  }

  /** Draw the unit quad. Every pass in both renderers is one of these. */
  drawQuad(): void {
    const { gl } = this;
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Point rendering at an FBO (or the canvas when null) and size the viewport to it. */
  bindTarget(target: Fbo | null, width: number, height: number): void {
    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.viewport(0, 0, target ? target.width : width, target ? target.height : height);
  }

  /** Clear the bound target to transparent black — the identity backdrop for compositing. */
  clear(r = 0, g = 0, b = 0, a = 0): void {
    const { gl } = this;
    gl.clearColor(r, g, b, a);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  // ── Resources ───────────────────────────────────────────────────────────────

  createFbo(width: number, height: number): Fbo {
    const { gl } = this;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    setSamplerState(gl);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    dlog('gl', 'GPU texture + FBO created', { width, height });
    return { fbo, tex, width, height };
  }

  deleteFbo(target: Fbo): void {
    this.gl.deleteFramebuffer(target.fbo);
    this.gl.deleteTexture(target.tex);
  }

  createTexture(): WebGLTexture {
    return this.gl.createTexture()!;
  }

  /**
   * Upload a decoded frame into `tex`.
   *
   * NEVER upload into an FBO's colour attachment: texImage2D's DOM-source overload
   * re-specifies the texture at the frame's natural size, silently resizing that FBO's
   * attachment away from the render size. A later pass then draws into a mis-sized target
   * under the old viewport, writing one corner and leaving stale pixels around it. Uploads go
   * to a dedicated source texture; this is why `Compositor.source` exists.
   */
  uploadFrame(tex: WebGLTexture, frame: TexImageSource): void {
    const { gl } = this;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // Flip at upload so the texture is bottom-up like every FBO attachment downstream — see
    // this file's header for why the two must agree.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    const source = this.withinLimits(frame);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    setSamplerState(gl);
    dthrottle('upload', 400, 'gl', () => {
      const f = frame as { videoWidth?: number; naturalWidth?: number; width?: number };
      const h = frame as { videoHeight?: number; naturalHeight?: number; height?: number };
      const err = gl.getError();
      return [
        'texImage2D frame→texture',
        {
          srcW: f.videoWidth ?? f.naturalWidth ?? f.width,
          srcH: h.videoHeight ?? h.naturalHeight ?? h.height,
          glError: err === gl.NO_ERROR ? 'none' : err,
        },
      ];
    });
  }

  /**
   * The source to actually upload, downscaled if it exceeds the texture cap.
   *
   * The hardware limit is the important half. A source wider than MAX_TEXTURE_SIZE does not
   * raise an error — `texImage2D` quietly produces a black texture — so a 20-megapixel import on
   * a modest GPU looks like a broken effect chain rather than an oversized image. The configured
   * limit rides along on the same check.
   *
   * Reuses ONE scratch canvas: a photo import can fire this per layer, and allocating a fresh
   * canvas each time leaves the GC holding several hundred MB of dead bitmaps.
   */
  private scratch: HTMLCanvasElement | null = null;
  private withinLimits(frame: TexImageSource): TexImageSource {
    const f = frame as { videoWidth?: number; naturalWidth?: number; width?: number };
    const h = frame as { videoHeight?: number; naturalHeight?: number; height?: number };
    const srcW = f.videoWidth || f.naturalWidth || f.width || 0;
    const srcH = h.videoHeight || h.naturalHeight || h.height || 0;
    if (!srcW || !srcH) return frame; // unknown size: let GL decide
    const target = uploadSize(srcW, srcH, this.maxTextureSize);
    if (!target) return frame;
    const canvas = (this.scratch ??= document.createElement('canvas'));
    canvas.width = target.width;
    canvas.height = target.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return frame;
    ctx.clearRect(0, 0, target.width, target.height);
    ctx.drawImage(frame as CanvasImageSource, 0, 0, target.width, target.height);
    return canvas;
  }

  /**
   * Read the bound target's pixels. Bottom-up, per GL — callers that write files must vflip.
   *
   * `into` lets a caller supply the destination instead of allocating one per call. Export does:
   * at 8 MB a frame, allocating per frame is hundreds of megabytes of garbage per second of
   * output. A buffer of the wrong size is ignored rather than trusted, because a short one would
   * make readPixels throw and a long one would silently keep stale pixels past the frame.
   *
   * This form is SYNCHRONOUS: it waits for the GPU to finish everything queued before it and
   * then for the whole frame to cross the bus. That stall is why the async pair below exists.
   */
  readPixels(width: number, height: number, into?: Uint8Array): Uint8Array {
    const { gl } = this;
    const need = width * height * 4;
    const pixels = into && into.length === need ? into : new Uint8Array(need);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return pixels;
  }

  /*
   * ── ASYNCHRONOUS READBACK ────────────────────────────────────────────────────────────
   *
   * `readPixels` into CPU memory is a full pipeline stall: the call cannot return until the GPU
   * has finished drawing and the pixels have crossed the bus. Measured on a 1080p export it was
   * the single largest cost in the loop — around 80% of it on ordinary footage, dwarfing the
   * composite it was reading.
   *
   * Reading into a PIXEL_PACK_BUFFER instead makes the copy a queued GPU command: it returns
   * immediately and the transfer happens while the CPU gets on with the next frame. Collecting
   * it one frame later then costs only whatever is left. The pixels are identical — this changes
   * WHEN they are fetched, not what they are.
   *
   * Two buffers, alternating, so the read being collected is never the read being issued.
   */
  private packBuffers: (WebGLBuffer | null)[] = [null, null];
  private packBytes = 0;

  /** Queue an async read of the bound target into slot 0 or 1. Returns without waiting. */
  beginReadPixels(width: number, height: number, slot: number): void {
    const { gl } = this;
    const bytes = width * height * 4;
    const i = slot & 1;
    if (this.packBytes !== bytes) {
      // Size changed (or first use): reallocate both, so a stale-sized buffer can never be read.
      for (let k = 0; k < 2; k++) {
        if (this.packBuffers[k]) gl.deleteBuffer(this.packBuffers[k]!);
        this.packBuffers[k] = gl.createBuffer();
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.packBuffers[k]!);
        gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.STREAM_READ);
      }
      this.packBytes = bytes;
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.packBuffers[i]!);
    // With a buffer bound to PIXEL_PACK_BUFFER the last argument is an OFFSET, not a target
    // array — this is the overload that makes the read asynchronous.
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    // Push the queued commands to the driver so the transfer can proceed while we are away;
    // without this the read may not start until something else forces a flush.
    gl.flush();
  }

  /** Collect a read started by beginReadPixels. Blocks only for the remainder of the transfer. */
  endReadPixels(slot: number, into: Uint8Array): Uint8Array {
    const { gl } = this;
    const i = slot & 1;
    const buf = this.packBuffers[i];
    if (!buf || into.length !== this.packBytes) return into;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, into);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    return into;
  }

  dispose(): void {
    for (const b of this.packBuffers) if (b) this.gl.deleteBuffer(b);
    this.packBuffers = [null, null];
    this.packBytes = 0;
    for (const p of this.programs.values()) this.gl.deleteProgram(p.program);
    this.programs.clear();
    this.gl.deleteVertexArray(this.quad);
  }

  // ── Internals ───────────────────────────────────────────────────────────────

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
    // upload and flipping v here are alternative ways to correct a direct upload, but only the
    // former also holds for FBO textures. Doing it here instead would leave uploads and FBOs on
    // opposite conventions, so each effect pass would flip the frame.
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
}

function setSamplerState(gl: WebGL2RenderingContext): void {
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
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
