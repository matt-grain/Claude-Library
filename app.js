// CONFIG: name of the JSON index file that lists .md files (relative paths)
const INDEX_FILE = 'files.json';

const fileListEl = document.getElementById('fileList');
const mdContainer = document.getElementById('mdContainer');
// Determine the actual scrollable container for the rendered markdown.
// In the layout the `<main class="content">` is scrollable (not the inner `#mdContainer`).
function findScrollableAncestor(el) {
  let cur = el;
  while (cur && cur !== document.body && cur !== document.documentElement) {
    const style = window.getComputedStyle(cur);
    const overflowY = style.overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') return cur;
    cur = cur.parentElement;
  }
  // fallback to document.scrollingElement
  return document.scrollingElement || document.documentElement;
}
let scrollContainer = null;
let scrollListenerAttached = false;

function ensureScrollContainer() {
  if (!scrollContainer) {
    scrollContainer = findScrollableAncestor(mdContainer);
    if (scrollContainer && !scrollListenerAttached && scrollContainer.addEventListener) {
      scrollContainer.addEventListener('scroll', saveCurrentScrollDebounced);
      scrollListenerAttached = true;
    }
  }
  return scrollContainer;
}
const noFilesEl = document.getElementById('noFiles');
const placeholder = document.getElementById('placeholder');
const filterInput = document.getElementById('filter');
const refreshBtn = document.getElementById('refreshBtn');

let files = []; // will hold {name, path}
let displayed = [];
let activeIndex = -1;
let mdFolderPrefix = ''; // prefix for loading files (detected on init)

// Sidebar resizer: create a draggable handle to resize the left panel width
(function setupSidebarResizer() {
  try {
    const container = document.querySelector('.container');
    const sidebar = document.querySelector('.sidebar');
    const RESIZE_KEY = 'sidebarWidth:' + (location.host || location.hostname || 'global');
    if (!container || !sidebar) return;

    // create resizer element and insert between sidebar and content
    const resizer = document.createElement('div');
    resizer.className = 'resizer';
    // insert after sidebar
    sidebar.parentNode.insertBefore(resizer, sidebar.nextSibling);

    // apply saved width (if any)
    const saved = parseInt(localStorage.getItem(RESIZE_KEY), 10);
    if (Number.isFinite(saved) && saved > 80) {
      document.documentElement.style.setProperty('--left-w', saved + 'px');
    }

    let dragging = false;
    let startX = 0;
    let startWidth = 0;

    const minWidth = 160; // px
    const maxWidth = Math.max(480, window.innerWidth - 300); // don't let content collapse

    resizer.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      dragging = true;
      startX = e.clientX;
      const cur = getComputedStyle(sidebar).width;
      startWidth = parseInt(cur, 10);
      resizer.setPointerCapture(e.pointerId);
      document.documentElement.classList.add('resizing');
    });

    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      try { resizer.releasePointerCapture(e.pointerId); } catch (ex) {}
      document.documentElement.classList.remove('resizing');
      // persist width
      const w = parseInt(getComputedStyle(sidebar).width, 10);
      try { localStorage.setItem(RESIZE_KEY, String(w)); } catch (ex) {}
    }

    function onMove(e) {
      if (!dragging) return;
      const dx = e.clientX - startX;
      let newW = startWidth + dx;
      newW = Math.max(minWidth, Math.min(maxWidth, newW));
      document.documentElement.style.setProperty('--left-w', newW + 'px');
    }

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    // double-click resets sidebar width to default
    resizer.addEventListener('dblclick', (ev) => {
      ev.preventDefault();
      const defaultW = 320; // default sidebar width
      document.documentElement.style.setProperty('--left-w', defaultW + 'px');
      try { localStorage.setItem(RESIZE_KEY, String(defaultW)); } catch (ex) {}
    });
  } catch (e) {
    // fail silently
  }
})();

// --- Markdown zoom (Ctrl/Cmd + '+' / '-' / '0') ---
const MD_ZOOM_KEY = 'mdZoomScale';
const MD_BASE_FONT_SIZE = 16; // px
function getSavedZoom() {
  const v = parseFloat(localStorage.getItem(MD_ZOOM_KEY));
  return Number.isFinite(v) ? v : 1;
}
function applyZoom(scale) {
  // clamp between 0.6 and 2.0
  const s = Math.max(0.6, Math.min(2.0, Math.round(scale * 10) / 10));
  localStorage.setItem(MD_ZOOM_KEY, String(s));
  const size = Math.round(MD_BASE_FONT_SIZE * s);
  document.documentElement.style.setProperty('--md-font-size', `${size}px`);
  // notify listeners that zoom changed
  try { window.dispatchEvent(new CustomEvent('mdzoomchange', { detail: { scale: s } })); } catch (e) {}
}
function changeZoom(delta) {
  const cur = getSavedZoom();
  applyZoom(cur + delta);
}
// apply saved zoom on load
applyZoom(getSavedZoom());

