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
  var serial = String(g.serial || "").toUpperCase();
  var out = [];
  // Serial-keyed covers from xlenore (via jsDelivr CDN) — reliable & exact by disc
  // serial. PS1 and PS2 each have their own repo, so a title mismatch (e.g. EU
  // "Crash Bandicoot 3 - Warped" vs US "Crash Bandicoot - Warped") no longer matters.
  var repo =
    g.console === "ps1"
      ? "psx-covers"
      : g.console === "ps2"
        ? "ps2-covers"
        : "";
  if (repo && serial) {
    out.push(
      "https://cdn.jsdelivr.net/gh/xlenore/" +
        repo +
        "@main/covers/default/" +
        encodeURIComponent(serial) +
        ".jpg",
    );
  }
  // Fallback for either console: libretro thumbnails by No-Intro name + region.
  var sys = g.console === "ps1" ? "Sony - PlayStation" : "Sony - PlayStation 2";
  var base =
    "https://thumbnails.libretro.com/" +
    encodeURIComponent(sys) +
    "/Named_Boxarts/";
  var pre = serial.split("-")[0];
  var region = /^(SLES|SCES|SLED|SCED|SLEH)/.test(pre)
    ? "Europe"
    : /^(SLPS|SLPM|SCPS|SCAJ|SLKA|SCKA|PCPX|SLAJ)/.test(pre)
      ? "Japan"
      : "USA";
  var regions = [region, "USA", "Europe", "Japan"].filter(function (r, i, a) {
    return a.indexOf(r) === i;
  });
  regions.forEach(function (r) {
    out.push(base + encodeURIComponent(g.title + " (" + r + ")") + ".png");
    if (g.console === "ps1")
      out.push(
        base + encodeURIComponent(g.title + " (" + r + ") (Disc 1)") + ".png",
      );
  });
  return out.slice(0, 7);
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
      var srcs = coverCandidates({
        console: con,
        serial: serial,
        title: title,
      });
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
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
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

// When a job first reaches a terminal "done" state (a game was placed), refresh the
// library in place so the new game appears without a manual reload.
var seenDone = null; // map of completed job ids; null until the first poll
function detectCompletions(rows) {
  var doneNow = {},
    isNew = false;
  for (var i = 0; i < rows.length; i++) {
    var st = rows[i].state;
    if (st === "ready" || st === "staged") {
      doneNow[rows[i].id] = 1;
      if (seenDone && !seenDone[rows[i].id]) isNew = true;
    }
  }
  if (seenDone && isNew && typeof refreshLibrary === "function")
    refreshLibrary();
  seenDone = doneNow;
}

