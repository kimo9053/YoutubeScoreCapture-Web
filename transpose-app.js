import { extractPdfImages } from "./pdfread.js";
import { getOcrWorker, recognizeChords, recognizeFretGlyphs } from "./ocr.js";
import { buildPdf, downloadBlob } from "./pdf.js";
import {
  MAX_FRET,
  analyzeStrip,
  buildNotes,
  countAccidentals,
  isChordText,
  makeCanvas,
  normalizeChordText,
  noteName,
  noteNameBoth,
  renderStrip,
  sourceOpenPitches,
  targetOpenPitches,
  transposeChord,
  transposeFret
} from "./tabtranspose.js";

const $ = (id) => document.getElementById(id);

const els = {
  fileInput: $("fileInput"),
  keyShift: $("keyShift"),
  keyShiftLabel: $("keyShiftLabel"),
  optDim: $("optDim"),
  optChords: $("optChords"),
  optLowB: $("optLowB"),
  btnAnalyze: $("btnAnalyze"),
  btnPdf: $("btnPdf"),
  strips: $("strips"),
  message: $("message"),
  sumStrips: $("sumStrips"),
  sumNotes: $("sumNotes"),
  sumCheck: $("sumCheck"),
  sumUnplaced: $("sumUnplaced"),
  sumIgnored: $("sumIgnored"),
  sumChords: $("sumChords"),
  sumLowB: $("sumLowB"),
  sumTuning: $("sumTuning"),
  btnTuning: $("btnTuning"),
  tuneDialog: $("tuneDialog"),
  tuneTitle: $("tuneTitle"),
  tuneText: $("tuneText"),
  tuneOptions: $("tuneOptions"),
  tuneNo: $("tuneNo")
};

/** Furthest the lowest string is offered to be tuned down, in semitones. */
const MAX_DROP = 2;
const TUNE_WARNING = "튜닝을 하더라도 옥타브를 이동해야합니다. 조정 키 값을 줄여주세요.";
const NO_TUNE_WARNING = "튜닝하지 않으면 표시할 수 없는 음이 있습니다. 조정 키 값을 줄여주세요.";
const TUNE_ASK_DELAY = 700;

const COLORS = {
  ok: "#2e7d32",
  check: "#f57c00",
  ignored: "#9e9e9e",
  chord: "#8e24aa"
};

const state = {
  baseName: "score",
  strips: [],
  analyzed: false,
  busy: false,
  needLowB: false,
  useFlats: false,
  /** null = no tuning can help; otherwise { key, need, options, choice: undefined (not asked) | null (no) | pitch } */
  tuning: null,
  /** set when some notes have no string even with the allowed tunings: { key, shown } */
  keyWarning: null,
  unplaced: 0,
  askTimer: 0
};

function setMessage(text, isError = false) {
  els.message.textContent = text;
  els.message.classList.toggle("error", isError);
}

function keyShift() {
  const v = Math.round(Number(els.keyShift.value) || 0);
  return Math.max(-12, Math.min(12, v));
}

function spelling() {
  return document.querySelector('input[name="spelling"]:checked')?.value || "auto";
}

function viewMode() {
  return document.querySelector('input[name="view"]:checked')?.value || "review";
}

function renderUi() {
  const k = keyShift();
  els.keyShiftLabel.textContent = k > 0 ? `+${k}` : String(k);
  els.btnAnalyze.disabled = state.busy || !state.strips.length;
  els.btnPdf.disabled = state.busy || !state.analyzed;
  els.fileInput.disabled = state.busy;
}

async function canvasFromBlob(blob) {
  const bmp = await createImageBitmap(blob);
  const c = makeCanvas(bmp.width, bmp.height);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0);
  bmp.close?.();
  return c;
}

async function loadFiles(files) {
  const list = [...files];
  if (!list.length) return;
  state.busy = true;
  renderUi();
  try {
    const strips = [];
    for (const file of list) {
      if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
        const images = await extractPdfImages(await file.arrayBuffer());
        for (const img of images) strips.push({ canvas: await canvasFromBlob(img.blob) });
      } else if (file.type.startsWith("image/")) {
        strips.push({ canvas: await canvasFromBlob(file) });
      }
    }
    if (!strips.length) throw new Error("PDF 안에서 악보 이미지를 찾지 못했습니다.");
    state.baseName = list[0].name.replace(/\.[^.]+$/, "") || "score";
    state.strips = strips;
    state.analyzed = false;
    setMessage(`악보 조각 ${strips.length}개를 불러왔습니다. 인식 시작을 누르세요.`);
    drawAll();
  } catch (err) {
    setMessage(err.message || String(err), true);
  } finally {
    state.busy = false;
    renderUi();
  }
}

