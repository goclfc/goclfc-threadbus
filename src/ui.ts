// Admin feed UI. A single self-contained HTML page served at GET /ui.
// It talks to /feed and /threads/:id with the viewer or admin key the operator pastes in,
// which is kept in the browser's localStorage and never put in a URL.
//
// Keep this file free of backticks and "${" so it stays a plain template literal.

export const UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ThreadBus</title>
<style>
  :root {
    --bg: #f5f6f8; --card: #ffffff; --text: #16181c; --muted: #6b7280; --line: #e5e7eb;
    --accent: #2563eb; --open: #d97706; --open-bg: #fef3c7; --done: #059669; --done-bg: #d1fae5;
    --arch: #6b7280; --arch-bg: #e5e7eb; --reply-bg: #f9fafb; --code: #f3f4f6;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1115; --card: #181b21; --text: #e6e7ea; --muted: #9aa0ab; --line: #2a2f3a;
      --accent: #60a5fa; --open: #fbbf24; --open-bg: #3b2f0b; --done: #34d399; --done-bg: #0d3b2a;
      --arch: #9aa0ab; --arch-bg: #2a2f3a; --reply-bg: #13161b; --code: #22262e;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  a { color: var(--accent); }
  header { position: sticky; top: 0; z-index: 5; background: var(--card); border-bottom: 1px solid var(--line); }
  .bar { max-width: 760px; margin: 0 auto; padding: 10px 16px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .brand { font-weight: 700; font-size: 17px; margin-right: auto; }
  .brand small { color: var(--muted); font-weight: 400; margin-left: 8px; font-size: 13px; }
  .tabs { display: flex; gap: 4px; }
  .tabs button, .btn { border: 1px solid var(--line); background: transparent; color: var(--text); padding: 5px 11px; border-radius: 999px; cursor: pointer; font-size: 13px; }
  .tabs button.on { background: var(--accent); border-color: var(--accent); color: #fff; }
  input[type=search], input[type=password] { border: 1px solid var(--line); background: var(--bg); color: var(--text); padding: 6px 10px; border-radius: 8px; font-size: 14px; }
  main { max-width: 760px; margin: 0 auto; padding: 16px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 14px 16px; margin-bottom: 14px; }
  .who { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 13px; color: var(--muted); }
  .avatar { width: 34px; height: 34px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-weight: 700; color: #fff; font-size: 13px; flex: none; }
  .name { color: var(--text); font-weight: 600; }
  .badge { padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .badge.open { background: var(--open-bg); color: var(--open); }
  .badge.resolved { background: var(--done-bg); color: var(--done); }
  .badge.archived { background: var(--arch-bg); color: var(--arch); }
  .kind { border: 1px solid var(--line); padding: 1px 8px; border-radius: 999px; font-size: 12px; }
  .title { font-size: 17px; font-weight: 700; margin: 10px 0 6px; }
  .body { white-space: pre-wrap; word-break: break-word; }
  .body pre { background: var(--code); padding: 8px 10px; border-radius: 8px; overflow-x: auto; white-space: pre; }
  .body code { background: var(--code); padding: 1px 4px; border-radius: 4px; font-size: 13px; }
  .att { margin-top: 6px; font-size: 13px; }
  .att a { margin-right: 10px; }
  .foot { margin-top: 10px; display: flex; gap: 14px; align-items: center; font-size: 13px; color: var(--muted); flex-wrap: wrap; }
  .foot button { background: none; border: none; color: var(--accent); cursor: pointer; padding: 0; font-size: 13px; }
  .replies { margin-top: 10px; border-left: 2px solid var(--line); padding-left: 12px; }
  .reply { background: var(--reply-bg); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; margin-top: 8px; }
  .reply .who { margin-bottom: 4px; }
  .reply.final { border-color: var(--done); }
  .outcome { margin-top: 10px; padding: 10px 12px; border-radius: 10px; background: var(--done-bg); color: var(--done); font-weight: 600; }
  .outcome span { font-weight: 400; color: var(--text); }
  .waiting { color: var(--open); font-weight: 600; }
  .empty, .err { color: var(--muted); text-align: center; padding: 40px 0; }
  .err { color: #dc2626; }
  .login { max-width: 420px; margin: 60px auto; }
  .login h2 { margin-top: 0; }
  .login form { display: flex; gap: 8px; }
  .login input { flex: 1; }
  .login .btn { background: var(--accent); border-color: var(--accent); color: #fff; }
  .more { text-align: center; margin: 10px 0 30px; }
  .avatar.c0 { background: #2563eb; } .avatar.c1 { background: #7c3aed; } .avatar.c2 { background: #db2777; }
  .avatar.c3 { background: #059669; } .avatar.c4 { background: #d97706; } .avatar.c5 { background: #0891b2; }
  .avatar.admin { background: #374151; }
</style>
</head>
<body>
<header>
  <div class="bar">
    <div class="brand">ThreadBus <small id="stats"></small></div>
    <div class="tabs" id="tabs">
      <button data-status="" class="on">All</button>
      <button data-status="open">Open</button>
      <button data-status="resolved">Resolved</button>
    </div>
    <input type="search" id="q" placeholder="Search titles" autocomplete="off">
    <button class="btn" id="refresh" title="Refresh">Refresh</button>
    <button class="btn" id="logout" title="Forget the admin key">Key</button>
  </div>
</header>
<main id="main"></main>
<script>
(function () {
  var KEY_NAME = 'threadbus_admin_key';
  var PAGE = 50;
  var state = { status: '', q: '', threads: [], total: 0, offset: 0, expanded: {}, cache: {}, timer: null };
  var main = document.getElementById('main');

  function key() { try { return localStorage.getItem(KEY_NAME) || ''; } catch (e) { return ''; } }
  function setKey(v) { try { if (v) localStorage.setItem(KEY_NAME, v); else localStorage.removeItem(KEY_NAME); } catch (e) {} }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  // Minimal, safe rendering: escape everything, then add fenced code, inline code and autolinks.
  function render(body) {
    var parts = String(body || '').split(/\\x60\\x60\\x60/);
    var out = '';
    for (var i = 0; i < parts.length; i++) {
      if (i % 2 === 1) { out += '<pre>' + esc(parts[i].replace(/^[a-z]*\\n/, '')) + '</pre>'; continue; }
      var t = esc(parts[i]);
      t = t.replace(/\\x60([^\\x60\\n]+)\\x60/g, '<code>$1</code>');
      t = t.replace(/(https?:\\/\\/[^\\s<]+[^\\s<.,;:!?)\\]])/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
      out += t;
    }
    return out;
  }

  function ago(iso) {
    var d = new Date(iso), s = Math.round((Date.now() - d.getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 86400 * 7) return Math.floor(s / 86400) + 'd ago';
    return d.toLocaleDateString();
  }
  function full(iso) { return new Date(iso).toLocaleString(); }

  function color(id) { if (id === 'admin') return 'admin'; var h = 0; for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0; return 'c' + (Math.abs(h) % 6); }
  function avatar(id) { return '<span class="avatar ' + color(id) + '" title="' + esc(id) + '">' + esc(id.slice(0, 2).toUpperCase()) + '</span>'; }

  function attachments(a) {
    if (!a || typeof a !== 'object') return '';
    var items = [];
    Object.keys(a).forEach(function (k) {
      var v = a[k];
      if (typeof v === 'string' && /^https?:\\/\\//.test(v)) items.push('<a href="' + esc(v) + '" target="_blank" rel="noopener">' + esc(k) + '</a>');
      else items.push('<span title="' + esc(JSON.stringify(v)) + '">' + esc(k) + '</span>');
    });
    return items.length ? '<div class="att">Attachments: ' + items.join('') + '</div>' : '';
  }

  function api(path) {
    return fetch(path, { headers: { authorization: 'Bearer ' + key() } }).then(function (r) {
      if (r.status === 401) { throw new Error('unauthorized'); }
      if (!r.ok) { return r.text().then(function (t) { throw new Error(r.status + ' ' + t); }); }
      return r.json();
    });
  }

  function statusBadge(t) {
    if (t.status === 'open') return '<span class="badge open">open</span> <span class="waiting">waiting on ' + esc(t.waiting_on || '?') + '</span>';
    return '<span class="badge ' + esc(t.status) + '">' + esc(t.status) + '</span>';
  }

  function card(t) {
    var fm = t.first_message || {};
    var replies = Math.max(0, (t.seq || 0) - 1);
    var isOpen = !!state.expanded[t.id];
    var html = '<article class="card" data-id="' + t.id + '">';
    html += '<div class="who">' + avatar(t.created_by) + '<span class="name">' + esc(t.created_by) + '</span>';
    if (fm.to) html += '<span>asked <b>' + esc(fm.to) + '</b></span>';
    html += '<span title="' + esc(full(t.created_at)) + '">' + ago(t.created_at) + '</span>';
    if (t.kind) html += '<span class="kind">' + esc(t.kind) + '</span>';
    html += '<span style="margin-left:auto">' + statusBadge(t) + '</span></div>';
    html += '<div class="title">#' + t.id + ' ' + esc(t.title) + '</div>';
    html += '<div class="body">' + render(fm.body) + '</div>' + attachments(fm.attachments);
    html += '<div class="foot"><button class="toggle">' + (isOpen ? 'Hide replies' : (replies === 1 ? '1 reply' : replies + ' replies')) + '</button>';
    html += '<span>participants: ' + esc((t.participants || []).join(', ')) + '</span>';
    html += '<span title="' + esc(full(t.updated_at)) + '">updated ' + ago(t.updated_at) + '</span></div>';
    if (!isOpen && t.last_message && t.last_message.seq > 1 && t.status === 'open') {
      html += '<div class="replies"><div class="reply"><div class="who">' + avatar(t.last_message.author) + '<span class="name">' + esc(t.last_message.author) + '</span>';
      if (t.last_message.to) html += '<span>to <b>' + esc(t.last_message.to) + '</b></span>';
      html += '<span>' + ago(t.last_message.created_at) + '</span></div><div class="body">' + render(t.last_message.body) + '</div></div></div>';
    }
    if (isOpen) html += '<div class="replies" id="r' + t.id + '">' + (state.cache[t.id] ? repliesHtml(state.cache[t.id]) : '<div class="empty">Loading</div>') + '</div>';
    if (t.status !== 'open' && t.outcome) html += '<div class="outcome">Outcome: <span>' + esc(t.outcome) + '</span></div>';
    html += '</article>';
    return html;
  }

  function repliesHtml(thread) {
    var ms = (thread.messages || []).filter(function (m) { return m.seq > 1; });
    if (!ms.length) return '<div class="empty">No replies yet</div>';
    return ms.map(function (m) {
      var h = '<div class="reply' + (m.resolved ? ' final' : '') + '"><div class="who">' + avatar(m.author) + '<span class="name">' + esc(m.author) + '</span>';
      if (m.to) h += '<span>to <b>' + esc(m.to) + '</b></span>';
      if (m.resolved) h += '<span class="badge resolved">resolved</span>';
      h += '<span title="' + esc(full(m.created_at)) + '">' + ago(m.created_at) + '</span><span>#' + m.seq + '</span></div>';
      h += '<div class="body">' + render(m.body) + '</div>' + attachments(m.attachments) + '</div>';
      return h;
    }).join('');
  }

  function draw() {
    var q = state.q.trim().toLowerCase();
    var list = state.threads.filter(function (t) { return !q || (t.title || '').toLowerCase().indexOf(q) >= 0 || ((t.first_message || {}).body || '').toLowerCase().indexOf(q) >= 0; });
    if (!list.length) { main.innerHTML = '<div class="empty">No threads' + (q ? ' match' : ' yet') + '.</div>'; return; }
    var html = list.map(card).join('');
    if (state.threads.length < state.total) html += '<div class="more"><button class="btn" id="more">Load more</button></div>';
    main.innerHTML = html;
  }

  function load(append) {
    if (!append) state.offset = 0;
    var qs = '/feed?limit=' + PAGE + '&offset=' + state.offset + (state.status ? '&status=' + state.status : '');
    return api(qs).then(function (d) {
      state.threads = append ? state.threads.concat(d.threads) : d.threads;
      state.total = d.total;
      state.offset = state.threads.length;
      document.getElementById('stats').textContent = d.total + (state.status ? ' ' + state.status : '') + ' threads';
      draw();
    }).catch(function (e) {
      if (e.message === 'unauthorized') { setKey(''); login('That key was rejected.'); }
      else main.innerHTML = '<div class="err">' + esc(e.message) + '</div>';
    });
  }

  function expand(id) {
    state.expanded[id] = true;
    draw();
    api('/threads/' + id).then(function (t) { state.cache[id] = t; var el = document.getElementById('r' + id); if (el) el.innerHTML = repliesHtml(t); })
      .catch(function (e) { var el = document.getElementById('r' + id); if (el) el.innerHTML = '<div class="err">' + esc(e.message) + '</div>'; });
  }

  function login(msg) {
    clearInterval(state.timer);
    main.innerHTML = '<div class="card login"><h2>ThreadBus</h2><p>Paste the viewer key (read-only) or the admin key. It stays in this browser only.</p>' +
      (msg ? '<p class="err" style="padding:0;text-align:left">' + esc(msg) + '</p>' : '') +
      '<form id="lf"><input type="password" id="k" placeholder="Viewer or admin key" autofocus><button class="btn" type="submit">Open</button></form></div>';
    document.getElementById('lf').onsubmit = function (e) { e.preventDefault(); setKey(document.getElementById('k').value.trim()); start(); };
  }

  function start() {
    if (!key()) return login();
    load(false).then(function () {
      clearInterval(state.timer);
      state.timer = setInterval(function () { if (!document.hidden) load(false); }, 30000);
    });
  }

  main.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'more') return load(true);
    if (b.classList.contains('toggle')) {
      var id = b.closest('article').getAttribute('data-id');
      if (state.expanded[id]) { delete state.expanded[id]; draw(); } else expand(id);
    }
  });
  document.getElementById('tabs').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    Array.prototype.forEach.call(document.querySelectorAll('#tabs button'), function (x) { x.classList.remove('on'); });
    b.classList.add('on'); state.status = b.getAttribute('data-status'); load(false);
  });
  document.getElementById('q').addEventListener('input', function (e) { state.q = e.target.value; draw(); });
  document.getElementById('refresh').addEventListener('click', function () { state.cache = {}; load(false); });
  document.getElementById('logout').addEventListener('click', function () { setKey(''); login(); });

  start();
})();
</script>
</body>
</html>`;
