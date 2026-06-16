/**
 * CBE Mark Sheet — Africa's Talking SMS Integration (v4)
 * ─────────────────────────────────────────────────────
 * Each school uses their OWN AT account & airtime.
 * This module never uses a central API key — zero cost to you (the SaaS owner).
 *
 * v4 CHANGES:
 *  - NEW: _openTestModal() — fully standalone test modal with its own UI
 *    Bypasses all settings-page DOM dependencies. Works from ANY page.
 *    Reads credentials fresh from Firestore, calls proxy directly, shows
 *    live status inside the modal. No dependency on #smsSaveMsg or any
 *    other element existing in the host page.
 *  - _testSMS() now delegates to _openTestModal() instead of inline flow
 *  - All v3 fixes retained
 *
 * v3 FIXES (retained):
 *  - Bug 1: _schoolId() race condition — buttons now guard against undefined schoolId
 *  - Bug 2: Added AbortController with 15s timeout on fetch (handles Render cold starts)
 *  - Bug 3: Replaced prompt() in _testSMS() with an inline phone input field
 *  - Bug 4: normalisePhone() now handles bare 7XXXXXXXX format
 *  - Bug 5: Removed misplaced dead comment at bottom of file
 *
 * HOW IT WORKS:
 *  1. School saves their AT API key + username in Settings → Firestore settings/{schoolId}
 *  2. When sending SMS, we fetch THEIR credentials from Firestore
 *  3. We POST to our backend proxy, which forwards to AT using their key — AT bills their account
 *  4. We log delivery status in Firestore smsLogs/{schoolId}/logs/{docId}
 *
 * USAGE:
 *  - Drop this file next to admin.html / marksheet.html / settings.html
 *  - Add <script src="sms-integration.js"></script> BEFORE your page's own <script> block
 *  - Call: CBE_SMS.openSendModal(recipients, schoolId, schoolSettings)
 *
 * PUBLIC API:
 *  CBE_SMS.openSendModal(recipients, schoolId, {name, term, year, senderId})
 *  CBE_SMS.sendBulkResults(schoolId, recipients, {term, year, schoolName, senderId, onProgress})
 *  CBE_SMS.sendSMS(apiKey, username, to, message, from)
 *  CBE_SMS.buildResultsSMS({studentName, grade, stream, term, year, schoolName, subjects, footer})
 *  CBE_SMS.saveATCredentials(schoolId, apiKey, username)
 *  CBE_SMS.loadATCredentials(schoolId)   → {atApiKey, atUsername, smsEnabled} | null
 *  CBE_SMS.loadSenderId(schoolId)        → string
 *  CBE_SMS.normalisePhone(raw)           → +254... string
 *  CBE_SMS.settingsHTML()                → HTML string for settings page
 *  CBE_SMS.initSettingsUI(schoolId)      → wires up the settings form
 *  CBE_SMS._openTestModal(schoolId?)     → standalone SMS test modal (v4 NEW)
 */

