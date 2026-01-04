"use strict";

let treeData = null;
let currentPath = "";
const openDirs = {};    // open/closed state in dir tree
const dirCache = new Map(); // path -> { mtime, files }

let allItems = [];      // unfiltered
let filteredItems = []; // after filter by media type
let groups = {};        // dirPath -> array of items
let groupOrder = [];
let groupOpen = {};     // open/closed state of groups in grid
let gridSourceItems = []; // flattened and sorted
let visibleItems = [];  // after filter by name

let sortType = "name";  // name | mtime | size
let sortAscending = true;
let mediaType = "all";  // all | image | video
let recursive = false;
let groupByDir = true;
let showNames = true;

const DEFAULT_THUMB_ZOOM = 180; // px

// UI elements
const topbar = document.getElementById("topbar");
const main = document.getElementById("main");
const tree = document.getElementById("tree");
const dragbar = document.getElementById("dragbar");
const grid = document.getElementById("grid");
const breadcrumbDiv = document.getElementById("breadcrumbDiv");

const setSortNameBtn = document.getElementById("setSortNameBtn");
const setSortTimeBtn = document.getElementById("setSortTimeBtn");
const setSortSizeBtn = document.getElementById("setSortSizeBtn");
const orderBtn = document.getElementById("orderBtn");
const recursiveBtn = document.getElementById("recursiveBtn");
const groupingBtn = document.getElementById("groupingBtn");
const setMediaAllBtn = document.getElementById("setMediaAllBtn");
const setMediaImagesBtn = document.getElementById("setMediaImagesBtn");
const setMediaVideoBtn = document.getElementById("setMediaVideoBtn");
const showNamesBtn = document.getElementById("showNamesBtn");
const refreshBtn = document.getElementById("refreshBtn");
const thumbZoomSlider = document.getElementById("thumbZoomSlider");
const resetZoomBtn = document.getElementById("resetZoomBtn");
const thumbFilterInput = document.getElementById("thumbFilterInput");
const thumbFilterClearBtn = document.getElementById("thumbFilterClearBtn");
const fileCountSpan = document.getElementById("fileCountSpan");

const thumbObserver = new IntersectionObserver(thumbObserverCallback,
  {root: grid, rootMargin: "200px"});

// ---------------- Path encoding ----------------

const OSPATH_PREFIX = "~~OSPATH~~";

function joinOsPaths(a, b) {
  let encoded = false;
  if (a.startsWith(OSPATH_PREFIX)) {
    a = a.slice(OSPATH_PREFIX.length);
    encoded = true;
  }
  if (b.startsWith(OSPATH_PREFIX)) {
    b = b.slice(OSPATH_PREFIX.length);
    encoded = true;
  }
  const s = a + "/" + b;
  return encoded ? OSPATH_PREFIX + s : s;
}

function decodeOsPathForDisplay(s) {
  if (!s.startsWith(OSPATH_PREFIX)) {
    return s;
  }

  s = s.slice(OSPATH_PREFIX.length);
  let out = "";

  for (let i = 0; i < s.length; ) {
    if (s[i] === "~") {
      const byte = parseInt(s.slice(i + 1, i + 3), 16);
      // ASCII bytes can be shown, non-ASCII become replacement char
      out += (byte < 0x80) ? String.fromCharCode(byte) : "\uFFFD";
      i += 3;
    } else {
      out += s[i];
      i += 1;
    }
  }

  return out;
}

function laxCompareOsPath(a, b) {
  if (a.startsWith(OSPATH_PREFIX))
    a = a.slice(OSPATH_PREFIX.length);
  if (b.startsWith(OSPATH_PREFIX))
    b = b.slice(OSPATH_PREFIX.length);
  return (a > b) - (a < b);
}

// ---------------- Helpers ----------------

function basename(p) {
  if (p === "." || p === "") return ".";
  return p.split("/").filter(Boolean).pop();
}

// ---------------- Dragbar ----------------

class Dragbar {
  constructor({
    dragbar,
    panel,
    minWidth = 150,
    maxWidthRatio = 0.5,
    collapseThreshold = 80,
    expandThreshold = 120
  }) {
    this.dragbar = dragbar;
    this.panel = panel;

    this.minWidth = minWidth;
    this.maxWidthRatio = maxWidthRatio;
    this.collapseThreshold = collapseThreshold;
    this.expandThreshold = expandThreshold;

    this.isDragging = false;
    this.didDrag = false;
    this.isCollapsed = false;
    this.dragStartX = 0;
    this.lastWidth = panel.offsetWidth;

    this.bindEvents();
  }

  bindEvents() {
    // Mouse
    this.dragbar.addEventListener("mousedown", e => {
      e.preventDefault();
      this.startDrag(e.clientX);
    });

    document.addEventListener("mousemove", e =>
      this.doDrag(e.clientX)
    );
    document.addEventListener("mouseup", () =>
      this.endDrag()
    );

    // Touch
    this.dragbar.addEventListener("touchstart", e => {
      e.preventDefault();
      this.startDrag(e.touches[0].clientX);
    }, { passive: false });

    document.addEventListener("touchmove", e =>
      this.doDrag(e.touches[0].clientX),
      { passive: false }
    );

    document.addEventListener("touchend", () =>
      this.endDrag()
    );

    // Click-to-toggle
    this.dragbar.addEventListener("click", () => {
      if (!this.didDrag) {
        this.toggle();
      }
    });
  }

  startDrag(clientX) {
    this.isDragging = true;
    this.didDrag = false;
    this.dragStartX = clientX;
    document.body.style.cursor = "col-resize";
  }

  doDrag(clientX) {
    if (!this.isDragging) return;

    if (Math.abs(clientX - this.dragStartX) > 3) {
      this.didDrag = true;
    }

    const maxWidth = window.innerWidth * this.maxWidthRatio;

    // Collapse
    if (!this.isCollapsed && clientX < this.collapseThreshold) {
      this.panel.style.minWidth = "0";
      this.panel.style.width = "0px";
      this.isCollapsed = true;
      return;
    }

    // Expand
    if (this.isCollapsed && clientX > this.expandThreshold) {
      this.panel.style.minWidth = this.minWidth + "px";
      this.panel.style.width = this.lastWidth + "px";
      this.isCollapsed = false;
    }

    // Resize
    if (!this.isCollapsed) {
      const w = Math.max(this.minWidth, Math.min(clientX, maxWidth));
      this.panel.style.width = w + "px";
      this.lastWidth = w;
    }
  }

  endDrag() {
    if (!this.isDragging) return;
    this.isDragging = false;
    document.body.style.cursor = "default";
  }

  toggle() {
    if (!this.isCollapsed) {
      this.panel.style.minWidth = "0";
      this.panel.style.width = "0px";
      this.isCollapsed = true;
    } else {
      this.panel.style.minWidth = this.minWidth + "px";
      this.panel.style.width = this.lastWidth + "px";
      this.isCollapsed = false;
    }
  }
}

