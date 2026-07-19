// store.js — the ONLY place that touches persistence.
// Today: localStorage (works instantly, no accounts needed).
// Later: this same interface gets a Supabase implementation swapped in,
// so nothing else in the app has to change.
//
// Every method is async (returns a Promise) on purpose — that's how the
// Supabase version will behave, so the rest of the app is already shaped for it.

const NS = 'tripbudget:';
const k = (name) => NS + name;

const read = (name, fallback) => {
  try {
    const raw = localStorage.getItem(k(name));
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    console.warn('store read failed', name, e);
    return fallback;
  }
};
const write = (name, value) => localStorage.setItem(k(name), JSON.stringify(value));

const uid = () =>
  Date.now().toString(36) + Math.floor(performance.now() % 1000).toString(36) + Math.floor(Math.random() * 1e6).toString(36);

// ---- Seed data (Gil's real trip numbers; editable in-app) ----
const SEED_SETTINGS = {
  tripName: 'Austria 2026',
  tripDates: '',              // free text, e.g. "Jul 25 – Aug 15"
  baseCurrency: 'USD',        // budgets are defined in this currency
  displayCurrency: 'USD',     // what the dashboard is currently showing
  whoAmI: 'Gil',              // who this device belongs to (stamps every entry)
  people: ['Gil', 'Tammy'],
  bannerImage: null,          // dataURL of an uploaded photo; null = default Alpine art
};

// rate[CODE] = how many BASE units one unit of CODE is worth. base is always 1.
const SEED_RATES = { USD: 1, EUR: 1.08, ILS: 0.27, CHF: 1.10 };

const SEED_CURRENCIES = [
  { code: 'USD', symbol: '$' },
  { code: 'EUR', symbol: '€' },
  { code: 'ILS', symbol: '₪' },
  { code: 'CHF', symbol: '₣' },
];

// Categories form a 2-level tree via parentId (null = top level).
// Spending is logged only on LEAF categories; parents aggregate their children.
const ID = { acc: uid(), car: uid(), food: uid(), attr: uid(), misc: uid() };
const SEED_CATEGORIES = [
  { id: ID.acc, name: 'Accommodation', icon: '🏠', budget: 11000, color: '#5b7cfa', order: 0, parentId: null },
  { id: ID.car, name: 'Car', icon: '🚗', budget: 0, color: '#ff8a4c', order: 1, parentId: null },
  { id: uid(), name: 'Rental', icon: '🚙', budget: 1800, color: '#ff8a4c', order: 0, parentId: ID.car },
  { id: uid(), name: 'Fuel', icon: '⛽', budget: 700, color: '#ffa96e', order: 1, parentId: ID.car },
  { id: uid(), name: 'Vignettes', icon: '🛣️', budget: 355, color: '#ffc39a', order: 2, parentId: ID.car },
  { id: ID.food, name: 'Food & Drinks', icon: '🍴', budget: 3500, color: '#14b8a6', order: 2, parentId: null },
  { id: ID.attr, name: 'Attractions', icon: '🎟️', budget: 2000, color: '#f5b301', order: 3, parentId: null },
  { id: ID.misc, name: 'Miscellaneous', icon: '✨', budget: 645, color: '#ec5f9a', order: 4, parentId: null },
];

// Placeholder itinerary — Gil replaces with his real one (from the Word doc).
// line = the one-sentence daily brief. lat/lon power the weather strip.
const SEED_ITINERARY = [
  { date: '2026-07-25', place: 'Vienna', lat: 48.2082, lon: 16.3738, line: 'Landing day — easy evening in Vienna.' },
  { date: '2026-07-28', place: 'Salzburg', lat: 47.8095, lon: 13.0550, line: 'Drive to Salzburg — old town stroll.' },
  { date: '2026-08-01', place: 'Hallstatt', lat: 47.5622, lon: 13.6493, line: 'Hallstatt lake day.' },
  { date: '2026-08-05', place: 'Innsbruck', lat: 47.2692, lon: 11.4041, line: 'Into the mountains — Innsbruck.' },
];

