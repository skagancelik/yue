"use strict";

const $ = (id) => document.getElementById(id);
const API = "/api";
const STATUS_TEXT = { queued: "Sırada", running: "Üretiliyor", succeeded: "Hazır", failed: "Hata", cancelled: "İptal" };
const GPU_HOURLY_USD = { "g6.2xlarge": 1.2, "g5.2xlarge": 1.46, "g6e.xlarge": 2.24, "g6.xlarge": 0.98, "g5.xlarge": 1.23 };
const UNFILED = "unfiled";

let passcode = null;
let source = null;          // selected source for the next job: {id?, key?, name, url}
let folders = [];
let sources = [];
let jobs = [];
let styles = [];
let gpu = null;
let pollTimer = null;
let view = { type: "folder", id: null, tab: "sources" };   // or {type: "liked"} / {type: "folder", id: UNFILED}
let lastFolderId = null;
const pendingEdit = new Set();   // freshly uploaded sources open their style/lyrics editor
let uploads = [];                // uploads in flight: {name, fraction, error}

try {
  passcode = localStorage.getItem("yue.passcode");
  view = { ...view, ...(JSON.parse(localStorage.getItem("yue.view")) || {}) };
} catch (_) { /* private mode */ }

async function api(path, options = {}) {
  const response = await fetch(API + path, {
    ...options,
    headers: { "content-type": "application/json", "x-passcode": passcode || "", ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401) { showLogin(body.error); throw new Error(body.error || "Yetkisiz"); }
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function report(error) {
  console.warn(error);
  alert(error.message || String(error));
}

// ---------------------------------------------------------------- auth

function showLogin(message) {
  $("app").classList.add("hidden");
  $("login").classList.remove("hidden");
  $("login-error").textContent = message || "";
  clearTimeout(pollTimer);
}

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  passcode = $("passcode").value.trim();
  try {
    await api("/login", { method: "POST" });
    try { localStorage.setItem("yue.passcode", passcode); } catch (_) {}
    start();
  } catch (_) { /* showLogin already rendered the error */ }
});

function start() {
  $("login").classList.add("hidden");
  $("app").classList.remove("hidden");
  loadStyles();
  refresh();
}

// ---------------------------------------------------------------- views & folders

function currentFolder() {
  return view.type === "folder" ? folders.find((f) => f.id === view.id) : null;
}

function activeTab() {
  return view.type === "folder" && currentFolder() ? (view.tab === "jobs" ? "jobs" : "sources") : "jobs";
}

function setView(next) {
  view = { tab: view.tab, ...next };
  closeMenus();
  if (view.type === "folder" && view.id && view.id !== UNFILED) lastFolderId = view.id;
  try { localStorage.setItem("yue.view", JSON.stringify(view)); } catch (_) {}
  if (source && source.folder_id && (!currentFolder() || source.folder_id !== view.id)) clearSource();
  render();
}

function unfiledJobs() {
  const known = new Set(folders.map((f) => f.id));
  return jobs.filter((j) => !j.folder_id || !known.has(j.folder_id));
}

function renderSidebar() {
  const list = $("folder-list");
  const items = folders.map((f) => ({ id: f.id, name: f.name, count: jobs.filter((j) => j.folder_id === f.id).length }));
  const unfiled = unfiledJobs();
  if (unfiled.length) items.push({ id: UNFILED, name: "Klasörsüz", count: unfiled.length, muted: true });
  list.replaceChildren(...items.map((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "nav-item" + (view.type === "folder" && view.id === item.id ? " active" : "") + (item.muted ? " muted" : "");
    button.innerHTML = `<span class="nav-icon">📁</span><span class="nav-name"></span><span class="nav-count"></span>`;
    button.querySelector(".nav-name").textContent = item.name;
    button.querySelector(".nav-count").textContent = item.count || "";
    button.addEventListener("click", () => setView({ type: "folder", id: item.id }));
    return button;
  }));
  const liked = jobs.filter((j) => j.liked).length;
  $("liked-count").textContent = liked || "";
  document.querySelector('.topnav-item[data-top="folders"]').classList.toggle("active", view.type === "folder");
  document.querySelector('.topnav-item[data-top="liked"]').classList.toggle("active", view.type === "liked");
}

document.querySelector('.topnav-item[data-top="liked"]').addEventListener("click", () => setView({ type: "liked" }));
document.querySelector('.topnav-item[data-top="folders"]').addEventListener("click", () => {
  const id = folders.some((f) => f.id === lastFolderId) ? lastFolderId : (folders[0] ? folders[0].id : null);
  setView({ type: "folder", id });
});
document.querySelectorAll(".subtab").forEach((button) => button.addEventListener("click", () => setView({ ...view, tab: button.dataset.tab })));

async function newFolder(name) {
  name = (name || "").trim();
  if (!name) return;
  try {
    const folder = await api("/folders", { method: "POST", body: JSON.stringify({ name }) });
    folders = [folder, ...folders];
    setView({ type: "folder", id: folder.id });
  } catch (error) { report(error); }
}

$("folder-new").addEventListener("click", () => newFolder(prompt("Klasör adı")));
$("first-folder").addEventListener("submit", (event) => {
  event.preventDefault();
  newFolder($("first-folder-name").value);
  $("first-folder-name").value = "";
});

$("folder-menu-btn").addEventListener("click", (event) => {
  event.stopPropagation();
  closeMenus($("folder-menu-list"));
  const open = $("folder-menu-list").classList.toggle("hidden") === false;
  $("folder-menu-btn").setAttribute("aria-expanded", String(open));
});

$("folder-rename").addEventListener("click", async () => {
  const folder = currentFolder();
  const name = folder && prompt("Yeni ad", folder.name);
  if (!name || !name.trim()) return;
  try {
    const updated = await api(`/folders/${folder.id}`, { method: "PATCH", body: JSON.stringify({ name: name.trim() }) });
    folders = folders.map((f) => (f.id === updated.id ? updated : f));
    render();
  } catch (error) { report(error); }
});

$("folder-delete").addEventListener("click", async () => {
  const folder = currentFolder();
  if (!folder || !confirm(`"${folder.name}" klasörü ve içindeki kaynak şarkılar silinsin mi?`)) return;
  try {
    await api(`/folders/${folder.id}`, { method: "DELETE" });
    folders = folders.filter((f) => f.id !== folder.id);
    sources = sources.filter((s) => s.folder_id !== folder.id);
    setView({ type: "folder", id: folders[0] ? folders[0].id : null });
  } catch (error) { report(error); }
});

// ---------------------------------------------------------------- source selection & upload

const drop = $("drop");
["dragenter", "dragover"].forEach((type) => drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((type) => drop.addEventListener(type, () => drop.classList.remove("over")));
drop.addEventListener("drop", (event) => {
  event.preventDefault();
  if (event.dataTransfer.files[0]) handleFile(event.dataTransfer.files[0]);
});
$("file").addEventListener("change", (event) => event.target.files[0] && handleFile(event.target.files[0]));
$("file-clear").addEventListener("click", clearSource);

function clearSource() {
  source = null;
  $("file").value = "";
  $("drop-file").classList.add("hidden");
  $("drop-empty").classList.remove("hidden");
  drop.classList.remove("has-file");
  updateCreate();
  renderSources();
}

function showSource(name, url, uploaded) {
  drop.classList.add("has-file");
  $("drop-empty").classList.add("hidden");
  $("drop-file").classList.remove("hidden");
  $("file-name").textContent = name;
  if (url) $("file-preview").src = url;
  $("upload-bar").style.width = uploaded ? "100%" : "0";
}

function selectSource(item) {
  source = { id: item.id, name: item.name, url: item.url, folder_id: item.folder_id };
  showSource(item.name, item.url, true);
  if (!$("title").value) $("title").value = item.name.replace(/\.[^.]+$/, "") + " (cover)";
  // A source remembers the style and lyrics it was last used with.
  if (item.style) { $("style").value = item.style; $("style-set").value = ""; $("style-delete").classList.add("hidden"); }
  if (item.lyrics) $("lyrics").value = item.lyrics;
  updateCreate();
  renderSources();
}

async function saveSourceText(item, style, lyrics, note) {
  const body = { style, lyrics };
  if (note !== undefined) body.note = note;
  const updated = await api(`/sources/${item.id}`, { method: "PATCH", body: JSON.stringify(body) });
  sources = sources.map((s) => (s.id === updated.id ? { ...s, style: updated.style, lyrics: updated.lyrics, note: updated.note } : s));
  return updated;
}

$("source-text-save").addEventListener("click", async () => {
  if (!source || !source.id) return;
  const note = $("create-note");
  try {
    await saveSourceText(source, $("style").value.trim(), $("lyrics").value.trim());
    note.textContent = "Stil ve söz kaynak şarkıya kaydedildi";
    renderSources();
  } catch (error) { report(error); }
});

async function handleFile(file) {
  $("create-error").textContent = "";
  const folder = currentFolder();
  if (!folder) { $("create-error").textContent = "Önce bir klasör seç"; return; }
  if (file.size > 40 * 1024 * 1024) { $("create-error").textContent = "Dosya en fazla 40 MB olabilir"; return; }
  source = null;
  showSource(file.name, URL.createObjectURL(file), false);
  if (!$("title").value) $("title").value = file.name.replace(/\.[^.]+$/, "") + " (cover)";
  updateCreate();
  try {
    const contentType = file.type || "application/octet-stream";
    const signed = await api("/uploads", {
      method: "POST", body: JSON.stringify({ filename: file.name, size: file.size, content_type: contentType }),
    });
    await putWithProgress(signed.url, file, signed.content_type, (fraction) => {
      $("upload-bar").style.width = `${Math.round(fraction * 95)}%`;
    });
    const saved = await api(`/folders/${folder.id}/sources`, {
      method: "POST", body: JSON.stringify({ upload_key: signed.key, name: file.name }),
    });
    sources = [saved, ...sources];
    selectSource(saved);
  } catch (error) {
    $("create-error").textContent = "Yükleme başarısız: " + error.message;
  }
  updateCreate();
}

function putWithProgress(url, file, contentType, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(`S3 ${xhr.status}`)));
    xhr.onerror = () => reject(new Error("ağ hatası"));
    xhr.send(file);
  });
}

