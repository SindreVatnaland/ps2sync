// ps2sync UI glue: poll the API, render the jobs table, stream uploads with
// progress, wire the delete action, catalogue search, and library filter/sort.
// Vanilla, no dependencies.
"use strict";

// --- tiny utils --------------------------------------------------------------

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c];
  });
}

function fmtBytes(n) {
  if (n == null) return "—";
  var u = ["B", "KB", "MB", "GB", "TB"];
  var x = n,
    i = 0;
  while (x >= 1024 && i < u.length - 1) {
    x /= 1024;
    i++;
  }
  return x.toFixed(i > 0 && x < 10 ? 1 : 0) + " " + u[i];
}

async function getJSON(url) {
  var r = await fetch(url, { headers: { accept: "application/json" } });
  return r.json();
}

function consoleLabel(c) {
  return c === "ps1" ? "PS1" : c === "ps2" ? "PS2" : "—";
}

// Box art straight from libretro's public thumbnail CDN — no server, no scraping,
// just an <img> the browser loads. Thumbnails are keyed by No-Intro name, which our
// catalogue titles nearly match (they already use " - " for subtitles); the region
// tag is derived from the serial prefix. Returns candidate URLs tried in order via
// the <img> onerror chain; a full miss just hides the image.
function coverCandidates(g) {
  var sys = g.console === "ps1" ? "Sony - PlayStation" : "Sony - PlayStation 2";
  var base =
    "https://thumbnails.libretro.com/" +
    encodeURIComponent(sys) +
    "/Named_Boxarts/";
  var pre = String(g.serial || "")
    .split("-")[0]
    .toUpperCase();
  var region = /^(SLES|SCES|SLED|SCED|SLEH)/.test(pre)
    ? "Europe"
    : /^(SLPS|SLPM|SCPS|SCAJ|SLKA|SCKA|PCPX|SLAJ)/.test(pre)
      ? "Japan"
      : "USA";
  var regions = [region, "USA", "Europe", "Japan"].filter(function (r, i, a) {
    return a.indexOf(r) === i;
  });
  var names = [];
  regions.forEach(function (r) {
    names.push(g.title + " (" + r + ")");
    if (g.console === "ps1") names.push(g.title + " (" + r + ") (Disc 1)");
  });
  return names.slice(0, 6).map(function (n) {
    return base + encodeURIComponent(n) + ".png";
  });
}

// Cover thumbnails, cached so the 2s jobs refresh doesn't reload/flicker them.
// coverCache["console|serial"] = resolved URL, "" = looked up (none), undefined = unknown.
var coverCache = {};
function coverKey(con, serial) {
  return con + "|" + serial;
}

// The cover cell HTML for a row. When the cover is already known we emit the resolved
// <img src> (or a fixed-size empty box) directly — no data-cover, so hydrateCovers
// skips it and it loads from the browser cache with no shift. Unknown ones get a
// data-cover <img> for hydrateCovers to resolve once.
function coverCell(con, serial, title) {
  if (!con || !serial) return '<span class="cover-sm cover-none"></span>';
  var c = coverCache[coverKey(con, serial)];
  if (c === "") return '<span class="cover-sm cover-none"></span>';
  if (c) return '<img class="cover-sm" src="' + esc(c) + '" alt="">';
  return (
    '<img class="cover-sm" data-cover data-console="' +
    esc(con) +
    '" data-serial="' +
    esc(serial) +
    '" data-title="' +
    esc(title || "") +
    '" alt="">'
  );
}

// Resolve any not-yet-hydrated data-cover images by walking the libretro candidates.
// Records the outcome in coverCache; on a full miss swaps in a fixed-size empty box
// so the row height never changes.
function hydrateCovers() {
  var imgs = document.querySelectorAll("img[data-cover]:not([data-hydrated])");
  for (var k = 0; k < imgs.length; k++) {
    (function (img) {
      img.setAttribute("data-hydrated", "1");
      var con = img.getAttribute("data-console");
      var serial = img.getAttribute("data-serial");
      var title = img.getAttribute("data-title");
      if (!serial || !title) return void markNone(img, con, serial);
      var key = coverKey(con, serial);
      var srcs = coverCandidates({ console: con, serial: serial, title: title });
      var i = 0;
      img.onload = function () {
        coverCache[key] = img.getAttribute("src");
      };
      img.onerror = function () {
        i++;
        if (i < srcs.length) img.src = srcs[i];
        else markNone(img, con, serial);
      };
      img.src = srcs[0];
    })(imgs[k]);
  }
}

