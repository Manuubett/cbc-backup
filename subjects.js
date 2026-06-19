/**
 * CBE Mark Sheet System — Subject Configuration
 * Copyright © 2026 Bett Emanuel — https://bett.website
 * All rights reserved.
 *
 * Centralised subject definitions for ALL CBC grades (1–14).
 * Import once in marksheet.html and analysis.html; both pages
 * call  getSubs(gradeStr)  to get the correct subject array.
 *
 * Subject object shape:
 *   { id, label, icon, gc, sc, parts? }
 *   parts: [{id, label}]  — compound subject with sub-scores
 *
 * Column-class conventions (for table header colouring):
 *   gc  = group colour class (thead row 1, wide span)
 *   sc  = sub-colour class   (thead row 2, narrow span)
 */

// ─────────────────────────────────────────────────────────────
// GRADE 1–3  Lower Primary (activity-based)
// ─────────────────────────────────────────────────────────────
const SUBS_LOWER = [
  { id:'math', label:'Mathematical Activities',  icon:'🔢', gc:'g-math', sc:'s-math' },
  { id:'eng',  label:'English',                  icon:'📖', gc:'g-eng',  sc:'s-eng'  },
  { id:'kis',  label:'Kiswahili',                icon:'🗣️', gc:'g-kis',  sc:'s-kis'  },
  { id:'int',  label:'Integrated Activities',    icon:'🌈', gc:'g-sci',  sc:'s-sci'  },
  { id:'crt',  label:'Creative Activities',      icon:'🎨', gc:'g-arts', sc:'s-arts' },
  { id:'cre',  label:'CRE',                      icon:'✝️', gc:'g-re',   sc:'s-re'   },
];

// ─────────────────────────────────────────────────────────────
// GRADE 4–6  Upper Primary
// ─────────────────────────────────────────────────────────────
const SUBS_UPPER = [
  { id:'math', label:'Mathematics',               icon:'🔢', gc:'g-math', sc:'s-math' },
  { id:'eng',  label:'English',                   icon:'📖', gc:'g-eng',  sc:'s-eng',
    parts:[{ id:'lang', label:'Language' },{ id:'comp', label:'Composition' }] },
  { id:'kis',  label:'Kiswahili',                 icon:'🗣️', gc:'g-kis',  sc:'s-kis',
    parts:[{ id:'lugha', label:'Lugha' },{ id:'insha', label:'Insha' }] },
  { id:'sci',  label:'Science and Technology',    icon:'🔬', gc:'g-sci',  sc:'s-sci'  },
  { id:'re',   label:'CRE',                       icon:'✝️', gc:'g-re',   sc:'s-re'   },
  { id:'soc',  label:'Social Studies',            icon:'🌍', gc:'g-soc',  sc:'s-soc'  },
  { id:'arts', label:'Creative Art and Sport',    icon:'🎨', gc:'g-arts', sc:'s-arts' },
  { id:'agri', label:'Agriculture and Nutrition', icon:'🌱', gc:'g-agri', sc:'s-agri' },
];

// ─────────────────────────────────────────────────────────────
// GRADE 7–9  Junior Secondary
// ─────────────────────────────────────────────────────────────
const SUBS_JUNIOR = [
  { id:'eng',  label:'English',                  icon:'📖', gc:'g-eng',  sc:'s-eng',
    parts:[{ id:'lang', label:'Language' },{ id:'comp', label:'Composition' }] },
  { id:'kis',  label:'Kiswahili / KSL',          icon:'🗣️', gc:'g-kis',  sc:'s-kis',
    parts:[{ id:'lugha', label:'Lugha' },{ id:'insha', label:'Insha' }] },
  { id:'math', label:'Mathematics',              icon:'🔢', gc:'g-math', sc:'s-math' },
  { id:'sci',  label:'Integrated Science',       icon:'🔬', gc:'g-sci',  sc:'s-sci'  },
  { id:'soc',  label:'Social Studies',           icon:'🌍', gc:'g-soc',  sc:'s-soc'  },
  { id:'re',   label:'Religious Ed.',            icon:'✝️', gc:'g-re',   sc:'s-re'   },
  { id:'arts', label:'Creative Arts & Sports',   icon:'🎨', gc:'g-arts', sc:'s-arts' },
  { id:'pret', label:'Pre-Technical',            icon:'🔧', gc:'g-pret', sc:'s-pret' },
  { id:'agri', label:'Agriculture & Nutrition',  icon:'🌱', gc:'g-agri', sc:'s-agri' },
];

