/* Deployment Packing Tracker — boards backed by Supabase.
   Each member belongs to one board, live-synced with anyone else on it.
   Row-level security decides which board's rows a query returns. */

const sb = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY, {
  auth: {
    // Implicit flow puts the session in the URL fragment, so a link requested on
    // a laptop still works when it's opened on a phone. PKCE (the default) keeps
    // the verifier in localStorage and would break that very common case.
    flowType: 'implicit',
    // The magic-link callback is consumed by hand in boot() — supabase-js's own
    // fragment detection is version-sensitive and silently no-ops on 2.58.
    detectSessionInUrl: false,
    persistSession: true,
    autoRefreshToken: true,
  },
});
window.sb = sb;   // handy from the console

const FLOW = {
  packing: ['Need', 'Ordered', 'Prepped', 'Packed'],
  tasks:   ['To Do', 'In Progress', 'Done'],
};
const DONE = { packing: 'Packed', tasks: 'Done' };
// Moving between a bag and the admin checklist changes status vocabulary.
const CROSS = {
  tasks:   { 'Need': 'To Do', 'Ordered': 'In Progress', 'Prepped': 'In Progress', 'Packed': 'Done' },
  packing: { 'To Do': 'Need', 'In Progress': 'Ordered', 'Done': 'Packed' },
};
const statusFor = (status, toKind) =>
  FLOW[toKind].includes(status) ? status : (CROSS[toKind][status] || FLOW[toKind][0]);

const TONE = {
  'Need': 'need', 'To Do': 'need',
  'Ordered': 'ordered', 'In Progress': 'ordered',
  'Prepped': 'prepped',
  'Packed': 'packed', 'Done': 'packed',
};

// Standing guidance carried over from the spreadsheet's Summary tab.
const GUIDE = [
  "Uniforms: the guide wants 4 complete OCP sets (minimum 3). You're at 3 — one more if you want the buffer.",
  "A-Bag: Body Armor and Helmet are placeholders for issued IPE — confirm the exact list against your CRCs and orders. No personal items go in a mobility bag.",
  "Jackets: one MASSIF and one rain jacket, both in the A-Bag. Fleece stays on Long Term as its own cold-weather item.",
  "Power is Type G / 220V throughout. 'Power Converter' should be a Type G adapter set (3–4) plus a power strip — check the flat iron and diffuser labels.",
  "Bag limits: 2 checked bags at 70 lb / 62 linear in each, 1 carry-on at 45 linear in. Mobility bags fly as excess baggage; the A-bag stays with you in transit. Nothing ships ahead on MILAIR.",
  "Your CRCs and orders are the final authority — this list is a working aid, not a substitute.",
];

const state = {
  user: null, profile: null,
  lists: [], items: [], activity: [],
  tab: 'summary', search: '', filter: 'all',
  editing: null,
  selectMode: false,
  selected: new Set(),
};

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const listBySlug = (slug) => state.lists.find((l) => l.slug === slug);
const itemsOf = (listId) => state.items.filter((i) => i.list_id === listId);

function tally(list) {
  const rows = itemsOf(list.id);
  const flow = FLOW[list.kind];
  const counts = Object.fromEntries(flow.map((s) => [s, 0]));
  rows.forEach((i) => { if (counts[i.status] !== undefined) counts[i.status]++; });
  const done = counts[DONE[list.kind]] || 0;
  return { total: rows.length, counts, done, pct: rows.length ? done / rows.length : 0 };
}

/* ------------------------------------------------------------------ auth */

async function boot() {
  sb.auth.onAuthStateChange((evt, s) => {
    if (s?.user && !state.user) enter(s.user);
    else if (evt === 'SIGNED_OUT' && state.user) location.reload();
    else if (evt === 'TOKEN_REFRESHED' && s) sb.realtime.setAuth(s.access_token);
  });

  const claimed = await claimLinkFromUrl();
  if (claimed) return;

  const { data: { session } } = await sb.auth.getSession();
  if (session?.user) enter(session.user);
  else if (!state.user) showGate();
}