function inkColor(canvas, box) {
  const x0 = Math.max(0, box.x0);
  const y0 = Math.max(0, box.y0);
  const w = Math.max(1, Math.min(canvas.width, box.x1 + 1) - x0);
  const h = Math.max(1, Math.min(canvas.height, box.y1 + 1) - y0);
  const { data } = canvas.getContext("2d", { willReadFrequently: true }).getImageData(x0, y0, w, h);
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let p = 0; p < data.length; p += 4) {
    const gray = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
    if (gray < 120) {
      r += data[p];
      g += data[p + 1];
      b += data[p + 2];
      n += 1;
    }
  }
  return n ? [r / n, g / n, b / n].map(Math.round) : [17, 17, 17];
}

async function analyze() {
  if (!state.strips.length) return;
  state.busy = true;
  renderUi();
  try {
    setMessage("타브 줄과 숫자 위치를 찾는 중…");
    await new Promise((r) => setTimeout(r, 0));
    let missing = 0;
    for (const s of state.strips) {
      s.analysis = analyzeStrip(s.canvas);
      s.notes = [];
      s.ignored = [];
      s.chords = [];
      if (!s.analysis) missing += 1;
    }

    setMessage("OCR 엔진 불러오는 중… (처음 한 번은 수십 초 걸릴 수 있습니다)");
    await getOcrWorker();

    const blobs = state.strips.flatMap((s) => s.analysis?.blobs || []);
    await recognizeFretGlyphs(blobs, (i, n) => setMessage(`타브 숫자 모양 인식 중… (${i}/${n})`));
    for (const s of state.strips) {
      if (!s.analysis) continue;
      const { notes, ignored } = buildNotes(s.analysis);
      s.notes = notes;
      s.ignored = ignored;
    }

    if (els.optChords.checked) {
      for (let i = 0; i < state.strips.length; i += 1) {
        const s = state.strips[i];
        if (!s.analysis) continue;
        setMessage(`코드명 인식 중… (${i + 1}/${state.strips.length})`);
        s.chords = await recognizeChords(s.canvas, s.analysis);
        for (const c of s.chords) c.color = inkColor(s.canvas, c);
      }
    }

    state.analyzed = true;
    recompute();
    const warn = missing ? ` 타브 줄을 찾지 못한 조각 ${missing}개는 그대로 둡니다.` : "";
    setMessage(`인식 완료. 박스를 확인하고 틀린 곳은 클릭해 고치세요.${warn}`);
  } catch (err) {
    setMessage(err.message || String(err), true);
  } finally {
    state.busy = false;
    renderUi();
  }
}

function playable(n) {
  return Number.isInteger(n.value) && n.value >= 0 && n.value <= MAX_FRET;
}

/** Notes that fall below the lowest target string after shifting by k. */
function findTuningNeed(k, allowLowB) {
  if (k === 0) return null;
  let need = null;
  for (const s of state.strips) {
    if (!s.analysis) continue;
    const lineCount = s.analysis.tab.ys.length;
    const srcOpen = sourceOpenPitches(lineCount);
    const base = targetOpenPitches(lineCount, allowLowB);
    const lowest = base[base.length - 1];
    for (const n of s.notes) {
      if (!playable(n)) continue;
      const pitch = srcOpen[n.line] + n.value + k;
      if (pitch >= lowest) continue;
      if (!need) need = { lowest, strings: base.length, minPitch: pitch, count: 0 };
      need.minPitch = Math.min(need.minPitch, pitch);
      need.count += 1;
    }
  }
  return need;
}

function targetOpen(lineCount, allowLowB, tuned) {
  const open = [...targetOpenPitches(lineCount, allowLowB)];
  if (tuned !== null && tuned < open[open.length - 1]) open[open.length - 1] = tuned;
  return open;
}