function renderUploads() {
  $("upload-list").replaceChildren(...uploads.map((item) => {
    const row = document.createElement("div");
    row.className = "upload-row" + (item.error ? " failed" : "");
    row.innerHTML = `<span class="upload-name"></span><span class="upload-state small"></span><div class="progress"><div></div></div>`;
    row.querySelector(".upload-name").textContent = item.name;
    row.querySelector(".upload-state").textContent = item.error ? item.error : `${Math.round(item.fraction * 100)}%`;
    row.querySelector(".progress > div").style.width = `${Math.round(item.fraction * 100)}%`;
    return row;
  }));
}

async function uploadSources(files) {
  const folder = currentFolder();
  if (!folder || !files.length) return;
  uploads = uploads.filter((u) => !u.error);
  await Promise.all(files.map(async (file) => {
    const entry = { name: file.name, fraction: 0, error: "" };
    uploads.push(entry);
    renderUploads();
    try {
      if (file.size > 40 * 1024 * 1024) throw new Error("en fazla 40 MB");
      const signed = await api("/uploads", {
        method: "POST", body: JSON.stringify({ filename: file.name, size: file.size, content_type: file.type || "application/octet-stream" }),
      });
      await putWithProgress(signed.url, file, signed.content_type, (fraction) => { entry.fraction = fraction * 0.95; renderUploads(); });
      const saved = await api(`/folders/${folder.id}/sources`, {
        method: "POST", body: JSON.stringify({ upload_key: signed.key, name: file.name }),
      });
      sources = [saved, ...sources];
      pendingEdit.add(saved.id);
      uploads = uploads.filter((u) => u !== entry);
    } catch (error) {
      entry.error = "yüklenemedi: " + error.message;
    }
    renderUploads();
    renderSources();
  }));
}