// A magic link lands as #access_token=…&refresh_token=… . Trade it for a stored
// session, then wipe the fragment so the tokens don't sit in the address bar.
async function claimLinkFromUrl() {
  if (!location.hash.includes('access_token')) return false;
  const p = new URLSearchParams(location.hash.slice(1));
  const { data, error } = await sb.auth.setSession({
    access_token: p.get('access_token'),
    refresh_token: p.get('refresh_token'),
  });
  history.replaceState(null, '', location.pathname + location.search);
  if (error || !data?.user) {
    showGate();
    note('#loginMsg', 'err', 'That sign-in link has expired. Request a fresh one below.');
    return true;
  }
  if (!state.user) enter(data.user);
  return true;
}

function showGate() {
  $('#gate').hidden = false;
  $('#app').hidden = true;
  // A magic-link callback lands with a #error= fragment when the link is stale.
  const frag = new URLSearchParams(location.hash.slice(1));
  if (frag.get('error_description')) {
    note('#loginMsg', 'err', decodeURIComponent(frag.get('error_description')).replace(/\+/g, ' '));
    history.replaceState(null, '', location.pathname + location.search);
  }
}

function note(sel, kind, text) {
  $(sel).innerHTML = `<div class="msg ${kind}">${esc(text)}</div>`;
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#loginBtn');
  const email = $('#email').value.trim();
  btn.disabled = true; btn.textContent = 'Sending…';
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: location.origin + location.pathname,
      shouldCreateUser: false,   // invite-only: signups are disabled project-wide
    },
  });
  btn.disabled = false; btn.textContent = 'Email me a sign-in link';
  if (error) {
    if (/signups? not allowed|user not found/i.test(error.message))
      return note('#loginMsg', 'err',
        `${email} isn't on the board yet. Ask Travis to add you, then try again.`);
    // The project sends through Supabase's built-in mailer, which allows only a
    // couple of messages an hour across everyone. Say so plainly — otherwise
    // this looks like the site is broken.
    if (/rate limit|too many requests/i.test(error.message) || error.status === 429)
      return note('#loginMsg', 'err',
        'Too many sign-in emails have gone out in the last hour — that limit is shared by everyone on the board. Wait an hour and try again, or ask Travis to send you a link directly.');
    return note('#loginMsg', 'err', error.message);
  }
  note('#loginMsg', 'ok', `Check ${email} — the link is good for one hour and works on any device. If it hasn't arrived in a few minutes, look in your spam folder before requesting another: only a couple of these can be sent per hour.`);
});

$('#signout').addEventListener('click', async () => {
  await sb.auth.signOut();
  location.reload();
});

async function enter(user) {
  state.user = user;
  $('#gate').hidden = true;
  $('#app').hidden = false;
  history.replaceState(null, '', location.pathname + location.search);

  const { data: prof } = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
  state.profile = prof;
  $('#whoami').textContent = prof?.display_name || user.email;

  await refresh();
  subscribe();
  render();
}

/* ------------------------------------------------------------------ data */

