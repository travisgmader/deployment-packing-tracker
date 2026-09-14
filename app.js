/* Deployment Packing Tracker — shared board backed by Supabase.
   One master list, live-synced; every signed-in member edits the same rows. */

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
    const unknown = /signups? not allowed|user not found/i.test(error.message);
    return note('#loginMsg', 'err', unknown
      ? `${email} isn't on the board yet. Ask Travis to add you, then try again.`
      : error.message);
  }
  note('#loginMsg', 'ok', `Check ${email} — the sign-in link is good for one hour. Open it on the device you want to track from.`);
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
}

function subscribe() {
  sb.channel('board')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'items' }, (p) => {
      if (p.eventType === 'DELETE') {
        state.items = state.items.filter((i) => i.id !== p.old.id);
      } else {
        const i = state.items.findIndex((x) => x.id === p.new.id);
        if (i >= 0) state.items[i] = p.new; else state.items.push(p.new);
        state.items.sort((a, b) => a.sort_order - b.sort_order);
      }
      render();
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'activity' }, (p) => {
      state.activity.unshift(p.new);
      state.activity = state.activity.slice(0, 80);
      if (state.tab === 'activity') render();
    })
    .subscribe((status) => {
      const live = status === 'SUBSCRIBED';
      $('#liveNote').innerHTML =
        `<span class="dot ${live ? '' : 'off'}"></span>${live ? 'live' : 'reconnecting…'}`;
    });
}

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
}

