// Full-page HTML shell: dark theme, top nav. Server-rendered, no build step, no
// framework. All view HTML is a plain string (mirrors wii-sync's layout).

// Escape text destined for HTML body/attributes. Small on purpose — no templating lib.
export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

interface NavItem {
  key: string;
  href: string;
  label: string;
}

const NAV: NavItem[] = [
  { key: 'library', href: '/', label: 'Library' },
  { key: 'add', href: '/add', label: 'Add' },
  { key: 'search', href: '/search', label: 'Search' },
  { key: 'guide', href: '/guide', label: 'Setup guide' },
];

// ponytail: one hand-written <style> block inlined into every page. Ceiling: no
//   CSS bundling / caching. Fine for a homelab single-page-feel app; upgrade path
//   is to move it to /static/app.css if it ever grows.
const STYLE = `
:root{
  color-scheme:light dark;
  /* light by default */
  --bg:#f5f6f8;--panel:#ffffff;--panel2:#eef1f5;--fg:#1b2027;--muted:#5b6672;
  --accent:#2563eb;--accent-fg:#ffffff;--danger:#dc2626;--ok:#16a34a;--warn:#b7791f;--border:#d9dee5;
  --bok-bg:#e6f6ec;--bok-fg:#166534;--bwarn-bg:#fdf3e2;--bwarn-fg:#92600a;--bbusy-bg:#e6f0fe;--bbusy-fg:#1e40af;
  --badge-ok-fg:#166534;--badge-ok-bd:#9bd3ae;--badge-busy-fg:#1e40af;--badge-busy-bd:#a9c4f5;--badge-dup-fg:#92600a;--badge-dup-bd:#e2c489;
}
/* follow the OS setting: switch to dark when the system prefers dark */
@media (prefers-color-scheme: dark){:root{
  --bg:#0f1216;--panel:#171c22;--panel2:#1e252d;--fg:#e6e9ee;--muted:#9aa4b2;
  --accent:#4aa8ff;--accent-fg:#03121f;--danger:#ff5f56;--ok:#3fb950;--warn:#d29922;--border:#2a323c;
  --bok-bg:#12351f;--bok-fg:#8fe3a5;--bwarn-bg:#3a2f12;--bwarn-fg:#f0cd7a;--bbusy-bg:#0e2a44;--bbusy-fg:#9fd0ff;
  --badge-ok-fg:#8fe3a5;--badge-ok-bd:#2e6b41;--badge-busy-fg:#9fd0ff;--badge-busy-bd:#265a86;--badge-dup-fg:#f0cd7a;--badge-dup-bd:#6b551f;
}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0;background:var(--bg);color:var(--fg);
  font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
  line-height:1.5;
}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
header.nav{
  position:sticky;top:0;z-index:10;background:var(--panel);
  border-bottom:1px solid var(--border);
  display:flex;flex-wrap:wrap;align-items:center;gap:.25rem;
  padding:.6rem 1rem;
}
header.nav .brand{font-weight:700;margin-right:1rem}
header.nav a.navlink{padding:.4rem .7rem;border-radius:6px;color:var(--fg)}
header.nav a.navlink:hover{background:var(--panel2);text-decoration:none}
header.nav a.navlink.active{background:var(--accent);color:var(--accent-fg)}
main{max-width:1000px;margin:0 auto;padding:1.5rem 1rem 4rem}
h1{font-size:1.4rem;margin:.2rem 0 1rem}
h2{font-size:1.1rem;margin:0 0 .75rem}
h3{font-size:1rem;margin:1.25rem 0 .4rem}
.card{
  background:var(--panel);border:1px solid var(--border);border-radius:10px;
  padding:1.1rem 1.2rem;margin:0 0 1.25rem;
}
.muted{color:var(--muted)}
.small{font-size:.85rem}
.hidden{display:none}
.table-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:.92rem}
th,td{text-align:left;padding:.5rem .6rem;border-bottom:1px solid var(--border);vertical-align:middle}
th{color:var(--muted);font-weight:600;white-space:nowrap}
th[data-col]{cursor:pointer;user-select:none}
th[data-col]:hover{color:var(--fg)}
tbody tr:hover{background:var(--panel2)}
input,select,button,textarea{font:inherit}
input[type=text],input[type=url],input[type=password],select{
  width:100%;max-width:420px;padding:.5rem .6rem;background:var(--panel2);
  color:var(--fg);border:1px solid var(--border);border-radius:6px;
}
label{display:block;margin:.25rem 0 .75rem;color:var(--muted);font-size:.9rem}
.btn{
  display:inline-block;padding:.45rem .8rem;border-radius:6px;cursor:pointer;
  background:var(--panel2);color:var(--fg);border:1px solid var(--border);
}
.btn:hover{filter:brightness(1.15)}
.btn.primary{background:var(--accent);color:var(--accent-fg);border-color:transparent;font-weight:600}
.btn.danger{background:transparent;color:var(--danger);border-color:var(--danger)}
.btn.small{padding:.3rem .55rem;font-size:.82rem}
.link{color:var(--accent);cursor:pointer}
.badge{display:inline-block;padding:.1rem .5rem;border-radius:999px;font-size:.78rem;border:1px solid var(--border)}
.badge.ok{color:var(--badge-ok-fg);border-color:var(--badge-ok-bd)}
.badge.pending{color:var(--muted)}
.badge.busy{color:var(--badge-busy-fg);border-color:var(--badge-busy-bd)}
.badge.fail{color:var(--danger);border-color:var(--danger)}
.badge.dup{color:var(--badge-dup-fg);border-color:var(--badge-dup-bd)}
.progress{background:var(--panel2);border-radius:999px;height:8px;overflow:hidden;min-width:90px}
.progress-fill{background:var(--accent);height:100%;width:0;transition:width .3s}
.dropzone{
  border:2px dashed var(--border);border-radius:10px;padding:2rem 1rem;text-align:center;
  transition:border-color .15s,background .15s;
}
.dropzone.drag{border-color:var(--accent);background:var(--panel2)}
.row-actions{display:flex;gap:.4rem;flex-wrap:wrap}
ul{padding-left:1.2rem}
li{margin:.25rem 0}
code{background:var(--panel2);padding:.1rem .35rem;border-radius:4px;font-size:.88em}
.results{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:1rem;margin-top:1rem}
.gcard{display:block;background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:.7rem;text-align:center;color:var(--fg);text-decoration:none}
.gcard .cover{width:100%;height:auto;border-radius:6px;margin-bottom:.5rem;display:block}
.gcard .gt{font-size:.9rem;margin:0 0 .4rem;line-height:1.3;font-weight:600}
.pill{display:inline-block;font-size:.72rem;color:var(--muted);border:1px solid var(--border);border-radius:999px;padding:.05rem .45rem;margin:.1rem .1rem 0}
.spinner{display:inline-block;width:14px;height:14px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .7s linear infinite;vertical-align:-3px;margin-right:.45rem}
@keyframes spin{to{transform:rotate(360deg)}}
`;

export function renderPage(title: string, activeNav: string, bodyHtml: string): string {
  const nav = NAV.map(
    (n) =>
      `<a class="navlink${n.key === activeNav ? ' active' : ''}" href="${n.href}">${escapeHtml(n.label)}</a>`,
  ).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)} · ps2sync</title>
<style>${STYLE}</style>
</head>
<body>
<header class="nav">
  <span class="brand">ps2sync</span>
  ${nav}
</header>
<main>
${bodyHtml}
</main>
<script src="/static/app.js" defer></script>
</body>
</html>`;
}
