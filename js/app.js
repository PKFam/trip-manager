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
  // withdrawals table may not exist until the migration runs — degrade gracefully
  try { state.withdrawals = await Store.getWithdrawals(); } catch (e) { state.withdrawals = []; }
}

// ---------- daily live FX rates (ECB via frankfurter.app, keyless) ----------
// Once per day per device: refresh the shared rate table. Entry-time conversion
// then uses today's real rate; each stored expense keeps its locked base_amount
// forever — historical numbers NEVER move when rates change.
async function refreshRatesDaily() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    if (localStorage.getItem('tripbudget:ratesday') === today) return;
    const base = state.settings.baseCurrency;
    const others = state.currencies.map((c) => c.code).filter((c) => c !== base);
    if (!others.length) return;
    const res = await fetch(`https://api.frankfurter.app/latest?from=${base}&to=${others.join(',')}`);
    if (!res.ok) throw new Error('fx http ' + res.status);
    const data = await res.json();
    const rates = { ...state.rates, [base]: 1 };
    for (const [code, perBase] of Object.entries(data.rates)) rates[code] = 1 / perBase; // 1 CODE in BASE units
    await Store.saveRates(rates);
    state.rates = rates;
    localStorage.setItem('tripbudget:ratesday', today);
  } catch (e) {
    console.warn('daily rate refresh skipped (offline or API down) — using last known rates', e);
  }
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
  const allRoots = childrenMap.__root || [];

  // FX & Exchange: a real category that ALSO auto-accrues the card's 1%
  // conversion markup on every non-base-currency card purchase. Fees ride on
  // the locked base amounts, so they're locked too.
  const baseCur = state.settings ? state.settings.baseCurrency : 'USD';
  const fxRoot = allRoots.find((c) => /fx|exchange/i.test(c.name));
  if (fxRoot) {
    let feeC = 0, feeP = 0;
    for (const e of state.expenses) {
      if ((e.payMethod || 'card') === 'card' && e.currency !== baseCur) {
        feeC += Number(e.baseAmount) * 0.01;
        feeP += Number(e.paidBase) * 0.01;
      }
    }
    committed[fxRoot.id] += feeC;
    paid[fxRoot.id] += feeP;
  }
  // "separate" buckets (e.g. Shopping) live OUTSIDE the trip budget:
  // excluded from totals, donut, category list, and the day chart.
  const tripRoots = allRoots.filter((c) => !c.separate);
  const sepRoots = allRoots.filter((c) => c.separate);
  return { childrenMap, isLeaf, budget, committed, paid, roots: tripRoots, tripRoots, sepRoots };
}