const treeDragbar = new Dragbar({
  dragbar,
  panel: tree,
  minWidth: 150,
  maxWidthRatio: 0.5,
  collapseThreshold: 80,
  expandThreshold: 120
});

// ---------------- Tree ----------------

async function loadTree() {
  try {
    treeData = await (await fetch("/api/tree")).json();
  } catch (err) {
    console.error("Failed to load tree:", err);
    return;
  }

  const fragment = document.createDocumentFragment();

  treeData.dirs.forEach(d => {
    openDirs[d.path] = true; // automatically open first level
    fragment.appendChild(renderTreeNode(d));
  });

  tree.replaceChildren(fragment);
}

function renderTreeNode(node) {
  const path = node.path;
  const displayName = decodeOsPathForDisplay(node.name);

  const isOpen = openDirs[path] ?? false;
  openDirs[path] = isOpen;

  const isSelected = (path === currentPath);

  // container for this node
  const dirDiv = document.createElement("div");
  dirDiv.className = "dir";

  // header
  const headerDiv = document.createElement("div");
  headerDiv.className = "dir-header" + (isSelected ? " selected" : "");
  headerDiv.addEventListener("click", () => openAndLoadDir(path));

  // toggle button
  const toggleBtn = document.createElement("span");
  toggleBtn.className = "dir-toggle";

  if (node.dirs.length > 0) {
    toggleBtn.textContent = (isOpen) ? "−" : "+";
    toggleBtn.addEventListener("click", e => {
      e.stopPropagation();
      toggleOpenDir(path);
    });
  } else {
    toggleBtn.textContent = "•";
  }

  headerDiv.appendChild(toggleBtn);

  // name span
  const nameSpan = document.createElement("span");
  nameSpan.className = "dir-name";
  nameSpan.dataset.path = path;
  nameSpan.textContent = displayName;
  headerDiv.appendChild(nameSpan);

  dirDiv.appendChild(headerDiv);

  // children container
  if (node.dirs.length > 0) {
    const childrenDiv = document.createElement("div");
    childrenDiv.className = "children";
    childrenDiv.style.display = isOpen ? "block" : "none";

    node.dirs.forEach(child => {
      childrenDiv.appendChild(renderTreeNode(child));
    });

    dirDiv.appendChild(childrenDiv);
  }

  return dirDiv;
}

function openAncestorDirs(dirPath) {
  const parts = dirPath.split("/");
  let acc = "";
  for (let i = 0; i < parts.length - 1; i++) {
    acc = acc ? `${acc}/${parts[i]}` : parts[i];
    openDirs[acc] = true;
  }
}

function syncOpenTreeDirs() {
  tree.querySelectorAll(".dir-header span[data-path]").forEach(span => {
    const path = span.dataset.path;
    const childrenDiv = span.parentElement.parentElement.querySelector(".children");
    if (!childrenDiv) return;

    const isOpen = openDirs[path];
    childrenDiv.style.display = (isOpen) ? "block" : "none";
    span.previousElementSibling.textContent = (isOpen) ? "−" : "+";
  });
}

function highlightTreeDir(newPath) {
  const prev = tree.querySelector(".dir-header.selected");

  // Open ancestors of the selected path
  openAncestorDirs(newPath);
  syncOpenTreeDirs();

  const newNode = tree.querySelector(
    `.dir-header span[data-path='${newPath}']`
  );
  if (!newNode) return;

  const header = newNode.parentElement;

  if (prev && prev !== header) {
    prev.classList.remove("selected");
  }

  header.classList.add("selected");

  // Trigger flash animation
  if (prev === header) {
    header.classList.remove("flash");
    void header.offsetWidth;
    header.classList.add("flash");
  }

  header.scrollIntoView({
    block: "nearest",
    inline: "nearest"
  });
}

function openAndLoadDir(path) {
  if (path === currentPath) {
    highlightTreeDir(path);
    return;
  }

  loadDir(path);
  openDirs[path] = true;
  highlightTreeDir(path);
  schedScrollToNextVisibleThumb();
}

function toggleOpenDir(p) {
  const isOpen = !openDirs[p];
  openDirs[p] = isOpen;

  const span = tree.querySelector(`.dir-header span[data-path='${p}']`);
  if (!span) return;

  const childrenDiv = span.parentElement.parentElement.querySelector(".children");
  if (!childrenDiv) return;

  childrenDiv.style.display = (isOpen) ? "block" : "none";
  span.previousElementSibling.textContent = (isOpen) ? "−" : "+";
}

async function loadDir(newPath, { refresh = false, changeRecursiveMode = false } = {}) {
  const newItems = [];
  let applyNewItems = changeRecursiveMode;

  async function addItemsForDir(dir) {
    const cacheEntry = dirCache.get(dir);
    let files = [];

    if (refresh || !cacheEntry) {
      let query = new URLSearchParams({ path: dir });
      if (cacheEntry?.mtime)
        query.set("since", cacheEntry.mtime);

      try {
        const r = await fetch(`/api/list?${query.toString()}`, {
          cache: "no-store"
        });
        if (!r.ok) {
          console.warn(`Failed to list directory ${dir}: ${r.status}`);
          files = [];
          dirCache.set(dir, { files }); // cache empty
          applyNewItems = true;
        } else {
          const data = await r.json();
          if (data.not_modified && cacheEntry) {
            // Directory hasn't changed; reuse cached files
            files = cacheEntry.files;
          } else {
            // New or updated directory
            files = data.files || [];
            dirCache.set(dir, { files, mtime: data.mtime });
            applyNewItems = true;
          }
        }
      } catch (err) {
        console.warn(`Error fetching directory ${dir}:`, err);
        files = [];
        dirCache.set(dir, { files }); // cache empty
        applyNewItems = true;
      }
    } else {
      // Already cached, no refresh
      files = cacheEntry.files;
    }

    files.forEach(f => {
      const key = joinOsPaths(dir, f.name);
      const dpath = decodeOsPathForDisplay(key);
      const pathLower = dpath.toLowerCase();
      const pathLowerNoAccents = removeAccents(pathLower);

      const item = {
        // The API gives us for each file:
        //    name
        //    type
        //    mtime
        //    size
        ...f,

        // We add these for each item:
        _dir: dir,
        _key: key, // path to access file
        _pathLower: pathLower, // only for filtering
        _pathLowerNoAccents: pathLowerNoAccents
      };
      newItems.push(item);
    });

    if (recursive) {
      // Find node in cached treeData to get its children of dir.
      const node = findTreeNode(dir, treeData);
      if (node) {
        for (const d of node.dirs) {
          const subdir = joinOsPaths(dir, d.name);
          await addItemsForDir(subdir);
        }
      }
    }
  }

  await addItemsForDir(newPath);

  if (newPath !== currentPath) {
    currentPath = newPath;
    groupOpen = {};
    updateBreadcrumbs(currentPath);
    applyNewItems = true;
  }

  if (applyNewItems) {
    allItems = newItems;
    deriveItemGroupsAndLists();
    renderGrid();
  }
}

