// store.js — the ONLY place that touches persistence.
// Backed by Supabase (Postgres) now — every read/write goes over the network
// to the shared database, so Gil and Tammy always see the same numbers.
// The interface (method names + shapes) is unchanged from the old
// localStorage version, which is why app.js didn't need to be rewritten.
//
// Field names: the app speaks camelCase; the database speaks snake_case.
// Every mapper below does that translation in exactly one place.
// Note: Postgres `numeric` columns come back over the wire as STRINGS (to
// preserve precision) — every numeric field is explicitly wrapped in
// Number(...) on the way in, or budget math would silently do string
// concatenation instead of addition.

function unwrap({ data, error }) {
  if (error) throw error;
  return data;
}

// ---------- field mappers ----------
function rowToCat(r) {
  return { id: r.id, name: r.name, icon: r.icon, color: r.color, budget: Number(r.budget), parentId: r.parent_id, order: r.order };
}
function catPatchToRow(p) {
  const row = {};
  if ('name' in p) row.name = p.name;
  if ('icon' in p) row.icon = p.icon;
  if ('color' in p) row.color = p.color;
  if ('budget' in p) row.budget = Number(p.budget);
  if ('parentId' in p) row.parent_id = p.parentId;
  if ('order' in p) row.order = p.order;
  return row;
}

function rowToExp(r) {
  return {
    id: r.id, categoryId: r.category_id, amount: Number(r.amount), currency: r.currency,
    baseAmount: Number(r.base_amount), paidAmount: Number(r.paid_amount), paidBase: Number(r.paid_base),
    note: r.note, who: r.who, createdAt: new Date(r.created_at).getTime(),
  };
}
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
  return row;
}

function rowToSettings(r) {
  return { tripName: r.trip_name, tripDates: r.trip_dates, baseCurrency: r.base_currency, displayCurrency: r.display_currency, bannerImage: r.banner_image };
}
function settingsPatchToRow(p) {
  const row = {};
  if ('tripName' in p) row.trip_name = p.tripName;
  if ('tripDates' in p) row.trip_dates = p.tripDates;
  if ('baseCurrency' in p) row.base_currency = p.baseCurrency;
  if ('displayCurrency' in p) row.display_currency = p.displayCurrency;
  if ('bannerImage' in p) row.banner_image = p.bannerImage;
  return row;
}

// ---------- first-run seed (only inserted if the tables are empty) ----------
const SEED_CURRENCIES = [
  { code: 'USD', symbol: '$' }, { code: 'EUR', symbol: '€' },
  { code: 'ILS', symbol: '₪' }, { code: 'CHF', symbol: '₣' },
];
const SEED_RATES = { USD: 1, EUR: 1.08, ILS: 0.27, CHF: 1.10 };
const SEED_ITINERARY = [
  { date: '2026-07-25', place: 'Vienna', lat: 48.2082, lon: 16.3738, line: 'Landing day — easy evening in Vienna.' },
  { date: '2026-07-28', place: 'Salzburg', lat: 47.8095, lon: 13.0550, line: 'Drive to Salzburg — old town stroll.' },
  { date: '2026-08-01', place: 'Hallstatt', lat: 47.5622, lon: 13.6493, line: 'Hallstatt lake day.' },
  { date: '2026-08-05', place: 'Innsbruck', lat: 47.2692, lon: 11.4041, line: 'Into the mountains — Innsbruck.' },
];

async function seedIfEmpty() {
  const { count: catCount } = await sb.from('categories').select('id', { count: 'exact', head: true });
  if (!catCount) {
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
    const kids = [
      { name: 'Rental', icon: '🚙', budget: 1800, color: '#ff8a4c', order: 0, parent_id: carId },
      { name: 'Fuel', icon: '⛽', budget: 700, color: '#ffa96e', order: 1, parent_id: carId },
      { name: 'Vignettes', icon: '🛣️', budget: 355, color: '#ffc39a', order: 2, parent_id: carId },
    ];
    await sb.from('categories').insert(kids);
  }

  const { count: itinCount } = await sb.from('itinerary').select('id', { count: 'exact', head: true });
  if (!itinCount) {
    await sb.from('itinerary').insert(SEED_ITINERARY.map((s) => ({ date: s.date, place: s.place, lat: s.lat, lon: s.lon, line: s.line })));
  }
}

