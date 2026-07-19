// store.js — LOCAL-FIRST persistence.
//
// Reads come from a local mirror in localStorage, so the app opens and works
// with zero signal. Writes update the mirror instantly (optimistic UI) and are
// queued in an outbox; a background flush drains the outbox to Supabase the
// moment connectivity returns. Every row's id is generated on the client, so
// re-sending a queued write is idempotent (upsert) — no duplicates, ever.
//
// Public interface is unchanged from the old cloud-only Store, so app.js only
// needed its realtime/boot wiring adjusted.

function unwrap({ data, error }) { if (error) throw error; return data; }
function ok(res) { if (res && res.error) throw res.error; return res; }

const uuid = () =>
  (crypto.randomUUID ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      }));

// ---------- field mappers (server snake_case <-> app camelCase) ----------
const rowToCat = (r) => ({ id: r.id, name: r.name, icon: r.icon, color: r.color, budget: Number(r.budget), parentId: r.parent_id, order: r.order, separate: !!r.separate });
const catToRow = (c) => ({ id: c.id, name: c.name, icon: c.icon, color: c.color, budget: Number(c.budget) || 0, parent_id: c.parentId ?? null, order: c.order ?? 0, separate: !!c.separate });
function catPatchToRow(p) {
  const row = {};
  if ('name' in p) row.name = p.name;
  if ('icon' in p) row.icon = p.icon;
  if ('color' in p) row.color = p.color;
  if ('budget' in p) row.budget = Number(p.budget);
  if ('parentId' in p) row.parent_id = p.parentId;
  if ('order' in p) row.order = p.order;
  if ('separate' in p) row.separate = !!p.separate;
  return row;
}
const rowToExp = (r) => ({
  id: r.id, categoryId: r.category_id, amount: Number(r.amount), currency: r.currency,
  baseAmount: Number(r.base_amount), paidAmount: Number(r.paid_amount), paidBase: Number(r.paid_base),
  note: r.note, who: r.who, createdAt: new Date(r.created_at).getTime(),
  payMethod: r.pay_method || 'card', halfFare: !!r.half_fare,
});
const expToRow = (e) => ({
  id: e.id, category_id: e.categoryId, amount: Number(e.amount), currency: e.currency,
  base_amount: Number(e.baseAmount), paid_amount: Number(e.paidAmount || 0), paid_base: Number(e.paidBase || 0),
  note: e.note || '', who: e.who || '', pay_method: e.payMethod || 'card', half_fare: !!e.halfFare,
  created_at: new Date(e.createdAt).toISOString(),
});
function expPatchToRow(p) {
  const row = {};
  if ('categoryId' in p) row.category_id = p.categoryId;
  if ('amount' in p) row.amount = Number(p.amount);
  if ('currency' in p) row.currency = p.currency;
  if ('baseAmount' in p) row.base_amount = Number(p.baseAmount);
  if ('paidAmount' in p) row.paid_amount = Number(p.paidAmount);
  if ('paidBase' in p) row.paid_base = Number(p.paidBase);
  if ('note' in p) row.note = p.note;
  if ('who' in p) row.who = p.who;
  if ('payMethod' in p) row.pay_method = p.payMethod;
  if ('halfFare' in p) row.half_fare = !!p.halfFare;
  return row;
}
const rowToSettings = (r) => ({ tripName: r.trip_name, tripDates: r.trip_dates, baseCurrency: r.base_currency, displayCurrency: r.display_currency, bannerImage: r.banner_image });
function settingsPatchToRow(p) {
  const row = {};
  if ('tripName' in p) row.trip_name = p.tripName;
  if ('tripDates' in p) row.trip_dates = p.tripDates;
  if ('baseCurrency' in p) row.base_currency = p.baseCurrency;
  if ('displayCurrency' in p) row.display_currency = p.displayCurrency;
  if ('bannerImage' in p) row.banner_image = p.bannerImage;
  return row;
}

// ---------- the mirror (app-shape data cached in localStorage) ----------
const MK = 'tb:mirror:';
const DEFAULT_SETTINGS = { tripName: 'Our Trip', tripDates: '', baseCurrency: 'USD', displayCurrency: 'USD', bannerImage: null };
const M = {
  get(name, fb) { try { const v = localStorage.getItem(MK + name); return v ? JSON.parse(v) : fb; } catch (e) { return fb; } },
  set(name, v) { try { localStorage.setItem(MK + name, JSON.stringify(v)); } catch (e) { console.warn('mirror full', e); } },
};

