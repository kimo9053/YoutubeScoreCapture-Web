import { compareImageData, fingerprint, fingerprintsSimilar, detectPlayhead } from "./diff.js";
import { buildPdf, downloadBlob } from "./pdf.js";

const $ = (id) => document.getElementById(id);

const els = {
  btnShare: $("btnShare"),
  btnRegion: $("btnRegion"),
  btnMeasureRegion: $("btnMeasureRegion"),
  btnMeasureMode: $("btnMeasureMode"),
  btnCursorMode: $("btnCursorMode"),
  btnStart: $("btnStart"),
  btnStop: $("btnStop"),
  btnPdf: $("btnPdf"),
  btnClear: $("btnClear"),
  btnDeleteSelected: $("btnDeleteSelected"),
  btnSelectAll: $("btnSelectAll"),
  btnSelectNone: $("btnSelectNone"),
  btnInstall: $("btnInstall"),
  sensitivity: $("sensitivity"),
  sensitivityValue: $("sensitivityValue"),
  minInterval: $("minInterval"),
  intervalValue: $("intervalValue"),
  captureCount: $("captureCount"),
  regionText: $("regionText"),
  measureRegionText: $("measureRegionText"),
  selectedText: $("selectedText"),
  statusDot: $("statusDot"),
  statusText: $("statusText"),
  message: $("message"),
  installHint: $("installHint"),
  preview: $("preview"),
  overlay: $("overlay"),
  empty: $("empty"),
  thumbs: $("thumbs"),
  previewWrap: $("previewWrap")
};

let deferredInstallPrompt = null;
let nextCaptureId = 1;

function detectPlatform() {
  const ua = navigator.userAgent || "";
  const isIOS =
    /iPad|iPhone|iPod/i.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/i.test(ua);
  return { isIOS, isAndroid, isMobile: isIOS || isAndroid };
}

const platform = detectPlatform();
const hasDisplayMedia = Boolean(
  navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === "function"
);

const state = {
  stream: null,
  selecting: false,
  selectingMeasure: false,
  region: null,
  measureRegion: null,
  measureModeEnabled: false,
  cursorModeEnabled: false,
  running: false,
  timerId: null,
  capturing: false,
  sensitivity: 0.08,
  minIntervalMs: 300,
  pdfColumns: 2,
  lastImageData: null,
  lastFingerprint: null,
  lastMeasureFingerprint: null,
  lastMeasureImageData: null,
  prevMeasureImageData: null,
  measureChangeStartedAt: 0,
  lastPlayheadX: null,
  lastPlayheadPresent: false,
  cursorChangeStartedAt: 0,
  lastSavedAt: 0,
  prevImageData: null,
  changeStartedAt: 0,
  captures: [],
  selectedIds: new Set()
};

/** 프레임이 안정화되었다고 볼 연속 변화율 상한 */
const SETTLE_RATIO = 0.015;
/** 페이지 전환 중에도 이 시간이 지나면 강제 저장 */
const MAX_SETTLE_WAIT_MS = 1200;

/** 마디 숫자 fingerprint 유사도 (낮을수록 엄격) */
const MEASURE_FP_SIMILAR = 0.04;
/** 같은 악보 페이지로 보는 score fingerprint 유사도 */
const SCORE_DUPE_SIMILAR = 0.06;

const workCanvas = document.createElement("canvas");
const workCtx = workCanvas.getContext("2d", { willReadFrequently: true });
const cropCanvas = document.createElement("canvas");
const cropCtx = cropCanvas.getContext("2d", { willReadFrequently: true });
const measureCropCanvas = document.createElement("canvas");
const measureCropCtx = measureCropCanvas.getContext("2d", { willReadFrequently: true });

function setMessage(text, isError = false) {
  els.message.textContent = text || "";
  els.message.classList.toggle("error", Boolean(isError));
}

function getPdfColumns() {
  const checked = document.querySelector('input[name="pdfColumns"]:checked');
  return Number(checked?.value || state.pdfColumns || 2);
}

function renderThumbs() {
  els.thumbs.innerHTML = "";
  state.captures.forEach((item, index) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "thumb" + (state.selectedIds.has(item.id) ? " selected" : "");
    btn.dataset.id = String(item.id);
    btn.title = `${index + 1}번 · 클릭하여 선택/해제`;

    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = String(index + 1);

    const img = document.createElement("img");
    img.src = item.dataUrl;
    img.alt = `capture ${index + 1}`;

    btn.append(badge, img);
    btn.addEventListener("click", () => toggleSelect(item.id));
    els.thumbs.appendChild(btn);
  });
}

