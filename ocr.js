/** OCR helpers: fret glyph clustering + recognition, chord name recognition (Tesseract.js). */

import { components, cursorFreeCanvas, isChordText, makeCanvas, normalizeChordText } from "./tabtranspose.js";

const TESSERACT_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";

let workerPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.Tesseract) {
      resolve();
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("OCR 엔진을 불러오지 못했습니다. 인터넷 연결을 확인하세요."));
    document.head.appendChild(s);
  });
}

export function getOcrWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      await loadScript(TESSERACT_URL);
      return window.Tesseract.createWorker("eng", 1);
    })().catch((err) => {
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

const NW = 14;
const NH = 20;

function normalizeGlyph(blob) {
  const scale = Math.min(NW / blob.w, NH / blob.h);
  const ox = (NW - blob.w * scale) / 2;
  const oy = (NH - blob.h * scale) / 2;
  const out = new Float32Array(NW * NH);
  for (let ty = 0; ty < NH; ty += 1) {
    for (let tx = 0; tx < NW; tx += 1) {
      let hit = 0;
      for (let sy = 0; sy < 3; sy += 1) {
        for (let sx = 0; sx < 3; sx += 1) {
          const x = Math.floor((tx + (sx + 0.5) / 3 - ox) / scale);
          const y = Math.floor((ty + (sy + 0.5) / 3 - oy) / scale);
          if (x >= 0 && y >= 0 && x < blob.w && y < blob.h && blob.mask[y * blob.w + x]) hit += 1;
        }
      }
      out[ty * NW + tx] = hit / 9;
    }
  }
  return out;
}

function glyphDistance(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

/** Group visually identical glyphs so each shape is OCR'd once. */
export function clusterGlyphs(blobs) {
  const clusters = [];
  for (const blob of blobs) {
    const vec = normalizeGlyph(blob);
    const aspect = blob.w / blob.h;
    let best = null;
    let bestD = Infinity;
    for (const c of clusters) {
      if (Math.abs(c.aspect - aspect) / Math.max(c.aspect, aspect) > 0.2) continue;
      if (Math.abs(c.h - blob.h) / Math.max(c.h, blob.h) > 0.25) continue;
      const dist = glyphDistance(c.vec, vec);
      if (dist < bestD) {
        bestD = dist;
        best = c;
      }
    }
    if (best && bestD < 0.1) best.members.push(blob);
    else clusters.push({ vec, aspect, h: blob.h, rep: blob, members: [blob] });
  }
  return clusters;
}

function glyphCanvas(blob) {
  const small = makeCanvas(blob.w, blob.h);
  const sctx = small.getContext("2d");
  const img = sctx.createImageData(blob.w, blob.h);
  for (let i = 0; i < blob.mask.length; i += 1) {
    const v = blob.mask[i] ? 0 : 255;
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  sctx.putImageData(img, 0, 0);
  const scale = Math.max(2, Math.round(56 / blob.h));
  const pad = Math.round(blob.h * scale * 0.6);
  const big = makeCanvas(blob.w * scale + pad * 2, blob.h * scale + pad * 2);
  const bctx = big.getContext("2d");
  bctx.fillStyle = "#fff";
  bctx.fillRect(0, 0, big.width, big.height);
  bctx.imageSmoothingEnabled = true;
  bctx.drawImage(small, pad, pad, blob.w * scale, blob.h * scale);
  return big;
}

const TEMPLATE_FONTS = [
  'bold 64px "Times New Roman", Times, serif',
  '64px "Times New Roman", Times, serif',
  "bold 64px Georgia, serif",
  "bold 64px Arial, sans-serif",
  "64px Arial, sans-serif"
];

let fontTemplates = null;

function maskFromCanvas(canvas) {
  const { width: w, height: h } = canvas;
  const { data } = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h);
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (data[(y * w + x) * 4] < 128) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  const mask = new Uint8Array(bw * bh);
  for (let y = 0; y < bh; y += 1) {
    for (let x = 0; x < bw; x += 1) mask[y * bw + x] = data[((y + y0) * w + x + x0) * 4] < 128 ? 1 : 0;
  }
  return { w: bw, h: bh, mask };
}

/** Rendered digits 0-9 in common score fonts, used when the score has no confident sample. */
function getFontTemplates() {
  if (fontTemplates) return fontTemplates;
  fontTemplates = [];
  const c = makeCanvas(96, 96);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  for (const font of TEMPLATE_FONTS) {
    for (let d = 0; d <= 9; d += 1) {
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, 96, 96);
      ctx.fillStyle = "#000";
      ctx.font = font;
      ctx.textBaseline = "middle";
      ctx.fillText(String(d), 20, 48);
      const g = maskFromCanvas(c);
      if (g) fontTemplates.push({ digit: String(d), vec: normalizeGlyph(g) });
    }
  }
  return fontTemplates;
}

/** Best digit and how far ahead it is of the best different digit. */
function nearestTemplate(vec, templates) {
  const perDigit = new Map();
  for (const t of templates) {
    const dist = glyphDistance(vec, t.vec);
    if (!perDigit.has(t.digit) || dist < perDigit.get(t.digit)) perDigit.set(t.digit, dist);
  }
  const ranked = [...perDigit.entries()].sort((a, b) => a[1] - b[1]);
  if (!ranked.length) return null;
  const [digit, dist] = ranked[0];
  const margin = ranked.length > 1 ? ranked[1][1] - dist : 1;
  return { digit, dist, margin };
}

const SURE_DIST = 0.08;
const MATCH_DIST = 0.22;
const MATCH_MARGIN = 0.05;
const OVERRIDE_DIST = 0.05;

function decisive(m) {
  return m && (m.dist < SURE_DIST || (m.dist < MATCH_DIST && m.margin >= MATCH_MARGIN));
}

/**
 * Recognize fret glyphs. Sets blob.kind ("digit" | "other"), blob.text, blob.conf, blob.suspect.
 * Single-digit shapes are matched against confident samples from the same score first,
 * then rendered font digits; Tesseract decides the rest.
 */
export async function recognizeFretGlyphs(blobs, onProgress) {
  const worker = await getOcrWorker();
  const clusters = clusterGlyphs(blobs);
  for (let i = 0; i < clusters.length; i += 1) {
    const c = clusters[i];
    const wide = c.aspect > 0.9;
    await worker.setParameters({
      tessedit_pageseg_mode: wide ? "8" : "10",
      tessedit_char_whitelist: "0123456789"
    });
    const { data } = await worker.recognize(glyphCanvas(c.rep));
    c.text = (data.text || "").replace(/\s+/g, "");
    c.conf = Math.round(data.confidence || 0);
    onProgress?.(i + 1, clusters.length);
  }

  const own = clusters
    .filter((c) => c.aspect <= 0.9 && /^\d$/.test(c.text) && c.conf >= 85)
    .map((c) => ({ digit: c.text, vec: c.vec }));
  const fonts = getFontTemplates();
  for (const c of clusters) {
    if (c.aspect > 0.9) continue;
    const tessDigit = /^\d$/.test(c.text) && c.conf >= 70;
    const mine = nearestTemplate(c.vec, own);
    const font = nearestTemplate(c.vec, fonts);
    if (tessDigit) {
      if (mine && mine.digit !== c.text && mine.dist < OVERRIDE_DIST) c.text = mine.digit;
      continue;
    }
    if (decisive(mine)) {
      c.text = mine.digit;
      c.conf = mine.dist < 0.16 ? 85 : 65;
    } else if (decisive(font)) {
      c.text = font.digit;
      c.conf = 60;
    }
  }

  const digitHeights = [];
  for (const c of clusters) {
    if (/^\d{1,2}$/.test(c.text)) for (const m of c.members) digitHeights.push(m.h);
  }
  digitHeights.sort((a, b) => a - b);
  const typicalH = digitHeights[Math.floor(digitHeights.length / 2)] || 0;

  for (const c of clusters) {
    const isDigit = /^\d{1,2}$/.test(c.text);
    for (const m of c.members) {
      m.text = c.text;
      m.conf = c.conf;
      m.kind = isDigit ? "digit" : "other";
      m.suspect = isDigit && typicalH > 0 && Math.abs(m.h - typicalH) > typicalH * 0.25;
    }
  }
  return clusters.length;
}

/** Recognize chord names in the band above the notation staff. */
export async function recognizeChords(stripCanvas, analysis) {
  const band = analysis.chordBand;
  if (!band) return [];
  const { w, masks } = analysis;
  let inkCount = 0;
  for (let y = band.y0; y <= band.y1; y += 1) {
    for (let x = 0; x < w; x += 1) inkCount += masks.ink[y * w + x];
  }
  if (inkCount < 30) return [];

  const worker = await getOcrWorker();
  const clean = cursorFreeCanvas(stripCanvas, analysis);
  const { sp } = analysis.tab;
  const chords = [];
  for (const word of bandWords(analysis, band)) {
    const first = await readChordWord(worker, clean, word, sp);
    let found = first.chord;
    const lead = word.parts[0];
    const thinLead = word.parts.length >= 3 && lead.x1 - lead.x0 + 1 <= (lead.y1 - lead.y0 + 1) * 0.5;
    if (!found && (thinLead || /^[|!Il[\]]*\d\./.test(first.raw))) {
      for (let drop = 1; drop <= Math.min(3, word.parts.length - 1) && !found; drop += 1) {
        const rest = word.parts.slice(drop);
        found = (await readChordWord(worker, clean, { ...boundsOf(rest), parts: rest }, sp)).chord;
      }
    }
    if (found) chords.push(found);
  }
  return consistentChords(chords, band, analysis.tab.sp);
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** Drop chords cut off at the strip top and stray hits off the common chord baseline. */
function consistentChords(chords, band, sp) {
  if (!chords.length) return chords;
  const medH = median(chords.map((c) => c.y1 - c.y0 + 1));
  const medY1 = median(chords.map((c) => c.y1));
  return chords.filter((c) => {
    const h = c.y1 - c.y0 + 1;
    if (c.y0 <= band.y0 && h < medH * 0.8) return false;
    return chords.length < 2 || Math.abs(c.y1 - medY1) <= sp * 0.6;
  });
}

const CHORD_CHARS = "ABCDEFGMabdgijmnsu#0123456789/+-o";

/**
 * OCR one word box; retry with a chord-only alphabet for one- or two-glyph words that did not parse.
 * Returns { chord|null, raw } where raw is the unrestricted OCR text.
 */
async function readChordWord(worker, canvas, box, sp) {
  const tries = [{ psm: "7", wl: "", minConf: 50, px: 48 }];
  if (box.parts && box.parts.length <= 2) tries.push({ psm: "7", wl: CHORD_CHARS, minConf: 70, px: 32 });
  const bh = box.y1 - box.y0 + 1;
  if (box.parts && box.parts.length === 1 && bh >= sp * 0.95 && bh <= sp * 1.4) {
    tries.push({ psm: "10", wl: "ABCDEFG", minConf: 75, px: 64 });
  }
  let raw = "";
  for (const t of tries) {
    await worker.setParameters({ tessedit_pageseg_mode: t.psm, tessedit_char_whitelist: t.wl });
    const { data } = await worker.recognize(wordCanvas(canvas, box, t.px));
    const read = (data.text || "").replace(/\s+/g, "");
    if (!t.wl) raw = read;
    const text = normalizeChordText(read);
    const conf = Math.round(data.confidence || 0);
    if (text && isChordText(text) && conf >= t.minConf) {
      return { chord: { text, conf, x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1 }, raw };
    }
  }
  return { chord: null, raw };
}

function boundsOf(parts) {
  return {
    x0: Math.min(...parts.map((p) => p.x0)),
    y0: Math.min(...parts.map((p) => p.y0)),
    x1: Math.max(...parts.map((p) => p.x1)),
    y1: Math.max(...parts.map((p) => p.y1))
  };
}

/**
 * Split the chord band into words: ink components joined while the horizontal gap is small.
 * Long horizontal strokes (volta brackets) are removed first so they do not glue words together.
 */
function bandWords(analysis, band) {
  const { w, masks } = analysis;
  const bh = band.y1 - band.y0 + 1;
  const sub = masks.ink.slice(band.y0 * w, (band.y1 + 1) * w);
  const minRun = Math.max(30, Math.round(analysis.tab.sp * 2.5));
  for (let y = 0; y < bh; y += 1) {
    let x = 0;
    while (x < w) {
      if (!sub[y * w + x]) {
        x += 1;
        continue;
      }
      let e = x;
      while (e < w && sub[y * w + e]) e += 1;
      if (e - x >= minRun) sub.fill(0, y * w + x, y * w + e);
      x = e;
    }
  }
  const comps = components(sub, w, bh)
    .filter((c) => c.pixels.length >= 4)
    .map((c) => ({ x0: c.x0, y0: c.y0 + band.y0, x1: c.x1, y1: c.y1 + band.y0 }))
    .sort((a, b) => a.x0 - b.x0);
  const words = [];
  for (const c of comps) {
    let host = null;
    let hostOverlap = -Infinity;
    for (let i = words.length - 1; i >= 0 && i >= words.length - 6; i -= 1) {
      const wd = words[i];
      const overlap = Math.min(wd.y1, c.y1) - Math.max(wd.y0, c.y0);
      const gap = c.x0 - wd.x1;
      if (overlap >= -2 && gap <= Math.max(4, (wd.y1 - wd.y0 + 1) * 0.45) && overlap > hostOverlap) {
        host = wd;
        hostOverlap = overlap;
      }
    }
    if (host) {
      host.parts.push(c);
      Object.assign(host, boundsOf(host.parts));
    } else {
      words.push({ ...c, parts: [c] });
    }
  }
  return words.filter((wd) => wd.y1 - wd.y0 + 1 >= 8 && wd.x1 - wd.x0 + 1 <= w * 0.2);
}

/** Word crop scaled to `target` px tall, padded and binarized for Tesseract. */
function wordCanvas(stripCanvas, word, target = 48) {
  const bw = word.x1 - word.x0 + 1;
  const bh = word.y1 - word.y0 + 1;
  const scale = Math.max(1, target / bh);
  const pad = Math.round(bh * scale * 0.4);
  const c = makeCanvas(Math.round(bw * scale) + pad * 2, Math.round(bh * scale) + pad * 2);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(stripCanvas, word.x0, word.y0, bw, bh, pad, pad, bw * scale, bh * scale);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let p = 0; p < d.length; p += 4) {
    const v = d[p] * 0.299 + d[p + 1] * 0.587 + d[p + 2] * 0.114 < 150 ? 0 : 255;
    d[p] = v;
    d[p + 1] = v;
    d[p + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