// ---------- the outbox (pending writes) ----------
let outbox = M.get('outbox', []);
const saveOutbox = () => M.set('outbox', outbox);
let syncState = { offline: !navigator.onLine, pending: outbox.length, syncing: false };
function emitSync() {
  syncState = { offline: !navigator.onLine, pending: outbox.length, syncing: syncState.syncing };
  if (window.onSyncState) window.onSyncState(syncState);
}
function enqueue(op) { outbox.push(op); saveOutbox(); emitSync(); scheduleFlush(); }

// translate one queued op into its Supabase call
async function applyOp(op) {
  const t = op.entity, k = op.kind, d = op.data;
  if (t === 'expenses' && k === 'add') return ok(await sb.from('expenses').upsert(expToRow(d), { onConflict: 'id' }));
  if (t === 'expenses' && k === 'update') return ok(await sb.from('expenses').update(expPatchToRow(d.patch)).eq('id', d.id));
  if (t === 'expenses' && k === 'delete') return ok(await sb.from('expenses').delete().eq('id', d.id));
  if (t === 'withdrawals' && k === 'add') return ok(await sb.from('withdrawals').upsert({ id: d.id, amount: Number(d.amount), currency: d.currency, base_amount: Number(d.baseAmount), who: d.who || '', created_at: new Date(d.createdAt).toISOString() }, { onConflict: 'id' }));
  if (t === 'withdrawals' && k === 'delete') return ok(await sb.from('withdrawals').delete().eq('id', d.id));
  if (t === 'categories' && k === 'add') return ok(await sb.from('categories').upsert(catToRow(d), { onConflict: 'id' }));
  if (t === 'categories' && k === 'update') return ok(await sb.from('categories').update(catPatchToRow(d.patch)).eq('id', d.id));
  if (t === 'categories' && k === 'delete') return ok(await sb.from('categories').delete().eq('id', d.id));
  if (t === 'settings' && k === 'patch') return ok(await sb.from('settings').update(settingsPatchToRow(d)).eq('id', 1));
  if (t === 'rates' && k === 'save') return ok(await sb.from('rates').upsert(Object.entries(d).map(([code, rate]) => ({ code, rate: Number(rate) })), { onConflict: 'code' }));
  if (t === 'currencies' && k === 'replace') {
    const existing = unwrap(await sb.from('currencies').select('code'));
    const keep = new Set(d.map((c) => c.code));
    const del = existing.map((r) => r.code).filter((c) => !keep.has(c));
    if (del.length) { try { await sb.from('currencies').delete().in('code', del); } catch (e) {} }
    return ok(await sb.from('currencies').upsert(d.map((c) => ({ code: c.code, symbol: c.symbol })), { onConflict: 'code' }));
  }
  if (t === 'itinerary' && k === 'replace') {
    await sb.from('itinerary').delete().not('id', 'is', null);
    if (d.length) return ok(await sb.from('itinerary').insert(d.map((x) => ({ date: x.date, place: x.place, lat: x.lat, lon: x.lon, line: x.line || '' }))));
    return;
  }
  console.warn('unknown op dropped', op);
}

let flushing = false, flushTimer = null;
function scheduleFlush() { clearTimeout(flushTimer); flushTimer = setTimeout(flush, 300); }

async function flush() {
  if (flushing || !outbox.length) return;
  flushing = true; syncState.syncing = true; emitSync();
  try {
    while (outbox.length) {
      const op = outbox[0];
      try {
        await applyOp(op);
        outbox.shift(); saveOutbox(); emitSync();
      } catch (e) {
        if (!navigator.onLine) break;                 // offline: retry later, don't count
        op.tries = (op.tries || 0) + 1; saveOutbox();
        if (op.tries >= 3) { console.error('dropping poison op after 3 tries', op, e); outbox.shift(); saveOutbox(); emitSync(); }
        else break;                                    // transient online error: retry later
      }
    }
  } finally { flushing = false; syncState.syncing = false; emitSync(); }
}