/** Notes that no string can play after shifting by k, with the lowest string tuned to `tuned` (null = standard). */
function countUnplaced(k, allowLowB, tuned) {
  if (k === 0) return 0;
  let count = 0;
  for (const s of state.strips) {
    if (!s.analysis) continue;
    const lineCount = s.analysis.tab.ys.length;
    const srcOpen = sourceOpenPitches(lineCount);
    const dstOpen = targetOpen(lineCount, allowLowB, tuned);
    for (const n of s.notes) {
      if (playable(n) && !transposeFret(n.line, n.value, k, srcOpen, dstOpen)) count += 1;
    }
  }
  return count;
}

/** Tunings of the lowest string (at most MAX_DROP down) that leave no note unplaced. */
function tuningOptions(need, k, allowLowB) {
  const out = [];
  for (let t = need.minPitch; t >= need.minPitch - 2; t -= 1) {
    if (need.lowest - t <= MAX_DROP && !countUnplaced(k, allowLowB, t)) out.push(t);
  }
  return out;
}

function tunedPitch() {
  const c = state.tuning?.choice;
  return typeof c === "number" ? c : null;
}

function tuningSummary() {
  const t = state.tuning;
  if (!t) return state.keyWarning ? "표준 (표시 못 하는 음 있음)" : "표준";
  if (t.choice === undefined) return "선택 필요";
  if (t.choice === null) return "표준 (표시 못 하는 음 있음)";
  return `${t.need.strings}번 줄 ${noteName(t.need.lowest, state.useFlats)}→${noteName(t.choice, state.useFlats)}`;
}

function updateTuningState(k, allowLowB) {
  const blocked = countUnplaced(k, allowLowB, null);
  const need = blocked ? findTuningNeed(k, allowLowB) : null;
  const options = need ? tuningOptions(need, k, allowLowB) : [];
  if (blocked && !options.length) {
    const key = `${k}:${allowLowB}`;
    if (state.keyWarning?.key !== key) state.keyWarning = { key, shown: false };
  } else {
    state.keyWarning = null;
  }
  if (!options.length) {
    state.tuning = null;
    return;
  }
  const key = `${need.lowest}:${need.minPitch}`;
  if (state.tuning?.key === key) Object.assign(state.tuning, { need, options });
  else state.tuning = { key, need, options, choice: undefined };
}

function scheduleTuningAsk() {
  clearTimeout(state.askTimer);
  if (state.tuning && state.tuning.choice === undefined) {
    state.askTimer = setTimeout(() => openTuningDialog(false), TUNE_ASK_DELAY);
  } else if (state.keyWarning && !state.keyWarning.shown) {
    state.askTimer = setTimeout(() => {
      if (!state.keyWarning || state.keyWarning.shown || state.busy) return;
      if (showWarning(TUNE_WARNING)) state.keyWarning.shown = true;
    }, TUNE_ASK_DELAY);
  }
}

function showWarning(text) {
  const dlg = els.tuneDialog;
  setMessage(text, true);
  if (dlg.open) return false;
  els.tuneTitle.textContent = "알림";
  els.tuneText.textContent = text;
  els.tuneOptions.replaceChildren();
  els.tuneNo.textContent = "확인";
  dlg.returnValue = "";
  dlg.showModal();
  return true;
}

/** Ask which tuning to use; resolves after the user picks (or immediately when nothing to ask). */
function openTuningDialog(force) {
  const t = state.tuning;
  const dlg = els.tuneDialog;
  if (!t || dlg.open || (!force && (t.choice !== undefined || state.busy))) return Promise.resolve();
  const { need, options } = t;
  const low = `${need.strings}번 줄(${noteName(need.lowest, state.useFlats)})`;
  const names = options.map((p) => noteNameBoth(p)).join(", ");
  const ask = options.length > 1 ? `${low}을 ${names} 중 선택하세요.` : `${low}을 ${names}(으)로 내려서 표시합니다.`;
  els.tuneTitle.textContent = "튜닝 제안";
  els.tuneNo.textContent = "아니오 (튜닝하지 않음)";
  els.tuneText.textContent =
    `악보에 표시하지 못하는 음이 있습니다 (${need.count}개, 가장 낮은 음 ${noteNameBoth(need.minPitch)}). ` +
    `튜닝을 하시겠습니까? ${ask}`;
  els.tuneOptions.replaceChildren(
    ...options.map((p) => {
      const b = document.createElement("button");
      b.type = "submit";
      b.value = String(p);
      b.innerHTML = `${noteNameBoth(p)}<small>${need.lowest - p}반음 내림</small>`;
      return b;
    })
  );
  dlg.returnValue = "";
  return new Promise((resolve) => {
    dlg.addEventListener(
      "close",
      () => {
        const v = dlg.returnValue;
        if (state.tuning === t) t.choice = v && v !== "no" ? Number(v) : null;
        recompute();
        if (state.tuning === t && t.choice === null && state.unplaced) setMessage(NO_TUNE_WARNING, true);
        resolve();
      },
      { once: true }
    );
    dlg.showModal();
  });
}