function findTreeNode(path, node) {
  if (node.path === path)
    return node;
  for (const d of node.dirs) {
    const r = findTreeNode(path, d);
    if (r) return r;
  }
  return null;
}

function deriveItemGroupsAndLists() {
  filteredItems = allItems.filter(itemMatchesMediaType);

  groups = {};
  groupOrder = [];
  gridSourceItems = [];

  if (recursive && groupByDir) {
    // Build groups from filtered items
    filteredItems.forEach(it => {
      const dir = it._dir;
      if (!groups[dir]) groups[dir] = [];
      groups[dir].push(it);
    });

    // The order that groups will appear in the grid.
    groupOrder = Object.keys(groups).sort(laxCompareOsPath);

    groupOrder.forEach(dir => {
      groups[dir] = sortItems(groups[dir]);
      gridSourceItems.push(...groups[dir]);
    });
  }
  else {
    gridSourceItems = sortItems(filteredItems);
  }

  // Will be updated by renderGrid if further filtered by name.
  visibleItems = gridSourceItems;
}

function itemMatchesMediaType(item) {
  return (mediaType === "all") || (item.type === mediaType);
}

function sortItems(items) {
  const gt = (sortAscending) ? 1 : -1;

  switch (sortType) {
    case "name":
    case "mtime":
    case "size":
      break;
    default:
      throw "unknown sort key";
  }

  const copy = [...items];
  copy.sort((a, b) => {
    const va = a[sortType];
    const vb = b[sortType];

    if (va < vb) return -gt;
    if (va > vb) return gt;
    return 0;
  });
  return copy;
}

// ---------------- Top bar buttons ----------------

function setSort(type) {
  if (sortType === type) return;
  sortType = type;

  document.querySelectorAll("#sortTypeGroup button").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.type === type);
  });

  deriveItemGroupsAndLists();
  renderGrid();
}

setSortNameBtn.addEventListener("click", () => setSort("name"));
setSortTimeBtn.addEventListener("click", () => setSort("mtime"));
setSortSizeBtn.addEventListener("click", () => setSort("size"));

function toggleOrder() {
  sortAscending = !sortAscending;
  orderBtn.textContent = (sortAscending) ? "↑ Ascending" : "↓ Descending";
  orderBtn.classList.add("active");
  setTimeout(() => orderBtn.classList.remove("active"), 100);

  deriveItemGroupsAndLists();
  renderGrid();
}

orderBtn.addEventListener("click", toggleOrder);

function toggleRecursive() {
  recursive = !recursive;
  recursiveBtn.classList.toggle("active", recursive);

  loadDir(currentPath, { changeRecursiveMode: true });
  schedScrollToNextVisibleThumb();
}

recursiveBtn.addEventListener("click", toggleRecursive);

function toggleGrouping() {
  groupByDir = !groupByDir;
  groupingBtn.classList.toggle("active", groupByDir);

  deriveItemGroupsAndLists();
  renderGrid();
}

groupingBtn.addEventListener("click", toggleGrouping);

function setMediaType(type) {
  if (mediaType === type) return;
  mediaType = type;

  document.querySelectorAll("#mediaTypeGroup button").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.type === type);
  });

  deriveItemGroupsAndLists();
  renderGrid();
}

setMediaAllBtn.addEventListener("click", () => setMediaType("all"));
setMediaImageBtn.addEventListener("click", () => setMediaType("image"));
setMediaVideoBtn.addEventListener("click", () => setMediaType("video"));

function toggleShowNames() {
  showNames = !showNames;
  showNamesBtn.classList.toggle("active", showNames);

  document.querySelectorAll(".thumb").forEach(d => {
    d.classList.toggle("hide-name", !showNames);
  });
}

showNamesBtn.addEventListener("click", toggleShowNames);

async function refreshDir() {
  refreshBtn.classList.add("active");

  // TODO: update dir tree based on changed filesystem
  try {
    loadDir(currentPath, { refresh: true });
  } finally {
    setTimeout(() => refreshBtn.classList.remove("active"), 100);
  }
}

refreshBtn.addEventListener("click", refreshDir);

// ---------------- Breadcrumbs ----------------

function updateBreadcrumbs(pathStr) {
  const segments = pathStr.split("/");
  const displaySegments = decodeOsPathForDisplay(pathStr).split("/");

  const fragment = document.createDocumentFragment();

  for (let i = 0; i < segments.length; i++) {
    const pathto = segments.slice(0, i + 1).join("/");
    const label = displaySegments[i];

    const span = document.createElement("span");
    span.className = "breadcrumb-segment";
    span.dataset.path = pathto;
    span.textContent = label;

    span.addEventListener("click", () => openAndLoadDir(pathto));

    fragment.appendChild(span);
  }

  breadcrumbDiv.replaceChildren(fragment);
}

// ---------------- Grid ----------------

function renderGrid() {
  // Clear thumbObserver. If any unloaded thumbnails are reused,
  // we will add them to the observer again.
  thumbObserver.disconnect();

  if (filteredItems.length === 0) {
    grid.replaceChildren(createNoMediaMsg());
    updateFileCountSpan();
    return;
  }

  // Map existing thumbs by stable key
  const existing = new Map(
    [...grid.querySelectorAll(".thumb")].map(thumb => [thumb._item._key, thumb])
  );

  const frag = document.createDocumentFragment();

  // Accumulate visible items as we go
  let accum = []; // new array

  if (recursive && groupByDir) {
    groupOrder.forEach(dir => {
      // Groups are open by default.
      if (!(dir in groupOpen)) groupOpen[dir] = true;

      // Header
      const header = document.createElement("div");
      header.className = "group-divider";
      header.dataset.dir = dir;

      const caret = document.createElement("span");
      caret.className = "caret";
      caret.textContent = groupOpen[dir] ? "▾" : "▸";

      let labelText = decodeOsPathForDisplay(dir);
      if (dir === currentPath) {
        labelText = basename(labelText);
      } else {
        // Abbreviate by removing the current path
        const prefix = decodeOsPathForDisplay(currentPath);
        labelText = labelText.slice(prefix.length + 1);
      }

      const label = document.createElement("span");
      label.className = "label";
      label.textContent = labelText;

      header.append(label, caret);
      frag.appendChild(header);

      let dirVisibleItems = 0;

      // Container for group thumbnails
      const groupItems = document.createElement("div");
      groupItems.className = "group-items";
      groups[dir].forEach(item => {
        const isVisible = itemMatchesFilter(item);
        const thumb = createOrReuseThumb(item, existing, isVisible);
        groupItems.appendChild(thumb);
        if (isVisible) {
          accum.push(item);
          dirVisibleItems++;
        }
      });
      groupItems.style.display = groupOpen[dir] ? "contents" : "none";
      frag.appendChild(groupItems);

      // Toggle display on header click
      header.onclick = () => {
        groupOpen[dir] = !groupOpen[dir];
        groupItems.style.display = groupOpen[dir] ? "contents" : "none";
        caret.textContent = groupOpen[dir] ? "▾" : "▸";
      };

      label.onclick = e => {
        e.stopPropagation();
        openAndLoadDir(dir);
      };

      header.classList.toggle("hide", dirVisibleItems == 0);
    });
  } else {
    // Flat grid
    gridSourceItems.forEach(item => {
      const isVisible = itemMatchesFilter(item);
      const thumb = createOrReuseThumb(item, existing, isVisible);
      frag.appendChild(thumb);
      if (isVisible) {
        accum.push(item);
      }
    });
  }

  visibleItems = accum;

  grid.replaceChildren(frag);

  updateFileCountSpan();
}

