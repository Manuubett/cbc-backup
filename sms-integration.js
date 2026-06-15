/**
 * CBE Mark Sheet — Africa's Talking SMS Integration
 * ─────────────────────────────────────────────────
 * Each school uses their OWN AT account & airtime.
 * This module never uses a central API key — zero cost to you (the SaaS owner).
 *
 * HOW IT WORKS:
 *  1. School saves their AT API key + username in Settings → Firestore settings/{schoolId}
 *  2. When sending SMS, we fetch THEIR credentials from Firestore
 *  3. We POST to AT using their key — AT bills their account directly
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
 *  CBE_SMS.loadATCredentials(schoolId)          → {atApiKey, atUsername, smsEnabled} | null
 *  CBE_SMS.loadSenderId(schoolId)               → string
 *  CBE_SMS.normalisePhone(raw)                  → +254... string
 *  CBE_SMS.settingsHTML()                       → HTML string for settings page
 *  CBE_SMS.initSettingsUI(schoolId)             → wires up the settings form
 */

window.CBE_SMS = (() => {

  // ── Firestore + Auth refs (expects firebase already initialised) ──
  const db   = () => firebase.firestore();
  const auth = () => firebase.auth();

  // ── Africa's Talking live endpoint ──
  const AT_ENDPOINT = 'https://api.africastalking.com/version1/messaging';

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
  //  2. CORE SEND FUNCTION
  // ══════════════════════════════════════════════════════════════

 async function sendSMS(apiKey, username, to, message, from = '') {
    const res = await fetch(SMS_PROXY_ENDPOINT, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey, username, to, message, from }),
    });

    if (!res.ok) throw new Error(`SMS proxy error: ${res.status} ${res.statusText}`);
    const data = await res.json();
    if (data.success === false) throw new Error(data.message || 'SMS send failed');
    return data;
  }

  // ══════════════════════════════════════════════════════════════
  //  3. MESSAGE BUILDER
  // ══════════════════════════════════════════════════════════════

  function buildResultsSMS({ studentName, grade, stream, term, year, schoolName, subjects, footer }) {
    const classStr = stream ? `${grade} ${stream}` : grade;
    const header   = `${schoolName}\nResults: ${term} ${year}\nStudent: ${studentName} (${classStr})\n`;
    const body     = subjects.map(s =>
      `${s.name}: ${s.score ?? s.marks ?? '-'}${s.grade ? ` (${s.grade})` : ''}`
    ).join('\n');
    const foot = footer || 'For queries, contact the school office.';
    return `${header}${body}\n${foot}`;
  }

  // ══════════════════════════════════════════════════════════════
  //  4. BULK SENDER
  // ══════════════════════════════════════════════════════════════

  async function sendBulkResults(schoolId, recipients, opts = {}) {
    const creds = await loadATCredentials(schoolId);
    if (!creds)             throw new Error('SMS not configured — go to Settings → SMS Setup');
    if (!creds.smsEnabled)  throw new Error('SMS is disabled for this school');

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
        const status = msgRes?.status === 'Success' ? 'sent' : 'failed';
        const entry  = { ...r, status, atResponse: msgRes, message, phone };
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
  //  6. SEND MODAL UI
  // ══════════════════════════════════════════════════════════════

  /**
   * Open the SMS send modal.
   * @param {Array}  recipients   — each: {studentName, parentPhone, grade, stream, subjects[]}
   * @param {string} schoolId
   * @param {object} schoolSettings — {name, term, year, senderId}
   */
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

    // Store recipients on the modal element (avoids JSON-in-HTML encoding issues)
    modal._smsRecipients = withPhone;

    // Populate preview with first recipient's sample
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

  // ── Internal: kick off the bulk send ────────────────────────────
  async function _startSend(schoolId, schoolName, term, year, senderId) {
    const modal      = document.getElementById('cbeSmsModal');
    const recipients = modal?._smsRecipients || [];

    const sendBtn   = document.getElementById('_smsSendBtn');
    const cancelBtn = document.getElementById('_smsCancelBtn');
    const progress  = document.getElementById('_smsProgress');
    const progFill  = document.getElementById('_smsProgFill');
    const progLabel = document.getElementById('_smsProgLabel');
    const logList   = document.getElementById('_smsLogList');

    if (sendBtn)   { sendBtn.disabled = true; sendBtn.textContent = '⏳ Sending…'; }
    if (cancelBtn) { cancelBtn.disabled = true; }
    if (progress)  { progress.style.display = 'block'; }

    const summary = { sent: 0, failed: 0, skipped: 0, error: 0 };

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
            const dot   = `<span class="_sms-dot ${s}"></span>`;
            const name  = _esc(last.studentName || '—');
            const phone = _esc(last.phone || last.parentPhone || '—');
            const note  = s === 'sent' ? 'Delivered'
              : s === 'skipped' ? 'No phone'
              : _esc(last.reason || s);
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

    // Done
    if (progLabel) progLabel.innerHTML =
      `✅ Done — <strong style="color:#059669">${summary.sent} sent</strong>` +
      ` · <span style="color:#dc2626">${summary.failed + summary.error} failed</span>` +
      ` · <span style="color:#d97706">${summary.skipped} skipped</span>`;
    if (sendBtn)   { sendBtn.textContent = '✓ Done'; sendBtn.style.background = '#059669'; }
    if (cancelBtn) { cancelBtn.disabled = false; cancelBtn.textContent = 'Close'; }
  }

  function _closeModal()    { _removeSendModal(); }
  function _removeSendModal() {
    const m = document.getElementById('cbeSmsModal');
    if (m) m.remove();
  }

  // ══════════════════════════════════════════════════════════════
  //  7. SETTINGS UI
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
          <input id="smsApiKey" type="password" placeholder="Paste your Africa's Talking API key"
            style="width:100%;height:36px;padding:0 10px;border:1.5px solid #dce1ec;
              border-radius:6px;font-family:inherit;font-size:13px;outline:none;
              transition:border-color .14s"
            onfocus="this.style.borderColor='#1a56db'"
            onblur="this.style.borderColor='#dce1ec'">
        </div>
        <div>
          <label style="display:block;font-size:11px;font-weight:700;color:#64748b;
            text-transform:uppercase;letter-spacing:.4px;margin-bottom:5px">AT Username *</label>
          <input id="smsUsername" type="text" placeholder="Your AT app username"
            style="width:100%;height:36px;padding:0 10px;border:1.5px solid #dce1ec;
              border-radius:6px;font-family:inherit;font-size:13px;outline:none;
              transition:border-color .14s"
            onfocus="this.style.borderColor='#1a56db'"
            onblur="this.style.borderColor='#dce1ec'">
        </div>
      </div>

      <div style="margin-bottom:14px">
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

      <div style="background:#eff4ff;border:1px solid #c7d9ff;border-left:3px solid #1a56db;
        border-radius:6px;padding:10px 14px;font-size:12px;color:#1e3a8a;
        line-height:1.7;margin-bottom:14px">
        ℹ️ <strong>How to get your AT credentials:</strong><br>
        1. Go to <a href="https://africastalking.com" target="_blank"
           style="color:#1a56db">africastalking.com</a> → Create a free account<br>
        2. Create an app (or use the Sandbox app for testing)<br>
        3. Copy your <strong>API Key</strong> and <strong>Username</strong>
           from the AT dashboard<br>
        4. Top up airtime in your AT account — ~KES 0.80 per SMS in Kenya
      </div>

      <div style="display:flex;gap:8px">
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
        badge.textContent  = '✅ Configured';
        badge.style.background = '#d1fae5';
        badge.style.color      = '#065f46';
      }
      try {
        const snap = await db().collection('settings').doc(schoolId).get();
        if (snap.exists) {
          const si = document.getElementById('smsSenderId');
          if (si && snap.data().smsSenderId) si.value = snap.data().smsSenderId;
        }
      } catch (_) {}
    }
  }

  async function _saveSettings() {
    const schoolId = _schoolId();
    const apiKey   = document.getElementById('smsApiKey')?.value.trim();
    const username = document.getElementById('smsUsername')?.value.trim();
    const senderId = document.getElementById('smsSenderId')?.value.trim();
    const btn      = document.getElementById('smsSaveBtn');

    if (!apiKey || !username) {
      _showSaveMsg('⚠️ API Key and Username are required.', '#dc2626');
      return;
    }
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      await saveATCredentials(schoolId, apiKey, username);
      if (senderId !== undefined) {
        await db().collection('settings').doc(schoolId).set(
          { smsSenderId: senderId || '' }, { merge: true }
        );
      }
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

  async function _testSMS() {
    const schoolId = _schoolId();
    const phone    = prompt('Enter your phone number to receive a test SMS:\n(Format: +254712345678)');
    if (!phone) return;

    const creds = await loadATCredentials(schoolId);
    if (!creds) { alert('Save your AT credentials first.'); return; }

    const senderId = document.getElementById('smsSenderId')?.value.trim() || '';
    try {
      const res = await sendSMS(
        creds.atApiKey, creds.atUsername,
        normalisePhone(phone),
        `CBE Mark Sheet test SMS ✅\nSMS integration is working correctly!\n— Your School System`,
        senderId
      );
      const status = res?.SMSMessageData?.Recipients?.[0]?.status;
      if (status === 'Success') {
        alert(`✅ Test SMS sent to ${phone}!`);
      } else {
        alert(`⚠️ AT responded: ${JSON.stringify(res?.SMSMessageData)}`);
      }
    } catch (e) {
      alert('❌ Failed: ' + e.message);
    }
  }

  function _showSaveMsg(msg, color) {
    const el = document.getElementById('smsSaveMsg');
    if (!el) return;
    el.textContent  = msg;
    el.style.color  = color;
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 4000);
  }

  // ══════════════════════════════════════════════════════════════
  //  UTILITIES
  // ══════════════════════════════════════════════════════════════

  /** Normalise Kenyan phone numbers to +254 format */
  function normalisePhone(raw) {
    let p = (raw || '').replace(/[\s\-]/g, '');
    if (p.startsWith('07') || p.startsWith('01')) p = '+254' + p.slice(1);
    if (p.startsWith('254') && !p.startsWith('+'))  p = '+' + p;
    return p;
  }

  function _currentTerm() {
    const m = new Date().getMonth();
    return m < 4 ? 'Term 1' : m < 8 ? 'Term 2' : 'Term 3';
  }

  function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  /** Escape HTML for safe injection into innerHTML */
  function _esc(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** Read schoolId from wherever the host page stores it */
  function _schoolId() {
    return window._schoolId
      || sessionStorage.getItem('cbe_school_id')
      || '';
  }

  // ── Public API ───────────────────────────────────────────────
  return {
    // Core
    sendSMS,
    sendBulkResults,
    buildResultsSMS,
    // Settings
    saveATCredentials,
    loadATCredentials,
    loadSenderId,
    // Modal
    openSendModal,
    // Settings UI
    settingsHTML,
    initSettingsUI,
    // Utilities
    normalisePhone,
    // Internals exposed for inline onclick handlers in the modal
    _startSend,
    _closeModal,
    _saveSettings,
    _testSMS,
  };

})(); // ← THIS WAS MISSING — executes the IIFE and assigns window.CBE_SMS