// leaf ids that belong to separate buckets (for excluding from the day chart)
function separateLeafIds() {
  const sepRootIds = new Set(state.categories.filter((c) => !c.parentId && c.separate).map((c) => c.id));
  return new Set(state.categories.filter((c) => sepRootIds.has(c.id) || sepRootIds.has(c.parentId)).map((c) => c.id));
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
// Illustrated banner scenes — one per trip context, all in the same layered
// alpine style. The scene follows the itinerary automatically.
// Every scene shares one grammar: a dusk sky, a soft glow, a hazed far range,
// a held mid ridge, a grounded near slope, then one scene-specific subject.
// Atmospheric perspective (distant = lighter/cooler) does the heavy lifting.
const HERO_DEFS = `<defs>
  <linearGradient id="sky-warm" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fbb98f"/><stop offset=".5" stop-color="#8f7ae0"/><stop offset="1" stop-color="#2c3573"/></linearGradient>
  <linearGradient id="sky-night" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#141a3d"/><stop offset=".58" stop-color="#454399"/><stop offset="1" stop-color="#d081a0"/></linearGradient>
  <linearGradient id="sky-day" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7db8e6"/><stop offset="1" stop-color="#e7dcc4"/></linearGradient>
  <linearGradient id="haze" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".34"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
  <radialGradient id="glow" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff5d8" stop-opacity=".55"/><stop offset="1" stop-color="#fff5d8" stop-opacity="0"/></radialGradient>
</defs>`;
const svg = (inner) => `<svg class="hero__mountains" viewBox="0 0 375 160" preserveAspectRatio="xMidYMax slice" aria-hidden="true">${HERO_DEFS}${inner}</svg>`;
// haze band that sits along the horizon and separates the depth layers
const HAZE = `<rect x="0" y="96" width="375" height="30" fill="url(#haze)"/>`;

const HERO_SCENES = {
  alps: svg(`
    <rect width="375" height="160" fill="url(#sky-warm)"/>
    <circle cx="292" cy="46" r="60" fill="url(#glow)" transform="translate(292 46)"/><circle cx="292" cy="46" r="15" fill="#ffe9b8"/>
    <path d="M0 160 L60 96 L120 132 L190 88 L250 128 L320 100 L375 138 L375 160 Z" fill="#6f77c4" opacity=".45"/>
    ${HAZE}
    <path d="M0 160 L95 70 L150 118 L215 62 L300 120 L375 92 L375 160 Z" fill="#3f4894"/>
    <path d="M215 62 L233 88 L197 88 Z" fill="#eef1ff"/><path d="M215 62 L215 88 L197 88 Z" fill="#c9cff0"/>
    <path d="M95 70 L110 92 L80 92 Z" fill="#eef1ff"/>
    <path d="M0 160 L70 112 L140 150 L210 118 L290 152 L375 126 L375 160 Z" fill="#272c63"/>`),

  flight: svg(`
    <rect width="375" height="160" fill="url(#sky-night)"/>
    <g fill="#fff"><circle cx="40" cy="26" r="1.5" opacity=".9"/><circle cx="96" cy="16" r="1" opacity=".6"/><circle cx="150" cy="30" r="1.2" opacity=".7"/><circle cx="205" cy="18" r="1.4" opacity=".85"/><circle cx="270" cy="34" r="1" opacity=".6"/><circle cx="320" cy="22" r="1.3" opacity=".75"/><circle cx="352" cy="40" r="1" opacity=".55"/></g>
    <circle cx="250" cy="30" r="46" fill="url(#glow)" transform="translate(250 30)"/><circle cx="250" cy="30" r="12" fill="#f3ead2"/><circle cx="245" cy="27" r="3.2" fill="#dccdae" opacity=".7"/>
    <path d="M64 60 q54 -5 104 -3" stroke="#fff" stroke-width="2.4" stroke-linecap="round" opacity=".32" stroke-dasharray="1.5 9"/>
    <path d="M172 60 h54 M186 60 l17 -10 h9 l-10 10 M186 60 l17 9 h9 l-10 -9 M172 60 l-7 -5 h6" stroke="#fff" stroke-width="4.6" stroke-linejoin="round" stroke-linecap="round" fill="none"/>
    <path d="M0 160 L80 118 L150 146 L230 116 L310 148 L375 122 L375 160 Z" fill="#3a3f7e" opacity=".7"/>
    ${HAZE}
    <path d="M0 160 L90 128 L180 156 L270 126 L375 150 L375 160 Z" fill="#242a55"/>`),

  drive: svg(`
    <rect width="375" height="160" fill="url(#sky-day)"/>
    <circle cx="58" cy="40" r="40" fill="url(#glow)" transform="translate(58 40)"/><circle cx="58" cy="40" r="15" fill="#fff2be"/>
    <path d="M0 160 L100 60 L160 118 L225 50 L300 108 L375 74 L375 160 Z" fill="#7f9bce" opacity=".55"/>
    <path d="M225 50 L243 78 L207 78 Z" fill="#f2f6ff"/>
    ${HAZE}
    <path d="M0 160 L110 96 L200 140 L300 104 L375 132 L375 160 Z" fill="#516aa8"/>
    <path d="M150 160 C 196 128 150 110 212 96 C 250 87 258 78 270 64" stroke="#2f3a5c" stroke-width="15" fill="none" stroke-linecap="round"/>
    <path d="M150 160 C 196 128 150 110 212 96 C 250 87 258 78 270 64" stroke="#f4f3ef" stroke-width="1.8" fill="none" stroke-dasharray="6 8" opacity=".9"/>
    <path d="M0 160 Q120 150 375 156 L375 160 Z" fill="#3a4f7a" opacity=".55"/>`),

  russbach: svg(`
    <rect width="375" height="160" fill="url(#sky-day)"/>
    <circle cx="312" cy="36" r="38" fill="url(#glow)" transform="translate(312 36)"/><circle cx="312" cy="36" r="14" fill="#fff2be"/>
    <path d="M0 160 L70 84 L150 132 L230 74 L320 120 L375 96 L375 160 Z" fill="#8aa6b0" opacity=".5"/>
    <path d="M230 74 L246 98 L214 98 Z" fill="#eef4f8"/>
    ${HAZE}
    <path d="M0 160 Q95 118 210 138 Q300 154 375 128 L375 160 Z" fill="#7bad6b"/>
    <path d="M0 160 Q120 150 375 150 L375 160 Z" fill="#5f9455"/>
    <g><rect x="177" y="106" width="25" height="26" fill="#fbf8f0"/><path d="M173 106 L189.5 90 L206 106 Z" fill="#a75a26"/>
      <rect x="185.5" y="72" width="8" height="34" fill="#fbf8f0"/><path d="M185.5 72 q4 -11 8 0 Z" fill="#2f3a5c"/><circle cx="189.5" cy="66" r="3" fill="#2f3a5c"/></g>
    <rect x="238" y="118" width="21" height="17" fill="#efe0c8"/><path d="M234 118 L248.5 106 L263 118 Z" fill="#7a4a22"/>
    <g fill="#3e7a4f"><path d="M120 134 l7 -17 l7 17 Z"/><path d="M136 136 l6 -14 l6 14 Z"/><path d="M300 138 l6 -14 l6 14 Z"/></g>`),

  glockner: svg(`
    <rect width="375" height="160" fill="url(#sky-warm)"/>
    <circle cx="66" cy="42" r="44" fill="url(#glow)" transform="translate(66 42)"/><circle cx="66" cy="42" r="13" fill="#ffd9e6"/>
    <path d="M0 160 L80 74 L150 128 L220 60 L300 120 L375 84 L375 160 Z" fill="#7b6aa8" opacity=".45"/>
    ${HAZE}
    <path d="M0 160 L95 44 L150 104 L210 32 L300 116 L375 72 L375 160 Z" fill="#332e60"/>
    <path d="M210 32 L230 66 L190 66 Z" fill="#f2ecfb"/><path d="M210 32 L210 66 L190 66 Z" fill="#cbc4e6"/>
    <path d="M95 44 L112 72 L78 72 Z" fill="#f2ecfb"/>
    <path d="M0 160 L85 116 L170 152 L260 118 L375 146 L375 160 Z" fill="#221d45"/>
    <path d="M40 160 C 92 150 60 136 126 130 C 176 126 156 116 198 110" stroke="#171334" stroke-width="6" fill="none" stroke-linecap="round" opacity=".85"/>`),

  stubai: svg(`
    <rect width="375" height="160" fill="url(#sky-day)"/>
    <circle cx="316" cy="34" r="40" fill="url(#glow)" transform="translate(316 34)"/><circle cx="316" cy="34" r="14" fill="#fff4c8"/>
    <path d="M0 160 L70 66 L150 130 L235 54 L320 118 L375 90 L375 160 Z" fill="#7f9dc4" opacity=".5"/>
    ${HAZE}
    <path d="M0 160 L60 58 L130 150 Z" fill="#41599a"/><path d="M60 58 L77 88 L42 88 Z" fill="#eef6ff"/>
    <path d="M245 160 L318 52 L375 138 L375 160 Z" fill="#3f5793"/><path d="M318 52 L334 82 L302 82 Z" fill="#eef6ff"/>
    <path d="M108 160 L188 60 L268 160 Z" fill="#c7dcee"/><path d="M188 60 L216 104 L160 104 Z" fill="#fbfdff"/><path d="M188 60 L188 104 L160 104 Z" fill="#dbe8f4"/>
    <path d="M182 160 Q189 120 188 104" stroke="#9ad2e8" stroke-width="4.5" fill="none" stroke-linecap="round" opacity=".9"/>
    <path d="M0 160 Q110 150 375 154 L375 160 Z" fill="#7bb06e"/>`),

  grindelwald: svg(`
    <rect width="375" height="160" fill="url(#sky-warm)"/>
    <circle cx="54" cy="34" r="40" fill="url(#glow)" transform="translate(54 34)"/><circle cx="54" cy="34" r="13" fill="#ffe4b0"/>
    <path d="M0 160 L70 80 L150 132 L250 70 L340 120 L375 100 L375 160 Z" fill="#7385c4" opacity=".45"/>
    ${HAZE}
    <path d="M120 160 L236 16 L344 160 Z" fill="#3c4166"/>
    <path d="M236 16 L268 64 L236 64 L251 92 L207 92 L221 64 L204 64 Z" fill="#f3f6fb"/>
    <path d="M236 16 L236 64 L221 64 L207 92 L229 92 L236 78 Z" fill="#cdd4e6"/>
    <path d="M0 160 L80 96 L175 150 Z" fill="#5c8a34" opacity=".5"/><path d="M262 160 L326 104 L375 142 L375 160 Z" fill="#4a63a0" opacity=".65"/>
    <path d="M0 160 Q120 146 375 152 L375 160 Z" fill="#6ba85c"/>
    <g><rect x="78" y="128" width="24" height="20" fill="#efe0c8"/><path d="M73 128 L90 112 L107 128 Z" fill="#7a4a22"/></g>
    <rect x="128" y="136" width="18" height="13" fill="#efe0c8"/><path d="M124 136 L137 124 L150 136 Z" fill="#8a5a2b"/>`),

  munich: svg(`
    <rect width="375" height="160" fill="url(#sky-night)"/>
    <g fill="#fff"><circle cx="46" cy="22" r="1.3" opacity=".8"/><circle cx="120" cy="16" r="1" opacity=".55"/><circle cx="300" cy="20" r="1.2" opacity=".7"/><circle cx="352" cy="30" r="1" opacity=".5"/></g>
    <circle cx="58" cy="38" r="40" fill="url(#glow)" transform="translate(58 38)"/><circle cx="58" cy="38" r="12" fill="#ffe6bc"/>
    <path d="M0 160 L60 118 L150 150 L250 116 L375 146 L375 160 Z" fill="#4a4a86" opacity=".4"/>
    ${HAZE}
    <path d="M0 160 V122 h30 v-14 h22 v14 h24 V98 h34 v62 Z" fill="#20223f"/>
    <rect x="150" y="74" width="17" height="86" fill="#282a4d"/><path d="M150 74 q8.5 -16 17 0 Z" fill="#343764"/><circle cx="158.5" cy="55" r="5" fill="#343764"/>
    <rect x="176" y="74" width="17" height="86" fill="#282a4d"/><path d="M176 74 q8.5 -16 17 0 Z" fill="#343764"/><circle cx="184.5" cy="55" r="5" fill="#343764"/>
    <path d="M205 160 V110 h28 v-18 h20 v18 h26 v50 Z" fill="#20223f"/><path d="M290 160 V126 h40 v-20 h24 v54 Z" fill="#282a4d"/>
    <g fill="#ffd98a"><rect x="10" y="130" width="3.2" height="4.6" opacity=".95"/><rect x="40" y="116" width="3.2" height="4.6" opacity=".8"/><rect x="62" y="132" width="3.2" height="4.6" opacity=".9"/><rect x="214" y="122" width="3.2" height="4.6" opacity=".85"/><rect x="240" y="102" width="3.2" height="4.6" opacity=".95"/><rect x="300" y="136" width="3.2" height="4.6" opacity=".8"/><rect x="340" y="118" width="3.2" height="4.6" opacity=".9"/><rect x="155" y="92" width="2.8" height="4.6" opacity=".7"/><rect x="181" y="100" width="2.8" height="4.6" opacity=".7"/></g>`),
};

// Which scene fits today? Movement beats location; location maps by base.
function heroScene() {
  const stop = currentStop();
  if (!stop) return 'alps';
  const p = (stop.place || '').toLowerCase();
  const l = (stop.line || '').toLowerCase();
  if (p.includes('→') || l.includes('fly')) return 'flight';
  if (l.includes('drive')) return 'drive';
  if (p.includes('rußbach') || p.includes('russbach')) return 'russbach';
  if (p.includes('glockner') || p.includes('dachstein')) return 'glockner';
  if (p.includes('stubai')) return 'stubai';
  if (p.includes('munich') || p.includes('salzburg')) return 'munich';
  return 'grindelwald'; // Grindelwald base + all its Swiss day trips
}

function renderHero() {
  $('#heroTitle').textContent = state.settings.tripName;
  $('#heroDates').textContent = state.settings.tripDates || '';
  $('#heroDate').textContent = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long',
  });
  const art = $('#heroArt');
  if (state.settings.bannerImage) {
    if (art.dataset.scene !== 'photo') { art.innerHTML = `<img src="${state.settings.bannerImage}" alt="" />`; art.dataset.scene = 'photo'; }
  } else {
    const scene = heroScene();
    if (art.dataset.scene !== scene) { art.innerHTML = HERO_SCENES[scene] || HERO_SCENES.alps; art.dataset.scene = scene; }
  }
  renderCountdown();
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

  setMoney($('#totalCommitted'), totalCommitted);
  setMoney($('#totalLeft'), totalLeft);
  $('#totalLeft').classList.toggle('is-over', totalLeft < 0);
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

  renderWidgets(t);
  renderDonut();
}