async function refresh() {
  const [lists, items, act] = await Promise.all([
    sb.from('lists').select('*').order('sort_order'),
    sb.from('items').select('*').order('sort_order'),
    sb.from('activity').select('*').order('created_at', { ascending: false }).limit(80),
  ]);
  state.lists = lists.data || [];
  state.items = items.data || [];
  state.activity = act.data || [];
  lastSync = Date.now();
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

let boardChannel = null;
let channelGen = 0;
let retryTimer = null;
let lastSync = 0;

function setLive(live) {
  $('#liveNote').innerHTML =
    `<span class="dot ${live ? '' : 'off'}"></span>${live ? 'live' : 'reconnecting…'}`;
}

function subscribe() {
  clearTimeout(retryTimer);
  // Drop the old channel first, and forget it before it reports CLOSED, so its
  // own callback can't schedule yet another rebuild.
  const old = boardChannel;
  boardChannel = null;
  if (old) sb.removeChannel(old);

  // A fresh topic each time: the client can hand back a same-named channel
  // that is still shutting down.
  const ch = sb.channel(`board-${++channelGen}`);
  boardChannel = ch;
  ch
    .on('postgres_changes', { event: '*', schema: 'public', table: 'items' }, (p) => {
      if (p.eventType === 'DELETE') {
        state.items = state.items.filter((i) => i.id !== p.old.id);
      } else {
        const i = state.items.findIndex((x) => x.id === p.new.id);
        if (i >= 0) state.items[i] = p.new; else state.items.push(p.new);
        state.items.sort((a, b) => a.sort_order - b.sort_order);
      }
      scheduleRender();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'lists' }, (p) => {
      if (p.eventType === 'DELETE') {
        const gone = state.lists.find((l) => l.id === p.old.id);
        state.lists = state.lists.filter((l) => l.id !== p.old.id);
        state.items = state.items.filter((i) => i.list_id !== p.old.id);
        if (gone && state.tab === gone.slug) leaveTab();
      } else {
        const i = state.lists.findIndex((l) => l.id === p.new.id);
        if (i >= 0) state.lists[i] = p.new; else state.lists.push(p.new);
        state.lists.sort((a, b) => a.sort_order - b.sort_order);
      }
      scheduleRender();
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'activity' }, (p) => {
      state.activity.unshift(p.new);
      state.activity = state.activity.slice(0, 80);
      if (state.tab === 'activity') scheduleRender();
    })
    .subscribe(async (status) => {
      if (ch !== boardChannel) return;          // a channel we've already replaced
      setLive(status === 'SUBSCRIBED');
      if (status === 'SUBSCRIBED') {
        if (Date.now() - lastSync > 2000) { await refresh(); render(); }
      } else if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) {
        // The server closes a channel whose sign-in token lapsed, and the client
        // does not rejoin it by itself — the board would silently stop updating.
        clearTimeout(retryTimer);
        retryTimer = setTimeout(subscribe, 3000);
      }
    });
}

// A phone that slept may have lost its channel, or missed changes while dark.
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !state.user) return;
  if (boardChannel?.state !== 'joined') subscribe();
  else if (Date.now() - lastSync > 60000) { await refresh(); render(); }
});

async function patch(id, fields) {
  const row = state.items.find((i) => i.id === id);
  const before = { ...row };
  Object.assign(row, fields);            // optimistic — realtime confirms
  render();
  const { error } = await sb.from('items').update(fields).eq('id', id);
  if (error) { Object.assign(row, before); render(); alert(error.message); }
}

/* ---------------------------------------------------------------- render */

function render() {
  renderTabs();
  const v = $('#view');
  if (state.tab === 'summary') v.innerHTML = summaryView();
  else if (state.tab === 'activity') v.innerHTML = activityView();
  else v.innerHTML = listView(listBySlug(state.tab));
  wire();
}

