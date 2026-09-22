// Studio main page: list of all problems + controls for every action
(() => {
  'use strict';

  const grid = document.getElementById('problem-grid');
  const empty = document.getElementById('empty-state');
  const toastWrap = document.getElementById('toast-wrap');
  const exportResults = document.getElementById('export-results');

  function toast(message, type) {
    const el = document.createElement('div');
    el.className = 'toast' + (type ? ' toast-' + type : '');
    el.textContent = message;
    toastWrap.appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }

  async function api(url, options) {
    const res = await fetch(url, options);
    let data = null;
    try { data = await res.json(); } catch { /* no body, that's fine */ }
    if (!res.ok) {
      const msg = (data && data.error && data.error.message) || 'An error occurred (HTTP ' + res.status + ')';
      const err = new Error(msg);
      err.data = data;
      throw err;
    }
    return data;
  }

  function postJson(url, body) {
    return api(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function renderCard(p) {
    const badge = p.ok
      ? '<span class="badge badge-ok">Passed</span>'
      : '<span class="badge badge-error">Failed</span>';
    const warnBadge = p.ok && p.warningCount
      ? ' <span class="badge badge-warn">' + p.warningCount + ' warning(s)</span>'
      : '';
    const name = escapeHtml(p.name || p.folder);
    const meta = p.ok
      ? ''
      : '<div class="card-meta is-error">' + escapeHtml(p.errorMessage || 'There is an error') + '</div>';

    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML =
      '<div class="card-head">' +
        '<div><div class="card-code">' + escapeHtml(p.code || p.folder) + '</div>' +
        '<div class="card-name">' + name + '</div></div>' +
        '<div>' + badge + warnBadge + '</div>' +
      '</div>' +
      meta +
      '<div class="card-actions">' +
        '<a class="btn btn-sm" href="/editor/' + encodeURIComponent(p.folder) + '">Edit</a>' +
        '<a class="btn btn-sm" target="_blank" rel="noopener" href="/preview/' + encodeURIComponent(p.folder) + '">Preview</a>' +
        '<button class="btn btn-sm" data-pdf="' + escapeHtml(p.folder) + '">Export PDF</button>' +
        '<a class="btn btn-sm" href="/api/problems/' + encodeURIComponent(p.folder) + '/export-zip" title="Download this problem as a ZIP file">Export ZIP</a>' +
        '<button class="btn btn-sm btn-danger" data-delete="' + escapeHtml(p.folder) + '" title="Delete this problem">🗑️ Delete</button>' +
      '</div>';

    card.querySelector('[data-pdf]').addEventListener('click', (ev) => exportOne(p.folder, ev.currentTarget));
    card.querySelector('[data-delete]')?.addEventListener('click', () => promptDelete(p));
    return card;
  }

  const sectionLabel = document.getElementById('section-problem-label');
  const openNewBtn = document.getElementById('open-new');

  /** Shows a banner when storage could not be read, so an empty list is never mistaken for an empty project */
  function renderStorageWarning(message) {
    let banner = document.getElementById('storage-warning');
    if (!message) {
      if (banner) banner.remove();
      return;
    }
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'storage-warning';
      banner.className = 'editor-error-banner';
      banner.style.margin = '0 0 12px';
      grid.parentNode.insertBefore(banner, grid);
    }
    banner.textContent = message;
    banner.hidden = false;
  }

  async function refreshList() {
    grid.innerHTML = '<p style="color:var(--ink-soft)">Loading...</p>';
    try {
      const data = await api('/api/problems');
      grid.innerHTML = '';
      const count = data.count ?? data.problems.length;
      const max = data.max || 15;

      if (sectionLabel) {
        sectionLabel.textContent = 'All Problems (' + count + '/' + max + ')';
      }

      if (openNewBtn) {
        if (count >= max) {
          openNewBtn.disabled = true;
          openNewBtn.title = 'The maximum number of problems has been reached (' + max + ')';
        } else {
          openNewBtn.disabled = false;
          openNewBtn.title = '';
        }
      }

      renderStorageWarning(data.warning);

      if (data.problems.length === 0) {
        // Only claim the project is empty when storage is actually healthy.
        empty.hidden = Boolean(data.warning);
        return;
      }
      empty.hidden = true;
      for (const p of data.problems) grid.appendChild(renderCard(p));
      return data.problems;
    } catch (err) {
      grid.innerHTML = '';
      toast(err.message, 'error');
    }
  }

  async function exportOne(folder, btn) {
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Generating...';
    try {
      const data = await postJson('/api/problems/' + encodeURIComponent(folder) + '/pdf');
      toast('PDF for ' + data.code + ' is ready', 'ok');
      window.open(data.downloadUrl, '_blank');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  // ---------- New problem modal ----------
  const newDialog = document.getElementById('new-dialog');
  const newForm = document.getElementById('new-form');
  const newInput = document.getElementById('new-name');
  const newError = document.getElementById('new-error');

  document.getElementById('open-new').addEventListener('click', () => {
    newError.textContent = '';
    newInput.value = '';
    newDialog.showModal();
    newInput.focus();
  });

  document.getElementById('new-cancel').addEventListener('click', () => newDialog.close());

  newForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    newError.textContent = '';
    const submitBtn = newForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      const data = await postJson('/api/problems', { name: newInput.value });
      newDialog.close();
      window.location.href = '/editor/' + encodeURIComponent(data.folder);
    } catch (err) {
      newError.textContent = err.message;
    } finally {
      submitBtn.disabled = false;
    }
  });

  // ---------- Top bar buttons ----------
  document.getElementById('btn-refresh').addEventListener('click', async () => {
    const problems = await refreshList();
    if (problems) {
      const failed = problems.filter((p) => !p.ok).length;
      toast(failed === 0
        ? 'All ' + problems.length + ' problems passed validation'
        : (problems.length - failed) + ' passed / ' + failed + ' failed',
        failed === 0 ? 'ok' : 'error');
    }
  });

  document.getElementById('btn-export-all').addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    exportResults.innerHTML = '<p style="color:var(--ink-soft)">Generating PDFs for every problem...</p>';
    try {
      const data = await postJson('/api/export-all');
      const list = document.createElement('ul');
      list.className = 'result-list';
      for (const r of data.results) {
        const li = document.createElement('li');
        if (r.ok) {
          li.innerHTML = '<span class="badge badge-ok">✓</span><span class="name">' + escapeHtml(r.folder) +
            '</span><a class="btn btn-sm" target="_blank" href="' + r.downloadUrl + '">Download</a>';
        } else {
          li.innerHTML = '<span class="badge badge-error">✕</span><span class="name">' + escapeHtml(r.folder) +
            ' — ' + escapeHtml(r.errorMessage || '') + '</span>';
        }
        list.appendChild(li);
      }
      exportResults.innerHTML = '';
      exportResults.appendChild(list);
      const failed = data.results.filter((r) => !r.ok).length;
      toast(failed === 0 ? 'Successfully generated all ' + data.results.length + ' PDFs' : failed + ' problem(s) still have issues',
        failed === 0 ? 'ok' : 'error');
    } catch (err) {
      exportResults.innerHTML = '';
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  // ---------- Booklet dialog ----------
  const bookletDialog = document.getElementById('booklet-dialog');
  const bkContestName = document.getElementById('bk-contest-name');
  const bkLogoUrl = document.getElementById('bk-logo-url');
  const bkLogoFile = document.getElementById('bk-logo-file');
  const bkLogoPreview = document.getElementById('bk-logo-preview');
  const bkLogoImg = document.getElementById('bk-logo-img');
  const bkLogoClear = document.getElementById('bk-logo-clear');
  const bkAuthors = document.getElementById('bk-authors');
  const bkRules = document.getElementById('bk-rules');
  const bkProblemList = document.getElementById('bk-problem-list');
  const bkSelectAll = document.getElementById('bk-select-all');
  const bkSelectNone = document.getElementById('bk-select-none');
  const bkSelectCount = document.getElementById('bk-select-count');
  const bkError = document.getElementById('bk-error');
  const bkLoading = document.getElementById('bk-loading');
  const bkCancel = document.getElementById('bk-cancel');
  const bkGenerate = document.getElementById('bk-generate');

  let bkLogoDataUri = '';

  function updateBkSelectCount() {
    const total = bkProblemList.querySelectorAll('input[type="checkbox"]').length;
    const checked = bkProblemList.querySelectorAll('input[type="checkbox"]:checked').length;
    bkSelectCount.textContent = checked + ' / ' + total + ' selected';
  }

  function showLogoPreview(src) {
    bkLogoDataUri = src;
    bkLogoImg.src = src;
    bkLogoPreview.hidden = false;
  }

  function clearLogoPreview() {
    bkLogoDataUri = '';
    bkLogoUrl.value = '';
    bkLogoImg.src = '';
    bkLogoPreview.hidden = true;
  }

  bkLogoClear?.addEventListener('click', clearLogoPreview);

  bkLogoFile?.addEventListener('change', () => {
    const file = bkLogoFile.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      showLogoPreview(reader.result);
      bkLogoUrl.value = file.name;
    };
    reader.readAsDataURL(file);
    bkLogoFile.value = '';
  });

  bkLogoUrl?.addEventListener('change', () => {
    const val = bkLogoUrl.value.trim();
    if (val && (val.startsWith('http://') || val.startsWith('https://') || val.startsWith('data:'))) {
      showLogoPreview(val);
    }
  });

  bkSelectAll?.addEventListener('click', () => {
    bkProblemList.querySelectorAll('input[type="checkbox"]').forEach((cb) => { cb.checked = true; });
    updateBkSelectCount();
  });

  bkSelectNone?.addEventListener('click', () => {
    bkProblemList.querySelectorAll('input[type="checkbox"]').forEach((cb) => { cb.checked = false; });
    updateBkSelectCount();
  });

  function updateItemOrders() {
    const items = bkProblemList.querySelectorAll('.bk-problem-item');
    items.forEach((item, index) => {
      const orderEl = item.querySelector('.bk-item-order');
      if (orderEl) orderEl.textContent = (index + 1);
      const upBtn = item.querySelector('.bk-btn-up');
      const downBtn = item.querySelector('.bk-btn-down');
      if (upBtn) upBtn.disabled = (index === 0);
      if (downBtn) downBtn.disabled = (index === items.length - 1);
    });
  }

  let draggedItem = null;

  document.getElementById('btn-booklet').addEventListener('click', async () => {
    bkError.textContent = '';
    bkLoading.style.display = 'none';
    bkProblemList.innerHTML = '<p style="color:var(--ink-soft)">Loading...</p>';
    bookletDialog.showModal();

    try {
      const data = await api('/api/problems');
      bkProblemList.innerHTML = '';
      if (data.problems.length === 0) {
        bkProblemList.innerHTML = '<p style="color:var(--ink-soft)">No problems available</p>';
        updateBkSelectCount();
        return;
      }
      data.problems.forEach((p, index) => {
        const item = document.createElement('div');
        item.className = 'bk-problem-item';
        item.draggable = true;
        item.dataset.folder = p.folder;

        const checkId = 'bk-check-' + index + '-' + encodeURIComponent(p.folder);
        const statusBadge = p.ok
          ? '<span class="badge badge-ok" style="font-size:0.7rem">✓</span>'
          : '<span class="badge badge-error" style="font-size:0.7rem">✕</span>';

        item.innerHTML =
          '<div class="bk-drag-handle" title="Drag to reorder">' +
            '<span class="bk-drag-icon">☰</span>' +
            '<span class="bk-item-order">' + (index + 1) + '</span>' +
          '</div>' +
          '<input type="checkbox" id="' + checkId + '" value="' + escapeHtml(p.folder) + '" checked>' +
          '<label for="' + checkId + '" class="bk-problem-info">' +
            '<span class="bk-problem-name">' + escapeHtml(p.name || p.folder) + '</span>' +
          '</label>' +
          statusBadge +
          '<div class="bk-reorder-btns">' +
            '<button type="button" class="btn-icon bk-btn-up" title="Move up">▲</button>' +
            '<button type="button" class="btn-icon bk-btn-down" title="Move down">▼</button>' +
          '</div>';

        item.querySelector('input').addEventListener('change', updateBkSelectCount);

        const upBtn = item.querySelector('.bk-btn-up');
        const downBtn = item.querySelector('.bk-btn-down');

        upBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const prev = item.previousElementSibling;
          if (prev) {
            prev.before(item);
            updateItemOrders();
          }
        });

        downBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const next = item.nextElementSibling;
          if (next) {
            next.after(item);
            updateItemOrders();
          }
        });

        // Drag & Drop
        item.addEventListener('dragstart', (e) => {
          draggedItem = item;
          item.classList.add('is-dragging');
          e.dataTransfer.effectAllowed = 'move';
          try {
            e.dataTransfer.setData('text/plain', p.folder);
          } catch (_) {}
        });

        item.addEventListener('dragend', () => {
          if (draggedItem) {
            draggedItem.classList.remove('is-dragging');
            draggedItem = null;
          }
          bkProblemList.querySelectorAll('.bk-problem-item').forEach((it) => it.classList.remove('drag-over-top', 'drag-over-bottom'));
          updateItemOrders();
        });

        item.addEventListener('dragover', (e) => {
          e.preventDefault();
          if (!draggedItem || draggedItem === item) return;
          e.dataTransfer.dropEffect = 'move';

          const rect = item.getBoundingClientRect();
          const midY = rect.top + rect.height / 2;
          if (e.clientY < midY) {
            item.classList.add('drag-over-top');
            item.classList.remove('drag-over-bottom');
          } else {
            item.classList.add('drag-over-bottom');
            item.classList.remove('drag-over-top');
          }
        });

        item.addEventListener('dragleave', () => {
          item.classList.remove('drag-over-top', 'drag-over-bottom');
        });

        item.addEventListener('drop', (e) => {
          e.preventDefault();
          item.classList.remove('drag-over-top', 'drag-over-bottom');
          if (!draggedItem || draggedItem === item) return;

          const rect = item.getBoundingClientRect();
          const midY = rect.top + rect.height / 2;
          if (e.clientY < midY) {
            item.before(draggedItem);
          } else {
            item.after(draggedItem);
          }
          updateItemOrders();
        });

        bkProblemList.appendChild(item);
      });
      updateBkSelectCount();
      updateItemOrders();
    } catch (err) {
      bkProblemList.innerHTML = '';
      bkError.textContent = err.message;
    }
  });

  bkCancel?.addEventListener('click', () => bookletDialog.close());

  bkGenerate?.addEventListener('click', async () => {
    bkError.textContent = '';
    const checked = bkProblemList.querySelectorAll('input[type="checkbox"]:checked');
    const folders = Array.from(checked).map((cb) => cb.value);

    if (folders.length === 0) {
      bkError.textContent = 'Please select at least one problem';
      return;
    }

    bkGenerate.disabled = true;
    bkCancel.disabled = true;
    bkLoading.style.display = 'block';

    try {
      const body = {
        folders: folders,
        contestName: bkContestName.value.trim() || undefined,
        logo: bkLogoDataUri || undefined,
        authors: bkAuthors.value.trim() || undefined,
        rules: bkRules.value.trim() || undefined,
      };

      const data = await postJson('/api/booklet', body);
      bookletDialog.close();

      exportResults.innerHTML = '';
      const box = document.createElement('div');
      box.className = 'card';
      box.innerHTML = '<div class="card-name">Booklet ready (' + data.pageCount + ' pages)</div>' +
        '<div class="card-actions"><a class="btn btn-primary btn-sm" target="_blank" href="' + data.downloadUrl + '">Download Booklet</a></div>';
      exportResults.appendChild(box);
      toast('Booklet combined successfully (' + data.pageCount + ' pages)', 'ok');
    } catch (err) {
      bkError.textContent = err.message;
    } finally {
      bkGenerate.disabled = false;
      bkCancel.disabled = false;
      bkLoading.style.display = 'none';
    }
  });

  // ---------- ZIP export / import ----------
  document.getElementById('btn-export-zip')?.addEventListener('click', () => {
    window.location.href = '/api/export-zip';
  });

  const importDialog = document.getElementById('import-dialog');
  const zipDrop = document.getElementById('zip-drop');
  const zipFileInput = document.getElementById('zip-file-input');
  const importLoading = document.getElementById('import-loading');
  const importError = document.getElementById('import-error');
  const importClose = document.getElementById('import-close');

  document.getElementById('btn-import-zip')?.addEventListener('click', () => {
    if (importError) importError.textContent = '';
    if (importLoading) importLoading.style.display = 'none';
    if (zipDrop) zipDrop.style.display = '';
    importDialog?.showModal();
  });

  importClose?.addEventListener('click', () => {
    importDialog?.close();
  });

  zipDrop?.addEventListener('click', () => {
    zipFileInput?.click();
  });

  zipDrop?.addEventListener('dragover', (e) => {
    e.preventDefault();
    zipDrop.classList.add('is-over');
  });

  zipDrop?.addEventListener('dragleave', () => {
    zipDrop.classList.remove('is-over');
  });

  zipDrop?.addEventListener('drop', (e) => {
    e.preventDefault();
    zipDrop.classList.remove('is-over');
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      uploadZipFile(files[0]);
    }
  });

  zipFileInput?.addEventListener('change', () => {
    const files = zipFileInput.files;
    if (files && files.length > 0) {
      uploadZipFile(files[0]);
      zipFileInput.value = '';
    }
  });

  async function uploadZipFile(file) {
    if (!file.name.toLowerCase().endsWith('.zip')) {
      if (importError) importError.textContent = 'Please select a file with a .zip extension only';
      return;
    }
    if (importError) importError.textContent = '';
    if (importLoading) importLoading.style.display = 'block';
    if (zipDrop) zipDrop.style.display = 'none';

    try {
      const formData = new FormData();
      formData.append('file', file);
      const modeInput = document.querySelector('input[name="import-mode"]:checked');
      const mode = modeInput ? modeInput.value : 'add';
      formData.append('mode', mode);

      const res = await fetch('/api/import-zip', {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error((data && data.error && data.error.message) || 'Import failed');
      }
      const modeText = data.mode === 'overwrite' ? ' (overwrite mode)' : ' (add-new mode)';
      toast('Imported ' + data.count + ' problem(s) successfully' + modeText + ': ' + data.imported.join(', '), 'ok');
      importDialog?.close();
      await refreshList();
    } catch (err) {
      if (importError) importError.textContent = err.message;
      if (importLoading) importLoading.style.display = 'none';
      if (zipDrop) zipDrop.style.display = '';
    }
  }

  // ---------- Delete problem modal ----------
  const deleteDialog = document.getElementById('delete-dialog');
  const deleteConfirmText = document.getElementById('delete-confirm-text');
  const deleteConfirmBtn = document.getElementById('delete-confirm-btn');
  const deleteCancelBtn = document.getElementById('delete-cancel');
  const deleteError = document.getElementById('delete-error');
  let folderPendingDelete = null;

  function promptDelete(p) {
    folderPendingDelete = p.folder;
    if (deleteError) deleteError.textContent = '';
    if (deleteConfirmText) {
      deleteConfirmText.textContent = 'Are you sure you want to delete "' + (p.code || p.folder) + '" (' + (p.name || p.folder) + ')? This cannot be undone and all files in the folder will be permanently deleted.';
    }
    deleteDialog?.showModal();
  }

  deleteCancelBtn?.addEventListener('click', () => {
    deleteDialog?.close();
    folderPendingDelete = null;
  });

  deleteConfirmBtn?.addEventListener('click', async () => {
    if (!folderPendingDelete) return;
    deleteConfirmBtn.disabled = true;
    if (deleteError) deleteError.textContent = '';
    try {
      await api('/api/problems/' + encodeURIComponent(folderPendingDelete), { method: 'DELETE' });
      toast('Deleted ' + folderPendingDelete + ' successfully', 'ok');
      deleteDialog?.close();
      folderPendingDelete = null;
      await refreshList();
    } catch (err) {
      if (deleteError) deleteError.textContent = err.message;
    } finally {
      deleteConfirmBtn.disabled = false;
    }
  });

  // Theme toggle
  const themeBtn = document.getElementById('btn-theme');
  function updateThemeButton() {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    if (themeBtn) {
      themeBtn.textContent = isDark ? '☀️' : '🌙';
      themeBtn.title = isDark ? 'Switch to light mode' : 'Switch to dark mode';
    }
  }
  themeBtn?.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    if (next === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    localStorage.setItem('studio-theme', next);
    updateThemeButton();
  });
  updateThemeButton();

  refreshList();
})();
