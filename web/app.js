"use strict";

const $ = (id) => document.getElementById(id);
const API = "/api";
const STYLE_PRESETS = [
  "Turkish", "English", "pop", "rock", "synthwave", "lo-fi hip hop", "R&B", "jazz", "acoustic ballad",
  "EDM", "Anatolian rock", "arabesque", "trap", "orchestral", "female vocal", "male vocal",
  "breathy vocal", "powerful vocal", "piano", "acoustic guitar", "electric guitar", "808 bass",
  "strings", "90 BPM", "120 BPM", "melancholic", "uplifting", "dreamy",
];
const STATUS_TEXT = { queued: "Sırada", running: "Üretiliyor", succeeded: "Hazır", failed: "Hata", cancelled: "İptal" };
const GPU_HOURLY_USD = { "g6.2xlarge": 1.2, "g5.2xlarge": 1.46, "g6e.xlarge": 2.24 };

let passcode = null;
let upload = null;          // {key, name}
let jobs = [];
let gpu = null;
let pollTimer = null;

try { passcode = localStorage.getItem("yue.passcode"); } catch (_) { /* private mode */ }

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
  refresh();
}

// ---------------------------------------------------------------- upload

const drop = $("drop");
["dragenter", "dragover"].forEach((type) => drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((type) => drop.addEventListener(type, () => drop.classList.remove("over")));
drop.addEventListener("drop", (event) => {
  event.preventDefault();
  if (event.dataTransfer.files[0]) handleFile(event.dataTransfer.files[0]);
});
$("file").addEventListener("change", (event) => event.target.files[0] && handleFile(event.target.files[0]));
$("file-clear").addEventListener("click", () => {
  upload = null;
  $("file").value = "";
  $("drop-file").classList.add("hidden");
  $("drop-empty").classList.remove("hidden");
  drop.classList.remove("has-file");
  updateCreate();
});

async function handleFile(file) {
  $("create-error").textContent = "";
  if (file.size > 40 * 1024 * 1024) { $("create-error").textContent = "Dosya en fazla 40 MB olabilir"; return; }
  upload = null;
  drop.classList.add("has-file");
  $("drop-empty").classList.add("hidden");
  $("drop-file").classList.remove("hidden");
  $("file-name").textContent = file.name;
  $("file-preview").src = URL.createObjectURL(file);
  $("upload-bar").style.width = "0";
  if (!$("title").value) $("title").value = file.name.replace(/\.[^.]+$/, "") + " (cover)";
  updateCreate();
  try {
    const contentType = file.type || "application/octet-stream";
    const signed = await api("/uploads", {
      method: "POST", body: JSON.stringify({ filename: file.name, size: file.size, content_type: contentType }),
    });
    await putWithProgress(signed.url, file, signed.content_type, (fraction) => {
      $("upload-bar").style.width = `${Math.round(fraction * 100)}%`;
    });
    upload = { key: signed.key, name: file.name };
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

// ---------------------------------------------------------------- form

STYLE_PRESETS.forEach((preset) => {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "chip";
  chip.textContent = "+ " + preset;
  chip.addEventListener("click", () => {
    const current = $("style").value.trim().replace(/,\s*$/, "");
    $("style").value = current ? `${current}, ${preset}` : preset;
    updateCreate();
  });
  $("style-chips").appendChild(chip);
});

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

function updateCreate() {
  const ready = upload && $("style").value.trim() && $("lyrics").value.trim();
  $("create").disabled = !ready;
  const variants = Number($("variants").value);
  if (!gpu) { $("create-note").textContent = ""; return; }
  const state = gpu.gpu.state;
  const warm = state === "running" && ["ready", "busy"].includes(gpu.worker.state);
  $("create-note").textContent = warm
    ? `GPU açık · şarkı başına ~3–5 dk`
    : `GPU kapalı · açılış ~3 dk + üretim ~3–5 dk${variants === 2 ? " (2 varyasyon birlikte)" : ""}`;
}
$("variants").addEventListener("change", updateCreate);

$("create").addEventListener("click", async () => {
  $("create-error").textContent = "";
  $("create").disabled = true;
  try {
    const seed = $("seed").value === "" ? undefined : Number($("seed").value);
    const result = await api("/jobs", {
      method: "POST",
      body: JSON.stringify({
        upload_key: upload.key, source_name: upload.name, title: $("title").value.trim(),
        style: $("style").value.trim(), lyrics: $("lyrics").value.trim(),
        variants: Number($("variants").value), seed,
      }),
    });
    jobs = [...result.jobs, ...jobs];
    renderJobs();
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

function renderJobs() {
  const container = $("jobs");
  const playing = new Map();
  container.querySelectorAll("audio").forEach((a) => { if (!a.paused) playing.set(a.dataset.id, a); });
  $("empty").classList.toggle("hidden", jobs.length > 0);
  $("lib-count").textContent = jobs.length ? `${jobs.length} kayıt` : "";

  const existing = new Map([...container.children].map((node) => [node.dataset.id, node]));
  const fragment = document.createDocumentFragment();
  for (const job of jobs) {
    let node = existing.get(job.id);
    if (!node) node = $("job-tpl").content.firstElementChild.cloneNode(true);
    fillJob(node, job, playing.has(job.id));
    fragment.appendChild(node);
  }
  container.replaceChildren(fragment);
}

function fillJob(node, job, isPlaying) {
  node.dataset.id = job.id;
  const h = hue(job.title + job.style);
  node.querySelector(".art").style.background = `linear-gradient(135deg, hsl(${h} 80% 60%), hsl(${(h + 60) % 360} 70% 45%))`;
  node.querySelector(".job-title").textContent = job.title + (job.variant > 1 ? ` · v${job.variant}` : "");
  node.querySelector(".job-style").textContent = job.style;
  node.querySelector(".job-style").title = job.style;
  const badge = node.querySelector(".badge");
  badge.className = `badge ${job.status}`;
  badge.textContent = STATUS_TEXT[job.status] || job.status;

  const active = job.status === "queued" || job.status === "running";
  node.querySelector(".job-progress").classList.toggle("hidden", !active);
  if (active) {
    const started = job.started_at || job.created_at / 1000;
    const elapsed = Math.max(0, Math.floor(Date.now() / 1000 - started));
    let stage = job.message || job.stage || "";
    if (job.status === "queued" && gpu && gpu.worker && gpu.worker.message && gpu.gpu.state !== "stopped") {
      stage = `Sırada · ${gpu.worker.message}`;
    }
    node.querySelector(".stage").textContent = `${stage} · ${fmtDuration(elapsed)}`;
  }

  const player = node.querySelector(".player");
  if (job.mp3_url) {
    player.classList.remove("hidden");
    player.dataset.id = job.id;
    if (!isPlaying && player.dataset.src !== job.id) { player.src = job.mp3_url; player.dataset.src = job.id; }
  } else {
    player.classList.add("hidden");
  }
  for (const [cls, key] of [["dl-mp3", "mp3_download"], ["dl-flac", "flac_download"], ["dl-abc", "abc_download"]]) {
    const link = node.querySelector("." + cls);
    link.classList.toggle("hidden", !job[key]);
    if (job[key]) link.href = job[key];
  }
  const error = node.querySelector(".job-error");
  error.classList.toggle("hidden", !job.error);
  error.textContent = job.error || "";
  node.querySelector(".cancel").classList.toggle("hidden", !active);
  node.querySelector(".delete").classList.toggle("hidden", active);
  const meta = [];
  if (job.duration) meta.push(fmtDuration(job.duration));
  meta.push(fmtAgo(job.created_at));
  node.querySelector(".meta").textContent = meta.join(" · ");

  node.querySelector(".reuse").onclick = () => reuse(job);
  node.querySelector(".cancel").onclick = async () => { await api(`/jobs/${job.id}/cancel`, { method: "POST" }); refresh(); };
  node.querySelector(".delete").onclick = async () => {
    if (!confirm(`"${job.title}" silinsin mi?`)) return;
    await api(`/jobs/${job.id}`, { method: "DELETE" });
    jobs = jobs.filter((j) => j.id !== job.id);
    renderJobs();
  };
}

function reuse(job) {
  $("title").value = job.title;
  $("style").value = job.style;
  $("lyrics").value = job.lyrics;
  if (job.source_url && job.upload_key) {
    // Same uploaded source can be reused while it is kept (30 days).
    upload = { key: job.upload_key, name: job.source_name || "kaynak" };
    drop.classList.add("has-file");
    $("drop-empty").classList.add("hidden");
    $("drop-file").classList.remove("hidden");
    $("file-name").textContent = upload.name;
    $("file-preview").src = job.source_url;
    $("upload-bar").style.width = "100%";
  }
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
    const [status, list] = await Promise.all([api("/status"), api("/jobs")]);
    gpu = status;
    jobs = list.jobs;
    renderGpu();
    renderJobs();
    updateCreate();
  } catch (error) {
    console.warn(error);
    if (!passcode) return;
  }
  const busy = jobs.some((j) => j.status === "queued" || j.status === "running")
    || (gpu && gpu.gpu.state !== "stopped");
  pollTimer = setTimeout(refresh, busy ? 4000 : 20000);
}

document.addEventListener("visibilitychange", () => { if (!document.hidden && passcode) refresh(); });

if (passcode) start(); else showLogin();