// Ensure marked outputs language- class for fenced code
marked.setOptions({ gfm: true, breaks: false, headerIds: true });

function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

// Strip YAML frontmatter from markdown (content between --- at start of file)
function stripFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (match) {
    return text.slice(match[0].length);
  }
  return text;
}

// --- Find-in-markdown feature ---
let findState = {
  query: '',
  matches: [],      // array of elements
  current: -1,
  activePath: null, // path for which matches are valid
};

function clearFindHighlights() {
  if (!findState.matches.length) return;
  findState.matches.forEach(el => {
    const parent = el.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(el.textContent), el);
  });
  findState = { query: '', matches: [], current: -1, activePath: null };
}

// Safely wrap matches in text nodes with <mark class="md-find">
function highlightAllMatches(query) {
  clearFindHighlights();
  if (!query) return 0;
  const root = mdContainer;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const p = node.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      if (p.closest && p.closest('pre,code')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  }, false);

  // Collect nodes first to avoid mutating the DOM while walking (which can skip nodes)
  const textNodes = [];
  let n;
  while ((n = walker.nextNode())) textNodes.push(n);

  const created = [];
  const esc = escapeRegExp(query);
  for (const node of textNodes) {
    const text = node.nodeValue;
    const re = new RegExp(esc, 'gi'); // fresh RegExp per node
    let m;
    // quick skip if no match
    if (!re.test(text)) continue;
    re.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      const before = text.slice(lastIndex, m.index);
      if (before) frag.appendChild(document.createTextNode(before));
      const mark = document.createElement('mark');
      mark.className = 'md-find';
      mark.textContent = m[0];
      frag.appendChild(mark);
      created.push(mark);
      lastIndex = m.index + m[0].length;
      // avoid infinite loop for zero-length matches
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    const after = text.slice(lastIndex);
    if (after) frag.appendChild(document.createTextNode(after));
    node.parentNode.replaceChild(frag, node);
  }

  findState.matches = created;
  findState.current = created.length ? 0 : -1;
  findState.activePath = displayed && activeIndex >= 0 ? displayed[activeIndex].path : null;
  if (findState.matches.length) focusCurrentMatch();
  return findState.matches.length;
}

function focusCurrentMatch() {
  if (!findState.matches.length || findState.current < 0) return;
  findState.matches.forEach((el, i) => el.classList.toggle('current', i === findState.current));
  const el = findState.matches[findState.current];
  // Try to scroll the match into view using the browser API (scrolls nearest scrollable ancestor).
  try {
    el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    // A short timeout ensures a smooth scroll begins; fallback adjustment after layout if needed
    setTimeout(() => {
      // If the scroll container still doesn't contain the element in view, fall back to manual calculation.
      const sc = ensureScrollContainer();
      if (!sc) return;
      const containerRect = sc.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      if (elRect.top < containerRect.top || elRect.bottom > containerRect.bottom) {
        const offset = (elRect.top - containerRect.top) + sc.scrollTop - 20;
        sc.scrollTop = offset;
      }
    }, 60);
  } catch (e) {
    // fallback: manual calculation
    const sc = ensureScrollContainer();
    if (!sc) return;
    const containerRect = sc.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const offset = (elRect.top - containerRect.top) + sc.scrollTop - 20;
    sc.scrollTop = offset;
  }
}

