/**
 * Renderer — the entire play field, drawn procedurally into one 2D canvas.
 *
 * No image assets: the mountains are seeded ridge noise, the moon and fog are
 * radial gradients, the torii is four rectangles, and the notes are hand-built
 * blade shapes. That keeps the installer small and lets every element be
 * re-tinted by the chosen breathing style at runtime.
 *
 * Everything that moves is driven by `songTime` from the Conductor, never by
 * frame count, so the visuals stay locked to audio even if frames are dropped.
 */

import type { Chart, ChartNote } from './composer';
import type { NoteState, HitEvent, Judgement } from './engine';
import { JUDGEMENT_LABEL } from './engine';
import type { BreathingStyle } from '../data/breathing';
import type { SongSpec } from '../data/songs';

const MAX_PARTICLES = 520;

const JUDGE_COLOR: Record<Judgement, string> = {
  kiwami: '#ffd76a',
  zan: '#6fe3c4',
  kasuri: '#6aa8ff',
  shitsu: '#ff5c6e',
};

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
  gravity: number;
  spin: number;
  rot: number;
  kind: 'spark' | 'petal' | 'shard' | 'stream';
}

interface Ripple {
  lane: number;
  life: number;
  maxLife: number;
  color: string;
  strength: number;
}

interface Burst {
  x: number;
  y: number;
  life: number;
  color: string;
  maxRadius: number;
}

interface JudgePop {
  lane: number;
  life: number;
  kanji: string;
  romaji: string;
  color: string;
  delta: number;
}

export interface RenderState {
  time: number;
  combo: number;
  artActive: boolean;
  intensity: number;
  paused: boolean;
}

export interface RendererOptions {
  /** 1 = default reading time; higher scrolls faster. */
  scrollSpeed: number;
  showLaneGuides: boolean;
  reducedEffects: boolean;
  /** Short display labels for the receptors, in lane order. */
  laneLabels: string[];
}