function renderTabs() {
  const tabs = [`<button data-tab="summary" aria-current="${state.tab === 'summary'}">Summary</button>`];
  state.lists.forEach((l) => {
    const t = tally(l);
    const cls = t.total && t.done === t.total ? ' done' : '';
    tabs.push(`<button data-tab="${l.slug}" aria-current="${state.tab === l.slug}">${esc(l.name)}` +
      `<span class="pill${cls}">${t.done}/${t.total}</span></button>`);
  });
  tabs.push(`<button data-tab="activity" aria-current="${state.tab === 'activity'}">Activity</button>`);
  $('#tabs').innerHTML = tabs.join('');
  // On a phone the strip scrolls; keep the tab you're on in view.
  $('#tabs').querySelector('[aria-current="true"]')
    ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function summaryView() {
  const totals = state.lists.reduce((a, l) => {
    const t = tally(l); a.total += t.total; a.done += t.done; return a;
  }, { total: 0, done: 0 });
  const pct = totals.total ? totals.done / totals.total : 0;
  const R = 48, C = 2 * Math.PI * R;

  // Fold both vocabularies into one legend so the numbers add up to the headline.
  const SAME = { 'To Do': 'Need', 'In Progress': 'Ordered', 'Done': 'Packed' };
  const agg = Object.fromEntries(FLOW.packing.map((s) => [s, 0]));
  state.lists.forEach((l) => {
    const t = tally(l);
    FLOW[l.kind].forEach((s) => { agg[SAME[s] || s] += t.counts[s]; });
  });

  return `
  <div class="card">
    <div class="overall">
      <div class="ring">
        <svg viewBox="0 0 110 110">
          <circle cx="55" cy="55" r="${R}" fill="none" stroke="var(--line-soft)" stroke-width="9"/>
          <circle cx="55" cy="55" r="${R}" fill="none" stroke="var(--accent)" stroke-width="9"
            stroke-linecap="round" stroke-dasharray="${C}"
            stroke-dashoffset="${C * (1 - pct)}"/>
        </svg>
        <div class="val"><b>${Math.round(pct * 100)}%</b><span>ready</span></div>
      </div>
      <div class="overall-txt">
        <h1>${totals.done} of ${totals.total} done</h1>
        <p>${totals.total - totals.done} item${totals.total - totals.done === 1 ? '' : 's'} still open across every bag and the admin checklist.</p>
        <div class="legend">
          ${FLOW.packing.map((s) => `<i style="background:var(--${TONE[s]}-bg);color:var(--${TONE[s]})">${s} ${agg[s] || 0}</i>`).join('')}
        </div>
      </div>
    </div>
  </div>

  <h2 class="sec">Bags &amp; checklists</h2>
  <div class="grid">
    ${state.lists.map((l) => {
      const t = tally(l);
      // Skip the first status: "Need"/"To Do" is the empty track, not progress.
      const segs = FLOW[l.kind].slice(1).map((s) => t.counts[s]
        ? `<i style="width:${(t.counts[s] / t.total) * 100}%;background:var(--${TONE[s]})"></i>` : '').join('');
      return `<button class="bagcard" data-tab="${l.slug}">
        <h3>${esc(l.name)}</h3>
        <div class="sub">${t.total} ${l.kind === 'tasks' ? 'tasks' : 'items'}</div>
        <div class="bar">${segs}</div>
        <div class="pct"><span>${t.done} ${DONE[l.kind].toLowerCase()}</span><b>${Math.round(t.pct * 100)}%</b></div>
      </button>`;
    }).join('')}
  </div>

  <h2 class="sec">Worth remembering</h2>
  <div class="card guide">
    <ul>${GUIDE.map((g) => `<li>${esc(g)}</li>`).join('')}</ul>
  </div>`;
}

// The rows currently on screen, after search and filter.
function visibleRows(list) {
  const q = state.search.toLowerCase();
  let rows = itemsOf(list.id);
  if (q) rows = rows.filter((i) =>
    (i.name + ' ' + (i.category || '') + ' ' + (i.notes || '')).toLowerCase().includes(q));
  if (state.filter === 'open') rows = rows.filter((i) => i.status !== DONE[list.kind]);
  else if (state.filter === 'done') rows = rows.filter((i) => i.status === DONE[list.kind]);
  return rows;
}

function listView(list) {
  if (!list) return '<div class="card"><div class="empty">List not found.</div></div>';
  const flow = FLOW[list.kind];
  const q = state.search.toLowerCase();
  const rows = visibleRows(list);

  const groups = [];
  rows.forEach((i) => {
    const key = i.category || 'Uncategorized';
    let g = groups.find((x) => x.key === key);
    if (!g) groups.push(g = { key, rows: [] });
    g.rows.push(i);
  });

  const t = tally(list);
  const allPicked = rows.length > 0 && rows.every((i) => state.selected.has(i.id));
  const body = groups.length ? groups.map((g) => `
    <div class="cat">${esc(g.key)}</div>
    ${g.rows.map((i) => {
      const done = i.status === DONE[list.kind];
      const qty = i.qty != null ? `<span class="qty">${(+i.qty) % 1 ? i.qty : +i.qty}${i.unit ? ' ' + esc(i.unit) : ''}</span>` : '';
      const flag = /^added from packing guide/i.test(i.notes || '');
      const picked = state.selected.has(i.id);
      return `<div class="row ${done ? 'done' : ''} ${state.selectMode ? 'picking' : ''} ${picked ? 'picked' : ''}" data-id="${i.id}">
        ${state.selectMode ? `<span class="tick" aria-hidden="true">${picked ? '✓' : ''}</span>` : ''}
        <div class="nm">
          <b>${esc(i.name)}</b>${qty}
          ${i.notes ? `<span class="nt ${flag ? 'flag' : ''}">${esc(i.notes)}</span>` : ''}
        </div>
        ${state.selectMode ? '' : `<div class="rowacts">
          <button class="chip" data-s="${esc(i.status)}" data-act="cycle">${esc(i.status)}</button>
          <button class="iconbtn" data-act="edit" aria-label="Edit ${esc(i.name)}">✎</button>
          <button class="iconbtn danger" data-act="del" aria-label="Delete ${esc(i.name)}">🗑</button>
        </div>`}
      </div>`;
    }).join('')}`).join('')
    : `<div class="empty">${q || state.filter !== 'all' ? 'Nothing matches that filter.' : 'No items yet.'}</div>`;

  return `
  <div class="card">
    <div class="listhead">
      <div class="listhead-top">
        <h1>${esc(list.name)} <span class="qty">${t.done}/${t.total} ${DONE[list.kind].toLowerCase()}</span></h1>
        <div class="listacts">
          <button class="btn sm ghost" data-act="editlist">✎ Rename</button>
          <button class="btn sm ghost danger-text" data-act="dellist">🗑 Delete list</button>
        </div>
      </div>
      <p>${esc(list.subtitle || '')}</p>
    </div>
    <div class="toolbar">
      <input type="text" id="search" placeholder="Search ${esc(list.name)}…" value="${esc(state.search)}">
      <div class="segs">
        <button data-filter="all"  aria-pressed="${state.filter === 'all'}">All</button>
        <button data-filter="open" aria-pressed="${state.filter === 'open'}">Open</button>
        <button data-filter="done" aria-pressed="${state.filter === 'done'}">${DONE[list.kind]}</button>
      </div>
      <button class="btn sm ghost" data-act="selectmode">${state.selectMode ? 'Done' : 'Select'}</button>
      <button class="btn sm" data-act="add">+ Add</button>
    </div>
    ${state.selectMode ? `<div class="selbar">
      <span class="selcount">${state.selected.size} selected</span>
      <button class="btn sm ghost" data-act="selectall">${allPicked ? 'Clear all' : `Select all ${rows.length}`}</button>
      <select class="movesel" data-act="movesel" ${state.selected.size ? '' : 'disabled'} aria-label="Move selected items to">
        <option value="">Move to…</option>
        ${state.lists.filter((l) => l.id !== list.id).map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}
      </select>
      <button class="btn sm danger-btn" data-act="delsel" ${state.selected.size ? '' : 'disabled'}>Delete</button>
    </div>` : ''}
    ${body}
    <div class="addbar">
      <span class="qty">${state.selectMode
        ? 'Tap rows to select them, then Move or Delete. Deleting can\'t be undone.'
        : `Tap a status chip to advance it: ${flow.join(' → ')} → back to ${flow[0]}.`}</span>
    </div>
  </div>`;
}

function activityView() {
  if (!state.activity.length)
    return '<div class="card"><div class="empty">No changes yet. Updates to this list show up here.</div></div>';
  const fmt = (ts) => {
    const d = new Date(ts), now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    return sameDay
      ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };
  return `<div class="card">${state.activity.map((a) => {
    let txt;
    if (a.action === 'status')
      txt = `<b>${esc(a.actor_name)}</b> moved <b>${esc(a.item_name)}</b> to <span class="s" data-s="${esc(a.to_status)}">${esc(a.to_status)}</span>`;
    else if (a.action === 'add')    txt = `<b>${esc(a.actor_name)}</b> added <b>${esc(a.item_name)}</b>`;
    else if (a.action === 'delete') txt = `<b>${esc(a.actor_name)}</b> removed <b>${esc(a.item_name)}</b>`;
    else if (a.action === 'list_rename')
      txt = `<b>${esc(a.actor_name)}</b> renamed the list <b>${esc(a.detail)}</b> to <b>${esc(a.item_name)}</b>`;
    else if (a.action === 'list_edit')
      txt = `<b>${esc(a.actor_name)}</b> edited the description of <b>${esc(a.item_name)}</b>`;
    else if (a.action === 'list_delete')
      txt = `<b>${esc(a.actor_name)}</b> deleted the list <b>${esc(a.item_name)}</b>${a.detail ? ` and its ${esc(a.detail)}` : ''}`;
    else if (a.action === 'move') {
      const from = a.from_list ? listBySlug(a.from_list) : null;
      txt = `<b>${esc(a.actor_name)}</b> moved <b>${esc(a.item_name)}</b>${from ? ` from ${esc(from.name)}` : ''} to`;
    }
    else                            txt = `<b>${esc(a.actor_name)}</b> edited <b>${esc(a.item_name)}</b>`;
    const l = a.list_slug && !a.action.startsWith('list_') ? listBySlug(a.list_slug) : null;
    return `<div class="act">
      <time>${fmt(a.created_at)}</time>
      <div class="txt">${txt}${l ? (a.action === 'move' ? ` <b>${esc(l.name)}</b>` : ` <span class="qty">· ${esc(l.name)}</span>`) : ''}</div>
    </div>`;
  }).join('')}</div>`;
}

/* ----------------------------------------------------------------- wiring */

function wire() {
  document.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => {
    state.tab = b.dataset.tab; state.search = ''; state.filter = 'all';
    state.selectMode = false; state.selected.clear();
    window.scrollTo(0, 0); render();
  });

  const s = $('#search');
  if (s) {
    s.oninput = () => {
      state.search = s.value;
      render();
      const n = $('#search'); n.focus(); n.setSelectionRange(n.value.length, n.value.length);
    };
  }
  document.querySelectorAll('[data-filter]').forEach((b) => b.onclick = () => {
    state.filter = b.dataset.filter; render();
  });

  document.querySelectorAll('.row').forEach((row) => {
    const item = state.items.find((i) => i.id === row.dataset.id);
    const list = state.lists.find((l) => l.id === item.list_id);

    if (state.selectMode) {
      // The whole row is the hit target while selecting — easier on a phone.
      row.onclick = () => {
        state.selected.has(item.id) ? state.selected.delete(item.id)
                                    : state.selected.add(item.id);
        render();
      };
      return;
    }

    row.querySelector('[data-act="cycle"]').onclick = () => {
      const flow = FLOW[list.kind];
      const next = flow[(flow.indexOf(item.status) + 1) % flow.length];
      patch(item.id, { status: next });
    };
    row.querySelector('[data-act="edit"]').onclick = () => openEdit(item, list);
    row.querySelector('[data-act="del"]').onclick = () => removeItems([item]);
  });

  const on = (act, fn) => {
    const el = document.querySelector(`[data-act="${act}"]`);
    if (el) el.onclick = fn;
  };
  on('add', () => openEdit(null, listBySlug(state.tab)));
  on('editlist', () => openListEdit(listBySlug(state.tab)));
  on('dellist', () => deleteList(listBySlug(state.tab)));
  on('selectmode', () => {
    state.selectMode = !state.selectMode;
    state.selected.clear();
    render();
  });
  on('selectall', () => {
    const list = listBySlug(state.tab);
    const shown = visibleRows(list);
    const allPicked = shown.length > 0 && shown.every((i) => state.selected.has(i.id));
    shown.forEach((i) => allPicked ? state.selected.delete(i.id) : state.selected.add(i.id));
    render();
  });
  const mv = document.querySelector('[data-act="movesel"]');
  if (mv) mv.onchange = () => {
    const target = state.lists.find((l) => l.id === mv.value);
    const picked = state.items.filter((i) => state.selected.has(i.id));
    if (target && picked.length) moveItems(picked, target);
  };
  on('delsel', () => {
    const picked = state.items.filter((i) => state.selected.has(i.id));
    if (picked.length) removeItems(picked);
  });
}

