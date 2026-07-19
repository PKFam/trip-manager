// app.js — UI logic. Reads/writes only through Store; converts only through Currency.
// $, el, reducedMotion come from util.js (loaded first).

const state = {
  settings: null,
  currencies: [],
  rates: {},
  categories: [],
  expenses: [],
  itinerary: [],
  addCategoryId: null,
  addMode: 'paid',        // 'paid' | 'committed'
  expanded: null,         // Set of expanded parent category ids
  editingId: null,        // expense id open in the edit sheet
  editCategoryId: null,
  tab: 'home',
};

async function loadAll() {
  state.settings = await Store.getSettings();
  state.currencies = await Store.getCurrencies();
  state.rates = await Store.getRates();
  state.categories = await Store.getCategories();
  state.expenses = await Store.getExpenses();
  state.itinerary = await Store.getItinerary();
}

// ---------- money helpers ----------
const disp = () => state.settings.displayCurrency;
// Dashboard money is rounded to whole units — the sub-unit "cents" on
// currency-converted totals are conversion noise, not information. (The
// ledger still shows each transaction's exact entered amount.)
const fmtBase = (baseAmount) =>
  Currency.format(Math.round(Currency.fromBase(baseAmount, disp(), state.rates)), disp(), state.currencies);

// ---------- category tree + aggregation ----------
function buildTree() {
  const cats = state.categories;
  const childrenMap = {};
  cats.forEach((c) => {
    const p = c.parentId || '__root';
    (childrenMap[p] = childrenMap[p] || []).push(c);
  });
  const isLeaf = (c) => !childrenMap[c.id];

  const leafCommitted = {}, leafPaid = {};
  cats.forEach((c) => { leafCommitted[c.id] = 0; leafPaid[c.id] = 0; });
  state.expenses.forEach((e) => {
    if (leafCommitted[e.categoryId] !== undefined) {
      leafCommitted[e.categoryId] += Number(e.baseAmount);
      leafPaid[e.categoryId] += Number(e.paidBase);
    }
  });

  const budget = {}, committed = {}, paid = {};
  function calc(c) {
    if (isLeaf(c)) {
      budget[c.id] = Number(c.budget) || 0;
      committed[c.id] = leafCommitted[c.id] || 0;
      paid[c.id] = leafPaid[c.id] || 0;
    } else {
      let b = 0, cm = leafCommitted[c.id] || 0, pd = leafPaid[c.id] || 0;
      childrenMap[c.id].forEach((ch) => { calc(ch); b += budget[ch.id]; cm += committed[ch.id]; pd += paid[ch.id]; });
      budget[c.id] = b; committed[c.id] = cm; paid[c.id] = pd;
    }
  }
  (childrenMap.__root || []).forEach(calc);
  return { childrenMap, isLeaf, budget, committed, paid, roots: childrenMap.__root || [] };
}

function leafCategories() {
  const parentIds = new Set(state.categories.filter((c) => c.parentId).map((c) => c.parentId));
  return state.categories.filter((c) => !parentIds.has(c.id));
}
const catById = (id) => state.categories.find((c) => c.id === id);
function catLabel(c) {
  if (!c) return '?';
  const p = c.parentId ? catById(c.parentId) : null;
  return p ? `${p.name} · ${c.name}` : c.name;
}
function catIcon(c) { return (c && c.icon) || '🏷️'; }
function iconBox(c, size) {
  const color = c ? c.color : '#5b7cfa';
  const s = size ? `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.54)}px;border-radius:${Math.round(size * 0.3)}px;` : '';
  return `<span class="icobox" style="--ic:${color};${s}">${catIcon(c)}</span>`;
}

// ---------- gradient bar segments ----------
// ---------- count-up numbers ----------
function setMoney(elm, baseAmount) {
  const target = Currency.fromBase(baseAmount, disp(), state.rates);
  const prev = Number(elm.dataset.val || 0);
  elm.dataset.val = target;
  const fmt = (v) => Currency.format(Math.round(v), disp(), state.currencies);
  if (reducedMotion || Math.abs(target - prev) < 0.5) {
    elm.textContent = fmt(target);
    return;
  }
  const t0 = performance.now(), dur = 450;
  const final = () => { elm.textContent = fmt(target); };
  // failsafe: rAF can be throttled (background tab) — always land on the exact value
  const guard = setTimeout(final, dur + 120);
  (function tick(t) {
    const p = Math.min((t - t0) / dur, 1);
    const eased = 1 - Math.pow(1 - p, 3);
    elm.textContent = fmt(prev + (target - prev) * eased);
    if (p < 1) requestAnimationFrame(tick);
    else { clearTimeout(guard); final(); }
  })(t0);
}

