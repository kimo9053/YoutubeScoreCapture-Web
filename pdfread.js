/** Extract embedded JPEG (DCTDecode) images from a PDF, in file order. */

export async function extractPdfImages(buffer) {
  const bytes = new Uint8Array(buffer);
  const text = new TextDecoder("latin1").decode(bytes);
  const found = [];
  const seen = new Set();
  const filterRe = /\/DCTDecode/g;
  let m;
  while ((m = filterRe.exec(text))) {
    const objStart = text.lastIndexOf(" obj", m.index);
    const streamKw = text.indexOf("stream", m.index);
    if (objStart < 0 || streamKw < 0 || seen.has(objStart)) continue;
    const dict = text.slice(objStart, streamKw);
    if (!/\/Subtype\s*\/Image/.test(dict)) continue;
    seen.add(objStart);

    let dataStart = streamKw + "stream".length;
    if (text[dataStart] === "\r") dataStart += 1;
    if (text[dataStart] === "\n") dataStart += 1;

    let length = -1;
    const direct = dict.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/);
    if (direct) length = Number(direct[1]);
    if (length <= 0 || dataStart + length > bytes.length) {
      const end = text.indexOf("endstream", dataStart);
      if (end < 0) continue;
      length = end - dataStart;
      while (length > 0 && (bytes[dataStart + length - 1] === 0x0a || bytes[dataStart + length - 1] === 0x0d)) {
        length -= 1;
      }
    }
    const width = Number(dict.match(/\/Width\s+(\d+)/)?.[1] || 0);
    const height = Number(dict.match(/\/Height\s+(\d+)/)?.[1] || 0);
    found.push({
      blob: new Blob([bytes.slice(dataStart, dataStart + length)], { type: "image/jpeg" }),
      width,
      height
    });
  }
  return found;
}
