/** Minimal A4 PDF builder — 2-column image layout. */

async function toJpegBytes(dataUrl, quality = 0.92) {
  const img = await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0);
  const jpegDataUrl = canvas.toDataURL("image/jpeg", quality);
  const base64 = jpegDataUrl.split(",")[1];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return { bytes, width: canvas.width, height: canvas.height };
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("이미지 로드 실패"));
    img.src = dataUrl;
  });
}

function escapePdfText(text) {
  return String(text).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

export async function buildPdf(images, options = {}) {
  const columns = options.columns ?? 2;
  const margin = options.margin ?? 36;
  const gap = options.gap ?? 16;
  const pageWidth = 595.28;
  const pageHeight = 841.89;

  if (!images.length) throw new Error("저장할 이미지가 없습니다.");

  const usableWidth = pageWidth - margin * 2 - gap * (columns - 1);
  const cellWidth = usableWidth / columns;

  const prepared = [];
  for (const image of images) {
    prepared.push(await toJpegBytes(image.dataUrl));
  }

  const pages = [[]];
  let col = 0;
  let rowY = pageHeight - margin - (options.title ? 18 : 0);
  let rowHeight = 0;

  prepared.forEach((img, jpegIndex) => {
    const drawW = cellWidth;
    const drawH = (img.height / img.width) * drawW;

    const placeOnNewPage = () => {
      pages.push([]);
      col = 0;
      rowY = pageHeight - margin;
      rowHeight = 0;
    };

    if (col === 0) {
      if (rowY - drawH < margin) placeOnNewPage();
      rowHeight = drawH;
    } else if (rowY - Math.max(rowHeight, drawH) < margin) {
      placeOnNewPage();
      rowHeight = drawH;
    } else {
      rowHeight = Math.max(rowHeight, drawH);
    }

    pages[pages.length - 1].push({
      jpegIndex,
      x: margin + col * (cellWidth + gap),
      y: rowY - drawH,
      w: drawW,
      h: drawH
    });

    col += 1;
    if (col >= columns) {
      rowY -= rowHeight + gap;
      col = 0;
      rowHeight = 0;
    }
  });

  const encoder = new TextEncoder();
  const objectBodies = [];
  const add = (body) => {
    objectBodies.push(body);
    return objectBodies.length;
  };

  const imageIds = prepared.map((img) =>
    add({
      image: {
        dict:
          `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} ` +
          `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.bytes.length} >>`,
        data: img.bytes
      }
    })
  );

  const fontId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const pageIds = [];

  pages.forEach((placements, pageIndex) => {
    let content = "q\n";
    if (pageIndex === 0 && options.title) {
      content += `BT /F1 10 Tf ${margin} ${(pageHeight - 24).toFixed(2)} Td (${escapePdfText(options.title)}) Tj ET\n`;
    }
    const xObjectEntries = [];
    placements.forEach((pl) => {
      const name = `Im${pl.jpegIndex}`;
      xObjectEntries.push(`/${name} ${imageIds[pl.jpegIndex]} 0 R`);
      content += `q ${pl.w.toFixed(2)} 0 0 ${pl.h.toFixed(2)} ${pl.x.toFixed(2)} ${pl.y.toFixed(2)} cm /${name} Do Q\n`;
    });
    content += "Q\n";

    const contentId = add({ stream: encoder.encode(content) });
    const resources =
      `<< /ProcSet [/PDF /Text /ImageC] /XObject << ${xObjectEntries.join(" ")} >> /Font << /F1 ${fontId} 0 R >> >>`;
    pageIds.push(
      add(
        `<< /Type /Page /Parent ___PAGES___ /MediaBox [0 0 ${pageWidth} ${pageHeight}] ` +
          `/Resources ${resources} /Contents ${contentId} 0 R >>`
      )
    );
  });

  const pagesId = add(
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`
  );

  for (const pageId of pageIds) {
    objectBodies[pageId - 1] = String(objectBodies[pageId - 1]).replace(
      "___PAGES___",
      `${pagesId} 0 R`
    );
  }

  const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  return serialize(objectBodies, catalogId, encoder);
}

function serialize(objectBodies, catalogId, encoder) {
  const chunks = [];
  let offset = 0;
  const offsets = [0];
  const pushBytes = (bytes) => {
    chunks.push(bytes);
    offset += bytes.length;
  };
  const pushText = (text) => pushBytes(encoder.encode(text));

  pushText("%PDF-1.4\n");
  for (let i = 0; i < objectBodies.length; i += 1) {
    offsets.push(offset);
    const body = objectBodies[i];
    pushText(`${i + 1} 0 obj\n`);
    if (body?.image) {
      pushText(`${body.image.dict}\nstream\n`);
      pushBytes(body.image.data);
      pushText("\nendstream\nendobj\n");
    } else if (body?.stream) {
      pushText(`<< /Length ${body.stream.length} >>\nstream\n`);
      pushBytes(body.stream);
      pushText("\nendstream\nendobj\n");
    } else {
      pushText(`${body}\nendobj\n`);
    }
  }

  const xrefStart = offset;
  pushText(`xref\n0 ${objectBodies.length + 1}\n`);
  pushText("0000000000 65535 f \n");
  for (let i = 1; i < offsets.length; i += 1) {
    pushText(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
  }
  pushText(`trailer\n<< /Size ${objectBodies.length + 1} /Root ${catalogId} 0 R >>\n`);
  pushText(`startxref\n${xrefStart}\n%%EOF`);

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const chunk of chunks) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  return new Blob([out], { type: "application/pdf" });
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