// ================= HERO + BRIEF =================
function renderHero() {
  $('#heroTitle').textContent = state.settings.tripName;
  $('#heroDates').textContent = state.settings.tripDates || '';
  $('#heroDate').textContent = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long',
  });
  const art = $('#heroArt');
  if (state.settings.bannerImage) {
    art.innerHTML = `<img src="${state.settings.bannerImage}" alt="" />`;
  } else if (!art.querySelector('svg')) {
    location.reload(); // default SVG lives in the HTML; simplest restore after clearing a photo
  }
}

// Today's itinerary stop = the latest stop whose date is <= today (or the first stop).
function currentStop() {
  if (!state.itinerary.length) return null;
  const today = new Date().toISOString().slice(0, 10);
  let cur = state.itinerary[0];
  for (const s of state.itinerary) { if (s.date <= today) cur = s; }
  return cur;
}

// WMO weather code → tiny inline SVG icon
function weatherIcon(code) {
  const sun = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="4.4" fill="#f5b301"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.5 4.5l2 2M17.5 17.5l2 2M19.5 4.5l-2 2M6.5 17.5l-2 2" stroke="#f5b301" stroke-width="1.8" stroke-linecap="round"/></svg>';
  const cloud = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M6 18a4 4 0 1 1 .6-7.96A5.5 5.5 0 0 1 17.3 9.2 3.8 3.8 0 0 1 17 18H6Z" fill="#9aa6d0"/></svg>';
  const rain = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M6 15a4 4 0 1 1 .6-7.96A5.5 5.5 0 0 1 17.3 6.2 3.8 3.8 0 0 1 17 15H6Z" fill="#9aa6d0"/><path d="M8 18l-1 3M13 18l-1 3M18 18l-1 3" stroke="#5b7cfa" stroke-width="1.8" stroke-linecap="round"/></svg>';
  const snow = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M6 15a4 4 0 1 1 .6-7.96A5.5 5.5 0 0 1 17.3 6.2 3.8 3.8 0 0 1 17 15H6Z" fill="#9aa6d0"/><circle cx="8" cy="19" r="1.2" fill="#5b7cfa"/><circle cx="13" cy="21" r="1.2" fill="#5b7cfa"/><circle cx="17" cy="19" r="1.2" fill="#5b7cfa"/></svg>';
  const storm = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M6 14a4 4 0 1 1 .6-7.96A5.5 5.5 0 0 1 17.3 5.2 3.8 3.8 0 0 1 17 14H6Z" fill="#9aa6d0"/><path d="M12 14l-2.5 4h3L10 22" stroke="#f5b301" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  if (code === 0) return sun;
  if (code <= 3 || code === 45 || code === 48) return cloud;
  if (code >= 95) return storm;
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return snow;
  return rain;
}