// ─────────────────────────────────────────────────────────────
// GRADE 10–12  Senior School — Core + Selected Electives
// Based on KICD Senior School Curriculum Designs list
// ─────────────────────────────────────────────────────────────
const SUBS_SENIOR_CORE = [
  // ── COMPULSORY CORE (all students) ──
  { id:'eng',    label:'English',                    icon:'📖', gc:'g-eng',  sc:'s-eng',
    parts:[{ id:'lang', label:'Language' },{ id:'comp', label:'Composition' }] },
  { id:'kis',    label:'Kiswahili / KSL',            icon:'🗣️', gc:'g-kis',  sc:'s-kis',
    parts:[{ id:'lugha', label:'Lugha' },{ id:'insha', label:'Insha' }] },
  { id:'math',   label:'Mathematics',                icon:'🔢', gc:'g-math', sc:'s-math' },
  { id:'pe',     label:'Physical Education',         icon:'🏃', gc:'g-arts', sc:'s-arts' },
  { id:'csl',    label:'Community Service Learning', icon:'🤝', gc:'g-soc',  sc:'s-soc'  },
  // ── HUMANITIES & SOCIAL ──
  { id:'hist',   label:'History & Citizenship',      icon:'🏛️', gc:'g-soc',  sc:'s-soc'  },
  { id:'geo',    label:'Geography',                  icon:'🌍', gc:'g-soc',  sc:'s-soc'  },
  { id:'cre',    label:'CRE',                        icon:'✝️', gc:'g-re',   sc:'s-re'   },
  { id:'ire',    label:'IRE',                        icon:'☪️', gc:'g-re',   sc:'s-re'   },
  { id:'hre',    label:'HRE',                        icon:'🕉️', gc:'g-re',   sc:'s-re'   },
  { id:'biz',    label:'Business Studies',           icon:'💼', gc:'g-soc',  sc:'s-soc'  },
  // ── LANGUAGES ──
  { id:'liteng', label:'Literature in English',      icon:'📚', gc:'g-eng',  sc:'s-eng'  },
  { id:'kip',    label:'Kiswahili Kipevu',           icon:'📜', gc:'g-kis',  sc:'s-kis'  },
  { id:'fasih',  label:'Fasihi ya Kiswahili',        icon:'📜', gc:'g-kis',  sc:'s-kis'  },
  { id:'aeng',   label:'Advanced English',           icon:'📖', gc:'g-eng',  sc:'s-eng'  },
  { id:'arabic', label:'Arabic',                     icon:'🕌', gc:'g-kis',  sc:'s-kis'  },
  { id:'french', label:'French',                     icon:'🇫🇷', gc:'g-eng', sc:'s-eng'  },
  { id:'german', label:'German',                     icon:'🇩🇪', gc:'g-eng', sc:'s-eng'  },
  { id:'mandarin',label:'Chinese (Mandarin)',         icon:'🇨🇳', gc:'g-eng', sc:'s-eng'  },
  { id:'indig',  label:'Indigenous Languages',       icon:'🌿', gc:'g-eng',  sc:'s-eng'  },
  { id:'signl',  label:'Sign Language',              icon:'🤟', gc:'g-eng',  sc:'s-eng'  },
  { id:'ksl',    label:'Kenyan Sign Language',       icon:'🤟', gc:'g-eng',  sc:'s-eng'  },
  // ── SCIENCES ──
  { id:'phy',    label:'Physics',                    icon:'⚛️', gc:'g-sci',  sc:'s-sci'  },
  { id:'chem',   label:'Chemistry',                  icon:'🧪', gc:'g-sci',  sc:'s-sci'  },
  { id:'bio',    label:'Biology',                    icon:'🧬', gc:'g-sci',  sc:'s-sci'  },
  { id:'gsci',   label:'General Science',            icon:'🔬', gc:'g-sci',  sc:'s-sci'  },
  { id:'admath', label:'Advanced Mathematics',       icon:'📐', gc:'g-math', sc:'s-math' },
  // ── CREATIVE & PERFORMING ARTS ──
  { id:'music',  label:'Music and Dance',            icon:'🎵', gc:'g-arts', sc:'s-arts' },
  { id:'theatre',label:'Theatre and Film',           icon:'🎭', gc:'g-arts', sc:'s-arts' },
  { id:'farts',  label:'Fine Arts',                  icon:'🎨', gc:'g-arts', sc:'s-arts' },
  { id:'sport',  label:'Sports and Recreation',      icon:'⚽', gc:'g-arts', sc:'s-arts' },
  { id:'media',  label:'Media Technology',           icon:'📷', gc:'g-pret', sc:'s-pret' },
  // ── TECHNICAL & APPLIED ──
  { id:'aviation',label:'Aviation',                  icon:'✈️', gc:'g-pret', sc:'s-pret' },
  { id:'bldg',   label:'Building & Construction',    icon:'🏗️', gc:'g-pret', sc:'s-pret' },
  { id:'elec',   label:'Electricity',                icon:'⚡', gc:'g-pret', sc:'s-pret' },
  { id:'draw',   label:'Drawing & Design',           icon:'📏', gc:'g-pret', sc:'s-pret' },
  { id:'marine', label:'Marine & Fisheries',         icon:'🐟', gc:'g-agri', sc:'s-agri' },
  { id:'tech',   label:'Technology',                 icon:'💻', gc:'g-pret', sc:'s-pret' },
  { id:'metal',  label:'Metalwork',                  icon:'⚙️', gc:'g-pret', sc:'s-pret' },
  { id:'powmech',label:'Power Mechanics',            icon:'🔩', gc:'g-pret', sc:'s-pret' },
  { id:'agri',   label:'Agriculture',                icon:'🌱', gc:'g-agri', sc:'s-agri' },
  { id:'comp',   label:'Computer Studies',           icon:'🖥️', gc:'g-pret', sc:'s-pret' },
  { id:'home',   label:'Home Science',               icon:'🏠', gc:'g-agri', sc:'s-agri' },
];