window.CBE_SMS = (() => {

  // ── Firestore + Auth refs (expects firebase already initialised) ──
  const db   = () => firebase.firestore();
  const auth = () => firebase.auth();

  // ── Backend SMS proxy (avoids browser CORS block on AT's API) ──
  const SMS_PROXY_ENDPOINT = 'https://instasend-backend.onrender.com/api/sms/send';

  // ── Fetch timeout (ms) — handles Render.com free-tier cold starts ──
  const FETCH_TIMEOUT_MS = 15000;

  // ══════════════════════════════════════════════════════════════
  //  1. SETTINGS HELPERS
  // ══════════════════════════════════════════════════════════════

  async function saveATCredentials(schoolId, apiKey, username) {
    if (!schoolId || !apiKey || !username) throw new Error('All AT credential fields required');
    await db().collection('settings').doc(schoolId).set({
      atApiKey:   apiKey.trim(),
      atUsername: username.trim(),
      smsEnabled: true,
      smsSetupAt: firebase.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  }

  async function loadATCredentials(schoolId) {
    if (!schoolId) return null;
    const snap = await db().collection('settings').doc(schoolId).get();
    if (!snap.exists) return null;
    const d = snap.data();
    if (!d.atApiKey || !d.atUsername) return null;
    return { atApiKey: d.atApiKey, atUsername: d.atUsername, smsEnabled: d.smsEnabled !== false };
  }

  /** Returns the registered sender ID for a school, or empty string */
  async function loadSenderId(schoolId) {
    try {
      const snap = await db().collection('settings').doc(schoolId).get();
      return snap.exists ? (snap.data().smsSenderId || '') : '';
    } catch (_) { return ''; }
  }

  // ══════════════════════════════════════════════════════════════
  //  2. CORE SEND FUNCTION (v3 — with timeout via AbortController)
  // ══════════════════════════════════════════════════════════════

  async function sendSMS(apiKey, username, to, message, from = '') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let res;
    try {
      res = await fetch(SMS_PROXY_ENDPOINT, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ apiKey, username, to, message, from }),
        signal:  controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        throw new Error(
          'SMS proxy timed out after 15 s — the server may be waking up. ' +
          'Wait 30 seconds and try again.'
        );
      }
      throw new Error('Network error: ' + err.message);
    }
    clearTimeout(timer);

    let data;
    try {
      data = await res.json();
    } catch (_) {
      throw new Error(`SMS proxy error: ${res.status} ${res.statusText}`);
    }

    if (!res.ok) {
      throw new Error(data?.message || `SMS proxy error: ${res.status} ${res.statusText}`);
    }
    if (data?.success === false) {
      throw new Error(data.message || 'SMS send failed');
    }
    return data;
  }

  // ══════════════════════════════════════════════════════════════
  //  3. MESSAGE BUILDER
  // ══════════════════════════════════════════════════════════════

function buildResultsSMS({ studentName, grade, stream, term, year, schoolName, subjects, overallAvg, level, points, rank, totalStudents }) {
  const classStr = stream ? `${grade}${stream}` : grade;
  const header = `${schoolName} ${term} ${year}\n${studentName} (${classStr})\n`;
  const body = subjects
    .map(s => `${s.name}:${_fmtScore(s.score ?? s.marks)}(${s.grade || '-'})`)
    .join(' ');
  const summary = (overallAvg != null)
    ? `\nAvg:${overallAvg}% ${level} ${points}pts${rank ? ` Pos:${rank}/${totalStudents}` : ''}`
    : '';
  return `${header}${body}${summary}`;
}

function _fmtScore(v) {
  const n = Number(v);
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

  // ══════════════════════════════════════════════════════════════
  //  4. BULK SENDER
  // ══════════════════════════════════════════════════════════════
// Add near other utilities
function _isInsufficientBalance(entry) {
  const reason = (entry?.reason || entry?.atResponse?.status || '').toLowerCase();
  return reason.includes('insufficientbalance') || reason.includes('insufficient balance') || reason.includes('user is not active');
}

function _statusNote(entry) {
  const s = entry.status;
  if (s === 'sent') return 'Delivered';
  if (s === 'skipped') return 'No phone';
  const raw = entry.reason || entry.atResponse?.status || s;
  if (_isInsufficientBalance(entry)) return 'No AT balance';
  return _esc(String(raw)).slice(0, 40); // keep log row readable
}
async function _wakeProxy(onStatus) {
  onStatus?.('Waking up SMS server…');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(SMS_PROXY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: '__wake__', username: '__wake__', to: '+2540', message: 'wake' }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    // Any response (even 400/401) means the server is awake and reachable
    onStatus?.('Server ready.');
    return true;
  } catch (e) {
    clearTimeout(timer);
    onStatus?.(e.name === 'AbortError' ? 'Server still waking up — retrying…' : 'Server unreachable.');
    return false;
  }
}
  async function sendBulkResults(schoolId, recipients, opts = {}) {
    const creds = await loadATCredentials(schoolId);
    if (!creds)            throw new Error('SMS not configured — go to Settings → SMS Setup');
    if (!creds.smsEnabled) throw new Error('SMS is disabled for this school');

    const { term, year, schoolName, senderId = '', onProgress } = opts;
    const results = [];

    for (let i = 0; i < recipients.length; i++) {
      const r = recipients[i];

      if (!r.parentPhone) {
        const entry = { ...r, status: 'skipped', reason: 'No phone number' };
        results.push(entry);
        onProgress?.(i + 1, recipients.length, entry);
        continue;
      }

      const message = buildResultsSMS({
        studentName: r.studentName,
        grade:       r.grade,
        stream:      r.stream,
        term, year, schoolName,
        subjects:    r.subjects,
        footer:      opts.footer,
      });

     try {
        const phone = normalisePhone(r.parentPhone);
        const atRes = await sendSMS(creds.atApiKey, creds.atUsername, phone, message, senderId);
        const msgRes = atRes?.SMSMessageData?.Recipients?.[0];
        const status = _isSuccessStatus(msgRes?.status) ? 'sent' : 'failed';
        const entry  = { ...r, status, atResponse: msgRes, message, phone, reason: msgRes?.status || '' };
        results.push(entry);
        await _logSMS(schoolId, entry, term, year);
      } catch (e) {
        const entry = { ...r, status: 'error', reason: e.message };
        results.push(entry);
        await _logSMS(schoolId, entry, term, year);
      }

      onProgress?.(i + 1, recipients.length, results[results.length - 1]);
      if (i < recipients.length - 1) await _sleep(120);
    }

    return results;
  }

  // ══════════════════════════════════════════════════════════════
  //  5. LOGGING
  // ══════════════════════════════════════════════════════════════

  async function _logSMS(schoolId, entry, term, year) {
    try {
      await db().collection('smsLogs').doc(schoolId).collection('logs').add({
        studentName: entry.studentName || '',
        grade:       entry.grade  || '',
        stream:      entry.stream || '',
        phone:       entry.phone  || entry.parentPhone || '',
        status:      entry.status,
        reason:      entry.reason || null,
        term, year,
        sentAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    } catch (_) { /* non-critical */ }
  }

  // ══════════════════════════════════════════════════════════════
  //  6. STANDALONE TEST MODAL (v4 NEW)
  // ══════════════════════════════════════════════════════════════

  /**
   * Opens a fully self-contained SMS test modal.
   * Has zero dependency on any host-page DOM elements.
   * Pre-fills credentials + senderId from Firestore if schoolId is known.
   * Calls the proxy directly and shows live status inside the modal.
   *
   * @param {string} [preloadSchoolId] — optional, pre-fills fields from Firestore
   */
  function _openTestModal(preloadSchoolId) {
    // Remove any existing instance
    const existing = document.getElementById('_cbeTestSmsModal');
    if (existing) existing.remove();

    const resolvedId = preloadSchoolId || _schoolId();

    // ── Build modal DOM ──────────────────────────────────────────
    const overlay = document.createElement('div');
    overlay.id = '_cbeTestSmsModal';
    overlay.style.cssText = `
      position:fixed;inset:0;background:rgba(0,0,0,.5);
      backdrop-filter:blur(8px);z-index:99999;
      display:flex;align-items:center;justify-content:center;padding:20px;
      font-family:'Plus Jakarta Sans',ui-sans-serif,sans-serif;
    `;

    overlay.innerHTML = `
      <div id="_cbeTestSmsBox" style="
        background:#fff;border-radius:16px;width:100%;max-width:460px;
        box-shadow:0 32px 80px rgba(0,0,0,.35);overflow:hidden;
        animation:_testIn .22s cubic-bezier(.22,1,.36,1);
      ">
        <style>
          @keyframes _testIn {
            from { opacity:0; transform:scale(.94) translateY(14px) }
            to   { opacity:1; transform:none }
          }
          #_cbeTestSmsBox input {
            width:100%;box-sizing:border-box;height:38px;padding:0 11px;
            border:1.5px solid #dce1ec;border-radius:7px;
            font-family:inherit;font-size:13px;outline:none;
            transition:border-color .14s;background:#fff;
          }
          #_cbeTestSmsBox input:focus { border-color:#1a56db; }
          #_cbeTestSmsBox label {
            display:block;font-size:10.5px;font-weight:700;color:#64748b;
            text-transform:uppercase;letter-spacing:.45px;margin-bottom:5px;
          }
          #_cbeTestSmsBox .field { margin-bottom:12px; }
          ._test-divider { border:none;border-top:1px solid #f1f5f9;margin:14px 0; }
          ._test-status {
            display:none;border-radius:8px;padding:10px 14px;
            font-size:12.5px;line-height:1.6;margin-top:12px;
          }
          ._test-log {
            font-family:monospace;font-size:11px;background:#0f172a;color:#94a3b8;
            border-radius:7px;padding:10px 12px;margin-top:10px;
            max-height:120px;overflow-y:auto;line-height:1.7;display:none;
          }
          ._test-log .ok  { color:#34d399; }
          ._test-log .err { color:#f87171; }
          ._test-log .inf { color:#60a5fa; }
        </style>

        <!-- Header -->
        <div style="
          background:linear-gradient(135deg,#0f172a 0%,#1e3a8a 65%,#1a56db 100%);
          padding:18px 22px;color:#fff;
        ">
          <div style="font-size:15px;font-weight:800;letter-spacing:-.2px;margin-bottom:2px;">
            🧪 SMS Connection Test
          </div>
          <div style="font-size:11px;opacity:.65;">
            Standalone test — works from any page, any time
          </div>
        </div>

        <!-- Body -->
        <div style="padding:20px 22px 4px;">

          <div class="field">
            <label>AT API Key</label>
            <input id="_tApiKey" type="password" placeholder="Your Africa's Talking API key">
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
            <div class="field">
              <label>AT Username</label>
              <input id="_tUsername" type="text" placeholder="sandbox">
            </div>
            <div class="field">
              <label>Sender ID <span style="font-weight:400;text-transform:none">(optional)</span></label>
              <input id="_tSenderId" type="text" placeholder="Leave blank for default">
            </div>
          </div>

          <div class="field">
            <label>Test Phone Number</label>
            <input id="_tPhone" type="tel" placeholder="+254712345678">
          </div>

          <!-- Info box -->
          <div style="
            background:#eff4ff;border:1px solid #c7d9ff;border-left:3px solid #1a56db;
            border-radius:6px;padding:9px 13px;font-size:11.5px;color:#1e3a8a;
            line-height:1.6;margin-bottom:4px;
          ">
            ℹ️ For <strong>Sandbox</strong> testing: use <code>sandbox</code> as username and
            register your number under <em>AT Dashboard → Sandbox Simulator</em> first.
          </div>

          <!-- Status area -->
          <div id="_tStatus" class="_test-status"></div>
          <div id="_tLog"    class="_test-log"></div>

        </div>

        <!-- Footer -->
        <div style="
          padding:14px 22px 18px;
          display:flex;justify-content:space-between;align-items:center;gap:8px;
        ">
          <button
            onclick="document.getElementById('_cbeTestSmsModal').remove()"
            style="
              padding:8px 18px;border-radius:7px;border:1.5px solid #e2e8f0;
              background:none;font-family:inherit;font-size:12.5px;font-weight:600;
              cursor:pointer;color:#64748b;
            ">
            Close
          </button>
          <div style="display:flex;gap:8px;">
            <button
              id="_tProbeBtn"
              onclick="window.CBE_SMS._probeProxy()"
              style="
                padding:8px 16px;border-radius:7px;
                border:1.5px solid #c7d9ff;background:#eff4ff;
                font-family:inherit;font-size:12.5px;font-weight:700;
                cursor:pointer;color:#1a56db;
              ">
              🔌 Ping Proxy
            </button>
            <button
              id="_tSendBtn"
              onclick="window.CBE_SMS._doTestSend()"
              style="
                padding:8px 20px;border-radius:7px;background:#1a56db;color:#fff;
                border:none;font-family:inherit;font-size:12.5px;font-weight:700;
                cursor:pointer;
              ">
              📤 Send Test SMS
            </button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    // Close on backdrop click
    overlay.addEventListener('click', e => {
      if (e.target === overlay) overlay.remove();
    });

    // Pre-fill from Firestore if we have a schoolId
    if (resolvedId) {
      _prefillTestModal(resolvedId);
    }
  }

  /** Pre-fill test modal fields from Firestore */
  async function _prefillTestModal(schoolId) {
    try {
      const snap = await db().collection('settings').doc(schoolId).get();
      if (!snap.exists) return;
      const d = snap.data();
      const keyEl    = document.getElementById('_tApiKey');
      const userEl   = document.getElementById('_tUsername');
      const senderEl = document.getElementById('_tSenderId');
      const phoneEl  = document.getElementById('_tPhone');
      if (keyEl    && d.atApiKey)     keyEl.value    = d.atApiKey;
      if (userEl   && d.atUsername)   userEl.value   = d.atUsername;
      if (senderEl && d.smsSenderId)  senderEl.value = d.smsSenderId;
      if (phoneEl  && d.smsTestPhone) phoneEl.value  = d.smsTestPhone;
    } catch (_) { /* non-critical — user can type manually */ }
  }

  /** Show status inside the test modal */
  function _testStatus(msg, type = 'info') {
    const el = document.getElementById('_tStatus');
    if (!el) return;
    const styles = {
      info:    'background:#eff4ff;color:#1e3a8a;border:1px solid #c7d9ff;',
      success: 'background:#f0fdf4;color:#065f46;border:1px solid #bbf7d0;',
      error:   'background:#fef2f2;color:#991b1b;border:1px solid #fecaca;',
      warning: 'background:#fef3c7;color:#92400e;border:1px solid #fcd34d;',
      loading: 'background:#f8fafc;color:#334155;border:1px solid #e2e8f0;',
    };
    el.style.cssText += styles[type] || styles.info;
    el.innerHTML  = msg;
    el.style.display = 'block';
  }

  /** Append a line to the debug log inside the test modal */
  function _testLog(msg, cls = 'inf') {
    const el = document.getElementById('_tLog');
    if (!el) return;
    el.style.display = 'block';
    const line = document.createElement('div');
    line.className = cls;
    line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
  }

  /**
   * Ping the proxy without sending a real SMS.
   * Sends an intentionally bad payload — a 401/400 from the proxy
   * means it's alive and reachable; a network error means it's down.
   */
  async function _probeProxy() {
    const btn = document.getElementById('_tProbeBtn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Pinging…'; }

    _testStatus('⏳ Pinging proxy — please wait…', 'loading');
    _testLog('POST ' + SMS_PROXY_ENDPOINT + ' (probe payload)');

    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      const r = await fetch(SMS_PROXY_ENDPOINT, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ apiKey: '__probe__', username: '__probe__', to: '+2540', message: 'probe' }),
        signal:  controller.signal,
      });

      _testLog(`HTTP ${r.status} ${r.statusText} — redirected: ${r.redirected}`, r.ok || r.status < 500 ? 'ok' : 'err');
      _testLog(`Final URL: ${r.url}`, r.url.includes('africastalking') ? 'err' : 'ok');

      if (r.redirected && r.url.includes('africastalking')) {
        _testStatus(
          '❌ Proxy is redirecting to AT directly — this causes CORS.<br>' +
          'Fix: update your backend to fetch AT server-side, not redirect.',
          'error'
        );
      } else if (r.status === 401 || r.status === 400) {
        _testStatus(
          '✅ Proxy is <strong>alive and reachable</strong>.<br>' +
          `Responded ${r.status} (expected — probe credentials are invalid).<br>` +
          'You can safely click <strong>Send Test SMS</strong> now.',
          'success'
        );
      } else if (r.status >= 500) {
        _testStatus(`⚠️ Proxy returned ${r.status} — server error. Check Render logs.`, 'warning');
      } else {
        _testStatus(`ℹ️ Proxy responded ${r.status}. Check debug log below.`, 'info');
      }
    } catch (e) {
      const msg = e.name === 'AbortError'
        ? 'Proxy timed out after 15 s — Render may be cold-starting. Wait 30 s and try again.'
        : 'Network error: ' + e.message;
      _testLog(msg, 'err');
      _testStatus('❌ ' + msg, 'error');
    }

    if (btn) { btn.disabled = false; btn.textContent = '🔌 Ping Proxy'; }
  }

  /** Actually send a test SMS using values from the test modal fields */
  async function _doTestSend() {
    const apiKey   = document.getElementById('_tApiKey')?.value.trim();
    const username = document.getElementById('_tUsername')?.value.trim();
    const senderId = document.getElementById('_tSenderId')?.value.trim() || '';
    const rawPhone = document.getElementById('_tPhone')?.value.trim();
    const btn      = document.getElementById('_tSendBtn');

    // Validate
    if (!apiKey)   { _testStatus('⚠️ Enter your AT API Key first.', 'warning');   return; }
    if (!username) { _testStatus('⚠️ Enter your AT Username first.', 'warning');  return; }
    if (!rawPhone) { _testStatus('⚠️ Enter a test phone number first.', 'warning'); return; }

    const phone = normalisePhone(rawPhone);
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Sending…'; }
    _testStatus('⏳ Sending test SMS — may take up to 15 s on first request…', 'loading');
    _testLog(`Sending to ${phone} via ${SMS_PROXY_ENDPOINT}`);
    _testLog(`Username: ${username} | Sender: ${senderId || '(AT default)'}`);

    try {
      const data = await sendSMS(apiKey, username, phone, `CBE Mark Sheet test SMS ✅\nProxy → AT pipeline working!\n— Your School System`, senderId);

      _testLog('Response: ' + JSON.stringify(data?.SMSMessageData || data), 'ok');

      const recipient = data?.SMSMessageData?.Recipients?.[0];
      const status    = recipient?.status;

      if (status === 'Success') {
        _testStatus(
          `✅ <strong>SMS delivered!</strong><br>` +
          `Sent to <strong>${phone}</strong> · Cost: ${recipient?.cost || '—'} · ` +
          `Message ID: ${recipient?.messageId || '—'}`,
          'success'
        );
      } else {
        _testStatus(
          `⚠️ AT accepted the request but delivery status: <strong>${status || 'unknown'}</strong><br>` +
          `${data?.SMSMessageData?.Message || 'Check AT dashboard for details.'}`,
          'warning'
        );
      }
    } catch (e) {
      _testLog('Error: ' + e.message, 'err');
      _testStatus('❌ <strong>Failed:</strong> ' + _esc(e.message), 'error');
    }

    if (btn) { btn.disabled = false; btn.textContent = '📤 Send Test SMS'; }
  }

  // ── _testSMS now just opens the standalone modal ──────────────
  function _testSMS() {
    _openTestModal(_schoolId());
  }

  // ══════════════════════════════════════════════════════════════
  //  6b. STANDALONE SETTINGS MODAL (v4 NEW)
  // ══════════════════════════════════════════════════════════════

  /**
   * Opens a fully self-contained SMS settings modal.
   * School pastes their AT API key + username → saved to Firestore.
   * Has zero dependency on any host-page DOM elements.
   * Can be triggered from ANY page via: CBE_SMS.openSettingsModal()
   */
  function openSettingsModal(preloadSchoolId) {
    const existing = document.getElementById('_cbeSmsCfgModal');
    if (existing) existing.remove();

    const resolvedId = preloadSchoolId || _schoolId();

    const overlay = document.createElement('div');
    overlay.id = '_cbeSmsCfgModal';
    overlay.style.cssText = `
      position:fixed;inset:0;background:rgba(0,0,0,.55);
      backdrop-filter:blur(8px);z-index:99999;
      display:flex;align-items:center;justify-content:center;padding:20px;
      font-family:'Plus Jakarta Sans',ui-sans-serif,sans-serif;
    `;

    overlay.innerHTML = `
      <div id="_cbeSmsCfgBox" style="
        background:#fff;border-radius:16px;width:100%;max-width:480px;
        box-shadow:0 32px 80px rgba(0,0,0,.3);overflow:hidden;
        animation:_cfgIn .22s cubic-bezier(.22,1,.36,1);
      ">
        <style>
          @keyframes _cfgIn {
            from { opacity:0;transform:scale(.94) translateY(14px) }
            to   { opacity:1;transform:none }
          }
          #_cbeSmsCfgBox input {
            width:100%;box-sizing:border-box;height:40px;padding:0 12px;
            border:1.5px solid #dce1ec;border-radius:8px;
            font-family:inherit;font-size:13px;outline:none;
            transition:border-color .14s;background:#fff;color:#0f172a;
          }
          #_cbeSmsCfgBox input:focus { border-color:#1a56db; box-shadow:0 0 0 3px rgba(26,86,219,.1); }
          #_cbeSmsCfgBox label {
            display:block;font-size:10.5px;font-weight:700;color:#64748b;
            text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;
          }
          #_cbeSmsCfgBox .field { margin-bottom:14px; }
          ._cfg-status {
            display:none;border-radius:8px;padding:10px 14px;
            font-size:12.5px;line-height:1.6;margin-top:4px;
          }
          ._cfg-badge {
            display:inline-flex;align-items:center;gap:5px;
            font-size:10.5px;font-weight:700;padding:3px 10px;
            border-radius:20px;background:#f1f5f9;color:#64748b;
          }
          ._cfg-badge.ok  { background:#d1fae5;color:#065f46; }
          ._cfg-badge.err { background:#fee2e2;color:#991b1b; }
        </style>

        <!-- Header -->
        <div style="
          background:linear-gradient(135deg,#0f172a 0%,#1e3a8a 60%,#1a56db 100%);
          padding:20px 24px;color:#fff;
        ">
          <div style="display:flex;align-items:center;justify-content:space-between;">
            <div>
              <div style="font-size:15px;font-weight:800;letter-spacing:-.2px;margin-bottom:2px;">
                📱 SMS Setup
              </div>
              <div style="font-size:11px;opacity:.65;">
                Connect your Africa's Talking account
              </div>
            </div>
            <span id="_cfgBadge" class="_cfg-badge">Not configured</span>
          </div>
        </div>

        <!-- Body -->
        <div style="padding:22px 24px 8px;">

          <div class="field">
            <label>AT API Key *</label>
            <input id="_cfgApiKey" type="password" autocomplete="new-password"
              placeholder="Paste your Africa's Talking API key">
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
            <div class="field">
              <label>AT Username *</label>
              <input id="_cfgUsername" type="text" autocomplete="off"
                placeholder="e.g. bett254">
            </div>
            <div class="field">
              <label>Sender ID <span style="font-weight:400;text-transform:none;">(optional)</span></label>
              <input id="_cfgSenderId" type="text" placeholder="Leave blank for default">
            </div>
          </div>

          <div class="field">
            <label>Test Phone Number</label>
            <input id="_cfgTestPhone" type="tel" placeholder="+254712345678">
          </div>

          <!-- How to get credentials -->
          <div style="
            background:#eff4ff;border:1px solid #c7d9ff;border-left:3px solid #1a56db;
            border-radius:7px;padding:10px 14px;font-size:11.5px;color:#1e3a8a;
            line-height:1.75;margin-bottom:4px;
          ">
            <strong>How to get your credentials:</strong><br>
            1. Go to <a href="https://africastalking.com" target="_blank" style="color:#1a56db;font-weight:600;">africastalking.com</a> → Login → your app<br>
            2. Copy <strong>API Key</strong> from Settings → API Key (account level)<br>
            3. Your <strong>Username</strong> is shown on the AT dashboard home<br>
            4. Top up airtime — ~KES 0.80 per SMS in Kenya
          </div>

          <!-- Status -->
          <div id="_cfgStatus" class="_cfg-status"></div>

        </div>

        <!-- Footer -->
        <div style="
          padding:16px 24px 20px;
          display:flex;justify-content:space-between;align-items:center;gap:8px;
        ">
          <button
            onclick="document.getElementById('_cbeSmsCfgModal').remove()"
            style="
              padding:9px 18px;border-radius:8px;border:1.5px solid #e2e8f0;
              background:none;font-family:inherit;font-size:12.5px;font-weight:600;
              cursor:pointer;color:#64748b;
            ">
            Cancel
          </button>
          <div style="display:flex;gap:8px;">
            <button
              id="_cfgTestBtn"
              onclick="window.CBE_SMS._doSettingsTest()"
              style="
                padding:9px 16px;border-radius:8px;
                border:1.5px solid #bbf7d0;background:#f0fdf4;
                font-family:inherit;font-size:12.5px;font-weight:700;
                cursor:pointer;color:#059669;
              ">
              🧪 Test SMS
            </button>
            <button
              id="_cfgSaveBtn"
              onclick="window.CBE_SMS._doSettingsSave()"
              style="
                padding:9px 22px;border-radius:8px;background:#1a56db;color:#fff;
                border:none;font-family:inherit;font-size:12.5px;font-weight:700;
                cursor:pointer;
              ">
              💾 Save Settings
            </button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

    // Pre-fill from Firestore
    if (resolvedId) _prefillSettingsModal(resolvedId);
  }

  async function _prefillSettingsModal(schoolId) {
    try {
      const snap = await db().collection('settings').doc(schoolId).get();
      if (!snap.exists) return;
      const d = snap.data();
      const keyEl    = document.getElementById('_cfgApiKey');
      const userEl   = document.getElementById('_cfgUsername');
      const senderEl = document.getElementById('_cfgSenderId');
      const phoneEl  = document.getElementById('_cfgTestPhone');
      const badge    = document.getElementById('_cfgBadge');
      if (keyEl    && d.atApiKey)     keyEl.value    = d.atApiKey;
      if (userEl   && d.atUsername)   userEl.value   = d.atUsername;
      if (senderEl && d.smsSenderId)  senderEl.value = d.smsSenderId;
      if (phoneEl  && d.smsTestPhone) phoneEl.value  = d.smsTestPhone;
      if (badge && d.atApiKey && d.atUsername) {
        badge.textContent = '✅ Configured';
        badge.className   = '_cfg-badge ok';
      }
    } catch (_) {}
  }

  function _cfgStatus(msg, type = 'info') {
    const el = document.getElementById('_cfgStatus');
    if (!el) return;
    const styles = {
      info:    'background:#eff4ff;color:#1e3a8a;border:1px solid #c7d9ff;',
      success: 'background:#f0fdf4;color:#065f46;border:1px solid #bbf7d0;',
      error:   'background:#fef2f2;color:#991b1b;border:1px solid #fecaca;',
      warning: 'background:#fef3c7;color:#92400e;border:1px solid #fcd34d;',
      loading: 'background:#f8fafc;color:#334155;border:1px solid #e2e8f0;',
    };
    el.style.cssText = styles[type] || styles.info;
    el.innerHTML     = msg;
    el.style.display = 'block';
  }

  async function _doSettingsSave() {
    const schoolId = _schoolId();
    if (!schoolId) { _cfgStatus('⚠️ Not signed in yet — please wait.', 'warning'); return; }

    const apiKey    = document.getElementById('_cfgApiKey')?.value.trim();
    const username  = document.getElementById('_cfgUsername')?.value.trim();
    const senderId  = document.getElementById('_cfgSenderId')?.value.trim() || '';
    const testPhone = document.getElementById('_cfgTestPhone')?.value.trim() || '';
    const btn       = document.getElementById('_cfgSaveBtn');
    const badge     = document.getElementById('_cfgBadge');

    if (!apiKey)    { _cfgStatus('⚠️ API Key is required.', 'warning');  return; }
    if (!username)  { _cfgStatus('⚠️ Username is required.', 'warning'); return; }

    btn.disabled = true; btn.textContent = '⏳ Saving…';
    try {
      await saveATCredentials(schoolId, apiKey, username);
      await db().collection('settings').doc(schoolId).set({
        smsSenderId:  senderId,
        smsTestPhone: testPhone,
      }, { merge: true });

      if (badge) { badge.textContent = '✅ Configured'; badge.className = '_cfg-badge ok'; }
      _cfgStatus('✅ <strong>Settings saved!</strong> Your AT credentials are ready to use.', 'success');
    } catch (e) {
      _cfgStatus('❌ ' + _esc(e.message), 'error');
    }
    btn.disabled = false; btn.textContent = '💾 Save Settings';
  }

  async function _doSettingsTest() {
    const apiKey   = document.getElementById('_cfgApiKey')?.value.trim();
    const username = document.getElementById('_cfgUsername')?.value.trim();
    const senderId = document.getElementById('_cfgSenderId')?.value.trim() || '';
    const rawPhone = document.getElementById('_cfgTestPhone')?.value.trim();
    const btn      = document.getElementById('_cfgTestBtn');

    if (!apiKey)   { _cfgStatus('⚠️ Enter your API Key first.', 'warning');       return; }
    if (!username) { _cfgStatus('⚠️ Enter your Username first.', 'warning');      return; }
    if (!rawPhone) { _cfgStatus('⚠️ Enter a test phone number first.', 'warning'); return; }

    btn.disabled = true; btn.textContent = '⏳ Sending…';
    _cfgStatus('⏳ Sending test SMS — may take up to 15 s…', 'loading');

    try {
      const data = await sendSMS(
        apiKey, username, normalisePhone(rawPhone),
        `CBE Mark Sheet ✅\nSMS integration working!\n— ${username}`,
        senderId
      );
      const recipient = data?.SMSMessageData?.Recipients?.[0];
      const status    = recipient?.status;

      if (status === 'Success') {
        _cfgStatus(
          `✅ <strong>Test SMS sent!</strong> Delivered to ${rawPhone} · Cost: ${recipient?.cost || '—'}`,
          'success'
        );
      } else {
        _cfgStatus(
          `⚠️ AT responded: <strong>${status || 'unknown'}</strong> — ${data?.SMSMessageData?.Message || 'Check AT dashboard.'}`,
          'warning'
        );
      }
    } catch (e) {
      _cfgStatus('❌ ' + _esc(e.message), 'error');
    }
    btn.disabled = false; btn.textContent = '🧪 Test SMS';
  }

  // ══════════════════════════════════════════════════════════════
  //  7. SEND MODAL UI
  // ══════════════════════════════════════════════════════════════

  function openSendModal(recipients, schoolId, schoolSettings = {}) {
    _removeSendModal();

    const {
      name: schoolName = '',
      term = _currentTerm(),
      year = String(new Date().getFullYear()),
      senderId = '',
    } = schoolSettings;

    const withPhone    = recipients.filter(r => r.parentPhone);
    const withoutPhone = recipients.filter(r => !r.parentPhone);

    const modal = document.createElement('div');
    modal.id    = 'cbeSmsModal';
    modal.style.cssText = `
      position:fixed;inset:0;background:rgba(0,0,0,.45);
      backdrop-filter:blur(6px);z-index:9999;
      display:flex;align-items:center;justify-content:center;padding:20px;
      font-family:'Plus Jakarta Sans',sans-serif;
    `;

    modal.innerHTML = `
      <div style="background:#fff;border-radius:14px;width:100%;max-width:520px;
        box-shadow:0 24px 60px rgba(0,0,0,.3);overflow:hidden;
        animation:_smsIn .2s cubic-bezier(.22,1,.36,1)">
        <style>
          @keyframes _smsIn{from{opacity:0;transform:scale(.95) translateY(12px)}to{opacity:1;transform:none}}
          ._sms-prog-bar{height:4px;background:#e2e8f0;border-radius:2px;overflow:hidden;margin:10px 0}
          ._sms-prog-fill{height:100%;background:#1a56db;border-radius:2px;transition:width .3s;width:0}
          ._sms-row{display:flex;align-items:center;gap:10px;padding:6px 0;
            border-bottom:1px solid #f1f5f9;font-size:12.5px}
          ._sms-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
          ._sms-dot.sent{background:#059669}
          ._sms-dot.failed,._sms-dot.error{background:#dc2626}
          ._sms-dot.skipped{background:#d97706}
          ._sms-dot.pending{background:#94a3b8}
          ._sms-dot.sending{background:#1a56db;animation:_pulse .8s infinite}
          @keyframes _pulse{0%,100%{opacity:1}50%{opacity:.4}}
        </style>

        <!-- Header -->
        <div style="background:linear-gradient(135deg,#0f172a,#1e3a8a 70%,#1a56db);
          padding:18px 22px;color:#fff">
          <div style="font-size:16px;font-weight:800;
            font-family:'Familjen Grotesk',sans-serif;margin-bottom:2px">
            📱 Send Results via SMS
          </div>
          <div style="font-size:11.5px;opacity:.75">${_esc(schoolName)} · ${_esc(term)} ${_esc(year)}</div>
        </div>

        <!-- Body -->
        <div style="padding:18px 22px">

          <!-- Summary cards -->
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:16px">
            <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;
              padding:10px;text-align:center">
              <div style="font-size:22px;font-weight:800;color:#059669">${withPhone.length}</div>
              <div style="font-size:10.5px;color:#065f46;font-weight:600">Will receive SMS</div>
            </div>
            <div style="background:#fef3c7;border:1px solid #fcd34d;border-radius:8px;
              padding:10px;text-align:center">
              <div style="font-size:22px;font-weight:800;color:#d97706">${withoutPhone.length}</div>
              <div style="font-size:10.5px;color:#92400e;font-weight:600">No phone number</div>
            </div>
            <div style="background:#eff4ff;border:1px solid #c7d9ff;border-radius:8px;
              padding:10px;text-align:center">
              <div style="font-size:22px;font-weight:800;color:#1a56db">${recipients.length}</div>
              <div style="font-size:10.5px;color:#1447c0;font-weight:600">Total students</div>
            </div>
          </div>

          <!-- SMS Preview -->
          <div style="margin-bottom:14px">
            <div style="font-size:11px;font-weight:700;color:#64748b;
              text-transform:uppercase;letter-spacing:.4px;margin-bottom:6px">SMS Preview</div>
            <div id="_smsMsgPreview" style="background:#f8fafc;border:1.5px solid #e2e8f0;
              border-radius:8px;padding:10px 14px;font-size:12px;line-height:1.8;color:#334155;
              font-family:monospace;white-space:pre-wrap;max-height:140px;overflow-y:auto"></div>
            <div id="_smsMsgLen" style="font-size:10.5px;color:#94a3b8;margin-top:4px;text-align:right"></div>
          </div>

          ${withoutPhone.length ? `
          <div style="background:#fef3c7;border:1px solid #fcd34d;border-left:3px solid #f59e0b;
            border-radius:6px;padding:8px 12px;font-size:11.5px;color:#92400e;
            margin-bottom:14px;line-height:1.6">
            ⚠️ ${withoutPhone.length} student${withoutPhone.length > 1 ? 's' : ''}
            will be skipped — no parent phone number saved.
          </div>` : ''}

          <!-- Progress (hidden until sending) -->
          <div id="_smsProgress" style="display:none">
            <div class="_sms-prog-bar">
              <div class="_sms-prog-fill" id="_smsProgFill"></div>
            </div>
            <div style="font-size:11.5px;color:#64748b;margin-bottom:8px"
              id="_smsProgLabel">Preparing…</div>
            <div id="_smsLogList" style="max-height:150px;overflow-y:auto"></div>
          </div>

        </div>

        <!-- Footer -->
        <div style="padding:12px 22px;border-top:1px solid #f1f5f9;
          display:flex;justify-content:space-between;align-items:center;gap:8px">
          <button id="_smsCancelBtn"
            onclick="window.CBE_SMS._closeModal()"
            style="padding:7px 16px;border-radius:6px;border:1.5px solid #e2e8f0;
              background:none;font-family:inherit;font-size:12.5px;font-weight:600;
              cursor:pointer;color:#64748b">
            Cancel
          </button>
          <button id="_smsSendBtn"
            onclick="window.CBE_SMS._startSend('${_esc(schoolId)}','${_esc(schoolName)}','${_esc(term)}','${_esc(year)}','${_esc(senderId)}')"
            style="padding:7px 20px;border-radius:6px;background:#1a56db;color:#fff;
              border:none;font-family:inherit;font-size:12.5px;font-weight:700;
              cursor:pointer;display:flex;align-items:center;gap:6px">
            📤 Send to ${withPhone.length} Parent${withPhone.length !== 1 ? 's' : ''}
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) _closeModal(); });

    modal._smsRecipients = withPhone;

    const sample = recipients[0];
    if (sample) {
      const preview = buildResultsSMS({
        studentName: sample.studentName || 'Student Name',
        grade:       sample.grade  || 'Grade 4',
        stream:      sample.stream || '',
        term, year, schoolName,
        subjects: sample.subjects?.length
          ? sample.subjects
          : [{ name: 'Math', score: 87 }, { name: 'English', score: 75 }, { name: 'Science', score: 90 }],
      });
      const previewEl = document.getElementById('_smsMsgPreview');
      if (previewEl) previewEl.textContent = preview;
      const lenEl = document.getElementById('_smsMsgLen');
      if (lenEl) {
        const parts = Math.ceil(preview.length / 160);
        lenEl.textContent = `~${preview.length} chars · ~${parts} SMS part${parts > 1 ? 's' : ''} per student`;
      }
    }
  }

async function _startSend(schoolId, schoolName, term, year, senderId) {
  const modal      = document.getElementById('cbeSmsModal');
  const recipients = modal?._smsRecipients || [];

  const sendBtn   = document.getElementById('_smsSendBtn');
  const cancelBtn = document.getElementById('_smsCancelBtn');
  const progress  = document.getElementById('_smsProgress');
  const progFill  = document.getElementById('_smsProgFill');
  const progLabel = document.getElementById('_smsProgLabel');
  const logList   = document.getElementById('_smsLogList');

  if (sendBtn)   { sendBtn.disabled = true; sendBtn.textContent = '⏳ Connecting…'; }
  if (cancelBtn) { cancelBtn.disabled = true; }
  if (progress)  { progress.style.display = 'block'; }

  // ── Wake the server first ──
  const awake = await _wakeProxy(msg => { if (progLabel) progLabel.textContent = msg; });
  if (!awake) {
    if (progLabel) progLabel.innerHTML = '❌ Could not reach SMS server. Wait 30s and try again.';
    if (sendBtn)   { sendBtn.disabled = false; sendBtn.textContent = '🔄 Retry'; }
    if (cancelBtn) { cancelBtn.disabled = false; }
    return;
  }

  if (sendBtn) sendBtn.textContent = '⏳ Sending…';
  const summary = { sent: 0, failed: 0, skipped: 0, error: 0 };
  let sawInsufficientBalance = false;

  try {
    await sendBulkResults(schoolId, recipients, {
      term, year, schoolName, senderId,
      onProgress(done, total, last) {
        const pct = Math.round((done / total) * 100);
        if (progFill)  progFill.style.width  = pct + '%';
        if (progLabel) progLabel.textContent  = `Sending ${done} of ${total}…`;

        if (last) {
          const s = last.status;
          summary[s] = (summary[s] || 0) + 1;
          if (_isInsufficientBalance(last)) sawInsufficientBalance = true;

          const dot      = `<span class="_sms-dot ${s}"></span>`;
          const name     = _esc(last.studentName || '—');
          const phone    = _esc(last.phone || last.parentPhone || '—');
          const note     = _statusNote(last);
          const noteColor = s === 'sent' ? '#059669' : s === 'skipped' ? '#d97706' : '#dc2626';
          if (logList) {
            logList.innerHTML += `
              <div class="_sms-row">
                ${dot}
                <span style="flex:1;font-weight:600">${name}</span>
                <span style="color:#94a3b8">${phone}</span>
                <span style="color:${noteColor};font-weight:600">${note}</span>
              </div>`;
            logList.scrollTop = logList.scrollHeight;
          }
        }
      },
    });
  } catch (e) {
    if (progLabel) progLabel.textContent = '❌ ' + e.message;
    if (sendBtn)   { sendBtn.disabled = false; sendBtn.textContent = '🔄 Retry'; }
    if (cancelBtn) { cancelBtn.disabled = false; }
    return;
  }

  if (progLabel) progLabel.innerHTML =
    `✅ Done — <strong style="color:#059669">${summary.sent} sent</strong>` +
    ` · <span style="color:#dc2626">${summary.failed + summary.error} failed</span>` +
    ` · <span style="color:#d97706">${summary.skipped} skipped</span>`;

  if (sawInsufficientBalance) {
    const topupHtml = `
      <div style="background:#fef2f2;border:1px solid #fecaca;border-left:3px solid #dc2626;
        border-radius:7px;padding:10px 14px;font-size:12px;color:#991b1b;margin-top:10px;line-height:1.7">
        💳 <strong>Insufficient AT balance.</strong> Some messages failed because your
        Africa's Talking account is out of credit.<br>
        <a href="https://account.africastalking.com/apps/sandbox/billing" target="_blank"
          style="color:#1a56db;font-weight:700">Top up your AT account →</a>
      </div>`;
    if (logList) logList.insertAdjacentHTML('afterend', topupHtml);
  }

  if (sendBtn)   { sendBtn.textContent = '✓ Done'; sendBtn.style.background = '#059669'; }
  if (cancelBtn) { cancelBtn.disabled = false; cancelBtn.textContent = 'Close'; }
}
  

  function _closeModal()      { _removeSendModal(); }
  function _removeSendModal() {
    const m = document.getElementById('cbeSmsModal');
    if (m) m.remove();
  }

  // ══════════════════════════════════════════════════════════════
  //  8. SETTINGS UI
  // ══════════════════════════════════════════════════════════════

  function settingsHTML() {
    return `
    <div id="smsSettingsSection" style="background:#fff;border:1px solid #dce1ec;
      border-radius:10px;padding:20px;margin-top:20px">

      <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px">
        <span style="font-size:20px">📱</span>
        <div>
          <div style="font-family:'Familjen Grotesk',sans-serif;font-size:15px;
            font-weight:800">SMS via Africa's Talking</div>
          <div style="font-size:11.5px;color:#64748b">
            Each school uses their own AT account. Your airtime — your control.
          </div>
        </div>
        <span id="smsStatusBadge" style="margin-left:auto;font-size:10.5px;font-weight:700;
          padding:2px 10px;border-radius:20px;background:#f1f5f9;color:#64748b">
          Not configured
        </span>
      </div>

      <div style="border-top:1px solid #f1f5f9;margin:14px 0"></div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
        <div>
          <label style="display:block;font-size:11px;font-weight:700;color:#64748b;
            text-transform:uppercase;letter-spacing:.4px;margin-bottom:5px">AT API Key *</label>
          <input id="smsApiKey" type="password" autocomplete="new-password"
            placeholder="Paste your Africa's Talking API key"
            style="width:100%;height:36px;padding:0 10px;border:1.5px solid #dce1ec;
              border-radius:6px;font-family:inherit;font-size:13px;outline:none;
              transition:border-color .14s"
            onfocus="this.style.borderColor='#1a56db'"
            onblur="this.style.borderColor='#dce1ec'">
        </div>
        <div>
          <label style="display:block;font-size:11px;font-weight:700;color:#64748b;
            text-transform:uppercase;letter-spacing:.4px;margin-bottom:5px">AT Username *</label>
          <input id="smsUsername" type="text" autocomplete="off"
            placeholder="Your AT app username (use 'sandbox' for testing)"
            style="width:100%;height:36px;padding:0 10px;border:1.5px solid #dce1ec;
              border-radius:6px;font-family:inherit;font-size:13px;outline:none;
              transition:border-color .14s"
            onfocus="this.style.borderColor='#1a56db'"
            onblur="this.style.borderColor='#dce1ec'">
        </div>
      </div>

      <div style="margin-bottom:12px">
        <label style="display:block;font-size:11px;font-weight:700;color:#64748b;
          text-transform:uppercase;letter-spacing:.4px;margin-bottom:5px">
          Sender ID
          <span style="font-size:10px;font-weight:400;text-transform:none">
            (optional — must be registered with AT)
          </span>
        </label>
        <input id="smsSenderId" type="text"
          placeholder="e.g. MySchool  (leave blank to use AT default)"
          style="width:100%;height:36px;padding:0 10px;border:1.5px solid #dce1ec;
            border-radius:6px;font-family:inherit;font-size:13px;outline:none;
            transition:border-color .14s"
          onfocus="this.style.borderColor='#1a56db'"
          onblur="this.style.borderColor='#dce1ec'">
      </div>

      <div style="margin-bottom:14px">
        <label style="display:block;font-size:11px;font-weight:700;color:#64748b;
          text-transform:uppercase;letter-spacing:.4px;margin-bottom:5px">
          Test Phone Number
          <span style="font-size:10px;font-weight:400;text-transform:none">
            (used by Send Test SMS button)
          </span>
        </label>
        <input id="smsTestPhone" type="tel" placeholder="+254712345678"
          style="width:100%;height:36px;padding:0 10px;border:1.5px solid #dce1ec;
            border-radius:6px;font-family:inherit;font-size:13px;outline:none;
            transition:border-color .14s"
          onfocus="this.style.borderColor='#1a56db'"
          onblur="this.style.borderColor='#dce1ec'">
      </div>

      <div style="background:#eff4ff;border:1px solid #c7d9ff;border-left:3px solid #1a56db;
        border-radius:6px;padding:10px 14px;font-size:12px;color:#1e3a8a;
        line-height:1.7;margin-bottom:14px">
        ℹ️ <strong>How to get your AT credentials:</strong><br>
        1. Go to <a href="https://africastalking.com" target="_blank"
           style="color:#1a56db">africastalking.com</a> → Create a free account<br>
        2. Create an app (or use the Sandbox app for testing)<br>
        3. Copy your <strong>API Key</strong> and <strong>Username</strong>
           from the AT dashboard (use <code>sandbox</code> as the username while testing)<br>
        4. Top up airtime in your AT account — ~KES 0.80 per SMS in Kenya<br>
        5. For Sandbox testing, add your phone number under
           Settings → Sandbox Simulator on the AT dashboard before sending a test SMS.
      </div>

      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button id="smsSaveBtn" onclick="CBE_SMS._saveSettings()"
          style="padding:7px 18px;background:#1a56db;color:#fff;border:none;
            border-radius:6px;font-family:inherit;font-size:12.5px;font-weight:700;
            cursor:pointer">
          💾 Save SMS Settings
        </button>
        <button onclick="CBE_SMS._testSMS()"
          style="padding:7px 18px;background:#f0fdf4;color:#059669;
            border:1.5px solid #bbf7d0;border-radius:6px;font-family:inherit;
            font-size:12.5px;font-weight:700;cursor:pointer">
          🧪 Send Test SMS
        </button>
      </div>
      <div id="smsSaveMsg" style="font-size:12px;margin-top:8px;display:none"></div>
    </div>`;
  }

  async function initSettingsUI(schoolId) {
    if (!schoolId) return;
    const creds = await loadATCredentials(schoolId);
    if (creds) {
      const keyInp  = document.getElementById('smsApiKey');
      const userInp = document.getElementById('smsUsername');
      const badge   = document.getElementById('smsStatusBadge');
      if (keyInp)  keyInp.value  = creds.atApiKey;
      if (userInp) userInp.value = creds.atUsername;
      if (badge) {
        badge.textContent      = '✅ Configured';
        badge.style.background = '#d1fae5';
        badge.style.color      = '#065f46';
      }
      try {
        const snap = await db().collection('settings').doc(schoolId).get();
        if (snap.exists) {
          const d  = snap.data();
          const si = document.getElementById('smsSenderId');
          const tp = document.getElementById('smsTestPhone');
          if (si && d.smsSenderId)  si.value = d.smsSenderId;
          if (tp && d.smsTestPhone) tp.value = d.smsTestPhone;
        }
      } catch (_) {}
    }
  }

  async function _saveSettings() {
    const schoolId = _schoolId();
    if (!schoolId) {
      _showSaveMsg('⚠️ Not signed in yet — please wait and try again.', '#dc2626');
      return;
    }

    const apiKey    = document.getElementById('smsApiKey')?.value.trim();
    const username  = document.getElementById('smsUsername')?.value.trim();
    const senderId  = document.getElementById('smsSenderId')?.value.trim();
    const testPhone = document.getElementById('smsTestPhone')?.value.trim();
    const btn       = document.getElementById('smsSaveBtn');

    if (!apiKey || !username) {
      _showSaveMsg('⚠️ API Key and Username are required.', '#dc2626');
      return;
    }

    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      await saveATCredentials(schoolId, apiKey, username);
      await db().collection('settings').doc(schoolId).set({
        smsSenderId:  senderId  || '',
        smsTestPhone: testPhone || '',
      }, { merge: true });

      const badge = document.getElementById('smsStatusBadge');
      if (badge) {
        badge.textContent      = '✅ Configured';
        badge.style.background = '#d1fae5';
        badge.style.color      = '#065f46';
      }
      _showSaveMsg('✅ SMS settings saved successfully!', '#059669');
    } catch (e) {
      _showSaveMsg('❌ ' + e.message, '#dc2626');
    }
    btn.disabled = false; btn.textContent = '💾 Save SMS Settings';
  }

  function _showSaveMsg(msg, color) {
    const el = document.getElementById('smsSaveMsg');
    if (!el) return;
    el.textContent   = msg;
    el.style.color   = color;
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 6000);
  }

  // ══════════════════════════════════════════════════════════════
  //  UTILITIES
  // ══════════════════════════════════════════════════════════════
  function _isSuccessStatus(status) {
  if (!status) return false;
  const s = String(status).toLowerCase();
  return s.includes('success') || s.includes('sent') || s.includes('submitted') || s.includes('queued');
  }
  function normalisePhone(raw) {
    let p = (raw || '').replace(/[\s\-]/g, '');
    if (p.startsWith('+254')) return p;
    if (p.startsWith('254') && p.length === 12) return '+' + p;
    if ((p.startsWith('07') || p.startsWith('01')) && p.length === 10) return '+254' + p.slice(1);
    if (/^7\d{8}$/.test(p)) return '+254' + p;
    return p;
  }

  function _currentTerm() {
    const m = new Date().getMonth();
    return m < 4 ? 'Term 1' : m < 8 ? 'Term 2' : 'Term 3';
  }

  function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function _esc(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function _schoolId() {
    return window._schoolId
      || sessionStorage.getItem('cbe_school_id')
      || '';
  }

  // ── Public API ────────────────────────────────────────────────
  return {
    // Core
    sendSMS,
    sendBulkResults,
    buildResultsSMS,
    // Settings
    saveATCredentials,
    loadATCredentials,
    loadSenderId,
    // Modals
    openSendModal,
    // Settings UI
    settingsHTML,
    initSettingsUI,
    // Utilities
    normalisePhone,
    // Internals exposed for inline onclick handlers
    _startSend,
    _closeModal,
    _saveSettings,
    _testSMS,
    // v4: standalone test modal
    _openTestModal,
    _probeProxy,
    _doTestSend,
    // v4: standalone settings modal
    openSettingsModal,
    _doSettingsSave,
    _doSettingsTest,
  };

})();