async function renderBrief() {
  const stop = currentStop();
  const strip = $('#briefStrip');
  if (!stop) { strip.hidden = true; return; }
  strip.hidden = false;
  $('#briefText').textContent = stop.line || `Currently in ${stop.place}.`;
  const w = $('#briefWeather');
  w.innerHTML = `<span>${escapeHtml(stop.place)}</span>`;

  // cache weather 30 min so the strip works offline-ish and doesn't spam the API
  const cacheKey = 'tripbudget:weathercache';
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
    let data = (cached && cached.lat === stop.lat && Date.now() - cached.at < 30 * 60e3) ? cached.data : null;
    if (!data) {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${stop.lat}&longitude=${stop.lon}&current_weather=true&daily=weathercode,temperature_2m_max,temperature_2m_min&forecast_days=3&timezone=auto`;
      const res = await fetch(url);
      if (!res.ok) throw new Error('weather http ' + res.status);
      data = await res.json();
      localStorage.setItem(cacheKey, JSON.stringify({ lat: stop.lat, at: Date.now(), data }));
    }
    const cur = data.current_weather;
    if (cur) {
      w.innerHTML = `${weatherIcon(cur.weathercode)}<span>${Math.round(cur.temperature)}°</span><span style="font-weight:600;color:var(--ink-soft)">${escapeHtml(stop.place)}</span>`;
    }
  } catch (e) {
    // offline or API hiccup — strip still shows place + brief line
    console.warn('weather unavailable', e);
  }
}

// ---------- overspend-aware bar ----------
// Within budget: bar scale = budget (classic fill).
// Over budget: bar RESCALES so the full committed amount fits; a white tick
// marks where the original budget ends, and only the chunk beyond it is red.
function barSegs(budgetB, committedB, paidB, color) {
  const over = committedB > budgetB;
  const scale = Math.max(over ? committedB : budgetB, 0.0001);
  const pct = (x) => Math.min(Math.max(x / scale, 0) * 100, 100);
  const grad = `linear-gradient(135deg, ${color}, color-mix(in srgb, ${color} 62%, #1e2440))`;
  const inBudgetCommitted = Math.min(committedB, budgetB);
  const inBudgetPaid = Math.min(paidB, budgetB);
  let html = `
    <div class="bar__seg bar__seg--committed" style="width:${pct(inBudgetCommitted)}%;background:${color}"></div>
    <div class="bar__seg bar__seg--paid" style="width:${pct(inBudgetPaid)}%;background:${grad}"></div>`;
  if (over) {
    const edge = pct(budgetB);
    html += `
    <div class="bar__seg bar__seg--over" style="left:${edge}%;width:${pct(committedB) - edge}%"></div>
    <div class="bar__tick" style="left:${edge}%"></div>`;
  }
  return html;
}

// ================= DASHBOARD =================
function renderDashboard() {
  const t = buildTree();
  if (state.expanded === null) state.expanded = new Set(Object.keys(t.childrenMap).filter((x) => x !== '__root'));

  const totalBudget = t.roots.reduce((s, c) => s + t.budget[c.id], 0);
  const totalCommitted = t.roots.reduce((s, c) => s + t.committed[c.id], 0);
  const totalPaid = t.roots.reduce((s, c) => s + t.paid[c.id], 0);
  const totalLeft = totalBudget - totalCommitted;

  state.heroVals = { committed: totalCommitted, left: totalLeft };
  renderHeroMoney(false);
  setMoney($('#statBudget'), totalBudget);
  setMoney($('#statPaid'), totalPaid);
  setMoney($('#statOutstanding'), totalCommitted - totalPaid);
  $('#totalBar').innerHTML = barSegs(totalBudget, totalCommitted, totalPaid, '#5b7cfa');

  const list = $('#categoryList');
  list.innerHTML = '';
  for (const c of t.roots) {
    const hasKids = !t.isLeaf(c);
    const b = t.budget[c.id], cm = t.committed[c.id], pd = t.paid[c.id];
    const left = b - cm;
    const open = state.expanded.has(c.id);

    const card = el('div', 'cat');
    card.innerHTML = `
      <div class="cat__head">
        <div class="cat__name ${hasKids ? 'expandable' : ''}" ${hasKids ? `data-toggle="${c.id}"` : ''}>
          ${hasKids ? `<span class="cat__chev ${open ? 'open' : ''}">▸</span>` : ''}
          ${iconBox(c)}<span>${escapeHtml(c.name)}</span>
        </div>
        <div class="cat__nums"><b>${fmtBase(cm)}</b> / ${fmtBase(b)}</div>
      </div>
      <div class="bar">${barSegs(b, cm, pd, c.color)}</div>
      <div class="cat__foot">
        <span class="cat__paid">Paid <b>${fmtBase(pd)}</b></span>
        <span class="cat__left ${left < 0 ? 'is-over' : ''}">${left < 0 ? 'Over ' + fmtBase(-left) : fmtBase(left) + ' left'}</span>
      </div>
      ${hasKids && open ? renderSubs(c, t) : ''}`;
    list.appendChild(card);
  }

  list.querySelectorAll('[data-toggle]').forEach((n) => {
    n.onclick = () => {
      const id = n.dataset.toggle;
      if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id);
      renderDashboard();
    };
  });

  renderDonut();
}

function renderSubs(parent, t) {
  const kids = t.childrenMap[parent.id] || [];
  let html = '<div class="subs">';
  for (const k of kids) {
    const b = t.budget[k.id], cm = t.committed[k.id], pd = t.paid[k.id];
    html += `
      <div class="sub">
        <div class="sub__head">
          <span class="sub__name">${iconBox(k, 22)}${escapeHtml(k.name)}</span>
          <span class="sub__nums"><b>${fmtBase(cm)}</b> / ${fmtBase(b)}</span>
        </div>
        <div class="bar">${barSegs(b, cm, pd, k.color)}</div>
      </div>`;
  }
  return html + '</div>';
}

// ================= ROTATING CURRENCY HERO =================
// The two hero numbers cycle through all currencies with a crossfade,
// ~6s each, forever. The manual picker still rules the rest of the app.
function renderHeroMoney(fade) {
  if (!state.heroVals) return;
  const codes = state.currencies.map((c) => c.code);
  const code = (reducedMotion || !codes.length) ? disp() : codes[state.rotIdx % codes.length];
  const els = [$('#totalCommitted'), $('#totalLeft'), $('#heroCurCode')];
  const apply = () => {
    const show = (v) => Currency.format(Math.round(Currency.fromBase(v, code, state.rates)), code, state.currencies);
    $('#totalCommitted').textContent = show(state.heroVals.committed);
    $('#totalLeft').textContent = show(state.heroVals.left);
    $('#totalLeft').classList.toggle('is-over', state.heroVals.left < 0);
    $('#heroCurCode').textContent = code;
  };
  if (!fade || reducedMotion) { apply(); return; }
  els.forEach((n) => n.classList.add('fading'));
  setTimeout(() => { apply(); els.forEach((n) => n.classList.remove('fading')); }, 380);
}
state.rotIdx = 0;
setInterval(() => {
  if (state.tab !== 'home' || reducedMotion || !state.heroVals) return;
  state.rotIdx++;
  renderHeroMoney(true);
}, 6000);

// ================= DONUT (breakdown) =================
function renderDonut() {
  const t = buildTree();
  const data = t.roots.map((c) => ({ c, v: t.committed[c.id] })).filter((d) => d.v > 0);
  const card = $('#donutCard');
  if (data.length === 0) { card.hidden = true; return; }
  card.hidden = false;

  const total = data.reduce((s, d) => s + d.v, 0);
  const R = 46, CIRC = 2 * Math.PI * R;
  const gap = data.length > 1 ? 2.6 : 0;
  let acc = 0, segs = '';
  for (const d of data) {
    const len = Math.max((d.v / total) * CIRC - gap, 1);
    const focus = state.donutFocus === d.c.id ? 'is-focus' : '';
    segs += `<circle class="donut-seg ${focus}" data-cat="${d.c.id}" cx="60" cy="60" r="${R}"
      stroke="${d.c.color}" stroke-dasharray="${len} ${CIRC - len}" stroke-dashoffset="${-acc}"
      transform="rotate(-90 60 60)"><title>${escapeHtml(d.c.name)}</title></circle>`;
    acc += (d.v / total) * CIRC;
  }
  const svg = $('#donutSvg');
  svg.innerHTML = segs;
  svg.classList.toggle('donut-dimmed', !!state.donutFocus);

  const center = $('#donutCenter');
  const focused = data.find((d) => d.c.id === state.donutFocus);
  if (focused) {
    const pctOf = Math.round((focused.v / total) * 100);
    center.innerHTML = `
      <span class="donut-center__ico">${catIcon(focused.c)}</span>
      <span class="donut-center__amt">${fmtBase(focused.v)}</span>
      <span class="donut-center__lbl">${escapeHtml(focused.c.name)} · ${pctOf}%</span>`;
  } else {
    center.innerHTML = `
      <span class="donut-center__amt">${fmtBase(total)}</span>
      <span class="donut-center__lbl">committed</span>`;
  }

  svg.querySelectorAll('.donut-seg').forEach((n) => {
    n.onclick = () => {
      state.donutFocus = state.donutFocus === n.dataset.cat ? null : n.dataset.cat;
      renderDonut();
    };
  });
}

// ================= SPEND PER DAY (Ledger) =================
function renderDayChart() {
  const card = $('#dayChartCard');
  if (state.expenses.length < 2) { card.hidden = true; return; }
  card.hidden = false;
  const DAYS = 14;
  const buckets = [];
  const now = new Date();
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    buckets.push({ key: d.toISOString().slice(0, 10), label: d.getDate(), v: 0 });
  }
  const map = Object.fromEntries(buckets.map((b) => [b.key, b]));
  for (const e of state.expenses) {
    const k = new Date(e.createdAt).toISOString().slice(0, 10);
    if (map[k]) map[k].v += Number(e.baseAmount);
  }
  const max = Math.max(...buckets.map((b) => b.v), 1);
  $('#dayChart').innerHTML = buckets.map((b) => `
    <div class="day">
      <div class="day__bar ${b.v === 0 ? 'is-zero' : ''}" style="height:${Math.max((b.v / max) * 100, 3)}%"></div>
      <span class="day__lbl">${b.label}</span>
    </div>`).join('');
  $('#dayChartMax').textContent = 'peak ' + fmtBase(max);
}

// ================= QUICK ADD (inline on Home) =================
function renderQuickAdd() {
  const leaves = leafCategories();
  if (!state.addCategoryId || !leaves.find((c) => c.id === state.addCategoryId)) {
    state.addCategoryId = leaves[0]?.id || null;
  }
  const curSel = $('#expCurrency');
  curSel.innerHTML = '';
  for (const c of state.currencies) { const o = el('option'); o.value = c.code; o.textContent = c.code; curSel.appendChild(o); }
  curSel.value = state.currencies.find((c) => c.code === disp()) ? disp() : state.settings.baseCurrency;
  renderChips($('#catChips'), () => state.addCategoryId, (id) => { state.addCategoryId = id; });
}

function renderChips(wrap, getSel, setSel) {
  wrap.innerHTML = '';
  for (const c of leafCategories()) {
    const chip = el('button', 'chip' + (c.id === getSel() ? ' is-active' : ''));
    chip.type = 'button';
    chip.style.setProperty('--chip-c', c.color);
    chip.innerHTML = `<span class="chip__ic">${catIcon(c)}</span>${escapeHtml(catLabel(c))}`;
    chip.onclick = () => { setSel(c.id); renderChips(wrap, getSel, setSel); };
    wrap.appendChild(chip);
  }
}

async function addExpense() {
  const amount = parseFloat($('#expAmount').value);
  if (!amount || amount <= 0) { $('#expAmount').focus(); return; }
  if (!state.addCategoryId) return;
  const currency = $('#expCurrency').value;
  const baseAmount = Currency.toBase(amount, currency, state.rates);

  let paidAmount, paidBase;
  if (state.addMode === 'paid') {
    paidAmount = amount; paidBase = baseAmount;
  } else {
    paidAmount = Math.min(parseFloat($('#expDeposit').value) || 0, amount);
    paidBase = Currency.toBase(paidAmount, currency, state.rates);
  }

  const cat = catById(state.addCategoryId);
  await Store.addExpense({
    categoryId: state.addCategoryId,
    amount, currency, baseAmount, paidAmount, paidBase,
    note: $('#expNote').value.trim(),
    who: Auth.user.who,
  });
  $('#expAmount').value = '';
  $('#expNote').value = '';
  $('#expDeposit').value = '';
  await loadAll();
  renderDashboard();
  confettiBurst($('#addBtn'), cat ? cat.color : '#5b7cfa');
}

// ================= CONFETTI =================
function confettiBurst(fromEl, color) {
  if (reducedMotion) return;
  const layer = $('#confettiLayer');
  const r = fromEl.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const palette = [color, '#f5b301', '#14b8a6', '#ec5f9a', '#5b7cfa', '#ff8a4c'];
  for (let i = 0; i < 26; i++) {
    const p = el('div', 'confetto');
    const ang = Math.random() * Math.PI * 2;
    const dist = 60 + Math.random() * 130;
    p.style.left = cx + 'px';
    p.style.top = cy + 'px';
    p.style.background = palette[i % palette.length];
    p.style.setProperty('--cx', Math.cos(ang) * dist + 'px');
    p.style.setProperty('--cy', (Math.sin(ang) * dist - 80) + 'px');
    p.style.setProperty('--cr', (Math.random() * 540 - 270) + 'deg');
    layer.appendChild(p);
    setTimeout(() => p.remove(), 950);
  }
}

// ================= LEDGER =================
function expenseStatus(e) {
  if (e.paidBase >= e.baseAmount - 0.005) return 'paid';
  if (e.paidBase > 0) return 'partial';
  return 'committed';
}
const STATUS_LABEL = { paid: 'Paid', partial: 'Partly paid', committed: 'Committed' };

function renderLedger() {
  const board = $('#ledgerBoard');
  const empty = $('#ledgerEmpty');
  board.innerHTML = '';
  empty.hidden = state.expenses.length > 0;

  for (const e of state.expenses) {
    const cat = catById(e.categoryId);
    const st = expenseStatus(e);
    const who = (e.who || '?')[0].toUpperCase();
    const row = el('button', 'lrow');
    row.innerHTML = `
      ${iconBox(cat, 40)}
      <span class="lrow__main">
        <span class="lrow__cat">${escapeHtml(catLabel(cat))}</span><br/>
        <span class="lrow__note">${escapeHtml(e.note || STATUS_LABEL[st])}</span><br/>
        <span class="lrow__date">${new Date(e.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
      </span>
      <span class="lrow__right">
        <span class="lrow__amt">${Currency.format(e.amount, e.currency, state.currencies)}</span>
        <span class="lrow__badges">
          <span class="pill pill--${st}">${STATUS_LABEL[st]}</span>
          <span class="avatar avatar--${who === 'T' ? 't' : 'g'}">${who}</span>
        </span>
      </span>`;
    row.onclick = () => openEditSheet(e.id);
    board.appendChild(row);
  }
}

// ---------- edit sheet ----------
function openEditSheet(id) {
  const e = state.expenses.find((x) => x.id === id);
  if (!e) return;
  state.editingId = id;
  state.editCategoryId = e.categoryId;
  $('#editTitle').textContent = 'Edit — ' + (e.note || catLabel(catById(e.categoryId)));
  $('#editAmount').value = e.amount;
  $('#editPaid').value = e.paidAmount;
  $('#editNote').value = e.note;
  const curSel = $('#editCurrency');
  curSel.innerHTML = '';
  for (const c of state.currencies) { const o = el('option'); o.value = c.code; o.textContent = c.code; curSel.appendChild(o); }
  curSel.value = e.currency;
  renderChips($('#editCatChips'), () => state.editCategoryId, (cid) => { state.editCategoryId = cid; });
  $('#editSheet').hidden = false;
}

function closeEditSheet() { $('#editSheet').hidden = true; state.editingId = null; }

async function saveEdit(overridePaid) {
  const e = state.expenses.find((x) => x.id === state.editingId);
  if (!e) return;
  const amount = parseFloat($('#editAmount').value) || e.amount;
  const currency = $('#editCurrency').value;
  let paidAmount = overridePaid !== undefined ? overridePaid : Math.min(parseFloat($('#editPaid').value) || 0, amount);
  paidAmount = Math.min(paidAmount, amount);
  await Store.updateExpense(e.id, {
    amount,
    currency,
    baseAmount: Currency.toBase(amount, currency, state.rates),
    paidAmount,
    paidBase: Currency.toBase(paidAmount, currency, state.rates),
    categoryId: state.editCategoryId,
    note: $('#editNote').value.trim(),
  });
  closeEditSheet();
  await loadAll();
  renderLedger();
  renderDashboard();
}

// ================= SETTINGS =================
function renderSettings() {
  $('#setTripName').value = state.settings.tripName;
  $('#setTripDates').value = state.settings.tripDates || '';
  $('#signedInAs').textContent = `${Auth.user.who} · ${Auth.user.email}`;

  const baseSel = $('#setBaseCurrency');
  baseSel.innerHTML = '';
  for (const c of state.currencies) { const o = el('option'); o.value = c.code; o.textContent = c.code; baseSel.appendChild(o); }
  baseSel.value = state.settings.baseCurrency;

  renderCatEditor();
  renderRateEditor();
}

function renderCatEditor() {
  const wrap = $('#catEditor');
  wrap.innerHTML = '';
  const childrenMap = {};
  state.categories.forEach((c) => { if (c.parentId) (childrenMap[c.parentId] = childrenMap[c.parentId] || []).push(c); });
  const tops = state.categories.filter((c) => !c.parentId);

  for (const top of tops) {
    const kids = childrenMap[top.id] || [];
    const group = el('div', 'cat-group');
    const prow = el('div', 'edit-row');
    prow.innerHTML = `
      <input type="text" class="ico-input" value="${escapeAttr(top.icon || '')}" data-id="${top.id}" data-f="icon" maxlength="3" aria-label="Emoji" />
      <input type="color" value="${top.color}" data-id="${top.id}" data-f="color" />
      <input type="text" value="${escapeAttr(top.name)}" data-id="${top.id}" data-f="name" />
      ${kids.length ? '' : `<input type="number" value="${top.budget}" data-id="${top.id}" data-f="budget" inputmode="decimal" />`}
      <button class="del" data-del="${top.id}" aria-label="Delete category">✕</button>`;
    group.appendChild(prow);

    for (const kid of kids) {
      const krow = el('div', 'edit-row is-sub');
      krow.innerHTML = `
        <input type="text" class="ico-input" value="${escapeAttr(kid.icon || '')}" data-id="${kid.id}" data-f="icon" maxlength="3" aria-label="Emoji" />
        <input type="color" value="${kid.color}" data-id="${kid.id}" data-f="color" />
        <input type="text" value="${escapeAttr(kid.name)}" data-id="${kid.id}" data-f="name" />
        <input type="number" value="${kid.budget}" data-id="${kid.id}" data-f="budget" inputmode="decimal" />
        <button class="del" data-del="${kid.id}" aria-label="Delete subcategory">✕</button>`;
      group.appendChild(krow);
    }

    const addSub = el('button', 'add-sub');
    addSub.textContent = '+ subcategory';
    addSub.dataset.addsub = top.id;
    group.appendChild(addSub);
    wrap.appendChild(group);
  }

  wrap.querySelectorAll('input').forEach((inp) => {
    inp.onchange = async () => {
      const patch = { id: inp.dataset.id };
      patch[inp.dataset.f] = inp.dataset.f === 'budget' ? Number(inp.value) : inp.value;
      await Store.upsertCategory(patch);
      await loadAll();
      if (inp.dataset.f !== 'budget') renderCatEditor();
    };
  });
  wrap.querySelectorAll('[data-del]').forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm('Delete this category and its transactions?')) return;
      await Store.deleteCategory(btn.dataset.del);
      await loadAll(); renderCatEditor();
    };
  });
  wrap.querySelectorAll('[data-addsub]').forEach((btn) => {
    btn.onclick = async () => {
      const parent = catById(btn.dataset.addsub);
      await Store.upsertCategory({ name: 'New sub', icon: parent.icon || '💸', budget: 0, color: parent.color, parentId: parent.id });
      await loadAll(); renderCatEditor();
    };
  });
}