// pull server truth into the mirror (only when the outbox is drained, so we
// never overwrite un-synced local writes)
async function pull() {
  if (outbox.length) return;
  const [settings, currencies, rates, categories, expenses, itinerary, withdrawals] = await Promise.all([
    sb.from('settings').select('*').eq('id', 1).single(),
    sb.from('currencies').select('*'),
    sb.from('rates').select('*'),
    sb.from('categories').select('*'),
    sb.from('expenses').select('*'),
    sb.from('itinerary').select('*'),
    sb.from('withdrawals').select('*').then((r) => r, () => ({ data: [], error: null })),
  ]);
  if (settings.data) M.set('settings', rowToSettings(settings.data));
  if (currencies.data) M.set('currencies', currencies.data.map((c) => ({ code: c.code, symbol: c.symbol })));
  if (rates.data) M.set('rates', Object.fromEntries(rates.data.map((r) => [r.code, Number(r.rate)])));
  if (categories.data) M.set('categories', categories.data.map(rowToCat));
  if (expenses.data) M.set('expenses', expenses.data.map(rowToExp));
  if (itinerary.data) M.set('itinerary', itinerary.data.map((r) => ({ date: r.date, place: r.place, lat: r.lat == null ? null : Number(r.lat), lon: r.lon == null ? null : Number(r.lon), line: r.line })));
  if (withdrawals && withdrawals.data) M.set('withdrawals', withdrawals.data.map((r) => ({ id: r.id, amount: Number(r.amount), currency: r.currency, baseAmount: Number(r.base_amount), who: r.who, createdAt: new Date(r.created_at).getTime() })));
}

async function sync() {
  try { await flush(); } catch (e) { /* stays queued */ }
  try { await pull(); emitSync(); } catch (e) { emitSync(); /* offline: keep mirror */ }
}

// connectivity + periodic drains
window.addEventListener('online', () => { emitSync(); sync().then(() => window.onSynced && window.onSynced()); });
window.addEventListener('offline', emitSync);
setInterval(() => { if (outbox.length) flush(); }, 20000);

// ---------- first-run server seed (online bootstrap; no-op once seeded) ----------
const SEED_CURRENCIES = [{ code: 'USD', symbol: '$' }, { code: 'EUR', symbol: '€' }, { code: 'ILS', symbol: '₪' }, { code: 'CHF', symbol: '₣' }];
const SEED_RATES = { USD: 1, EUR: 1.08, ILS: 0.27, CHF: 1.10 };
const SEED_ITIN = [
  { date: '2026-07-25', place: 'Vienna', lat: 48.2082, lon: 16.3738, line: 'Landing day.' },
];
async function seedIfEmpty() {
  const { count } = await sb.from('categories').select('id', { count: 'exact', head: true });
  if (count) return;
  await sb.from('currencies').upsert(SEED_CURRENCIES, { onConflict: 'code' });
  await sb.from('rates').upsert(Object.entries(SEED_RATES).map(([code, rate]) => ({ code, rate })), { onConflict: 'code' });
  const tops = [
    { name: 'Accommodation', icon: '🏠', budget: 11000, color: '#5b7cfa', order: 0 },
    { name: 'Car', icon: '🚗', budget: 0, color: '#ff8a4c', order: 1 },
    { name: 'Food & Drinks', icon: '🍴', budget: 3500, color: '#14b8a6', order: 2 },
    { name: 'Attractions', icon: '🎟️', budget: 2000, color: '#f5b301', order: 3 },
    { name: 'Miscellaneous', icon: '✨', budget: 645, color: '#ec5f9a', order: 4 },
  ];
  const topRows = unwrap(await sb.from('categories').insert(tops).select());
  const carId = topRows.find((r) => r.name === 'Car').id;
  await sb.from('categories').insert([
    { name: 'Rental', icon: '🚙', budget: 1800, color: '#ff8a4c', order: 0, parent_id: carId },
    { name: 'Fuel', icon: '⛽', budget: 700, color: '#ffa96e', order: 1, parent_id: carId },
    { name: 'Vignettes', icon: '🛣️', budget: 355, color: '#ffc39a', order: 2, parent_id: carId },
  ]);
  await sb.from('settings').update({ trip_name: 'Austria 2026' }).eq('id', 1);
  const { count: ic } = await sb.from('itinerary').select('id', { count: 'exact', head: true });
  if (!ic) await sb.from('itinerary').insert(SEED_ITIN);
}

// ---------- sorted reads from the mirror ----------
const sortedCats = (list) => list.slice().sort((a, b) => { const pa = a.parentId || '', pb = b.parentId || ''; if (pa !== pb) return pa < pb ? -1 : 1; return a.order - b.order; });