async function refreshJobs() {
  var tbody = document.getElementById("jobs-tbody");
  if (!tbody) return;
  try {
    var rows = await getJSON("/api/jobs");
    detectCompletions(rows);
    var pages = Math.max(1, Math.ceil(rows.length / JOBS_PER_PAGE));
    if (jobsPage > pages - 1) jobsPage = pages - 1; // clamp after deletes
    if (jobsPage < 0) jobsPage = 0;
    var start = jobsPage * JOBS_PER_PAGE;
    tbody.innerHTML = rows.length
      ? rows
          .slice(start, start + JOBS_PER_PAGE)
          .map(jobRow)
          .join("")
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
  var curLoaded = 0,
    curTotal = 0,
    speed = 0; // smoothed bytes/sec, for the batch ETA

  function fmtEta(s) {
    if (!isFinite(s) || s <= 0) return "";
    s = Math.round(s);
    if (s < 60) return s + "s";
    var m = Math.round(s / 60);
    if (m < 60) return m + " min";
    return Math.floor(m / 60) + "h " + (m % 60) + "m";
  }
  function queuedBytes() {
    var b = 0;
    for (var i = 0; i < queue.length; i++) b += queue[i].file.size || 0;
    return b;
  }
  function updateSummary() {
    if (!current) return;
    var remaining = Math.max(0, curTotal - curLoaded) + queuedBytes();
    var eta = speed > 0 ? fmtEta(remaining / speed) : "";
    text.textContent =
      "Uploading " +
      (doneCount + 1) +
      " of " +
      (doneCount + 1 + queue.length) +
      " · " +
      fmtBytes(remaining) +
      " left" +
      (eta ? " · ~" + eta : "") +
      (speed > 0 ? " (" + fmtBytes(speed) + "/s)" : "");
  }

  function itemRow(id, name, active, size) {
    var mid = active
      ? '<div class="progress" style="flex:1;min-width:60px"><div class="progress-fill" id="uq-bar-' +
        id +
        '"></div></div><span class="muted small" id="uq-txt-' +
        id +
        '" style="white-space:nowrap">0%</span>'
      : '<span class="muted small" style="white-space:nowrap">Queued · ' +
        fmtBytes(size) +
        "</span>";
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
    if (current)
      rows.push(
        itemRow(current.id, current.file.name, true, current.file.size),
      );
    for (var i = 0; i < queue.length; i++)
      rows.push(
        itemRow(queue[i].id, queue[i].file.name, false, queue[i].file.size),
      );
    queueBox.innerHTML = rows.join("");
  }

  function drain() {
    if (queue.length === 0) {
      running = false;
      current = null;
      currentXhr = null;
      speed = 0;
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
    curLoaded = 0;
    curTotal = current.file.size || 0;
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
    var lastLoaded = 0,
      lastTime = Date.now();
    xhr.upload.onprogress = function (e) {
      if (!e.lengthComputable || !current) return;
      curLoaded = e.loaded;
      curTotal = e.total;
      var pct = Math.round((e.loaded / e.total) * 100);
      var b = document.getElementById("uq-bar-" + current.id);
      if (b) b.style.width = pct + "%";
      var t = document.getElementById("uq-txt-" + current.id);
      if (t)
        t.textContent =
          pct + "% (" + fmtBytes(e.loaded) + " / " + fmtBytes(e.total) + ")";
      var now = Date.now(),
        dt = (now - lastTime) / 1000;
      if (dt >= 0.4) {
        speed = speed
          ? speed * 0.7 + ((e.loaded - lastLoaded) / dt) * 0.3
          : (e.loaded - lastLoaded) / dt;
        lastLoaded = e.loaded;
        lastTime = now;
        updateSummary();
      }
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
    for (var i = 0; i < list.length; i++)
      queue.push({ id: ++seq, file: list[i] });
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
  var hideDupes = document.getElementById("hide-dupes");
  var hideDemos = document.getElementById("hide-demos");
  var timer = null,
    seq = 0,
    lastHits = [];

  function card(g) {
    // Metadata only — no game files hosted here. The title links out to an external
    // site so you can find/grab the game. This URL is the only place the link is
    // defined (results are client-rendered); change it below to point anywhere.
    var lib = g.inLibrary ? '<span class="pill">In library</span>' : "";
    var consoleNumber = g.console === "ps1" ? 7 : 8;
    var webSearch =
      "https://romsfun.com/browse-all-roms/?q=" +
      encodeURIComponent(g.title) +
      "&consoles[]=" +
      consoleNumber;
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

  function normTitle(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }
  // Collapse same-console/same-title region variants down to the first one.
  function collapse(hits) {
    if (!hideDupes || !hideDupes.checked) return hits;
    var seen = {},
      out = [];
    for (var i = 0; i < hits.length; i++) {
      var k = hits[i].console + "|" + normTitle(hits[i].title);
      if (seen[k]) continue;
      seen[k] = 1;
      out.push(hits[i]);
    }
    return out;
  }
  // Demo / beta / trial disc: by title marker or by a demo/promo serial prefix.
  function isDemo(g) {
    var t = String(g.title || "").toLowerCase();
    if (
      /(^|[^a-z])(demo|beta|trial|taikenban|otameshi|tentou)([^a-z]|$)/.test(t)
    )
      return true;
    var pre = String(g.serial || "")
      .split("-")[0]
      .toUpperCase();
    return /^(SLED|SCED|PCPX|PAPX|PBPX|TLES|TLUS|TCES|TCUS|TLED)$/.test(pre);
  }
  function render() {
    var hits = lastHits;
    if (hideDemos && hideDemos.checked)
      hits = hits.filter(function (g) {
        return !isDemo(g);
      });
    var shown = collapse(hits);
    var hidden = lastHits.length - shown.length;
    status.textContent = shown.length
      ? shown.length +
        " result" +
        (shown.length === 1 ? "" : "s") +
        (lastHits.length >= 60 ? " (first 60 — narrow your search)" : "") +
        (hidden > 0 ? " · " + hidden + " hidden" : "")
      : "No matches.";
    results.innerHTML = shown.map(card).join("");
  }

  async function run() {
    var term = q.value.trim();
    if (term.length < 2) {
      lastHits = [];
      results.innerHTML = "";
      status.innerHTML = "";
      return;
    }
    var mine = ++seq;
    status.innerHTML = '<span class="spinner"></span>Searching…';
    try {
      var hits = await getJSON("/api/search?q=" + encodeURIComponent(term));
      if (mine !== seq) return; // a newer query already fired
      lastHits = hits;
      render();
    } catch (e) {
      status.textContent = "Search failed.";
    }
  }

  q.addEventListener("input", function () {
    clearTimeout(timer);
    timer = setTimeout(run, 250);
  });
  if (hideDupes) {
    hideDupes.checked = localStorage.getItem("ps2sync-hide-dupes") === "1";
    hideDupes.addEventListener("change", function () {
      try {
        localStorage.setItem(
          "ps2sync-hide-dupes",
          hideDupes.checked ? "1" : "0",
        );
      } catch (e) {
        /* private mode */
      }
      render();
    });
  }
  if (hideDemos) {
    hideDemos.checked = localStorage.getItem("ps2sync-hide-demos") !== "0"; // default on
    hideDemos.addEventListener("change", function () {
      try {
        localStorage.setItem(
          "ps2sync-hide-demos",
          hideDemos.checked ? "1" : "0",
        );
      } catch (e) {
        /* private mode */
      }
      render();
    });
  }
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

  if (action === "patch") {
    // Pick a patch file (CHEATS.TXT / PATCH_#.BIN / TROJAN_#.BIN) and drop it into the
    // game's POPS folder over the API. POPStarter reads it on next launch.
    var inp = document.getElementById("patch-file");
    if (!inp) {
      inp = document.createElement("input");
      inp.type = "file";
      inp.id = "patch-file";
      inp.multiple = true;
      inp.style.display = "none";
      document.body.appendChild(inp);
    }
    inp.value = "";
    inp.onchange = async function () {
      if (!inp.files || !inp.files.length) return;
      var fd = new FormData();
      for (var i = 0; i < inp.files.length; i++) fd.append("file", inp.files[i]);
      btn.disabled = true;
      try {
        var res = await fetch("/api/games/" + id + "/patch", {
          method: "POST",
          body: fd,
        });
        var j = await res.json();
        if (!res.ok) throw new Error(j.error || res.status);
        alert(
          'Patch uploaded to "' +
            name +
            '": ' +
            (j.saved || []).join(", ") +
            "\nLaunch the game to apply.",
        );
      } catch (err) {
        alert("Patch upload failed: " + err);
      } finally {
        btn.disabled = false;
      }
    };
    inp.click();
    return;
  }

  if (action === "fix") {
    if (
      !confirm(
        'Apply the bundled fix to "' +
          name +
          '"? Drops POPStarter fix files into the game folder. Relaunch the game to apply.',
      )
    )
      return;
    btn.disabled = true;
    try {
      var fres = await fetch("/api/games/" + id + "/fix", {
        method: "POST",
        headers: { accept: "application/json" },
      });
      var fj = await fres.json();
      if (!fres.ok) throw new Error(fj.error || fres.status);
      alert(
        'Applied fix to "' + name + '": ' + (fj.saved || []).join(", ") + "\nRelaunch the game.",
      );
    } catch (err) {
      alert("Apply fix failed: " + err);
    } finally {
      btn.disabled = false;
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

// PS1 overclock dropdown: writes/removes the game's TROJAN_2.BIN via the API.
document.addEventListener("change", async function (e) {
  var sel = e.target;
  if (!sel || !sel.dataset || sel.dataset.action !== "overclock") return;
  var id = sel.dataset.id;
  var level = parseInt(sel.value, 10) || 0;
  sel.disabled = true;
  try {
    var res = await fetch("/api/games/" + id + "/overclock", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ level: level }),
    });
    var j = await res.json();
    if (!res.ok) throw new Error(j.error || res.status);
  } catch (err) {
    alert("Overclock change failed: " + err);
  } finally {
    sel.disabled = false;
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

function applyLibraryFilter() {
  var filter = document.getElementById("lib-filter");
  var q = filter ? filter.value.trim().toLowerCase() : "";
  document.querySelectorAll("tr[data-row]").forEach(function (tr) {
    tr.style.display =
      tr.getAttribute("data-search").indexOf(q) !== -1 ? "" : "none";
  });
}
function wireLibrarySort() {
  document
    .querySelectorAll("th[data-col]:not([data-sortwired])")
    .forEach(function (th) {
      th.setAttribute("data-sortwired", "1");
      th.addEventListener("click", function () {
        sortTable(th);
      });
    });
}
function wireLibrary() {
  var filter = document.getElementById("lib-filter");
  if (filter && !filter.dataset.wired) {
    filter.dataset.wired = "1";
    filter.addEventListener("input", applyLibraryFilter);
  }
  wireLibrarySort();
}
// Swap in freshly-rendered library tables (called when a job completes) without a
// full reload — re-hydrate covers, re-wire the new sort headers, re-apply the filter.
function refreshLibrary() {
  var body = document.getElementById("library-body");
  if (!body) return;
  fetch("/api/library", { headers: { accept: "text/html" } })
    .then(function (r) {
      return r.text();
    })
    .then(function (html) {
      body.innerHTML = html;
      if (typeof hydrateCovers === "function") hydrateCovers();
      wireLibrarySort();
      applyLibraryFilter();
    })
    .catch(function () {});
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

// --- apps (Apps page) --------------------------------------------------------

function wireApps() {
  var list = document.getElementById("apps-list");
  if (!list) return; // not on the apps page
  var q = document.getElementById("apps-q");
  var auto = document.getElementById("apps-auto");
  var all = [];

  function render() {
    var term = (q.value || "").trim().toLowerCase();
    var apps = all.filter(function (a) {
      return !term || (a.name + " " + a.blurb).toLowerCase().indexOf(term) !== -1;
    });
    list.classList.remove("muted");
    if (!apps.length) {
      list.innerHTML = '<p class="muted small">No matching apps.</p>';
      return;
    }
    list.innerHTML = apps
      .map(function (a) {
        var badge = a.installed ? ' <span class="pill">on share</span>' : "";
        var update = a.updateAvailable
          ? ' <span class="pill pill-warn">update: ' +
            esc(a.latestVersion || "") +
            (a.major ? " (major)" : "") +
            "</span>"
          : "";
        var btnLabel = a.updateAvailable ? "Update" : a.installed ? "Re-download" : "Download";
        return (
          '<div class="app-row"><div>' +
          "<strong>" +
          esc(a.name) +
          "</strong>" +
          (a.version ? ' <span class="pill">' + esc(a.version) + "</span>" : "") +
          badge +
          update +
          '<div class="muted small">' +
          esc(a.blurb) +
          "</div></div>" +
          '<button class="btn small" data-app="' +
          esc(a.key) +
          '">' +
          btnLabel +
          "</button>" +
          '<span class="app-msg small muted" data-msg="' +
          esc(a.key) +
          '"></span></div>'
        );
      })
      .join("");
  }

  function load() {
    // Fast disk-only list first, then enrich with the (cached) update check.
    getJSON("/api/apps")
      .then(function (apps) {
        all = apps;
        render();
        return getJSON("/api/apps/check");
      })
      .then(function (checked) {
        if (checked) {
          all = checked;
          render();
        }
      })
      .catch(function () {
        if (!all.length) list.textContent = "Failed to load apps.";
      });
  }

  var allBtn = document.getElementById("apps-install-all");
  if (allBtn) {
    var allMsg = document.getElementById("apps-all-msg");
    allBtn.addEventListener("click", async function () {
      allBtn.disabled = true;
      if (allMsg) allMsg.textContent = "Downloading everything… (this takes a bit)";
      try {
        var r = await fetch("/api/apps/install-all", { method: "POST", headers: { accept: "application/json" } });
        var body = await r.json();
        allBtn.disabled = false;
        if (!r.ok) throw new Error(body.error || "failed");
        var txt = "Done: " + (body.done || []).join(", ");
        if (body.errors && body.errors.length) txt += " · Errors: " + body.errors.join("; ");
        if (allMsg) allMsg.textContent = txt;
        load();
      } catch (err) {
        allBtn.disabled = false;
        if (allMsg) allMsg.textContent = "Failed: " + err.message;
      }
    });
  }

  var covers = document.getElementById("covers-refresh");
  if (covers) {
    var coversMsg = document.getElementById("covers-msg");
    covers.addEventListener("click", async function () {
      covers.disabled = true;
      coversMsg.textContent = "Fetching covers…";
      try {
        var r = await fetch("/api/covers/refresh", { method: "POST", headers: { accept: "application/json" } });
        var body = await r.json();
        covers.disabled = false;
        if (!r.ok) throw new Error(body.error || "failed");
        coversMsg.textContent = "Added " + body.added + " cover(s) of " + body.total + " games.";
      } catch (err) {
        covers.disabled = false;
        coversMsg.textContent = "Failed: " + err.message;
      }
    });
  }

  q.addEventListener("input", render);
  list.addEventListener("click", async function (e) {
    var btn = e.target.closest("button[data-app]");
    if (!btn) return;
    var key = btn.dataset.app;
    var msg = list.querySelector('[data-msg="' + key + '"]');
    btn.disabled = true;
    if (msg) msg.textContent = "Downloading…";
    try {
      var r = await fetch("/api/apps/" + key + "/install", {
        method: "POST",
        headers: { accept: "application/json" },
      });
      var body = await r.json();
      if (!r.ok) throw new Error(body.error || "install failed");
      if (msg) msg.textContent = "Saved " + (body.version || "") + " to APPS/";
      load();
    } catch (err) {
      btn.disabled = false;
      if (msg) msg.textContent = "Failed: " + err.message;
    }
  });

  if (auto) {
    getJSON("/api/settings")
      .then(function (s) {
        auto.checked = !!s.appsAutoUpdate;
      })
      .catch(function () {});
    auto.addEventListener("change", function () {
      fetch("/api/apps/auto-update", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ enabled: auto.checked }),
      }).catch(function () {});
    });
  }
  load();
}

// PS1 / POPStarter setup (Apps page): upload the POPS core files + show status.
function wirePops() {
  var status = document.getElementById("pops-status");
  if (!status) return; // not on the apps page
  var install = document.getElementById("pops-install");
  var input = document.getElementById("pops-file");
  var btn = document.getElementById("pops-upload");
  var msg = document.getElementById("pops-msg");

  function loadStatus() {
    getJSON("/api/pops")
      .then(function (s) {
        status.classList.remove("muted");
        var have = s.present.length
          ? "Present: " + s.present.map(esc).join(", ")
          : "No POPS files uploaded yet";
        var need = s.missing.length ? " · Missing: " + s.missing.map(esc).join(", ") : "";
        var games =
          " · " +
          s.vcds +
          " PS1 game(s), " +
          s.launchers +
          " launcher(s)" +
          (s.ready ? "" : " — upload POPSTARTER.ELF to generate launchers");
        status.innerHTML = "<strong>" + have + "</strong>" + esc(need) + esc(games);
      })
      .catch(function () {
        status.textContent = "Could not load POPS status.";
      });
  }

  var push = document.getElementById("pops-push");
  if (push) {
    var pushMsg = document.getElementById("pops-push-msg");
    var ipInput = document.getElementById("ps2-ip");
    push.addEventListener("click", async function () {
      push.disabled = true;
      pushMsg.textContent = "Connecting to PS2 over FTP…";
      try {
        var r = await fetch("/api/pops/push-config", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ ps2ip: (ipInput.value || "").trim() }),
        });
        var body = await r.json();
        push.disabled = false;
        if (!r.ok) throw new Error(body.error || "push failed");
        pushMsg.textContent = "Wrote " + (body.files || []).join(" + ") + " to mc0:/POPSTARTER/ (SMB server " + body.server + ")";
      } catch (err) {
        push.disabled = false;
        pushMsg.textContent = "Failed: " + err.message;
      }
    });
  }

  var purge = document.getElementById("pops-purge");
  if (purge) {
    purge.addEventListener("click", async function () {
      if (!confirm("Remove all PS1 entries smaller than 50 MB? These are bogus data files, not real games.")) return;
      purge.disabled = true;
      msg.textContent = "Cleaning up…";
      try {
        var r = await fetch("/api/pops/purge", { method: "POST", headers: { accept: "application/json" } });
        var body = await r.json();
        purge.disabled = false;
        if (!r.ok) throw new Error(body.error || "purge failed");
        msg.textContent = "Removed " + body.removed + " bogus PS1 entr(ies).";
        loadStatus();
      } catch (err) {
        purge.disabled = false;
        msg.textContent = "Failed: " + err.message;
      }
    });
  }

  install.addEventListener("click", async function () {
    install.disabled = true;
    msg.textContent = "Downloading POPStarter core…";
    try {
      var r = await fetch("/api/pops/install", { method: "POST", headers: { accept: "application/json" } });
      var body = await r.json();
      install.disabled = false;
      if (!r.ok) throw new Error(body.error || "download failed");
      msg.textContent =
        "Installed: " + (body.placed || []).join(", ") + " · " + (body.launchers || 0) + " launcher(s) made";
      loadStatus();
    } catch (err) {
      install.disabled = false;
      msg.textContent = "Failed: " + err.message;
    }
  });

  btn.addEventListener("click", async function () {
    if (!input.files || !input.files.length) {
      msg.textContent = "Pick your POPS file(s) or a .7z first.";
      return;
    }
    var fd = new FormData();
    for (var i = 0; i < input.files.length; i++) fd.append("file", input.files[i]);
    btn.disabled = true;
    msg.textContent = "Uploading…";
    try {
      var r = await fetch("/pops/upload", { method: "POST", body: fd });
      var body = await r.json();
      btn.disabled = false;
      if (!r.ok) throw new Error(body.error || "upload failed");
      msg.textContent =
        "Placed: " + (body.placed || []).join(", ") + " · " + (body.launchers || 0) + " launcher(s) made";
      input.value = "";
      loadStatus();
    } catch (err) {
      btn.disabled = false;
      msg.textContent = "Failed: " + err.message;
    }
  });
  loadStatus();
}

// Files page: browse DATA_DIR, navigate folders, download, upload.
function wireFiles() {
  var tbody = document.getElementById("files-tbody");
  if (!tbody) return; // not on the files page
  var crumbs = document.getElementById("files-crumbs");
  var upBtn = document.getElementById("files-upload-btn");
  var upInput = document.getElementById("files-upload");
  var msg = document.getElementById("files-msg");
  var cur = "";

  function fmt(n) {
    return typeof fmtBytes === "function" ? fmtBytes(n) : n + " B";
  }

  function renderCrumbs() {
    var parts = cur ? cur.split("/") : [];
    var html = '<a href="#" data-path="">/data</a>';
    var acc = "";
    for (var i = 0; i < parts.length; i++) {
      acc = acc ? acc + "/" + parts[i] : parts[i];
      html += " / " + '<a href="#" data-path="' + esc(acc) + '">' + esc(parts[i]) + "</a>";
    }
    crumbs.innerHTML = html;
  }

  function load() {
    tbody.innerHTML = '<tr><td colspan="2" class="muted">Loading…</td></tr>';
    getJSON("/api/files?path=" + encodeURIComponent(cur))
      .then(function (d) {
        cur = d.path || "";
        renderCrumbs();
        var rows = "";
        if (cur)
          rows += '<tr data-dir="' + esc(parentOf(cur)) + '" style="cursor:pointer"><td colspan="2">⬆ ..</td></tr>';
        if (!d.entries.length) rows += '<tr><td colspan="2" class="muted">Empty folder.</td></tr>';
        d.entries.forEach(function (e) {
          var rel = (cur ? cur + "/" : "") + e.name;
          if (e.dir) {
            rows +=
              '<tr data-dir="' + esc(rel) + '" style="cursor:pointer"><td>📁 ' + esc(e.name) + "</td><td></td></tr>";
          } else {
            rows +=
              "<tr><td>📄 " +
              esc(e.name) +
              "</td><td>" +
              fmt(e.size) +
              ' · <a class="link small" href="/files/download?path=' +
              encodeURIComponent(rel) +
              '">download</a></td></tr>';
          }
        });
        tbody.innerHTML = rows;
      })
      .catch(function () {
        tbody.innerHTML = '<tr><td colspan="2" class="muted">Failed to load.</td></tr>';
      });
  }

  function parentOf(p) {
    var i = p.lastIndexOf("/");
    return i === -1 ? "" : p.slice(0, i);
  }

  tbody.addEventListener("click", function (e) {
    var d = e.target.closest("[data-dir]");
    if (d) {
      e.preventDefault();
      cur = d.dataset.dir;
      load();
    }
  });
  crumbs.addEventListener("click", function (e) {
    var a = e.target.closest("[data-path]");
    if (a) {
      e.preventDefault();
      cur = a.dataset.path;
      load();
    }
  });

  upBtn.addEventListener("click", async function () {
    if (!upInput.files || !upInput.files.length) {
      msg.textContent = "Pick file(s) first.";
      return;
    }
    var fd = new FormData();
    for (var i = 0; i < upInput.files.length; i++) fd.append("file", upInput.files[i]);
    upBtn.disabled = true;
    msg.textContent = "Uploading…";
    try {
      var r = await fetch("/files/upload?dir=" + encodeURIComponent(cur), { method: "POST", body: fd });
      var body = await r.json();
      upBtn.disabled = false;
      if (!r.ok) throw new Error(body.error || "upload failed");
      msg.textContent = "Uploaded: " + (body.saved || []).join(", ");
      upInput.value = "";
      load();
    } catch (err) {
      upBtn.disabled = false;
      msg.textContent = "Failed: " + err.message;
    }
  });

  load();
}

// Badge the Apps nav link when any installed app has an update (runs every page).
function badgeAppUpdates() {
  var link = document.querySelector('a.navlink[href="/apps"]');
  if (!link) return;
  getJSON("/api/apps/check")
    .then(function (apps) {
      var n = (apps || []).filter(function (a) {
        return a.updateAvailable;
      }).length;
      if (n > 0 && !link.querySelector(".nav-badge")) {
        var b = document.createElement("span");
        b.className = "nav-badge";
        b.textContent = n;
        link.appendChild(b);
      }
    })
    .catch(function () {});
}

// --- boot --------------------------------------------------------------------

wireUpload();
wireLibrary();
wireSearch();
wireApps();
wirePops();
wireFiles();
badgeAppUpdates();
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