function recompute() {
  const k = keyShift();
  const allowLowB = els.optLowB.checked;
  let needLowB = false;
  let notes = 0;
  let check = 0;
  let unplaced = 0;
  let ignored = 0;
  let chordCount = 0;

  updateTuningState(k, allowLowB);
  const tuned = tunedPitch();

  for (const s of state.strips) {
    if (!s.analysis) continue;
    const lineCount = s.analysis.tab.ys.length;
    const srcOpen = sourceOpenPitches(lineCount);
    const dstOpen = targetOpen(lineCount, allowLowB, tuned);
    for (const n of s.notes) {
      n.target = null;
      n.unplayable = false;
      if (k !== 0 && playable(n)) {
        const t = transposeFret(n.line, n.value, k, srcOpen, dstOpen);
        if (t) {
          n.target = t;
          if (lineCount < 5 && t.line >= lineCount) needLowB = true;
        } else {
          n.unplayable = true;
          unplaced += 1;
        }
      }
      notes += 1;
      if (n.status === "check" || n.unplayable) check += 1;
    }
    ignored += s.ignored.length;
    chordCount += s.chords.filter((c) => !c.ignored).length;
  }

  const chordTexts = state.strips.flatMap((s) => s.chords.filter((c) => !c.ignored).map((c) => c.text));
  const pref = spelling();
  let useFlats = pref === "flat";
  if (pref === "auto") {
    const flats = countAccidentals(chordTexts, k, true);
    const sharps = countAccidentals(chordTexts, k, false);
    useFlats = flats < sharps || (flats === sharps && k < 0);
  }
  state.useFlats = useFlats;
  for (const s of state.strips) {
    for (const c of s.chords) {
      c.newText = els.optChords.checked && k !== 0 && !c.ignored ? transposeChord(c.text, k, useFlats) : null;
    }
  }

  state.needLowB = needLowB;
  state.unplaced = unplaced;
  if (!unplaced && [TUNE_WARNING, NO_TUNE_WARNING].includes(els.message.textContent)) setMessage("");
  els.sumStrips.textContent = String(state.strips.length);
  els.sumNotes.textContent = String(notes);
  els.sumCheck.textContent = String(check);
  els.sumUnplaced.textContent = String(unplaced);
  els.sumIgnored.textContent = String(ignored);
  els.sumChords.textContent = String(chordCount);
  els.sumLowB.textContent = needLowB ? "예" : "아니오";
  els.sumTuning.textContent = tuningSummary();
  els.btnTuning.hidden = !state.tuning;
  drawAll();
  scheduleTuningAsk();
}

function tuningLabel() {
  const tuned = tunedPitch();
  if (tuned === null) return null;
  const { strings } = state.tuning.need;
  return { line: strings - 1, text: `${strings}번 줄 = ${noteName(tuned, state.useFlats)}` };
}

function renderResult(s) {
  if (!s.analysis) return s.canvas;
  return renderStrip(s.canvas, s.analysis, s.notes, els.optChords.checked ? s.chords : [], {
    dimNotation: els.optDim.checked,
    addLowString: state.needLowB,
    tuningLabel: tuningLabel()
  });
}

function strokeBox(ctx, box, color, dashed = false) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  if (dashed) ctx.setLineDash([3, 2]);
  ctx.strokeRect(box.x0 - 2.5, box.y0 - 2.5, box.x1 - box.x0 + 5, box.y1 - box.y0 + 5);
  ctx.restore();
}

function tagLabel(ctx, x, y, text, color) {
  ctx.save();
  ctx.font = "bold 11px Segoe UI, sans-serif";
  const w = ctx.measureText(text).width + 6;
  ctx.fillStyle = color;
  ctx.fillRect(x, y - 12, w, 13);
  ctx.fillStyle = "#fff";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(text, x + 3, y - 2);
  ctx.restore();
}