function toggleSelect(id) {
  if (state.selectedIds.has(id)) state.selectedIds.delete(id);
  else state.selectedIds.add(id);
  renderUi();
  renderThumbs();
}

function selectAll() {
  state.selectedIds = new Set(state.captures.map((c) => c.id));
  renderUi();
  renderThumbs();
}

function selectNone() {
  state.selectedIds.clear();
  renderUi();
  renderThumbs();
}

function deleteSelected() {
  if (state.selectedIds.size === 0) return;
  const before = state.captures.length;
  state.captures = state.captures.filter((c) => !state.selectedIds.has(c.id));
  const removed = before - state.captures.length;
  state.selectedIds.clear();
  renderThumbs();
  setMessage(`선택한 ${removed}장을 삭제했습니다.`);
  renderUi();
}

function mobileShareMessage() {
  if (platform.isAndroid) {
    return "갤럭시·안드로이드 Chrome은 화면 공유(getDisplayMedia)를 지원하지 않습니다. 악보 캡처는 PC Chrome/Edge에서만 가능합니다.";
  }
  if (platform.isIOS) {
    return "아이폰·아이패드 Safari는 화면 공유를 지원하지 않습니다. 악보 캡처는 PC Chrome/Edge에서만 가능합니다.";
  }
  return "이 브라우저는 화면 공유를 지원하지 않습니다. PC Chrome/Edge를 사용해 주세요.";
}

function useMeasureCaptureMode() {
  return state.measureModeEnabled && Boolean(state.measureRegion);
}

function useCursorCaptureMode() {
  return state.cursorModeEnabled && Boolean(state.region);
}

function setCaptureMode(mode) {
  if (mode === "measure") {
    state.measureModeEnabled = true;
    state.cursorModeEnabled = false;
    return;
  }
  if (mode === "cursor") {
    state.cursorModeEnabled = true;
    state.measureModeEnabled = false;
    return;
  }
  state.measureModeEnabled = false;
  state.cursorModeEnabled = false;
}

function renderUi() {
  const hasStream = Boolean(state.stream);
  const hasRegion = Boolean(state.region);
  const hasMeasureRegion = Boolean(state.measureRegion);
  const measureModeOn = useMeasureCaptureMode();
  const cursorModeOn = useCursorCaptureMode();
  const count = state.captures.length;
  const selected = state.selectedIds.size;

  els.btnRegion.disabled = !hasStream || state.running;
  els.btnMeasureRegion.disabled = !hasStream || !hasRegion || state.running;
  els.btnMeasureMode.disabled = !hasMeasureRegion || state.running;
  els.btnMeasureMode.classList.toggle("on", measureModeOn);
  els.btnMeasureMode.textContent = measureModeOn
    ? "마디 숫자 우선 캡처: 켜짐"
    : "마디 숫자 우선 캡처: 꺼짐";
  els.btnCursorMode.disabled = !hasRegion || state.running;
  els.btnCursorMode.classList.toggle("on", cursorModeOn);
  els.btnCursorMode.textContent = cursorModeOn
    ? "재생 커서 인식 캡처: 켜짐"
    : "재생 커서 인식 캡처: 꺼짐";
  els.btnStart.disabled = !hasStream || !hasRegion || state.running;
  els.btnStop.disabled = !state.running;
  els.btnShare.disabled = state.running;
  els.btnPdf.disabled = count === 0;
  els.btnClear.disabled = count === 0 || state.running;
  els.btnDeleteSelected.disabled = selected === 0 || state.running;
  els.btnSelectAll.disabled = count === 0;
  els.btnSelectNone.disabled = selected === 0;
  els.sensitivity.disabled = state.running;
  els.minInterval.disabled = state.running;
  document.querySelectorAll('input[name="pdfColumns"]').forEach((el) => {
    el.disabled = state.running;
  });

  els.captureCount.textContent = String(count);
  els.selectedText.textContent = `선택: ${selected}장`;
  els.statusDot.classList.toggle("on", state.running);
  els.statusText.textContent = state.running
    ? measureModeOn
      ? "캡처 중 (마디 숫자)"
      : cursorModeOn
        ? "캡처 중 (재생 커서)"
        : "캡처 중"
    : hasRegion && measureModeOn
      ? "준비됨 (마디 숫자 모드)"
      : hasRegion && cursorModeOn
        ? "준비됨 (재생 커서 모드)"
        : hasRegion && hasMeasureRegion
          ? "캡처 모드 선택"
          : hasRegion
            ? "캡처 모드 선택"
            : hasStream
              ? "악보 영역 지정 필요"
              : "대기";

  if (hasRegion) {
    els.regionText.textContent = `악보 영역: ${state.region.w}×${state.region.h} px`;
  } else {
    els.regionText.textContent = "악보 영역: 미지정";
  }

  if (hasMeasureRegion) {
    els.measureRegionText.textContent = `마디 숫자: ${state.measureRegion.w}×${state.measureRegion.h} px`;
  } else {
    els.measureRegionText.textContent = "마디 숫자: 미지정";
  }

  els.empty.classList.toggle("hidden", hasStream);
}