// Append to the end of the target list, keeping the items' relative order and
// translating status if they cross between a bag and the checklist.
async function moveItems(items, target) {
  const before = items.map((i) => ({ ...i }));
  let last = itemsOf(target.id).reduce((m, i) => Math.max(m, i.sort_order), 0);
  const updates = [...items]
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((i) => ({
      id: i.id,
      fields: { list_id: target.id, status: statusFor(i.status, target.kind), sort_order: (last += 10) },
    }));

  updates.forEach(({ id, fields }) => Object.assign(state.items.find((i) => i.id === id), fields));
  state.items.sort((a, b) => a.sort_order - b.sort_order);
  state.selected.clear();
  render();

  const results = await Promise.all(updates.map(({ id, fields }) =>
    sb.from('items').update(fields).eq('id', id)));
  const failed = results.find((r) => r.error);
  if (failed) {
    before.forEach((b) => Object.assign(state.items.find((i) => i.id === b.id) || {}, b));
    render();
    alert(failed.error.message);
  }
}

// One confirmation, whether it's a single row or a whole selection.
async function removeItems(items) {
  const what = items.length === 1
    ? `"${items[0].name}"`
    : `${items.length} items`;
  if (!confirm(`Delete ${what}? This can't be undone.`)) return;

  const ids = items.map((i) => i.id);
  const keep = state.items;
  state.items = state.items.filter((i) => !state.selected.has(i.id) && !ids.includes(i.id));
  state.selected.clear();
  render();

  const { error } = await sb.from('items').delete().in('id', ids);
  if (error) {
    state.items = keep;                 // put them back if the server refused
    render();
    alert(error.message);
  }
}