$("source-upload").addEventListener("click", () => $("source-file").click());
$("source-file").addEventListener("change", (event) => { uploadSources([...event.target.files]); event.target.value = ""; });
const sourcesBlock = $("sources-block");
["dragenter", "dragover"].forEach((type) => sourcesBlock.addEventListener(type, (e) => { e.preventDefault(); sourcesBlock.classList.add("over"); }));
["dragleave", "drop"].forEach((type) => sourcesBlock.addEventListener(type, () => sourcesBlock.classList.remove("over")));
sourcesBlock.addEventListener("drop", (event) => { event.preventDefault(); uploadSources([...event.dataTransfer.files]); });

function renderSources() {
  const folder = currentFolder();
  if (!folder) return;
  const list = sources.filter((s) => s.folder_id === folder.id);
  $("sources-count").textContent = list.length || "";
  $("sources-empty").classList.toggle("hidden", list.length > 0 || uploads.length > 0);
  $("source-text-save").classList.toggle("hidden", !(source && source.id));
  const container = $("sources");
  const existing = new Map([...container.children].map((node) => [node.dataset.id, node]));
  container.replaceChildren(...list.map((item) => {
    let node = existing.get(item.id);
    if (!node) {
      node = $("source-tpl").content.firstElementChild.cloneNode(true);
      node.dataset.id = item.id;
      node.querySelector("audio").src = item.url;
    }
    if (pendingEdit.delete(item.id)) node.classList.add("editing");
    node.classList.toggle("selected", !!source && source.id === item.id);
    node.querySelector(".source-name").textContent = item.name;
    const used = jobs.filter((j) => j.source_id === item.id).length;
    const saved = item.style || item.lyrics;
    node.querySelector(".source-meta").textContent = [used ? `${used} üretim` : "", saved ? "✓ stil ve söz kayıtlı" : "", fmtAgo(item.created_at)].filter(Boolean).join(" · ");
    node.querySelector(".use").textContent = source && source.id === item.id ? "Seçili" : "Bununla üret";
    node.querySelector(".use").onclick = () => { selectSource(item); window.scrollTo({ top: 0, behavior: "smooth" }); };
    // Do not overwrite what is being typed while the library refreshes.
    if (!node.classList.contains("editing")) {
      node.querySelector(".src-style").value = item.style || "";
      node.querySelector(".src-lyrics").value = item.lyrics || "";
    }
    const noteLine = node.querySelector(".source-note");
    noteLine.textContent = item.note || "";
    noteLine.classList.toggle("hidden", !item.note);
    if (!node.classList.contains("editing")) node.querySelector(".src-note").value = item.note || "";
    node.querySelector(".rename").onclick = async () => {
      const name = prompt("Kaynak şarkı adı", item.name);
      if (!name || !name.trim() || name.trim() === item.name) return;
      try {
        const updated = await api(`/sources/${item.id}`, { method: "PATCH", body: JSON.stringify({ name: name.trim() }) });
        sources = sources.map((s) => (s.id === updated.id ? { ...s, name: updated.name } : s));
        renderSources();
      } catch (error) { report(error); }
    };
    node.querySelector(".edit-text").onclick = () => node.classList.toggle("editing");
    node.querySelector(".src-save").onclick = async () => {
      const note = node.querySelector(".src-note");
      try {
        await saveSourceText(item, node.querySelector(".src-style").value.trim(), node.querySelector(".src-lyrics").value.trim(), node.querySelector(".src-note").value.trim());
        note.textContent = "Kaydedildi";
        node.classList.remove("editing");
        if (source && source.id === item.id) selectSource(sources.find((s) => s.id === item.id));
        else renderSources();
      } catch (error) { note.textContent = error.message; }
    };
    node.querySelector(".remove").onclick = async () => {
      if (!confirm(`"${item.name}" kaynak şarkısı silinsin mi? (Üretilen cover'lar kalır.)`)) return;
      try {
        await api(`/sources/${item.id}`, { method: "DELETE" });
        sources = sources.filter((s) => s.id !== item.id);
        if (source && source.id === item.id) clearSource();
        renderSources();
      } catch (error) { report(error); }
    };
    return node;
  }));
}

// ---------------------------------------------------------------- style sets

async function loadStyles() {
  try { styles = (await api("/styles")).styles; } catch (error) { console.warn(error); }
  renderStyles();
}

function renderStyles() {
  const select = $("style-set");
  const selected = select.value;
  select.replaceChildren(new Option("Kayıtlı stil seti seç…", ""), ...styles.map((s) => new Option(s.name, s.id)));
  select.value = styles.some((s) => s.id === selected) ? selected : "";
  $("style-delete").classList.toggle("hidden", !select.value);
}

