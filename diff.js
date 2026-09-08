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
      if (!isRedHighlightLoose(data[i], data[i + 1], data[i + 2], data[i + 3])) continue;
      cols[x] += 1;
      count += 1;
    }
  }

  const minCount = Math.max(8, Math.round(height * 0.03));
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

  const band = Math.max(3, Math.round(width * 0.025));
  let inBand = 0;
  let minX = width;
  let maxX = 0;
  for (let x = Math.max(0, peakX - band); x <= Math.min(width - 1, peakX + band); x += 1) {
    if (!cols[x]) continue;
    inBand += cols[x];
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
  }

  // 세로 선이 아니면(퍼진 빨간 UI) 커서로 보지 않음
  if (inBand / count < 0.25 || peak < height * 0.025) {
    return { present: false, x: null, minX: null, maxX: null, width: 0, count };
  }

  return {
    present: true,
    x: peakX,
    minX,
    maxX,
    width: Math.max(1, maxX - minX + 1),
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