function markNone(img, con, serial) {
  if (con && serial) coverCache[coverKey(con, serial)] = "";
  var span = document.createElement("span");
  span.className = "cover-sm cover-none";
  if (img.parentNode) img.parentNode.replaceChild(span, img);
}

// Setup guide: the server's LAN IP field. Loads the saved value (or auto-fills from
// the browser's address when the UI was opened via the LAN IP), writes it into the
// SMB address shown in step 4, and saves on click.
function wireGuideIp() {
  var input = document.getElementById("lan-ip");
  if (!input) return; // not on the guide page
  var save = document.getElementById("lan-ip-save");
  var msg = document.getElementById("lan-ip-msg");
  var isIpv4 = /^(\d{1,3}\.){3}\d{1,3}$/;
  function apply(ip) {
    var spots = document.querySelectorAll(".smb-ip");
    for (var i = 0; i < spots.length; i++)
      spots[i].textContent = ip || "192.168.1.10";
  }
  getJSON("/api/settings")
    .then(function (s) {
      var ip =
        s.serverLanIp ||
        (isIpv4.test(location.hostname) ? location.hostname : "");
      input.value = ip;
      apply(ip);
    })
    .catch(function () {});
  save.addEventListener("click", async function () {
    save.disabled = true;
    msg.textContent = "Saving…";
    try {
      var r = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ serverLanIp: input.value.trim() }),
      });
      var body = await r.json();
      save.disabled = false;
      if (!r.ok) {
        msg.textContent = body.error || "Save failed";
        return;
      }
      input.value = body.serverLanIp || "";
      apply(input.value);
      msg.textContent = "Saved.";
    } catch (e) {
      save.disabled = false;
      msg.textContent = "Save failed.";
    }
  });
}

// --- jobs table (home page) --------------------------------------------------

var STATE_BADGE = {
  ready: "ok",
  failed: "fail",
  duplicate: "dup",
  pending: "pending",
  downloading: "busy",
  identifying: "busy",
  converting: "busy",
  placing: "busy",
};

var ACTIVE_STATE = {
  downloading: 1,
  identifying: 1,
  converting: 1,
  placing: 1,
};

function jobRow(j) {
  // Only show a progress bar while the job is actively working.
  var prog;
  if (ACTIVE_STATE[j.state] && j.progress != null) {
    var pct = Math.round(j.progress * 100);
    prog =
      '<div class="progress"><div class="progress-fill" style="width:' +
      pct +
      '%"></div></div>';
  } else {
    prog = j.state === "ready" ? "done" : "—";
  }
  var badge =
    '<span class="badge ' +
    (STATE_BADGE[j.state] || "pending") +
    '">' +
    esc(j.state) +
    "</span>";
  var info = j.error
    ? '<span style="color:var(--danger)">' + esc(j.error) + "</span>"
    : "";
  var con = j.console ? consoleLabel(j.console) : "—";
  var ser = j.serial ? "<code>" + esc(j.serial) + "</code>" : "—";
  // Terminal jobs (ready/failed/duplicate) can be cleared from the list.
  var actions = !ACTIVE_STATE[j.state]
    ? '<button class="btn small danger" data-action="del-job" data-id="' +
      esc(j.id) +
      '">Delete</button>'
    : "";
  return (
    "<tr><td>" +
    coverCell(j.console, j.serial, j.title) +
    "</td><td>" +
    esc(j.source || "—") +
    "</td><td>" +
    esc(j.kind) +
    "</td><td>" +
    con +
    "</td><td>" +
    ser +
    "</td><td>" +
    badge +
    "</td><td>" +
    prog +
    "</td><td>" +
    info +
    "</td><td>" +
    actions +
    "</td></tr>"
  );
}

var jobsPage = 0;
var JOBS_PER_PAGE = 5;

async function refreshJobs() {
  var tbody = document.getElementById("jobs-tbody");
  if (!tbody) return;
  try {
    var rows = await getJSON("/api/jobs");
    var pages = Math.max(1, Math.ceil(rows.length / JOBS_PER_PAGE));
    if (jobsPage > pages - 1) jobsPage = pages - 1; // clamp after deletes
    if (jobsPage < 0) jobsPage = 0;
    var start = jobsPage * JOBS_PER_PAGE;
    tbody.innerHTML = rows.length
      ? rows.slice(start, start + JOBS_PER_PAGE).map(jobRow).join("")
      : '<tr><td colspan="9" class="muted">No jobs yet. <a href="/add">Add a game.</a></td></tr>';
    renderJobsPager(rows.length, pages);
    hydrateCovers();
  } catch (e) {
    /* transient */
  }
}

