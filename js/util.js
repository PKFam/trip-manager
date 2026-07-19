// util.js — tiny shared helpers, loaded before every other app script.
const $ = (sel) => document.querySelector(sel);
const el = (tag, cls) => { const n = document.createElement(tag); if (cls) n.className = cls; return n; };
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