function renderRateEditor() {
  const wrap = $('#rateEditor');
  wrap.innerHTML = '';
  for (const c of state.currencies) {
    const isBase = c.code === state.settings.baseCurrency;
    const rate = state.rates[c.code] ?? 1;
    const row = el('div', 'rate-row');
    row.innerHTML = `
      <input type="text" class="sym" value="${escapeAttr(c.symbol)}" data-f="symbol" aria-label="Symbol" />
      <input type="text" class="code" value="${escapeAttr(c.code)}" data-f="code" aria-label="Code" />
      <span class="eq">1 = </span>
      <input type="number" value="${rate}" data-f="rate" ${isBase ? 'disabled' : ''} inputmode="decimal" />
      <span class="eq">${escapeHtml(state.settings.baseCurrency)}</span>
      ${isBase ? '' : `<button class="del" data-delcur="${c.code}" aria-label="Delete currency">✕</button>`}`;
    wrap.appendChild(row);
  }
  wrap.querySelectorAll('input').forEach((inp) => { inp.onchange = commitCurrencies; });
  wrap.querySelectorAll('[data-delcur]').forEach((btn) => {
    btn.onclick = async () => {
      const code = btn.dataset.delcur;
      await Store.saveCurrencies(state.currencies.filter((c) => c.code !== code));
      const rates = { ...state.rates }; delete rates[code];
      await Store.saveRates(rates);
      await loadAll(); renderRateEditor();
    };
  });
}