// utility
function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function renderList(list) {
  // Build a hierarchical tree from flat list of paths and render a collapsible tree.
  displayed = list;
  fileListEl.innerHTML = '';
  if (!list.length) {
    noFilesEl.style.display = 'block';
    return;
  }
  noFilesEl.style.display = 'none';

  // Build tree as nested objects
  let root = { children: new Map(), files: [] };
  list.forEach((f, i) => {
    const parts = f.path.split('/');
    let node = root;
    for (let j = 0; j < parts.length - 1; j++) {
      const p = parts[j];
      if (!node.children.has(p)) node.children.set(p, { children: new Map(), files: [], name: p, path: parts.slice(0, j+1).join('/') });
      node = node.children.get(p);
    }
    node.files.push({ name: f.name, path: f.path, index: i });
  });

  // Store root globally for the collapse/expand button
  window.fileTreeRoot = root;

  // track expanded folders (initialize as empty set - collapsed by default)
  if (!renderList._expanded) {
    renderList._expanded = new Set();
  }

  // If there's a single top-level folder and no files at root, unwrap it
  // so the UI doesn't show an extra root folder (useful when all files
  // live under a single directory like `md/` or `md/plans/`).
  if (root.children.size === 1 && root.files.length === 0) {
    const only = Array.from(root.children.values())[0];
    // adopt the only child as the new root for rendering
    root = only;
  }

  function makeFolderLi(folder) {
    const li = document.createElement('li');
    li.className = 'folder';
    const header = document.createElement('div');
    header.className = 'folder-header';

    // Check if this is a "Done" folder
    const isDoneFolder = folder.name.toLowerCase() === 'done';
    if (isDoneFolder) {
      li.classList.add('done-folder');
    }

    const caret = document.createElement('span');
    caret.className = 'caret';
    const isExpanded = renderList._expanded.has(folder.path);
    caret.textContent = '›';
    if (isExpanded) caret.classList.add('expanded');
    const folderIcon = document.createElement('span');
    folderIcon.className = 'folder-icon';
    // Use checkmark icon for Done folders
    if (isDoneFolder) {
      folderIcon.textContent = '✅';
    } else {
      folderIcon.textContent = isExpanded ? '📂' : '📁';
    }
    const label = document.createElement('span');
    label.className = 'folder-label';
    label.textContent = folder.name;
    header.appendChild(caret);
    header.appendChild(folderIcon);
    header.appendChild(label);
    header.addEventListener('click', () => {
      // Toggle expansion in-place to avoid rebuilding the whole tree
      const path = folder.path;
      const currently = renderList._expanded.has(path);
      if (currently) {
        renderList._expanded.delete(path);
        caret.classList.remove('expanded');
        // Keep checkmark for Done folders, toggle for others
        if (!isDoneFolder) folderIcon.textContent = '📁';
        if (inner) inner.style.display = 'none';
      } else {
        renderList._expanded.add(path);
        caret.classList.add('expanded');
        if (!isDoneFolder) folderIcon.textContent = '📂';
        if (inner) inner.style.display = '';
      }
    });
    li.appendChild(header);
    const inner = document.createElement('ul');
    inner.className = 'folder-children';
    if (!isExpanded) inner.style.display = 'none';

    // add subfolders
    for (const child of Array.from(folder.children.values()).sort((a,b)=>a.name.localeCompare(b.name))) {
      inner.appendChild(makeFolderLi(child));
    }
    // add files
    for (const file of folder.files.sort((a,b)=>a.name.localeCompare(b.name))) {
      const fli = document.createElement('li');
      fli.className = 'file';
      fli.dataset.index = file.index;
      fli.tabIndex = 0;
      fli.innerHTML = `<span class="file-icon">📄</span><span class="filename">${escapeHtml(file.name)}</span>`;
      fli.addEventListener('click', () => selectFile(file.index));
      fli.addEventListener('keydown', (e) => { if (e.key === 'Enter') selectFile(file.index); });
      if (file.index === activeIndex) fli.classList.add('active');
      inner.appendChild(fli);
    }

    li.appendChild(inner);
    return li;
  }

  // render top-level folders first, then any root files
  for (const child of Array.from(root.children.values()).sort((a,b)=>a.name.localeCompare(b.name))) {
    fileListEl.appendChild(makeFolderLi(child));
  }

  // add files that are at root (displayed below folders)
  for (const f of root.files.sort((a,b)=>a.name.localeCompare(b.name))) {
    const fli = document.createElement('li');
    fli.className = 'file';
    fli.dataset.index = f.index;
    fli.tabIndex = 0;
    fli.innerHTML = `<span class="file-icon">📄</span><span class="filename">${escapeHtml(f.name)}</span>`;
    fli.addEventListener('click', () => selectFile(f.index));
    fli.addEventListener('keydown', (e) => { if (e.key === 'Enter') selectFile(f.index); });
    if (f.index === activeIndex) fli.classList.add('active');
    fileListEl.appendChild(fli);
  }

  // ensure active file's parent folders are expanded
  if (activeIndex >= 0 && displayed[activeIndex]) {
    const activePath = displayed[activeIndex].path;
    const parts = activePath.split('/');
    let cur = '';
    for (let i = 0; i < parts.length - 1; i++) {
      cur = cur ? (cur + '/' + parts[i]) : parts[i];
      renderList._expanded.add(cur);
    }
  }
}

// --- scroll-position helpers (per-file) ---
const SC_KEY_PREFIX = 'mdpos:'; // sessionStorage key prefix