function renderJobsPager(total, pages) {
  var el = document.getElementById("jobs-pager");
  if (!el) return;
  if (total <= JOBS_PER_PAGE) {
    el.innerHTML = "";
    return;
  }
  var start = jobsPage * JOBS_PER_PAGE + 1;
  var end = Math.min(total, (jobsPage + 1) * JOBS_PER_PAGE);
  el.innerHTML =
    '<button class="btn small" data-action="jobs-prev"' +
    (jobsPage <= 0 ? " disabled" : "") +
    ">← Prev</button>" +
    '<span class="muted small">' +
    start +
    "–" +
    end +
    " of " +
    total +
    "</span>" +
    '<button class="btn small" data-action="jobs-next"' +
    (jobsPage >= pages - 1 ? " disabled" : "") +
    ">Next →</button>";
}

// --- upload (Add page): XHR for real progress --------------------------------

function wireUpload() {
  var dz = document.getElementById("dropzone");
  if (!dz) return;
  var input = document.getElementById("file-input");
  var targetSel = document.getElementById("target-select");
  var status = document.getElementById("upload-status");
  var queueBox = document.getElementById("upload-queue");
  var text = document.getElementById("upload-text");

  // Upload queue with a visible list + per-file cancel. Files upload one at a time
  // (each POST = one job). Cancel a queued file to drop it, or the active one to abort
  // its in-flight upload.
  var queue = []; // pending: {id, file}
  var current = null; // {id, file} uploading now
  var currentXhr = null;
  var running = false;
  var seq = 0;
  var doneCount = 0;
  var failed = [];

  function itemRow(id, name, active) {
    var mid = active
      ? '<div class="progress" style="flex:1;min-width:70px"><div class="progress-fill" id="uq-bar-' +
        id +
        '"></div></div>'
      : '<span class="muted small">Queued</span>';
    return (
      '<div class="uq-item" style="display:flex;align-items:center;gap:.5rem;margin:.3rem 0">' +
      '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
      esc(name) +
      "</span>" +
      mid +
      '<button class="btn small danger" data-cancel="' +
      id +
      '" title="Cancel">✕</button></div>'
    );
  }

  function renderQueue() {
    if (!queueBox) return;
    var rows = [];
    if (current) rows.push(itemRow(current.id, current.file.name, true));
    for (var i = 0; i < queue.length; i++)
      rows.push(itemRow(queue[i].id, queue[i].file.name, false));
    queueBox.innerHTML = rows.join("");
  }

  function drain() {
    if (queue.length === 0) {
      running = false;
      current = null;
      currentXhr = null;
      renderQueue();
      text.innerHTML =
        doneCount || failed.length
          ? (failed.length
              ? doneCount + " uploaded, " + failed.length + " failed."
              : "All " +
                doneCount +
                " upload" +
                (doneCount === 1 ? "" : "s") +
                " complete.") +
            ' Jobs started — see the <a href="/">Library</a>.'
          : "";
      return;
    }
    running = true;
    current = queue.shift();
    renderQueue();
    text.textContent = "";
    var file = current.file;
    var fd = new FormData();
    fd.append("target", targetSel ? targetSel.value : "");
    fd.append("file", file);
    status.classList.remove("hidden");
    var xhr = new XMLHttpRequest();
    currentXhr = xhr;
    xhr.open("POST", "/upload");
    xhr.upload.onprogress = function (e) {
      if (!e.lengthComputable || !current) return;
      var b = document.getElementById("uq-bar-" + current.id);
      if (b) b.style.width = Math.round((e.loaded / e.total) * 100) + "%";
    };
    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 400) doneCount++;
      else failed.push(file.name);
      current = null;
      currentXhr = null;
      if (typeof refreshJobs === "function") refreshJobs(); // show the new job at once
      drain();
    };
    xhr.onerror = function () {
      failed.push(file.name);
      current = null;
      currentXhr = null;
      drain();
    };
    xhr.onabort = function () {
      // user cancelled this one — drop it silently and move on
      current = null;
      currentXhr = null;
      drain();
    };
    xhr.send(fd);
  }

  // Queue one or more files. Adding files mid-batch extends the running queue.
  function enqueue(list) {
    if (!list || !list.length) return;
    for (var i = 0; i < list.length; i++) queue.push({ id: ++seq, file: list[i] });
    status.classList.remove("hidden");
    text.textContent = "";
    renderQueue();
    if (!running) {
      doneCount = 0;
      failed = [];
      drain();
    }
  }

  // Cancel: abort the active upload, or drop a still-queued file.
  if (queueBox)
    queueBox.addEventListener("click", function (e) {
      var btn = e.target.closest ? e.target.closest("[data-cancel]") : null;
      if (!btn) return;
      var id = Number(btn.getAttribute("data-cancel"));
      if (current && current.id === id) {
        if (currentXhr) currentXhr.abort();
      } else {
        queue = queue.filter(function (it) {
          return it.id !== id;
        });
        renderQueue();
      }
    });

  input.addEventListener("change", function () {
    enqueue(input.files);
    input.value = ""; // allow re-picking the same file(s)
  });
  dz.addEventListener("click", function (e) {
    var t = e.target.tagName;
    if (t !== "LABEL" && t !== "INPUT") input.click();
  });
  ["dragenter", "dragover"].forEach(function (ev) {
    dz.addEventListener(ev, function (e) {
      e.preventDefault();
      dz.classList.add("drag");
    });
  });
  ["dragleave", "drop"].forEach(function (ev) {
    dz.addEventListener(ev, function (e) {
      e.preventDefault();
      dz.classList.remove("drag");
    });
  });
  dz.addEventListener("drop", function (e) {
    if (e.dataTransfer) enqueue(e.dataTransfer.files);
  });

  // Leaving/closing the tab aborts an in-flight upload (a page upload can't keep
  // running in the background). Trigger the browser's leave prompt while a batch is
  // uploading. The dialog text is fixed by the browser; live progress stays in-page.
  window.addEventListener("beforeunload", function (e) {
    if (!running) return;
    e.preventDefault();
    e.returnValue = "";
  });
}