/* ------------------------------------------------------------ edit modal */

const dlg = $('#editDlg');

function openEdit(item, list) {
  state.editing = { item, list };
  $('#editTitle').textContent = item ? 'Edit item' : `Add to ${list.name}`;
  $('#f_name').value = item?.name || '';
  $('#f_cat').value = item?.category || '';
  $('#f_qty').value = item?.qty ?? '';
  $('#f_unit').value = item?.unit || '';
  $('#f_notes').value = item?.notes || '';
  $('#f_del').hidden = !item;

  $('#f_list').innerHTML = state.lists
    .map((l) => `<option value="${l.id}"${l.id === list.id ? ' selected' : ''}>${esc(l.name)}</option>`).join('');
  syncModalToList(item?.status || FLOW[list.kind][0]);

  dlg.showModal();
  $('#f_name').focus();
}

// Status options, qty fields and category suggestions follow the chosen list.
function syncModalToList(status) {
  const target = state.lists.find((l) => l.id === $('#f_list').value);
  const wanted = statusFor(status, target.kind);
  $('#qtyFields').hidden = target.kind === 'tasks';
  $('#f_status').innerHTML = FLOW[target.kind]
    .map((s) => `<option${s === wanted ? ' selected' : ''}>${s}</option>`).join('');
  $('#catlist').innerHTML = [...new Set(itemsOf(target.id).map((i) => i.category).filter(Boolean))]
    .map((c) => `<option value="${esc(c)}">`).join('');
}
$('#f_list').onchange = () => syncModalToList($('#f_status').value);