function saveScrollPos(path) {
  try {
    const key = SC_KEY_PREFIX + path;
    const sc = ensureScrollContainer();
    const pos = (sc && typeof sc.scrollTop === 'number') ? sc.scrollTop : 0;
    sessionStorage.setItem(key, String(pos));
  } catch (e) { /* ignore */ }
}

function restoreScrollPos(path) {
  try {
    const key = SC_KEY_PREFIX + path;
    const v = sessionStorage.getItem(key);
    if (v !== null) {
      const sc = ensureScrollContainer();
      if (sc && typeof sc.scrollTop === 'number') {
        sc.scrollTop = parseInt(v, 10) || 0;
      } else if (document.scrollingElement) {
        document.scrollingElement.scrollTop = parseInt(v, 10) || 0;
      }
    } else {
      const sc = ensureScrollContainer();
      if (sc && typeof sc.scrollTop === 'number') sc.scrollTop = 0; else if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
    }
  } catch (e) {
    const sc = ensureScrollContainer();
    if (sc && typeof sc.scrollTop === 'number') sc.scrollTop = 0;
    else if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
  }
}

// debounce helper
function debounce(fn, wait = 150) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

const saveCurrentScrollDebounced = debounce(() => {
  if (!displayed || activeIndex < 0) return;
  const info = displayed[activeIndex];
  if (info) saveScrollPos(info.path);
}, 150);

// scroll listener will be attached when the scroll container is discovered (see `ensureScrollContainer`).
window.addEventListener('beforeunload', () => {
  if (!displayed || activeIndex < 0) return;
  const info = displayed[activeIndex];
  if (info) saveScrollPos(info.path);
});

function selectFile(idx) {
  const info = displayed[idx];
  if (!info) return;
  // save current file scroll before switching
  if (displayed && activeIndex >= 0 && displayed[activeIndex]) {
    saveScrollPos(displayed[activeIndex].path);
  }

  activeIndex = idx;
  renderList(displayed);

  placeholder.style.display = 'none';
  mdContainer.innerHTML = '<div class="empty">Loading…</div>';
  // Use mdFolderPrefix if the md/ mirror directory was detected
  const filePath = mdFolderPrefix + info.path;
  fetch(filePath).then(r => {
    if (!r.ok) throw new Error('Failed to load file');
    return r.text();
  }).then(txt => {
    const content = stripFrontmatter(txt);
    const html = marked.parse(content);
    mdContainer.innerHTML = html;
    // run highlight.js on code blocks
    document.querySelectorAll('#mdContainer pre code').forEach((block) => {
      try { hljs.highlightElement(block); } catch (e) {}
    });
    // restore scroll position for this file (after rendering)
    restoreScrollPos(info.path);
    history.replaceState(null, '', '#' + encodeURIComponent(info.path));
  }).catch(err => {
    mdContainer.innerHTML = `<div class="empty">Error loading file: ${escapeHtml(err.message)}</div>`;
  });
}

function applyFilter() {
  const q = filterInput.value.trim().toLowerCase();
  const filtered = files.filter(f => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q));
  activeIndex = -1;
  renderList(filtered);
  if (filtered.length === 1) selectFile(0);
}

// Fetch index and update files list
function fetchIndex({showLoading=false} = {}) {
  if (showLoading) {
    refreshBtn.disabled = true;
    refreshBtn.textContent = 'Refreshing…';
  } else {
    refreshBtn.disabled = true;
  }
  // Detect if md/ mirror directory exists by attempting to list it
  fetch('md/', { method: 'HEAD' }).then(r => {
    if (r.ok) mdFolderPrefix = 'md/';
  }).catch(() => {
    mdFolderPrefix = '';
  });
  
  return fetch(INDEX_FILE, {cache: "no-store"}).then(r => {
    if (!r.ok) throw new Error('Index file not found. Create files.json listing .md paths.');
    return r.json();
  }).then(list => {
    files = (Array.isArray(list) ? list.map(item => {
      if (typeof item === 'string') {
        const p = item;
        const n = p.split('/').pop();
        return {name: n, path: p};
      } else if (item && typeof item === 'object') {
        return { name: item.name || (item.path && item.path.split('/').pop()) || 'file', path: item.path };
      }
      return null;
    }).filter(Boolean) : []);
    window.fileTree = files;
    renderList(files);
    // If a file was open, try to keep it open
    const hash = decodeURIComponent(location.hash.slice(1) || '');
    if (hash) {
      const idx = files.findIndex(f=>f.path === hash);
      if (idx >= 0) selectFile(idx);
    }
  }).catch(err => {
    fileListEl.innerHTML = '';
    noFilesEl.style.display = 'block';
    noFilesEl.textContent = 'Failed to load index: ' + err.message;
  }).finally(()=> {
    refreshBtn.disabled = false;
    refreshBtn.textContent = 'Refresh';
  });
}