$("style-set").addEventListener("change", () => {
  const set = styles.find((s) => s.id === $("style-set").value);
  if (set) $("style").value = set.style;
  $("style-delete").classList.toggle("hidden", !set);
  updateCreate();
});

$("style-save").addEventListener("click", async () => {
  const style = $("style").value.trim();
  if (!style) { $("create-error").textContent = "Önce stil alanına bir şeyler yaz"; return; }
  const name = prompt("Stil setinin adı", style.split(",")[0].trim());
  if (!name || !name.trim()) return;
  try {
    const saved = await api("/styles", { method: "POST", body: JSON.stringify({ name: name.trim(), style }) });
    styles = [saved, ...styles];
    renderStyles();
    $("style-set").value = saved.id;
    $("style-delete").classList.remove("hidden");
  } catch (error) { report(error); }
});

$("style-delete").addEventListener("click", async () => {
  const set = styles.find((s) => s.id === $("style-set").value);
  if (!set || !confirm(`"${set.name}" stil seti silinsin mi?`)) return;
  try {
    await api(`/styles/${set.id}`, { method: "DELETE" });
    styles = styles.filter((s) => s.id !== set.id);
    renderStyles();
  } catch (error) { report(error); }
});

// ---------------------------------------------------------------- form

document.querySelectorAll(".chip.tag").forEach((button) => button.addEventListener("click", () => {
  const area = $("lyrics");
  const before = area.value.slice(0, area.selectionStart);
  const after = area.value.slice(area.selectionEnd);
  const prefix = before && !before.endsWith("\n\n") ? (before.endsWith("\n") ? "\n" : "\n\n") : "";
  const insert = `${prefix}${button.dataset.tag}\n`;
  area.value = before + insert + after;
  area.focus();
  area.selectionStart = area.selectionEnd = before.length + insert.length;
  updateCreate();
}));

["style", "lyrics", "title"].forEach((id) => $(id).addEventListener("input", updateCreate));
$("style").addEventListener("input", () => {
  const set = styles.find((s) => s.id === $("style-set").value);
  if (set && set.style !== $("style").value.trim()) { $("style-set").value = ""; $("style-delete").classList.add("hidden"); }
});

function updateCreate() {
  const ready = source && (source.id || source.key) && currentFolder() && $("style").value.trim() && $("lyrics").value.trim();
  $("create").disabled = !ready;
  const variants = Number($("variants").value);
  if (!gpu) { $("create-note").textContent = ""; return; }
  const state = gpu.gpu.state;
  const warm = state === "running" && ["ready", "busy"].includes(gpu.worker.state);
  $("create-note").textContent = warm
    ? `GPU açık · şarkı başına ~1–3 dk`
    : `GPU kapalı · açılış ~3 dk + üretim ~1–3 dk${variants === 2 ? " (2 varyasyon birlikte)" : ""}`;
}
$("variants").addEventListener("change", updateCreate);

$("create").addEventListener("click", async () => {
  $("create-error").textContent = "";
  $("create").disabled = true;
  try {
    const seed = $("seed").value === "" ? undefined : Number($("seed").value);
    const body = {
      folder_id: currentFolder().id, title: $("title").value.trim(),
      style: $("style").value.trim(), lyrics: $("lyrics").value.trim(),
      variants: Number($("variants").value), seed, stems: $("auto-stems").checked,
    };
    if (source.id) body.source_id = source.id;
    else { body.upload_key = source.key; body.source_name = source.name; }
    const result = await api("/jobs", { method: "POST", body: JSON.stringify(body) });
    jobs = [...result.jobs, ...jobs];
    view = { ...view, tab: "jobs" };
    try { localStorage.setItem("yue.view", JSON.stringify(view)); } catch (_) {}
    window.scrollTo({ top: 0 });
    render();
    refresh();
  } catch (error) {
    $("create-error").textContent = error.message;
  }
  updateCreate();
});

// ---------------------------------------------------------------- library

