// Studio problem editor: edit problem.yaml + live preview + manage images + export PDF
// Supports 2 modes: Form mode (default) and Source mode (edit YAML directly)
// Supports the image picker and an "img" autocomplete that inserts an image reference automatically
(() => {
  'use strict';

  const folder = document.body.dataset.folder;
  const enc = encodeURIComponent(folder);

  const textarea = document.getElementById('yaml-editor');
  const iframe = document.getElementById('preview-frame');
  const statusEl = document.getElementById('editor-status');
  const statusText = document.getElementById('editor-status-text');
  const saveBtn = document.getElementById('btn-save');
  const pdfBtn = document.getElementById('btn-pdf');
  const assetsBtn = document.getElementById('btn-assets');
  const errorBanner = document.getElementById('error-banner');
  const warnBanner = document.getElementById('warn-banner');
  const toastWrap = document.getElementById('toast-wrap');

  // mode switch (segmented control)
  const btnModeForm = document.getElementById('btn-mode-form');
  const btnModeSource = document.getElementById('btn-mode-source');
  const formPane = document.getElementById('form-pane');
  const sourcePane = document.getElementById('source-pane');

  // form fields
  const fCode = document.getElementById('f-code');
  const fName = document.getElementById('f-name');
  const fLogo = document.getElementById('f-logo');
  const fAuthor = document.getElementById('f-author');
  const fStory = document.getElementById('f-story');
  const fInputFormat = document.getElementById('f-input-format');
  const fOutputFormat = document.getElementById('f-output-format');
  const fConstraints = document.getElementById('f-constraints');
  const fSubtasksWrap = document.getElementById('f-subtasks');
  const fExamplesWrap = document.getElementById('f-examples');
  const fTime = document.getElementById('f-time');
  const fMemory = document.getElementById('f-memory');

  // image picker & autocomplete elements
  const pickerDialog = document.getElementById('picker-dialog');
  const pickerGrid = document.getElementById('picker-grid');
  const pickerUploadBtn = document.getElementById('picker-upload');
  const pickerCloseBtn = document.getElementById('picker-close');
  const acBox = document.getElementById('img-autocomplete');
  const acList = document.getElementById('img-autocomplete-list');
  const acUploadBtn = document.getElementById('ac-upload-btn');

  let originalContent = textarea.value;
  // Fingerprint of the problem.yaml this editor loaded. Sent back on save so the server can tell
  // us when somebody else changed the file in the meantime.
  let baseVersion = null;
  let dirty = false;
  let sourceMode = false;
  let cachedAssets = [];
  let pickerTarget = null;
  let acTarget = null;
  let acSelectedIndex = 0;
  let currentAssets = [];

  // ========== helpers ==========

  function toast(message, type) {
    const el = document.createElement('div');
    el.className = 'toast' + (type ? ' toast-' + type : '');
    el.textContent = message;
    toastWrap.appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  async function api(url, options) {
    const res = await fetch(url, options);
    let data = null;
    try { data = await res.json(); } catch { /* no body, that's fine */ }
    if (!res.ok) {
      const msg = (data && data.error && data.error.message) || 'An error occurred (HTTP ' + res.status + ')';
      throw new Error(msg);
    }
    return data;
  }

  function setStatus(kind, text) {
    statusEl.classList.remove('is-dirty', 'is-ok', 'is-error');
    if (kind) statusEl.classList.add(kind);
    statusText.textContent = text;
  }

  function setDirty(isDirty) {
    dirty = isDirty;
    if (isDirty) setStatus('is-dirty', 'Unsaved changes (Ctrl+S to save)');
  }

  function renderErrorBanner(error) {
    if (!error) {
      errorBanner.hidden = true;
      errorBanner.innerHTML = '';
      return;
    }
    let html = '<strong>' + escapeHtml(error.message) + '</strong>';
    if (error.file) html += '<div>File: <code>' + escapeHtml(error.file) + '</code></div>';
    if (error.details && error.details.length) {
      html += '<ul>' + error.details.map((d) => '<li>' + escapeHtml(d) + '</li>').join('') + '</ul>';
    }
    if (error.hint) html += '<div>Fix: ' + escapeHtml(error.hint) + '</div>';
    errorBanner.innerHTML = html;
    errorBanner.hidden = false;
  }

  function renderWarnBanner(warnings) {
    if (!warnings || warnings.length === 0) {
      warnBanner.hidden = true;
      warnBanner.innerHTML = '';
      return;
    }
    warnBanner.innerHTML = '<strong>Warnings:</strong><ul>' +
      warnings.map((w) => '<li>' + escapeHtml(w) + '</li>').join('') + '</ul>';
    warnBanner.hidden = false;
  }

  function reloadPreview() {
    try {
      iframe.contentWindow.location.reload();
    } catch {
      iframe.src = iframe.src;
    }
  }

  async function fetchAssets(force = false) {
    if (cachedAssets.length > 0 && !force) return cachedAssets;
    try {
      const data = await api('/api/problems/' + enc + '/assets');
      cachedAssets = data.assets || [];
    } catch {
      cachedAssets = [];
    }
    return cachedAssets;
  }

  // ========== YAML ↔ Form conversion ==========

  /** Escape a YAML string value — wrap in double quotes */
  function yamlStr(val) {
    if (!val) return '""';
    return '"' + val.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }

  /** Build YAML string from form fields */
  function formToYaml() {
    const lines = [];

    lines.push('task:');
    lines.push('  code: ' + yamlStr(fCode.value));
    lines.push('  name: ' + yamlStr(fName.value));
    lines.push('');

    if (fLogo.value.trim()) {
      lines.push('logo: ' + yamlStr(fLogo.value.trim()));
      lines.push('');
    }

    // story — use YAML block scalar
    lines.push('story: |');
    const storyLines = fStory.value.replace(/\r\n/g, '\n').replace(/\s+$/, '').split('\n');
    for (const line of storyLines) {
      lines.push('  ' + line);
    }
    lines.push('');

    // input_format
    lines.push('input_format:');
    const inputLines = fInputFormat.value.replace(/\r\n/g, '\n').trim().split('\n').filter(Boolean);
    for (const line of inputLines) {
      lines.push('  - ' + yamlStr(line.trim()));
    }
    lines.push('');

    // output_format
    lines.push('output_format:');
    const outputLines = fOutputFormat.value.replace(/\r\n/g, '\n').trim().split('\n').filter(Boolean);
    for (const line of outputLines) {
      lines.push('  - ' + yamlStr(line.trim()));
    }
    lines.push('');

    // constraints
    lines.push('constraints:');
    const constraintLines = fConstraints.value.replace(/\r\n/g, '\n').trim().split('\n').filter(Boolean);
    for (const line of constraintLines) {
      lines.push('  - ' + yamlStr(line.trim()));
    }
    lines.push('');

    // subtasks
    const subtaskEls = fSubtasksWrap.querySelectorAll('.form-group-item');
    if (subtaskEls.length > 0) {
      lines.push('subtasks:');
      subtaskEls.forEach((el) => {
        const score = el.querySelector('.st-score').value.trim() || '0';
        const cond = el.querySelector('.st-condition').value.trim();
        lines.push('  - score: ' + score);
        lines.push('    condition: ' + yamlStr(cond));
      });
    } else {
      lines.push('subtasks: []');
    }
    lines.push('');

    // examples
    lines.push('examples:');
    const exampleEls = fExamplesWrap.querySelectorAll('.form-group-item');
    exampleEls.forEach((el) => {
      const input = el.querySelector('.ex-input').value.replace(/\r\n/g, '\n').replace(/\s+$/, '');
      const output = el.querySelector('.ex-output').value.replace(/\r\n/g, '\n').replace(/\s+$/, '');
      const explanation = el.querySelector('.ex-explanation').value.replace(/\r\n/g, '\n').replace(/\s+$/, '');
      const image = el.querySelector('.ex-image').value.trim();

      lines.push('  - input: |');
      for (const line of input.split('\n')) {
        lines.push('      ' + line);
      }
      if (output.includes('\n')) {
        lines.push('    output: |');
        for (const line of output.split('\n')) {
          lines.push('      ' + line);
        }
      } else {
        lines.push('    output: ' + yamlStr(output));
      }
      if (explanation) {
        lines.push('    explanation: |');
        for (const line of explanation.split('\n')) {
          lines.push('      ' + line);
        }
      }
      if (image) {
        lines.push('    image: ' + yamlStr(image));
      }
    });
    lines.push('');

    // limits
    lines.push('limits:');
    lines.push('  time: ' + yamlStr(fTime.value.trim()));
    lines.push('  memory: ' + yamlStr(fMemory.value.trim()));
    lines.push('');

    // author
    lines.push('author: ' + yamlStr(fAuthor.value.trim()));
    lines.push('');

    return lines.join('\n');
  }

  /** Minimalist YAML parser for our known problem schema */
  function parseSimpleYaml(text) {
    const result = {
      task: { code: '', name: '' },
      logo: '',
      author: '',
      story: '',
      input_format: [],
      output_format: [],
      constraints: [],
      subtasks: [],
      examples: [],
      limits: { time: '', memory: '' },
    };

    const lines = text.replace(/\r\n/g, '\n').split('\n');
    let i = 0;

    function skipComments() {
      while (i < lines.length && (/^\s*#/.test(lines[i]) || /^\s*$/.test(lines[i]))) i++;
    }

    function peekIndent() {
      if (i >= lines.length) return -1;
      const m = lines[i].match(/^(\s*)/);
      return m ? m[1].length : 0;
    }

    function readValue(line) {
      let val = line;
      const m = val.match(/^("(?:[^"\\]|\\.)*"|'[^']*'|[^#]*?)(\s*#.*)?$/);
      if (m) val = m[1];
      val = val.trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
        val = val.replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, '\\');
      }
      return val;
    }

    function readBlockScalar() {
      i++;
      const blockLines = [];
      const baseIndent = peekIndent();
      if (baseIndent <= 0) return '';
      while (i < lines.length) {
        const line = lines[i];
        if (/^\s*$/.test(line)) { blockLines.push(''); i++; continue; }
        const indent = peekIndent();
        if (indent < baseIndent) break;
        blockLines.push(line.slice(baseIndent));
        i++;
      }
      while (blockLines.length && blockLines[blockLines.length - 1] === '') blockLines.pop();
      return blockLines.join('\n');
    }

    function readList() {
      const items = [];
      const baseIndent = peekIndent();
      while (i < lines.length) {
        skipComments();
        if (i >= lines.length) break;
        const indent = peekIndent();
        if (indent < baseIndent) break;
        const line = lines[i].trim();
        if (!line.startsWith('- ') && line !== '-') break;
        items.push(readValue(line.slice(2)));
        i++;
      }
      return items;
    }

    while (i < lines.length) {
      skipComments();
      if (i >= lines.length) break;

      const line = lines[i];
      const trimmed = line.trim();

      if (trimmed === 'task:') {
        i++;
        while (i < lines.length && peekIndent() > 0) {
          skipComments();
          if (i >= lines.length) break;
          const sub = lines[i].trim();
          if (sub.startsWith('code:')) { result.task.code = readValue(sub.slice(5)); i++; }
          else if (sub.startsWith('name:')) { result.task.name = readValue(sub.slice(5)); i++; }
          else { i++; }
        }
      } else if (trimmed.startsWith('logo:')) {
        result.logo = readValue(trimmed.slice(5)); i++;
      } else if (trimmed.startsWith('author:')) {
        result.author = readValue(trimmed.slice(7)); i++;
      } else if (trimmed === 'story: |' || trimmed === 'story: >') {
        result.story = readBlockScalar();
      } else if (trimmed.startsWith('story:')) {
        result.story = readValue(trimmed.slice(6)); i++;
      } else if (trimmed === 'input_format:') {
        i++; result.input_format = readList();
      } else if (trimmed === 'output_format:') {
        i++; result.output_format = readList();
      } else if (trimmed === 'constraints:') {
        i++; result.constraints = readList();
      } else if (trimmed === 'subtasks: []') {
        result.subtasks = []; i++;
      } else if (trimmed === 'subtasks:') {
        i++;
        while (i < lines.length) {
          skipComments();
          if (i >= lines.length) break;
          if (peekIndent() < 2) break;
          const sub = lines[i].trim();
          if (sub.startsWith('- score:')) {
            const score = sub.slice(8).trim();
            i++; skipComments();
            let cond = '';
            if (i < lines.length) {
              const cl = lines[i].trim();
              if (cl.startsWith('condition:')) { cond = readValue(cl.slice(10)); i++; }
            }
            result.subtasks.push({ score: score, condition: cond });
          } else { i++; }
        }
      } else if (trimmed === 'examples:') {
        i++;
        while (i < lines.length) {
          skipComments();
          if (i >= lines.length) break;
          if (peekIndent() < 2) break;
          const sub = lines[i].trim();
          if (sub.startsWith('- input:')) {
            const ex = { input: '', output: '', explanation: '', image: '' };
            if (sub === '- input: |' || sub === '- input: >') {
              i++;
              const bl = [];
              while (i < lines.length && (peekIndent() >= 6 || /^\s*$/.test(lines[i]))) {
                if (/^\s*$/.test(lines[i])) { bl.push(''); i++; continue; }
                if (peekIndent() < 6) break;
                bl.push(lines[i].slice(6)); i++;
              }
              while (bl.length && bl[bl.length - 1] === '') bl.pop();
              ex.input = bl.join('\n');
            } else {
              ex.input = readValue(sub.slice(8)); i++;
            }
            while (i < lines.length) {
              skipComments();
              if (i >= lines.length) break;
              if (peekIndent() < 4) break;
              const fl = lines[i].trim();
              if (fl.startsWith('output: |') || fl.startsWith('output: >')) {
                i++;
                const bl = [];
                while (i < lines.length && (peekIndent() >= 6 || /^\s*$/.test(lines[i]))) {
                  if (/^\s*$/.test(lines[i])) { bl.push(''); i++; continue; }
                  if (peekIndent() < 6) break;
                  bl.push(lines[i].slice(6)); i++;
                }
                while (bl.length && bl[bl.length - 1] === '') bl.pop();
                ex.output = bl.join('\n');
              } else if (fl.startsWith('output:')) {
                ex.output = readValue(fl.slice(7)); i++;
              } else if (fl.startsWith('explanation: |') || fl.startsWith('explanation: >')) {
                i++;
                const bl = [];
                while (i < lines.length && (peekIndent() >= 6 || /^\s*$/.test(lines[i]))) {
                  if (/^\s*$/.test(lines[i])) { bl.push(''); i++; continue; }
                  if (peekIndent() < 6) break;
                  bl.push(lines[i].slice(6)); i++;
                }
                while (bl.length && bl[bl.length - 1] === '') bl.pop();
                ex.explanation = bl.join('\n');
              } else if (fl.startsWith('explanation:')) {
                ex.explanation = readValue(fl.slice(12)); i++;
              } else if (fl.startsWith('image:')) {
                ex.image = readValue(fl.slice(6)); i++;
              } else if (fl.startsWith('- ')) {
                break;
              } else { i++; }
            }
            result.examples.push(ex);
          } else { i++; }
        }
      } else if (trimmed === 'limits:') {
        i++;
        while (i < lines.length && peekIndent() > 0) {
          skipComments();
          if (i >= lines.length) break;
          const sub = lines[i].trim();
          if (sub.startsWith('time:')) { result.limits.time = readValue(sub.slice(5)); i++; }
          else if (sub.startsWith('memory:')) { result.limits.memory = readValue(sub.slice(7)); i++; }
          else { i++; }
        }
      } else { i++; }
    }

    return result;
  }

  /** Parse YAML text and populate form fields */
  function yamlToForm(yamlText) {
    try {
      const parsed = parseSimpleYaml(yamlText);
      if (!parsed) return;

      fCode.value = (parsed.task && parsed.task.code) || '';
      fName.value = (parsed.task && parsed.task.name) || '';
      fLogo.value = parsed.logo || '';
      fAuthor.value = parsed.author || '';
      fStory.value = parsed.story || '';
      fTime.value = (parsed.limits && parsed.limits.time) || '';
      fMemory.value = (parsed.limits && parsed.limits.memory) || '';

      fInputFormat.value = (parsed.input_format || []).join('\n');
      fOutputFormat.value = (parsed.output_format || []).join('\n');
      fConstraints.value = (parsed.constraints || []).join('\n');

      fSubtasksWrap.innerHTML = '';
      (parsed.subtasks || []).forEach((st) => addSubtaskItem(st.score, st.condition));

      fExamplesWrap.innerHTML = '';
      (parsed.examples || []).forEach((ex) => addExampleItem(ex.input, ex.output, ex.explanation, ex.image));
    } catch (err) {
      // The assignments above run in order, so a throw part-way leaves the form half filled —
      // which reads as "some of the default text is missing" rather than as an error. Say so
      // loudly in the status line too, not just in a toast that scrolls away.
      console.warn('Form parse error:', err);
      setStatus('is-error', 'Could not read this YAML into the form — switch to Source mode');
      toast('Could not read the YAML into the form, so some fields may be blank. Switch to Source (YAML) mode to see the real content. Details: ' + (err && err.message ? err.message : err), 'error');
    }
  }

  // ========== Dynamic subtask / example items ==========

  function addSubtaskItem(score, condition) {
    const item = document.createElement('div');
    item.className = 'form-group-item';
    const idx = fSubtasksWrap.querySelectorAll('.form-group-item').length + 1;
    item.innerHTML =
      '<div class="group-label">Subtask ' + idx + '</div>' +
      '<button type="button" class="btn-remove" aria-label="Remove">✕</button>' +
      '<div class="inline-fields">' +
        '<label>Score<input type="text" class="st-score" value="' + escapeHtml(String(score)) + '"></label>' +
        '<label>Condition<input type="text" class="st-condition" value="' + escapeHtml(String(condition)) + '"></label>' +
      '</div>';
    item.querySelector('.btn-remove').addEventListener('click', () => { item.remove(); renumberItems(fSubtasksWrap, 'Subtask'); setDirty(true); });
    item.querySelectorAll('input').forEach((inp) => inp.addEventListener('input', () => setDirty(true)));
    fSubtasksWrap.appendChild(item);
  }

  function addExampleItem(input, output, explanation, image) {
    const item = document.createElement('div');
    item.className = 'form-group-item';
    const idx = fExamplesWrap.querySelectorAll('.form-group-item').length + 1;
    item.innerHTML =
      '<div class="group-label">Example ' + idx + '</div>' +
      '<button type="button" class="btn-remove" aria-label="Remove">✕</button>' +
      '<label>Input (input)<textarea class="ex-input" rows="2">' + escapeHtml(input) + '</textarea></label>' +
      '<label>Output (output)<textarea class="ex-output" rows="1">' + escapeHtml(output) + '</textarea></label>' +
      '<label>Explanation (explanation) — optional<textarea class="ex-explanation" rows="2">' + escapeHtml(explanation) + '</textarea></label>' +
      '<label>Image (image) — optional' +
        '<div class="input-with-btn">' +
          '<input type="text" class="ex-image" value="' + escapeHtml(image) + '" placeholder="e.g. assets/example1.png">' +
          '<button type="button" class="btn btn-sm btn-pick-img">🖼️ Choose Image</button>' +
        '</div>' +
      '</label>';

    item.querySelector('.btn-remove').addEventListener('click', () => { item.remove(); renumberItems(fExamplesWrap, 'Example'); setDirty(true); });
    item.querySelector('.btn-pick-img').addEventListener('click', () => {
      openImagePicker(item.querySelector('.ex-image'), false);
    });
    item.querySelectorAll('input, textarea').forEach((inp) => inp.addEventListener('input', () => setDirty(true)));
    fExamplesWrap.appendChild(item);
  }

  function renumberItems(wrap, prefix) {
    wrap.querySelectorAll('.form-group-item').forEach((el, i) => {
      el.querySelector('.group-label').textContent = prefix + ' ' + (i + 1);
    });
  }

  document.getElementById('btn-add-subtask').addEventListener('click', () => { addSubtaskItem('', ''); setDirty(true); });
  document.getElementById('btn-add-example').addEventListener('click', () => { addExampleItem('', '', '', ''); setDirty(true); });

  // ========== Mode toggle (Segmented Switch) ==========

  function setEditMode(targetMode) {
    if (targetMode === 'source' && !sourceMode) {
      textarea.value = formToYaml();
      formPane.hidden = true;
      formPane.style.display = 'none';
      sourcePane.hidden = false;
      sourcePane.style.display = 'flex';
      sourceMode = true;
      btnModeForm?.classList.remove('is-active');
      btnModeSource?.classList.add('is-active');
    } else if (targetMode === 'form' && sourceMode) {
      yamlToForm(textarea.value);
      formPane.hidden = false;
      formPane.style.display = 'flex';
      sourcePane.hidden = true;
      sourcePane.style.display = 'none';
      sourceMode = false;
      btnModeForm?.classList.add('is-active');
      btnModeSource?.classList.remove('is-active');
    }
  }

  btnModeForm?.addEventListener('click', () => setEditMode('form'));
  btnModeSource?.addEventListener('click', () => setEditMode('source'));

  // ========== dirty tracking for form ==========
  document.querySelectorAll('#editor-form input, #editor-form textarea').forEach((el) => el.addEventListener('input', () => setDirty(true)));

  // ========== Image Picker Dialog ==========

  async function openImagePicker(targetEl, isInsert = false) {
    pickerTarget = { el: targetEl, isInsert };
    pickerGrid.innerHTML = '<p style="color:var(--ink-soft);grid-column:1/-1">Loading...</p>';
    pickerDialog.showModal();
    const assets = await fetchAssets(true);
    renderPickerGrid(assets);
  }

  function renderPickerGrid(assets) {
    pickerGrid.innerHTML = '';
    if (assets.length === 0) {
      pickerGrid.innerHTML = '<p style="color:var(--ink-soft);grid-column:1/-1">No images in this problem yet — click "+ Upload New Image" below to get started</p>';
      return;
    }
    assets.forEach((asset) => {
      const item = document.createElement('div');
      item.className = 'asset-item';
      item.title = 'Click to select assets/' + asset.name;
      item.innerHTML =
        '<img src="' + asset.url + '?v=' + Date.now() + '" alt="' + escapeHtml(asset.name) + '">' +
        '<span class="asset-name">' + escapeHtml(asset.name) + '</span>';
      item.addEventListener('click', () => {
        applyImageToTarget(asset.name);
        pickerDialog.close();
      });
      pickerGrid.appendChild(item);
    });
  }

  function applyImageToTarget(assetName) {
    if (!pickerTarget || !pickerTarget.el) return;
    const el = pickerTarget.el;
    const path = 'assets/' + assetName;
    if (pickerTarget.isInsert) {
      insertTextAtCursor(el, '[img: ' + path + ']');
    } else {
      el.value = path;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    setDirty(true);
    toast('Selected ' + path, 'ok');
  }

  pickerCloseBtn?.addEventListener('click', () => pickerDialog.close());
  pickerUploadBtn?.addEventListener('click', () => assetInput.click());

  // Connect pick-img buttons in form
  document.querySelector('[data-target="f-logo"]')?.addEventListener('click', () => {
    openImagePicker(fLogo, false);
  });
  document.querySelector('[data-target="f-story"]')?.addEventListener('click', () => {
    openImagePicker(fStory, true);
  });

  // ========== Autocomplete when typing "img" ==========

  function insertTextAtCursor(el, textToInsert, replaceLen = 0) {
    const start = el.selectionStart - replaceLen;
    const end = el.selectionEnd;
    const val = el.value;
    const before = val.slice(0, Math.max(0, start));
    const after = val.slice(end);
    el.value = before + textToInsert + after;
    const newPos = before.length + textToInsert.length;
    el.setSelectionRange(newPos, newPos);
    el.focus();
  }

  function hideImgAutocomplete() {
    acBox.hidden = true;
    acTarget = null;
  }

  async function checkImgTrigger(el) {
    if (!el || typeof el.selectionStart !== 'number') {
      hideImgAutocomplete();
      return;
    }
    const val = el.value.slice(0, el.selectionStart);
    // Check whether the last word before the cursor is "img" or "[img"
    const match = val.match(/(?:^|[\s\n\[])(img)$/i);
    if (!match) {
      hideImgAutocomplete();
      return;
    }

    acTarget = { el, triggerLen: match[1].length };
    currentAssets = await fetchAssets();
    acSelectedIndex = 0;

    const rect = el.getBoundingClientRect();
    const topPos = Math.min(window.innerHeight - 260, rect.top + Math.min(rect.height, 100));
    const leftPos = Math.max(10, Math.min(window.innerWidth - 330, rect.left + 15));
    acBox.style.top = topPos + 'px';
    acBox.style.left = leftPos + 'px';
    acBox.hidden = false;

    renderAcList();
  }

  function renderAcList() {
    acList.innerHTML = '';
    if (currentAssets.length === 0) {
      acList.innerHTML =
        '<div class="img-ac-empty">No images in this problem yet<br>' +
        '<button type="button" class="btn btn-sm" id="btn-ac-up" style="margin-top:6px">+ Upload Image</button></div>';
      document.getElementById('btn-ac-up')?.addEventListener('click', () => {
        hideImgAutocomplete();
        assetInput.click();
      });
      return;
    }

    currentAssets.forEach((asset, idx) => {
      const item = document.createElement('div');
      item.className = 'img-ac-item' + (idx === acSelectedIndex ? ' is-selected' : '');
      item.innerHTML =
        '<img class="img-ac-thumb" src="' + asset.url + '?v=' + Date.now() + '" alt="">' +
        '<div class="img-ac-info">' +
          '<span class="img-ac-name">' + escapeHtml(asset.name) + '</span>' +
          '<span class="img-ac-path">assets/' + escapeHtml(asset.name) + '</span>' +
        '</div>';
      item.addEventListener('click', () => commitAcSelection(asset.name));
      acList.appendChild(item);
    });
  }

  function updateAcSelectionVisual() {
    const items = acList.querySelectorAll('.img-ac-item');
    items.forEach((it, idx) => {
      it.classList.toggle('is-selected', idx === acSelectedIndex);
      if (idx === acSelectedIndex) {
        it.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  function commitAcSelection(assetName) {
    if (!acTarget || !acTarget.el) return;
    const el = acTarget.el;
    const path = 'assets/' + assetName;
    const isTextarea = el.tagName === 'TEXTAREA' || el.id === 'yaml-editor';
    const textToInsert = isTextarea ? '[img: ' + path + ']' : path;

    insertTextAtCursor(el, textToInsert, acTarget.triggerLen);
    hideImgAutocomplete();
    el.dispatchEvent(new Event('input', { bubbles: true }));
    setDirty(true);
    toast('Inserted image ' + path, 'ok');
  }

  acUploadBtn?.addEventListener('click', () => {
    hideImgAutocomplete();
    assetInput.click();
  });

  // Track input for autocomplete
  document.addEventListener('input', (ev) => {
    const target = ev.target;
    if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) {
      checkImgTrigger(target);
    }
  });

  document.addEventListener('click', (ev) => {
    if (!acBox.hidden && !acBox.contains(ev.target)) {
      hideImgAutocomplete();
    }
  });

  // ========== Load / Save ==========

  async function loadYaml() {
    const data = await api('/api/problems/' + enc + '/yaml');
    textarea.value = data.content;
    originalContent = data.content;
    baseVersion = data.version || null;
    dirty = false;
    yamlToForm(data.content);
    if (fExamplesWrap.querySelectorAll('.form-group-item').length === 0) {
      addExampleItem('', '', '', '');
    }
    formPane.hidden = false;
    formPane.style.display = 'flex';
    sourcePane.hidden = true;
    sourcePane.style.display = 'none';
    sourceMode = false;
    btnModeForm?.classList.add('is-active');
    btnModeSource?.classList.remove('is-active');
    setStatus('is-ok', 'Ready to edit');
    fetchAssets();
  }

  async function save() {
    setStatus(null, 'Saving...');
    saveBtn.disabled = true;
    try {
      let content;
      if (sourceMode) {
        content = textarea.value;
      } else {
        content = formToYaml();
        textarea.value = content;
      }

      const data = await api('/api/problems/' + enc + '/yaml', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, baseVersion }),
      });
      originalContent = content;
      baseVersion = data.version || null;
      dirty = false;

      // Somebody else saved this problem between our load and our save, so this save replaced
      // their version. Say so loudly — the old behaviour was to report a clean "Saved" and let
      // their work vanish without a trace.
      if (data.overwrote) {
        toast('Warning: someone else had saved this problem since you opened it, and your save has replaced their version. Reload the page to see the current file.', 'error');
      }

      if (data.ok) {
        setStatus(data.overwrote ? 'is-dirty' : 'is-ok', data.overwrote ? 'Saved (replaced a newer version)' : 'Saved');
        renderErrorBanner(null);
        renderWarnBanner(data.warnings);
        document.getElementById('editor-title').textContent = data.name + ' (' + data.code + ')';
      } else {
        setStatus('is-error', 'Saved, but there are still errors');
        renderErrorBanner(data.error);
        renderWarnBanner(null);
      }
      reloadPreview();
      return data.ok;
    } catch (err) {
      setStatus('is-error', 'Save failed');
      toast(err.message, 'error');
      return false;
    } finally {
      saveBtn.disabled = false;
    }
  }

  textarea.addEventListener('input', () => setDirty(textarea.value !== originalContent));

  textarea.addEventListener('keydown', (ev) => {
    if (ev.key === 'Tab' && acBox.hidden) {
      ev.preventDefault();
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      textarea.setRangeText('  ', start, end, 'end');
      textarea.dispatchEvent(new Event('input'));
    }
  });

  window.addEventListener('keydown', (ev) => {
    if (!acBox.hidden && currentAssets.length > 0) {
      if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        acSelectedIndex = (acSelectedIndex + 1) % currentAssets.length;
        updateAcSelectionVisual();
        return;
      }
      if (ev.key === 'ArrowUp') {
        ev.preventDefault();
        acSelectedIndex = (acSelectedIndex - 1 + currentAssets.length) % currentAssets.length;
        updateAcSelectionVisual();
        return;
      }
      if (ev.key === 'Enter' || ev.key === 'Tab') {
        ev.preventDefault();
        if (currentAssets[acSelectedIndex]) {
          commitAcSelection(currentAssets[acSelectedIndex].name);
        }
        return;
      }
      if (ev.key === 'Escape') {
        ev.preventDefault();
        hideImgAutocomplete();
        return;
      }
    }

    const isSave = (ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's';
    if (isSave) { ev.preventDefault(); save(); }
  });

  window.addEventListener('beforeunload', (ev) => {
    if (dirty) { ev.preventDefault(); ev.returnValue = ''; }
  });

  saveBtn.addEventListener('click', save);

  pdfBtn.addEventListener('click', async () => {
    if (dirty) {
      const shouldSave = window.confirm('There are unsaved changes. Save before exporting?');
      if (!shouldSave) return;
      const ok = await save();
      if (!ok) { toast('The file still has errors — fix them before exporting', 'error'); return; }
    }
    const original = pdfBtn.textContent;
    pdfBtn.disabled = true;
    pdfBtn.textContent = 'Generating...';
    try {
      const data = await api('/api/problems/' + enc + '/pdf', { method: 'POST' });
      toast('PDF is ready', 'ok');
      window.open(data.downloadUrl, '_blank');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      pdfBtn.disabled = false;
      pdfBtn.textContent = original;
    }
  });

  // ---------- Manage images ----------
  const assetDialog = document.getElementById('asset-dialog');
  const assetGrid = document.getElementById('asset-grid');
  const assetDrop = document.getElementById('asset-drop');
  const assetInput = document.getElementById('asset-file-input');

  async function refreshAssets() {
    assetGrid.innerHTML = '<p style="color:var(--ink-soft);grid-column:1/-1">Loading...</p>';
    try {
      const assets = await fetchAssets(true);
      assetGrid.innerHTML = '';
      if (assets.length === 0) {
        assetGrid.innerHTML = '<p style="color:var(--ink-soft);grid-column:1/-1">No images in this problem yet</p>';
        return;
      }
      for (const asset of assets) {
        const item = document.createElement('div');
        item.className = 'asset-item';
        item.title = 'Click to copy the filename assets/' + asset.name;
        item.innerHTML =
          '<img src="' + asset.url + '?v=' + Date.now() + '" alt="' + escapeHtml(asset.name) + '">' +
          '<span class="asset-name">' + escapeHtml(asset.name) + '</span>' +
          '<button class="asset-del" type="button" aria-label="Delete">✕</button>';
        item.querySelector('img').addEventListener('click', () => copyAssetName(asset.name));
        item.querySelector('.asset-del').addEventListener('click', () => removeAsset(asset.name));
        assetGrid.appendChild(item);
      }
    } catch (err) {
      assetGrid.innerHTML = '';
      toast(err.message, 'error');
    }
  }

  function copyAssetName(name) {
    const text = 'assets/' + name;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => toast('Copied: ' + text, 'ok'),
        () => toast('Copy failed — try typing it manually: ' + text, 'error'),
      );
    } else {
      toast('Put this in the file: ' + text);
    }
  }

  async function removeAsset(name) {
    if (!window.confirm('Delete file "' + name + '"?')) return;
    try {
      await api('/api/problems/' + enc + '/assets/' + encodeURIComponent(name), { method: 'DELETE' });
      toast('Deleted ' + name, 'ok');
      cachedAssets = [];
      refreshAssets();
      reloadPreview();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function uploadFiles(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    for (const file of files) {
      const body = new FormData();
      body.append('file', file, file.name);
      try {
        await api('/api/problems/' + enc + '/assets', { method: 'POST', body });
        toast('Uploaded ' + file.name, 'ok');
      } catch (err) {
        toast(file.name + ': ' + err.message, 'error');
      }
    }
    cachedAssets = [];
    refreshAssets();
    if (pickerDialog?.open) {
      fetchAssets(true).then(renderPickerGrid);
    }
    reloadPreview();
  }

  assetsBtn.addEventListener('click', () => { assetDialog.showModal(); refreshAssets(); });
  document.getElementById('asset-close')?.addEventListener('click', () => assetDialog.close());
  assetDrop?.addEventListener('click', () => assetInput.click());
  assetInput?.addEventListener('change', () => { uploadFiles(assetInput.files); assetInput.value = ''; });

  ['dragenter', 'dragover'].forEach((evt) => {
    assetDrop?.addEventListener(evt, (ev) => { ev.preventDefault(); assetDrop.classList.add('is-over'); });
  });
  ['dragleave', 'drop'].forEach((evt) => {
    assetDrop?.addEventListener(evt, (ev) => { ev.preventDefault(); assetDrop.classList.remove('is-over'); });
  });
  assetDrop?.addEventListener('drop', (ev) => { uploadFiles(ev.dataTransfer.files); });

  // ---------- auto-reload when the file is changed elsewhere ----------
  (() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let retry = 0;
    const connect = () => {
      const ws = new WebSocket(proto + '://' + location.host + '/__live');
      ws.addEventListener('open', () => { retry = 0; });
      ws.addEventListener('message', (event) => { if (event.data === 'reload') reloadPreview(); });
      ws.addEventListener('close', () => { retry += 1; setTimeout(connect, Math.min(2000, 200 * retry)); });
    };
    connect();
  })();

  // ---------- Delete problem ----------
  const deleteBtn = document.getElementById('btn-delete-editor');
  deleteBtn?.addEventListener('click', async () => {
    const ok = window.confirm('Are you sure you want to delete this problem? This cannot be undone and all files in the folder will be permanently deleted.');
    if (!ok) return;
    deleteBtn.disabled = true;
    try {
      await api('/api/problems/' + enc, { method: 'DELETE' });
      alert('Problem deleted — returning to the main page');
      window.location.href = '/';
    } catch (err) {
      toast(err.message, 'error');
      deleteBtn.disabled = false;
    }
  });

  loadYaml().catch((err) => toast(err.message, 'error'));
})();