// Initial load
fetchIndex();

// Wire refresh button
refreshBtn.addEventListener('click', () => fetchIndex({showLoading:true}));

filterInput.addEventListener('input', applyFilter);

// Add zoom buttons to the bottom of the sidebar for explicit controls
const sidebarEl = document.querySelector('.sidebar');
if (sidebarEl) {
  // container anchored to bottom
  const zoomWrap = document.createElement('div');
  zoomWrap.className = 'zoom-controls';

  const zoomOutBtn = document.createElement('button');
  zoomOutBtn.className = 'zoom-btn btn';
  zoomOutBtn.title = 'Zoom out';
  zoomOutBtn.textContent = '−';

  const zoomResetBtn = document.createElement('button');
  zoomResetBtn.className = 'zoom-btn btn';
  zoomResetBtn.title = 'Reset zoom';
  zoomResetBtn.textContent = '100%';

  const zoomInBtn = document.createElement('button');
  zoomInBtn.className = 'zoom-btn btn';
  zoomInBtn.title = 'Zoom in';
  zoomInBtn.textContent = '+';

  zoomWrap.appendChild(zoomOutBtn);
  zoomWrap.appendChild(zoomResetBtn);
  zoomWrap.appendChild(zoomInBtn);
  // theme toggle (dark / light)
  const themeToggle = document.createElement('button');
  themeToggle.className = 'theme-toggle btn';
  themeToggle.title = 'Toggle dark / light mode';
  themeToggle.textContent = '🌙';
  zoomWrap.appendChild(themeToggle);
  // collapse/expand all folders button
  const toggleAllFoldersBtn = document.createElement('button');
  toggleAllFoldersBtn.className = 'toggle-folders-btn btn';
  toggleAllFoldersBtn.title = 'Collapse/Expand all folders';
  toggleAllFoldersBtn.textContent = '▶';
  zoomWrap.appendChild(toggleAllFoldersBtn);
  sidebarEl.appendChild(zoomWrap);

  zoomOutBtn.addEventListener('click', (e) => { e.preventDefault(); changeZoom(-0.1); });
  zoomInBtn.addEventListener('click', (e) => { e.preventDefault(); changeZoom(0.1); });
  zoomResetBtn.addEventListener('click', (e) => { e.preventDefault(); applyZoom(1); });

  function updateZoomLabel(ev) {
    const s = (ev && ev.detail && ev.detail.scale) ? ev.detail.scale : getSavedZoom();
    zoomResetBtn.textContent = Math.round(s * 100) + '%';
  }
  // initial label
  updateZoomLabel({ detail: { scale: getSavedZoom() } });
  window.addEventListener('mdzoomchange', updateZoomLabel);
  // theme handling (persist per-site)
  const THEME_KEY = 'mdTheme:' + (location.host || location.hostname || 'global');
  function applyTheme(t) {
    if (t === 'dark') {
      document.documentElement.classList.add('dark');
      themeToggle.textContent = '☀️';
      themeToggle.setAttribute('aria-pressed', 'true');
    } else {
      document.documentElement.classList.remove('dark');
      themeToggle.textContent = '🌙';
      themeToggle.setAttribute('aria-pressed', 'false');
    }
    try { localStorage.setItem(THEME_KEY, t); } catch (e) {}
  }
  function toggleTheme() {
    const cur = (localStorage.getItem(THEME_KEY) || 'light');
    applyTheme(cur === 'dark' ? 'light' : 'dark');
  }
  // initialize theme
  applyTheme(localStorage.getItem(THEME_KEY) || 'light');
  themeToggle.addEventListener('click', (e) => { e.preventDefault(); toggleTheme(); });

  // collapse/expand all folders toggle
  let allExpanded = false; // start collapsed by default
  toggleAllFoldersBtn.addEventListener('click', (e) => {
    e.preventDefault();
    if (!renderList._expanded) renderList._expanded = new Set();
    
    // Get all folder paths from the file tree
    const allFolders = new Set();
    function collectFolders(node) {
      for (const child of node.children.values()) {
        allFolders.add(child.path);
        collectFolders(child);
      }
    }
    if (window.fileTreeRoot) {
      collectFolders(window.fileTreeRoot);
    }
    
    // Toggle: if all expanded, collapse all; otherwise expand all
    if (allExpanded) {
      renderList._expanded.clear();
      allExpanded = false;
      toggleAllFoldersBtn.textContent = '▶';
    } else {
      renderList._expanded.clear();
      for (const folderPath of allFolders) {
        renderList._expanded.add(folderPath);
      }
      allExpanded = true;
      toggleAllFoldersBtn.textContent = '▼';
    }
    
    // Re-render the file list
    if (window.fileTree) {
      renderList(window.fileTree);
    }
  });
}