const Store = {
  async init() {
    await sync(); // flush pending + pull fresh (offline: no-op, mirror stands)
    if (navigator.onLine && (M.get('categories', []).length === 0)) {
      try { await seedIfEmpty(); await pull(); emitSync(); } catch (e) { console.warn('seed skipped', e); }
    }
  },
  sync,                       // exposed so app.js can trigger on focus/realtime
  syncState: () => syncState,

  async getSettings() { return M.get('settings', DEFAULT_SETTINGS); },
  async saveSettings(patch) {
    const next = { ...M.get('settings', DEFAULT_SETTINGS), ...patch };
    M.set('settings', next); enqueue({ entity: 'settings', kind: 'patch', data: patch }); return next;
  },

  async getItinerary() { return M.get('itinerary', []).slice().sort((a, b) => a.date.localeCompare(b.date)); },
  async saveItinerary(list) { M.set('itinerary', list); enqueue({ entity: 'itinerary', kind: 'replace', data: list }); return list; },

  async getCurrencies() { return M.get('currencies', SEED_CURRENCIES); },
  async saveCurrencies(list) { M.set('currencies', list); enqueue({ entity: 'currencies', kind: 'replace', data: list }); return list; },
  async getRates() { return M.get('rates', SEED_RATES); },
  async saveRates(rates) { M.set('rates', rates); enqueue({ entity: 'rates', kind: 'save', data: rates }); return rates; },

  async getCategories() { return sortedCats(M.get('categories', [])); },
  async upsertCategory(cat) {
    const list = M.get('categories', []);
    if (cat.id) {
      const i = list.findIndex((c) => c.id === cat.id);
      if (i >= 0) list[i] = { ...list[i], ...cat };
      M.set('categories', list);
      enqueue({ entity: 'categories', kind: 'update', data: { id: cat.id, patch: cat } });
      return list[i];
    }
    const siblings = list.filter((c) => (c.parentId || null) === (cat.parentId || null));
    const row = { id: uuid(), name: cat.name, icon: cat.icon, color: cat.color, budget: Number(cat.budget) || 0, parentId: cat.parentId ?? null, order: siblings.length, separate: !!cat.separate };
    list.push(row); M.set('categories', list);
    enqueue({ entity: 'categories', kind: 'add', data: row });
    return row;
  },
  async deleteCategory(id) {
    let list = M.get('categories', []);
    const childIds = list.filter((c) => c.parentId === id).map((c) => c.id);
    const dead = new Set([id, ...childIds]);
    M.set('categories', list.filter((c) => !dead.has(c.id)));
    M.set('expenses', M.get('expenses', []).filter((e) => !dead.has(e.categoryId))); // mirror the FK cascade
    enqueue({ entity: 'categories', kind: 'delete', data: { id } }); // server cascades
  },

  async getExpenses() { return M.get('expenses', []).slice().sort((a, b) => b.createdAt - a.createdAt); },
  async addExpense(exp) {
    const row = {
      id: exp.id || uuid(), categoryId: exp.categoryId, amount: Number(exp.amount), currency: exp.currency,
      baseAmount: Number(exp.baseAmount), paidAmount: Number(exp.paidAmount || 0), paidBase: Number(exp.paidBase || 0),
      note: exp.note || '', who: exp.who || '', payMethod: exp.payMethod || 'card', halfFare: !!exp.halfFare,
      createdAt: exp.createdAt || Date.now(),
    };
    M.set('expenses', [...M.get('expenses', []), row]);
    enqueue({ entity: 'expenses', kind: 'add', data: row });
    return row;
  },
  async updateExpense(id, patch) {
    const list = M.get('expenses', []); const i = list.findIndex((e) => e.id === id);
    if (i >= 0) { list[i] = { ...list[i], ...patch }; M.set('expenses', list); }
    enqueue({ entity: 'expenses', kind: 'update', data: { id, patch } });
    return list[i];
  },
  async deleteExpense(id) {
    M.set('expenses', M.get('expenses', []).filter((e) => e.id !== id));
    enqueue({ entity: 'expenses', kind: 'delete', data: { id } });
  },

  async getWithdrawals() { return M.get('withdrawals', []).slice().sort((a, b) => b.createdAt - a.createdAt); },
  async addWithdrawal(w) {
    const row = { id: uuid(), amount: Number(w.amount), currency: w.currency, baseAmount: Number(w.baseAmount), who: w.who || '', createdAt: Date.now() };
    M.set('withdrawals', [...M.get('withdrawals', []), row]);
    enqueue({ entity: 'withdrawals', kind: 'add', data: row });
    return row;
  },
  async deleteWithdrawal(id) {
    M.set('withdrawals', M.get('withdrawals', []).filter((w) => w.id !== id));
    enqueue({ entity: 'withdrawals', kind: 'delete', data: { id } });
  },
};

window.Store = Store;
