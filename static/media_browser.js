"use strict";

let treeData = null;
let currentPath = "";
const openDirs = {};    // open/closed state in dir tree

let allItems = [];      // unfiltered
let filteredItems = [];
let groups = {};        // dirPath -> array of items
let groupOrder = [];
let groupOpen = {};     // open/closed state of groups in grid
let navItems = [];
let navIndex = 0;

let sortType = "name";  // name | mtime | size
let sortAscending = true;
let mediaType = "all";  // all | image | video
let recursive = false;
let groupByDir = true;
let showNames = true;

const DEFAULT_THUMB_ZOOM = 180; // px

let shuffleEnabled = false;
let shuffleOrder = null;   // array of indices into navOrder[]

let currentHls = null;
let viewerControlsVisible = false;
let viewerAllowClick = true;
let viewerFullscreenEntered = false;

let hideTimer = null;
let slideTimer = null;
let toastTimer = null;

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

const viewerEl = document.getElementById("viewer");
const viewerTitleEl = document.getElementById("viewerTitle");
const viewerImg = document.getElementById("viewerImg");
const viewerVideo = document.getElementById("viewerVideo");

const shuffleBtn = document.getElementById("shuffleBtn");
const slideBtn = document.getElementById("slideBtn");
const fullscreenBtn = document.getElementById("fullscreenBtn");
const closeViewerBtn = document.getElementById("closeViewerBtn");
const navLeftEl = document.getElementById("navLeft");
const navRightEl = document.getElementById("navRight");
const toastEl = document.getElementById("toast");

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

let isDragging = false;

function startDrag(clientX) {
  isDragging = true;
  document.body.style.cursor = "col-resize";
}

function doDrag(clientX) {
  if (isDragging) {
    let newWidth = clientX; // distance from left edge
    newWidth = Math.max(150, Math.min(newWidth, window.innerWidth * 0.5));
    tree.style.width = newWidth + "px";
  }
}

function endDrag() {
  if (isDragging) {
    isDragging = false;
    document.body.style.cursor = "default";
  }
}

// Mouse events
dragbar.addEventListener("mousedown", e => {
  e.preventDefault();
  startDrag(e.clientX);
});
document.addEventListener("mousemove", e => doDrag(e.clientX));
document.addEventListener("mouseup", endDrag);

// Touch events
dragbar.addEventListener("touchstart", e => {
  e.preventDefault();
  startDrag(e.touches[0].clientX);
}, { passive: false });

document.addEventListener("touchmove", e => {
  doDrag(e.touches[0].clientX);
}, { passive: false });

document.addEventListener("touchend", endDrag);

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
  // Remove previous selection
  const prev = tree.querySelector(".dir-header.selected");
  if (prev) prev.classList.remove("selected");

  // Open ancestors of the selected path
  openAncestorDirs(newPath);
  syncOpenTreeDirs();

  // Add selection to the target node
  const newNode = tree.querySelector(`.dir-header span[data-path='${newPath}']`);
  if (newNode) newNode.parentElement.classList.add("selected");
}