// ================= WIDGETS (F&D pace + Shopping bucket) =================
function tripSpan() {
  if (!state.itinerary.length) return null;
  const start = new Date(state.itinerary[0].date + 'T00:00:00');
  const lastMid = new Date(state.itinerary[state.itinerary.length - 1].date + 'T00:00:00');
  const total = Math.round((lastMid - start) / 86400e3) + 1;
  return { start, total };
}

function renderWidgets(t) {
  const row = $('#widgetRow');
  let html = '';

  // --- Food & Drinks: the fast-moving category, tracked by daily pace ---
  const fnb = t.tripRoots.find((c) => /food/i.test(c.name));
  if (fnb) {
    const spent = t.committed[fnb.id];
    const span = tripSpan();
    const target = span ? fnb.budget / span.total : null;
    const now = new Date();
    let avgTxt, subTxt, tone = 'ok';
    if (span && now >= span.start) {
      const daysIn = Math.min(Math.floor((now - span.start) / 86400e3) + 1, span.total);
      const avg = spent / daysIn;
      avgTxt = fmtBase(avg) + '<small>/day</small>';
      subTxt = `target ${fmtBase(target)}/day · spent ${fmtBase(spent)}`;
      tone = avg > target * 1.1 ? 'over' : 'ok';
    } else {
      avgTxt = fmtBase(spent);
      subTxt = target ? `pace starts with the trip · target ${fmtBase(target)}/day` : 'pace starts with the trip';
    }
    const pct = fnb.budget > 0 ? Math.min((spent / fnb.budget) * 100, 100) : 0;
    html += `
      <div class="widget">
        <div class="widget__head">${catIcon(fnb)} ${escapeHtml(fnb.name)}</div>
        <div class="widget__big ${tone === 'over' ? 'is-over' : ''}">${avgTxt}</div>
        <div class="widget__bar"><i style="width:${pct}%;background:${fnb.color}"></i></div>
        <div class="widget__sub">${subTxt}</div>
      </div>`;
  }

  // --- Shopping: its own wallet, deliberately OUTSIDE the trip budget ---
  const shop = t.sepRoots[0];
  if (shop) {
    const spent = t.committed[shop.id];
    const left = t.budget[shop.id] - spent;
    const pct = t.budget[shop.id] > 0 ? Math.min((spent / t.budget[shop.id]) * 100, 100) : 0;
    html += `
      <div class="widget">
        <div class="widget__head">${catIcon(shop)} ${escapeHtml(shop.name)}</div>
        <div class="widget__big ${left < 0 ? 'is-over' : ''}">${left < 0 ? 'Over ' + fmtBase(-left) : fmtBase(left) + '<small> left</small>'}</div>
        <div class="widget__bar"><i style="width:${pct}%;background:${shop.color}"></i></div>
        <div class="widget__sub">spent ${fmtBase(spent)} of ${fmtBase(t.budget[shop.id])} · separate budget</div>
      </div>`;
  }

  // --- Half Fare Card: a recoup meter that starts in the RED (down the 300 CHF
  // the cards cost) and climbs through break-even into the GREEN as ½-fare
  // savings pile up. Net = saved − investment. With the HFC you pay half, so
  // every ½-fare franc paid IS a franc saved.
  {
    const INVEST = 300; // 2 × Swiss Half Fare Card, CHF
    const chfBuys = state.expenses.filter((e) => e.currency === 'CHF');
    const saved = chfBuys.filter((e) => e.halfFare).reduce((s, e) => s + Number(e.amount), 0);
    const net = saved - INVEST;                       // negative until break-even
    const fmtCHF = (v) => Currency.format(Math.round(v), 'CHF', state.currencies);
    const p = Math.max(-1, Math.min(1, net / INVEST)); // -1 (fully in the red) … +1
    const green = net >= 0;
    const col = green ? 'var(--ok)' : '#e0544f';
    const fillLeft = p < 0 ? 50 + p * 50 : 50;         // % from left
    const fillW = Math.abs(p) * 50;                    // %
    const headline = green ? '+' + fmtCHF(net) : '−' + fmtCHF(-net);
    let sub;
    if (saved === 0) sub = chfBuys.length
      ? `tick “½ fare” on Swiss tickets so they count · ${fmtCHF(INVEST)} to recoup`
      : `${fmtCHF(INVEST)} invested · savings start in Switzerland`;
    else if (net < 0) sub = `saved ${fmtCHF(saved)} of ${fmtCHF(INVEST)} · ${fmtCHF(-net)} to break even`;
    else if (net === 0) sub = `broke even — every franc from here is profit`;
    else sub = `🎉 recouped · ${fmtCHF(net)} ahead`;
    html += `
      <div class="widget">
        <div class="widget__head">🚆 Half Fare Card</div>
        <div class="widget__big" style="color:${col}">${headline}</div>
        <div class="dbar">
          <span class="dbar__fill" style="left:${fillLeft}%;width:${fillW}%;background:${col}"></span>
          <span class="dbar__zero"></span>
        </div>
        <div class="widget__sub">${sub}</div>
      </div>`;
  }

  // --- Card vs Cash: the envelope of physical money ---
  {
    const withdrawn = state.withdrawals.reduce((s, w) => s + Number(w.baseAmount), 0);
    const cashSpent = state.expenses.filter((e) => e.payMethod === 'cash').reduce((s, e) => s + Number(e.baseAmount), 0);
    const cashLeft = withdrawn - cashSpent;
    const pct = withdrawn > 0 ? Math.min((cashSpent / withdrawn) * 100, 100) : 0;
    html += `
      <div class="widget">
        <div class="widget__head">💵 Cash <button type="button" class="widget__act" data-addcash>+ cash</button></div>
        <div class="widget__big ${cashLeft < 0 ? 'is-over' : ''}">${fmtBase(cashLeft)}<small> left</small></div>
        <div class="widget__bar"><i style="width:${pct}%;background:#8a9455"></i></div>
        <div class="widget__sub">${withdrawn > 0 ? `in ${fmtBase(withdrawn)} · spent ${fmtBase(cashSpent)}` : 'add your starting cash with “+ cash”'}</div>
      </div>`;
  }

  row.innerHTML = html;
  row.hidden = !html;
  const addCashBtn = row.querySelector('[data-addcash]');
  if (addCashBtn) addCashBtn.onclick = (ev) => { ev.stopPropagation(); openCashSheet(); };
}