function noteColor(n) {
  if (n.status === "check" || n.unplayable) return COLORS.check;
  return COLORS.ok;
}

function drawReview(s, canvas) {
  canvas.width = s.canvas.width;
  canvas.height = s.canvas.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(s.canvas, 0, 0);
  if (!s.analysis) {
    if (state.analyzed) tagLabel(ctx, 6, 18, "타브 줄을 찾지 못함 (그대로 둠)", "#d32f2f");
    return;
  }
  if (!state.analyzed) return;
  const k = keyShift();
  for (const b of s.ignored) strokeBox(ctx, b, COLORS.ignored, true);
  for (const n of s.notes) {
    const color = noteColor(n);
    strokeBox(ctx, n, color);
    let label = n.text;
    if (n.target && k !== 0) label += `→${n.target.fret}${n.target.line !== n.line ? "*" : ""}`;
    tagLabel(ctx, n.x0 - 2, n.y0 - 3, label, color);
  }
  for (const c of s.chords) {
    if (c.ignored) {
      strokeBox(ctx, c, COLORS.ignored, true);
      continue;
    }
    strokeBox(ctx, c, COLORS.chord);
    tagLabel(ctx, c.x0 - 2, c.y1 + 15, c.newText ? `${c.text}→${c.newText}` : c.text, COLORS.chord);
  }
}

function drawStrip(s, i) {
  if (!s.el) {
    const wrap = document.createElement("div");
    wrap.className = "strip";
    const label = document.createElement("span");
    label.className = "strip-no";
    label.textContent = String(i + 1);
    const canvas = document.createElement("canvas");
    canvas.className = "strip-canvas";
    canvas.addEventListener("click", (ev) => onStripClick(s, canvas, ev));
    wrap.append(label, canvas);
    s.el = wrap;
    s.view = canvas;
  }
  if (viewMode() === "result" && state.analyzed) {
    const out = renderResult(s);
    s.view.width = out.width;
    s.view.height = out.height;
    s.view.getContext("2d").drawImage(out, 0, 0);
    s.view.classList.remove("editable");
  } else {
    drawReview(s, s.view);
    s.view.classList.toggle("editable", state.analyzed && !!s.analysis);
  }
}

function drawAll() {
  if (!state.strips.length) return;
  els.strips.replaceChildren();
  state.strips.forEach((s, i) => {
    drawStrip(s, i);
    els.strips.append(s.el);
  });
}

function hit(box, x, y, pad = 3) {
  return x >= box.x0 - pad && x <= box.x1 + pad && y >= box.y0 - pad && y <= box.y1 + pad;
}

function parseFret(input) {
  const t = String(input).trim();
  if (!/^\d{1,2}$/.test(t)) return null;
  const v = Number(t);
  return v <= MAX_FRET ? v : null;
}

function makeNote(s, box, line, value) {
  const color = s.notes[0]?.color || [20, 20, 20];
  return { ...box, line, text: String(value), value, conf: 100, status: "ok", manual: true, color };
}

