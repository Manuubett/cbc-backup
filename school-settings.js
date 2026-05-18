/**
 * school-settings.js
 * Loaded by every page. Reads the school config from Firestore once,
 * caches it in localStorage, and exposes applySchoolSettings(db) globally.
 *
 * Firestore path: settings/school
 *
 * Usage in each HTML page — add AFTER firebase init:
 *   <script src="school-settings.js"></script>
 *   then call: await applySchoolSettings(db);
 */

const SETTINGS_CACHE_TTL = 60 * 60 * 1000; // 1 hour

// ── Get cache key per school (keyed by uid, not shared) ──
function _settingsCacheKey(){
  // uid is stored after login in window._schoolId or fallback
  const uid = window._schoolId || localStorage.getItem('cbe_current_uid') || 'shared';
  return 'cbe_school_settings_' + uid;
}

// ── Load settings (cache-first, then Firestore) ──
// Reads from settings/{uid} — each school has its own doc
async function loadSchoolSettings(db) {
  const uid = window._schoolId || localStorage.getItem('cbe_current_uid');
  if(!uid) return null; // can't load without knowing which school

  const cacheKey = _settingsCacheKey();

  // 1. Try cache
  try {
    const raw = localStorage.getItem(cacheKey);
    if (raw) {
      const { data, ts } = JSON.parse(raw);
      if (Date.now() - ts < SETTINGS_CACHE_TTL) return data;
    }
  } catch (_) {}

  // 2. Fetch from Firestore — settings/{uid} not settings/school
  const snap = await db.collection('settings').doc(uid).get();
  if (!snap.exists) return null;
  const data = snap.data();

  // Save to cache (per-school key)
  try {
    localStorage.setItem(cacheKey, JSON.stringify({ data, ts: Date.now() }));
  } catch (_) {}

  return data;
}

// ── Apply settings to the current page ──
async function applySchoolSettings(db) {
  const s = await loadSchoolSettings(db);
  if (!s) return;

  // Store globally so any page can access
  window.schoolSettings = s;

  // ── Page title ──
  if (s.name) document.title = s.name + ' | CBE Mark Sheet';

  // ── Header logo text ──
  const lt = document.querySelector('.lt');
  if (lt && s.name) lt.textContent = s.name;

  const ls = document.querySelector('.ls');
  if (ls && s.tagline) ls.textContent = s.tagline;

  // ── Header logo image (if set) ──
  const lm = document.querySelector('.lm');
  if (lm && s.logoUrl) {
    lm.innerHTML = `<img src="${s.logoUrl}" style="width:100%;height:100%;object-fit:contain;border-radius:inherit" onerror="this.style.display='none'">`;
  }

  // ── Brand colors ──
  if (s.primaryColor) {
    document.documentElement.style.setProperty('--accent', s.primaryColor);
    document.documentElement.style.setProperty('--ah', darken(s.primaryColor, 10));
    document.documentElement.style.setProperty('--alight', s.primaryColor + '18');
  }

  // ── Print header — inject if not already present ──
  injectPrintHeader(s);
}

// ── Inject a print-only school header ──
function injectPrintHeader(s) {
  if (document.getElementById('printHeader')) return;
  const div = document.createElement('div');
  div.id = 'printHeader';
  div.style.cssText = 'display:none';
  div.innerHTML = `
    <div class="ph-inner">
      ${s.logoUrl ? `<img src="${s.logoUrl}" class="ph-logo" onerror="this.style.display='none'">` : ''}
      <div class="ph-text">
        <div class="ph-name">${s.name || 'Junior School'}</div>
        ${s.motto ? `<div class="ph-motto">${s.motto}</div>` : ''}
        ${s.county ? `<div class="ph-county">${s.county}</div>` : ''}
      </div>
    </div>`;
  document.body.insertBefore(div, document.body.firstChild);

  // Inject print CSS
  const style = document.createElement('style');
  style.textContent = `
    @media print {
      #printHeader { display:block !important; margin-bottom:16px; }
      .ph-inner {
        display:flex; align-items:center; gap:14px;
        padding-bottom:10px; border-bottom:2px solid #1e2d4d;
        margin-bottom:12px;
      }
      .ph-logo { width:64px; height:64px; object-fit:contain; }
      .ph-text { flex:1; }
      .ph-name {
        font-family:'Familjen Grotesk',sans-serif;
        font-size:20px; font-weight:800; color:#131c2e;
        letter-spacing:-.3px; line-height:1.1;
      }
      .ph-motto { font-size:11px; color:#4f6080; font-style:italic; margin-top:2px; }
      .ph-county { font-size:11px; color:#9aaabb; margin-top:1px; }
    }
  `;
  document.head.appendChild(style);
}

// ── Utility: darken a hex color by percent ──
function darken(hex, pct) {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = Math.max(0, (n >> 16) - Math.round(2.55 * pct));
  const g = Math.max(0, ((n >> 8) & 0xff) - Math.round(2.55 * pct));
  const b = Math.max(0, (n & 0xff) - Math.round(2.55 * pct));
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

// ── Force refresh settings (called after saving) ──
function clearSettingsCache() {
  localStorage.removeItem(_settingsCacheKey());
  // Also clear old shared key if present
  localStorage.removeItem('cbe_school_settings');
        }
    