// ─────────────────────────────────────────────────────────────
// DEFAULT subject sets per grade band
// Schools that want a custom subset for senior can call
//   setCustomSubs(gradeStr, subIdArray)  before rendering.
// ─────────────────────────────────────────────────────────────

/**
 * Default Senior School subject subset — the 9 most commonly
 * offered subjects. Schools override via setCustomSubs().
 */
const SUBS_SENIOR_DEFAULT = [
  { id:'eng',    label:'English',                    icon:'📖', gc:'g-eng',  sc:'s-eng',
    parts:[{ id:'lang', label:'Language' },{ id:'comp', label:'Composition' }] },
  { id:'kis',    label:'Kiswahili / KSL',            icon:'🗣️', gc:'g-kis',  sc:'s-kis',
    parts:[{ id:'lugha', label:'Lugha' },{ id:'insha', label:'Insha' }] },
  { id:'math',   label:'Mathematics',                icon:'🔢', gc:'g-math', sc:'s-math' },
  { id:'phy',    label:'Physics',                    icon:'⚛️', gc:'g-sci',  sc:'s-sci'  },
  { id:'chem',   label:'Chemistry',                  icon:'🧪', gc:'g-sci',  sc:'s-sci'  },
  { id:'bio',    label:'Biology',                    icon:'🧬', gc:'g-sci',  sc:'s-sci'  },
  { id:'hist',   label:'History & Citizenship',      icon:'🏛️', gc:'g-soc',  sc:'s-soc'  },
  { id:'geo',    label:'Geography',                  icon:'🌍', gc:'g-soc',  sc:'s-soc'  },
  { id:'biz',    label:'Business Studies',           icon:'💼', gc:'g-soc',  sc:'s-soc'  },
];

// ─────────────────────────────────────────────────────────────
// CUSTOM SUBJECT OVERRIDE
// Allows a school to choose which senior subjects appear
// Usage: setCustomSubs('Grade 10', ['eng','kis','math','bio','chem','phy'])
// ─────────────────────────────────────────────────────────────
const _customSubs = {};