function createNoMediaMsg() {
  const msg = document.createElement("div");
  msg.className = "no-media";
  msg.textContent = "No supported media in this directory";
  return msg;
}

function createOrReuseThumb(item, existing, isVisible) {
  let d = existing.get(item._key);

  if (!d) {
    d = document.createElement("div");
    d.className = "thumb";
    d._item = item; // keep reference to item

    const imgPlaceholder = document.createElement("div");
    imgPlaceholder.className = "thumb-img-placeholder";
    imgPlaceholder.item = item;

    const nameDiv = document.createElement("div");
    nameDiv.className = "name";
    nameDiv.textContent = decodeOsPathForDisplay(item.name);

    d.appendChild(imgPlaceholder);
    d.appendChild(nameDiv);

    thumbObserver.observe(imgPlaceholder);

  } else {
    const imgPlaceholder = d.querySelector(".thumb-img-placeholder");
    const img = imgPlaceholder.querySelector("img");
    if (!img) {
      thumbObserver.observe(imgPlaceholder);
    }
  }

  d.classList.toggle("hide", !isVisible);
  d.classList.toggle("hide-name", !showNames);

  return d;
}

function updateFileCountSpan() {
  const m = visibleItems.length;
  const n = gridSourceItems.length;

  if (n == 0) {
    fileCountSpan.textContent = "";
    return;
  }

  let text = (m == n) ? `${n}` : `${m} / ${n}`;
  text += (n == 1) ? " file" : " files";
  fileCountSpan.textContent = text;
}

function thumbObserverCallback(entries, observer) {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      const placeholder = entry.target;

      if (!placeholder.querySelector("img")) {
        const item = placeholder.item;

        const img = document.createElement("img");
        img.loading = "lazy";
        img.src = "/api/thumb?path=" + encodeURIComponent(item._key);
        img.onload = () => { placeholder.style.background = "none"; };
        placeholder.appendChild(img);
      }

      observer.unobserve(placeholder);
    }
  });
}

grid.addEventListener("click", (e) => {
  const img = e.target.closest(".thumb-img-placeholder img");
  if (!img) return;
  const placeholder = img.parentElement;
  const item = placeholder.item;
  if (item) viewer.openItem(item, visibleItems);
});

// ---------------- Thumbnail Zoom ----------------

thumbZoomSlider.addEventListener("input", () => {
  const value = parseInt(thumbZoomSlider.value);
  updateThumbSizes(value);
});

thumbZoomSlider.addEventListener("wheel", e => {
  e.preventDefault(); // prevent page scroll

  const step = 10;
  const min = parseInt(thumbZoomSlider.min);
  const max = parseInt(thumbZoomSlider.max);
  let value = parseInt(thumbZoomSlider.value);

  if (e.deltaY < 0) {
    value = Math.min(max, value + step);
  } else {
    value = Math.max(min, value - step);
  }

  thumbZoomSlider.value = value;
  updateThumbSizes(value);
}, { passive: false });

resetZoomBtn.addEventListener("click", () => {
  resetZoomBtn.classList.add("active");
  setTimeout(() => resetZoomBtn.classList.remove("active"), 100);

  thumbZoomSlider.value = DEFAULT_THUMB_ZOOM
  updateThumbSizes(DEFAULT_THUMB_ZOOM);
});

function updateThumbSizes(value) {
  grid.style.gridTemplateColumns = `repeat(auto-fill, minmax(${value}px, 1fr))`;
}

// ---------------- Filter thumbnails by name ----------------

let filterTerms = [];
let filterTimeout = null;
const DEBOUNCE_DELAY = 150; // ms

function removeAccents(str) {
  let r = str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return (r === str) ? str : r;
}

function updateFilterTerms(input) {
  const newTerms = input
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(term => {
      const lower = term.toLowerCase();
      const stripped = removeAccents(lower);
      // User typed no accents: ignore accents when matching.
      // User typed with accents: require exact match with accents.
      const ignoreAccents = (lower === stripped);
      return {
        str: ignoreAccents ? stripped : lower,
        ignoreAccents: ignoreAccents
      };
    });

  const changed =
    newTerms.length !== filterTerms.length ||
    newTerms.some((t, i) => {
      const old = filterTerms[i];
      return !old || t.str !== old.str || t.ignoreAccents !== old.ignoreAccents;
    });

  if (changed)
    filterTerms = newTerms;

  return changed;
}

function itemMatchesFilter(item) {
  if (filterTerms.length === 0)
    return true;

  return filterTerms.every(term => {
    return term.ignoreAccents
      ? item._pathLowerNoAccents.includes(term.str)
      : item._pathLower.includes(term.str);
  });
}

function updateThumbsForFilterText() {
  const thumbs = grid.querySelectorAll(".thumb");
  const groupHeaders = grid.querySelectorAll(".group-divider");

  if (filterTerms.length === 0) {
    thumbs.forEach(t => t.classList.remove("hide"));
    groupHeaders.forEach(hdr => hdr.classList.remove("hide"));
    visibleItems = gridSourceItems;
    updateFileCountSpan();
    return;
  }

  let accumItems = []; // new array
  let seenDir = (recursive && groupByDir) ? {} : null;

  for (const thumb of thumbs) {
    const item = thumb._item;
    const match = itemMatchesFilter(item);
    thumb.classList.toggle("hide", !match);
    if (match) {
      accumItems.push(item);
      if (seenDir && !seenDir[item._dir]) {
        seenDir[item._dir] = true;
      }
    }
  }

  if (seenDir) {
    groupHeaders.forEach(hdr => {
      hdr.classList.toggle("hide", !seenDir[hdr.dataset.dir]);
    });
  }

  visibleItems = accumItems;
  updateFileCountSpan();

  return true;
}

function scrollToNextVisibleThumb() {
  const thumbs = grid.querySelectorAll(".thumb:not(.hide)");
  if (thumbs.length === 0) return;

  const containerRect = grid.getBoundingClientRect();
  const scrollTop = grid.scrollTop;

  let targetThumb = null;

  for (let i = 0; i < thumbs.length; i++) {
    const r = thumbs[i].getBoundingClientRect();
    if (r.top > containerRect.top) {
      targetThumb = thumbs[i];
      break;
    }
  }

  // If none is below the top, pick the first thumb in the grid
  if (!targetThumb) targetThumb = thumbs[0];

  const thumbRect = targetThumb.getBoundingClientRect();
  const offset = (recursive && groupByDir) ? 40 : 5; // room for group label
  const targetTop = scrollTop + (thumbRect.top - containerRect.top - offset);

  grid.scrollTo({
    top: targetTop,
    //behavior: "smooth"
  });
}