async function commitCurrencies() {
  const rows = [...document.querySelectorAll('#rateEditor .rate-row')];
  const currencies = [], rates = {};
  for (const row of rows) {
    const code = row.querySelector('[data-f="code"]').value.trim().toUpperCase();
    if (!code) continue;
    const symbol = row.querySelector('[data-f="symbol"]').value.trim();
    const isBase = code === state.settings.baseCurrency;
    currencies.push({ code, symbol });
    rates[code] = isBase ? 1 : Number(row.querySelector('[data-f="rate"]').value) || 1;
  }
  if (!rates[state.settings.baseCurrency]) rates[state.settings.baseCurrency] = 1;
  await Store.saveCurrencies(currencies);
  await Store.saveRates(rates);
  await loadAll();
  renderDisplayCurrencyOptions();
}

// ---------- banner upload (downscaled to keep localStorage small) ----------
function handleBannerUpload(file) {
  const img = new Image();
  img.onload = async () => {
    const maxW = 1100;
    const scale = Math.min(1, maxW / img.width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const dataURL = canvas.toDataURL('image/jpeg', 0.82);
    try {
      state.settings = await Store.saveSettings({ bannerImage: dataURL });
      renderHero();
    } catch (e) {
      alert('That photo is too large to store — try a smaller one.');
    }
    URL.revokeObjectURL(img.src);
  };
  img.src = URL.createObjectURL(file);
}

// ================= TABS =================
function switchTab(tab) {
  state.tab = tab;
  $('#homeView').hidden = tab !== 'home';
  $('#ledgerView').hidden = tab !== 'ledger';
  $('#settingsView').hidden = tab !== 'settings';
  document.querySelectorAll('.nav__btn').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === tab));
  if (!state.settings) return; // data still loading — tab is remembered, render happens when boot finishes
  if (tab === 'home') { renderHero(); renderQuickAdd(); renderDashboard(); renderBrief(); }
  if (tab === 'ledger') { renderDayChart(); renderLedger(); }
  if (tab === 'settings') renderSettings();
  window.scrollTo({ top: 0 });
  // subtle enter animation on the newly shown view (retrigger by reflow)
  const v = { home: '#homeView', ledger: '#ledgerView', settings: '#settingsView' }[tab];
  const vEl = $(v);
  if (vEl && !reducedMotion) { vEl.classList.remove('anim'); void vEl.offsetWidth; vEl.classList.add('anim'); }
}