function syncOverlaySize() {
  const rect = els.previewWrap.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  els.overlay.width = Math.max(1, Math.round(rect.width * dpr));
  els.overlay.height = Math.max(1, Math.round(rect.height * dpr));
  els.overlay.style.width = `${rect.width}px`;
  els.overlay.style.height = `${rect.height}px`;
  drawOverlay();
}

function cssToVideoPoint(clientX, clientY) {
  const video = els.preview;
  const wrap = els.previewWrap.getBoundingClientRect();
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;

  const scale = Math.min(wrap.width / vw, wrap.height / vh);
  const dispW = vw * scale;
  const dispH = vh * scale;
  const offX = (wrap.width - dispW) / 2;
  const offY = (wrap.height - dispH) / 2;

  const x = (clientX - wrap.left - offX) / scale;
  const y = (clientY - wrap.top - offY) / scale;
  return {
    x: Math.max(0, Math.min(vw, x)),
    y: Math.max(0, Math.min(vh, y))
  };
}

function videoRectToOverlay(region) {
  const video = els.preview;
  const wrap = els.previewWrap.getBoundingClientRect();
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh || !region) return null;

  const scale = Math.min(wrap.width / vw, wrap.height / vh);
  const dispW = vw * scale;
  const dispH = vh * scale;
  const offX = (wrap.width - dispW) / 2;
  const offY = (wrap.height - dispH) / 2;
  const dpr = window.devicePixelRatio || 1;

  return {
    x: (offX + region.x * scale) * dpr,
    y: (offY + region.y * scale) * dpr,
    w: region.w * scale * dpr,
    h: region.h * scale * dpr
  };
}

function drawOverlay(tempRegion = null, tempMeasureRegion = null) {
  const ctx = els.overlay.getContext("2d");
  ctx.clearRect(0, 0, els.overlay.width, els.overlay.height);

  const mainRegion = tempRegion || state.region;
  const measureRegion = tempMeasureRegion ?? (tempRegion ? null : state.measureRegion);
  const mainRect = videoRectToOverlay(mainRegion);
  if (!mainRect) return;

  ctx.fillStyle = "rgba(0,0,0,0.28)";
  ctx.fillRect(0, 0, els.overlay.width, els.overlay.height);
  ctx.clearRect(mainRect.x, mainRect.y, mainRect.w, mainRect.h);

  const lineWidth = Math.max(2, (window.devicePixelRatio || 1) * 2);
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = "#e53935";
  ctx.strokeRect(mainRect.x, mainRect.y, mainRect.w, mainRect.h);

  const measureRect = videoRectToOverlay(measureRegion);
  if (measureRect) {
    ctx.strokeStyle = "#42a5f5";
    ctx.strokeRect(measureRect.x, measureRect.y, measureRect.w, measureRect.h);
  }
}