// ---------- cash sheet ----------
function openCashSheet() {
  $('#cashAmount').value = '';
  const sel = $('#cashCurrency');
  sel.innerHTML = '';
  for (const c of state.currencies) { const o = el('option'); o.value = c.code; o.textContent = c.code; sel.appendChild(o); }
  sel.value = state.settings.baseCurrency;
  $('#cashSheet').hidden = false;
  setTimeout(() => $('#cashAmount').focus(), 50);
}
async function saveCash() {
  const amount = parseFloat($('#cashAmount').value);
  if (!amount || amount <= 0) { $('#cashAmount').focus(); return; }
  const currency = $('#cashCurrency').value;
  await Store.addWithdrawal({
    amount, currency,
    baseAmount: Currency.toBase(amount, currency, state.rates), // locked at today's rate
    who: Auth.user.who,
  });
  $('#cashSheet').hidden = true;
  await loadAll();
  renderDashboard();
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

// ================= COUNTDOWN (hero clock) =================
// Derived from the itinerary's first/last dates: counts down to takeoff,
// then counts the trip days, then rests. Refreshes every minute so it
// rolls over midnight without a reload.
function renderCountdown() {
  const box = $('#heroCountdown');
  if (!state.itinerary.length) { box.hidden = true; return; }
  const start = new Date(state.itinerary[0].date + 'T00:00:00');
  const last = new Date(state.itinerary[state.itinerary.length - 1].date + 'T23:59:59');
  const now = new Date();
  let big, small;
  if (now < start) {
    const days = Math.ceil((start - now) / 86400e3);
    big = String(days);
    small = days === 1 ? 'day to go' : 'days to go';
  } else if (now <= last) {
    const day = Math.floor((now - start) / 86400e3) + 1;
    const lastMid = new Date(state.itinerary[state.itinerary.length - 1].date + 'T00:00:00');
    const total = Math.round((lastMid - start) / 86400e3) + 1; // inclusive day count
    big = 'Day ' + day;
    small = 'of ' + total;
  } else {
    big = '🏁';
    small = 'trip complete';
  }
  $('#cdBig').textContent = big;
  $('#cdSmall').textContent = small;
  box.hidden = false;
}
setInterval(() => { if (state.tab === 'home' && state.itinerary.length) renderCountdown(); }, 60e3);

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

  // legend — mirrors the slices; tapping a row focuses that slice (and back)
  const legend = $('#donutLegend');
  legend.innerHTML = data.map((d) => {
    const pctOf = Math.round((d.v / total) * 100);
    const on = state.donutFocus === d.c.id;
    return `
      <button type="button" class="lg-row ${on ? 'is-on' : ''}" data-cat="${d.c.id}">
        <span class="lg-dot" style="background:${d.c.color}"></span>
        <span class="lg-name">${catIcon(d.c)} ${escapeHtml(d.c.name)}</span>
        <span class="lg-amt">${fmtBase(d.v)}</span>
        <span class="lg-pct">${pctOf}%</span>
      </button>`;
  }).join('');

  const toggleFocus = (id) => {
    state.donutFocus = state.donutFocus === id ? null : id;
    renderDonut();
  };
  svg.querySelectorAll('.donut-seg').forEach((n) => { n.onclick = () => toggleFocus(n.dataset.cat); });
  legend.querySelectorAll('.lg-row').forEach((n) => { n.onclick = () => toggleFocus(n.dataset.cat); });
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
  const sepLeaves = separateLeafIds(); // shopping etc. tracks its own pace
  for (const e of state.expenses) {
    if (sepLeaves.has(e.categoryId)) continue;
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
  syncHalfFareRow();
  renderChips($('#catChips'), () => state.addCategoryId, (id) => { state.addCategoryId = id; });
}

// the ½-fare checkbox only makes sense for Swiss (CHF) purchases
function syncHalfFareRow() {
  const isCHF = $('#expCurrency').value === 'CHF';
  $('#hfcRow').hidden = !isCHF;
  if (!isCHF) $('#expHalfFare').checked = false;
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
    payMethod: state.addPay || 'card',
    halfFare: currency === 'CHF' && $('#expHalfFare').checked,
  });
  $('#expAmount').value = '';
  $('#expNote').value = '';
  $('#expDeposit').value = '';
  $('#expHalfFare').checked = false;
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
          ${e.halfFare ? '<span class="pill pill--hfc">½ fare</span>' : ''}
          ${e.payMethod === 'cash' ? '<span class="pill pill--cash">cash</span>' : ''}
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
  state.editPay = e.payMethod || 'card';
  $('#editPaySeg').querySelectorAll('button').forEach((b) => b.classList.toggle('is-active', b.dataset.pay === state.editPay));
  $('#editHalfFare').checked = !!e.halfFare;
  $('#editHfcRow').hidden = e.currency !== 'CHF';
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
    payMethod: state.editPay || 'card',
    halfFare: currency === 'CHF' && $('#editHalfFare').checked,
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