function onStripClick(s, canvas, ev) {
  if (!state.analyzed || !s.analysis || viewMode() !== "review") return;
  const rect = canvas.getBoundingClientRect();
  const x = ((ev.clientX - rect.left) / rect.width) * canvas.width;
  const y = ((ev.clientY - rect.top) / rect.height) * canvas.height;
  const { tab } = s.analysis;

  const chord = s.chords.find((c) => hit(c, x, y));
  if (chord) {
    const input = prompt("코드명을 수정하세요. 비우면 이 코드는 바꾸지 않습니다.", chord.ignored ? "" : chord.text);
    if (input === null) return;
    const text = normalizeChordText(input);
    if (!text) chord.ignored = true;
    else if (isChordText(text)) {
      chord.text = text;
      chord.ignored = false;
    } else {
      alert("코드명 형식이 아닙니다. 예: Bm, F#m7, D/F#");
      return;
    }
    recompute();
    return;
  }

  const note = s.notes.find((n) => hit(n, x, y));
  if (note) {
    const input = prompt("프렛 숫자를 입력하세요. 비우면 '숫자 아님'으로 처리해 그대로 둡니다.", note.text);
    if (input === null) return;
    if (!input.trim()) {
      s.notes.splice(s.notes.indexOf(note), 1);
      s.ignored.push({ x0: note.x0, y0: note.y0, x1: note.x1, y1: note.y1, line: note.line });
    } else {
      const v = parseFret(input);
      if (v === null) {
        alert(`0~${MAX_FRET} 사이 숫자를 입력하세요.`);
        return;
      }
      Object.assign(note, { text: String(v), value: v, conf: 100, status: "ok", manual: true });
    }
    recompute();
    return;
  }

  const blob = s.ignored.find((b) => hit(b, x, y));
  if (blob) {
    const input = prompt("이 표시를 프렛 숫자로 바꾸려면 숫자를 입력하세요.", "");
    if (input === null || !input.trim()) return;
    const v = parseFret(input);
    if (v === null) {
      alert(`0~${MAX_FRET} 사이 숫자를 입력하세요.`);
      return;
    }
    s.ignored.splice(s.ignored.indexOf(blob), 1);
    s.notes.push(makeNote(s, blob, blob.line, v));
    recompute();
    return;
  }

  let line = 0;
  tab.ys.forEach((ly, i) => {
    if (Math.abs(y - ly) < Math.abs(y - tab.ys[line])) line = i;
  });
  if (Math.abs(y - tab.ys[line]) > tab.sp * 0.45 || x < tab.x0 || x > tab.x1) return;
  const input = prompt(`${line + 1}번째 줄 이 위치에 프렛 숫자를 추가합니다.`, "");
  if (input === null || !input.trim()) return;
  const v = parseFret(input);
  if (v === null) {
    alert(`0~${MAX_FRET} 사이 숫자를 입력하세요.`);
    return;
  }
  const heights = s.notes.map((n) => n.y1 - n.y0 + 1).sort((a, b) => a - b);
  const dh = heights[Math.floor(heights.length / 2)] || Math.round(tab.sp * 0.7);
  const dw = Math.round(dh * 0.55) * String(v).length;
  const box = {
    x0: Math.round(x - dw / 2),
    x1: Math.round(x + dw / 2),
    y0: Math.round(tab.ys[line] - dh / 2),
    y1: Math.round(tab.ys[line] + dh / 2)
  };
  s.notes.push(makeNote(s, box, line, v));
  recompute();
}

async function savePdf() {
  if (!state.analyzed) return;
  if (state.tuning && state.tuning.choice === undefined) await openTuningDialog(true);
  if (state.unplaced) {
    showWarning(state.keyWarning ? TUNE_WARNING : NO_TUNE_WARNING);
    return;
  }
  state.busy = true;
  renderUi();
  try {
    setMessage("변환 PDF 만드는 중…");
    await new Promise((r) => setTimeout(r, 0));
    const images = state.strips.map((s) => ({ dataUrl: renderResult(s).toDataURL("image/png") }));
    const k = keyShift();
    const sign = k > 0 ? `+${k}` : String(k);
    const tuned = tunedPitch();
    let title = `Transposed ${sign}`;
    let suffix = "";
    if (tuned !== null) {
      const { strings, lowest } = state.tuning.need;
      const to = noteName(tuned, state.useFlats);
      title += `, string ${strings}: ${noteName(lowest, state.useFlats)} -> ${to}`;
      suffix = `_${strings}번줄${to}`;
    }
    const blob = await buildPdf(images, { columns: 1, title });
    downloadBlob(blob, `${state.baseName}_키${sign}${suffix}.pdf`);
    setMessage(`PDF 저장 완료 (조정 키 ${sign}${tuned !== null ? `, ${tuningSummary()}` : ""}, ${images.length}장)`);
  } catch (err) {
    setMessage(err.message || String(err), true);
  } finally {
    state.busy = false;
    renderUi();
  }
}

els.fileInput.addEventListener("change", () => loadFiles(els.fileInput.files));
els.btnAnalyze.addEventListener("click", analyze);
els.btnPdf.addEventListener("click", savePdf);
els.btnTuning.addEventListener("click", () => openTuningDialog(true));
els.keyShift.addEventListener("input", () => {
  renderUi();
  if (state.analyzed) recompute();
});
for (const el of [els.optDim, els.optChords, els.optLowB]) {
  el.addEventListener("change", () => state.analyzed && recompute());
}
document.querySelectorAll('input[name="spelling"]').forEach((el) =>
  el.addEventListener("change", () => state.analyzed && recompute())
);
document.querySelectorAll('input[name="view"]').forEach((el) => el.addEventListener("change", drawAll));

renderUi();
