/** Red playhead-aware image diff (browser). */

const RED_R_MIN = 160;
const RED_G_MAX = 120;
const RED_B_MAX = 120;
const RED_DOMINANCE = 40;

function isRedHighlight(r, g, b, a) {
  if (a < 40) return true;
  return r >= RED_R_MIN && g <= RED_G_MAX && b <= RED_B_MAX && r - Math.max(g, b) >= RED_DOMINANCE;
}

/** 2배속 모션블러로 흐려진 재생선도 포함 */
function isRedHighlightLoose(r, g, b, a) {
  if (a < 40) return true;
  return r >= 130 && r > g + 12 && r > b + 12 && g <= 170 && b <= 170;
}

/** 유튜브 공식 악보의 현재 음 파란/청록 칸 */
function isBlueHighlight(r, g, b, a) {
  if (a < 40) return false;
  return b >= 120 && b - Math.max(r, g) >= 16 && r <= 215 && g <= 235;
}

function isPlayheadPixel(r, g, b, a) {
  return isRedHighlightLoose(r, g, b, a) || isBlueHighlight(r, g, b, a);
}

function grayOf(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

export function compareImageData(a, b, options = {}) {
  const pixelThreshold = options.pixelThreshold ?? 28;

  if (!a || !b || a.width !== b.width || a.height !== b.height) {
    return { changeRatio: 1, comparedPixels: 0, changedPixels: 0 };
  }

  const da = a.data;
  const db = b.data;
  let compared = 0;
  let changed = 0;

  for (let i = 0; i < da.length; i += 4) {
    const r1 = da[i];
    const g1 = da[i + 1];
    const b1 = da[i + 2];
    const a1 = da[i + 3];
    const r2 = db[i];
    const g2 = db[i + 1];
    const b2 = db[i + 2];
    const a2 = db[i + 3];

    if (isRedHighlight(r1, g1, b1, a1) || isRedHighlight(r2, g2, b2, a2)) {
      continue;
    }

    compared += 1;
    if (Math.abs(grayOf(r1, g1, b1) - grayOf(r2, g2, b2)) >= pixelThreshold) {
      changed += 1;
    }
  }

  if (compared === 0) {
    return { changeRatio: 0, comparedPixels: 0, changedPixels: 0 };
  }

  return {
    changeRatio: changed / compared,
    comparedPixels: compared,
    changedPixels: changed
  };
}

/** 유튜브 공식 악보처럼 흰 용지+검은 줄이 아직 보이는지 */
export function analyzeScorePresence(imageData) {
  if (!imageData || !imageData.data || !imageData.width) {
    return { present: false, lightRatio: 0, inkRatio: 0 };
  }

  const data = imageData.data;
  let light = 0;
  let ink = 0;
  const total = data.length / 4;

  for (let i = 0; i < data.length; i += 4) {
    const gray = grayOf(data[i], data[i + 1], data[i + 2]);
    if (gray >= 214) light += 1;
    else if (gray <= 96) ink += 1;
  }

  const lightRatio = total ? light / total : 0;
  const inkRatio = total ? ink / total : 0;
  return {
    present: lightRatio >= 0.3 && inkRatio >= 0.003,
    lightRatio,
    inkRatio
  };
}

export function fingerprint(imageData, size = 16) {
  const { width, height, data } = imageData;
  const values = [];

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const sx = Math.min(width - 1, Math.floor(((x + 0.5) / size) * width));
      const sy = Math.min(height - 1, Math.floor(((y + 0.5) / size) * height));
      const i = (sy * width + sx) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];
      if (isRedHighlight(r, g, b, a)) values.push(-1);
      else values.push(Math.round(grayOf(r, g, b)));
    }
  }

  return values.join(",");
}

/** 마디 숫자처럼 작은 잉크 영역 비교. 흰 배경·빨간 커서는 제외. */
export function compareMeasureInk(a, b) {
  const WHITE = 228;
  const pixelThreshold = 30;

  if (!a || !b || a.width !== b.width || a.height !== b.height) {
    return { changeRatio: 1, inkPixels: 0, changedPixels: 0 };
  }

  const da = a.data;
  const db = b.data;
  let ink = 0;
  let changed = 0;

  for (let i = 0; i < da.length; i += 4) {
    const r1 = da[i];
    const g1 = da[i + 1];
    const b1 = da[i + 2];
    const a1 = da[i + 3];
    const r2 = db[i];
    const g2 = db[i + 1];
    const b2 = db[i + 2];
    const a2 = db[i + 3];

    if (isRedHighlight(r1, g1, b1, a1) || isRedHighlight(r2, g2, b2, a2)) continue;

    const gray1 = grayOf(r1, g1, b1);
    const gray2 = grayOf(r2, g2, b2);
    if (gray1 >= WHITE && gray2 >= WHITE) continue;

    ink += 1;
    if (Math.abs(gray1 - gray2) >= pixelThreshold) changed += 1;
  }

  if (ink < 8) {
    return { changeRatio: 0, inkPixels: ink, changedPixels: 0 };
  }

  return {
    changeRatio: changed / ink,
    inkPixels: ink,
    changedPixels: changed
  };
}

export function detectPlayhead(imageData) {
  const { width, height, data } = imageData;
  const cols = new Uint32Array(width);
  let count = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      if (!isPlayheadPixel(data[i], data[i + 1], data[i + 2], data[i + 3])) continue;
      cols[x] += 1;
      count += 1;
    }
  }

  const minCount = Math.max(6, Math.round(height * 0.012));
  if (count < minCount) {
    return { present: false, x: null, minX: null, maxX: null, width: 0, count };
  }

  let peakX = 0;
  let peak = 0;
  for (let x = 0; x < width; x += 1) {
    if (cols[x] > peak) {
      peak = cols[x];
      peakX = x;
    }
  }

  const band = Math.max(4, Math.round(width * 0.03));
  let inBand = 0;
  let minX = width;
  let maxX = 0;
  for (let x = Math.max(0, peakX - band); x <= Math.min(width - 1, peakX + band); x += 1) {
    if (!cols[x]) continue;
    inBand += cols[x];
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
  }

  const blobWidth = Math.max(1, maxX - minX + 1);
  const compact = blobWidth <= Math.max(14, width * 0.08);
  const tallEnough = peak >= Math.max(5, height * 0.012);
  const clustered = count > 0 && inBand / count >= 0.16;

  // 세로 재생선 또는 음표 위 작은 파란/빨간 칸
  if (!tallEnough || (!compact && !clustered)) {
    return { present: false, x: null, minX: null, maxX: null, width: 0, count };
  }

  return {
    present: true,
    x: peakX,
    minX,
    maxX,
    width: blobWidth,
    count
  };
}

export function fingerprintsSimilar(fpA, fpB, maxDiffRatio = 0.08) {
  if (!fpA || !fpB || fpA === fpB) return fpA === fpB;
  const a = fpA.split(",").map(Number);
  const b = fpB.split(",").map(Number);
  if (a.length !== b.length) return false;

  let compared = 0;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] < 0 || b[i] < 0) continue;
    compared += 1;
    if (Math.abs(a[i] - b[i]) > 18) diff += 1;
  }
  if (compared === 0) return true;
  return diff / compared <= maxDiffRatio;
}