async function startShare() {
  if (!window.isSecureContext) {
    setMessage("화면 공유는 https 또는 localhost에서만 동작합니다.", true);
    return;
  }

  if (!hasDisplayMedia) {
    setMessage(mobileShareMessage(), true);
    return;
  }

  try {
    stopCapture();
    if (state.stream) {
      state.stream.getTracks().forEach((t) => t.stop());
      state.stream = null;
    }

    const videoConstraints = platform.isMobile
      ? { frameRate: 10 }
      : { frameRate: 10, displaySurface: "browser" };

    const displayMediaOptions = {
      video: videoConstraints,
      audio: false
    };

    if (!platform.isMobile) {
      displayMediaOptions.preferCurrentTab = false;
      displayMediaOptions.selfBrowserSurface = "exclude";
      displayMediaOptions.surfaceSwitching = "include";
      displayMediaOptions.systemAudio = "exclude";
    }

    const stream = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions);

    state.stream = stream;
    state.region = null;
    state.measureRegion = null;
    state.measureModeEnabled = false;
    state.cursorModeEnabled = false;
    els.preview.srcObject = stream;
    await els.preview.play();

    stream.getVideoTracks()[0].addEventListener("ended", () => {
      stopCapture();
      state.stream = null;
      els.preview.srcObject = null;
      state.region = null;
      state.measureRegion = null;
      state.measureModeEnabled = false;
      state.cursorModeEnabled = false;
      setMessage("화면 공유가 종료되었습니다.");
      renderUi();
      drawOverlay();
    });

    setMessage("공유됨. 악보 영역 → 마디 숫자 영역 순으로 지정하세요.");
    renderUi();
    requestAnimationFrame(syncOverlaySize);
  } catch (error) {
    setMessage(error.message || "화면 공유가 취소되었습니다.", true);
    renderUi();
  }
}

function beginRegionSelect(mode = "main") {
  if (!state.stream) return;
  if (mode === "measure" && !state.region) {
    setMessage("먼저 악보 영역을 지정해 주세요.", true);
    return;
  }

  state.selecting = mode === "main";
  state.selectingMeasure = mode === "measure";
  els.overlay.classList.add("selecting");
  setMessage(
    mode === "measure"
      ? "마디 숫자가 보이는 작은 영역을 드래그하세요 (왼쪽 위)."
      : "미리보기에서 악보 영역을 드래그하세요."
  );

  let start = null;
  let current = null;

  const onDown = (e) => {
    const p = cssToVideoPoint(e.clientX, e.clientY);
    if (!p) return;
    start = p;
    current = { x: p.x, y: p.y, w: 0, h: 0 };
  };

  const onMove = (e) => {
    if (!start) return;
    const p = cssToVideoPoint(e.clientX, e.clientY);
    if (!p) return;
    const x = Math.min(start.x, p.x);
    const y = Math.min(start.y, p.y);
    current = {
      x: Math.round(x),
      y: Math.round(y),
      w: Math.round(Math.abs(p.x - start.x)),
      h: Math.round(Math.abs(p.y - start.y))
    };
    if (mode === "measure") drawOverlay(null, current);
    else drawOverlay(current);
  };

  const cleanup = () => {
    els.overlay.removeEventListener("pointerdown", onDown);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("keydown", onKey);
    els.overlay.classList.remove("selecting");
    state.selecting = false;
    state.selectingMeasure = false;
  };

  const onUp = () => {
    if (!current || current.w < 8 || current.h < 8) {
      cleanup();
      setMessage("영역이 너무 작습니다. 다시 지정해 주세요.", true);
      drawOverlay();
      return;
    }
    if (mode === "measure") {
      state.measureRegion = current;
      cleanup();
      setMessage(`마디 숫자 영역 지정됨 (${current.w}×${current.h}). '마디 숫자 우선 캡처'를 켜세요.`);
    } else {
      state.region = current;
      state.measureRegion = null;
      state.measureModeEnabled = false;
      state.cursorModeEnabled = false;
      cleanup();
      setMessage(`악보 영역 지정됨 (${current.w}×${current.h}). 이제 마디 숫자 영역을 지정하세요.`);
    }
    drawOverlay();
    renderUi();
  };

  const onKey = (e) => {
    if (e.key === "Escape") {
      cleanup();
      setMessage("영역 지정이 취소되었습니다.");
      drawOverlay();
    }
  };

  els.overlay.addEventListener("pointerdown", onDown);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("keydown", onKey);
}

function beginMeasureRegionSelect() {
  beginRegionSelect("measure");
}

