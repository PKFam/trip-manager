// currency.js — pure conversion + formatting helpers. No state.
//
// Convention: rates[CODE] = value of 1 unit of CODE expressed in BASE currency.
// The base currency's rate is always 1.
//   toBase(amount, from)      = amount * rates[from]
//   fromBase(baseAmount, to)  = baseAmount / rates[to]
//   convert(amount, from, to) = amount * rates[from] / rates[to]

const Currency = {
  toBase(amount, from, rates) {
    const r = rates[from] ?? 1;
    return Number(amount) * r;
  },

  fromBase(baseAmount, to, rates) {
    const r = rates[to] ?? 1;
    return Number(baseAmount) / r;
  },

  convert(amount, from, to, rates) {
    if (from === to) return Number(amount);
    return this.fromBase(this.toBase(amount, from, rates), to, rates);
  },

  symbolFor(code, currencies) {
    const c = currencies.find((x) => x.code === code);
    return c ? c.symbol : '';
  },

  // Formats a money amount with the currency's symbol and sensible separators.
  format(amount, code, currencies) {
    const sym = this.symbolFor(code, currencies);
    const n = Number(amount);
    const big = Math.abs(n) >= 1000;
    const hasCents = !big && Math.abs(n % 1) > 0.004;
    const str = new Intl.NumberFormat('en-US', {
      minimumFractionDigits: hasCents ? 2 : 0,
      maximumFractionDigits: big ? 0 : 2,
    }).format(n);
    return `${sym}${str}`;
  },
};

window.Currency = Currency;
