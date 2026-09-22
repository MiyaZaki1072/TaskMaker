/**
 * Studio page shells (dashboard + editor) — the client side is plain vanilla JS,
 * no build step, to match the style of the rest of the project.
 */
import { escapeHtml } from './text.js';

function shellHead(title: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<script>
  (function() {
    try {
      const theme = localStorage.getItem('studio-theme');
      if (theme === 'dark' || (!theme && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
        document.documentElement.setAttribute('data-theme', 'dark');
      }
    } catch(e) {}
  })();
</script>
<link rel="stylesheet" href="/assets/style.css">
<link rel="stylesheet" href="/studio-assets/studio.css">
</head>`;
}

export function dashboardPage(): string {
  return `${shellHead('Studio — Problem Maker')}
<body class="studio">
  <header class="topbar">
    <h1 class="topbar-title">Studio — Problem Maker</h1>
    <div class="topbar-actions">
      <button id="btn-theme" class="btn btn-sm" title="Toggle dark/light mode">🌙</button>
      <button id="btn-refresh" class="btn">Validate All</button>
      <button id="btn-export-all" class="btn">Export All (PDF)</button>
      <button id="btn-booklet" class="btn">Combine Into One Booklet</button>
      <button id="btn-export-zip" class="btn" title="Download every problem including assets as a ZIP file">📦 Export ZIP</button>
      <button id="btn-import-zip" class="btn" title="Import problems from a ZIP file">📥 Import ZIP</button>
      <button id="open-new" class="btn btn-primary">+ New Problem</button>
      <!-- A form rather than a link: signing out changes state, and a GET that logs you out can
           be triggered by any page that embeds the URL as an image. -->
      <form method="post" action="/logout" class="topbar-logout">
        <button type="submit" class="btn btn-sm" title="Sign out of Studio">Sign out</button>
      </form>
    </div>
  </header>

  <main class="page-body">
    <p class="section-label" id="section-problem-label">All Problems</p>
    <div id="problem-grid" class="grid"></div>
    <div id="empty-state" class="empty-state" hidden>
      <p>No problems yet</p>
      <p>Click "+ New Problem" above to get started, or "📥 Import ZIP" to import a problem package</p>
    </div>

    <p class="section-label">Latest Results</p>
    <div id="export-results"></div>
  </main>

  <dialog id="new-dialog" class="modal">
    <form id="new-form" method="dialog">
      <div class="modal-body">
        <h2>New Problem</h2>
        <p class="hint">Name the problem, e.g. "PrePosn2_Tree" — the system allows a maximum of 15 problems</p>
        <input id="new-name" type="text" placeholder="e.g. PrePosn2_Tree" autocomplete="off">
        <div id="new-error" class="modal-error"></div>
        <div class="modal-actions">
          <button id="new-cancel" type="button" class="btn">Cancel</button>
          <button type="submit" class="btn btn-primary">Create</button>
        </div>
      </div>
    </form>
  </dialog>

  <dialog id="import-dialog" class="modal">
    <div class="modal-body">
      <h2>Import Problems from a ZIP File</h2>
      <p class="hint">Choose or drag a previously-exported <code>.zip</code> file here — the system will pull in the problems and images automatically (maximum 15 problems)</p>

      <div class="import-mode-options" style="margin: 12px 0 16px; padding: 12px; border: 1px solid var(--line-soft); border-radius: 8px; font-size: 0.9rem;">
        <div style="font-weight: 600; margin-bottom: 8px;">When a problem name already exists:</div>
        <label style="display: flex; align-items: flex-start; gap: 8px; margin-bottom: 8px; cursor: pointer;">
          <input type="radio" name="import-mode" value="add" checked style="margin-top: 3px;">
          <span><strong>Add as new</strong> — creates a new entry with a number suffix (e.g. <code>name_1</code>), the existing one is not overwritten</span>
        </label>
        <label style="display: flex; align-items: flex-start; gap: 8px; cursor: pointer;">
          <input type="radio" name="import-mode" value="overwrite" style="margin-top: 3px;">
          <span><strong>Replace / Overwrite</strong> — overwrites the existing problem with the same name</span>
        </label>
      </div>

      <div id="zip-drop" class="asset-drop">Drag a .zip file here, or click to choose one</div>
      <input id="zip-file-input" type="file" accept=".zip,application/zip,application/x-zip-compressed" hidden>
      <div id="import-loading" style="display:none;padding:12px;text-align:center;color:var(--ink-soft);">⏳ Importing problems... please wait</div>
      <div id="import-error" class="modal-error"></div>
      <div class="modal-actions">
        <button id="import-close" type="button" class="btn">Close</button>
      </div>
    </div>
  </dialog>

  <dialog id="delete-dialog" class="modal">
    <div class="modal-body">
      <h2>Confirm Delete Problem</h2>
      <p class="hint" id="delete-confirm-text">Are you sure you want to delete this problem? This cannot be undone and all files in the folder will be permanently deleted.</p>
      <div id="delete-error" class="modal-error"></div>
      <div class="modal-actions">
        <button id="delete-cancel" type="button" class="btn">Cancel</button>
        <button id="delete-confirm-btn" type="button" class="btn btn-danger">Confirm Delete</button>
      </div>
    </div>
  </dialog>

  <dialog id="booklet-dialog" class="modal modal-wide">
    <div class="modal-body">
      <h2>📖 Combine Into One Booklet</h2>
      <p class="hint">Select problems and set contest details — the system will generate a cover page + table of contents + all selected problems as one PDF</p>

      <fieldset class="booklet-field">
        <legend>Contest Details</legend>
        <label>Contest name
          <input type="text" id="bk-contest-name" placeholder='e.g. "การแข่งขัน สอวน. คอมพิวเตอร์ ครั้งที่ 1"' autocomplete="off">
        </label>
        <label>Logo — optional (paste image URL or upload)
          <div class="input-with-btn">
            <input type="text" id="bk-logo-url" placeholder="Paste a URL or upload an image" autocomplete="off">
            <label class="btn btn-sm" style="margin:0;cursor:pointer;">📁 Upload<input type="file" id="bk-logo-file" accept="image/*" hidden></label>
          </div>
          <div id="bk-logo-preview" class="bk-logo-preview" hidden>
            <img id="bk-logo-img" alt="Logo preview">
            <button type="button" class="btn btn-sm" id="bk-logo-clear">✕ Remove</button>
          </div>
        </label>
        <label>Authors — one per line
          <textarea id="bk-authors" rows="3" placeholder='john smith\ntung tung tung sahur\ncat3000'></textarea>
        </label>
        <label>Rules / Notes — optional
          <textarea id="bk-rules" rows="3" placeholder='e.g. "ข้อสอบทั้งหมด 5 ข้อ เวลา 3 ชั่วโมง\nห้ามใช้ AI ทุกรูปแบบ"'></textarea>
        </label>
      </fieldset>

      <fieldset class="booklet-field">
        <legend>Select &amp; Order Problems</legend>
        <p class="hint" style="margin:0 0 8px">Drag ≡ to reorder, uncheck to exclude</p>
        <div class="bk-select-actions">
          <button type="button" class="btn btn-sm" id="bk-select-all">Select All</button>
          <button type="button" class="btn btn-sm" id="bk-select-none">Select None</button>
          <span id="bk-select-count" class="bk-select-count"></span>
        </div>
        <div id="bk-problem-list" class="bk-problem-list"></div>
      </fieldset>

      <div id="bk-error" class="modal-error"></div>
      <div id="bk-loading" style="display:none;padding:12px;text-align:center;color:var(--ink-soft);">⏳ Generating booklet... this may take a while</div>
      <div class="modal-actions">
        <button id="bk-cancel" type="button" class="btn">Cancel</button>
        <button id="bk-generate" type="button" class="btn btn-primary">📖 Generate Booklet</button>
      </div>
    </div>
  </dialog>

  <div id="toast-wrap" class="toast-wrap"></div>
  <script src="/studio-assets/dashboard.js" defer></script>
</body>
</html>`;
}

export interface EditorPageInfo {
  folder: string;
  code: string;
  name: string;
  content: string;
}

export function editorPage(info: EditorPageInfo): string {
  const folderAttr = escapeHtml(info.folder);
  const titleText = `${info.name} (${info.code})`;
  return `${shellHead(`Edit ${info.code}`)}
<body class="studio" data-folder="${folderAttr}">
  <div class="editor-shell">
    <header class="topbar editor-topbar">
      <div>
        <a href="/">← Back to main page</a>
        <div id="editor-title" style="font-weight:700;font-size:1.05rem">${escapeHtml(titleText)}</div>
      </div>
      <div class="topbar-actions">
        <div id="editor-status" class="editor-status"><span class="dot"></span><span id="editor-status-text">Loading...</span></div>
        <div class="mode-switch-wrapper">
          <span class="mode-switch-label">Mode:</span>
          <div class="segmented-switch" id="mode-switch" role="group" aria-label="Edit mode">
            <button type="button" class="switch-btn is-active" id="btn-mode-form" title="Switch to form mode">📝 Form (Input)</button>
            <button type="button" class="switch-btn" id="btn-mode-source" title="Switch to source mode">💻 Source (YAML)</button>
          </div>
        </div>
        <button id="btn-theme" class="btn btn-sm" title="Toggle dark/light mode">🌙</button>
        <button id="btn-assets" class="btn">Manage Images</button>
        <a class="btn" target="_blank" rel="noopener" href="/preview/${encodeURIComponent(info.folder)}">Open Preview in New Tab</a>
        <button id="btn-pdf" class="btn">Export PDF</button>
        <a class="btn" href="/api/problems/${encodeURIComponent(info.folder)}/export-zip" title="Download this problem with its images as a ZIP file">📦 Export ZIP</a>
        <button id="btn-save" class="btn btn-primary">Save (Ctrl+S)</button>
        <button id="btn-delete-editor" type="button" class="btn btn-danger" title="Delete this problem">🗑️ Delete</button>
      </div>
    </header>

    <div id="error-banner" class="editor-error-banner" hidden></div>
    <div id="warn-banner" class="editor-warn-banner" hidden></div>

    <div class="editor-body">
      <div class="editor-pane" id="form-pane">
        <div class="editor-form" id="editor-form">
          <fieldset>
            <legend>Problem Info</legend>
            <label>Problem code (code)<input type="text" id="f-code" autocomplete="off"></label>
            <label>Problem name (name)<input type="text" id="f-name" autocomplete="off"></label>
            <label>Logo (logo) — optional
              <div class="input-with-btn">
                <input type="text" id="f-logo" placeholder="e.g. assets/logo.png" autocomplete="off">
                <button type="button" class="btn btn-sm btn-pick-img" data-target="f-logo">🖼️ Choose Image</button>
              </div>
            </label>
            <label>Author (author)<input type="text" id="f-author" autocomplete="off"></label>
          </fieldset>
          <fieldset>
            <legend>Story</legend>
            <div class="field-header">
              <label for="f-story">Story (story)</label>
              <button type="button" class="btn btn-sm btn-insert-img" data-target="f-story">🖼️ Insert Image</button>
            </div>
            <div class="field-hint">💡 <strong>How to insert an image:</strong> type <code>img</code> in the story to pick from uploaded images, or type <code>[img: assets/filename.png]</code> (you can add a caption, e.g. <code>[img: assets/filename.png | image caption]</code>, and a size in pixels or %, e.g. <code>[img: assets/filename.png | image caption | 300]</code>)</div>
            <div class="field-hint">💡 <strong>Text formatting:</strong> <code>[b]bold text[/b]</code> for bold &middot; <code>[br]</code> to break to a new line without starting a new paragraph &middot; wrap anything in <code>[center]...[/center]</code>, <code>[left]...[/left]</code>, or <code>[right]...[/right]</code> to align it (works on text and images)</div>
            <textarea id="f-story" rows="6"></textarea>
          </fieldset>
          <fieldset>
            <legend>Input / Output</legend>
            <label>Input format (input_format) — one item per line<textarea id="f-input-format" rows="3"></textarea></label>
            <label>Output format (output_format) — one item per line<textarea id="f-output-format" rows="2"></textarea></label>
          </fieldset>
          <fieldset>
            <legend>Constraints</legend>
            <label>Constraints (constraints) — one item per line<textarea id="f-constraints" rows="3"></textarea></label>
          </fieldset>
          <fieldset>
            <legend>Subtasks (subtasks) — leave empty if none</legend>
            <div id="f-subtasks"></div>
            <button type="button" id="btn-add-subtask" class="btn btn-sm">+ Add Subtask</button>
          </fieldset>
          <fieldset>
            <legend>Examples</legend>
            <div id="f-examples"></div>
            <button type="button" id="btn-add-example" class="btn btn-sm">+ Add Example</button>
          </fieldset>
          <fieldset>
            <legend>Limits</legend>
            <label>Time (time)<input type="text" id="f-time" placeholder='e.g. "1 second"' autocomplete="off"></label>
            <label>Memory (memory)<input type="text" id="f-memory" placeholder='e.g. "256 MiB"' autocomplete="off"></label>
          </fieldset>
        </div>
      </div>
      <div class="editor-pane" id="source-pane" hidden>
        <textarea id="yaml-editor" spellcheck="false" autocapitalize="off" autocorrect="off">${escapeHtml(info.content)}</textarea>
      </div>
      <div class="preview-pane">
        <iframe id="preview-frame" src="/preview/${encodeURIComponent(info.folder)}" title="Problem preview"></iframe>
      </div>
    </div>
  </div>

  <dialog id="asset-dialog" class="modal modal-wide">
    <div class="modal-body">
      <h2>Images for This Problem</h2>
      <p class="hint">Upload an image, then click it to copy the filename (e.g. <code>assets/logo.png</code>) to paste into the <code>logo:</code> or <code>image:</code> field</p>
      <div id="asset-drop" class="asset-drop">Drag image files here, or click to choose one<br>(.png .jpg .jpeg .gif .svg .webp)</div>
      <input id="asset-file-input" type="file" accept="image/png,image/jpeg,image/gif,image/svg+xml,image/webp" multiple hidden>
      <div id="asset-grid" class="asset-grid"></div>
      <div class="modal-actions">
        <button id="asset-close" type="button" class="btn">Close</button>
      </div>
    </div>
  </dialog>

  <div id="img-autocomplete" class="img-autocomplete" hidden>
    <div class="img-autocomplete-head">
      <span>🖼️ Pick an image to insert (press Esc to close)</span>
      <button type="button" id="ac-upload-btn" class="btn btn-sm">+ Upload Image</button>
    </div>
    <div id="img-autocomplete-list" class="img-autocomplete-list"></div>
  </div>

  <dialog id="picker-dialog" class="modal modal-wide">
    <div class="modal-body">
      <h2>Choose an Image</h2>
      <p class="hint">Click an image to select it, or upload a new one below</p>
      <div id="picker-grid" class="asset-grid"></div>
      <div class="modal-actions" style="justify-content:space-between;align-items:center;">
        <button id="picker-upload" type="button" class="btn btn-sm">+ Upload New Image</button>
        <button id="picker-close" type="button" class="btn">Cancel</button>
      </div>
    </div>
  </dialog>

  <div id="toast-wrap" class="toast-wrap"></div>
  <script src="/studio-assets/editor.js" defer></script>
</body>
</html>`;
}

export interface LoginPageInfo {
  /** Shown above the field when a previous attempt failed */
  error?: string;
  /** Where to send the browser after a successful login */
  next?: string;
}

/**
 * The login page.
 *
 * Deliberately self-contained: its CSS is inline rather than pulled from /assets/style.css and
 * /studio-assets/studio.css, because this is the one page served to someone who is not logged in
 * yet. Linking those stylesheets would mean opening the static routes to anonymous requests just
 * to make the login page look right — a wider hole than the page is worth. It is a few hundred
 * bytes either way.
 */
export function loginPage(info: LoginPageInfo = {}): string {
  const error = info.error
    ? `<p class="error" role="alert">${escapeHtml(info.error)}</p>`
    : '';
  // Only ever a same-site path (studio-server.ts rejects anything else), so this cannot be turned
  // into an open redirect that sends someone to another site after they log in.
  const next = info.next ? `<input type="hidden" name="next" value="${escapeHtml(info.next)}">` : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in — Problem Studio</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f4f5f7;
    --card: #ffffff;
    --ink: #1b1f27;
    --ink-soft: #5c6473;
    --line: #d9dde4;
    --accent: #2f6fed;
    --accent-ink: #ffffff;
    --error-bg: #fdecec;
    --error-ink: #a32222;
    --error-line: #f0b9b9;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14171d;
      --card: #1d212a;
      --ink: #e8ebf0;
      --ink-soft: #9aa3b2;
      --line: #313846;
      --accent: #5b8cf5;
      --accent-ink: #0d1016;
      --error-bg: #3a2020;
      --error-ink: #ff9b9b;
      --error-line: #5e2f2f;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: var(--bg);
    color: var(--ink);
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans Thai", Roboto, sans-serif;
  }
  .card {
    width: 100%;
    max-width: 360px;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 28px 26px 26px;
    box-shadow: 0 1px 2px rgba(0,0,0,.04), 0 8px 24px rgba(0,0,0,.06);
  }
  h1 { margin: 0 0 4px; font-size: 1.2rem; letter-spacing: -0.01em; }
  .sub { margin: 0 0 20px; color: var(--ink-soft); font-size: .875rem; }
  label { display: block; font-size: .8rem; font-weight: 600; color: var(--ink-soft); margin-bottom: 6px; }
  input[type=password] {
    width: 100%;
    padding: 10px 12px;
    font-size: 1rem;
    font-family: inherit;
    color: var(--ink);
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 8px;
  }
  input[type=password]:focus {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
    border-color: var(--accent);
  }
  button {
    width: 100%;
    margin-top: 16px;
    padding: 10px 14px;
    font-size: .95rem;
    font-family: inherit;
    font-weight: 600;
    color: var(--accent-ink);
    background: var(--accent);
    border: 0;
    border-radius: 8px;
    cursor: pointer;
  }
  button:hover { filter: brightness(1.06); }
  .error {
    margin: 0 0 16px;
    padding: 9px 12px;
    font-size: .85rem;
    color: var(--error-ink);
    background: var(--error-bg);
    border: 1px solid var(--error-line);
    border-radius: 8px;
  }
</style>
</head>
<body>
  <main class="card">
    <h1>Problem Studio</h1>
    <p class="sub">Enter the studio password to continue.</p>
    ${error}
    <form method="post" action="/login">
      ${next}
      <label for="password">Password</label>
      <input type="password" id="password" name="password" autocomplete="current-password"
             autofocus required>
      <button type="submit">Sign in</button>
    </form>
  </main>
</body>
</html>`;
}