function openAndLoadDir(path) {
  if (path === currentPath) return;

  loadDir(path);
  openDirs[path] = true;
  highlightTreeDir(path);
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

async function loadDir(newPath) {
  if (newPath !== currentPath) {
    groupOpen = {};
  }

  currentPath = newPath;
  allItems = [];

  async function addItemsForDir(dir) {
    const r = await fetch(`/api/list?path=${encodeURIComponent(dir)}`);
    const data = await r.json();

    data.files.forEach(f => {
      // The API gives us for each file:
      //    name
      //    type
      //    mtime
      //    size
      // We add:
      //    _dir
      allItems.push({ ...f, _dir: dir });
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

  deriveItemGroupsAndLists();
  renderGrid();

  updateBreadcrumbs(currentPath);
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
  filteredItems = allItems.filter(filterMedia);

  groups = {};
  groupOrder = [];
  navItems = [];

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
      navItems.push(...groups[dir]);
    });
  }
  else {
    navItems = sortItems(filteredItems);
  }
}

function filterMedia(item) {
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

  deriveItemGroupsAndLists();
  renderGrid();
}

orderBtn.addEventListener("click", toggleOrder);

function toggleRecursive() {
  recursive = !recursive;
  recursiveBtn.classList.toggle("active", recursive);

  loadDir(currentPath);
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

function refreshDir() {
  // TODO: update dir tree based on changed filesystem
  loadDir(currentPath);
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

    span.addEventListener("click", () => {
      if (pathto !== currentPath) {
        loadDir(pathto);
        highlightTreeDir(pathto);
      }
    });

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
    return;
  }

  // Map existing thumbs by stable key
  const existing = new Map(
    [...grid.querySelectorAll(".thumb")].map(d => [d.dataset.key, d])
  );

  const frag = document.createDocumentFragment();

  if (recursive && groupByDir) {
    groupOrder.forEach(dir => {
      // Groups are open by default.
      if (!(dir in groupOpen)) groupOpen[dir] = true;

      // Header
      const header = document.createElement("div");
      header.className = "group-divider";

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

      // Container for group thumbnails
      const groupItems = document.createElement("div");
      groupItems.className = "group-items";
      groups[dir].forEach(f => {
        groupItems.appendChild(addThumb(f, existing));
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
        if (dir === currentPath) return;
        loadDir(dir);
        highlightTreeDir(dir);
      };
    });
  } else {
    // Flat grid
    navItems.forEach(f => {
      frag.appendChild(addThumb(f, existing));
    });
  }

  grid.replaceChildren(frag);
}

function createNoMediaMsg() {
  const msg = document.createElement("div");
  msg.className = "no-media";
  msg.textContent = "No supported media in this directory";
  return msg;
}

function addThumb(item, existing) {
  const key = joinOsPaths(item._dir, item.name);
  let d = existing.get(key);

  if (!d) {
    d = document.createElement("div");
    d.className = "thumb";
    d.dataset.key = key;

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

  d.classList.toggle("hide-name", !showNames);

  return d;
}

function thumbObserverCallback(entries, observer) {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      const placeholder = entry.target;

      if (!placeholder.querySelector("img")) {
        const item = placeholder.item;
        const key = joinOsPaths(item._dir, item.name);

        const img = document.createElement("img");
        img.loading = "lazy";
        img.src = "/api/thumb?path=" + encodeURIComponent(key);
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
  if (item) openViewer(item);
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
  thumbZoomSlider.value = DEFAULT_THUMB_ZOOM
  updateThumbSizes(DEFAULT_THUMB_ZOOM);
});

function updateThumbSizes(value) {
  grid.style.gridTemplateColumns = `repeat(auto-fill, minmax(${value}px, 1fr))`;
}

// ---------------- Viewer ----------------

function isViewerActive() {
  return viewerEl.style.display === "block";
}

function openViewer(item) {
  const idx = navItems.findIndex(f => f._dir === item._dir && f.name === item.name);
  if (idx === -1) {
    console.warn(`openView() item not found: item._dir=${item._dir}, item.name=${item.name}`);
    return;
  }

  navIndex = idx;
  if (shuffleEnabled) {
    makeShuffleOrder(navIndex);
  } else {
    shuffleOrder = null;
  }

  viewerEl.style.display = "block";
  hideViewerControls();
  showItem(navItems[navIndex]);
}

async function showItem(item) {
  viewerTitleEl.textContent = decodeOsPathForDisplay(item.name);

  // Cancel previous video if any
  viewerVideo.pause();
  viewerVideo.removeAttribute("src");
  viewerVideo.load();

  // Destroy previous HLS instance if any
  if (currentHls) {
    currentHls.destroy();
    currentHls = null;
  }

  if (item.type === "video") {
    showVideoItem(item);
  } else {
    // Hide video
    viewerVideo.style.display = "none";

    // Show image
    const itemPath = joinOsPaths(item._dir, item.name);
    viewerImg.src = `/api/file?path=${encodeURIComponent(itemPath)}`;
    viewerImg.style.display = "block";
  }
}

async function showVideoItem(item) {
  viewerImg.style.display = "none";
  viewerVideo.style.display = "block";

  const itemPath = joinOsPaths(item._dir, item.name);
  const ext = item.name.split(".").pop().toLowerCase();

  const commonExts = ["mp4", "m4v", "webm", "ogg", "ogv", "mkv"];

  if (commonExts.includes(ext)) {
    try {
      viewerVideo.src = `/api/file?path=${encodeURIComponent(itemPath)}`;
      await viewerVideo.play();
      return; // native playback succeeded
    } catch (e) {
      console.warn("Native playback failed, falling back to HLS:", e);
    }
  }

  try {
    const res = await fetch(`/api/start_hls?path=${encodeURIComponent(itemPath)}`);
    const data = await res.json();
    if (!data.playlist) {
      console.error(data.error || "No playlist returned");
      showToast("No playlist returned", 3000);
      return;
    }

    let hlsStarted = false;
    if (viewerVideo.canPlayType("application/vnd.apple.mpegurl")) {
      viewerVideo.src = data.playlist;
      await viewerVideo.play();
      hlsStarted = true;
    } else if (window.Hls && window.Hls.isSupported()) {
      currentHls = new Hls();
      currentHls.loadSource(data.playlist);
      currentHls.attachMedia(viewerVideo);
      currentHls.on(Hls.Events.MANIFEST_PARSED, () => viewerVideo.play());
      hlsStarted = true;
    } else {
      showToast("Hls.js not loaded, cannot play HLS video", 3000);
    }

    if (hlsStarted) {
      showToast("HLS playback");
    }
  } catch (e) {
    console.error("Failed to start HLS stream", e);
    showToast("Failed to start HLS stream: " + e.message, 3000);
  }
}

function makeShuffleOrder(anchorIdx) {
  shuffleOrder = navItems.map((_, i) => i);

  // Remove anchor and put it first
  if (anchorIdx >= 0 && anchorIdx < navItems.length) {
    shuffleOrder.splice(shuffleOrder.indexOf(anchorIdx), 1);
    shuffleOrder.unshift(anchorIdx);
  }

  // Fisher–Yates shuffle starting from index 1 to keep anchor first
  for (let i = 1; i < shuffleOrder.length; i++) {
    const j = i + Math.floor(Math.random() * (shuffleOrder.length - i));
    [shuffleOrder[i], shuffleOrder[j]] = [shuffleOrder[j], shuffleOrder[i]];
  }
}

function viewerNav(d) {
  if (navItems.length < 2)
    return;

  if (shuffleEnabled) {
    const i = shuffleOrder.indexOf(navIndex);
    const j = (i + d + shuffleOrder.length) % shuffleOrder.length;
    navIndex = shuffleOrder[j];
  } else {
    navIndex = (navIndex + d + navItems.length) % navItems.length;
  }

  showItem(navItems[navIndex]);
}

function manualAdvance(d, showUI) {
  viewerNav(d);

  if (slideTimer)
    armSlideTimer(); // reset countdown

  if (showUI) {
    showViewerControls();
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hideViewerControls, 1000);
  }
}

function closeViewer() {
  disarmSlideTimer();
  updateSlideBtn();
  hideViewerControls();
  viewerEl.style.display = "none";

  // Stop video
  viewerVideo.pause();
  viewerVideo.removeAttribute("src");
  viewerVideo.load();
  viewerVideo.style.display = "none";

  if (currentHls) {
    currentHls.destroy();
    currentHls = null;
  }

  // Hide image
  viewerImg.style.display = "none";
  viewerImg.removeAttribute("src");

  toastEl.classList.remove("show");

  // Exit fullscreen only if viewer itself triggered it
  if (viewerFullscreenEntered && document.fullscreenElement === viewerEl) {
    document.exitFullscreen?.();
  }
  viewerFullscreenEntered = false;
}

// ---------------- Viewer controls ----------------

function showViewerControls() {
  viewerControlsVisible = true;

  document.querySelectorAll(".viewer-control").forEach(el => {
    el.classList.add("show");
  });
}

function hideViewerControls() {
  clearTimeout(hideTimer);
  viewerControlsVisible = false;

  document.querySelectorAll(".viewer-control").forEach(el => {
    el.classList.remove("show");
  });

  resetMouseAccum();
}

function toggleShuffle() {
  if (!isViewerActive()) return;

  shuffleEnabled = !shuffleEnabled;

  if (shuffleEnabled && !shuffleOrder) {
    makeShuffleOrder(navIndex);
  }

  shuffleBtn.classList.toggle("active", shuffleEnabled);
  showToast(shuffleEnabled ? "Shuffle enabled" : "Shuffle disabled");
}

shuffleBtn.addEventListener("click", () => {
  if (viewerAllowClick)
    toggleShuffle();
});

function toggleSlide() {
  if (!isViewerActive()) return;

  if (!slideTimer)
    armSlideTimer();
  else
    disarmSlideTimer();

  updateSlideBtn();
  showToast(slideTimer ? "Slideshow started" : "Slideshow stopped");
}

function armSlideTimer() {
  clearTimeout(slideTimer);
  slideTimer = setTimeout(() => {
    viewerNav(1);
    armSlideTimer(); // schedule next
  }, 3000);
}

function disarmSlideTimer() {
  clearTimeout(slideTimer);
  slideTimer = null;
}

function updateSlideBtn() {
  if (slideTimer) {
    slideBtn.textContent = "⏸";
    slideBtn.classList.add("active");
  } else {
    slideBtn.textContent = "▶";
    slideBtn.classList.remove("active");
  }
}

slideBtn.addEventListener("click", () => {
  if (viewerAllowClick)
    toggleSlide();
});

function toggleFullscreen() {
  if (!isViewerActive()) return;

  if (!document.fullscreenElement) {
    viewerEl.requestFullscreen?.();
    viewerFullscreenEntered = true;
  } else {
    document.exitFullscreen?.();
    viewerFullscreenEntered = false;
  }
}

fullscreenBtn.addEventListener("click", () => {
  if (viewerAllowClick)
    toggleFullscreen();
});

document.addEventListener("fullscreenchange", () => {
  const fs = document.fullscreenElement;
  fullscreenBtn.classList.toggle("active", Boolean(fs));
  // Reset flag if user exits fullscreen manually
  if (fs !== viewerEl)
    viewerFullscreenEntered = false;
});

closeViewerBtn.addEventListener("click", () => {
  if (viewerAllowClick)
    closeViewer();
});

navLeftEl.addEventListener("click", () => {
  if (viewerAllowClick)
    manualAdvance(-1);
});

navRightEl.addEventListener("click", () => {
  if (viewerAllowClick)
    manualAdvance(1);
});

// ---------------- Video controls ----------------

function togglePauseVideo() {
  if (viewerVideo.paused)
    viewerVideo.play();
  else
    viewerVideo.pause();
}

function seekVideo(deltaSecs) {
  if (viewerVideo.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
    viewerVideo.currentTime = Math.max(0, viewerVideo.currentTime + deltaSecs);
  }
}

function toggleMute() {
  viewerVideo.muted = !viewerVideo.muted;
  showToast(viewerVideo.muted ? "Mute" : "Unmute", 800);
}

function adjustVolume(delta) {
  const vol = Math.max(0, Math.min(1, viewerVideo.volume + delta));
  viewerVideo.volume = vol;

  const i = Math.round(vol * 100);
  showToast("Volume " + i + "%", 800);
}

// ---------------- Toast ----------------

function showToast(msg, duration=1200) {
  toastEl.textContent = msg;

  // Restart CSS transition:
  // removing + forcing reflow ensures transition runs again
  toastEl.classList.remove("show");
  void toastEl.offsetWidth;

  toastEl.classList.add("show");

  if (toastTimer)
    clearTimeout(toastTimer);

  toastTimer = setTimeout(() => {
    toastEl.classList.remove("show");
    toastTimer = null;
  }, duration);
}

// ---------------- Viewer inputs ----------------

// Keyboard
document.addEventListener("keydown", e => {
  if (!isViewerActive()) return;

  if (viewerVideo.style.display !== "none") {
    switch (e.key) {
      case "ArrowLeft":
        e.preventDefault();
        seekVideo(-5);
        return;
      case "ArrowRight":
        e.preventDefault();
        seekVideo(5);
        return;
      case "ArrowDown":
        e.preventDefault();
        seekVideo(-60);
        return;
      case "ArrowUp":
        e.preventDefault();
        seekVideo(60);
        return;
      case "m":
        // TODO: would be better if this didn't repeat
        toggleMute();
        return;
      case "9":
        e.preventDefault();
        adjustVolume(-0.1);
        return;
      case "0":
        e.preventDefault();
        adjustVolume(0.1);
        return;
    }
  }

  switch (e.key) {
    case "Escape":
      closeViewer();
      break;
    case "ArrowLeft":
    case "<":
    case "p":
      manualAdvance(-1, true);
      break;
    case "ArrowRight":
    case ">":
    case "n":
      manualAdvance(1, true);
      break;
    // TODO: would be better if these didn't repeat
    case "r":
      toggleShuffle();
      break;
    case "s":
      toggleSlide();
      break;
    case "f":
      toggleFullscreen();
      break;
  }
});

document.addEventListener("keyup", e => {
  if (!isViewerActive()) return;

  if (viewerVideo.style.display !== "none") {
    switch (e.key) {
      case " ":
      case "Spacebar": // older browsers
        e.preventDefault();
        togglePauseVideo();
        return;
    }
  }
});

// Mouse movement
let lastMouseX = null;
let lastMouseY = null;
let mousemoveAccum = 0;

function resetMouseAccum() {
  lastMouseX = null;
  lastMouseY = null;
  mousemoveAccum = 0;
  wheelAccum = 0;
}

viewerEl.addEventListener("mousemove", e => {
  if (!isViewerActive()) return;

  if (lastMouseX === null) {
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
    return;
  }

  const dx = e.clientX - lastMouseX;
  const dy = e.clientY - lastMouseY;

  mousemoveAccum += Math.hypot(dx, dy);

  lastMouseX = e.clientX;
  lastMouseY = e.clientY;

  if (mousemoveAccum >= 20) {
    if (!viewerControlsVisible) {
      showViewerControls();
    }
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hideViewerControls, 1000);
    mousemoveAccum = 0;
  }
});

/*
// This was an attempt to make the UI hide more quickly
// when the mouse cursor is moved outside the window,
// but it fires in other cases as well I think.
window.addEventListener("mouseout", () => {
  if (!isViewerActive()) return;

  clearTimeout(hideTimer);
  hideTimer = setTimeout(hideViewerControls, 200);
});
*/

// Mouse wheel
let wheelAccum = 0;

viewerEl.addEventListener("wheel", e => {
  if (!isViewerActive()) return;

  e.preventDefault(); // stop page scrolling

  wheelAccum += e.deltaY;

  // TODO: for video, use mouse wheel for something else
  const threshold = 100;
  if (wheelAccum >= threshold) {
    if (viewerImg.style.display !== "none")
      manualAdvance(1);
    wheelAccum = 0;
  } else if (wheelAccum <= -threshold) {
    if (viewerImg.style.display !== "none")
      manualAdvance(-1);
    wheelAccum = 0;
  }
}, { passive: false });

// Touch
let touchStartX = 0;
let touchStartY = 0;
let touchActive = false;

viewerEl.addEventListener("touchstart", e => {
  if (!isViewerActive()) return;
  if (e.touches.length !== 1) return;
  // Only handle "click" events if the viewer controls are visible
  // when the screen is touched.
  // It turns out to be more annoying than it helps.
  //viewerAllowClick = viewerControlsVisible;

  const t = e.touches[0];
  touchStartX = t.clientX;
  touchStartY = t.clientY;
  touchActive = true;

  // Keep showing overlay while touching.
  showViewerControls();
  clearTimeout(hideTimer);
}, { passive: true });

viewerEl.addEventListener("touchmove", e => {
  if (!touchActive) return;
  if (e.touches.length !== 1) return;

  const t = e.touches[0];
  const dx = t.clientX - touchStartX;
  const dy = t.clientY - touchStartY;
}, { passive: true });

viewerEl.addEventListener("touchend", e => {
  if (!touchActive) return;
  touchActive = false;

  clearTimeout(hideTimer);
  hideTimer = setTimeout(hideViewerControls, 1000);

  const t = e.changedTouches[0];
  const dx = t.clientX - touchStartX;
  const dy = t.clientY - touchStartY;

  // Detect horizontal swipes.
  if (Math.abs(dx) < 50 || Math.abs(dx) < 2 * Math.abs(dy))
    return;

  if (dx < 0) {
    viewerNav(1);
  } else {
    viewerNav(-1);
  }
}, { passive: true });

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
    loadDir(initialDir);
    highlightTreeDir(initialDir);
  }
});