// Create find overlay elements
const findOverlay = document.createElement('div');
findOverlay.className = 'find-overlay';
findOverlay.style.display = 'none';
const findInput = document.createElement('input');
findInput.className = 'find-input';
findInput.type = 'search';
findInput.placeholder = 'Find in document (press Enter to go to next)';
const findBtn = document.createElement('button');
findBtn.className = 'find-btn';
findBtn.textContent = 'Find';
const findCount = document.createElement('div');
findCount.className = 'find-count';
findOverlay.appendChild(findInput);
// Prev / Next buttons for navigating matches
const prevBtn = document.createElement('button');
prevBtn.className = 'find-prev';
prevBtn.title = 'Previous match';
prevBtn.ariaLabel = 'Previous match';
prevBtn.textContent = '▲';

const nextBtn = document.createElement('button');
nextBtn.className = 'find-next';
nextBtn.title = 'Next match';
nextBtn.ariaLabel = 'Next match';
nextBtn.textContent = '▼';

findOverlay.appendChild(prevBtn);
findOverlay.appendChild(nextBtn);
findOverlay.appendChild(findBtn);
findOverlay.appendChild(findCount);
document.body.appendChild(findOverlay);

// add a close (×) control and focus-on-click behavior so Escape reliably closes
const closeBtn = document.createElement('button');
closeBtn.className = 'find-close';
closeBtn.type = 'button';
closeBtn.title = 'Close';
closeBtn.textContent = '×';
// insert the close button before the input so it appears to the left
findOverlay.insertBefore(closeBtn, findInput);

// clicking anywhere in the overlay focuses the input (so Escape closes)
findOverlay.addEventListener('click', (ev) => {
  // if user clicked the explicit close button, let its handler run instead
  if (ev.target === closeBtn) return;
  try { findInput.focus(); } catch (e) {}
});

closeBtn.addEventListener('click', (ev) => {
  ev.stopPropagation();
  ev.preventDefault();
  findOverlay.style.display = 'none';
});

// Global Escape handler to close the overlay when it's visible
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && findOverlay.style.display !== 'none') {
    ev.preventDefault();
    findOverlay.style.display = 'none';
  }
});

function openFindOverlay(initial = '') {
  findOverlay.style.display = 'flex';
  findInput.value = initial;
  findInput.focus();
  findInput.select();
}

function closeFindOverlay() {
  findOverlay.style.display = 'none';
  // keep highlights but reset active index so next open will continue cycling from 0
}

// handle find action: highlight and move to next
function doFindNext() {
  const q = findInput.value.trim();
  if (!q) return;
  // If opened for different file, re-run highlight
  const currentPath = displayed && activeIndex >= 0 ? displayed[activeIndex].path : null;
  if (findState.activePath !== currentPath || findState.query !== q) {
    clearFindHighlights();
    findState.query = q;
    const total = highlightAllMatches(q);
    findCount.textContent = total ? `${1}/${total}` : '0/0';
    if (!total) return;
  } else {
    // same query/file: advance index
    findState.current = (findState.current + 1) % Math.max(1, findState.matches.length);
    focusCurrentMatch();
    findCount.textContent = `${findState.current + 1}/${findState.matches.length}`;
  }
  // update count to current/total
  if (findState.matches.length) {
    findCount.textContent = `${findState.current + 1}/${findState.matches.length}`;
  }
}

function doFindPrev() {
  const q = findInput.value.trim();
  if (!q) return;
  const currentPath = displayed && activeIndex >= 0 ? displayed[activeIndex].path : null;
  if (findState.activePath !== currentPath || findState.query !== q) {
    clearFindHighlights();
    findState.query = q;
    const total = highlightAllMatches(q);
    if (!total) {
      findCount.textContent = '0/0';
      return;
    }
    // start at last match when requesting previous on a fresh search
    findState.current = findState.matches.length - 1;
    focusCurrentMatch();
  } else {
    if (!findState.matches.length) return;
    findState.current = (findState.current - 1 + findState.matches.length) % findState.matches.length;
    focusCurrentMatch();
  }
  if (findState.matches.length) {
    findCount.textContent = `${findState.current + 1}/${findState.matches.length}`;
  }
}

// Bind events
findBtn.addEventListener('click', doFindNext);
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (e.shiftKey) {
      doFindPrev();
    } else {
      doFindNext();
    }
  } else if (e.key === 'Escape') {
    e.preventDefault();
    findOverlay.style.display = 'none';
  }
});

