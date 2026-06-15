/**
 * bett-sync.js
 * ─────────────────────────────────────────────────────────────
 * Handles all CBE → BETT synchronisation.
 *
 * Exposes one global: window.BETT_SYNC
 *
 * Usage in admission.html (after Firebase is ready):
 *   import or <script src="bett-sync.js"></script>
 *   BETT_SYNC.init(db, schoolId);
 *   BETT_SYNC.syncStudentToBETT(studentData);   // called after every admit
 *   BETT_SYNC.runBulkSync();                     // called once from E-learning panel
 *
 * Firestore state lives at:
 *   settings/{schoolId}.bettSync = {
 *     state:      'idle' | 'running' | 'completed' | 'failed',
 *     startedAt:  Timestamp,
 *     completedAt:Timestamp,
 *     progress: {
 *       total:    number,
 *       done:     number,
 *       failed:   string[],  // Firestore doc IDs that errored
 *       lastId:   string,    // last successfully processed doc ID
 *     }
 *   }
 * ─────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  // ── Config ────────────────────────────────────────────────
  const BETT_API      = 'http://localhost:5000/api/dashboard';
  const CHUNK_SIZE    = 50;
  const LOG_PREFIX    = '[BETT-SYNC]';

  // ── Internal state ────────────────────────────────────────
  let _db       = null;
  let _schoolId = null;
  let _settingsRef = null;

  // ── Helpers ───────────────────────────────────────────────

  function log(msg, data) {
    console.log(`${LOG_PREFIX} ${msg}`, data || '');
  }

  function warn(msg, data) {
    console.warn(`${LOG_PREFIX} ${msg}`, data || '');
  }

  /**
   * Normalise a CBE student document into the payload BETT's
   * POST /api/dashboard/students expects.
   *
   * Field mapping (from our earlier analysis):
   *   CBE name          → BETT firstName + lastName
   *   CBE admissionNumber → BETT adm
   *   CBE grade "Grade 7" → BETT grade "Grade 7"  (same format, confirmed)
   *   CBE stream        → BETT stream
   *   CBE gender        → BETT gender
   *   CBE parentName    → BETT parent  (rename)
   *   CBE parentPhone   → BETT parentPhone
   *   CBE parentEmail   → BETT parentEmail
   *   CBE schoolId      → BETT schoolId
   */
  function mapStudentToBETT(cbeStudent) {
    const nameParts = (cbeStudent.name || '').trim().split(/\s+/);
    const firstName = nameParts[0] || '';
    const lastName  = nameParts.slice(1).join(' ') || '';

    return {
      firstName,
      lastName,
      adm:         cbeStudent.admissionNumber || null,
      grade:       cbeStudent.grade           || null,
      stream:      cbeStudent.stream          || null,
      gender:      cbeStudent.gender          || null,
      dob:         cbeStudent.dob             || null,
      parent:      cbeStudent.parentName      || null,   // CBE parentName → BETT parent
      parentPhone: cbeStudent.parentPhone     || null,
      parentEmail: cbeStudent.parentEmail     || null,
      schoolId:    _schoolId,
      cbeId:       cbeStudent.id,                        // store CBE doc ID for dedup
      fees:        'pending',                            // default; BETT manages fee status
    };
  }

  /**
   * Call BETT's student endpoint.
   * First checks if the student already exists (by cbeId) to stay idempotent.
   */
  async function pushStudentToBETT(payload) {
    // 1. Check for existing record by cbeId to avoid duplicates
    const checkRes = await fetch(
      `${BETT_API}/students?cbeId=${encodeURIComponent(payload.cbeId)}&schoolId=${encodeURIComponent(_schoolId)}`,
      { credentials: 'include' }
    );

    if (checkRes.ok) {
      const existing = await checkRes.json();
      if (Array.isArray(existing) && existing.length > 0) {
        log(`Student ${payload.adm} already in BETT — skipping`);
        return { skipped: true };
      }
    }

    // 2. Create in BETT
    const res = await fetch(`${BETT_API}/students`, {
      method:      'POST',
      credentials: 'include',
      headers:     { 'Content-Type': 'application/json' },
      body:        JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    return res.json();
  }

  // ── Public: init ─────────────────────────────────────────

  function init(firestoreDb, schoolId) {
    _db          = firestoreDb;
    _schoolId    = schoolId;
    _settingsRef = firestoreDb.collection('settings').doc(schoolId);
    log('Initialised', { schoolId });
  }

  // ── Public: syncStudentToBETT (called after every admit) ─

  /**
   * Silently syncs a single newly-admitted student to BETT.
   * Fails quietly — CBE admission is never blocked by BETT being down.
   *
   * @param {object} studentData  The Firestore student document data
   *                              (same shape written by admission.html)
   * @param {string} docId        The Firestore document ID
   */
  async function syncStudentToBETT(studentData, docId) {
    try {
      // Only sync if school has BETT activated
      const settings = await _settingsRef.get();
      const bettActive = settings.exists && settings.data()?.bettEnabled === true;
      if (!bettActive) return;

      const payload = mapStudentToBETT({ ...studentData, id: docId });
      await pushStudentToBETT(payload);
      log(`Auto-synced student ${payload.adm} to BETT`);
    } catch (e) {
      // Silent fail — log but never surface to admin during admission flow
      warn(`Auto-sync failed for student (non-blocking): ${e.message}`);
    }
  }

  // ── Public: runBulkSync ──────────────────────────────────

  /**
   * One-time migration of all existing CBE students into BETT.
   * Uses the state machine:   idle → running → completed | failed
   * Safe to re-run: resumes from lastId if interrupted.
   *
   * @param {function} onProgress  Optional callback(done, total, failedCount)
   * @returns {Promise<{done, failed}>}
   */
  async function runBulkSync(onProgress) {
    if (!_db || !_schoolId) throw new Error('BETT_SYNC not initialised');

    // ── GUARD: check current state ──────────────────────────
    const settingsSnap = await _settingsRef.get();
    const existing     = settingsSnap.exists ? settingsSnap.data() : {};
    const currentState = existing?.bettSync?.state;

    if (currentState === 'completed') {
      log('Bulk sync already completed — skipping');
      return { done: existing.bettSync.progress?.done || 0, failed: [] };
    }

    if (currentState === 'running') {
      log('Bulk sync already running — skipping duplicate call');
      return { done: 0, failed: [] };
    }

    // ── Mark as RUNNING immediately ─────────────────────────
    const lastId   = existing?.bettSync?.progress?.lastId   || null;
    const prevFail = existing?.bettSync?.progress?.failed   || [];

    await _settingsRef.set({
      bettSync: {
        state:     'running',
        startedAt: firebase.firestore.FieldValue.serverTimestamp(),
        progress: {
          total:  0,
          done:   existing?.bettSync?.progress?.done || 0,
          failed: prevFail,
          lastId,
        }
      }
    }, { merge: true });

    // ── Load students (resume from lastId if set) ───────────
    try {
      let query = _db.collection('students')
        .where('schoolId', '==', _schoolId)
        .orderBy(firebase.firestore.FieldPath.documentId());

      if (lastId) {
        const lastDoc = await _db.collection('students').doc(lastId).get();
        if (lastDoc.exists) {
          query = query.startAfter(lastDoc);
          log(`Resuming bulk sync after doc ${lastId}`);
        }
      }

      const snap = await query.get();
      const docs = snap.docs;
      const total = docs.length + (existing?.bettSync?.progress?.done || 0);

      // Update total count
      await _settingsRef.set({
        bettSync: { progress: { total } }
      }, { merge: true });

      // ── Chunk loop ──────────────────────────────────────
      let doneCount  = existing?.bettSync?.progress?.done || 0;
      let failedIds  = [...prevFail];

      for (let i = 0; i < docs.length; i += CHUNK_SIZE) {
        const chunk = docs.slice(i, i + CHUNK_SIZE);

        for (const doc of chunk) {
          const data    = doc.data();
          const payload = mapStudentToBETT({ ...data, id: doc.id });

          try {
            await pushStudentToBETT(payload);
            doneCount++;
          } catch (e) {
            warn(`Failed to sync student ${doc.id}: ${e.message}`);
            failedIds.push(doc.id);
          }
        }

        // ── Checkpoint after every chunk ──────────────────
        const lastProcessed = chunk[chunk.length - 1].id;
        await _settingsRef.set({
          bettSync: {
            progress: {
              done:   doneCount,
              failed: failedIds,
              lastId: lastProcessed,
            }
          }
        }, { merge: true });

        if (typeof onProgress === 'function') {
          onProgress(doneCount, total, failedIds.length);
        }

        log(`Chunk complete: ${doneCount}/${total} done, ${failedIds.length} failed`);
      }

      // ── Mark COMPLETED ─────────────────────────────────
      await _settingsRef.set({
        bettSync: {
          state:       'completed',
          completedAt: firebase.firestore.FieldValue.serverTimestamp(),
          progress: {
            total:  doneCount + failedIds.length,
            done:   doneCount,
            failed: failedIds,
            lastId: docs.length ? docs[docs.length - 1].id : lastId,
          }
        }
      }, { merge: true });

      log(`Bulk sync complete: ${doneCount} synced, ${failedIds.length} failed`);
      return { done: doneCount, failed: failedIds };

    } catch (e) {
      // ── Mark FAILED (safe to retry) ────────────────────
      await _settingsRef.set({
        bettSync: { state: 'failed' }
      }, { merge: true });
      warn(`Bulk sync failed: ${e.message}`);
      throw e;
    }
  }

  // ── Public: retryFailed ──────────────────────────────────

  /**
   * Retry only the students that failed during bulk sync.
   */
  async function retryFailed(onProgress) {
    const snap    = await _settingsRef.get();
    const failed  = snap.exists ? (snap.data()?.bettSync?.progress?.failed || []) : [];

    if (!failed.length) {
      log('No failed records to retry');
      return { retried: 0, stillFailing: [] };
    }

    log(`Retrying ${failed.length} failed records`);
    const stillFailing = [];

    for (let i = 0; i < failed.length; i++) {
      const docId = failed[i];
      try {
        const doc  = await _db.collection('students').doc(docId).get();
        if (!doc.exists) continue;
        await pushStudentToBETT(mapStudentToBETT({ ...doc.data(), id: docId }));
        log(`Retry success: ${docId}`);
      } catch (e) {
        warn(`Retry still failing: ${docId} — ${e.message}`);
        stillFailing.push(docId);
      }

      if (typeof onProgress === 'function') {
        onProgress(i + 1, failed.length, stillFailing.length);
      }
    }

    // Update failed list in Firestore
    await _settingsRef.set({
      bettSync: { progress: { failed: stillFailing } }
    }, { merge: true });

    return { retried: failed.length - stillFailing.length, stillFailing };
  }

  // ── Public: getSyncState ─────────────────────────────────

  async function getSyncState() {
    const snap = await _settingsRef.get();
    if (!snap.exists) return null;
    return snap.data()?.bettSync || null;
  }

  // ── Public: resetSync ────────────────────────────────────

  /**
   * Reset sync state back to idle (for re-running from scratch).
   * Only usable when state is 'failed' or 'completed'.
   */
  async function resetSync() {
    await _settingsRef.set({
      bettSync: {
        state:    'idle',
        progress: { total: 0, done: 0, failed: [], lastId: null }
      }
    }, { merge: true });
    log('Sync state reset to idle');
  }

  // ── Expose public API ────────────────────────────────────
  window.BETT_SYNC = {
    init,
    syncStudentToBETT,
    runBulkSync,
    retryFailed,
    getSyncState,
    resetSync,
  };

})();