window.setCustomSubs = function(gradeStr, idArray) {
  if (!Array.isArray(idArray) || !idArray.length) return;
  const filtered = SUBS_SENIOR_CORE.filter(s => idArray.includes(s.id));
  _customSubs[gradeStr] = filtered;
};

window.clearCustomSubs = function(gradeStr) {
  delete _customSubs[gradeStr];
};

// ─────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────

/**
 * Returns the subject array for a grade string like "Grade 7".
 * Respects custom overrides set via setCustomSubs().
 */
window.getSubs = function(gradeStr) {
  if (_customSubs[gradeStr]) return _customSubs[gradeStr];
  const n = parseInt((gradeStr || '').replace(/\D/g, ''), 10) || 0;
  if (n >= 1  && n <= 3)  return SUBS_LOWER;
  if (n >= 4  && n <= 6)  return SUBS_UPPER;
  if (n >= 7  && n <= 9)  return SUBS_JUNIOR;
  if (n >= 10 && n <= 12) return SUBS_SENIOR_DEFAULT;
  return SUBS_JUNIOR; // fallback
};

/**
 * Returns ALL available Senior School subjects (for a subject
 * picker UI that lets the admin choose which ones to show).
 */
window.isSeniorGrade = function(gradeStr) {
  const n = parseInt((gradeStr || '').replace(/\D/g, ''), 10) || 0;
  return n >= 10 && n <= 12;
};

window.getAllSeniorSubs = function() {
  return SUBS_SENIOR_CORE;
};

/**
 * For a SENIOR student — returns only the subjects they take.
 * studentSubIds = array of subject IDs from the student Firestore doc.
 * Falls back to SUBS_SENIOR_DEFAULT if none assigned yet.
 */
window.getStudentSubs = function(studentSubIds) {
  if (!Array.isArray(studentSubIds) || !studentSubIds.length) {
    return SUBS_SENIOR_DEFAULT;
  }
  return SUBS_SENIOR_CORE.filter(s => studentSubIds.includes(s.id));
};

/**
 * Returns the UNION of all subjects taken by any student in the class,
 * in SUBS_SENIOR_CORE order — used to build marksheet column headers.
 * studentsArr = [{id, subjects:[...]}, ...]
 */
window.getSeniorClassSubs = function(studentsArr) {
  const seen = new Set();
  studentsArr.forEach(s => {
    (Array.isArray(s.subjects) ? s.subjects : []).forEach(id => seen.add(id));
  });
  if (!seen.size) return SUBS_SENIOR_DEFAULT;
  return SUBS_SENIOR_CORE.filter(s => seen.has(s.id));
};

/**
 * Returns true if the grade uses Exam 1 / Exam 2 / Exam 3.
 * ALL CBC grades (1–14) sit three exams per term, so this
 * always returns true for any valid grade string.
 */
window.gradeUsesCats = function(gradeStr) {
  const n = parseInt((gradeStr || '').replace(/\D/g, ''), 10) || 0;
  return n >= 1; // every grade has 3 exams per term
};

/**
 * CBC Level lookup — takes a percentage (0-100).
 */
window.getLevel = function(pct) {
  if (pct >= 90) return { l:'EE1', p:8, c:'ee1' };
  if (pct >= 75) return { l:'EE2', p:7, c:'ee2' };
  if (pct >= 58) return { l:'ME1', p:6, c:'me1' };
  if (pct >= 41) return { l:'ME2', p:5, c:'me2' };
  if (pct >= 31) return { l:'AE1', p:4, c:'ae1' };
  if (pct >= 21) return { l:'AE2', p:3, c:'ae2' };
  if (pct >= 11) return { l:'BE1', p:2, c:'be1' };
  return               { l:'BE2', p:1, c:'be2' };
};

/**
 * Helper — get the subject score from a Firestore result record.
 * Returns null if the subject has no data.
 */