// ================= DISPLAY CURRENCY =================
function renderDisplayCurrencyOptions() {
  const sel = $('#displayCurrency');
  sel.innerHTML = '';
  for (const c of state.currencies) { const o = el('option'); o.value = c.code; o.textContent = c.code; sel.appendChild(o); }
  sel.value = state.settings.displayCurrency;
}

// ================= UTIL =================
function escapeHtml(s) { return String(s).replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m])); }
function escapeAttr(s) { return String(s).replace(/"/g, '&quot;'); }

// ================= WIRE UP =================
function wireEvents() {
  document.querySelectorAll('.nav__btn').forEach((b) => { b.onclick = () => switchTab(b.dataset.tab); });

  $('#addBtn').onclick = addExpense;
  $('#paidSeg').querySelectorAll('button').forEach((btn) => {
    btn.onclick = () => {
      state.addMode = btn.dataset.mode;
      $('#paidSeg').querySelectorAll('button').forEach((b) => b.classList.toggle('is-active', b === btn));
      $('#depositRow').hidden = state.addMode !== 'committed';
    };
  });

  $('#displayCurrency').onchange = async (e) => {
    state.settings = await Store.saveSettings({ displayCurrency: e.target.value });
    // reset count-up baselines so numbers jump cleanly to the new currency
    document.querySelectorAll('[data-val]').forEach((n) => delete n.dataset.val);
    renderDashboard();
  };

  // edit sheet
  $('#cancelEditBtn').onclick = closeEditSheet;
  $('#saveEditBtn').onclick = () => saveEdit();
  $('#markPaidBtn').onclick = () => saveEdit(parseFloat($('#editAmount').value) || 0);
  $('#deleteExpBtn').onclick = async () => {
    if (!confirm('Delete this transaction?')) return;
    await Store.deleteExpense(state.editingId);
    closeEditSheet();
    await loadAll();
    renderLedger();
    renderDashboard();
  };
  $('#editSheet').onclick = (e) => { if (e.target.id === 'editSheet') closeEditSheet(); };

  // settings
  $('#setTripName').onchange = async (e) => { state.settings = await Store.saveSettings({ tripName: e.target.value }); };
  $('#setTripDates').onchange = async (e) => { state.settings = await Store.saveSettings({ tripDates: e.target.value }); };
  $('#signOutBtn').onclick = () => Auth.signOut();
  $('#setBanner').onchange = (e) => { if (e.target.files[0]) handleBannerUpload(e.target.files[0]); };
  $('#clearBannerBtn').onclick = async () => {
    state.settings = await Store.saveSettings({ bannerImage: null });
    renderHero();
  };
  $('#setBaseCurrency').onchange = async (e) => {
    state.settings = await Store.saveSettings({ baseCurrency: e.target.value });
    await Store.saveRates({ ...state.rates, [e.target.value]: 1 });
    await loadAll(); renderRateEditor();
  };

  $('#addCatBtn').onclick = async () => {
    const colors = ['#5b7cfa', '#ff8a4c', '#14b8a6', '#f5b301', '#ec5f9a', '#7048e8', '#20c997', '#fa5252'];
    const topCount = state.categories.filter((c) => !c.parentId).length;
    await Store.upsertCategory({ name: 'New category', icon: '💸', budget: 0, color: colors[topCount % colors.length], parentId: null });
    await loadAll(); renderCatEditor();
  };
  $('#addCurBtn').onclick = async () => {
    await Store.saveCurrencies([...state.currencies, { code: 'XXX', symbol: '' }]);
    await Store.saveRates({ ...state.rates, XXX: 1 });
    await loadAll(); renderRateEditor(); renderDisplayCurrencyOptions();
  };
}

let wired = false;
let realtimeChannel = null;

async function main() {
  try {
    if (!wired) { wireEvents(); wired = true; } // buttons live even while data loads
    await Store.init();
    await loadAll();
    renderDisplayCurrencyOptions();
    switchTab(state.tab || 'home');
    subscribeRealtime();
  } catch (e) {
    // Never fail silently into a dead skeleton — say what broke.
    console.error('boot failed', e);
    alert('Could not load trip data: ' + (e && e.message ? e.message : e));
  }
}

// Live sync: when Gil or Tammy's phone writes anywhere, both phones pick it
// up within a second or two, no manual refresh.
function subscribeRealtime() {
  if (realtimeChannel) return; // already listening
  realtimeChannel = sb.channel('trip-changes')
    .on('postgres_changes', { event: '*', schema: 'public' }, debounce(async () => {
      await loadAll();
      if (state.tab === 'home') { renderQuickAdd(); renderDashboard(); }
      if (state.tab === 'ledger') { renderDayChart(); renderLedger(); }
      if (state.tab === 'settings') renderSettings();
    }, 400))
    .subscribe();
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

window.main = main;