const Store = {
  async init() { await seedIfEmpty(); },

  // ---- settings ----
  async getSettings() { return rowToSettings(unwrap(await sb.from('settings').select('*').eq('id', 1).single())); },
  async saveSettings(patch) {
    return rowToSettings(unwrap(await sb.from('settings').update(settingsPatchToRow(patch)).eq('id', 1).select().single()));
  },

  // ---- itinerary ----
  async getItinerary() {
    const rows = unwrap(await sb.from('itinerary').select('*').order('date', { ascending: true }));
    return rows.map((r) => ({ date: r.date, place: r.place, lat: r.lat == null ? null : Number(r.lat), lon: r.lon == null ? null : Number(r.lon), line: r.line }));
  },
  async saveItinerary(list) {
    await sb.from('itinerary').delete().not('id', 'is', null); // clear table
    if (list.length) unwrap(await sb.from('itinerary').insert(list.map((x) => ({ date: x.date, place: x.place, lat: x.lat, lon: x.lon, line: x.line || '' }))));
    return list;
  },

  // ---- currencies + rates ----
  async getCurrencies() { return unwrap(await sb.from('currencies').select('*')); },
  async saveCurrencies(list) {
    const existing = unwrap(await sb.from('currencies').select('code'));
    const keep = new Set(list.map((c) => c.code));
    const toDelete = existing.map((r) => r.code).filter((c) => !keep.has(c));
    if (toDelete.length) { try { await sb.from('currencies').delete().in('code', toDelete); } catch (e) { console.warn('currency in use, skipped delete', e); } }
    unwrap(await sb.from('currencies').upsert(list.map((c) => ({ code: c.code, symbol: c.symbol })), { onConflict: 'code' }));
    return list;
  },
  async getRates() {
    const rows = unwrap(await sb.from('rates').select('*'));
    return Object.fromEntries(rows.map((r) => [r.code, Number(r.rate)]));
  },
  async saveRates(rates) {
    unwrap(await sb.from('rates').upsert(Object.entries(rates).map(([code, rate]) => ({ code, rate: Number(rate) })), { onConflict: 'code' }));
    return rates;
  },

  // ---- categories ----
  async getCategories() {
    const rows = unwrap(await sb.from('categories').select('*'));
    return rows.map(rowToCat).sort((a, b) => {
      const pa = a.parentId || '', pb = b.parentId || '';
      if (pa !== pb) return pa < pb ? -1 : 1;
      return a.order - b.order;
    });
  },
  async upsertCategory(cat) {
    if (cat.id) return rowToCat(unwrap(await sb.from('categories').update(catPatchToRow(cat)).eq('id', cat.id).select().single()));
    const siblings = unwrap(await sb.from('categories').select('id', { count: 'exact', head: false }).eq('parent_id', cat.parentId ?? null));
    const row = { ...catPatchToRow(cat), order: siblings.length };
    return rowToCat(unwrap(await sb.from('categories').insert(row).select().single()));
  },
  async deleteCategory(id) {
    // children + their expenses cascade automatically (FK ON DELETE CASCADE)
    unwrap(await sb.from('categories').delete().eq('id', id));
  },

  // ---- expenses ----
  async getExpenses() {
    const rows = unwrap(await sb.from('expenses').select('*').order('created_at', { ascending: false }));
    return rows.map(rowToExp);
  },
  async addExpense(exp) {
    const row = {
      category_id: exp.categoryId, amount: Number(exp.amount), currency: exp.currency,
      base_amount: Number(exp.baseAmount), paid_amount: Number(exp.paidAmount || 0), paid_base: Number(exp.paidBase || 0),
      note: exp.note || '', who: exp.who || '',
    };
    return rowToExp(unwrap(await sb.from('expenses').insert(row).select().single()));
  },
  async updateExpense(id, patch) {
    return rowToExp(unwrap(await sb.from('expenses').update(expPatchToRow(patch)).eq('id', id).select().single()));
  },
  async deleteExpense(id) { unwrap(await sb.from('expenses').delete().eq('id', id)); },
};

window.Store = Store;