$('#f_cancel').onclick = () => dlg.close();

$('#editForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const { item } = state.editing;
  const target = state.lists.find((l) => l.id === $('#f_list').value);
  const qtyRaw = $('#f_qty').value;
  const fields = {
    name: $('#f_name').value.trim(),
    category: $('#f_cat').value.trim(),
    status: $('#f_status').value,
    notes: $('#f_notes').value.trim() || null,
    unit: target.kind === 'tasks' ? null : ($('#f_unit').value.trim() || null),
    qty: target.kind === 'tasks' || qtyRaw === '' ? null : Number(qtyRaw),
  };
  if (!fields.name) return;
  dlg.close();

  const endOf = (l) => itemsOf(l.id).reduce((m, i) => Math.max(m, i.sort_order), 0) + 10;
  if (item) {
    if (target.id !== item.list_id) Object.assign(fields, { list_id: target.id, sort_order: endOf(target) });
    await patch(item.id, fields);
  } else {
    const { error } = await sb.from('items')
      .insert({ ...fields, list_id: target.id, sort_order: endOf(target) });
    if (error) return alert(error.message);
    await refresh(); render();
  }
});

$('#f_del').onclick = () => {
  const { item } = state.editing;
  dlg.close();
  removeItems([item]);
};

/* ------------------------------------------------------------ list editor */