function grabCropFromRegion(region, destCanvas, destCtx, { withDataUrl = false } = {}) {
  const video = els.preview;
  if (!video.videoWidth || !region) return null;

  if (workCanvas.width !== video.videoWidth || workCanvas.height !== video.videoHeight) {
    workCanvas.width = video.videoWidth;
    workCanvas.height = video.videoHeight;
  }
  workCtx.drawImage(video, 0, 0);

  const sx = Math.max(0, region.x);
  const sy = Math.max(0, region.y);
  const sw = Math.min(region.w, video.videoWidth - sx);
  const sh = Math.min(region.h, video.videoHeight - sy);
  if (sw < 1 || sh < 1) return null;

  if (destCanvas.width !== sw || destCanvas.height !== sh) {
    destCanvas.width = sw;
    destCanvas.height = sh;
  }
  destCtx.drawImage(workCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
  const imageData = destCtx.getImageData(0, 0, sw, sh);
  const dataUrl = withDataUrl ? destCanvas.toDataURL("image/png") : null;
  return { dataUrl, width: sw, height: sh, imageData };
}

function grabCrop(options = {}) {
  return grabCropFromRegion(state.region, cropCanvas, cropCtx, options);
}

function grabMeasureCrop() {
  return grabCropFromRegion(state.measureRegion, measureCropCanvas, measureCropCtx);
}

function ensureDataUrl(cropped) {
  if (cropped.dataUrl) return cropped;
  // grabCrop 직후 cropCanvas에 동일 프레임이 남아 있음
  if (cropCanvas.width !== cropped.width || cropCanvas.height !== cropped.height) {
    cropCanvas.width = cropped.width;
    cropCanvas.height = cropped.height;
    cropCtx.putImageData(cropped.imageData, 0, 0);
  }
  return {
    ...cropped,
    dataUrl: cropCanvas.toDataURL("image/png")
  };
}

function addCapture(cropped) {
  const ready = ensureDataUrl(cropped);
  const item = {
    id: nextCaptureId++,
    dataUrl: ready.dataUrl,
    width: ready.width,
    height: ready.height,
    createdAt: Date.now()
  };
  state.captures.push(item);
  renderThumbs();
  renderUi();
}

function saveCapture(cropped, changeRatio, now, measureCropped = null, reason = null) {
  const fp = fingerprint(cropped.imageData);
  if (state.lastFingerprint) {
    if (
      state.lastFingerprint === fp ||
      fingerprintsSimilar(state.lastFingerprint, fp, SCORE_DUPE_SIMILAR)
    ) {
      state.changeStartedAt = 0;
      if (measureCropped) {
        state.lastMeasureImageData = measureCropped.imageData;
        state.lastMeasureFingerprint = fingerprint(measureCropped.imageData);
        state.prevMeasureImageData = measureCropped.imageData;
      }
      return false;
    }
  }

  addCapture(cropped);
  state.lastImageData = cropped.imageData;
  state.lastFingerprint = fp;
  state.prevImageData = cropped.imageData;
  state.lastSavedAt = now;
  state.changeStartedAt = 0;
  if (measureCropped) {
    state.lastMeasureImageData = measureCropped.imageData;
    state.lastMeasureFingerprint = fingerprint(measureCropped.imageData);
    state.prevMeasureImageData = measureCropped.imageData;
  }
  const label =
    reason ??
    (measureCropped != null
      ? "저장됨 (마디 숫자 변경)"
      : `저장됨 (변화 ${(changeRatio * 100).toFixed(1)}%)`);
  setMessage(label);
  return true;
}

function measureNumberChanged(measureCropped) {
  if (!measureCropped) return false;
  if (!state.lastMeasureFingerprint) return true;

  const measureFp = fingerprint(measureCropped.imageData);
  if (fingerprintsSimilar(state.lastMeasureFingerprint, measureFp, MEASURE_FP_SIMILAR)) {
    return false;
  }

  // 재생 커서 등 노이즈: 픽셀 변화율이 사용자 임계값 미만이면 무시
  if (state.lastMeasureImageData) {
    const { changeRatio } = compareImageData(state.lastMeasureImageData, measureCropped.imageData);
    if (changeRatio < state.sensitivity) return false;
  }

  return true;
}

async function tickMeasureMode(cropped, measureCropped, now) {
  if (!state.lastMeasureImageData) {
    addCapture(cropped);
    state.lastImageData = cropped.imageData;
    state.lastFingerprint = fingerprint(cropped.imageData);
    state.prevImageData = cropped.imageData;
    state.lastMeasureImageData = measureCropped.imageData;
    state.lastMeasureFingerprint = fingerprint(measureCropped.imageData);
    state.prevMeasureImageData = measureCropped.imageData;
    state.lastSavedAt = now;
    state.changeStartedAt = 0;
    state.measureChangeStartedAt = 0;
    setMessage("첫 프레임 저장");
    return;
  }

  if (!measureNumberChanged(measureCropped)) {
    state.measureChangeStartedAt = 0;
    state.prevMeasureImageData = measureCropped.imageData;
    return;
  }

  // 마디 영역만 흔들리고 악보는 같으면 오탐 → 기준만 갱신
  const scoreFp = fingerprint(cropped.imageData);
  if (
    state.lastFingerprint &&
    fingerprintsSimilar(state.lastFingerprint, scoreFp, SCORE_DUPE_SIMILAR)
  ) {
    state.lastMeasureImageData = measureCropped.imageData;
    state.lastMeasureFingerprint = fingerprint(measureCropped.imageData);
    state.prevMeasureImageData = measureCropped.imageData;
    state.measureChangeStartedAt = 0;
    return;
  }

  if (!state.measureChangeStartedAt) state.measureChangeStartedAt = now;
  if (now - state.lastSavedAt < state.minIntervalMs) return;

  const vsPrev = state.prevMeasureImageData
    ? compareImageData(state.prevMeasureImageData, measureCropped.imageData).changeRatio
    : 1;
  state.prevMeasureImageData = measureCropped.imageData;

  const waited = now - state.measureChangeStartedAt;
  if (vsPrev > SETTLE_RATIO && waited < MAX_SETTLE_WAIT_MS) return;

  saveCapture(cropped, 1, now, measureCropped);
  state.measureChangeStartedAt = 0;
}

function playheadPageTurn(last, current, scoreWidth) {
  if (!current.present || !last.present || current.x == null || last.x == null) return false;

  const jumpBack = last.x - current.x;
  if (jumpBack > scoreWidth * 0.2) return true;

  return last.x > scoreWidth * 0.65 && current.x < scoreWidth * 0.35;
}

function playheadTrigger(last, current, scoreWidth) {
  if (!current.present) return false;
  if (!last.present) return true;
  return playheadPageTurn(last, current, scoreWidth);
}

async function tickCursorMode(cropped, now) {
  const current = detectPlayhead(cropped.imageData);
  const last = {
    present: state.lastPlayheadPresent,
    x: state.lastPlayheadX
  };
  const scoreWidth = cropped.width;

  if (state.lastPlayheadX == null) {
    addCapture(cropped);
    state.lastImageData = cropped.imageData;
    state.lastFingerprint = fingerprint(cropped.imageData);
    state.prevImageData = cropped.imageData;
    state.lastPlayheadX = current.x;
    state.lastPlayheadPresent = current.present;
    state.lastSavedAt = now;
    state.changeStartedAt = 0;
    state.cursorChangeStartedAt = 0;
    setMessage("첫 프레임 저장");
    return;
  }

  if (!playheadTrigger(last, current, scoreWidth)) {
    state.cursorChangeStartedAt = 0;
    state.lastPlayheadX = current.x;
    state.lastPlayheadPresent = current.present;
    return;
  }

  const scoreFp = fingerprint(cropped.imageData);
  if (
    state.lastFingerprint &&
    fingerprintsSimilar(state.lastFingerprint, scoreFp, SCORE_DUPE_SIMILAR)
  ) {
    state.lastPlayheadX = current.x;
    state.lastPlayheadPresent = current.present;
    state.cursorChangeStartedAt = 0;
    return;
  }

  if (!state.cursorChangeStartedAt) state.cursorChangeStartedAt = now;
  if (now - state.lastSavedAt < state.minIntervalMs) return;

  const waited = now - state.cursorChangeStartedAt;
  if (waited < 200) return;

  if (
    saveCapture(cropped, 1, now, null, "저장됨 (재생 커서 · 페이지 전환)")
  ) {
    state.lastPlayheadX = current.x;
    state.lastPlayheadPresent = current.present;
  }
  state.cursorChangeStartedAt = 0;
}

async function tickDiffMode(cropped, now) {
  if (!state.lastImageData) {
    addCapture(cropped);
    state.lastImageData = cropped.imageData;
    state.lastFingerprint = fingerprint(cropped.imageData);
    state.prevImageData = cropped.imageData;
    state.lastSavedAt = now;
    state.changeStartedAt = 0;
    setMessage("첫 프레임 저장");
    return;
  }

  const { changeRatio } = compareImageData(state.lastImageData, cropped.imageData);
  const vsPrev = state.prevImageData
    ? compareImageData(state.prevImageData, cropped.imageData).changeRatio
    : 1;
  state.prevImageData = cropped.imageData;

  // 마지막 저장본과 충분히 다르지 않으면 대기
  if (changeRatio < state.sensitivity) {
    state.changeStartedAt = 0;
    return;
  }

  if (!state.changeStartedAt) state.changeStartedAt = now;
  if (now - state.lastSavedAt < state.minIntervalMs) return;

  // 전환 애니메이션 중이면 안정화될 때까지 기다림 (너무 길면 강제 저장)
  const waited = now - state.changeStartedAt;
  const settled = vsPrev <= SETTLE_RATIO;
  if (!settled && waited < MAX_SETTLE_WAIT_MS) return;

  saveCapture(cropped, changeRatio, now);
}

async function tick() {
  if (!state.running || state.capturing) return;
  state.capturing = true;
  try {
    const cropped = grabCrop();
    if (!cropped) return;

    const now = Date.now();
    if (useMeasureCaptureMode()) {
      const measureCropped = grabMeasureCrop();
      if (!measureCropped) return;
      await tickMeasureMode(cropped, measureCropped, now);
      return;
    }

    if (useCursorCaptureMode()) {
      await tickCursorMode(cropped, now);
      return;
    }

    await tickDiffMode(cropped, now);
  } catch (error) {
    setMessage(error.message || String(error), true);
  } finally {
    state.capturing = false;
  }
}

function startCapture() {
  if (!state.stream || !state.region) {
    setMessage("화면 공유와 악보 영역 지정이 필요합니다.", true);
    return;
  }
  state.running = true;
  state.lastImageData = null;
  state.lastFingerprint = null;
  state.lastMeasureImageData = null;
  state.lastMeasureFingerprint = null;
  state.prevMeasureImageData = null;
  state.measureChangeStartedAt = 0;
  state.lastPlayheadX = null;
  state.lastPlayheadPresent = false;
  state.cursorChangeStartedAt = 0;
  state.prevImageData = null;
  state.lastSavedAt = 0;
  state.changeStartedAt = 0;
  state.timerId = setInterval(tick, 100);
  tick();
  setMessage(
    useMeasureCaptureMode()
      ? "캡처 중… (마디 숫자가 바뀔 때 저장)"
      : useCursorCaptureMode()
        ? "캡처 중… (재생 커서가 왼쪽으로 넘어갈 때 저장)"
        : "캡처 중… (악보 변화 감지)"
  );
  renderUi();
}

function toggleMeasureMode() {
  if (!state.measureRegion || state.running) return;
  if (state.measureModeEnabled) {
    setCaptureMode("off");
    setMessage("악보 변화 감지 모드로 전환되었습니다.");
  } else {
    setCaptureMode("measure");
    setMessage("마디 숫자 우선 캡처 모드가 켜졌습니다. (재생 커서 모드는 자동 꺼짐)");
  }
  renderUi();
}

function toggleCursorMode() {
  if (!state.region || state.running) return;
  if (state.cursorModeEnabled) {
    setCaptureMode("off");
    setMessage("악보 변화 감지 모드로 전환되었습니다.");
  } else {
    setCaptureMode("cursor");
    setMessage("재생 커서 인식 캡처 모드가 켜졌습니다. (마디 숫자 모드는 자동 꺼짐)");
  }
  renderUi();
}

function stopCapture() {
  state.running = false;
  if (state.timerId) {
    clearInterval(state.timerId);
    state.timerId = null;
  }
  renderUi();
}

function clearCaptures() {
  state.captures = [];
  state.selectedIds.clear();
  state.lastImageData = null;
  state.lastFingerprint = null;
  state.lastMeasureImageData = null;
  state.lastMeasureFingerprint = null;
  state.prevMeasureImageData = null;
  state.measureChangeStartedAt = 0;
  state.lastPlayheadX = null;
  state.lastPlayheadPresent = false;
  state.cursorChangeStartedAt = 0;
  state.prevImageData = null;
  state.changeStartedAt = 0;
  renderThumbs();
  setMessage("캡처를 비웠습니다.");
  renderUi();
}

async function makePdf() {
  try {
    const columns = getPdfColumns();
    state.pdfColumns = columns;
    setMessage(`PDF 생성 중… (${columns}열)`);
    els.btnPdf.disabled = true;
    const blob = await buildPdf(state.captures, {
      columns,
      title: "Youtube Score Capture"
    });
    downloadBlob(blob, `score-${columns}col-${Date.now()}.pdf`);
    setMessage(`PDF 생성 완료 (${state.captures.length}장, ${columns}열)`);
  } catch (error) {
    setMessage(error.message || String(error), true);
  } finally {
    renderUi();
  }
}

els.btnShare.addEventListener("click", startShare);
els.btnRegion.addEventListener("click", () => beginRegionSelect("main"));
els.btnMeasureRegion.addEventListener("click", beginMeasureRegionSelect);
els.btnMeasureMode.addEventListener("click", toggleMeasureMode);
els.btnCursorMode.addEventListener("click", toggleCursorMode);
els.btnStart.addEventListener("click", startCapture);
els.btnStop.addEventListener("click", () => {
  stopCapture();
  setMessage("중지됨");
});
els.btnClear.addEventListener("click", clearCaptures);
els.btnDeleteSelected.addEventListener("click", deleteSelected);
els.btnSelectAll.addEventListener("click", selectAll);
els.btnSelectNone.addEventListener("click", selectNone);
els.btnPdf.addEventListener("click", makePdf);

document.querySelectorAll('input[name="pdfColumns"]').forEach((el) => {
  el.addEventListener("change", () => {
    state.pdfColumns = getPdfColumns();
    setMessage(`PDF 배열: ${state.pdfColumns}열`);
  });
});

els.sensitivity.addEventListener("input", () => {
  els.sensitivityValue.textContent = els.sensitivity.value;
  state.sensitivity = Number(els.sensitivity.value) / 100;
});
els.minInterval.addEventListener("input", () => {
  els.intervalValue.textContent = els.minInterval.value;
  state.minIntervalMs = Math.max(100, Number(els.minInterval.value) * 1000);
});

window.addEventListener("resize", syncOverlaySize);
els.preview.addEventListener("loadedmetadata", syncOverlaySize);

renderUi();

if (!hasDisplayMedia) {
  const siteUrl = "https://kimo9053.github.io/YoutubeScoreCapture-Web/";
  setMessage(mobileShareMessage(), true);
  if (els.empty) {
    els.empty.innerHTML = platform.isAndroid
      ? `갤럭시에서는 웹 화면 공유가 지원되지 않습니다.<br><br>PC Chrome/Edge에서 아래 주소로 접속해 주세요.<br><strong>${siteUrl}</strong>`
      : platform.isIOS
        ? `아이폰·아이패드에서는 웹 화면 공유가 지원되지 않습니다.<br><br>PC Chrome/Edge에서 아래 주소로 접속해 주세요.<br><strong>${siteUrl}</strong>`
        : "이 브라우저는 화면 공유를 지원하지 않습니다. PC Chrome/Edge로 접속해 주세요.";
  }
  if (els.installHint) {
    els.installHint.textContent = platform.isMobile
      ? "모바일에서는 홈 화면 추가만 가능하고, 악보 캡처는 PC 전용입니다."
      : els.installHint.textContent;
  }
} else if (!window.isSecureContext) {
  setMessage(
    "화면 공유·PWA는 localhost(또는 https)에서만 동작합니다. start.bat으로 실행하세요.",
    true
  );
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((err) => {
      console.warn("SW register failed", err);
    });
  });
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  if (els.btnInstall) els.btnInstall.hidden = false;
  if (els.installHint) {
    els.installHint.textContent = "설치 가능: 아래 ‘앱으로 설치’를 누르세요.";
  }
});

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  if (els.btnInstall) els.btnInstall.hidden = true;
  if (els.installHint) els.installHint.textContent = "홈 화면에 설치되었습니다.";
  setMessage("앱으로 설치되었습니다.");
});

els.btnInstall?.addEventListener("click", async () => {
  if (!deferredInstallPrompt) {
    setMessage("이 브라우저는 자동 설치를 지원하지 않습니다. 메뉴에서 홈 화면에 추가하세요.");
    return;
  }
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  els.btnInstall.hidden = true;
});