function schedScrollToNextVisibleThumb() {
  // Wait for layout to stabilise after loadDir/renderGrid.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      scrollToNextVisibleThumb();
    });
  });
}

function handleThumbFilterInput({ scroll = true }) {
  clearTimeout(filterTimeout);
  filterTimeout = null;

  if (!updateFilterTerms(thumbFilterInput.value))
    return;

  updateThumbsForFilterText();
  if (scroll)
    scrollToNextVisibleThumb();
}

thumbFilterInput.addEventListener("input", () => {
  if (!filterTimeout)  {
    handleThumbFilterInput({ scroll: true });
  }

  // Debounce subsequent inputs
  clearTimeout(filterTimeout);
  filterTimeout = setTimeout(() => {
    handleThumbFilterInput({ scroll: true });
  }, DEBOUNCE_DELAY);
});

thumbFilterInput.addEventListener("keydown", e => {
  switch (e.key) {
    case "Enter":
      handleThumbFilterInput({ scroll: false });
      scrollToNextVisibleThumb(); // scroll even no changed
      break;
    case "Escape":
      thumbFilterInput.value = "";
      handleThumbFilterInput({ scroll: false});
      break;
  }
});

thumbFilterClearBtn.addEventListener("click", () => {
  thumbFilterInput.value = "";
  handleThumbFilterInput({ scroll: true });
  thumbFilterInput.focus();
});

// ---------------- Context menu ----------------

class ContextMenu {
  constructor(container, itemSelector, msgTimeout = 1000) {
    this.container = container;
    this.selector = itemSelector;
    this.msgTimeout = msgTimeout;

    this.selectedItem = null;
    this.menu = document.createElement("ul");
    this.menu.className = "context-menu";

    // actionName -> handler(selectedItem, clickedEl)
    this.actions = {};

    // message element
    this.msgEl = document.createElement("li");
    this.msgEl.className = "menu-msg";
    this.menu.appendChild(this.msgEl);

    document.body.appendChild(this.menu);

    this._bindEvents();
  }

  addItem(label, action, handler) {
    const li = document.createElement("li");
    li.className = "menu-item";
    li.dataset.action = action;
    li.textContent = label;
    this.menu.insertBefore(li, this.msgEl);
    this.actions[action] = handler;
  }

  isActive() {
    return this.menu.classList.contains("show-items");
  }

  show(x, y) {
    if (tooltip) tooltip.hideTooltip();
    this.menu.style.left = `${x}px`;
    this.menu.style.top = `${y}px`;
    this.menu.classList.remove("show-msg");
    this.menu.classList.add("show-items");
  }

  hide() {
    this.selectedItem = null;
    this.menu.classList.remove("show-items", "show-msg");
  }

  showMessage(msg, clickedEl) {
    this.msgEl.textContent = msg;

    // adjust menu position so message aligns with clicked item
    const itemOffset = clickedEl.offsetTop;
    const menuX = parseFloat(this.menu.style.left) || 0;
    const menuY = parseFloat(this.menu.style.top) || 0;

    this.menu.style.top = `${menuY + itemOffset}px`;
    this.menu.style.left = `${menuX}px`;

    this.menu.classList.remove("show-items");
    this.menu.classList.add("show-msg");

    setTimeout(() => this.hide(), this.msgTimeout);
  }

  _bindEvents() {
    // menu item clicks
    this.menu.addEventListener("click", async e => {
      if (!this.selectedItem) return;
      const clickedEl = e.target.closest("li.menu-item");
      if (!clickedEl) return;

      const actionName = clickedEl.dataset.action;
      const handler = this.actions[actionName];
      if (handler)
        await handler(this.selectedItem, clickedEl);
    });

    this.container.addEventListener("contextmenu", e => {
      if (e.shiftKey) return; // allow native menu with shift

      const target = e.target.closest(this.selector);
      if (!target) return;

      e.preventDefault();
      this.selectedItem = target;
      this.show(e.clientX, e.clientY);
    });

    // hide if clicking outside
    document.addEventListener("click", e => {
      if (this.isActive() && !this.menu.contains(e.target))
        this.hide();
    });

    // hide on Escape
    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && this.isActive())
        this.hide();
    });
  }
}

const contextMenu = new ContextMenu(grid, ".thumb");

contextMenu.addItem("Copy file URL", "copy-link", async (thumbEl, clickedEl) => {
  const item = thumbEl._item;
  if (!item) return;

  const url = `${window.location.origin}/api/file?path=${encodeURIComponent(item._key)}`;
  const copied = await copyToClipboard(url);
  contextMenu.showMessage(copied ? "Copied to clipboard" : "Copy failed", clickedEl);
});

contextMenu.addItem("Copy file path", "copy-path", async (thumbEl, clickedEl) => {
  const item = thumbEl._item;
  if (!item) return;

  const copied = await copyToClipboard(item._key);
  contextMenu.showMessage(copied ? "Copied to clipboard" : "Copy failed", clickedEl);
});

contextMenu.addItem("Go to directory", "goto-dir", async (thumbEl, clickedEl) => {
  const item = thumbEl._item;
  if (!item) return;

  openAndLoadDir(item._dir);
  contextMenu.hide();
});

async function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      console.error("Clipboard write failed", err);
      return false;
    }
  }
  // Fallback
  const textarea = document.createElement("textarea");
  textarea.value = text;
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand("copy");
    return true;
  }
  catch (err) {
    console.error("Fallback copy failed", err);
    return false;
  }
  finally {
    document.body.removeChild(textarea);
  }
}

// ---------------- Tooltip ----------------

class Tooltip {
  constructor(container, selector, options = {}) {
    this.container = container;
    this.selector = selector;
    this.showDelay = options.showDelay ?? 1000;
    this.hideDelay = options.hideDelay ?? 250;
    this.switchDelay = options.switchDelay ?? 250;
    this.getContent = options.getContent ?? (() => "(no content)");

    this.tooltip = document.createElement("div");
    this.tooltip.className = "tooltip";
    document.body.appendChild(this.tooltip);

    this.hoverEl = null;    // element currently under cursor
    this.tooltipEl = null;  // element currently displayed in tooltip
    this.tooltipVisible = false;

    this.showTimer = null;
    this.hideTimer = null;

    this.attachEvents();
  }

