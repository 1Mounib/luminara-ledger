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
  const wanted = new Set(highlightIds);
  const items = (doc.items || []).filter((i) => i.docId === doc.docId);
  const page = items.find((i) => wanted.has(i.id))?.page || 1;
  const key = `${doc.docId}|${doc.kind === 'csv' ? 1 : page}`;

  // Same document and page already on screen? Only move the highlight (no flicker).
  if (container._key === key && container.querySelector('.doc-stage, .recon-page, .csv-view')) {
    container._renderToken = (container._renderToken || 0) + 1; // cancel any slower render still running
    highlight(container, doc, items, wanted, page);
    return;
  }
  const token = (container._renderToken = (container._renderToken || 0) + 1);
  const stale = () => container._renderToken !== token; // a newer request has started
  const loading = setTimeout(() => { if (!stale()) container.innerHTML = '<div class="viewer-loading">Opening document...</div>'; }, 200);

  try {
    const blob = await loadFile(doc.docId).catch(() => null);
    if (stale()) return;
    const masked = !blob; // original not on this device -> show the masked copy from the database

    if (doc.kind === 'csv') {
      const headers = items[0]?.cells ? Object.keys(items[0].cells) : [];
      container.innerHTML = `${masked ? MASKED_NOTE : ''}<div class="csv-view"><table><thead><tr><th>#</th>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${items
        .map((r) => `<tr data-id="${escapeHtml(r.id)}"><td>${r.row ?? ''}</td>${headers.map((h) => `<td>${showTokens(r.cells?.[h])}</td>`).join('')}</tr>`)
        .join('')}</tbody></table></div>`;
    } else if (masked) {
      // Rebuild the page from the masked lines and their saved positions
      const lines = items.filter((i) => (i.page || 1) === page && i.bbox);
      if (!lines.length) { container.innerHTML = '<p class="muted">This document has no saved layout.</p>'; return; }
      container.innerHTML = `${MASKED_NOTE}<div class="recon-page">${lines.map((l) => {
        const [x0, y0, , y1] = l.bbox;
        return `<div class="recon-line" style="left:${x0 / 10}%;top:${y0 / 10}%;max-width:${100 - x0 / 10}%;height:${Math.max(1.4, (y1 - y0) / 10)}%">${showTokens(l.text)}</div>`;
      }).join('')}</div>`;
    } else {
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
      if (stale()) return;
      container.innerHTML = '';
      container.append(stage);
    }
    container._key = key;
    highlight(container, doc, items, wanted, page);
  } finally {
    clearTimeout(loading);
  }
}

/** Draws the gold boxes (or row highlights) for the wanted lines. bbox is on a 0-1000 scale. */
function highlight(container, doc, items, wanted, page) {
  if (doc.kind === 'csv') {
    container.querySelectorAll('tr[data-id]').forEach((tr) => tr.classList.toggle('hl', wanted.has(tr.dataset.id)));
    scrollIfHidden(container.querySelector('tr.hl'), container);
    return;
  }
  const surface = container.querySelector('.doc-stage, .recon-page');
  if (!surface) return;
  surface.querySelectorAll('.hl-box').forEach((b) => b.remove());
  for (const item of items.filter((i) => wanted.has(i.id) && (i.page || 1) === page && i.bbox)) {
    const [x0, y0, x1, y1] = item.bbox;
    const box = document.createElement('div');
    box.className = 'hl-box';
    box.style.cssText = `left:${x0 / 10 - 0.6}%;top:${y0 / 10 - 0.4}%;width:${(x1 - x0) / 10 + 1.2}%;height:${(y1 - y0) / 10 + 0.8}%`;
    box.title = item.text;
    surface.append(box);
  }
  scrollIfHidden(surface.querySelector('.hl-box'), container);
}

/**
 * Scrolls ONLY the document box (never the whole page) and only when the
 * highlight is out of view, so nothing jumps around.
 */
function scrollIfHidden(el, container) {
  if (!el) return;
  const pane = container.closest('.doc-pane, .viewer-body') || container;
  const box = el.getBoundingClientRect();
  const view = pane.getBoundingClientRect();
  if (box.top >= view.top && box.bottom <= view.bottom) return;
  pane.scrollTop += box.top - view.top - (view.height - box.height) / 2;
}

const MASKED_NOTE = '<p class="viewer-note">The original file stays on the client\'s own device. This is the <b>masked copy</b> rebuilt from the database: private details appear as tokens such as &lt;PII_PERSON_1&gt;.</p>';

/** Escapes text and styles the PII tokens so they stand out. */
function showTokens(text) {
  return escapeHtml(text).replace(/&lt;PII_[A-Z]+_\d+&gt;/g, (t) => `<span class="tok">${t}</span>`);
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
