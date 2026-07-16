import { compareImageData, fingerprint, fingerprintsSimilar } from "./diff.js";
import { buildPdf, downloadBlob } from "./pdf.js";

const $ = (id) => document.getElementById(id);

const els = {
  btnShare: $("btnShare"),
  btnRegion: $("btnRegion"),
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
  region: null,
  running: false,
  timerId: null,
  capturing: false,
  sensitivity: 0.2,
  minIntervalMs: 300,
  pdfColumns: 2,
  lastImageData: null,
  lastFingerprint: null,
  lastSavedAt: 0,
  captures: [],
  selectedIds: new Set()
};

const workCanvas = document.createElement("canvas");
const workCtx = workCanvas.getContext("2d", { willReadFrequently: true });
const cropCanvas = document.createElement("canvas");
const cropCtx = cropCanvas.getContext("2d", { willReadFrequently: true });

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

function renderUi() {
  const hasStream = Boolean(state.stream);
  const hasRegion = Boolean(state.region);
  const count = state.captures.length;
  const selected = state.selectedIds.size;

  els.btnRegion.disabled = !hasStream || state.running;
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
    ? "캡처 중"
    : hasRegion
      ? "준비됨"
      : hasStream
        ? "영역 지정 필요"
        : "대기";

  if (hasRegion) {
    els.regionText.textContent = `영역: ${state.region.w}×${state.region.h} px`;
  } else {
    els.regionText.textContent = "영역: 미지정";
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

function drawOverlay(tempRegion = null) {
  const ctx = els.overlay.getContext("2d");
  ctx.clearRect(0, 0, els.overlay.width, els.overlay.height);

  const region = tempRegion || state.region;
  const r = videoRectToOverlay(region);
  if (!r) return;

  ctx.fillStyle = "rgba(0,0,0,0.28)";
  ctx.fillRect(0, 0, els.overlay.width, els.overlay.height);
  ctx.clearRect(r.x, r.y, r.w, r.h);
  ctx.strokeStyle = "#e53935";
  ctx.lineWidth = Math.max(2, (window.devicePixelRatio || 1) * 2);
  ctx.strokeRect(r.x, r.y, r.w, r.h);
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
    els.preview.srcObject = stream;
    await els.preview.play();

    stream.getVideoTracks()[0].addEventListener("ended", () => {
      stopCapture();
      state.stream = null;
      els.preview.srcObject = null;
      state.region = null;
      setMessage("화면 공유가 종료되었습니다.");
      renderUi();
      drawOverlay();
    });

    setMessage("공유됨. 이제 악보 영역을 지정하세요.");
    renderUi();
    requestAnimationFrame(syncOverlaySize);
  } catch (error) {
    setMessage(error.message || "화면 공유가 취소되었습니다.", true);
    renderUi();
  }
}

function beginRegionSelect() {
  if (!state.stream) return;
  state.selecting = true;
  els.overlay.classList.add("selecting");
  setMessage("미리보기에서 악보 영역을 드래그하세요.");

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
    drawOverlay(current);
  };

  const cleanup = () => {
    els.overlay.removeEventListener("pointerdown", onDown);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("keydown", onKey);
    els.overlay.classList.remove("selecting");
    state.selecting = false;
  };

  const onUp = () => {
    if (!current || current.w < 8 || current.h < 8) {
      cleanup();
      setMessage("영역이 너무 작습니다. 다시 지정해 주세요.", true);
      drawOverlay();
      return;
    }
    state.region = current;
    cleanup();
    setMessage(`영역 지정됨 (${current.w}×${current.h})`);
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

function grabCrop() {
  const video = els.preview;
  const region = state.region;
  if (!video.videoWidth || !region) return null;

  workCanvas.width = video.videoWidth;
  workCanvas.height = video.videoHeight;
  workCtx.drawImage(video, 0, 0);

  const sx = Math.max(0, region.x);
  const sy = Math.max(0, region.y);
  const sw = Math.min(region.w, video.videoWidth - sx);
  const sh = Math.min(region.h, video.videoHeight - sy);
  if (sw < 1 || sh < 1) return null;

  cropCanvas.width = sw;
  cropCanvas.height = sh;
  cropCtx.drawImage(workCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
  const imageData = cropCtx.getImageData(0, 0, sw, sh);
  const dataUrl = cropCanvas.toDataURL("image/png");
  return { dataUrl, width: sw, height: sh, imageData };
}

function addCapture(cropped) {
  const item = {
    id: nextCaptureId++,
    dataUrl: cropped.dataUrl,
    width: cropped.width,
    height: cropped.height,
    createdAt: Date.now()
  };
  state.captures.push(item);
  renderThumbs();
  renderUi();
}

async function tick() {
  if (!state.running || state.capturing) return;
  state.capturing = true;
  try {
    const cropped = grabCrop();
    if (!cropped) return;

    const now = Date.now();
    if (!state.lastImageData) {
      addCapture(cropped);
      state.lastImageData = cropped.imageData;
      state.lastFingerprint = fingerprint(cropped.imageData);
      state.lastSavedAt = now;
      setMessage("첫 프레임 저장");
      return;
    }

    const { changeRatio } = compareImageData(state.lastImageData, cropped.imageData);
    if (changeRatio < state.sensitivity) return;
    if (now - state.lastSavedAt < state.minIntervalMs) return;

    const fp = fingerprint(cropped.imageData);
    if (fingerprintsSimilar(state.lastFingerprint, fp)) return;

    addCapture(cropped);
    state.lastImageData = cropped.imageData;
    state.lastFingerprint = fp;
    state.lastSavedAt = now;
    setMessage(`저장됨 (변화 ${(changeRatio * 100).toFixed(1)}%)`);
  } catch (error) {
    setMessage(error.message || String(error), true);
  } finally {
    state.capturing = false;
  }
}

function startCapture() {
  if (!state.stream || !state.region) {
    setMessage("화면 공유와 영역 지정이 필요합니다.", true);
    return;
  }
  state.running = true;
  state.lastImageData = null;
  state.lastFingerprint = null;
  state.lastSavedAt = 0;
  state.timerId = setInterval(tick, 100);
  tick();
  setMessage("캡처 중…");
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
els.btnRegion.addEventListener("click", beginRegionSelect);
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
});
els.sensitivity.addEventListener("change", () => {
  state.sensitivity = Number(els.sensitivity.value) / 100;
});
els.minInterval.addEventListener("input", () => {
  els.intervalValue.textContent = els.minInterval.value;
});
els.minInterval.addEventListener("change", () => {
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