const Store = {
  async init() {
    // merge-in any new settings keys added since first run (safe migration)
    const s = read('settings', null);
    write('settings', s ? { ...SEED_SETTINGS, ...s } : SEED_SETTINGS);
    if (read('rates', null) === null) write('rates', SEED_RATES);
    if (read('currencies', null) === null) write('currencies', SEED_CURRENCIES);
    if (read('categories', null) === null) write('categories', SEED_CATEGORIES);
    if (read('expenses', null) === null) write('expenses', []);
    if (read('itinerary', null) === null) write('itinerary', SEED_ITINERARY);
  },

  // ---- settings ----
  async getSettings() { return read('settings', SEED_SETTINGS); },
  async saveSettings(patch) {
    const next = { ...read('settings', SEED_SETTINGS), ...patch };
    write('settings', next);
    return next;
  },

  // ---- itinerary ----
  async getItinerary() {
    return read('itinerary', []).slice().sort((a, b) => a.date.localeCompare(b.date));
  },
  async saveItinerary(list) { write('itinerary', list); return list; },

  // ---- currencies + rates ----
  async getCurrencies() { return read('currencies', SEED_CURRENCIES); },
  async saveCurrencies(list) { write('currencies', list); return list; },
  async getRates() { return read('rates', SEED_RATES); },
  async saveRates(rates) { write('rates', rates); return rates; },

  // ---- categories ----
  async getCategories() {
    return read('categories', []).slice().sort((a, b) => {
      const pa = a.parentId || '', pb = b.parentId || '';
      if (pa !== pb) return pa < pb ? -1 : 1;
      return a.order - b.order;
    });
  },
  async upsertCategory(cat) {
    const list = read('categories', []);
    if (cat.id) {
      const i = list.findIndex((c) => c.id === cat.id);
      if (i >= 0) list[i] = { ...list[i], ...cat };
      else list.push(cat);
    } else {
      cat.id = uid();
      const siblings = list.filter((c) => (c.parentId || null) === (cat.parentId || null));
      cat.order = siblings.length;
      list.push(cat);
    }
    write('categories', list);
    return cat;
  },
  async deleteCategory(id) {
    let list = read('categories', []);
    const childIds = list.filter((c) => c.parentId === id).map((c) => c.id);
    const dead = new Set([id, ...childIds]);
    list = list.filter((c) => !dead.has(c.id));
    write('categories', list);
    // cascade: drop expenses on the removed (leaf) categories
    write('expenses', read('expenses', []).filter((e) => !dead.has(e.categoryId)));
  },

  // ---- expenses ----
  async getExpenses() {
    return read('expenses', []).slice().sort((a, b) => b.createdAt - a.createdAt);
  },
  async addExpense(exp) {
    const list = read('expenses', []);
    const row = {
      id: uid(),
      categoryId: exp.categoryId,
      amount: Number(exp.amount),            // full committed amount, original currency
      currency: exp.currency,
      baseAmount: Number(exp.baseAmount),    // full committed amount, base currency
      paidAmount: Number(exp.paidAmount || 0),   // how much paid, original currency
      paidBase: Number(exp.paidBase || 0),       // how much paid, base currency
      note: exp.note || '',
      who: exp.who || '',
      createdAt: exp.createdAt || Date.now(),
    };
    list.push(row);
    write('expenses', list);
    return row;
  },
  async updateExpense(id, patch) {
    const list = read('expenses', []);
    const i = list.findIndex((e) => e.id === id);
    if (i >= 0) { list[i] = { ...list[i], ...patch }; write('expenses', list); }
    return list[i];
  },
  async deleteExpense(id) {
    write('expenses', read('expenses', []).filter((e) => e.id !== id));
  },
};

window.Store = Store;