  showTooltip(el, event) {
    if (contextMenu.isActive()) return;

    this.tooltipEl = el;
    this.tooltip.innerHTML = this.getContent(el);

    const margin = 12;
    const elRect = el.getBoundingClientRect();

    // Make tooltip measurable
    this.tooltip.style.left = "0px";
    this.tooltip.style.top = "0px";
    this.tooltip.classList.add("show");
    const tipRect = this.tooltip.getBoundingClientRect();

    const placements = [
      // right
      {
        x: elRect.right + margin,
        y: elRect.top + (elRect.height - tipRect.height) / 2
      },
      // left
      {
        x: elRect.left - tipRect.width - margin,
        y: elRect.top + (elRect.height - tipRect.height) / 2
      },
      // bottom
      {
        x: elRect.left + (elRect.width - tipRect.width) / 2,
        y: elRect.bottom + margin
      },
      // top
      {
        x: elRect.left + (elRect.width - tipRect.width) / 2,
        y: elRect.top - tipRect.height - margin
      }
    ];

    let placed = false;
    let x = 0, y = 0;

    for (const p of placements) {
      const px = Math.round(p.x);
      const py = Math.round(p.y);
      if (
        px >= 0 &&
        py >= 0 &&
        px + tipRect.width <= window.innerWidth &&
        py + tipRect.height <= window.innerHeight
      ) {
        x = px;
        y = py;
        placed = true;
        break;
      }
    }

    // Fallback: cursor-based, but offset away from the element
    if (!placed) {
      x = event.clientX + margin;
      y = event.clientY + margin;
      if (x + tipRect.width > window.innerWidth)
        x = event.clientX - tipRect.width - margin;
      if (y + tipRect.height > window.innerHeight)
        y = event.clientY - tipRect.height - margin;
    }

    this.tooltip.style.left = `${x}px`;
    this.tooltip.style.top = `${y}px`;

    if (!this.tooltipVisible) {
      this.tooltip.style.opacity = "0";
      requestAnimationFrame(() => {
        this.tooltip.style.opacity = "1";
        this.tooltipVisible = true;
      });
    }
  }

  hideTooltip() {
    this.tooltip.style.opacity = "0";
    this.tooltipVisible = false;
    this.tooltipEl = null;
  }

  attachEvents() {
    this.container.addEventListener("mouseover", e => {
      const el = e.target.closest(this.selector);
      if (!el) return;

      this.hoverEl = el;

      if (this.hideTimer) {
        clearTimeout(this.hideTimer);
        this.hideTimer = null;
      }

      const delay = this.tooltipVisible ? this.switchDelay : this.showDelay;

      if (this.showTimer)
        clearTimeout(this.showTimer);
      this.showTimer = setTimeout(() => {
        if (this.hoverEl === el)
          this.showTooltip(el, e);
      }, delay);
    });

    this.container.addEventListener("mouseout", e => {
      const fromEl = e.target.closest(this.selector);
      const toEl = e.relatedTarget?.closest?.(this.selector);

      if (!fromEl || fromEl === toEl) return;

      this.hoverEl = null;

      if (this.showTimer) {
        clearTimeout(this.showTimer);
        this.showTimer = null;
      }

      if (this.tooltipVisible) {
        if (this.hideTimer) clearTimeout(this.hideTimer);
        this.hideTimer = setTimeout(() => this.hideTooltip(), this.hideDelay);
      }
    });
  }
}

const tooltip = new Tooltip(grid, ".thumb", {
  showDelay: 1000,
  hideDelay: 250,
  switchDelay: 250,
  getContent: el => {
    const item = el._item;
    if (!item) return null;
    return renderItemTooltip(item);
  }
});

function renderItemTooltip(item) {
  const itemName = decodeOsPathForDisplay(item.name);
  const itemDir = decodeOsPathForDisplay(item._dir);

  return `<table>
    <tr><td class="label">Name:</td><td class="value wrap">${itemName}</td></tr>
    <tr><td class="label">Directory:</td><td class="value wrap">${itemDir}</td></tr>
    <tr><td class="label">Modified:</td><td class="value">${formatDateTime(item.mtime)}</td></tr>
    <tr><td class="label">Size:</td><td class="value">${formatBytes(item.size)}</td></tr>
  </table>`;
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  if (bytes < 1024) return bytes + " B";
  let kb = bytes / 1024;
  if (kb < 1024) return kb.toFixed(1) + " KB";
  let mb = kb / 1024;
  if (mb < 1024) return mb.toFixed(1) + " MB";
  let gb = mb / 1024;
  return gb.toFixed(1) + " GB";
}

