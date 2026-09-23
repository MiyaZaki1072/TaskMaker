// Scoreboard page: CMS ranking in, live preview + PDF out. The server does the parsing and
// rendering, so the preview here is exactly what the PDF will print.
(() => {
  'use strict';

  const rankingInput = document.getElementById('sb-ranking');
  const fileInput = document.getElementById('sb-file');
  const drop = document.getElementById('sb-drop');
  const contestInput = document.getElementById('sb-contest');
  const authorsInput = document.getElementById('sb-authors');
  const cutoffInputs = {
    gold: document.getElementById('sb-gold'),
    silver: document.getElementById('sb-silver'),
    bronze: document.getElementById('sb-bronze'),
  };
  const preview = document.getElementById('sb-preview');
  const pdfBtn = document.getElementById('sb-pdf');
  const pngBtn = document.getElementById('sb-png');
  const errorBanner = document.getElementById('sb-error');
  const status = document.getElementById('sb-status');
  const statusText = document.getElementById('sb-status-text');
  const summary = document.getElementById('sb-summary');
  const toastWrap = document.getElementById('toast-wrap');

  function toast(message, type) {
    const el = document.createElement('div');
    el.className = 'toast' + (type ? ' toast-' + type : '');
    el.textContent = message;
    toastWrap.appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }

  function setStatus(text, state) {
    statusText.textContent = text;
    status.className = 'editor-status' + (state ? ' is-' + state : '');
  }

  function showError(error) {
    if (!error) {
      errorBanner.hidden = true;
      errorBanner.replaceChildren();
      return;
    }
    const title = document.createElement('strong');
    title.textContent = error.message || 'Could not build the scoreboard';
    const parts = [title];
    const lines = (error.details || []).concat(error.hint ? ['💡 ' + error.hint] : []);
    if (lines.length > 0) {
      const list = document.createElement('ul');
      for (const line of lines) {
        const li = document.createElement('li');
        li.textContent = line;
        list.appendChild(li);
      }
      parts.push(list);
    }
    errorBanner.replaceChildren(...parts);
    errorBanner.hidden = false;
  }

  function setExportEnabled(enabled) {
    pdfBtn.disabled = !enabled;
    pngBtn.disabled = !enabled;
  }

  function payload() {
    return {
      ranking: rankingInput.value,
      contestName: contestInput.value,
      authors: authorsInput.value,
      cutoffs: {
        gold: cutoffInputs.gold.value,
        silver: cutoffInputs.silver.value,
        bronze: cutoffInputs.bronze.value,
      },
    };
  }

  function postJson(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  }

  async function errorFrom(res) {
    try {
      const data = await res.json();
      if (data && data.error) return data.error;
    } catch { /* not JSON */ }
    return { message: 'An error occurred (HTTP ' + res.status + ')' };
  }

  // ---------- Live preview ----------
  let lastSent = '';
  let debounce = null;
  let requestSeq = 0;

  async function refresh() {
    if (!rankingInput.value.trim()) {
      requestSeq += 1;
      lastSent = '';
      preview.srcdoc = '';
      summary.textContent = '';
      setExportEnabled(false);
      showError(null);
      setStatus('Upload a ranking to begin');
      return;
    }
    const body = JSON.stringify(payload());
    // An edit that leaves the request unchanged costs nothing
    if (body === lastSent) return;
    lastSent = body;
    const seq = ++requestSeq;
    setStatus('Updating preview...', 'dirty');

    try {
      const res = await postJson('/api/scoreboard/preview', body);
      // A slower, older response must not overwrite a newer one
      if (seq !== requestSeq) return;
      if (!res.ok) {
        const error = await errorFrom(res);
        if (seq !== requestSeq) return;
        showError(error);
        setExportEnabled(false);
        setStatus('Fix the problem above', 'error');
        lastSent = '';
        return;
      }
      const data = await res.json();
      if (seq !== requestSeq) return;
      preview.srcdoc = data.html;
      showError(null);
      setExportEnabled(true);
      const medals = data.medals;
      summary.textContent =
        data.contestants + ' contestants · ' + data.problems.length + ' problems (' + data.problems.join(', ') + ')' +
        ' · 🥇 ' + medals.gold + '  🥈 ' + medals.silver + '  🥉 ' + medals.bronze;
      setStatus('Preview up to date', 'ok');
    } catch (err) {
      if (seq !== requestSeq) return;
      lastSent = '';
      showError({ message: 'Could not reach the studio server', details: [String(err && err.message ? err.message : err)] });
      setStatus('Offline', 'error');
    }
  }

  function scheduleRefresh() {
    clearTimeout(debounce);
    debounce = setTimeout(refresh, 450);
  }

  for (const input of [rankingInput, contestInput, authorsInput, cutoffInputs.gold, cutoffInputs.silver, cutoffInputs.bronze]) {
    input.addEventListener('input', scheduleRefresh);
  }

  // ---------- File upload ----------
  async function loadFile(file) {
    if (!file) return;
    if (file.size > 1024 * 1024) {
      toast('That file is over 1 MB — it is probably not a CMS ranking', 'error');
      return;
    }
    rankingInput.value = await file.text();
    toast('Loaded ' + file.name, 'ok');
    clearTimeout(debounce);
    refresh();
  }

  drop.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    loadFile(fileInput.files[0]);
    fileInput.value = '';
  });
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('is-over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('is-over');
    loadFile(e.dataTransfer.files[0]);
  });

  // ---------- Downloads (PDF pages, or one tall PNG) ----------
  function exportButton(button, kind, label) {
    button.addEventListener('click', async () => {
      setExportEnabled(false);
      const original = button.textContent;
      button.textContent = '⏳ Generating ' + label + '...';
      try {
        const res = await postJson('/api/scoreboard/' + kind, payload());
        if (!res.ok) {
          const error = await errorFrom(res);
          showError(error);
          toast(error.message, 'error');
          return;
        }
        const url = URL.createObjectURL(await res.blob());
        const link = document.createElement('a');
        link.href = url;
        link.download = 'scoreboard.' + kind;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        toast('Scoreboard ' + label + ' downloaded', 'ok');
      } catch (err) {
        toast('Could not generate the ' + label + ': ' + (err && err.message ? err.message : err), 'error');
      } finally {
        button.textContent = original;
        setExportEnabled(true);
      }
    });
  }

  exportButton(pdfBtn, 'pdf', 'PDF');
  exportButton(pngBtn, 'png', 'PNG');
})();