// wire prev/next buttons
prevBtn.addEventListener('click', (e) => { e.preventDefault(); doFindPrev(); });
nextBtn.addEventListener('click', (e) => { e.preventDefault(); doFindNext(); });

// Intercept Ctrl/Cmd+F
document.addEventListener('keydown', (e) => {
  const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    openFindOverlay(findState.query || '');
  }
});

// Global handler for markdown zoom: capture Ctrl/Cmd + '+' / '-' / '0' and prevent browser zoom.
// Use capture and non-passive listeners so we can reliably preventDefault before the browser.
function _zoomKeyHandler(e) {
  const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (!mod) return;
  // identify keys: handle numeric keypad codes as well
  const k = e.key;
  const c = e.code;
  // plus: '+' or '=' with shift or NumpadAdd
  if (k === '+' || (k === '=' && e.shiftKey) || c === 'NumpadAdd') {
    e.preventDefault();
    e.stopPropagation();
    changeZoom(0.1);
  } else if (k === '-' || c === 'NumpadSubtract') {
    e.preventDefault();
    e.stopPropagation();
    changeZoom(-0.1);
  } else if (k === '0' || c === 'Numpad0') {
    e.preventDefault();
    e.stopPropagation();
    applyZoom(1);
  }
}
window.addEventListener('keydown', _zoomKeyHandler, { capture: true, passive: false });

// Also intercept Ctrl/Cmd + mousewheel (commonly used for browser zoom)
function _zoomWheelHandler(e) {
  if (!e.ctrlKey && !e.metaKey) return;
  // prevent browser zoom
  e.preventDefault();
  e.stopPropagation();
  // Determine wheel direction robustly. On some devices/browsers deltaY may be 0
  // or inverted; fall back to non-standard wheelDelta when needed.
  let d = e.deltaY;
  if (!d && typeof e.wheelDelta !== 'undefined') {
    // wheelDelta is positive for wheel-up, so invert to match deltaY sign convention
    d = -e.wheelDelta;
  }
  if (d < 0) {
    // wheel up -> zoom in
    changeZoom(0.05);
  } else if (d > 0) {
    // wheel down -> zoom out
    changeZoom(-0.05);
  }
}
window.addEventListener('wheel', _zoomWheelHandler, { passive: false, capture: true });

// When switching files, if same query exists, re-highlight automatically
const originalSelectFile = selectFile;
selectFile = function(idx) {
  // call original
  originalSelectFile(idx);
  // after small delay (render completes), re-run highlight for active query
  setTimeout(() => {
    if (findState.query) {
      highlightAllMatches(findState.query);
      if (findState.matches.length) {
        findCount.textContent = `${findState.current + 1}/${findState.matches.length}`;
      } else {
        findCount.textContent = '0/0';
      }
    }
  }, 120);
};


// keyboard navigation
document.addEventListener('keydown', (e) => {
  // Find all visible file nodes (in DOM order) and navigate between them
  const fileNodes = Array.from(fileListEl.querySelectorAll('li.file'));
  if (!fileNodes.length) return;
  const current = fileNodes.findIndex(li => li.classList.contains('active'));
  if (e.key === 'j' || e.key === 'ArrowDown') {
    const next = Math.min(fileNodes.length - 1, Math.max(0, current + 1));
    const node = fileNodes[next];
    if (node) { node.focus(); node.click(); }
  } else if (e.key === 'k' || e.key === 'ArrowUp') {
    const prev = Math.max(0, current - 1);
    const node = fileNodes[prev];
    if (node) { node.focus(); node.click(); }
  }
});