// --- catalogue + library search (Search page) --------------------------------

function wireSearch() {
  var q = document.getElementById("search-q");
  if (!q) return;
  var results = document.getElementById("search-results");
  var status = document.getElementById("search-status");
  var timer = null,
    seq = 0;

  function card(g) {
    // Metadata only — no game files hosted here. The title links out to an external
    // site so you can find/grab the game. This URL is the only place the link is
    // defined (results are client-rendered); change it below to point anywhere.
    var lib = g.inLibrary ? '<span class="pill">In library</span>' : "";
    var webSearch =
      "https://romsfun.com/browse-all-roms/?q=" + encodeURIComponent(g.title);
    // Box art from libretro's CDN (see coverCandidates). onerror walks the fallback
    // URLs, then hides the image if none exist. loading="lazy" defers off-screen ones.
    var srcs = coverCandidates(g);
    var cover =
      '<img class="cover" loading="lazy" alt="" data-srcs="' +
      esc(JSON.stringify(srcs)) +
      '" data-i="0" src="' +
      esc(srcs[0]) +
      '" onerror="var s=JSON.parse(this.dataset.srcs),i=+this.dataset.i+1;if(s[i]){this.dataset.i=i;this.src=s[i];}else{this.remove();}">';
    return (
      '<div class="gcard">' +
      cover +
      '<div class="gt">' +
      '<a href="' +
      webSearch +
      '" target="_blank" rel="noopener">' +
      esc(g.title) +
      "</a></div>" +
      "<div><code>" +
      esc(g.serial) +
      "</code></div>" +
      '<div><span class="pill">' +
      esc(consoleLabel(g.console)) +
      "</span>" +
      lib +
      "</div>" +
      "</div>"
    );
  }

  async function run() {
    var term = q.value.trim();
    if (term.length < 2) {
      results.innerHTML = "";
      status.innerHTML = "";
      return;
    }
    var mine = ++seq;
    status.innerHTML = '<span class="spinner"></span>Searching…';
    try {
      var hits = await getJSON("/api/search?q=" + encodeURIComponent(term));
      if (mine !== seq) return; // a newer query already fired
      status.textContent = hits.length
        ? hits.length +
          " result" +
          (hits.length === 1 ? "" : "s") +
          (hits.length >= 60 ? " (showing first 60 — narrow your search)" : "")
        : "No matches.";
      results.innerHTML = hits.map(card).join("");
    } catch (e) {
      status.textContent = "Search failed.";
    }
  }

  q.addEventListener("input", function () {
    clearTimeout(timer);
    timer = setTimeout(run, 250);
  });
}

// --- row actions (Library): delegated ----------------------------------------

