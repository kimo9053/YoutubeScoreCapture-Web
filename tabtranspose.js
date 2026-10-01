/** Tab staff analysis, fret transposition and re-rendering for captured score strips. */

export const MAX_FRET = 24;

/** Open-string MIDI pitches, listed top tab line -> bottom tab line. */
const OPEN_PITCHES = {
  4: [43, 38, 33, 28], // G D A E
  5: [43, 38, 33, 28, 23], // G D A E B
  6: [64, 59, 55, 50, 45, 40] // guitar E B G D A E
};

/** Canvas font = `${weight} ${px}px ${family}` (weight must precede the size). */
const TAB_FONT = { weight: "bold", family: '"Times New Roman", Times, serif' };
const CHORD_FONT = { weight: "bold", family: '"Times New Roman", Times, serif' };

function fontString(font, px) {
  return `${font.weight} ${px.toFixed(1)}px ${font.family}`;
}

export function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

export function canvasFromImage(img) {
  const c = makeCanvas(img.naturalWidth || img.width, img.naturalHeight || img.height);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0);
  return c;
}

function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function pixelMasks(data, w, h) {
  const ink = new Uint8Array(w * h);
  const colored = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < w * h; i += 1, p += 4) {
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    const gray = (r * 299 + g * 587 + b * 114) / 1000;
    const sat = Math.max(r, g, b) - Math.min(r, g, b);
    if (sat >= 70) {
      if (gray < 190) colored[i] = 1;
    } else if (gray < 150) {
      ink[i] = 1;
    }
  }
  return { ink, colored };
}

/** Playback cursors are thin tinted vertical bars spanning most of the strip. */
function findCursorColumns(data, w, h) {
  const hit = new Uint8Array(w);
  for (let x = 0; x < w; x += 1) {
    let c = 0;
    for (let y = 0; y < h; y += 1) {
      const p = (y * w + x) * 4;
      if (Math.max(data[p], data[p + 1], data[p + 2]) - Math.min(data[p], data[p + 1], data[p + 2]) >= 35) c += 1;
    }
    if (c > h * 0.4) hit[x] = 1;
  }
  const out = new Uint8Array(w);
  for (let x = 0; x < w; x += 1) {
    if (hit[x] || hit[x - 1] || hit[x + 1]) out[x] = 1;
  }
  return out;
}

function rowCoverage(ink, w, h) {
  const cov = new Float32Array(h);
  for (let y = 0; y < h; y += 1) {
    let c = 0;
    const o = y * w;
    for (let x = 0; x < w; x += 1) c += ink[o + x];
    cov[y] = c / w;
  }
  return cov;
}

/** Row runs above minFrac coverage; `core` is the block around the peak row (>= 60% of peak). */
function rowRuns(cov, minFrac) {
  const h = cov.length;
  const runs = [];
  let start = -1;
  for (let y = 0; y <= h; y += 1) {
    const on = y < h && cov[y] > minFrac;
    if (on && start < 0) start = y;
    if (!on && start >= 0) {
      const y1 = y - 1;
      let py = start;
      for (let k = start; k <= y1; k += 1) if (cov[k] > cov[py]) py = k;
      const peak = cov[py];
      let c0 = py;
      let c1 = py;
      while (c0 > start && cov[c0 - 1] >= peak * 0.6) c0 -= 1;
      while (c1 < y1 && cov[c1 + 1] >= peak * 0.6) c1 += 1;
      runs.push({
        y0: start,
        y1,
        c: (start + y1) / 2,
        t: y1 - start + 1,
        peak,
        core: { y0: c0, y1: c1, c: (c0 + c1) / 2, t: c1 - c0 + 1 }
      });
      start = -1;
    }
  }
  return runs;
}

/** Equally spaced line chains; a stray line closer than the spacing is skipped, not a chain break. */
function equalSpacedChains(lines) {
  const chains = [];
  const okGap = (g) => g >= 6 && g <= 90;
  let cur = [];
  for (const ln of lines) {
    if (!cur.length) {
      cur = [ln];
      continue;
    }
    const gap = ln.c - cur[cur.length - 1].c;
    if (cur.length === 1) {
      if (okGap(gap)) cur.push(ln);
      else {
        chains.push(cur);
        cur = [ln];
      }
      continue;
    }
    const prev = cur[cur.length - 1].c - cur[cur.length - 2].c;
    const tol = Math.max(2, prev * 0.15);
    if (Math.abs(gap - prev) <= tol) {
      cur.push(ln);
    } else if (cur.length >= 3 && gap < prev - tol) {
      continue;
    } else {
      chains.push(cur);
      cur = okGap(gap) ? [cur[cur.length - 1], ln] : [ln];
    }
  }
  if (cur.length) chains.push(cur);
  return chains;
}