function hue(text) {
  let h = 0;
  for (const c of text || "") h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

function fmtDuration(seconds) {
  if (!seconds && seconds !== 0) return "";
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function fmtAgo(epochMs) {
  const diff = Date.now() / 1000 - epochMs / 1000;
  if (diff < 60) return "az önce";
  if (diff < 3600) return `${Math.floor(diff / 60)} dk önce`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} sa önce`;
  return new Date(epochMs).toLocaleDateString("tr-TR");
}

function visibleJobs() {
  if (view.type === "liked") return jobs.filter((j) => j.liked);
  if (view.id === UNFILED) return unfiledJobs();
  return jobs.filter((j) => j.folder_id === view.id);
}

function render() {
  // Fall back to a real folder when the remembered one is gone.
  if (view.type === "folder" && view.id !== UNFILED && !currentFolder()) {
    view = folders[0] ? { type: "folder", id: folders[0].id } : { type: "folder", id: null };
  }
  if (view.type === "folder" && view.id === UNFILED && !unfiledJobs().length && folders[0]) {
    view = { type: "folder", id: folders[0].id };
  }
  const folder = currentFolder();
  const tab = activeTab();
  const onboarding = !folders.length && !unfiledJobs().length && view.type !== "liked";
  $("no-folder").classList.toggle("hidden", !onboarding);
  document.querySelector(".library").classList.toggle("hidden", onboarding);
  const showCreate = !!folder && tab === "sources";
  $("create-panel").classList.toggle("hidden", !showCreate);
  document.querySelector(".layout").classList.toggle("single", !showCreate);
  $("shell").classList.toggle("no-side", view.type === "liked");
  document.querySelector(".sidebar").classList.toggle("hidden", view.type === "liked");
  $("create-folder-name").textContent = folder ? folder.name : "";
  $("view-title").textContent = view.type === "liked" ? "♥ Beğendiklerim" : folder ? folder.name : "Klasörsüz";
  $("subtabs").classList.toggle("hidden", !folder);
  document.querySelectorAll(".subtab").forEach((b) => {
    const on = b.dataset.tab === tab;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", String(on));
  });
  $("sources-block").classList.toggle("hidden", !(folder && tab === "sources"));
  $("jobs-block").classList.toggle("hidden", tab !== "jobs");
  $("jobs-head").classList.toggle("hidden", !!folder);
  $("jobs-title").textContent = view.type === "liked" ? "Beğenilen şarkılar" : "Klasörsüz üretimler";
  $("folder-menu").classList.toggle("hidden", !folder);
  $("empty-text").textContent = view.type === "liked"
    ? "Henüz beğendiğin şarkı yok. Bir üretimdeki ♡ ikonuna dokun."
    : folder ? "Bu klasörde henüz üretim yok. Kaynak şarkılar sekmesinden bir şarkı seçip cover oluştur." : "Burada üretim yok.";
  renderSidebar();
  renderSources();
  renderJobs();
  updateCreate();
}

function renderJobs() {
  const container = $("jobs");
  const list = visibleJobs();
  $("empty").classList.toggle("hidden", list.length > 0);
  $("lib-count").textContent = list.length ? `${list.length} kayıt` : "";
  $("jobs-count").textContent = view.type === "folder" && currentFolder() ? (list.length || "") : "";

  const existing = new Map([...container.children].map((node) => [node.dataset.id, node]));
  const fragment = document.createDocumentFragment();
  for (const job of list) {
    let node = existing.get(job.id);
    if (!node) node = $("job-tpl").content.firstElementChild.cloneNode(true);
    fillJob(node, job);
    fragment.appendChild(node);
  }
  container.replaceChildren(fragment);
  syncPlayIcons();
  updatePlayerBar();
}

function menuOpen(menu) { return !menu.classList.contains("hidden"); }

function closeMenus(except) {
  document.querySelectorAll(".menu").forEach((menu) => {
    if (menu === except) return;
    menu.classList.add("hidden");
    const button = menu.parentElement.querySelector(".menu-btn");
    if (button) button.setAttribute("aria-expanded", "false");
  });
}
document.addEventListener("click", () => closeMenus());
document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeMenus(); });

function menuItem(label, onClick, cls = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "menu-item " + cls;
  button.textContent = label;
  button.onclick = onClick;
  return button;
}

function menuLabel(text) {
  const label = document.createElement("div");
  label.className = "menu-label";
  label.textContent = text;
  return label;
}

function buildJobMenu(node, job, active) {
  const menu = node.querySelector(".job-menu");
  const button = node.querySelector(".job-menu-btn");
  button.onclick = (event) => {
    event.stopPropagation();
    closeMenus(menu);
    const open = menu.classList.toggle("hidden") === false;
    button.setAttribute("aria-expanded", String(open));
  };
  if (menuOpen(menu)) return;   // do not rebuild under the user's cursor
  const items = [];
  const downloads = [
    ["Şarkı · MP3", job.mp3_download], ["Şarkı · FLAC", job.flac_download],
    ["Altyapı · MP3", job.instrumental_mp3_download], ["Altyapı · FLAC", job.instrumental_download],
    ["Vokal · FLAC", job.vocals_download], ["Nota (ABC)", job.abc_download],
  ].filter(([, url]) => url);
  if (downloads.length) {
    items.push(menuLabel("İndir"));
    for (const [label, url] of downloads) {
      const link = document.createElement("a");
      link.className = "menu-item";
      link.href = url;
      link.rel = "noopener";
      link.textContent = "⬇ " + label;
      items.push(link);
    }
  }
  items.push(menuItem("↻ Tekrar kullan", () => reuse(job)));
  const targets = folders.filter((f) => f.id !== job.folder_id);
  if (targets.length) {
    items.push(menuLabel("Klasöre taşı"));
    for (const folder of targets) {
      items.push(menuItem(`📁 ${folder.name}`, async () => {
        try {
          const updated = await api(`/jobs/${job.id}`, { method: "PATCH", body: JSON.stringify({ folder_id: folder.id }) });
          jobs = jobs.map((j) => (j.id === job.id ? updated : j));
          render();
        } catch (error) { report(error); }
      }));
    }
  }
  const divider = document.createElement("div");
  divider.className = "menu-divider";
  items.push(divider);
  if (active) {
    items.push(menuItem("İptal et", async () => { await api(`/jobs/${job.id}/cancel`, { method: "POST" }); refresh(); }, "danger"));
  } else {
    items.push(menuItem("🗑 Sil", async () => {
      if (!confirm(`"${job.title}" silinsin mi?`)) return;
      try {
        await api(`/jobs/${job.id}`, { method: "DELETE" });
        jobs = jobs.filter((j) => j.id !== job.id);
        render();
      } catch (error) { report(error); }
    }, "danger"));
  }
  menu.replaceChildren(...items);
}

function fillNote(node, job) {
  const line = node.querySelector(".job-note");
  const area = node.querySelector(".note-editor");
  const editing = !area.classList.contains("hidden");
  if (editing) return;
  line.textContent = job.note || "+ Not ekle";
  line.classList.toggle("no-note", !job.note);
  const startEdit = () => {
    area.value = job.note || "";
    area.classList.remove("hidden");
    line.classList.add("hidden");
    area.focus();
  };
  line.onclick = startEdit;
  line.onkeydown = (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); startEdit(); } };
  line.classList.remove("hidden");
  const finish = async (save) => {
    if (area.classList.contains("hidden")) return;   // already finished (blur fires after we hide the field)
    const value = area.value.trim();
    area.classList.add("hidden");
    line.classList.remove("hidden");
    if (!save || value === (job.note || "")) return;
    try {
      const updated = await api(`/jobs/${job.id}`, { method: "PATCH", body: JSON.stringify({ note: value }) });
      jobs = jobs.map((j) => (j.id === job.id ? updated : j));
      render();
    } catch (error) { report(error); }
  };
  area.onkeydown = (event) => {
    if (event.key === "Escape") { event.stopPropagation(); finish(false); }
    else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { finish(true); }
  };
  area.onblur = () => finish(true);
}

function fillJob(node, job) {
  node.dataset.id = job.id;
  const h = hue(job.title + job.style);
  node.querySelector(".art").style.background = `linear-gradient(135deg, hsl(${h} 80% 60%), hsl(${(h + 60) % 360} 70% 45%))`;
  node.querySelector(".job-title").textContent = job.title + (job.variant > 1 ? ` · v${job.variant}` : "");
  node.querySelector(".job-style").textContent = job.style;
  node.querySelector(".job-style").title = job.style;
  const dur = node.querySelector(".dur");
  dur.textContent = job.duration ? fmtDuration(job.duration) : "";
  dur.classList.toggle("hidden", !job.duration);
  const badge = node.querySelector(".badge");
  badge.className = `badge ${job.status}`;
  badge.textContent = STATUS_TEXT[job.status] || job.status;
  badge.classList.toggle("hidden", job.status === "succeeded");   // "Hazır" is the normal state; the duration pill says enough

  const folder = folders.find((f) => f.id === job.folder_id);
  const folderLine = node.querySelector(".job-folder");
  folderLine.classList.toggle("hidden", view.type !== "liked");
  folderLine.textContent = `📁 ${folder ? folder.name : "Klasörsüz"}`;

  const like = node.querySelector(".like");
  like.textContent = job.liked ? "♥" : "♡";
  like.classList.toggle("on", !!job.liked);
  like.setAttribute("aria-pressed", String(!!job.liked));
  like.title = job.liked ? "Beğeniyi kaldır" : "Beğen";
  like.onclick = async () => {
    const liked = !job.liked;
    job.liked = liked;
    render();
    try {
      await api(`/jobs/${job.id}`, { method: "PATCH", body: JSON.stringify({ liked }) });
    } catch (error) {
      job.liked = !liked;
      render();
      report(error);
    }
  };

  const active = job.status === "queued" || job.status === "running";
  node.querySelector(".job-progress").classList.toggle("hidden", !active);
  if (active) {
    const started = job.started_at || job.created_at / 1000;
    const elapsed = Math.max(0, Math.floor(Date.now() / 1000 - started));
    let stage = job.message || job.stage || "";
    if (job.status === "queued" && gpu && gpu.worker && gpu.worker.message && gpu.gpu.state !== "stopped") {
      stage = `Sırada · ${gpu.worker.message}`;
    }
    node.querySelector(".stage").textContent = `${stage} · geçen süre ${fmtDuration(elapsed)}`;
  }

  const playButton = node.querySelector(".art-play");
  playButton.classList.toggle("hidden", !job.mp3_url);
  node.querySelector(".art-note").classList.toggle("hidden", !!job.mp3_url);
  playButton.onclick = () => playJob(job);

  fillStems(node, job);
  fillNote(node, job);
  node.querySelector(".lyrics-btn").onclick = () => openLyrics(job);

  const error = node.querySelector(".job-error");
  error.classList.toggle("hidden", !job.error);
  error.textContent = job.error || "";
  node.querySelector(".meta").textContent = fmtAgo(job.created_at);
  node.querySelector(".rename").onclick = async () => {
    const title = prompt("Şarkı adı", job.title);
    if (!title || !title.trim() || title.trim() === job.title) return;
    try {
      const updated = await api(`/jobs/${job.id}`, { method: "PATCH", body: JSON.stringify({ title: title.trim() }) });
      jobs = jobs.map((j) => (j.id === job.id ? updated : j));
      render();
    } catch (error) { report(error); }
  };
  buildJobMenu(node, job, active);
}

function fillStems(node, job) {
  const state = job.stems_status;
  const working = state === "queued" || state === "running";
  node.querySelector(".stems-state").classList.toggle("hidden", !working);
  node.querySelector(".stems-progress").classList.toggle("hidden", !working);
  let status = working ? "Altyapı ve vokal ayrılıyor" : "";
  if (state === "queued" && gpu && gpu.gpu.state !== "running") status = "Altyapı ve vokal için sırada · GPU açılıyor";
  node.querySelector(".stems-status").textContent = status;

  // New covers are split automatically; the button is only a retry (or for covers made before that).
  const button = node.querySelector(".stems-btn");
  const canRequest = job.status === "succeeded" && (!state || state === "failed");
  button.classList.toggle("hidden", !canRequest);
  button.textContent = state === "failed" ? "🎙 Tekrar dene" : "🎙 Altyapı ve vokal ayır";
  button.onclick = async () => {
    button.disabled = true;
    try {
      const result = await api(`/jobs/${job.id}/stems`, { method: "POST" });
      jobs = jobs.map((j) => (j.id === job.id ? result.job : j));
      render();
      refresh();
    } catch (error) { report(error); }
    button.disabled = false;
  };
  const error = node.querySelector(".stems-error");
  error.classList.toggle("hidden", state !== "failed");
  error.textContent = state === "failed" ? `Vokal ayırma başarısız: ${job.stems_error || "bilinmeyen hata"}` : "";
}

// ---------------------------------------------------------------- lyrics modal

function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  return new Promise((resolve, reject) => {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    ok ? resolve() : reject(new Error("kopyalanamadı"));
  });
}

let lyricsJob = null;
function openLyrics(job) {
  lyricsJob = job;
  $("lyrics-title").textContent = job.title;
  $("lyrics-text").textContent = job.lyrics || "(şarkı sözü yok)";
  $("lyrics-note").textContent = "";
  $("lyrics-modal").showModal();
}
async function copyFromModal(text, label) {
  try { await copyText(text); $("lyrics-note").textContent = `${label} kopyalandı ✓`; }
  catch (error) { $("lyrics-note").textContent = "Kopyalanamadı: metni seçip Ctrl/Cmd+C ile kopyala"; }
}
$("lyrics-copy").addEventListener("click", () => lyricsJob && copyFromModal(lyricsJob.lyrics || "", "Sözler"));
$("lyrics-copy-style").addEventListener("click", () => lyricsJob && copyFromModal(lyricsJob.style || "", "Stil"));
$("lyrics-close").addEventListener("click", () => $("lyrics-modal").close());
$("lyrics-modal").addEventListener("click", (event) => { if (event.target === $("lyrics-modal")) $("lyrics-modal").close(); });

// ---------------------------------------------------------------- player bar
// One player for the whole page. Covers with stems play instrumental + vocals in sync,
// and each stem can be switched off with its own toggle.

const pb = { main: new Audio(), vocals: new Audio(), id: null, stems: false, inst: true, voc: true, muted: false, seeking: false };
pb.main.preload = "auto";
pb.vocals.preload = "auto";

function applyMix() {
  const volume = Number($("pb-vol").value);
  pb.main.volume = volume;
  pb.vocals.volume = volume;
  pb.main.muted = pb.muted || (pb.stems && !pb.inst);
  pb.vocals.muted = pb.muted || !pb.voc;
  $("pb-mute").textContent = pb.muted || volume === 0 ? "🔇" : "🔊";
  for (const [cls, on] of [[".toggle.inst", pb.inst], [".toggle.voc", pb.voc]]) {
    const button = $("pb-mix").querySelector(cls);
    button.classList.toggle("on", on);
    button.setAttribute("aria-pressed", String(on));
  }
}

function startPlayback() {
  pb.main.play().catch((error) => report(error));
  if (pb.stems) { pb.vocals.currentTime = pb.main.currentTime; pb.vocals.play().catch(() => {}); }
}

function togglePlayback() {
  if (!pb.id) return;
  if (pb.main.paused) startPlayback(); else { pb.main.pause(); pb.vocals.pause(); }
}

function playJob(job) {
  if (pb.id === job.id) { togglePlayback(); return; }
  const stems = job.stems_status === "succeeded" && !!job.instrumental_url && !!job.vocals_url;
  pb.main.pause();
  pb.vocals.pause();
  pb.id = job.id;
  pb.stems = stems;
  pb.inst = true;
  pb.voc = true;
  pb.main.src = stems ? job.instrumental_url : job.mp3_url;
  if (stems) pb.vocals.src = job.vocals_url; else pb.vocals.removeAttribute("src");
  pb.main.currentTime = 0;
  $("pb-mix").classList.toggle("hidden", !stems);
  $("pb-range").value = 0;
  $("pb-cur").textContent = "0:00";
  $("pb-dur").textContent = job.duration ? fmtDuration(job.duration) : "0:00";
  $("playerbar").classList.remove("hidden");
  document.body.classList.add("has-player");
  applyMix();
  updatePlayerBar();
  startPlayback();
}

function closePlayer() {
  pb.main.pause();
  pb.vocals.pause();
  pb.main.removeAttribute("src");
  pb.vocals.removeAttribute("src");
  pb.id = null;
  $("playerbar").classList.add("hidden");
  document.body.classList.remove("has-player");
  syncPlayIcons();
}

function updatePlayerBar() {
  if (!pb.id) return;
  const job = jobs.find((j) => j.id === pb.id);
  if (!job) { closePlayer(); return; }
  const h = hue(job.title + job.style);
  $("pb-art").style.background = `linear-gradient(135deg, hsl(${h} 80% 60%), hsl(${(h + 60) % 360} 70% 45%))`;
  $("pb-title").textContent = job.title + (job.variant > 1 ? ` · v${job.variant}` : "");
  $("pb-sub").textContent = pb.stems ? "Altyapı + vokal" : "Şarkı";
}

function syncPlayIcons() {
  const playing = !!pb.id && !pb.main.paused;
  $("pb-play").textContent = playing ? "⏸" : "▶";
  document.querySelectorAll(".job").forEach((node) => {
    const button = node.querySelector(".art-play");
    const on = playing && node.dataset.id === pb.id;
    button.textContent = on ? "⏸" : "▶";
    node.classList.toggle("now-playing", !!pb.id && node.dataset.id === pb.id);
  });
}

$("pb-play").addEventListener("click", togglePlayback);
$("pb-close").addEventListener("click", closePlayer);
$("pb-vol").addEventListener("input", applyMix);
$("pb-mute").addEventListener("click", () => { pb.muted = !pb.muted; applyMix(); });
$("pb-mix").querySelector(".toggle.inst").addEventListener("click", () => { pb.inst = !pb.inst; applyMix(); });
$("pb-mix").querySelector(".toggle.voc").addEventListener("click", () => { pb.voc = !pb.voc; applyMix(); });
$("pb-range").addEventListener("pointerdown", () => { pb.seeking = true; });
$("pb-range").addEventListener("pointerup", () => { pb.seeking = false; });
$("pb-range").addEventListener("input", () => {
  const total = pb.main.duration;
  if (!Number.isFinite(total)) return;
  pb.main.currentTime = (Number($("pb-range").value) / 1000) * total;
  $("pb-cur").textContent = fmtDuration(pb.main.currentTime);
  if (pb.stems) pb.vocals.currentTime = pb.main.currentTime;
});
for (const type of ["play", "pause", "ended"]) pb.main.addEventListener(type, syncPlayIcons);
pb.main.addEventListener("ended", () => { pb.vocals.pause(); });
pb.main.addEventListener("waiting", () => { if (pb.stems) pb.vocals.pause(); });
pb.main.addEventListener("playing", () => { if (pb.stems && pb.vocals.paused) { pb.vocals.currentTime = pb.main.currentTime; pb.vocals.play().catch(() => {}); } });
pb.main.addEventListener("loadedmetadata", () => { if (Number.isFinite(pb.main.duration)) $("pb-dur").textContent = fmtDuration(pb.main.duration); });
pb.main.addEventListener("timeupdate", () => {
  const total = pb.main.duration;
  if (!pb.seeking && Number.isFinite(total) && total > 0) {
    $("pb-range").value = Math.round((pb.main.currentTime / total) * 1000);
    $("pb-cur").textContent = fmtDuration(pb.main.currentTime);
  }
  if (pb.stems && !pb.main.paused && Math.abs(pb.vocals.currentTime - pb.main.currentTime) > 0.25) {
    pb.vocals.currentTime = pb.main.currentTime;
  }
});

function reuse(job) {
  if (job.folder_id && folders.some((f) => f.id === job.folder_id)) {
    setView({ type: "folder", id: job.folder_id, tab: "sources" });
  }
  if (!currentFolder()) {
    $("create-error").textContent = "Tekrar kullanmak için şarkıyı önce bir klasöre taşı";
    return;
  }
  const saved = job.source_id && sources.find((s) => s.id === job.source_id);
  if (saved) {
    selectSource(saved);
  } else if (job.source_url && job.upload_key) {
    // Older jobs point at a temporary upload (kept 30 days).
    source = { key: job.upload_key, name: job.source_name || "kaynak", url: job.source_url };
    showSource(source.name, source.url, true);
  }
  // The job's own style and lyrics win over what the source remembers.
  $("title").value = job.title;
  $("style").value = job.style;
  $("lyrics").value = job.lyrics;
  updateCreate();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ---------------------------------------------------------------- status

function renderGpu() {
  const pill = $("gpu-pill");
  const state = gpu.gpu.state;
  const worker = gpu.worker || {};
  let cls = "", text;
  if (state === "stopped") { text = "GPU kapalı · $0/sa"; }
  else if (state === "stopping") { cls = "warm"; text = "GPU kapanıyor"; }
  else if (state === "pending") { cls = "warm"; text = "GPU açılıyor"; }
  else if (state === "running") {
    const rate = GPU_HOURLY_USD[gpu.gpu.type];
    const cost = rate ? ` · ~$${rate.toFixed(2)}/sa` : "";
    if (worker.state === "busy") { cls = "busy"; text = `Üretiyor${cost}`; }
    else if (worker.state === "ready") {
      cls = "on";
      const idle = Math.max(0, gpu.now - (worker.last_activity_at || gpu.now));
      const left = Math.max(0, gpu.idle_minutes * 60 - idle);
      text = `Hazır · ${Math.ceil(left / 60)} dk sonra kapanır${cost}`;
    } else if (worker.state === "error") { cls = "bad"; text = "Worker hatası"; }
    else { cls = "warm"; text = worker.message || "Hazırlanıyor"; }
  } else { text = state; }
  if (worker.state === "no_capacity") { cls = "bad"; text = "GPU kapasitesi yok, tekrar deneniyor"; }
  if (worker.state === "error" && state !== "running") { cls = "bad"; text = "Sunucu hata verdi · yeni işte tekrar denenir"; }
  pill.className = `pill ${cls}`;
  $("gpu-text").textContent = text;
  pill.title = [worker.message, gpu.gpu.type].filter(Boolean).join(" · ");
  $("gpu-stop").classList.toggle("hidden", !["running", "pending"].includes(state));
}

$("gpu-stop").addEventListener("click", async () => {
  if (jobs.some((j) => j.status === "running") && !confirm("Devam eden işler iptal olabilir. GPU kapatılsın mı?")) return;
  await api("/gpu/stop", { method: "POST" });
  refresh();
});

async function refresh() {
  clearTimeout(pollTimer);
  try {
    const [status, library] = await Promise.all([api("/status"), api("/library")]);
    gpu = status;
    folders = library.folders;
    sources = library.sources;
    jobs = library.jobs;
    renderGpu();
    render();
  } catch (error) {
    console.warn(error);
    if (!passcode) return;
  }
  const busy = jobs.some((j) => ["queued", "running"].includes(j.status) || ["queued", "running"].includes(j.stems_status))
    || (gpu && gpu.gpu.state !== "stopped");
  pollTimer = setTimeout(refresh, busy ? 4000 : 20000);
}

document.addEventListener("visibilitychange", () => { if (!document.hidden && passcode) refresh(); });

if (passcode) start(); else showLogin();
