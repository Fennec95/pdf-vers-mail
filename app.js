/* PDF → Mail
 * Transforme un PDF (Canva) en mail HTML compatible Outlook :
 * chaque page est rendue en haute définition puis découpée en images,
 * les zones de lien devenant des images cliquables.
 * Tout est traité localement, sur l'appareil. */
'use strict';
(function () {
  const pdfjsLib = window.pdfjsLib;
  const $ = (sel, root = document) => root.querySelector(sel);

  // ---------- Réglages techniques ----------
  const QUALITY = {
    light: { scale: 1.5, mime: 'image/jpeg', q: 0.8 },
    reco:  { scale: 2,   mime: 'image/jpeg', q: 0.88 },
    high:  { scale: 2,   mime: 'image/jpeg', q: 0.95 },
    max:   { scale: 2,   mime: 'image/png' }
  };
  const MAX_SLICE_PX = 1600;   // Outlook Windows rogne les images de plus de 1728 px de haut
  const MAX_CANVAS_PX = 16e6;  // limite de taille des canvas sur iPad
  const SNAP = 4;              // fusionne les découpes trop proches (px)
  const EMAIL_RE = /^[^\s@:/]+@[^\s@:/]+\.[^\s@:/]+$/;
  const SAFE_URL_RE = /^(https?|mailto|tel|ftp):/i;

  // pdf.js : vrai « worker » quand la page est servie, mode intégré en file://
  const workerReady = location.protocol === 'file:'
    ? loadScript('lib/pdf.worker.min.js')
    : Promise.resolve().then(() => { pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js'; });

  const state = { pdf: null, fileName: '', pages: [], addMode: false, sel: null, build: null, buildSig: '', output: null };
  const settings = { subject: '', to: '', preheader: '', width: 600, bg: '#ffffff', bgAuto: true, gap: 0, margin: 0, quality: 'reco' };
  const SAVED_KEYS = ['width', 'quality', 'gap', 'margin'];
  let uid = 0;

  try {
    const saved = JSON.parse(localStorage.getItem('pdfmail-settings') || '{}');
    SAVED_KEYS.forEach(k => { if (saved[k] != null) settings[k] = saved[k]; });
  } catch (e) { /* stockage indisponible */ }

  function saveSettings() {
    try {
      const out = {};
      SAVED_KEYS.forEach(k => { out[k] = settings[k]; });
      localStorage.setItem('pdfmail-settings', JSON.stringify(out));
    } catch (e) { /* stockage indisponible */ }
  }

  // ---------- Utilitaires ----------
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Chargement impossible : ' + src));
      document.head.appendChild(s);
    });
  }
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = n => String(n).padStart(3, '0');
  const fmtBytes = b => b < 1024 * 1024 ? Math.max(1, Math.round(b / 1024)) + ' Ko' : (b / 1024 / 1024).toLocaleString('fr-FR', { maximumFractionDigits: 1 }) + ' Mo';
  const toHex = (r, g, b) => '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');

  function canvasToBlob(canvas, mime, q) {
    return new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('Image trop grande pour cet appareil')), mime, q));
  }
  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }
  function freeCanvas(c) { c.width = 0; c.height = 0; }

  function utf8ToB64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function wrap76(b64) {
    const out = [];
    for (let i = 0; i < b64.length; i += 76) out.push(b64.slice(i, i + 76));
    return out.join('\r\n');
  }
  // Objet encodé en UTF-8 (RFC 2047), découpé en mots de 75 caractères max.
  function encodeHeader(str) {
    str = String(str).replace(/[\r\n]+/g, ' ');
    if (/^[\x20-\x7e]*$/.test(str)) return str;
    const words = [];
    let chunk = '';
    for (const ch of str) {
      if (new TextEncoder().encode(chunk + ch).length > 45) { words.push(chunk); chunk = ''; }
      chunk += ch;
    }
    if (chunk) words.push(chunk);
    return words.map(w => '=?UTF-8?B?' + utf8ToB64(w) + '?=').join('\r\n ');
  }

  function normalizeUrl(raw, type) {
    const s = String(raw || '').trim();
    if (!s) return '';
    if (SAFE_URL_RE.test(s)) return s.replace(/^[a-z]+:/i, m => m.toLowerCase());
    if (/^[a-z][\w+.-]*:(?!\d)/i.test(s)) return '';            // javascript:, data:… refusés
    if (type === 'tel' || (!type && /^\+?[\d\s.()-]{6,}$/.test(s))) return 'tel:' + s.replace(/[^\d+]/g, '');
    if (type === 'mail' || EMAIL_RE.test(s)) return 'mailto:' + s.replace(/^mailto:/i, '');
    return 'https://' + s.replace(/^\/+/, '');
  }
  const urlType = url => /^mailto:/i.test(url) ? 'mail' : /^tel:/i.test(url) ? 'tel' : 'web';

  // ---------- Interface : éléments ----------
  const els = {
    start: $('#start'), workspace: $('#workspace'), drop: $('#drop'),
    fileInput: $('#fileInput'), fileInput2: $('#fileInput2'), btnNew: $('#btnNew'), fileLabel: $('#fileLabel'),
    pages: $('#pages'), btnAdd: $('#btnAddLink'), modeHint: $('#modeHint'),
    subject: $('#optSubject'), to: $('#optTo'), preheader: $('#optPreheader'),
    width: $('#optWidth'), quality: $('#optQuality'), bg: $('#optBg'), bgHex: $('#optBgHex'), bgAuto: $('#btnBgAuto'),
    gap: $('#optGap'), margin: $('#optMargin'),
    linkList: $('#linkList'), linkCount: $('#linkCount'), btnBuild: $('#btnBuild'),
    progress: $('#progress'), progressText: $('#progressText'), progressBar: $('#progressBar'), toast: $('#toast'),
    linkDialog: $('#linkDialog'), linkInput: $('#linkInput'), linkLabel: $('#linkLabel'), linkResult: $('#linkResult'),
    linkTitle: $('#linkTitle'), linkDelete: $('#linkDelete'),
    resultDialog: $('#resultDialog'), frame: $('#previewFrame'), frameWrap: $('#frameWrap'),
    resSize: $('#resSize'), resWarn: $('#resWarn'), btnShare: $('#btnShare'),
    helpDialog: $('#helpDialog')
  };

  let toastTimer = 0;
  function toast(msg, ms = 3200) {
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), ms);
  }
  function showProgress(text, frac) {
    els.progress.hidden = false;
    els.progressText.textContent = text;
    els.progressBar.style.width = Math.round((frac || 0) * 100) + '%';
  }
  const hideProgress = () => { els.progress.hidden = true; };

  // ---------- Ouverture du PDF ----------
  [els.fileInput, els.fileInput2].forEach(inp => inp.addEventListener('change', () => {
    const f = inp.files && inp.files[0];
    inp.value = '';
    openFile(f);
  }));
  ['dragenter', 'dragover'].forEach(t => document.addEventListener(t, e => {
    e.preventDefault();
    els.drop.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach(t => document.addEventListener(t, e => {
    e.preventDefault();
    if (t === 'drop' || e.target === els.drop) els.drop.classList.remove('over');
  }));
  document.addEventListener('drop', e => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) openFile(f);
  });

  async function openFile(file) {
    if (!file) return;
    if (!/pdf$/i.test(file.type) && !/\.pdf$/i.test(file.name)) { toast("Ce fichier n'est pas un PDF."); return; }
    showProgress('Ouverture du PDF…', 0);
    try {
      await workerReady;
      const data = new Uint8Array(await file.arrayBuffer());
      const pdf = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
      if (state.pdf) state.pdf.destroy();
      state.pages.forEach(p => p.previewUrl && URL.revokeObjectURL(p.previewUrl));
      Object.assign(state, { pdf, fileName: file.name.replace(/\.pdf$/i, ''), pages: [], sel: null, build: null, buildSig: '', output: null });

      for (let i = 1; i <= pdf.numPages; i++) {
        showProgress(`Lecture de la page ${i} / ${pdf.numPages}…`, (i - 1) / pdf.numPages * 0.3);
        const page = await pdf.getPage(i);
        const vp = page.getViewport({ scale: 1 });
        state.pages.push({
          num: i, w: vp.width, h: vp.height, include: true,
          links: await readLinks(page, vp),
          text: await readText(page, vp),
          previewUrl: null, el: null
        });
      }
      settings.subject = state.fileName.replace(/[_-]+/g, ' ').trim();
      settings.bgAuto = true;
      els.fileLabel.textContent = file.name;
      els.start.hidden = true;
      els.workspace.hidden = false;
      els.btnNew.hidden = false;
      setAddMode(false);
      syncInputs();
      buildPageEls();
      refreshLinks();
      await renderPreviews();
      const n = state.pages.reduce((s, p) => s + p.links.length, 0);
      toast(n ? `${pdf.numPages} page(s) · ${n} lien(s) repris du PDF` : `${pdf.numPages} page(s) · aucun lien dans le PDF, vous pouvez en dessiner`);
    } catch (err) {
      console.error(err);
      toast('Impossible de lire ce PDF : ' + (err && err.message || err), 6000);
    } finally {
      hideProgress();
    }
  }

  async function readLinks(page, vp) {
    const out = [];
    for (const a of await page.getAnnotations()) {
      if (a.subtype !== 'Link') continue;
      const url = a.url || a.unsafeUrl;
      if (!url || !SAFE_URL_RE.test(url)) continue;     // liens internes / douteux ignorés
      const r = vp.convertToViewportRectangle(a.rect);
      const x0 = Math.min(r[0], r[2]), x1 = Math.max(r[0], r[2]);
      const y0 = Math.min(r[1], r[3]), y1 = Math.max(r[1], r[3]);
      const link = {
        id: ++uid, url, auto: true,
        x: clamp(x0 / vp.width, 0, 1), y: clamp(y0 / vp.height, 0, 1),
        w: (Math.min(x1, vp.width) - Math.max(x0, 0)) / vp.width,
        h: (Math.min(y1, vp.height) - Math.max(y0, 0)) / vp.height
      };
      if (link.w > 0.002 && link.h > 0.002) out.push(link);
    }
    return out;
  }

  async function readText(page, vp) {
    const tc = await page.getTextContent();
    const items = [];
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const t = pdfjsLib.Util.transform(vp.transform, it.transform);
      const fh = Math.hypot(t[2], t[3]) || 1;
      items.push({ x: t[4] / vp.width, y: (t[5] - fh) / vp.height, w: it.width / vp.width, h: fh / vp.height, s: it.str });
    }
    return items;
  }

  async function renderPage(page, scale) {
    let vp = page.getViewport({ scale });
    if (vp.width * vp.height > MAX_CANVAS_PX) {
      scale *= Math.sqrt(MAX_CANVAS_PX / (vp.width * vp.height));
      vp = page.getViewport({ scale });
    }
    const c = document.createElement('canvas');
    c.width = Math.floor(vp.width);
    c.height = Math.floor(vp.height);
    const ctx = c.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return c;
  }

  // Couleur la plus fréquente aux 4 coins de la page
  function sampleBg(canvas) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const counts = {};
    [[2, 2], [w - 3, 2], [2, h - 3], [w - 3, h - 3]].forEach(([x, y]) => {
      const d = ctx.getImageData(x, y, 1, 1).data;
      const hex = toHex(d[0], d[1], d[2]);
      counts[hex] = (counts[hex] || 0) + 1;
    });
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  }

  // ---------- Pages et zones de lien ----------
  function buildPageEls() {
    els.pages.innerHTML = '';
    for (const p of state.pages) {
      const wrap = document.createElement('div');
      wrap.className = 'page-wrap';
      wrap.innerHTML =
        `<div class="page-head"><span>Page ${p.num}</span>` +
        `<label class="check"><input type="checkbox" checked> Inclure</label></div>` +
        `<div class="page" style="aspect-ratio:${p.w} / ${p.h}"><div class="loading">Chargement…</div><img alt=""><div class="layer"></div></div>`;
      const cb = wrap.querySelector('input');
      cb.addEventListener('change', () => {
        p.include = cb.checked;
        wrap.classList.toggle('excluded', !p.include);
      });
      p.el = wrap;
      p.layer = wrap.querySelector('.layer');
      setupLayer(p);
      els.pages.appendChild(wrap);
    }
  }

  async function renderPreviews() {
    const cssW = Math.max(320, Math.min(els.pages.clientWidth || 700, 1000));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const [i, p] of state.pages.entries()) {
      showProgress(`Affichage de la page ${i + 1} / ${state.pages.length}…`, 0.3 + i / state.pages.length * 0.7);
      const page = await state.pdf.getPage(p.num);
      const canvas = await renderPage(page, Math.min(1600, cssW * dpr) / p.w);
      if (i === 0 && settings.bgAuto) { settings.bg = sampleBg(canvas); syncInputs(); }
      const blob = await canvasToBlob(canvas, 'image/jpeg', 0.85);
      freeCanvas(canvas);
      page.cleanup();
      p.previewUrl = URL.createObjectURL(blob);
      const img = p.el.querySelector('img');
      img.onload = () => { const l = p.el.querySelector('.loading'); if (l) l.remove(); };
      img.src = p.previewUrl;
    }
  }

  function allLinks() {
    const out = [];
    state.pages.forEach(p => p.links.forEach(l => out.push({ p, l })));
    return out;
  }

  function refreshLinks() {
    const list = allLinks();
    const num = new Map(list.map((x, i) => [x.l, i + 1]));
    for (const p of state.pages) {
      p.layer.innerHTML = '';
      for (const l of p.links) {
        const d = document.createElement('div');
        d.className = 'link' + (l.url ? '' : ' missing') + (state.sel === l ? ' sel' : '');
        d.dataset.id = l.id;
        placeLink(d, l);
        d.innerHTML = `<span class="n">${num.get(l)}</span><span class="grip"></span>`;
        d.title = l.url || 'Lien sans adresse';
        p.layer.appendChild(d);
        l.el = d;
      }
    }
    renderLinkList(list);
  }

  function placeLink(d, l) {
    d.style.left = (l.x * 100) + '%';
    d.style.top = (l.y * 100) + '%';
    d.style.width = (l.w * 100) + '%';
    d.style.height = (l.h * 100) + '%';
  }

  function renderLinkList(list) {
    els.linkCount.textContent = list.length;
    els.linkList.innerHTML = '';
    if (!list.length) {
      els.linkList.innerHTML = '<p class="muted small" style="margin:0">Aucun lien pour l\'instant. Touchez « ＋ Dessiner un lien » puis glissez le doigt sur la zone à rendre cliquable.</p>';
      return;
    }
    list.forEach(({ p, l }, i) => {
      const row = document.createElement('div');
      row.className = 'link-row' + (l.url ? '' : ' missing');
      row.innerHTML =
        `<span class="badge">${i + 1}</span>` +
        `<div class="lr-main"><small>Page ${p.num}${l.auto ? ' · repris du PDF' : ''}</small>` +
        `<input type="text" placeholder="Adresse du lien…" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="Adresse du lien ${i + 1}"></div>` +
        `<button type="button" data-act="see">Voir</button>` +
        `<button type="button" class="danger" data-act="del" aria-label="Supprimer le lien ${i + 1}">✕</button>`;
      const inp = row.querySelector('input');
      inp.value = l.url;
      inp.addEventListener('change', () => {
        l.url = normalizeUrl(inp.value);
        if (inp.value.trim() && !l.url) toast('Adresse non valide.');
        refreshLinks();
      });
      row.querySelector('[data-act=see]').addEventListener('click', () => {
        state.sel = l;
        refreshLinks();
        l.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        l.el.classList.add('flash');
      });
      row.querySelector('[data-act=del]').addEventListener('click', () => removeLink(p, l));
      els.linkList.appendChild(row);
    });
  }

  function removeLink(p, l) {
    p.links = p.links.filter(x => x !== l);
    if (state.sel === l) state.sel = null;
    refreshLinks();
  }

  function setAddMode(on) {
    state.addMode = on;
    els.btnAdd.classList.toggle('on', on);
    els.btnAdd.textContent = on ? '✓ Terminer' : '＋ Dessiner un lien';
    els.pages.classList.toggle('adding', on);
    els.modeHint.textContent = on
      ? 'Glissez le doigt sur la zone à rendre cliquable.'
      : 'Touchez un lien pour le modifier, faites-le glisser pour le déplacer.';
  }
  els.btnAdd.addEventListener('click', () => setAddMode(!state.addMode));

  // Dessin / déplacement / redimensionnement au doigt (ou à la souris)
  function setupLayer(p) {
    const layer = p.layer;
    layer.addEventListener('pointerdown', e => {
      if (e.button > 0) return;
      const box = layer.getBoundingClientRect();
      const pos = ev => ({ x: clamp((ev.clientX - box.left) / box.width, 0, 1), y: clamp((ev.clientY - box.top) / box.height, 0, 1) });
      const start = pos(e);
      const linkEl = e.target.closest('.link');
      let drag;
      if (linkEl) {
        const link = p.links.find(l => String(l.id) === linkEl.dataset.id);
        if (!link) return;
        drag = { mode: e.target.classList.contains('grip') ? 'resize' : 'move', link, orig: { ...link } };
      } else if (state.addMode) {
        const link = { id: ++uid, x: start.x, y: start.y, w: 0, h: 0, url: '', auto: false };
        const d = document.createElement('div');
        d.className = 'link missing sel';
        placeLink(d, link);
        layer.appendChild(d);
        link.el = d;
        drag = { mode: 'create', link };
      } else {
        return;
      }
      e.preventDefault();
      drag.moved = false;
      const minW = 16 / box.width, minH = 16 / box.height;

      const onMove = ev => {
        const c = pos(ev);
        const dx = c.x - start.x, dy = c.y - start.y;
        if (!drag.moved && Math.hypot(dx * box.width, dy * box.height) < 6) return;
        drag.moved = true;
        const l = drag.link, o = drag.orig;
        if (drag.mode === 'create') {
          l.x = Math.min(start.x, c.x); l.y = Math.min(start.y, c.y);
          l.w = Math.abs(dx); l.h = Math.abs(dy);
        } else if (drag.mode === 'move') {
          l.x = clamp(o.x + dx, 0, 1 - o.w);
          l.y = clamp(o.y + dy, 0, 1 - o.h);
        } else {
          l.w = clamp(o.w + dx, minW, 1 - o.x);
          l.h = clamp(o.h + dy, minH, 1 - o.y);
        }
        placeLink(l.el, l);
        ev.preventDefault();
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        const l = drag.link;
        if (drag.mode === 'create') {
          if (l.w < minW * 1.5 || l.h < minH * 1.2) {
            l.el.remove();
            toast('Glissez le doigt pour tracer un rectangle sur la zone à rendre cliquable.');
            return;
          }
          p.links.push(l);
          state.sel = l;
          refreshLinks();
          openLinkDialog(p, l, true);
        } else if (!drag.moved) {
          state.sel = l;
          refreshLinks();
          openLinkDialog(p, l, false);
        } else {
          state.sel = l;
          refreshLinks();
        }
      };
      window.addEventListener('pointermove', onMove, { passive: false });
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    });
  }

  // ---------- Fenêtre d'édition d'un lien ----------
  let dlgCtx = null;
  let linkType = 'web';
  const TYPE_LABELS = {
    web: ['Adresse du site', 'www.exemple.fr'],
    mail: ['Adresse e-mail', 'contact@exemple.fr'],
    tel: ['Numéro de téléphone', '06 12 34 56 78']
  };
  function setLinkType(t) {
    linkType = t;
    document.querySelectorAll('#linkType button').forEach(b => b.classList.toggle('on', b.dataset.t === t));
    els.linkLabel.textContent = TYPE_LABELS[t][0];
    els.linkInput.placeholder = TYPE_LABELS[t][1];
    els.linkInput.inputMode = t === 'tel' ? 'tel' : t === 'mail' ? 'email' : 'url';
    updateLinkResult();
  }
  function updateLinkResult() {
    const u = normalizeUrl(els.linkInput.value, linkType);
    els.linkResult.textContent = els.linkInput.value.trim() ? (u ? 'Lien : ' + u : 'Adresse non valide') : '';
  }
  document.querySelectorAll('#linkType button').forEach(b => b.addEventListener('click', () => { setLinkType(b.dataset.t); els.linkInput.focus(); }));
  els.linkInput.addEventListener('input', updateLinkResult);
  // Touche Entrée = Valider (sinon le formulaire prendrait le premier bouton : « Supprimer »)
  els.linkInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); els.linkDialog.close('ok'); }
  });
  $('#linkTest').addEventListener('click', () => {
    const u = normalizeUrl(els.linkInput.value, linkType);
    if (u) window.open(u, '_blank', 'noopener'); else toast("Saisissez d'abord une adresse.");
  });

  function openLinkDialog(p, link, isNew) {
    dlgCtx = { p, link, isNew };
    els.linkTitle.textContent = isNew ? 'Nouveau lien' : 'Modifier le lien';
    els.linkDelete.hidden = isNew;
    els.linkInput.value = link.url.replace(/^(mailto|tel):/i, '');
    setLinkType(urlType(link.url));
    els.linkDialog.returnValue = '';
    els.linkDialog.showModal();
    els.linkInput.focus();
  }
  els.linkDialog.addEventListener('close', () => {
    if (!dlgCtx) return;
    const { p, link, isNew } = dlgCtx;
    dlgCtx = null;
    const action = els.linkDialog.returnValue;
    if (action === 'ok') {
      const u = normalizeUrl(els.linkInput.value, linkType);
      if (els.linkInput.value.trim() && !u) toast('Adresse non valide : lien non modifié.');
      else link.url = u;
    }
    if (action === 'delete' || (isNew && !link.url)) removeLink(p, link);
    else refreshLinks();
  });

  // ---------- Réglages ----------
  function syncInputs() {
    els.subject.value = settings.subject;
    els.to.value = settings.to;
    els.preheader.value = settings.preheader;
    els.width.value = settings.width;
    els.quality.value = settings.quality;
    els.gap.value = settings.gap;
    els.margin.value = settings.margin;
    els.bg.value = settings.bg;
    els.bgHex.value = settings.bg;
    els.bgAuto.classList.toggle('on', settings.bgAuto);
  }
  els.subject.addEventListener('input', () => { settings.subject = els.subject.value; });
  els.to.addEventListener('input', () => { settings.to = els.to.value; });
  els.preheader.addEventListener('input', () => { settings.preheader = els.preheader.value; });
  [['width', true], ['gap', true], ['margin', true], ['quality', false]].forEach(([k, num]) => {
    els[k].addEventListener('change', () => { settings[k] = num ? Number(els[k].value) : els[k].value; saveSettings(); });
  });
  function setBg(hex, auto) {
    settings.bg = hex.toLowerCase();
    settings.bgAuto = auto;
    syncInputs();
  }
  els.bg.addEventListener('input', () => setBg(els.bg.value, false));
  els.bgHex.addEventListener('change', () => {
    let v = els.bgHex.value.trim();
    if (!v.startsWith('#')) v = '#' + v;
    if (/^#[0-9a-f]{3}$/i.test(v)) v = '#' + v.slice(1).split('').map(c => c + c).join('');
    if (/^#[0-9a-f]{6}$/i.test(v)) setBg(v, false);
    else { toast('Code couleur attendu, par exemple #FFFFFF'); syncInputs(); }
  });
  els.bgAuto.addEventListener('click', async () => {
    if (!state.pdf) return;
    const page = await state.pdf.getPage(1);
    const c = await renderPage(page, 400 / state.pages[0].w);
    setBg(sampleBg(c), true);
    freeCanvas(c);
    toast('Couleur reprise du bord du PDF');
  });

  $('#btnHelp').addEventListener('click', () => els.helpDialog.showModal());

  // ---------- Découpage d'une page en bandes / cellules ----------
  // Regroupe des positions trop proches pour éviter des tranches de 1-2 px.
  function cluster(values, lo, hi) {
    const sorted = [...new Set(values.map(v => clamp(v, lo, hi)))].sort((a, b) => a - b);
    const out = [lo];
    for (const v of sorted) {
      if (v <= lo) continue;
      if (v - out[out.length - 1] < SNAP) {
        if (v === hi && out.length > 1) out[out.length - 1] = hi;
        continue;
      }
      out.push(v);
    }
    if (out[out.length - 1] !== hi) out.push(hi);
    return out;
  }
  const nearest = (cuts, v) => cuts.reduce((best, c) => Math.abs(c - v) < Math.abs(best - v) ? c : best, cuts[0]);

  function sliceLayout(p, W, H, maxBand) {
    const links = p.links.filter(l => l.url).map(l => ({
      href: l.url,
      x0: clamp(Math.round(l.x * W), 0, W), x1: clamp(Math.round((l.x + l.w) * W), 0, W),
      y0: clamp(Math.round(l.y * H), 0, H), y1: clamp(Math.round((l.y + l.h) * H), 0, H)
    })).filter(l => l.x1 - l.x0 >= SNAP && l.y1 - l.y0 >= SNAP);

    const ycuts = cluster([0, H].concat(...links.map(l => [l.y0, l.y1])), 0, H);
    links.forEach(l => { l.y0 = nearest(ycuts, l.y0); l.y1 = nearest(ycuts, l.y1); });

    // Bandes trop hautes redécoupées (limite Outlook)
    const cuts = [0];
    for (let i = 1; i < ycuts.length; i++) {
      const a = ycuts[i - 1], b = ycuts[i];
      const k = Math.ceil((b - a) / maxBand);
      for (let j = 1; j < k; j++) cuts.push(Math.round(a + (b - a) * j / k));
      cuts.push(b);
    }

    const bands = [];
    for (let i = 1; i < cuts.length; i++) {
      const y0 = cuts[i - 1], y1 = cuts[i];
      if (y1 <= y0) continue;
      const mid = (y0 + y1) / 2;
      const inBand = links.filter(l => l.y0 < mid && l.y1 > mid);
      let cells;
      if (!inBand.length) {
        cells = [{ x0: 0, x1: W, href: null }];
      } else {
        const xcuts = cluster([0, W].concat(...inBand.map(l => [l.x0, l.x1])), 0, W);
        const snapped = inBand.map(l => ({ href: l.href, x0: nearest(xcuts, l.x0), x1: nearest(xcuts, l.x1) }));
        cells = [];
        for (let j = 1; j < xcuts.length; j++) {
          const x0 = xcuts[j - 1], x1 = xcuts[j], cx = (x0 + x1) / 2;
          const hit = snapped.find(l => l.x0 < cx && l.x1 > cx);
          const href = hit ? hit.href : null;
          const prev = cells[cells.length - 1];
          if (prev && prev.href === href) prev.x1 = x1;
          else cells.push({ x0, x1, href });
        }
      }
      bands.push({ y0, y1, cells });
    }
    return bands;
  }

  function altFor(p, x0, x1, y0, y1, W, H) {
    const parts = [];
    for (const t of p.text) {
      const cx = (t.x + t.w / 2) * W, cy = (t.y + t.h / 2) * H;
      if (cx >= x0 && cx < x1 && cy >= y0 && cy < y1) parts.push(t.s);
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 300);
  }

  // ---------- Fabrication des images ----------
  function buildSignature() {
    return JSON.stringify({
      w: settings.width, q: settings.quality,
      p: state.pages.map(p => [p.include, p.links.map(l => [l.x, l.y, l.w, l.h, l.url])])
    });
  }

  async function buildImages() {
    const sig = buildSignature();
    if (state.build && state.buildSig === sig) return state.build;
    const Q = QUALITY[settings.quality] || QUALITY.reco;
    const W = settings.width;
    const pages = state.pages.filter(p => p.include);
    const blocks = [], images = [];
    let n = 0;
    for (const [i, p] of pages.entries()) {
      showProgress(`Préparation de la page ${p.num} (${i + 1} / ${pages.length})…`, i / pages.length);
      const page = await state.pdf.getPage(p.num);
      const H = Math.round(W * p.h / p.w);
      const canvas = await renderPage(page, W * Q.scale / p.w);
      const rx = canvas.width / W, ry = canvas.height / H;
      const bands = sliceLayout(p, W, H, Math.max(50, Math.floor(MAX_SLICE_PX / ry)));
      for (const band of bands) {
        for (const cell of band.cells) {
          const sx = Math.round(cell.x0 * rx), ex = Math.round(cell.x1 * rx);
          const sy = Math.round(band.y0 * ry), ey = Math.round(band.y1 * ry);
          const c = document.createElement('canvas');
          c.width = Math.max(1, ex - sx);
          c.height = Math.max(1, ey - sy);
          c.getContext('2d', { alpha: false }).drawImage(canvas, sx, sy, c.width, c.height, 0, 0, c.width, c.height);
          const blob = await canvasToBlob(c, Q.mime, Q.q);
          freeCanvas(c);
          const dataUrl = await blobToDataUrl(blob);
          const ext = Q.mime === 'image/png' ? 'png' : 'jpg';
          n++;
          cell.img = {
            name: `image${pad(n)}.${ext}`, cid: `image${pad(n)}.${ext}@pdf-mail`,
            mime: Q.mime, size: blob.size, dataUrl, b64: dataUrl.slice(dataUrl.indexOf(',') + 1)
          };
          cell.alt = altFor(p, cell.x0, cell.x1, band.y0, band.y1, W, H);
          images.push(cell.img);
        }
        showProgress(`Préparation de la page ${p.num} (${i + 1} / ${pages.length})…`, (i + band.y1 / H) / pages.length);
      }
      freeCanvas(canvas);
      page.cleanup();
      blocks.push({ page: p, bands });
    }
    state.build = { W, blocks, images, bytes: images.reduce((s, im) => s + im.size, 0) };
    state.buildSig = sig;
    return state.build;
  }

  // ---------- HTML du mail (compatible Outlook) ----------
  function emailHtml(b, srcOf, opts = {}) {
    const W = b.W, bg = esc(settings.bg), gap = settings.gap, margin = settings.margin;
    const td0 = 'font-size:0;line-height:0;mso-line-height-rule:exactly;padding:0;';
    const cellHtml = (c, h) => {
      const w = c.x1 - c.x0;
      const img = `<img src="${srcOf(c.img)}" width="${w}" height="${h}" alt="${esc(c.alt)}" border="0" style="display:block;width:100%;max-width:${w}px;height:auto;border:0;outline:none;text-decoration:none;">`;
      return c.href ? `<a href="${esc(c.href)}" target="_blank" style="display:block;text-decoration:none;border:0;">${img}</a>` : img;
    };
    let rows = '';
    b.blocks.forEach((blk, i) => {
      if (i > 0 && gap > 0) rows += `<tr><td height="${gap}" style="height:${gap}px;${td0}">&nbsp;</td></tr>\n`;
      for (const band of blk.bands) {
        const h = band.y1 - band.y0;
        rows += `<tr><td style="${td0}">`;
        if (band.cells.length === 1) {
          rows += cellHtml(band.cells[0], h);
        } else {
          rows += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;table-layout:fixed;border-collapse:collapse;"><tr>';
          for (const c of band.cells) {
            const w = c.x1 - c.x0;
            rows += `<td width="${w}" valign="top" style="width:${(w / W * 100).toFixed(4)}%;${td0}">${cellHtml(c, h)}</td>`;
          }
          rows += '</tr></table>';
        }
        rows += '</td></tr>\n';
      }
    });

    const pre = settings.preheader.trim()
      ? `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;color:${bg};">${esc(settings.preheader.trim())}${'&#847;&zwnj;&nbsp;'.repeat(40)}</div>\n`
      : '';

    const body =
`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${bg}" style="width:100%;background-color:${bg};">
<tr><td align="center" valign="top" style="padding:${margin}px 0;">
<!--[if mso]><table role="presentation" width="${W}" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" align="center" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:${W}px;margin:0 auto;">
${rows}</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>`;

    const doc =
`<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" lang="fr">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${esc(settings.subject)}</title>${opts.base ? '\n<base target="_blank">' : ''}
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:AllowPNG/><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
<style type="text/css">
body{margin:0!important;padding:0!important;width:100%!important;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}
table,td{border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;}
img{border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;display:block;}
a img{border:0;}
</style>
</head>
<body style="margin:0;padding:0;background-color:${bg};">
${pre}${body}
</body>
</html>`;
    return { doc, body: pre + body };
  }

  function plainText(b) {
    const parts = [];
    if (settings.preheader.trim()) parts.push(settings.preheader.trim(), '');
    for (const blk of b.blocks) {
      const t = blk.page.text.map(x => x.s).join(' ').replace(/\s+/g, ' ').trim();
      if (t) parts.push(t, '');
    }
    const links = [...new Set(b.blocks.flatMap(blk => blk.page.links.filter(l => l.url).map(l => l.url)))];
    if (links.length) parts.push('Liens :', ...links.map(u => '- ' + u.replace(/^mailto:/i, '')));
    return parts.join('\r\n') || settings.subject;
  }

  function buildEml(b) {
    const html = emailHtml(b, img => 'cid:' + img.cid).doc;
    const rnd = () => Math.random().toString(36).slice(2, 12);
    const alt = '----=_Alt_' + rnd(), rel = '----=_Rel_' + rnd();
    const L = ['X-Unsent: 1'];
    const to = settings.to.replace(/[\r\n]+/g, ' ').trim();
    if (to) L.push('To: ' + to.split(/[;,]\s*/).filter(Boolean).join(', '));
    L.push('Subject: ' + encodeHeader(settings.subject.trim() || '(sans objet)'));
    L.push('MIME-Version: 1.0');
    L.push(`Content-Type: multipart/alternative; boundary="${alt}"`);
    L.push('', 'This is a multi-part message in MIME format.', '');
    L.push('--' + alt, 'Content-Type: text/plain; charset="utf-8"', 'Content-Transfer-Encoding: base64', '', wrap76(utf8ToB64(plainText(b))), '');
    L.push('--' + alt, `Content-Type: multipart/related; type="text/html"; boundary="${rel}"`, '');
    L.push('--' + rel, 'Content-Type: text/html; charset="utf-8"', 'Content-Transfer-Encoding: base64', '', wrap76(utf8ToB64(html)), '');
    for (const img of b.images) {
      L.push('--' + rel,
        `Content-Type: ${img.mime}; name="${img.name}"`,
        'Content-Transfer-Encoding: base64',
        `Content-ID: <${img.cid}>`,
        `Content-Disposition: inline; filename="${img.name}"`,
        '', wrap76(img.b64), '');
    }
    L.push('--' + rel + '--', '', '--' + alt + '--', '');
    return L.join('\r\n');
  }

  function baseName() {
    const s = (settings.subject.trim() || state.fileName || 'mail').replace(/[\\/:*?"<>|\r\n]+/g, '-').replace(/\s+/g, ' ').trim();
    return s.slice(0, 80) || 'mail';
  }

  // ---------- Création + fenêtre de résultat ----------
  els.btnBuild.addEventListener('click', async () => {
    if (!state.pdf) return;
    if (!state.pages.some(p => p.include)) { toast('Aucune page sélectionnée.'); return; }
    if (state.addMode) setAddMode(false);
    try {
      const b = await buildImages();
      showProgress('Assemblage du mail…', 1);
      const eml = buildEml(b);
      const name = baseName();
      const emlFile = new File([eml], name + '.eml', { type: 'message/rfc822' });
      const html = emailHtml(b, img => img.dataUrl);
      const preview = emailHtml(b, img => img.dataUrl, { base: true }).doc;
      state.output = { eml, emlFile, html, name };

      els.frame.srcdoc = preview;
      const missing = allLinks().filter(x => x.p.include && !x.l.url).length;
      const linkCount = b.blocks.reduce((s, blk) => s + blk.page.links.filter(l => l.url).length, 0);
      els.resSize.innerHTML = `<strong>${b.blocks.length}</strong> page(s) · <strong>${linkCount}</strong> lien(s) · mail de <strong>${fmtBytes(eml.length)}</strong>`;
      const warns = [];
      if (missing) warns.push(`${missing} zone(s) de lien sans adresse : elles ne seront pas cliquables.`);
      if (eml.length > 15 * 1024 * 1024) warns.push('Mail lourd : il risque d\'être refusé par certaines messageries. Choisissez la qualité « Légère » ou retirez des pages.');
      else if (eml.length > 8 * 1024 * 1024) warns.push('Mail assez lourd. Si besoin, choisissez la qualité « Légère ».');
      els.resWarn.hidden = !warns.length;
      els.resWarn.textContent = warns.join(' ');

      const canShare = !!(navigator.canShare && navigator.canShare({ files: [emlFile] }));
      els.btnShare.hidden = !canShare;
      $('#btnSaveEml').classList.toggle('primary', !canShare);
      $('#btnSaveEml').classList.toggle('big', !canShare);
      hideProgress();
      els.resultDialog.showModal();
    } catch (err) {
      console.error(err);
      hideProgress();
      toast('Erreur pendant la création : ' + (err && err.message || err), 6000);
    }
  });

  function download(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 60000);
  }

  els.btnShare.addEventListener('click', async () => {
    const o = state.output;
    if (!o) return;
    try {
      await navigator.share({ files: [o.emlFile], title: settings.subject || o.name });
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      download(o.emlFile, o.emlFile.name);
      toast('Partage indisponible : le fichier .eml a été enregistré.');
    }
  });
  $('#btnSaveEml').addEventListener('click', () => {
    const o = state.output;
    if (!o) return;
    download(new Blob([o.eml], { type: 'message/rfc822' }), o.name + '.eml');
    toast('Fichier .eml enregistré (dossier Téléchargements).');
  });
  $('#btnSaveHtml').addEventListener('click', () => {
    const o = state.output;
    if (!o) return;
    download(new Blob([o.html.doc], { type: 'text/html' }), o.name + '.html');
    toast('Fichier HTML enregistré (dossier Téléchargements).');
  });
  $('#btnCopy').addEventListener('click', async () => {
    const o = state.output;
    if (!o) return;
    const html = o.html.body;
    if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write && window.isSecureContext) {
      try {
        await navigator.clipboard.write([new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([plainText(state.build)], { type: 'text/plain' })
        })]);
        toast('Mail copié : collez-le dans un nouveau message Outlook.');
        return;
      } catch (e) { /* on tente la méthode classique */ }
    }
    const zone = $('#copyZone');
    zone.innerHTML = html;
    const range = document.createRange();
    range.selectNodeContents(zone);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    sel.removeAllRanges();
    zone.innerHTML = '';
    toast(ok ? 'Mail copié : collez-le dans un nouveau message Outlook.' : 'Copie impossible sur cet appareil : utilisez le fichier .eml.');
  });
  $('#resClose').addEventListener('click', () => els.resultDialog.close());
  document.querySelectorAll('#viewSeg button').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('#viewSeg button').forEach(x => x.classList.toggle('on', x === b));
    els.frameWrap.classList.toggle('mob', b.dataset.v === 'mob');
  }));

  // Application installable / hors connexion quand elle est servie en HTTPS
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  syncInputs();
})();
