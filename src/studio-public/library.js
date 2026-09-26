// Library page: images and text snippets shared by every problem (see src/library.ts).
// Images are used live as global/<name>; snippets are copied into problems from the editor.
(() => {
  'use strict';

  const drop = document.getElementById('lib-drop');
  const fileInput = document.getElementById('lib-file-input');
  const replaceInput = document.getElementById('lib-replace-input');
  const imagesGrid = document.getElementById('lib-images');
  const imagesEmpty = document.getElementById('lib-images-empty');
  const snippetsList = document.getElementById('lib-snippets');
  const snippetsEmpty = document.getElementById('lib-snippets-empty');
  const newSnippetBtn = document.getElementById('lib-new-snippet');
  const confirmDialog = document.getElementById('lib-confirm-dialog');
  const confirmTitle = document.getElementById('lib-confirm-title');
  const confirmText = document.getElementById('lib-confirm-text');
  const confirmList = document.getElementById('lib-confirm-list');
  const confirmError = document.getElementById('lib-confirm-error');
  const confirmOk = document.getElementById('lib-confirm-ok');
  const confirmCancel = document.getElementById('lib-confirm-cancel');
  const toastWrap = document.getElementById('toast-wrap');

  let replaceTarget = null;
  let confirmAction = null;
  // What the image grid shows: the list, and name -> problem folders using it (null until loaded)
  let currentImages = [];
  let usage = null;

  // ========== helpers ==========

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
      const error = (data && data.error) || {};
      const msg = (error.message || 'An error occurred (HTTP ' + res.status + ')') + (error.hint ? ' — ' + error.hint : '');
      throw new Error(msg);
    }
    return data;
  }

  function sendJson(url, method, body) {
    return api(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  function extOf(name) {
    const dot = name.lastIndexOf('.');
    return dot === -1 ? '' : name.slice(dot).toLowerCase();
  }

  /** Clipboard API first; the textarea fallback covers plain-http access from another machine */
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* fall through */ }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }

  function button(label, className, onClick, title) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-sm' + (className ? ' ' + className : '');
    btn.textContent = label;
    if (title) btn.title = title;
    btn.addEventListener('click', onClick);
    return btn;
  }

  // ========== confirm dialog ==========

  function openConfirm({ title, text, items, okLabel, onConfirm }) {
    confirmTitle.textContent = title;
    confirmText.textContent = text;
    confirmList.replaceChildren(...(items || []).map((item) => {
      const li = document.createElement('li');
      li.textContent = item;
      return li;
    }));
    confirmList.hidden = !items || items.length === 0;
    confirmError.textContent = '';
    confirmOk.textContent = okLabel || 'Delete';
    confirmOk.disabled = false;
    confirmAction = onConfirm;
    confirmDialog.showModal();
  }

  confirmCancel.addEventListener('click', () => confirmDialog.close());
  confirmOk.addEventListener('click', async () => {
    if (!confirmAction) return;
    confirmOk.disabled = true;
    try {
      await confirmAction();
      confirmDialog.close();
    } catch (err) {
      confirmError.textContent = err.message;
      confirmOk.disabled = false;
    }
  });

  // ========== images ==========

  function renderImages(images) {
    currentImages = images;
    imagesGrid.replaceChildren(...images.map(imageCard));
    imagesEmpty.hidden = images.length > 0;
  }

  /** "used by 3 problems" on every card at once — a problem that stops using an image shows here too */
  async function loadUsage() {
    try {
      const data = await api('/api/library/usage');
      usage = data.usage || {};
    } catch {
      usage = null; // the cards just leave the count out; the delete check asks again anyway
    }
    renderImages(currentImages);
  }

  function usageText(name) {
    if (!usage) return '';
    const folders = usage[name] || [];
    return folders.length === 0 ? 'not used by any problem' : 'used by ' + folders.length + ' problem' + (folders.length === 1 ? '' : 's');
  }

  function imageCard(image) {
    const ref = 'global/' + image.name;
    const card = document.createElement('div');
    card.className = 'lib-image-card';

    const thumb = document.createElement('div');
    thumb.className = 'lib-image-thumb';
    const img = document.createElement('img');
    img.src = image.url;
    img.alt = image.name;
    img.loading = 'lazy';
    thumb.appendChild(img);

    const info = document.createElement('div');
    info.className = 'lib-image-info';
    const name = document.createElement('code');
    name.className = 'lib-image-name';
    name.textContent = ref;
    const meta = document.createElement('span');
    meta.className = 'lib-image-meta';
    const used = usageText(image.name);
    meta.textContent = formatSize(image.size) + (used ? ' · ' + used : '');
    const folders = usage && usage[image.name];
    if (folders && folders.length > 0) meta.title = folders.join('\n');

    const actions = document.createElement('div');
    actions.className = 'lib-image-actions';
    actions.append(
      button('Copy name', '', async () => {
        const ok = await copyText(ref);
        toast(ok ? 'Copied ' + ref + ' — paste it into logo: or [img: ...]' : 'Could not copy — select the name and copy it by hand', ok ? 'ok' : 'error');
      }, 'Copy ' + ref + ' to paste into a problem'),
      button('Replace', '', () => {
        replaceTarget = image.name;
        replaceInput.accept = extOf(image.name);
        replaceInput.value = '';
        replaceInput.click();
      }, 'Upload a new version — every problem using ' + ref + ' will show it'),
      button('Delete', 'btn-danger', () => confirmDeleteImage(image.name)),
    );

    info.append(name, meta, actions);
    card.append(thumb, info);
    return card;
  }

  async function loadLibrary() {
    try {
      const data = await api('/api/library');
      renderImages(data.images || []);
      renderSnippets(data.snippets || []);
    } catch (err) {
      toast('Could not load the library: ' + err.message, 'error');
      return;
    }
    loadUsage();
  }

  async function uploadImage(file, name) {
    const form = new FormData();
    form.append('file', file, name || file.name);
    return api('/api/library/images', { method: 'POST', body: form });
  }

  async function uploadFiles(files) {
    const list = Array.from(files || []);
    if (list.length === 0) return;
    let uploaded = 0;
    for (const file of list) {
      try {
        await uploadImage(file);
        uploaded += 1;
      } catch (err) {
        toast(file.name + ': ' + err.message, 'error');
      }
    }
    if (uploaded > 0) toast('Uploaded ' + uploaded + ' image' + (uploaded === 1 ? '' : 's'), 'ok');
    await refreshImages();
  }

  async function refreshImages() {
    try {
      const data = await api('/api/library');
      renderImages(data.images || []);
    } catch (err) {
      toast('Could not refresh the images: ' + err.message, 'error');
    }
  }

  replaceInput.addEventListener('change', async () => {
    const file = replaceInput.files && replaceInput.files[0];
    const target = replaceTarget;
    replaceTarget = null;
    if (!file || !target) return;
    // Keeping the name is what makes every problem pick up the new version — and the name's
    // extension decides how the image is served, so the new file has to be the same type
    if (extOf(file.name) !== extOf(target)) {
      toast('Choose a ' + extOf(target) + ' file to replace ' + target + ' (the name has to stay the same so problems keep working)', 'error');
      return;
    }
    try {
      await uploadImage(file, target);
      toast('Replaced ' + target + ' — every problem using it now shows the new version', 'ok');
      await refreshImages();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  async function confirmDeleteImage(name) {
    let folders;
    try {
      const data = await api('/api/library/images/' + encodeURIComponent(name) + '/usage');
      folders = data.folders || [];
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    openConfirm({
      title: 'Delete global/' + name + '?',
      text: folders.length === 0
        ? 'No problem uses this image. This cannot be undone.'
        : folders.length + ' problem' + (folders.length === 1 ? ' uses' : 's use') + ' this image and will show a "not found" warning until you pick another one:',
      items: folders,
      okLabel: folders.length === 0 ? 'Delete' : 'Delete anyway',
      onConfirm: async () => {
        await api('/api/library/images/' + encodeURIComponent(name), { method: 'DELETE' });
        toast('Deleted global/' + name, 'ok');
        await refreshImages();
      },
    });
  }

  drop.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    uploadFiles(fileInput.files);
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
    uploadFiles(e.dataTransfer && e.dataTransfer.files);
  });

  // ========== snippets ==========

  function renderSnippets(snippets) {
    snippetsList.replaceChildren(...snippets.map((s) => snippetCard(s, false)));
    updateSnippetsEmpty();
  }

  function updateSnippetsEmpty() {
    snippetsEmpty.hidden = snippetsList.children.length > 0;
  }

  function snippetCard(snippet, isNew) {
    // The name the server knows this snippet by — changes after a rename is saved
    let savedName = isNew ? null : snippet.name;
    let savedBody = isNew ? '' : snippet.body;

    const card = document.createElement('div');
    card.className = 'snippet-card';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = snippet.name;
    nameInput.placeholder = 'Snippet name, e.g. "Contest rules"';
    nameInput.maxLength = 80;
    nameInput.setAttribute('aria-label', 'Snippet name');

    const bodyInput = document.createElement('textarea');
    bodyInput.value = snippet.body;
    bodyInput.rows = 5;
    bodyInput.placeholder = 'The text to reuse';
    bodyInput.setAttribute('aria-label', 'Snippet text');

    // Non-empty exactly when there is something to lose — the beforeunload guard reads it
    const status = document.createElement('span');
    status.className = 'snippet-status';

    function isDirty() {
      return nameInput.value.trim() !== (savedName || '') || bodyInput.value !== savedBody;
    }
    function updateStatus() {
      status.textContent = !isDirty() ? '' : savedName === null ? 'Not saved yet' : 'Unsaved changes';
    }
    nameInput.addEventListener('input', updateStatus);
    bodyInput.addEventListener('input', updateStatus);

    const saveBtn = button('Save', 'btn-primary', async () => {
      const body = { name: nameInput.value, body: bodyInput.value };
      saveBtn.disabled = true;
      try {
        const data = savedName === null
          ? await sendJson('/api/library/snippets', 'POST', body)
          : await sendJson('/api/library/snippets/' + encodeURIComponent(savedName), 'PUT', body);
        savedName = data.snippet.name;
        savedBody = data.snippet.body;
        nameInput.value = savedName;
        bodyInput.value = savedBody;
        updateStatus();
        toast('Saved "' + savedName + '"', 'ok');
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        saveBtn.disabled = false;
      }
    });

    const copyBtn = button('Copy', '', async () => {
      const ok = await copyText(bodyInput.value);
      toast(ok ? 'Copied — paste it into a problem with Ctrl+V' : 'Could not copy — select the text and copy it by hand', ok ? 'ok' : 'error');
    });

    const deleteBtn = button('Delete', 'btn-danger', () => {
      if (savedName === null) {
        card.remove();
        updateSnippetsEmpty();
        return;
      }
      const name = savedName;
      openConfirm({
        title: 'Delete "' + name + '"?',
        text: 'Problems that already contain this text keep their copy. This cannot be undone.',
        onConfirm: async () => {
          await api('/api/library/snippets/' + encodeURIComponent(name), { method: 'DELETE' });
          card.remove();
          updateSnippetsEmpty();
          toast('Deleted "' + name + '"', 'ok');
        },
      });
    });

    const actions = document.createElement('div');
    actions.className = 'snippet-actions';
    actions.append(saveBtn, copyBtn, deleteBtn, status);

    card.append(nameInput, bodyInput, actions);
    updateStatus();
    return card;
  }

  newSnippetBtn.addEventListener('click', () => {
    const card = snippetCard({ name: '', body: '' }, true);
    snippetsList.prepend(card);
    updateSnippetsEmpty();
    card.querySelector('input').focus();
  });

  window.addEventListener('beforeunload', (e) => {
    const unsaved = Array.from(snippetsList.querySelectorAll('.snippet-status')).some((el) => el.textContent);
    if (unsaved) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  loadLibrary();
})();