window.getSubjectScore = function(rec, sub) {
  if (!rec) return null;
  if (sub.parts) {
    const tot = rec[`${sub.id}_tot`];
    if (tot !== undefined && tot !== null && Number(tot) > 0) return Number(tot);
    const partSum = sub.parts.reduce((a, p) => {
      const v = rec[`${sub.id}_${p.id}`];
      return a + (v !== undefined && v !== null ? Number(v) : 0);
    }, 0);
    return partSum > 0 ? partSum : null;
  }
  const sc = rec[`${sub.id}_score`];
  return (sc !== undefined && sc !== null && Number(sc) > 0) ? Number(sc) : null;
};

/**
 * Helper — get the "out of" denominator from a result record.
 */
window.getSubjectOof = function(rec, sub, DEFAULT_OOF = 100) {
  if (!rec) return DEFAULT_OOF;
  if (sub.parts) {
    return sub.parts.reduce((a, p) => {
      return a + (rec[`oof_${sub.id}_${p.id}`] || DEFAULT_OOF);
    }, 0);
  }
  return rec[`oof_${sub.id}`] || DEFAULT_OOF;
};

// ─────────────────────────────────────────────────────────────
// SUBJECT PICKER MODAL HELPER
// Call renderSubjectPicker(containerId, gradeStr, onSave)
// to render a checkbox grid of all senior subjects so the admin
// can pick which ones appear in the mark sheet.
// ─────────────────────────────────────────────────────────────
window.renderSubjectPicker = function(containerId, gradeStr, onSave) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const n = parseInt((gradeStr || '').replace(/\D/g, ''), 10) || 0;
  if (n < 10) {
    container.innerHTML = '<p style="color:var(--text3);font-size:12px">Subject picker only available for Senior School (Grade 10+).</p>';
    return;
  }

  const current = _customSubs[gradeStr]?.map(s => s.id) || SUBS_SENIOR_DEFAULT.map(s => s.id);
  const all = SUBS_SENIOR_CORE;

  // Group by gc for visual separation
  const groups = {};
  all.forEach(s => {
    const g = s.gc || 'other';
    if (!groups[g]) groups[g] = [];
    groups[g].push(s);
  });

  const groupLabels = {
    'g-eng':'Languages', 'g-kis':'Kiswahili', 'g-math':'Mathematics',
    'g-sci':'Sciences', 'g-soc':'Humanities & Social', 'g-re':'Religious Education',
    'g-arts':'Creative & Performing Arts', 'g-pret':'Technical & Applied',
    'g-agri':'Agriculture & Home Science'
  };

  let html = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px">`;
  Object.entries(groups).forEach(([gc, subs]) => {
    html += `<div>
      <div style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;
                  color:var(--text3);margin-bottom:6px">${groupLabels[gc] || gc}</div>`;
    subs.forEach(s => {
      const checked = current.includes(s.id) ? 'checked' : '';
      html += `<label style="display:flex;align-items:center;gap:7px;font-size:12.5px;
                             cursor:pointer;padding:3px 0;color:var(--text)">
        <input type="checkbox" value="${s.id}" ${checked}
               style="width:14px;height:14px;accent-color:var(--accent)">
        <span>${s.icon} ${s.label}</span>
      </label>`;
    });
    html += `</div>`;
  });
  html += `</div>
  <div style="margin-top:16px;display:flex;gap:8px;justify-content:flex-end">
    <button onclick="window._subPickerSave('${gradeStr}')"
            style="padding:6px 18px;background:var(--accent);color:#fff;border:none;
                   border-radius:6px;font-weight:700;cursor:pointer;font-size:13px">
      ✅ Apply Subjects
    </button>
    <button onclick="window.clearCustomSubs('${gradeStr}');if(typeof onSave==='function')onSave()"
            style="padding:6px 14px;background:none;border:1.5px solid var(--border);
                   border-radius:6px;font-weight:600;cursor:pointer;font-size:12px;color:var(--text2)">
      Reset to Default
    </button>
  </div>`;

  container.innerHTML = html;

  window._subPickerSave = function(gradeStr) {
    const ids = [...container.querySelectorAll('input[type=checkbox]:checked')].map(cb => cb.value);
    if (!ids.length) { alert('Select at least one subject.'); return; }
    window.setCustomSubs(gradeStr, ids);
    if (typeof onSave === 'function') onSave(ids);
  };
};