function formatDateTime(dateInput) {
  if (!dateInput) return "(unknown)";
  const d = typeof dateInput === "number" && dateInput < 1e12
    ? new Date(dateInput * 1000)
    : new Date(dateInput);

  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ---------------- Viewer ----------------

class Viewer {
  constructor() {
    // DOM elements
    this.viewerEl = document.getElementById("viewer");
    this.viewerImg = this.viewerEl.querySelector("img");
    this.viewerVideo = this.viewerEl.querySelector("video");
    this.viewerTitleEl = this.viewerEl.querySelector(".viewer-title");
    this.toastEl = document.getElementById("toast");

    this.navLeftEl = this.viewerEl.querySelector(".viewer-nav.left");
    this.navRightEl = this.viewerEl.querySelector(".viewer-nav.right");
    this.closeViewerBtn = this.viewerEl.querySelector(".close-btn");
    this.shuffleBtn = this.viewerEl.querySelector(".shuffle-btn");
    this.slideBtn = this.viewerEl.querySelector(".slide-btn");
    this.fullscreenBtn = this.viewerEl.querySelector(".fullscreen-btn");

    // State
    this.navItems = [];
    this.navIndex = 0;
    this.shuffleEnabled = false;
    this.shuffleOrder = null;
    this.currentHls = null;
    this.slideTimer = null;
    this.viewerControlsVisible = false;
    this.viewerFullscreenEntered = false;
    this.toastTimer = null;

    // Mouse & touch tracking
    this.lastMouseX = null;
    this.lastMouseY = null;
    this.mousemoveAccum = 0;
    this.wheelAccum = 0;
    this.touchStartX = 0;
    this.touchStartY = 0;
    this.touchActive = false;

    this.bindUI();
  }

  // ---------------- Viewer State ----------------

  isActive() {
    return this.viewerEl.style.display === "block";
  }

  openItem(item, navItems) {
    const idx = navItems.findIndex(vi => vi._key === item._key);
    if (idx === -1) {
      console.warn("Item not in navItems:", item);
      return;
    }

    this.navItems = navItems;
    this.navIndex = idx;

    if (this.shuffleEnabled) {
      this.makeShuffleOrder(this.navIndex);
    } else {
      this.shuffleOrder = null;
    }

    this.viewerEl.style.display = "block";
    this.hideViewerControls();
    this.showItem(this.navItems[this.navIndex]);
  }

  close() {
    this.disarmSlideTimer();
    this.updateSlideBtn();
    this.hideViewerControls();

    this.viewerEl.style.display = "none";

    // Stop video
    this.viewerVideo.pause();
    this.viewerVideo.removeAttribute("src");
    this.viewerVideo.load();
    this.viewerVideo.style.display = "none";

    if (this.currentHls) {
      this.currentHls.destroy();
      this.currentHls = null;
    }

    // Hide image
    this.viewerImg.style.display = "none";
    this.viewerImg.removeAttribute("src");

    this.toastEl.classList.remove("show");

    // Exit fullscreen only if viewer itself triggered it
    if (this.viewerFullscreenEntered && document.fullscreenElement === this.viewerEl) {
      document.exitFullscreen?.();
    }
    this.viewerFullscreenEntered = false;
  }

  // ---------------- Item Display ----------------

  async showItem(item) {
    if (tooltip) tooltip.hideTooltip();

    this.viewerTitleEl.textContent = decodeOsPathForDisplay(item.name);

    // Cancel previous video if any
    this.viewerVideo.pause();
    this.viewerVideo.removeAttribute("src");
    this.viewerVideo.load();

    // Destroy previous HLS instance if any
    if (this.currentHls) {
      this.currentHls.destroy();
      this.currentHls = null;
    }

    if (item.type === "video") {
      await this.showVideoItem(item);
    } else {
      // Show image
      this.viewerVideo.style.display = "none";
      this.viewerImg.src = `/api/file?path=${encodeURIComponent(item._key)}`;
      this.viewerImg.style.display = "block";
    }
  }

  async showVideoItem(item) {
    this.viewerImg.style.display = "none";
    this.viewerVideo.style.display = "block";

    const ext = item.name.split(".").pop().toLowerCase();
    const commonExts = ["mp4", "m4v", "webm", "ogg", "ogv", "mkv"];

    if (commonExts.includes(ext)) {
      try {
        this.viewerVideo.src = `/api/file?path=${encodeURIComponent(item._key)}`;
        await this.viewerVideo.play();
        return;
      } catch {
        console.warn("Native playback failed, falling back to HLS");
      }
    }

    try {
      const res = await fetch(`/api/start_hls?path=${encodeURIComponent(item._key)}`);
      const data = await res.json();
      if (!data.playlist) {
        this.showToast(data.error || "No playlist returned", 3000);
        return;
      }

      let hlsStarted = false;
      if (this.viewerVideo.canPlayType("application/vnd.apple.mpegurl")) {
        this.viewerVideo.src = data.playlist;
        await this.viewerVideo.play();
        hlsStarted = true;
      } else if (window.Hls?.isSupported()) {
        this.currentHls = new Hls();
        this.currentHls.loadSource(data.playlist);
        this.currentHls.attachMedia(this.viewerVideo);
        this.currentHls.on(Hls.Events.MANIFEST_PARSED, () => this.viewerVideo.play());
        hlsStarted = true;
      } else {
        this.showToast("Hls.js not loaded, cannot play HLS video", 3000);
      }

      if (hlsStarted)
        this.showToast("HLS playback");
    } catch (e) {
      console.error("Failed to start HLS stream", e);
      this.showToast("Failed to start HLS stream: " + e.message, 3000);
    }
  }

  makeShuffleOrder(anchorIdx) {
    this.shuffleOrder = this.navItems.map((_, i) => i);

    // Remove anchor and put it first
    if (anchorIdx >= 0 && anchorIdx < this.navItems.length) {
      this.shuffleOrder.splice(this.shuffleOrder.indexOf(anchorIdx), 1);
      this.shuffleOrder.unshift(anchorIdx);
    }

    // Fisher–Yates shuffle starting from index 1 to keep anchor first
    for (let i = 1; i < this.shuffleOrder.length; i++) {
      const j = i + Math.floor(Math.random() * (this.shuffleOrder.length - i));
      [this.shuffleOrder[i], this.shuffleOrder[j]] = [this.shuffleOrder[j], this.shuffleOrder[i]];
    }
  }

  viewerNav(delta) {
    if (this.navItems.length < 2) return;

    if (this.shuffleEnabled) {
      const i = this.shuffleOrder.indexOf(this.navIndex);
      const j = (i + delta + this.shuffleOrder.length) % this.shuffleOrder.length;
      this.navIndex = this.shuffleOrder[j];
    } else {
      this.navIndex = (this.navIndex + delta + this.navItems.length) % this.navItems.length;
    }

    this.showItem(this.navItems[this.navIndex]);
  }

  manualAdvance(delta, showUI) {
    this.viewerNav(delta);
    if (this.slideTimer) this.armSlideTimer();

    if (showUI) {
      this.showViewerControls();
      clearTimeout(this.hideTimer);
      this.hideTimer = setTimeout(() => this.hideViewerControls(), 1000);
    }

    if (this.viewerControlsVisible) {
      const navEl = delta < 0 ? this.navLeftEl : this.navRightEl;
      navEl.classList.add("active");
      setTimeout(() => navEl.classList.remove("active"), 100);
    }
  }

  // ---------------- Viewer Controls ----------------

  showViewerControls() {
    this.lastMouseX = null;
    this.lastMouseY = null;
    this.mousemoveAccum = 0;
    this.wheelAccum = 0;

    this.viewerControlsVisible = true;
    this.viewerEl.querySelectorAll(".viewer-control")
      .forEach(el => el.classList.add("show"));
  }

  hideViewerControls() {
    clearTimeout(this.hideTimer);
    this.viewerControlsVisible = false;
    this.viewerEl.querySelectorAll(".viewer-control")
      .forEach(el => el.classList.remove("show"));
  }

  toggleShuffle() {
    if (!this.isActive()) return;

    this.shuffleEnabled = !this.shuffleEnabled;

    if (this.shuffleEnabled && !this.shuffleOrder)
      this.makeShuffleOrder(this.navIndex);

    this.shuffleBtn.classList.toggle("active", this.shuffleEnabled);
    this.showToast(this.shuffleEnabled ? "Shuffle enabled" : "Shuffle disabled");
  }

  toggleSlide() {
    if (!this.isActive()) return;

    if (!this.slideTimer)
      this.armSlideTimer();
    else
      this.disarmSlideTimer();

    this.updateSlideBtn();
    this.showToast(this.slideTimer ? "Slideshow started" : "Slideshow stopped");
  }

  armSlideTimer() {
    clearTimeout(this.slideTimer);
    this.slideTimer = setTimeout(() => {
      this.viewerNav(1);
      this.armSlideTimer();
    }, 3000);
  }

  disarmSlideTimer() {
    clearTimeout(this.slideTimer);
    this.slideTimer = null;
  }

  updateSlideBtn() {
    if (this.slideTimer) {
      this.slideBtn.textContent = "⏸";
      this.slideBtn.classList.add("active");
    } else {
      this.slideBtn.textContent = "▶";
      this.slideBtn.classList.remove("active");
    }
  }

  toggleFullscreen() {
    if (!this.isActive()) return;

    if (!document.fullscreenElement) {
      this.viewerEl.requestFullscreen?.();
      this.viewerFullscreenEntered = true;
    } else {
      document.exitFullscreen?.();
      this.viewerFullscreenEntered = false;
    }
  }

  // ---------------- Video Controls ----------------

  togglePauseVideo() {
    if (this.viewerVideo.paused)
      this.viewerVideo.play();
    else
      this.viewerVideo.pause();
  }

  seekVideo(deltaSecs) {
    if (this.viewerVideo.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
      this.viewerVideo.currentTime = Math.max(0, this.viewerVideo.currentTime + deltaSecs);
    }
  }

  toggleMute() {
    this.viewerVideo.muted = !this.viewerVideo.muted;
    this.showToast(this.viewerVideo.muted ? "Mute" : "Unmute", 800);
  }

  adjustVolume(delta) {
    this.viewerVideo.volume = Math.max(0, Math.min(1, this.viewerVideo.volume + delta));
    this.showToast(`Volume ${Math.round(this.viewerVideo.volume * 100)}%`, 800);
  }

  // ---------------- Toast ----------------

  showToast(msg, duration = 1200) {
    this.toastEl.textContent = msg;
    this.toastEl.classList.remove("show");
    void this.toastEl.offsetWidth; // force reflow
    this.toastEl.classList.add("show");

    if (this.toastTimer)
      clearTimeout(this.toastTimer);

    this.toastTimer = setTimeout(() => {
      this.toastEl.classList.remove("show");
      this.toastTimer = null;
    }, duration);
  }

  // ---------------- Input Handling ----------------

  bindUI() {
    // Buttons
    this.navLeftEl.addEventListener("click", () => this.manualAdvance(-1));
    this.navRightEl.addEventListener("click", () => this.manualAdvance(1));
    this.closeViewerBtn.addEventListener("click", () => this.close());
    this.shuffleBtn.addEventListener("click", () => this.toggleShuffle());
    this.slideBtn.addEventListener("click", () => this.toggleSlide());
    this.fullscreenBtn.addEventListener("click", () => this.toggleFullscreen());

    // Keyboard
    document.addEventListener("keydown", e => this.handleKeyDown(e));
    document.addEventListener("keyup", e => this.handleKeyUp(e));

    // Mouse move
    this.viewerEl.addEventListener("mousemove", e => this.handleMouseMove(e));

    // Wheel
    this.viewerEl.addEventListener("wheel", e => this.handleWheel(e), { passive: false });

    // Touch
    this.viewerEl.addEventListener("touchstart", e => this.handleTouchStart(e), { passive: true });
    this.viewerEl.addEventListener("touchmove", e => this.handleTouchMove(e), { passive: true });
    this.viewerEl.addEventListener("touchend", e => this.handleTouchEnd(e), { passive: true });

    // Fullscreen change
    document.addEventListener("fullscreenchange", () => {
      const fs = document.fullscreenElement;
      this.fullscreenBtn.classList.toggle("active", Boolean(fs));
      if (fs !== this.viewerEl) this.viewerFullscreenEntered = false;
    });
  }

  handleKeyDown(e) {
    if (!this.isActive()) return;

    if (this.viewerVideo.style.display !== "none") {
      switch (e.key) {
        case "ArrowLeft":
          e.preventDefault();
          this.seekVideo(-5);
          return;
        case "ArrowRight":
          e.preventDefault();
          this.seekVideo(5);
          return;
        case "ArrowDown":
          e.preventDefault();
          this.seekVideo(-60);
          return;
        case "ArrowUp":
          e.preventDefault();
          this.seekVideo(60);
          return;
        case "m":
          this.toggleMute();
          return;
        case "9":
          e.preventDefault();
          this.adjustVolume(-0.1);
          return;
        case "0":
          e.preventDefault();
          this.adjustVolume(0.1);
          return;
      }
    }

    switch (e.key) {
      case "Escape":
        this.close();
        break;
      case "ArrowLeft":
      case "<":
      case "p":
        this.manualAdvance(-1, true);
        break;
      case "ArrowRight":
      case ">":
      case "n":
        this.manualAdvance(1, true);
        break;
      case "r":
        this.toggleShuffle();
        break;
      case "s":
        this.toggleSlide();
        break;
      case "f":
        this.toggleFullscreen();
        break;
    }
  }

  handleKeyUp(e) {
    if (!this.isActive()) return;

    if (this.viewerVideo.style.display !== "none") {
      if (e.key === " " || e.key === "Spacebar") {
        e.preventDefault();
        this.togglePauseVideo();
      }
    }
  }

  handleMouseMove(e) {
    if (!this.isActive()) return;

    if (this.lastMouseX === null) {
      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;
      return;
    }

    const dx = e.clientX - this.lastMouseX;
    const dy = e.clientY - this.lastMouseY;
    this.mousemoveAccum += Math.hypot(dx, dy);
    this.lastMouseX = e.clientX;
    this.lastMouseY = e.clientY;

    if (this.mousemoveAccum >= 20) {
      if (!this.viewerControlsVisible)
        this.showViewerControls();

      clearTimeout(this.hideTimer);
      this.hideTimer = setTimeout(() => this.hideViewerControls(), 1000);

      this.mousemoveAccum = 0;
    }
  }

  handleWheel(e) {
    if (!this.isActive()) return;

    e.preventDefault();
    this.wheelAccum += e.deltaY;

    const threshold = 100;
    if (this.wheelAccum >= threshold) {
      if (this.viewerImg.style.display !== "none")
        this.manualAdvance(1);
      this.wheelAccum = 0;
    } else if (this.wheelAccum <= -threshold) {
      if (this.viewerImg.style.display !== "none")
        this.manualAdvance(-1);
      this.wheelAccum = 0;
    }
  }

  handleTouchStart(e) {
    if (!this.isActive()) return;
    if (e.touches.length !== 1) return;

    const t = e.touches[0];
    this.touchStartX = t.clientX;
    this.touchStartY = t.clientY;
    this.touchActive = true;

    this.showViewerControls();
    clearTimeout(this.hideTimer);
  }

  handleTouchMove(e) {
    if (!this.touchActive) return;
    if (e.touches.length !== 1) return;

    const t = e.touches[0];
    // could accumulate dx/dy for gestures if needed
  }

  handleTouchEnd(e) {
    if (!this.touchActive) return;
    this.touchActive = false;

    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this.hideViewerControls(), 1000);

    const t = e.changedTouches[0];
    const dx = t.clientX - this.touchStartX;
    const dy = t.clientY - this.touchStartY;

    // horizontal swipe detection
    if (Math.abs(dx) >= 50 && Math.abs(dx) > 2 * Math.abs(dy)) {
      if (dx < 0)
        this.viewerNav(1);
      else
        this.viewerNav(-1);
    }
  }
}

const viewer = new Viewer();

// ---------------- Window ----------------

function resizeMain() {
  // Prevent mobile browser chrome overlapping our page.
  const height = window.innerHeight - topbar.offsetHeight;
  main.style.height = height + 'px';
}

window.addEventListener('load', resizeMain);
window.addEventListener('resize', resizeMain);
window.addEventListener('orientationchange', resizeMain);

// ---------------- Init ----------------

loadTree().then(() => {
  const initialDir = treeData.dirs[0]?.path;
  if (initialDir) {
    openAndLoadDir(initialDir)
  }
});
