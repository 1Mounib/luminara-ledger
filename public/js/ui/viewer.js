/**
 * Document viewer with source highlighting (FR-021, NFR-010).
 * Shows the original document and draws a gold box around the exact line
 * a number came from, using the bounding box saved when it was read.
 */
import * as pdfjsLib from '/vendor/pdfjs/pdf.min.mjs';
import { loadFile } from '../engine/vault.js';
import { escapeHtml } from './common.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
export { pdfjsLib };

/**
 * Draws a document into a container and highlights some of its lines.
 * @param {HTMLElement} container
 * @param {object} doc  { docId, docName, kind, items }
 * @param {string[]} highlightIds  line IDs to highlight
 */
export async function renderDocument(container, doc, highlightIds = []) {
  container.innerHTML = '<div class="viewer-loading">Opening document...</div>';
  const blob = await loadFile(doc.docId);
  if (!blob) { container.innerHTML = '<p class="muted">The original file is not stored on this device.</p>'; return; }
  const wanted = new Set(highlightIds);
  const items = (doc.items || []).filter((i) => i.docId === doc.docId);

  if (doc.kind === 'csv') {
    const rows = items;
    const headers = rows[0]?.cells ? Object.keys(rows[0].cells) : [];
    container.innerHTML = `<div class="csv-view"><table><thead><tr><th>#</th>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${rows
      .map((r) => `<tr class="${wanted.has(r.id) ? 'hl' : ''}" data-id="${escapeHtml(r.id)}"><td>${r.row}</td>${headers.map((h) => `<td>${escapeHtml(r.cells[h])}</td>`).join('')}</tr>`)
      .join('')}</tbody></table></div>`;
    container.querySelector('tr.hl')?.scrollIntoView({ block: 'center' });
    return;
  }

  const page = items.find((i) => wanted.has(i.id))?.page || 1;
  const stage = document.createElement('div');
  stage.className = 'doc-stage';

  if (doc.kind === 'pdf') {
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
    const p = await pdf.getPage(page);
    const width = Math.min(container.clientWidth || 640, 820);
    const viewport = p.getViewport({ scale: width / p.getViewport({ scale: 1 }).width });
    const canvas = document.createElement('canvas');
    const ratio = window.devicePixelRatio || 1;
    canvas.width = viewport.width * ratio;
    canvas.height = viewport.height * ratio;
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    await p.render({ canvasContext: canvas.getContext('2d'), viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null }).promise;
    stage.style.width = `${viewport.width}px`;
    stage.append(canvas);
  } else {
    const img = document.createElement('img');
    img.src = URL.createObjectURL(blob);
    img.alt = doc.docName;
    await img.decode();
    stage.append(img);
  }

  // Gold boxes over the source lines (bbox is on a 0-1000 scale)
  for (const item of items.filter((i) => wanted.has(i.id) && i.page === page && i.bbox)) {
    const [x0, y0, x1, y1] = item.bbox;
    const box = document.createElement('div');
    box.className = 'hl-box';
    box.style.cssText = `left:${x0 / 10 - 0.6}%;top:${y0 / 10 - 0.4}%;width:${(x1 - x0) / 10 + 1.2}%;height:${(y1 - y0) / 10 + 0.8}%`;
    box.title = item.text;
    stage.append(box);
  }
  container.innerHTML = '';
  container.append(stage);
  stage.querySelector('.hl-box')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/** Opens the viewer in a pop-up window over the page. */
export function openViewer(doc, highlightIds, caption = '') {
  const dialog = document.createElement('dialog');
  dialog.className = 'viewer-dialog';
  dialog.innerHTML = `<header><div><b>${escapeHtml(doc.docName)}</b><small>${escapeHtml(caption)}</small></div><button class="btn ghost small" data-close>Close</button></header><div class="viewer-body"></div>`;
  document.body.append(dialog);
  dialog.showModal();
  dialog.addEventListener('close', () => dialog.remove());
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  renderDocument(dialog.querySelector('.viewer-body'), doc, highlightIds);
}