export function components(mask, w, h) {
  const label = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  const out = [];
  let next = 0;
  for (let start = 0; start < w * h; start += 1) {
    if (!mask[start] || label[start]) continue;
    next += 1;
    let sp = 0;
    stack[sp++] = start;
    label[start] = next;
    const pixels = [];
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    while (sp) {
      const i = stack[--sp];
      pixels.push(i);
      const x = i % w;
      const y = (i - x) / w;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy += 1) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (mask[j] && !label[j]) {
            label[j] = next;
            stack[sp++] = j;
          }
        }
      }
    }
    out.push({ x0, y0, x1, y1, pixels });
  }
  return out;
}

function averageColor(data, indices, fallback) {
  if (!indices.length) return fallback;
  let r = 0;
  let g = 0;
  let b = 0;
  for (const i of indices) {
    r += data[i * 4];
    g += data[i * 4 + 1];
    b += data[i * 4 + 2];
  }
  const n = indices.length;
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

/** Mean color of the darkest 40% of the pixels (glyph core rather than anti-aliased edge). */
export function darkColor(data, indices, fallback) {
  if (!indices.length) return fallback;
  const lum = (i) => data[i * 4] * 299 + data[i * 4 + 1] * 587 + data[i * 4 + 2] * 114;
  const sorted = [...indices].sort((a, b) => lum(a) - lum(b));
  return averageColor(data, sorted.slice(0, Math.max(1, Math.round(sorted.length * 0.4))), fallback);
}

/** Cut stem-like rows (only a couple of pixels wide) off the top and bottom of a component. */
function trimThinTails(comp, w, sp) {
  const rows = comp.y1 - comp.y0 + 1;
  const counts = new Int32Array(rows);
  for (const p of comp.pixels) counts[Math.floor(p / w) - comp.y0] += 1;
  const thin = Math.max(2, Math.round(sp * 0.15));
  let a = 0;
  let b = rows - 1;
  while (a < b && counts[a] <= thin) a += 1;
  while (b > a && counts[b] <= thin) b -= 1;
  if (a === 0 && b === rows - 1) return comp;
  const y0 = comp.y0 + a;
  const y1 = comp.y0 + b;
  const pixels = comp.pixels.filter((p) => {
    const y = Math.floor(p / w);
    return y >= y0 && y <= y1;
  });
  let x0 = Infinity;
  let x1 = -1;
  for (const p of pixels) {
    const x = p % w;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
  }
  return { x0, y0, x1, y1, pixels };
}

/**
 * Locate the tab staff, notation staff, chord band and candidate fret glyphs.
 * Returns null when no tab staff is found.
 */
export function analyzeStrip(canvas) {
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const { data } = ctx.getImageData(0, 0, w, h);
  const cursorCols = findCursorColumns(data, w, h);
  const cursors = [];
  for (let x = 0; x < w; x += 1) if (cursorCols[x]) cursors.push(x);
  eraseCursors(data, w, h, cursors);
  const { ink, colored } = pixelMasks(data, w, h);
  for (let i = 0; i < w * h; i += 1) if (colored[i]) ink[i] = 1;

  const thinMax = Math.max(3, Math.round(h / 90));
  const cov = rowCoverage(ink, w, h);
  const lines = rowRuns(cov, 0.25)
    .filter((r) => r.peak >= 0.4)
    .map((r) => r.core)
    .filter((r) => r.t <= thinMax);
  const chains = equalSpacedChains(lines).filter((c) => c.length >= 4);
  if (!chains.length) return null;
  let tabLines = chains[chains.length - 1];
  if (tabLines.length > 6) tabLines = tabLines.slice(-6);
  const ys = tabLines.map((l) => l.c);
  const sp = (ys[ys.length - 1] - ys[0]) / (ys.length - 1);
  const thick = Math.max(1, Math.round(median(tabLines.map((l) => l.t))));
  const tabTop = ys[0];
  const tabBottom = ys[ys.length - 1];

  const firsts = [];
  const lasts = [];
  const linePixels = [];
  for (const ln of tabLines) {
    const y = Math.round(ln.c);
    let first = -1;
    let last = -1;
    for (let x = 0; x < w; x += 1) {
      if (ink[y * w + x]) {
        if (first < 0) first = x;
        last = x;
        if (linePixels.length < 4000) linePixels.push(y * w + x);
      }
    }
    if (first >= 0) {
      firsts.push(first);
      lasts.push(last);
    }
  }
  const x0 = median(firsts);
  const x1 = median(lasts);
  const lineColor = averageColor(data, linePixels, [40, 40, 40]);

  let bgR = 0;
  let bgG = 0;
  let bgB = 0;
  let bgN = 0;
  for (let i = 0; i < w * h; i += 13) {
    if (!ink[i] && !colored[i]) {
      bgR += data[i * 4];
      bgG += data[i * 4 + 1];
      bgB += data[i * 4 + 2];
      bgN += 1;
    }
  }
  const bg = bgN ? [bgR / bgN, bgG / bgN, bgB / bgN].map(Math.round) : [255, 255, 255];

  const notationRuns = rowRuns(cov, 0.5).filter(
    (r) => r.c >= tabTop - 9 * sp && r.c <= tabTop - 1.6 * sp
  );
  let notation = null;
  if (notationRuns.length >= 2) {
    const top = notationRuns[0].y0;
    const bottom = notationRuns[notationRuns.length - 1].y1;
    const s1 = notationRuns.length >= 3 ? Math.max(4, (bottom - top) / 4) : sp * 0.66;
    notation = { top, bottom, s1 };
  }
  const chordBottom = notation ? notation.top - notation.s1 * 0.3 : tabTop - sp;
  const chordBand = chordBottom > 10 ? { y0: 0, y1: Math.floor(chordBottom) } : null;

  const barCols = [];
  const span = Math.round(tabBottom) - Math.round(tabTop) + 1;
  for (let x = Math.max(0, x0 - 2); x <= Math.min(w - 1, x1 + 2); x += 1) {
    let c = 0;
    for (let y = Math.round(tabTop); y <= Math.round(tabBottom); y += 1) c += ink[y * w + x];
    if (c >= span * 0.9) barCols.push(x);
  }

  const bandTop = Math.max(0, Math.floor(tabTop - sp * 0.8));
  const bandBot = Math.min(h - 1, Math.ceil(tabBottom + sp * 0.8));
  const bh = bandBot - bandTop + 1;
  const band = new Uint8Array(w * bh);
  for (let y = 0; y < bh; y += 1) {
    band.set(ink.subarray((y + bandTop) * w, (y + bandTop + 1) * w), y * w);
  }
  for (const ln of tabLines) {
    const r0 = ln.y0 - bandTop;
    const r1 = ln.y1 - bandTop;
    for (let x = 0; x < w; x += 1) {
      const above = r0 > 0 ? band[(r0 - 1) * w + x] : 0;
      const below = r1 + 1 < bh ? band[(r1 + 1) * w + x] : 0;
      if (!above && !below) {
        for (let r = r0; r <= r1; r += 1) band[r * w + x] = 0;
      }
    }
  }

  const blobs = [];
  const minX = x0 + sp * 2;
  for (const raw of components(band, w, bh)) {
    const comp = raw.y1 - raw.y0 + 1 > sp * 1.15 ? trimThinTails(raw, w, sp) : raw;
    const bw = comp.x1 - comp.x0 + 1;
    const bht = comp.y1 - comp.y0 + 1;
    if (bht < sp * 0.4 || bht > sp * 1.3 || bw > sp * 1.5) continue;
    if (comp.pixels.length < Math.max(6, sp * sp * 0.01)) continue;
    if (bw <= 2 && bht > sp * 0.6) continue;
    const cx = (comp.x0 + comp.x1) / 2;
    if (cx < minX) continue;
    const cy = (comp.y0 + comp.y1) / 2 + bandTop;
    let line = 0;
    for (let i = 1; i < ys.length; i += 1) {
      if (Math.abs(cy - ys[i]) < Math.abs(cy - ys[line])) line = i;
    }
    if (Math.abs(cy - ys[line]) >= sp * 0.45) continue;
    const mask = new Uint8Array(bw * bht);
    const srcIdx = [];
    for (const p of comp.pixels) {
      const px = p % w;
      const py = (p - px) / w;
      mask[(py - comp.y0) * bw + (px - comp.x0)] = 1;
      srcIdx.push((py + bandTop) * w + px);
    }
    blobs.push({
      x0: comp.x0,
      y0: comp.y0 + bandTop,
      x1: comp.x1,
      y1: comp.y1 + bandTop,
      w: bw,
      h: bht,
      line,
      mask,
      color: darkColor(data, srcIdx, [20, 20, 20])
    });
  }
  blobs.sort((a, b) => a.line - b.line || a.x0 - b.x0);


  return {
    w,
    h,
    tab: { ys, sp, thick, x0, x1, top: tabTop, bottom: tabBottom, lines: tabLines, lineColor, barCols },
    notation,
    chordBand,
    blobs,
    cursors,
    bg,
    masks: { ink, colored }
  };
}

/** Group recognized glyphs on the same line into multi-digit fret numbers. */
export function buildNotes(analysis) {
  const { sp } = analysis.tab;
  const notes = [];
  const ignored = [];
  const digits = analysis.blobs.filter((b) => b.kind === "digit");
  for (const b of analysis.blobs) if (b.kind !== "digit") ignored.push(b);

  let cur = null;
  const flush = () => {
    if (!cur) return;
    const text = cur.parts.map((p) => p.text).join("");
    notes.push({
      line: cur.line,
      x0: cur.x0,
      y0: cur.y0,
      x1: cur.x1,
      y1: cur.y1,
      text,
      value: Number.parseInt(text, 10),
      conf: Math.min(...cur.parts.map((p) => p.conf)),
      suspect: cur.parts.some((p) => p.suspect),
      color: cur.parts[0].color
    });
    cur = null;
  };
  for (const b of digits) {
    const joinable =
      cur &&
      cur.line === b.line &&
      b.x0 - cur.x1 <= sp * 0.3 &&
      cur.parts.reduce((n, p) => n + p.text.length, 0) + b.text.length <= 2;
    if (joinable) {
      cur.parts.push(b);
      cur.x1 = Math.max(cur.x1, b.x1);
      cur.y0 = Math.min(cur.y0, b.y0);
      cur.y1 = Math.max(cur.y1, b.y1);
    } else {
      flush();
      cur = { line: b.line, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, parts: [b] };
    }
  }
  flush();

  notes.forEach((n, i) => {
    n.id = i;
    n.status = n.value > MAX_FRET || n.conf < 70 || n.suspect ? "check" : "ok";
  });
  return { notes, ignored };
}

export function targetOpenPitches(lineCount, allowLowB) {
  if (lineCount === 6) return OPEN_PITCHES[6];
  if (lineCount === 5 || allowLowB) return OPEN_PITCHES[5];
  return OPEN_PITCHES[4];
}

export function sourceOpenPitches(lineCount) {
  return OPEN_PITCHES[lineCount] || OPEN_PITCHES[4];
}

/**
 * Move a fret by `shift` semitones, keeping the same string when possible,
 * otherwise the nearest string that can play it, otherwise an octave fallback.
 */
export function transposeFret(line, fret, shift, srcOpen, dstOpen) {
  const pitch = srcOpen[line] + fret + shift;
  const fits = (p, i) => p - dstOpen[i] >= 0 && p - dstOpen[i] <= MAX_FRET;
  const search = (p) => {
    if (fits(p, line)) return line;
    const order = [];
    for (let d = 1; d < dstOpen.length; d += 1) {
      const down = line + d;
      const up = line - d;
      if (p - dstOpen[line] < 0) {
        if (down < dstOpen.length) order.push(down);
        if (up >= 0) order.push(up);
      } else {
        if (up >= 0) order.push(up);
        if (down < dstOpen.length) order.push(down);
      }
    }
    return order.find((i) => fits(p, i)) ?? -1;
  };
  let target = search(pitch);
  if (target >= 0) return { line: target, fret: pitch - dstOpen[target], octave: 0 };
  for (const oct of [12, -12, 24, -24]) {
    target = search(pitch + oct);
    if (target >= 0) return { line: target, fret: pitch + oct - dstOpen[target], octave: oct };
  }
  return null;
}

const SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
const NOTE_INDEX = {
  C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, Fb: 4, "E#": 5, F: 5, "F#": 6, Gb: 6,
  G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11, Cb: 11, "B#": 0
};

export const CHORD_RE =
  /^([A-G])([#b]?)((?:maj|min|m|M|dim|aug|sus|add|o|\+|-|[0-9]|\(|\)|[#b](?=[0-9]))*)(?:\/([A-G])([#b]?))?$/;

export function normalizeChordText(text) {
  return String(text)
    .trim()
    .replace(/[♯＃]/g, "#")
    .replace(/♭/g, "b")
    .replace(/[°º]/g, "o")
    .replace(/^[|.,;:'"`]+/g, "")
    .replace(/[|.,;:'"`]+$/g, "");
}

export function isChordText(text) {
  return CHORD_RE.test(normalizeChordText(text));
}

export function transposeChord(text, shift, useFlats) {
  const m = normalizeChordText(text).match(CHORD_RE);
  if (!m) return null;
  const names = useFlats ? FLAT_NAMES : SHARP_NAMES;
  const move = (root, acc) => names[(((NOTE_INDEX[root + acc] ?? 0) + shift) % 12 + 12) % 12];
  let out = move(m[1], m[2]) + (m[3] || "");
  if (m[4]) out += `/${move(m[4], m[5] || "")}`;
  return out;
}

export function noteName(pitch, useFlats) {
  return (useFlats ? FLAT_NAMES : SHARP_NAMES)[((pitch % 12) + 12) % 12];
}

/** "C#/Db" for black keys, "D" otherwise. */
export function noteNameBoth(pitch) {
  const s = noteName(pitch, false);
  const f = noteName(pitch, true);
  return s === f ? s : `${s}/${f}`;
}

export function countAccidentals(chords, shift, useFlats) {
  let n = 0;
  for (const c of chords) {
    const t = transposeChord(c, shift, useFlats);
    if (t) n += (t.match(/[#b](?![0-9])/g) || []).length;
  }
  return n;
}

function fontMetrics(ctx, font, sample) {
  ctx.font = fontString(font, 100);
  const m = ctx.measureText(sample);
  const asc = m.actualBoundingBoxAscent || 66;
  const desc = m.actualBoundingBoxDescent || 0;
  return { ratio: (asc + desc) / 100 };
}

function sampleBg(data, w, h, masks, x0, y0, x1, y1, fallback) {
  const pad = 3;
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = Math.max(0, y0 - pad); y <= Math.min(h - 1, y1 + pad); y += 1) {
    for (let x = Math.max(0, x0 - pad); x <= Math.min(w - 1, x1 + pad); x += 1) {
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) continue;
      const i = y * w + x;
      if (masks.ink[i] || masks.colored[i]) continue;
      r += data[i * 4];
      g += data[i * 4 + 1];
      b += data[i * 4 + 2];
      n += 1;
    }
  }
  return n ? [r / n, g / n, b / n].map(Math.round) : fallback;
}

function fillRectPixels(data, w, h, x0, y0, x1, y1, rgb) {
  for (let y = Math.max(0, y0); y <= Math.min(h - 1, y1); y += 1) {
    for (let x = Math.max(0, x0); x <= Math.min(w - 1, x1); x += 1) {
      const p = (y * w + x) * 4;
      data[p] = rgb[0];
      data[p + 1] = rgb[1];
      data[p + 2] = rgb[2];
      data[p + 3] = 255;
    }
  }
}

const lum = (d, p) => (d[p] * 299 + d[p + 1] * 587 + d[p + 2] * 114) / 1000;

/**
 * Paint out cursor bars in place. Tinted pixels darker than the cursor itself are ink seen
 * through it and become neutral; lighter ones take the brighter side neighbour, or a blend
 * of both sides when a dark line runs straight through.
 */
function eraseCursors(d, w, h, cursors) {
  for (const [ca, cb] of columnRuns(cursors)) {
    const xa = Math.max(1, ca - 4);
    const xb = Math.min(w - 2, cb + 4);
    for (let y = 0; y < h; y += 1) {
      const pl = (y * w + xa - 1) * 4;
      const pr = (y * w + xb + 1) * 4;
      const darkL = lum(d, pl) < 150;
      const darkR = lum(d, pr) < 150;
      const light = lum(d, pl) >= lum(d, pr) ? pl : pr;
      for (let x = xa; x <= xb; x += 1) {
        const p = (y * w + x) * 4;
        const mn = Math.min(d[p], d[p + 1], d[p + 2]);
        if (Math.max(d[p], d[p + 1], d[p + 2]) - mn <= 10) continue;
        if (lum(d, p) < 110) {
          d[p] = mn;
          d[p + 1] = mn;
          d[p + 2] = mn;
        } else if (darkL && darkR) {
          const t = (x - xa + 1) / (xb - xa + 2);
          for (let k = 0; k < 3; k += 1) d[p + k] = Math.round(d[pl + k] * (1 - t) + d[pr + k] * t);
        } else {
          for (let k = 0; k < 3; k += 1) d[p + k] = d[light + k];
        }
      }
    }
  }
}

/** Copy of the strip with playback cursors painted out. */
export function cursorFreeCanvas(canvas, analysis) {
  const out = makeCanvas(canvas.width, canvas.height);
  const ctx = out.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0);
  if (!analysis.cursors.length) return out;
  const img = ctx.getImageData(0, 0, out.width, out.height);
  eraseCursors(img.data, out.width, out.height, analysis.cursors);
  ctx.putImageData(img, 0, 0);
  return out;
}

function columnRuns(xs) {
  const runs = [];
  for (const x of xs) {
    const last = runs[runs.length - 1];
    if (last && x === last[1] + 1) last[1] = x;
    else runs.push([x, x]);
  }
  return runs;
}

function rgbCss(rgb) {
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

/**
 * Draw the transposed strip.
 * notes: [{x0,y0,x1,y1,line, target:{line,fret}|null, color}]
 * chords: [{x0,y0,x1,y1,newText}]
 * opts: { dimNotation, addLowString, tuningLabel: {line, text} } — tuningLabel marks a retuned string.
 */
export function renderStrip(srcCanvas, analysis, notes, chords, opts = {}) {
  const { w, h, tab, masks, bg } = analysis;
  const { sp, ys, thick, lineColor } = tab;
  const srcCtx = srcCanvas.getContext("2d", { willReadFrequently: true });
  const src = srcCtx.getImageData(0, 0, w, h);
  eraseCursors(src.data, w, h, analysis.cursors);
  const work = new ImageData(new Uint8ClampedArray(src.data), w, h);
  const d = work.data;
  const half = Math.floor((thick - 1) / 2);

  const drawLineSpan = (lineIdx, xa, xb) => {
    const ln = tab.lines[lineIdx];
    fillRectPixels(d, w, h, xa, ln.y0, xb, ln.y1, lineColor);
  };

  const active = notes.filter((n) => n.target);
  for (const n of active) {
    const color = sampleBg(src.data, w, h, masks, n.x0 - 1, n.y0 - 1, n.x1 + 1, n.y1 + 1, bg);
    fillRectPixels(d, w, h, n.x0 - 1, n.y0 - 1, n.x1 + 1, n.y1 + 1, color);
    const ln = tab.lines[n.line];
    const row = Math.round(ln.c);
    const limit = Math.round(sp * 0.7);
    let left = n.x0 - 1;
    for (let k = 0; k < limit && left > tab.x0; k += 1) {
      if (masks.ink[row * w + left - 1]) break;
      left -= 1;
    }
    let right = n.x1 + 1;
    for (let k = 0; k < limit && right < tab.x1; k += 1) {
      if (masks.ink[row * w + right + 1]) break;
      right += 1;
    }
    drawLineSpan(n.line, left, right);
  }

  const chordEdits = chords.filter((c) => c.newText);
  for (const c of chordEdits) {
    const color = sampleBg(src.data, w, h, masks, c.x0 - 2, c.y0 - 2, c.x1 + 2, c.y1 + 2, bg);
    fillRectPixels(d, w, h, c.x0 - 2, c.y0 - 2, c.x1 + 2, c.y1 + 2, color);
  }

  const workCanvas = makeCanvas(w, h);
  const wctx = workCanvas.getContext("2d");
  wctx.putImageData(work, 0, 0);

  if (opts.dimNotation && analysis.notation) {
    const { top, bottom, s1 } = analysis.notation;
    const y0 = Math.max(0, Math.floor(top - s1 * 1.2));
    const y1 = Math.min(Math.floor(tab.top - sp * 0.9), Math.ceil(bottom + s1 * 1.4));
    if (y1 > y0) {
      wctx.fillStyle = `rgba(${bg[0]}, ${bg[1]}, ${bg[2]}, 0.7)`;
      wctx.fillRect(0, y0, w, y1 - y0);
    }
  }

  if (chordEdits.length) {
    wctx.textAlign = "left";
    wctx.textBaseline = "alphabetic";
    for (const c of chordEdits) {
      const ref = c.text || "B";
      const px = Math.max(8, (c.y1 - c.y0 + 1) / fontMetrics(wctx, CHORD_FONT, ref).ratio);
      wctx.font = fontString(CHORD_FONT, px);
      const descent = wctx.measureText(ref).actualBoundingBoxDescent || 0;
      wctx.fillStyle = rgbCss(c.color || [17, 17, 17]);
      wctx.fillText(c.newText, c.x0, c.y1 - descent);
    }
  }

  const extra = opts.addLowString && tab.lines.length < 5 ? Math.round(sp) : 0;
  const cutY = Math.round(tab.bottom + sp * 0.5);
  const out = makeCanvas(w, h + extra);
  const octx = out.getContext("2d");
  if (extra) {
    octx.drawImage(workCanvas, 0, 0, w, cutY, 0, 0, w, cutY);
    octx.drawImage(workCanvas, 0, cutY, w, 1, 0, cutY, w, extra);
    octx.drawImage(workCanvas, 0, cutY, w, h - cutY, 0, cutY + extra, w, h - cutY);
  } else {
    octx.drawImage(workCanvas, 0, 0);
  }

  const lowY = tab.bottom + sp;
  if (extra) {
    octx.fillStyle = rgbCss(lineColor);
    octx.fillRect(tab.x0, Math.round(lowY) - half, tab.x1 - tab.x0 + 1, thick);
    for (const x of tab.barCols) {
      octx.fillRect(x, Math.round(tab.bottom), 1, Math.round(lowY) - Math.round(tab.bottom) + half + 1);
    }
  }

  if (active.length) {
    const digitH = median(active.map((n) => n.y1 - n.y0 + 1)) || sp * 0.7;
    const tm = fontMetrics(octx, TAB_FONT, "0");
    const px = digitH / tm.ratio;
    octx.font = fontString(TAB_FONT, px);
    octx.textAlign = "center";
    octx.textBaseline = "alphabetic";
    for (const n of active) {
      const text = String(n.target.fret);
      const y = n.target.line < ys.length ? ys[n.target.line] : lowY;
      const cx = (n.x0 + n.x1) / 2;
      const m = octx.measureText(text);
      const tw = m.width + px * 0.18;
      const srcY = Math.min(h - 1, Math.round(y));
      const kb = sampleBg(src.data, w, h, masks, Math.round(cx - tw / 2), srcY - 1, Math.round(cx + tw / 2), srcY + 1, bg);
      octx.fillStyle = rgbCss(kb);
      octx.fillRect(Math.round(cx - tw / 2), Math.round(y - digitH / 2) - 1, Math.ceil(tw), Math.ceil(digitH) + 2);
      const asc = m.actualBoundingBoxAscent || digitH;
      const desc = m.actualBoundingBoxDescent || 0;
      octx.fillStyle = rgbCss(n.color || [20, 20, 20]);
      octx.fillText(text, cx, y + (asc - desc) / 2);
    }
  }

  if (opts.tuningLabel) {
    const { line, text } = opts.tuningLabel;
    const y = line < ys.length ? ys[line] : lowY;
    octx.font = `bold ${Math.max(10, sp * 0.62).toFixed(1)}px "Malgun Gothic", "Segoe UI", sans-serif`;
    octx.textAlign = "left";
    octx.textBaseline = "top";
    octx.fillStyle = "#c62828";
    octx.fillText(text, tab.x0 + 2, Math.round(y + sp * 0.35));
  }

  return out;
}