const listDlg = $('#listDlg');
let editingList = null;

function leaveTab() {
  state.tab = 'summary';
  state.selectMode = false;
  state.selected.clear();
}

function openListEdit(list) {
  editingList = list;
  $('#l_name').value = list.name;
  $('#l_sub').value = list.subtitle || '';
  listDlg.showModal();
  $('#l_name').select();
}

$('#l_cancel').onclick = () => listDlg.close();

$('#listForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const list = editingList;
  const fields = { name: $('#l_name').value.trim(), subtitle: $('#l_sub').value.trim() || null };
  if (!fields.name) return;
  listDlg.close();
  if (fields.name === list.name && fields.subtitle === (list.subtitle || null)) return;

  const before = { ...list };
  Object.assign(list, fields);
  render();
  const { error } = await sb.from('lists').update(fields).eq('id', list.id);
  if (error) { Object.assign(list, before); render(); alert(error.message); }
});

$('#l_del').onclick = () => {
  const list = editingList;
  listDlg.close();
  deleteList(list);
};

// One confirmation. The list's items go with it, so say how many.
async function deleteList(list) {
  const n = itemsOf(list.id).length;
  const what = n === 0 ? 'It has no items.' : n === 1 ? 'Its 1 item will be deleted too.' : `All ${n} items in it will be deleted too.`;
  if (!confirm(`Delete the "${list.name}" list for everyone on the board? ${what} This can't be undone.\n\nTo keep some items, cancel and use Select → Move to first.`)) return;

  const keepLists = state.lists, keepItems = state.items, keepTab = state.tab;
  state.lists = state.lists.filter((l) => l.id !== list.id);
  state.items = state.items.filter((i) => i.list_id !== list.id);
  if (state.tab === list.slug) leaveTab();
  render();

  const { error } = await sb.from('lists').delete().eq('id', list.id);
  if (error) {
    state.lists = keepLists; state.items = keepItems; state.tab = keepTab;
    render();
    alert(error.message);
  }
}

boot();