function summaryView() {
  const totals = state.lists.reduce((a, l) => {
    const t = tally(l); a.total += t.total; a.done += t.done; return a;
  }, { total: 0, done: 0 });
  const pct = totals.total ? totals.done / totals.total : 0;
  const R = 48, C = 2 * Math.PI * R;

  const packing = state.lists.filter((l) => l.kind === 'packing');
  const agg = {};
  packing.forEach((l) => {
    const t = tally(l);
    FLOW.packing.forEach((s) => { agg[s] = (agg[s] || 0) + t.counts[s]; });
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
      const segs = FLOW[l.kind].map((s) => t.counts[s]
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

function listView(list) {
  if (!list) return '<div class="card"><div class="empty">List not found.</div></div>';
  const flow = FLOW[list.kind];
  const q = state.search.toLowerCase();
  let rows = itemsOf(list.id);
  if (q) rows = rows.filter((i) =>
    (i.name + ' ' + (i.category || '') + ' ' + (i.notes || '')).toLowerCase().includes(q));
  if (state.filter === 'open') rows = rows.filter((i) => i.status !== DONE[list.kind]);
  else if (state.filter === 'done') rows = rows.filter((i) => i.status === DONE[list.kind]);

  const groups = [];
  rows.forEach((i) => {
    const key = i.category || 'Uncategorized';
    let g = groups.find((x) => x.key === key);
    if (!g) groups.push(g = { key, rows: [] });
    g.rows.push(i);
  });

  const t = tally(list);
  const body = groups.length ? groups.map((g) => `
    <div class="cat">${esc(g.key)}</div>
    ${g.rows.map((i) => {
      const done = i.status === DONE[list.kind];
      const qty = i.qty != null ? `<span class="qty">${(+i.qty) % 1 ? i.qty : +i.qty}${i.unit ? ' ' + esc(i.unit) : ''}</span>` : '';
      const flag = /^added from packing guide/i.test(i.notes || '');
      return `<div class="row ${done ? 'done' : ''}" data-id="${i.id}">
        <div class="nm">
          <b>${esc(i.name)}</b>${qty}
          ${i.notes ? `<span class="nt ${flag ? 'flag' : ''}">${esc(i.notes)}</span>` : ''}
        </div>
        <div class="rowacts">
          <button class="chip" data-s="${esc(i.status)}" data-act="cycle">${esc(i.status)}</button>
          <button class="iconbtn" data-act="edit" aria-label="Edit ${esc(i.name)}">✎</button>
        </div>
      </div>`;
    }).join('')}`).join('')
    : `<div class="empty">${q || state.filter !== 'all' ? 'Nothing matches that filter.' : 'No items yet.'}</div>`;

  return `
  <div class="card">
    <div class="listhead">
      <h1>${esc(list.name)} <span class="qty">${t.done}/${t.total} ${DONE[list.kind].toLowerCase()}</span></h1>
      <p>${esc(list.subtitle || '')}</p>
    </div>
    <div class="toolbar">
      <input type="text" id="search" placeholder="Search ${esc(list.name)}…" value="${esc(state.search)}">
      <div class="segs">
        <button data-filter="all"  aria-pressed="${state.filter === 'all'}">All</button>
        <button data-filter="open" aria-pressed="${state.filter === 'open'}">Open</button>
        <button data-filter="done" aria-pressed="${state.filter === 'done'}">${DONE[list.kind]}</button>
      </div>
      <button class="btn sm" data-act="add">+ Add</button>
    </div>
    ${body}
    <div class="addbar">
      <span class="qty">Tap a status chip to advance it: ${flow.join(' → ')} → back to ${flow[0]}.</span>
    </div>
  </div>`;
}

function activityView() {
  if (!state.activity.length)
    return '<div class="card"><div class="empty">No changes yet. Updates from everyone on the board show up here.</div></div>';
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
    else                            txt = `<b>${esc(a.actor_name)}</b> edited <b>${esc(a.item_name)}</b>`;
    const l = a.list_slug ? listBySlug(a.list_slug) : null;
    return `<div class="act">
      <time>${fmt(a.created_at)}</time>
      <div class="txt">${txt}${l ? ` <span class="qty">· ${esc(l.name)}</span>` : ''}</div>
    </div>`;
  }).join('')}</div>`;
}

/* ----------------------------------------------------------------- wiring */

function wire() {
  document.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => {
    state.tab = b.dataset.tab; state.search = ''; state.filter = 'all';
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
    row.querySelector('[data-act="cycle"]').onclick = () => {
      const flow = FLOW[list.kind];
      const next = flow[(flow.indexOf(item.status) + 1) % flow.length];
      patch(item.id, { status: next });
    };
    row.querySelector('[data-act="edit"]').onclick = () => openEdit(item, list);
  });

  const add = document.querySelector('[data-act="add"]');
  if (add) add.onclick = () => openEdit(null, listBySlug(state.tab));
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
  $('#qtyFields').hidden = list.kind === 'tasks';
  $('#f_del').hidden = !item;

  $('#f_status').innerHTML = FLOW[list.kind]
    .map((s) => `<option${s === (item?.status || FLOW[list.kind][0]) ? ' selected' : ''}>${s}</option>`).join('');
  $('#catlist').innerHTML = [...new Set(itemsOf(list.id).map((i) => i.category).filter(Boolean))]
    .map((c) => `<option value="${esc(c)}">`).join('');

  dlg.showModal();
  $('#f_name').focus();
}

$('#f_cancel').onclick = () => dlg.close();

$('#editForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const { item, list } = state.editing;
  const qtyRaw = $('#f_qty').value;
  const fields = {
    name: $('#f_name').value.trim(),
    category: $('#f_cat').value.trim(),
    status: $('#f_status').value,
    notes: $('#f_notes').value.trim() || null,
    unit: list.kind === 'tasks' ? null : ($('#f_unit').value.trim() || null),
    qty: list.kind === 'tasks' || qtyRaw === '' ? null : Number(qtyRaw),
  };
  if (!fields.name) return;
  dlg.close();

  if (item) {
    await patch(item.id, fields);
  } else {
    const last = itemsOf(list.id).reduce((m, i) => Math.max(m, i.sort_order), 0);
    const { error } = await sb.from('items')
      .insert({ ...fields, list_id: list.id, sort_order: last + 10 });
    if (error) return alert(error.message);
    await refresh(); render();
  }
});

$('#f_del').onclick = async () => {
  const { item } = state.editing;
  if (!confirm(`Delete "${item.name}" for everyone on the board?`)) return;
  dlg.close();
  const { error } = await sb.from('items').delete().eq('id', item.id);
  if (error) return alert(error.message);
  state.items = state.items.filter((i) => i.id !== item.id);
  render();
};

boot();