export class Renderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private chart: Chart;
  private song: SongSpec;
  private style: BreathingStyle;
  private opts: RendererOptions;

  private w = 0;
  private h = 0;
  private dpr = 1;

  /* layout, recomputed on resize */
  private fieldX = 0;
  private fieldW = 0;
  private laneW = 0;
  private hitY = 0;
  private topY = 0;

  /** Seconds a note is visible before it reaches the hit line. */
  private approach = 1.5;

  private particles: Particle[] = [];
  private ripples: Ripple[] = [];
  private bursts: Burst[] = [];
  private pops: JudgePop[] = [];
  private laneGlow: number[] = [];
  private laneHeld: boolean[] = [];
  private shake = 0;
  private flash = 0;
  private missFlash = 0;

  private ridgeFar: number[] = [];
  private ridgeNear: number[] = [];
  private stars: Array<{ x: number; y: number; r: number; tw: number }> = [];

  /** Cached per-lane centre X so the hot loop does no arithmetic. */
  private laneCx: number[] = [];

  constructor(
    canvas: HTMLCanvasElement,
    chart: Chart,
    song: SongSpec,
    style: BreathingStyle,
    opts: RendererOptions,
  ) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;
    this.chart = chart;
    this.song = song;
    this.style = style;
    this.opts = opts;
    this.laneGlow = new Array(chart.laneCount).fill(0);
    this.laneHeld = new Array(chart.laneCount).fill(false);
    this.laneCx = new Array(chart.laneCount).fill(0);
    this.approach = 1.5 / (opts.scrollSpeed * style.modifiers.scrollMul);
    this.buildScenery();
    this.resize();
  }

  setOptions(opts: Partial<RendererOptions>): void {
    this.opts = { ...this.opts, ...opts };
    this.approach =
      1.5 / (this.opts.scrollSpeed * this.style.modifiers.scrollMul);
  }

  /* ---------------------------------------------------------------- *
   * scenery generation (once)
   * ---------------------------------------------------------------- */

  private buildScenery(): void {
    const seed = this.song.id.length * 97 + this.song.bpm;
    const noise = (i: number, f: number, o: number) =>
      Math.sin(i * f + seed * 0.37 + o) * 0.5 +
      Math.sin(i * f * 2.3 + seed * 0.11 + o) * 0.3 +
      Math.sin(i * f * 5.1 + o) * 0.2;

    for (let i = 0; i < 160; i++) {
      this.ridgeFar.push(noise(i, 0.09, 0) * 0.5 + 0.5);
      this.ridgeNear.push(noise(i, 0.14, 2.4) * 0.5 + 0.5);
    }

    for (let i = 0; i < 90; i++) {
      this.stars.push({
        x: Math.random(),
        y: Math.random() * 0.55,
        r: Math.random() * 1.3 + 0.3,
        tw: Math.random() * Math.PI * 2,
      });
    }
  }

  /* ---------------------------------------------------------------- *
   * layout
   * ---------------------------------------------------------------- */

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.w = Math.max(1, Math.round(rect.width));
    this.h = Math.max(1, Math.round(rect.height));

    /*
     * Budget the backing store rather than trusting devicePixelRatio blindly.
     * A maximised window on a Retina display is ~3.7 megapixels of CSS area,
     * which at dpr 2 is a 15-megapixel canvas redrawn every frame — enough on
     * its own to push the compositor past its tile budget. Capping total
     * pixels degrades gracefully: small windows stay fully crisp, and only very
     * large ones give up sharpness they were not really showing anyway.
     */
    const MAX_BACKING_PIXELS = 6_000_000;
    const cssPixels = this.w * this.h;
    let dpr = Math.min(2, window.devicePixelRatio || 1);
    if (cssPixels * dpr * dpr > MAX_BACKING_PIXELS) {
      dpr = Math.max(1, Math.sqrt(MAX_BACKING_PIXELS / cssPixels));
    }
    this.dpr = dpr;

    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    this.fieldW = Math.min(520, Math.max(320, this.w * 0.40));
    this.fieldX = (this.w - this.fieldW) / 2;
    this.laneW = this.fieldW / this.chart.laneCount;
    this.hitY = this.h * 0.8;
    this.topY = -60;
    for (let i = 0; i < this.chart.laneCount; i++) {
      this.laneCx[i] = this.fieldX + this.laneW * (i + 0.5);
    }
  }

  /** Screen Y for a note that lands at `noteTime`, given the current time. */
  private yFor(noteTime: number, time: number): number {
    const t = (noteTime - time) / this.approach; // 1 = just spawned, 0 = hit line
    return this.hitY - t * (this.hitY - this.topY);
  }

  /* ---------------------------------------------------------------- *
   * feedback hooks
   * ---------------------------------------------------------------- */

  onHit(ev: HitEvent): void {
    const color = JUDGE_COLOR[ev.judgement];
    const cx = this.laneCx[ev.lane];

    this.pops.push({
      lane: ev.lane,
      life: 1,
      kanji: JUDGEMENT_LABEL[ev.judgement].kanji,
      romaji: JUDGEMENT_LABEL[ev.judgement].romaji,
      color,
      delta: ev.delta,
    });

    if (ev.judgement === 'shitsu') {
      this.missFlash = Math.min(1, this.missFlash + 0.45);
      this.shake = Math.min(9, this.shake + 4);
      this.emit(cx, this.hitY, 8, '#ff5c6e', 'shard');
      return;
    }

    const strength = ev.judgement === 'kiwami' ? 1 : ev.judgement === 'zan' ? 0.7 : 0.45;
    this.ripples.push({
      lane: ev.lane,
      life: 1,
      maxLife: 1,
      color,
      strength,
    });
    this.laneGlow[ev.lane] = Math.max(this.laneGlow[ev.lane], strength);
    this.flash = Math.min(1, Math.max(this.flash, strength * (ev.upgraded ? 0.6 : 0.32)));
    if (ev.judgement === 'kiwami') this.shake = Math.min(6, this.shake + 1.6);

    const n = this.opts.reducedEffects ? 6 : Math.round(10 + strength * 16);
    this.emit(cx, this.hitY, n, this.style.spark, 'spark');
    if (ev.judgement === 'kiwami' && !this.opts.reducedEffects) {
      this.emit(cx, this.hitY, 6, color, 'shard');
    }
  }

  onArt(): void {
    this.flash = 1;
    this.shake = 12;
    for (let i = 0; i < this.chart.laneCount; i++) {
      this.emit(this.laneCx[i], this.hitY, 22, this.style.accent, 'spark');
    }
  }

  setHeld(lane: number, held: boolean): void {
    this.laneHeld[lane] = held;
    if (held) this.laneGlow[lane] = Math.max(this.laneGlow[lane], 0.35);
  }

  /** Sparks that ride up the lane, following the held tail. */
  private emitStream(x: number, y: number, color: string): void {
    if (this.particles.length >= MAX_PARTICLES) return;
    this.particles.push({
      x: x + (Math.random() - 0.5) * this.laneW * 0.4,
      y: y + (Math.random() - 0.5) * 6,
      vx: (Math.random() - 0.5) * 0.7,
      vy: -(2.4 + Math.random() * 3.4),
      life: 1,
      maxLife: 0.35 + Math.random() * 0.4,
      size: 0.9 + Math.random() * 1.8,
      color,
      gravity: -0.06,
      spin: 0,
      rot: 0,
      kind: 'stream',
    });
  }

  /** A hold carried all the way to its end. */
  onHoldComplete(lane: number): void {
    const cx = this.laneCx[lane];
    this.bursts.push({
      x: cx,
      y: this.hitY,
      life: 1,
      color: this.style.accent,
      maxRadius: this.laneW * 1.25,
    });
    this.laneGlow[lane] = 1;
    this.flash = Math.min(1, this.flash + 0.3);
    this.emit(cx, this.hitY, this.opts.reducedEffects ? 6 : 18, this.style.spark, 'spark');
  }

  /** A hold dropped early. */
  onHoldBreak(lane: number): void {
    const cx = this.laneCx[lane];
    this.missFlash = Math.min(1, this.missFlash + 0.35);
    this.shake = Math.min(9, this.shake + 3);
    this.emit(cx, this.hitY, 10, '#ff5c6e', 'shard');
  }

  private emit(
    x: number,
    y: number,
    count: number,
    color: string,
    kind: Particle['kind'],
  ): void {
    for (let i = 0; i < count; i++) {
      if (this.particles.length >= MAX_PARTICLES) break;
      const a = Math.random() * Math.PI * 2;
      const sp = kind === 'shard' ? 3 + Math.random() * 5 : 1.4 + Math.random() * 4.4;
      this.particles.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - (kind === 'spark' ? 1.6 : 0.4),
        life: 1,
        maxLife: 0.45 + Math.random() * 0.55,
        size: kind === 'shard' ? 2 + Math.random() * 3 : 1 + Math.random() * 2.4,
        color,
        gravity: kind === 'shard' ? 0.28 : 0.13,
        spin: (Math.random() - 0.5) * 0.4,
        rot: Math.random() * Math.PI,
        kind,
      });
    }
  }

  /* ---------------------------------------------------------------- *
   * main draw
   * ---------------------------------------------------------------- */

  draw(state: RenderState, states: NoteState[], activeFrom: number): void {
    const { ctx } = this;
    const dt = 1 / 60;

    ctx.save();
    if (this.shake > 0.05) {
      const s = this.shake;
      ctx.translate((Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
      this.shake *= 0.86;
    }

    this.drawSky(state);
    this.drawStars(state);
    this.drawMoon(state);
    this.drawMountains(state);
    this.drawTorii(state);
    this.drawFog(state);
    this.drawField(state);
    this.drawNotes(state, states, activeFrom);
    this.drawHitLine(state);
    this.drawEffects(state, dt);

    if (state.artActive) this.drawArtOverlay(state);
    if (this.missFlash > 0.01) {
      ctx.fillStyle = `rgba(255, 40, 70, ${this.missFlash * 0.1})`;
      ctx.fillRect(0, 0, this.w, this.h);
      this.missFlash *= 0.8;
    }
    if (this.flash > 0.01) {
      ctx.fillStyle = `rgba(255, 255, 255, ${this.flash * 0.1})`;
      ctx.fillRect(0, 0, this.w, this.h);
      this.flash *= 0.85;
    }

    ctx.restore();
  }

  /* --- background -------------------------------------------------- */

  private drawSky(state: RenderState): void {
    const { ctx } = this;
    const energy = state.intensity;
    const g = ctx.createLinearGradient(0, 0, 0, this.h);
    g.addColorStop(0, '#05040a');
    g.addColorStop(0.42, this.mix('#05040a', this.song.hue2, 0.35 + energy * 0.3));
    g.addColorStop(
      0.72,
      this.mix('#0a0812', state.artActive ? this.style.accent2 : this.song.hue2, 0.5 + energy * 0.32),
    );
    g.addColorStop(1, '#04030700');
    ctx.fillStyle = '#05040a';
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.w, this.h);
  }

  private drawStars(state: RenderState): void {
    const { ctx } = this;
    ctx.save();
    for (const s of this.stars) {
      const tw = 0.45 + Math.sin(state.time * 1.6 + s.tw) * 0.3;
      ctx.globalAlpha = tw * 0.7;
      ctx.fillStyle = '#f4eee2';
      ctx.beginPath();
      ctx.arc(s.x * this.w, s.y * this.h, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawMoon(state: RenderState): void {
    const { ctx } = this;
    const cx = this.w * 0.79;
    const cy = this.h * 0.19;
    const r = Math.min(this.w, this.h) * 0.085;
    const pulse = 1 + Math.sin(state.time * 0.7) * 0.02;

    const glow = ctx.createRadialGradient(cx, cy, r * 0.5, cx, cy, r * 5.4);
    const moonTint = state.artActive ? this.style.accent : '#ffeccf';
    glow.addColorStop(0, this.rgba(moonTint, 0.3));
    glow.addColorStop(0.35, this.rgba(moonTint, 0.08));
    glow.addColorStop(1, this.rgba(moonTint, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(cx - r * 5.5, cy - r * 5.5, r * 11, r * 11);

    ctx.fillStyle = state.artActive ? this.mix('#fff4e0', this.style.accent, 0.5) : '#fdf3e0';
    ctx.beginPath();
    ctx.arc(cx, cy, r * pulse, 0, Math.PI * 2);
    ctx.fill();

    // craters
    ctx.fillStyle = 'rgba(120, 108, 92, 0.16)';
    const craters: Array<[number, number, number]> = [
      [-0.3, -0.25, 0.22],
      [0.28, 0.12, 0.16],
      [-0.1, 0.38, 0.12],
      [0.42, -0.36, 0.1],
    ];
    for (const [dx, dy, cr] of craters) {
      ctx.beginPath();
      ctx.arc(cx + dx * r, cy + dy * r, cr * r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawMountains(state: RenderState): void {
    const { ctx } = this;
    const layers: Array<[number[], number, number, string]> = [
      [this.ridgeFar, 0.5, 0.1, '#120f1c'],
      [this.ridgeNear, 0.62, 0.16, '#0a0812'],
    ];
    const drift = state.time * 6;

    for (const [ridge, baseY, amp, color] of layers) {
      ctx.beginPath();
      ctx.moveTo(0, this.h);
      const n = ridge.length;
      for (let i = 0; i <= n; i++) {
        const x = (i / n) * this.w;
        const idx = (i + Math.floor(drift * 0.02)) % n;
        const y = this.h * (baseY + ridge[idx] * amp);
        ctx.lineTo(x, y);
      }
      ctx.lineTo(this.w, this.h);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    }
  }

  private drawTorii(state: RenderState): void {
    const { ctx } = this;
    const cx = this.w / 2;
    const baseY = this.h * 0.62;
    const hgt = this.h * 0.3;
    const half = this.fieldW * 0.72;
    const pillar = Math.max(7, this.fieldW * 0.032);

    ctx.save();
    ctx.globalAlpha = 0.5 + state.intensity * 0.2;
    ctx.fillStyle = state.artActive
      ? this.rgba(this.style.accent2, 0.55)
      : 'rgba(96, 20, 30, 0.62)';

    // pillars, slightly splayed the way real torii are
    ctx.fillRect(cx - half - pillar / 2, baseY - hgt, pillar, hgt);
    ctx.fillRect(cx + half - pillar / 2, baseY - hgt, pillar, hgt);
    // nuki (lower beam)
    ctx.fillRect(cx - half - pillar, baseY - hgt * 0.72, half * 2 + pillar * 2, pillar * 0.8);
    // kasagi (upper beam) with its upward sweep faked by two stacked bars
    ctx.fillRect(cx - half - pillar * 2.2, baseY - hgt, half * 2 + pillar * 4.4, pillar * 1.1);
    ctx.fillRect(cx - half - pillar * 1.6, baseY - hgt + pillar * 1.1, half * 2 + pillar * 3.2, pillar * 0.5);
    ctx.restore();
  }

  private drawFog(state: RenderState): void {
    const { ctx } = this;
    ctx.save();
    for (let i = 0; i < 3; i++) {
      const y = this.h * (0.5 + i * 0.13);
      const off = ((state.time * (7 + i * 5)) % (this.w + 400)) - 200;
      const g = ctx.createLinearGradient(0, y - 60, 0, y + 60);
      g.addColorStop(0, 'rgba(180, 196, 220, 0)');
      g.addColorStop(0.5, `rgba(180, 196, 220, ${0.05 + i * 0.012})`);
      g.addColorStop(1, 'rgba(180, 196, 220, 0)');
      ctx.fillStyle = g;
      ctx.fillRect(off - this.w, y - 60, this.w * 2.4, 120);
    }
    ctx.restore();
  }

  /* --- play field --------------------------------------------------- */

  private drawField(state: RenderState): void {
    const { ctx } = this;
    const top = 0;
    const bottom = this.h;

    // darkened floor so notes always have contrast
    const g = ctx.createLinearGradient(0, top, 0, bottom);
    g.addColorStop(0, 'rgba(4, 3, 8, 0.05)');
    g.addColorStop(0.55, 'rgba(4, 3, 8, 0.55)');
    g.addColorStop(1, 'rgba(4, 3, 8, 0.9)');
    ctx.fillStyle = g;
    ctx.fillRect(this.fieldX, top, this.fieldW, bottom);

    // edge rails
    ctx.strokeStyle = this.rgba(this.style.accent, 0.28);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(this.fieldX + 0.5, top);
    ctx.lineTo(this.fieldX + 0.5, bottom);
    ctx.moveTo(this.fieldX + this.fieldW - 0.5, top);
    ctx.lineTo(this.fieldX + this.fieldW - 0.5, bottom);
    ctx.stroke();

    // bar lines, for reading tempo
    if (this.opts.showLaneGuides) {
      const spb = this.chart.secPerBeat;
      const firstBeat = Math.floor((state.time - 0.2) / (spb * 4)) * 4;
      ctx.strokeStyle = 'rgba(244, 238, 226, 0.07)';
      for (let b = firstBeat; b < firstBeat + 32; b += 4) {
        const t = 2.2 + b * spb;
        const y = this.yFor(t, state.time);
        if (y < -20 || y > this.hitY + 20) continue;
        ctx.beginPath();
        ctx.moveTo(this.fieldX, y);
        ctx.lineTo(this.fieldX + this.fieldW, y);
        ctx.stroke();
      }
    }

    // lane separators + per-lane glow columns
    for (let i = 0; i < this.chart.laneCount; i++) {
      const x = this.fieldX + this.laneW * i;
      if (i > 0) {
        ctx.strokeStyle = 'rgba(244, 238, 226, 0.09)';
        ctx.beginPath();
        ctx.moveTo(x + 0.5, top);
        ctx.lineTo(x + 0.5, bottom);
        ctx.stroke();
      }

      const glow = this.laneGlow[i];
      if (glow > 0.01) {
        const lg = ctx.createLinearGradient(0, this.hitY - 260, 0, this.hitY);
        lg.addColorStop(0, this.rgba(this.style.accent, 0));
        lg.addColorStop(1, this.rgba(this.style.accent, glow * 0.3));
        ctx.fillStyle = lg;
        ctx.fillRect(x, this.hitY - 260, this.laneW, 260);
        this.laneGlow[i] *= 0.9;
      }
    }
  }

  private drawNotes(
    state: RenderState,
    states: NoteState[],
    activeFrom: number,
  ): void {
    const visibleAhead = state.time + this.approach + 0.1;
    const fadeFrom = this.style.modifiers.fadeFrom;

    for (let i = activeFrom; i < states.length; i++) {
      const st = states[i];
      const note = st.note;
      if (note.time > visibleAhead) break;
      if (st.judged !== null && note.kind === 'tap') continue;
      if (st.holdDone) continue;

      const y = this.yFor(note.time, state.time);
      if (y > this.hitY + 40) continue;

      // Mist Breathing hides the top of the lane.
      let alpha = 1;
      if (fadeFrom > 0) {
        const progress = 1 - (y - this.topY) / (this.hitY - this.topY);
        // progress: 0 at spawn, 1 at hit line
        alpha = Math.min(1, Math.max(0, (progress - fadeFrom) / 0.25));
      }
      if (alpha <= 0.01) continue;

      if (note.kind === 'hold') {
        this.drawHold(note, st, state, y, alpha);
      }
      this.drawNote(note, y, alpha, state);
    }
  }

  /**
   * Hold tails. The important state to communicate is *is the player currently
   * holding this* — before, the only cue was a slightly brighter fill, which
   * was easy to miss mid-song. An active hold now pulses, runs energy up the
   * lane, and streams sparks off the receptor, so the answer is obvious from
   * peripheral vision while you are reading notes further up the field.
   */
  private drawHold(
    note: ChartNote,
    st: NoteState,
    state: RenderState,
    headY: number,
    alpha: number,
  ): void {
    const { ctx } = this;
    const cx = this.laneCx[note.lane];
    const tailY = this.yFor(note.time + note.duration, state.time);
    const wdt = this.laneW * 0.44;
    const top = Math.max(this.topY, tailY);
    const bot = Math.min(this.hitY, headY);
    if (bot <= top) return;

    const active = st.holdStart !== null && !st.holdDone;
    const broken = st.holdBroken;
    const accent = broken ? '#ff5c6e' : this.style.accent;

    ctx.save();
    ctx.globalAlpha = alpha * (broken ? 0.22 : 1);

    /* --- outer bloom, only while gripped --------------------------- */
    if (active && !this.opts.reducedEffects) {
      const bloom = ctx.createLinearGradient(cx - wdt, 0, cx + wdt, 0);
      bloom.addColorStop(0, this.rgba(accent, 0));
      bloom.addColorStop(0.5, this.rgba(accent, 0.22));
      bloom.addColorStop(1, this.rgba(accent, 0));
      ctx.fillStyle = bloom;
      ctx.fillRect(cx - wdt, top, wdt * 2, bot - top);
    }

    /* --- body ------------------------------------------------------ */
    // A fast shimmer reads as tension being held, rather than a static bar.
    const pulse = active ? 0.72 + Math.sin(state.time * 16) * 0.24 : 0.34;
    const g = ctx.createLinearGradient(cx - wdt / 2, 0, cx + wdt / 2, 0);
    g.addColorStop(0, this.rgba(accent, 0.08));
    g.addColorStop(0.5, this.rgba(accent, pulse));
    g.addColorStop(1, this.rgba(accent, 0.08));
    ctx.fillStyle = g;
    ctx.fillRect(cx - wdt / 2, top, wdt, bot - top);

    /* --- bright core ----------------------------------------------- */
    if (active) {
      ctx.fillStyle = this.rgba('#ffffff', 0.16 + Math.sin(state.time * 16) * 0.1);
      ctx.fillRect(cx - wdt * 0.13, top, wdt * 0.26, bot - top);
    }

    /* --- energy running up the lane -------------------------------- */
    ctx.strokeStyle = this.rgba('#ffffff', active ? 0.35 : 0.12);
    ctx.lineWidth = active ? 1.6 : 1;
    const step = active ? 20 : 14;
    const speed = active ? 340 : 60;
    const phase = ((state.time * speed) % step) + step;
    for (let y = bot - phase; y > top; y -= step) {
      const k = active ? 1 - (bot - y) / Math.max(1, bot - top) : 1;
      ctx.globalAlpha = alpha * (broken ? 0.2 : 0.35 + k * 0.65);
      ctx.beginPath();
      ctx.moveTo(cx - wdt / 2, y);
      ctx.lineTo(cx + wdt / 2, y);
      ctx.stroke();
    }
    ctx.globalAlpha = alpha * (broken ? 0.22 : 1);

    /* --- edges ------------------------------------------------------ */
    ctx.strokeStyle = this.rgba(accent, active ? 0.9 : 0.4);
    ctx.lineWidth = active ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(cx - wdt / 2, top);
    ctx.lineTo(cx - wdt / 2, bot);
    ctx.moveTo(cx + wdt / 2, top);
    ctx.lineTo(cx + wdt / 2, bot);
    ctx.stroke();

    /* --- the grip: where the tail meets the judgement line ---------- */
    if (active) {
      const gripPulse = 1 + Math.sin(state.time * 18) * 0.22;

      const halo = ctx.createRadialGradient(cx, this.hitY, 2, cx, this.hitY, wdt * 1.5 * gripPulse);
      halo.addColorStop(0, this.rgba('#ffffff', 0.5));
      halo.addColorStop(0.35, this.rgba(accent, 0.4));
      halo.addColorStop(1, this.rgba(accent, 0));
      ctx.fillStyle = halo;
      ctx.fillRect(cx - wdt * 1.6, this.hitY - wdt * 1.6, wdt * 3.2, wdt * 3.2);

      ctx.strokeStyle = this.rgba('#ffffff', 0.85);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(cx, this.hitY, wdt * 0.62 * gripPulse, wdt * 0.3 * gripPulse, 0, 0, Math.PI * 2);
      ctx.stroke();

      // remaining-time arc, so you can see how much longer to hold
      const remaining = 1 - st.holdProgress;
      ctx.strokeStyle = this.rgba(accent, 0.95);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(cx, this.hitY, wdt * 0.86, -Math.PI / 2, -Math.PI / 2 + remaining * Math.PI * 2);
      ctx.stroke();
    }

    /* --- a dropped hold visibly frays ------------------------------- */
    if (broken) {
      ctx.strokeStyle = this.rgba('#ff5c6e', 0.5);
      ctx.lineWidth = 1;
      for (let y = top; y < bot; y += 18) {
        const jag = (Math.sin(y * 0.7) * wdt) / 3;
        ctx.beginPath();
        ctx.moveTo(cx - wdt / 2 + jag, y);
        ctx.lineTo(cx + wdt / 2 + jag, y + 9);
        ctx.stroke();
      }
    }

    ctx.restore();

    /* --- sparks streaming off the receptor while held --------------- */
    if (active && !this.opts.reducedEffects && Math.random() < 0.6) {
      this.emitStream(cx, this.hitY, this.style.spark);
    }
  }

  private drawNote(
    note: ChartNote,
    y: number,
    alpha: number,
    state: RenderState,
  ): void {
    const { ctx } = this;
    const cx = this.laneCx[note.lane];
    const wdt = this.laneW * 0.78;
    const hgt = 15;
    const accent = note.chord ? '#ffd76a' : this.style.accent;

    // depth cue: distant notes are slightly smaller and dimmer
    const depth = Math.max(0.55, Math.min(1, (y - this.topY) / (this.hitY - this.topY)));
    const sw = wdt * (0.72 + depth * 0.28);
    const sh = hgt * (0.72 + depth * 0.28);

    ctx.save();
    ctx.globalAlpha = alpha * (0.55 + depth * 0.45);
    ctx.translate(cx, y);

    // blade body — a slanted shard, brighter along the leading edge
    const g = ctx.createLinearGradient(0, -sh / 2, 0, sh / 2);
    g.addColorStop(0, this.rgba('#ffffff', 0.95));
    g.addColorStop(0.35, accent);
    g.addColorStop(1, this.rgba(this.style.accent2, 0.9));

    const skew = sw * 0.14;
    ctx.beginPath();
    ctx.moveTo(-sw / 2 + skew, -sh / 2);
    ctx.lineTo(sw / 2, -sh / 2);
    ctx.lineTo(sw / 2 - skew, sh / 2);
    ctx.lineTo(-sw / 2, sh / 2);
    ctx.closePath();
    ctx.fillStyle = g;
    ctx.fill();

    // hard highlight line along the top — reads as a sharpened edge
    ctx.strokeStyle = this.rgba('#ffffff', 0.85);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-sw / 2 + skew, -sh / 2 + 0.75);
    ctx.lineTo(sw / 2, -sh / 2 + 0.75);
    ctx.stroke();

    // as it nears the line, a soft aura appears so timing is readable
    if (depth > 0.86 && !this.opts.reducedEffects) {
      const k = (depth - 0.86) / 0.14;
      const aura = ctx.createRadialGradient(0, 0, 2, 0, 0, sw * 0.9);
      aura.addColorStop(0, this.rgba(accent, 0.4 * k));
      aura.addColorStop(1, this.rgba(accent, 0));
      ctx.fillStyle = aura;
      ctx.fillRect(-sw, -sw, sw * 2, sw * 2);
    }

    if (state.artActive) {
      ctx.strokeStyle = this.rgba('#ffffff', 0.5);
      ctx.lineWidth = 1;
      ctx.strokeRect(-sw / 2 - 3, -sh / 2 - 3, sw + 6, sh + 6);
    }

    ctx.restore();
  }

  private drawHitLine(state: RenderState): void {
    const { ctx } = this;
    const y = this.hitY;

    // beam
    const g = ctx.createLinearGradient(this.fieldX, 0, this.fieldX + this.fieldW, 0);
    g.addColorStop(0, this.rgba(this.style.accent, 0.05));
    g.addColorStop(0.5, this.rgba(this.style.accent, 0.95));
    g.addColorStop(1, this.rgba(this.style.accent, 0.05));
    ctx.fillStyle = g;
    ctx.fillRect(this.fieldX - 26, y - 1.5, this.fieldW + 52, 3);

    // bloom under the beam
    const bloom = ctx.createLinearGradient(0, y - 26, 0, y + 26);
    bloom.addColorStop(0, this.rgba(this.style.accent, 0));
    bloom.addColorStop(0.5, this.rgba(this.style.accent, 0.2));
    bloom.addColorStop(1, this.rgba(this.style.accent, 0));
    ctx.fillStyle = bloom;
    ctx.fillRect(this.fieldX - 26, y - 26, this.fieldW + 52, 52);

    // receptors
    for (let i = 0; i < this.chart.laneCount; i++) {
      const cx = this.laneCx[i];
      const wdt = this.laneW * 0.78;
      const held = this.laneHeld[i];
      const glow = this.laneGlow[i];

      ctx.save();
      ctx.translate(cx, y);
      ctx.strokeStyle = this.rgba(
        this.style.accent,
        held ? 0.95 : 0.4 + glow * 0.5,
      );
      ctx.lineWidth = held ? 2.4 : 1.4;
      ctx.beginPath();
      ctx.moveTo(-wdt / 2, -9);
      ctx.lineTo(wdt / 2, -9);
      ctx.moveTo(-wdt / 2, 9);
      ctx.lineTo(wdt / 2, 9);
      ctx.stroke();

      // corner ticks
      const t = 7;
      ctx.beginPath();
      ctx.moveTo(-wdt / 2, -9 + t);
      ctx.lineTo(-wdt / 2, -9);
      ctx.lineTo(-wdt / 2 + t, -9);
      ctx.moveTo(wdt / 2 - t, 9);
      ctx.lineTo(wdt / 2, 9);
      ctx.lineTo(wdt / 2, 9 - t);
      ctx.stroke();

      if (held) {
        ctx.fillStyle = this.rgba(this.style.accent, 0.18);
        ctx.fillRect(-wdt / 2, -9, wdt, 18);
      }

      const label = this.opts.laneLabels[i];
      if (label) {
        ctx.fillStyle = this.rgba(
          held ? '#ffffff' : this.style.accent,
          held ? 0.95 : 0.68,
        );
        ctx.font = `700 ${this.chart.laneCount >= 8 ? 8 : 9}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(label, 0, 15);
      }
      ctx.restore();
    }

    // shimenawa tassels anchoring the line to the world
    ctx.fillStyle = this.rgba('#f4eee2', 0.5);
    for (const side of [-1, 1]) {
      const x = this.w / 2 + side * (this.fieldW / 2 + 26);
      ctx.beginPath();
      ctx.moveTo(x - 5, y - 2);
      ctx.lineTo(x + 5, y - 2);
      ctx.lineTo(x + 2, y + 26);
      ctx.lineTo(x - 2, y + 26);
      ctx.closePath();
      ctx.fill();
    }
    void state;
  }

  /* --- effects ------------------------------------------------------ */

  private drawEffects(state: RenderState, dt: number): void {
    const { ctx } = this;

    // slash arcs
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const r = this.ripples[i];
      r.life -= dt * 3.2;
      if (r.life <= 0) {
        this.ripples.splice(i, 1);
        continue;
      }
      const p = 1 - r.life;
      const cx = this.laneCx[r.lane];
      const radius = this.laneW * (0.25 + p * 1.5);
      ctx.save();
      ctx.globalAlpha = r.life * r.strength;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = 3 * r.life * r.strength + 0.5;
      ctx.beginPath();
      ctx.ellipse(cx, this.hitY, radius, radius * 0.42, 0, 0, Math.PI * 2);
      ctx.stroke();

      // the cut itself: a diagonal streak through the receptor
      if (p < 0.5) {
        const len = this.laneW * (0.8 + p * 2);
        ctx.globalAlpha = (1 - p * 2) * r.strength;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(cx - len / 2, this.hitY + len * 0.22);
        ctx.lineTo(cx + len / 2, this.hitY - len * 0.22);
        ctx.stroke();
      }
      ctx.restore();
    }

    // expanding rings from completed holds
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const b = this.bursts[i];
      b.life -= dt * 2.4;
      if (b.life <= 0) {
        this.bursts.splice(i, 1);
        continue;
      }
      const p = 1 - b.life;
      ctx.save();
      ctx.globalAlpha = b.life * 0.9;
      ctx.strokeStyle = b.color;
      ctx.lineWidth = 3 * b.life + 0.5;
      ctx.beginPath();
      ctx.ellipse(b.x, b.y, b.maxRadius * p, b.maxRadius * p * 0.45, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = b.life * 0.5;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5 * b.life;
      ctx.beginPath();
      ctx.ellipse(b.x, b.y, b.maxRadius * p * 0.62, b.maxRadius * p * 0.28, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // particles
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt / p.maxLife;
      if (p.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }
      p.vy += p.gravity;
      p.vx *= 0.98;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.spin;

      ctx.save();
      ctx.globalAlpha = Math.min(1, p.life);
      ctx.fillStyle = p.color;
      if (p.kind === 'shard') {
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillRect(-p.size, -p.size * 0.35, p.size * 2, p.size * 0.7);
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // judgement text
    for (let i = this.pops.length - 1; i >= 0; i--) {
      const pop = this.pops[i];
      pop.life -= dt * 1.7;
      if (pop.life <= 0) {
        this.pops.splice(i, 1);
        continue;
      }
      const rise = (1 - pop.life) * 34;
      const cx = this.laneCx[pop.lane];
      ctx.save();
      ctx.globalAlpha = Math.min(1, pop.life * 1.6);
      ctx.textAlign = 'center';
      ctx.fillStyle = pop.color;
      ctx.font = `600 26px "Hiragino Mincho ProN", "Yu Mincho", serif`;
      ctx.fillText(pop.kanji, cx, this.hitY - 46 - rise);
      ctx.globalAlpha = Math.min(1, pop.life) * 0.7;
      ctx.font = `700 8px "Avenir Next", system-ui, sans-serif`;
      ctx.letterSpacing = '2px';
      ctx.fillText(pop.romaji, cx, this.hitY - 32 - rise);
      ctx.letterSpacing = '0px';
      ctx.restore();
    }

    void state;
  }

  private drawArtOverlay(state: RenderState): void {
    const { ctx } = this;
    const t = state.time;

    // radial speed lines from the hit line outward
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    const cx = this.w / 2;
    const cy = this.hitY;
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2 + t * 0.6;
      const r0 = this.fieldW * 0.6 + ((t * 220 + i * 60) % 400);
      const r1 = r0 + 90;
      ctx.globalAlpha = 0.06 + (Math.sin(t * 4 + i) + 1) * 0.03;
      ctx.strokeStyle = this.style.accent;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0 * 0.6);
      ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1 * 0.6);
      ctx.stroke();
    }
    ctx.restore();

    // style kanji watermark behind the field
    ctx.save();
    ctx.globalAlpha = 0.07 + Math.sin(t * 3) * 0.02;
    ctx.fillStyle = this.style.accent;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `600 ${Math.round(this.h * 0.34)}px "Hiragino Mincho ProN", serif`;
    ctx.fillText(this.style.kanji[0], this.w / 2, this.h * 0.44);
    ctx.restore();
  }

  /* --- colour helpers ----------------------------------------------- */

  private parse(hex: string): [number, number, number] {
    const h = hex.replace('#', '');
    const v =
      h.length === 3
        ? h
            .split('')
            .map((c) => c + c)
            .join('')
        : h;
    return [
      parseInt(v.slice(0, 2), 16),
      parseInt(v.slice(2, 4), 16),
      parseInt(v.slice(4, 6), 16),
    ];
  }

  private rgba(hex: string, a: number): string {
    const [r, g, b] = this.parse(hex);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }

  private mix(a: string, b: string, t: number): string {
    const [r1, g1, b1] = this.parse(a);
    const [r2, g2, b2] = this.parse(b);
    const k = Math.max(0, Math.min(1, t));
    return `rgb(${Math.round(r1 + (r2 - r1) * k)}, ${Math.round(
      g1 + (g2 - g1) * k,
    )}, ${Math.round(b1 + (b2 - b1) * k)})`;
  }
}