// ================= SYNC STATUS CHIP =================
// Quiet, honest feedback: appears only when offline or when writes are waiting
// to upload. Never nags when everything is synced.
function renderSyncChip(s) {
  let chip = $('#syncChip');
  if (!chip) {
    chip = el('div', 'sync-chip'); chip.id = 'syncChip'; document.body.appendChild(chip);
  }
  const show = s.offline || s.pending > 0;
  chip.hidden = !show;
  chip.classList.toggle('is-offline', s.offline);
  if (!show) return;
  if (s.offline) chip.innerHTML = `<span class="sync-dot"></span>Offline · ${s.pending ? s.pending + ' waiting' : 'changes save here'}`;
  else chip.innerHTML = `<span class="sync-dot sync-dot--spin"></span>Syncing ${s.pending}…`;
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
  state.addPay = 'card';
  $('#paySeg').querySelectorAll('button').forEach((btn) => {
    btn.onclick = () => {
      state.addPay = btn.dataset.pay;
      $('#paySeg').querySelectorAll('button').forEach((b) => b.classList.toggle('is-active', b === btn));
    };
  });
  $('#expCurrency').onchange = syncHalfFareRow;
  $('#editPaySeg').querySelectorAll('button').forEach((btn) => {
    btn.onclick = () => {
      state.editPay = btn.dataset.pay;
      $('#editPaySeg').querySelectorAll('button').forEach((b) => b.classList.toggle('is-active', b === btn));
    };
  });
  $('#editCurrency').onchange = (ev) => { $('#editHfcRow').hidden = ev.target.value !== 'CHF'; };
  $('#cancelCashBtn').onclick = () => { $('#cashSheet').hidden = true; };
  $('#saveCashBtn').onclick = saveCash;
  $('#cashSheet').onclick = (e) => { if (e.target.id === 'cashSheet') $('#cashSheet').hidden = true; };

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
    window.onSyncState = renderSyncChip;
    await Store.init();
    await loadAll();
    refreshRatesDaily(); // background; don't block boot on the rate feed
    renderDisplayCurrencyOptions();
    switchTab(state.tab || 'home');
    subscribeRealtime();
    renderSyncChip(Store.syncState());
  } catch (e) {
    // Never fail silently into a dead skeleton — say what broke.
    console.error('boot failed', e);
    alert('Could not load trip data: ' + (e && e.message ? e.message : e));
  }
}