document.addEventListener("click", async function (e) {
  var btn = e.target.closest ? e.target.closest("[data-action]") : null;
  if (!btn) return;
  var id = btn.dataset.id;
  var action = btn.dataset.action;
  var name = btn.dataset.title || id;

  if (action === "jobs-prev") {
    if (jobsPage > 0) jobsPage--;
    refreshJobs();
    return;
  }
  if (action === "jobs-next") {
    jobsPage++;
    refreshJobs();
    return;
  }

  if (action === "del-job") {
    if (
      !confirm(
        "Delete this job from the list? Removes the job and any leftover upload file. Staged games are not affected.",
      )
    )
      return;
    btn.disabled = true;
    try {
      await fetch("/api/jobs/" + id + "/delete", {
        method: "POST",
        headers: { accept: "application/json" },
      });
      location.reload();
    } catch (err) {
      btn.disabled = false;
      alert("Delete failed: " + err);
    }
    return;
  }

  if (action === "clear-jobs") {
    if (
      !confirm(
        "Clear all finished, failed and duplicate jobs? Staged games are not affected.",
      )
    )
      return;
    btn.disabled = true;
    try {
      await fetch("/api/jobs/clear", {
        method: "POST",
        headers: { accept: "application/json" },
      });
      location.reload();
    } catch (err) {
      btn.disabled = false;
      alert("Clear failed: " + err);
    }
    return;
  }

  if (action !== "delete") return;
  if (
    !confirm(
      'Delete "' +
        name +
        '" from the server? The file is removed from the shared folder. This cannot be undone.',
    )
  )
    return;
  btn.disabled = true;
  try {
    await fetch("/api/games/" + id + "/delete", {
      method: "POST",
      headers: { accept: "application/json" },
    });
    location.reload();
  } catch (err) {
    btn.disabled = false;
    alert("Delete failed: " + err);
  }
});

// --- library filter + click-to-sort (Library page) ---------------------------

function sortTable(th) {
  var table = th.closest("table");
  var tbody = table.querySelector("tbody");
  var col = +th.getAttribute("data-col");
  var type = th.getAttribute("data-type");
  var asc = th.getAttribute("data-dir") !== "asc";
  th.setAttribute("data-dir", asc ? "asc" : "desc");
  var rows = Array.prototype.slice.call(tbody.querySelectorAll("tr"));
  rows.sort(function (a, b) {
    var ca = a.children[col],
      cb = b.children[col],
      va,
      vb;
    if (type === "num") {
      va = +(ca.getAttribute("data-value") || 0);
      vb = +(cb.getAttribute("data-value") || 0);
    } else {
      va = ca.textContent.trim().toLowerCase();
      vb = cb.textContent.trim().toLowerCase();
    }
    if (va < vb) return asc ? -1 : 1;
    if (va > vb) return asc ? 1 : -1;
    return 0;
  });
  rows.forEach(function (r) {
    tbody.appendChild(r);
  });
}

function wireLibrary() {
  var filter = document.getElementById("lib-filter");
  if (!filter) return;
  filter.addEventListener("input", function () {
    var q = filter.value.trim().toLowerCase();
    document.querySelectorAll("tr[data-row]").forEach(function (tr) {
      tr.style.display =
        tr.getAttribute("data-search").indexOf(q) !== -1 ? "" : "none";
    });
  });
  document.querySelectorAll("th[data-col]").forEach(function (th) {
    th.addEventListener("click", function () {
      sortTable(th);
    });
  });
}

// --- storage usage (home page) -----------------------------------------------

async function refreshStorage() {
  var el = document.getElementById("storage-body");
  if (!el) return;
  try {
    var s = await getJSON("/api/storage");
    var pi = s.pi;
    var lines = [];
    lines.push(
      "<p><strong>" +
        fmtBytes(pi.stagedBytes) +
        "</strong> organised across <strong>" +
        pi.stagedGames +
        "</strong> game" +
        (pi.stagedGames === 1 ? "" : "s") +
        (pi.totalBytes
          ? " · " +
            fmtBytes(pi.freeBytes) +
            " free of " +
            fmtBytes(pi.totalBytes)
          : "") +
        "</p>",
    );
    if (pi.totalBytes) {
      var usedPct = Math.round(
        ((pi.totalBytes - pi.freeBytes) / pi.totalBytes) * 100,
      );
      lines.push(
        '<div class="progress" style="max-width:420px"><div class="progress-fill" style="width:' +
          usedPct +
          '%"></div></div>',
      );
    }
    el.classList.remove("muted");
    el.innerHTML = lines.join("");
  } catch (e) {
    /* transient */
  }
}

// --- boot --------------------------------------------------------------------

wireUpload();
wireLibrary();
wireSearch();
wireGuideIp();
hydrateCovers(); // fill covers for the server-rendered library rows

if (document.getElementById("jobs-tbody")) {
  refreshJobs();
  setInterval(refreshJobs, 2000);
}

if (document.getElementById("storage-body")) {
  refreshStorage();
  setInterval(refreshStorage, 10000);
}
