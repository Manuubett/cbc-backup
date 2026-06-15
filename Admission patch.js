/**
 * admission-patch.js
 * ─────────────────────────────────────────────────────────────
 * Two surgical changes to admission.html.
 * Load this AFTER bett-sync.js and Firebase.
 *
 * What it does:
 *   1. Intercepts the student form submit to call syncStudentToBETT()
 *      after every successful Firestore write — silently, non-blocking.
 *   2. Initialises BETT_SYNC once the school ID is confirmed.
 *
 * HOW TO USE:
 *   In admission.html, after the existing <script> block, add:
 *     <script src="bett-sync.js"></script>
 *     <script src="admission-patch.js"></script>
 *
 * This patch monkey-patches the existing form submit listener
 * without touching admission.html's source. Safe to remove
 * by just deleting this <script> tag.
 * ─────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  // ── Wait for auth + BETT_SYNC to be ready ────────────────
  const _ready = new Promise(resolve => {
    const interval = setInterval(() => {
      if (window._schoolId && window.db && window.BETT_SYNC) {
        clearInterval(interval);
        BETT_SYNC.init(window.db, window._schoolId);
        resolve();
      }
    }, 200);
    // Give up after 15s
    setTimeout(() => clearInterval(interval), 15000);
  });

  // ── Patch the form submit ─────────────────────────────────
  //
  // The existing admission.html registers:
  //   el('admForm').addEventListener('submit', async e => { ... })
  //
  // We register a second listener on the SAME form that fires
  // AFTER the student is saved. We detect the save completed
  // by watching db.collection('students') for a new doc.
  // Simpler approach: we override db.collection('students').add
  // so we can intercept the returned docRef.

  document.addEventListener('DOMContentLoaded', () => {
    _ready.then(() => {
      _patchFirestoreAdd();
      console.log('[admission-patch] BETT auto-sync wired in');
    });
  });

  function _patchFirestoreAdd() {
    // Grab the students CollectionReference prototype
    const origCollection = window.db.collection.bind(window.db);

    window.db.collection = function (path) {
      const ref = origCollection(path);

      // Only intercept the students collection
      if (path !== 'students') return ref;

      const origAdd = ref.add.bind(ref);

      ref.add = async function (data) {
        // 1. Do the real Firestore write first
        const docRef = await origAdd(data);

        // 2. After successful write, sync to BETT silently
        //    Pass both data and the new doc ID
        BETT_SYNC.syncStudentToBETT(data, docRef.id).catch(() => {
          // Already handles errors internally — belt + suspenders
        });

        return docRef;
      };

      return ref;
    };
  }

})();