// re-render whatever tab is showing, from the current (mirror) state
function refreshCurrentTab() {
  if (state.tab === 'home') { renderHero(); renderBrief(); renderQuickAdd(); renderDashboard(); }
  if (state.tab === 'ledger') { renderDayChart(); renderLedger(); }
  if (state.tab === 'settings') renderSettings();
}
async function refreshUI() { await loadAll(); refreshCurrentTab(); }

// Live sync: when Gil or Tammy's phone writes anywhere, both phones pull the
// change into their local mirror and repaint within a second or two.
function subscribeRealtime() {
  if (realtimeChannel) return; // already listening
  realtimeChannel = sb.channel('trip-changes')
    .on('postgres_changes', { event: '*', schema: 'public' }, debounce(async () => {
      await Store.sync();   // flush anything pending, then pull server truth
      await refreshUI();
    }, 400))
    .subscribe();

  // reconnect / return-to-app → sync and repaint
  window.onSynced = () => refreshUI();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) Store.sync().then(refreshUI); });
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// Subtle hero parallax — the title/countdown drift up and fade as you scroll,
// floating over the static illustrated peaks for a sense of depth. rAF-throttled,
// disabled under reduced-motion. No transform on the art, so the composition
// is never cropped.
(function heroParallax() {
  if (reducedMotion) return;
  let ticking = false;
  window.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      if (state.tab === 'home') {
        const y = Math.min(window.scrollY, 200);
        const content = document.getElementById('heroContent');
        const count = document.getElementById('heroCountdown');
        const fade = 1 - y / 260;
        if (content) { content.style.transform = `translateY(${(y * 0.2).toFixed(1)}px)`; content.style.opacity = fade.toFixed(2); }
        if (count && !count.hidden) { count.style.transform = `translateY(${(y * 0.12).toFixed(1)}px)`; count.style.opacity = fade.toFixed(2); }
      }
      ticking = false;
    });
  }, { passive: true });
})();

window.main = main;