// --- Context menu for copying file paths ---
(function setupContextMenu() {
  // Create context menu element
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.style.display = 'none';
  document.body.appendChild(menu);

  let targetPath = null;
  let targetIsMdFile = false;

  // Build menu items dynamically based on file type
  function buildMenuItems() {
    let html = `
      <div class="context-menu-item" data-action="copy-path">
        <span class="context-menu-icon">📋</span>
        <span>Copy path</span>
      </div>
    `;
    if (targetIsMdFile) {
      html += `
        <div class="context-menu-item" data-action="move-to-done">
          <span class="context-menu-icon">✅</span>
          <span>Move to Done</span>
        </div>
      `;
    }
    menu.innerHTML = html;
  }

  // Hide menu on click outside or escape
  function hideMenu() {
    menu.style.display = 'none';
    targetPath = null;
    targetIsMdFile = false;
  }

  document.addEventListener('click', hideMenu);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideMenu();
  });

  // Show context menu on right-click on file items
  fileListEl.addEventListener('contextmenu', (e) => {
    const fileItem = e.target.closest('li.file');
    if (!fileItem) return;

    e.preventDefault();

    // Get the file index and path
    const idx = parseInt(fileItem.dataset.index, 10);
    if (isNaN(idx) || !displayed[idx]) return;

    // Store the path (already in linux format from files.json)
    targetPath = displayed[idx].path;

    // Check if file is a .md file
    targetIsMdFile = targetPath.toLowerCase().endsWith('.md');

    // Build menu items based on file type
    buildMenuItems();

    // Position the menu
    const x = e.clientX;
    const y = e.clientY;

    // Ensure menu doesn't go off-screen
    menu.style.display = 'block';
    const menuRect = menu.getBoundingClientRect();
    const maxX = window.innerWidth - menuRect.width - 10;
    const maxY = window.innerHeight - menuRect.height - 10;

    menu.style.left = Math.min(x, maxX) + 'px';
    menu.style.top = Math.min(y, maxY) + 'px';
  });

  // Handle menu item clicks
  menu.addEventListener('click', async (e) => {
    const item = e.target.closest('.context-menu-item');
    if (!item) return;

    const action = item.dataset.action;

    if (action === 'copy-path' && targetPath) {
      try {
        // Copy path to clipboard (already in linux format)
        await navigator.clipboard.writeText(targetPath);

        // Brief visual feedback
        const originalText = item.querySelector('span:last-child').textContent;
        item.querySelector('span:last-child').textContent = 'Copied!';
        setTimeout(() => {
          item.querySelector('span:last-child').textContent = originalText;
        }, 1000);
      } catch (err) {
        console.error('Failed to copy path:', err);
      }
    } else if (action === 'move-to-done' && targetPath) {
      try {
        // Call backend API to move file to Done folder
        const response = await fetch('/api/move-to-done', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: targetPath })
        });

        if (!response.ok) {
          const errData = await response.json().catch(() => ({}));
          throw new Error(errData.error || 'Failed to move file');
        }

        // Brief visual feedback
        const originalText = item.querySelector('span:last-child').textContent;
        item.querySelector('span:last-child').textContent = 'Moved!';
        setTimeout(() => {
          item.querySelector('span:last-child').textContent = originalText;
        }, 1000);

        // Refresh file list after successful move
        setTimeout(() => fetchIndex({ showLoading: false }), 500);
      } catch (err) {
        console.error('Failed to move file to Done:', err);
        alert('Failed to move file: ' + err.message);
      }
    }

    hideMenu();
  });
})();

// --- Smart polling: auto-refresh file list when files.json changes ---
(function setupSmartPolling() {
  const POLL_INTERVAL = 5000; // 5 seconds
  let lastContentHash = null;
  let pollTimer = null;

  // Simple hash function for comparing content
  function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash;
  }

  // Show brief "Updated" indicator on refresh button
  function showUpdateIndicator() {
    const originalText = refreshBtn.textContent;
    refreshBtn.textContent = 'Updated';
    refreshBtn.style.color = '#22c55e'; // green
    setTimeout(() => {
      refreshBtn.textContent = originalText;
      refreshBtn.style.color = '';
    }, 1500);
  }

  // Check for updates
  async function checkForUpdates() {
    try {
      // Add cache-busting parameter to ensure fresh response
      const url = INDEX_FILE + '?t=' + Date.now();
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) return;

      const text = await response.text();
      const newHash = simpleHash(text);

      // First poll: just store the hash
      if (lastContentHash === null) {
        lastContentHash = newHash;
        return;
      }

      // Content changed: update the UI
      if (newHash !== lastContentHash) {
        lastContentHash = newHash;
        const list = JSON.parse(text);
        files = (Array.isArray(list) ? list.map(item => {
          if (typeof item === 'string') {
            const p = item;
            const n = p.split('/').pop();
            return { name: n, path: p };
          } else if (item && typeof item === 'object') {
            return { name: item.name || (item.path && item.path.split('/').pop()) || 'file', path: item.path };
          }
          return null;
        }).filter(Boolean) : []);
        window.fileTree = files;
        renderList(files);
        showUpdateIndicator();
      }
    } catch (e) {
      // Silently ignore errors during background polling
    }
  }

  // Start/stop polling based on visibility
  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(checkForUpdates, POLL_INTERVAL);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // Handle visibility changes
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      // Check immediately when tab becomes visible
      checkForUpdates();
      startPolling();
    } else {
      stopPolling();
    }
  });

  // Initialize: start polling after initial load completes
  // Small delay to let the initial fetchIndex finish first
  setTimeout(() => {
    checkForUpdates(); // Get initial hash
    startPolling();
  }, 1000);
})();
