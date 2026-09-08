/** Red playhead-aware image diff (browser). */

const RED_R_MIN = 160;
const RED_G_MAX = 120;
const RED_B_MAX = 120;
const RED_DOMINANCE = 40;

function isRedHighlight(r, g, b, a) {
  if (a < 40) return true;
  return r >= RED_R_MIN && g <= RED_G_MAX && b <= RED_B_MAX && r - Math.max(g, b) >= RED_DOMINANCE;
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
