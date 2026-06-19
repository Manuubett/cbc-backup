/**
 * CBE Mark Sheet — SMS Integration (v6 — Central Wallet + Announcements)
 * ───────────────────────────────────────────────────────
 * v6 CHANGES:
 *  - NEW: Announcements — send a custom, freeform SMS to any grade/stream,
 *    independent of results (e.g. "school closes early Friday" to Grade 10).
 *    Supports optional {studentName}/{grade}/{schoolName} placeholders.
 *  - NEW: openAnnouncementModal(students, schoolId, {name, senderId}) — grade
 *    + stream filters, live recipient count, live cost estimate, live
 *    preview, same low-balance guard as the results modal.
 *  - NEW: sendBulkAnnouncement() / buildAnnouncementSMS() — reuse the central
 *    wallet endpoint, tagged type:'announcement' so they're distinguishable
 *    from result sends in Firestore smsLogs (paired server-side change).
 *  - All v5 features retained unchanged (wallet top-up, central bulk results
 *    send, legacy test/settings modals).
 *  - FIX: All modals now scrollable (overflow-y:auto, max-height:90vh,
 *    align-items:flex-start on overlay) so action buttons always reachable.
 *  - NEW: Airtel-only notice banner shown in send + announcement modals.
 *
 * BACKEND ENDPOINTS USED:
 *  POST /api/sms/send-bulk-school  — central send (uses server AT_API_KEY).
 *                                    Accepts optional `type` field
 *                                    ('results' | 'announcement') for logging.
 *  POST /api/wallet/topup          — STK push to top up wallet
 *  GET  /api/wallet/balance/:id    — read balance
 *  GET  /api/wallet/topup-status/:txRef — poll until confirmed
 *
 * PUBLIC API:
 *  CBE_SMS.openSendModal(recipients, schoolId, {name, term, year, senderId})
 *  CBE_SMS.openAnnouncementModal(students, schoolId, {name, senderId})
 *  CBE_SMS.openWalletModal(schoolId)        → top-up + balance modal
 *  CBE_SMS.getWalletBalance(schoolId)       → { balance, totalTopups, totalSpent }
 *  CBE_SMS.sendBulkResults(schoolId, recipients, opts)
 *  CBE_SMS.sendBulkAnnouncement(schoolId, recipients, opts)
 *  CBE_SMS.buildResultsSMS({...})
 *  CBE_SMS.buildAnnouncementSMS(template, {studentName, grade, stream, schoolName})
 *  CBE_SMS.normalisePhone(raw)
 *  CBE_SMS.settingsHTML()
 *  CBE_SMS.initSettingsUI(schoolId)
 *  CBE_SMS._openTestModal(schoolId?)
 *  CBE_SMS.openSettingsModal(schoolId?)
 */

window.CBE_SMS = (() => {

  // ── Firestore ref ────────────────────────────────────────────
  const db   = () => firebase.firestore();

  // ── Backend endpoints ────────────────────────────────────────
  const BACKEND          = 'https://instasend-backend.onrender.com';
  const SMS_PROXY_LEGACY = `${BACKEND}/api/sms/send`;
  const SMS_SEND_SCHOOL  = `${BACKEND}/api/sms/send-bulk-school`;
  const WALLET_TOPUP     = `${BACKEND}/api/wallet/topup`;
  const WALLET_BALANCE   = (id) => `${BACKEND}/api/wallet/balance/${id}`;
  const WALLET_STATUS    = (ref) => `${BACKEND}/api/wallet/topup-status/${ref}`;

  const FETCH_TIMEOUT_MS = 15000;
  const SMS_COST = 1.20; // KES per SMS (matches server)

  // ── Airtel-only notice banner (shown in send + announcement modals) ──────
  const NETWORK_NOTICE = `
    <div style="
      background:#fffbeb;border-bottom:1px solid #fcd34d;
      border-left:4px solid #f59e0b;padding:10px 16px;
      font-size:12px;color:#92400e;line-height:1.6;
      display:flex;align-items:flex-start;gap:10px;flex-shrink:0;
    ">
      <span style="font-size:16px;flex-shrink:0;">⚠️</span>
      <div>
        <strong>Airtel numbers only for now.</strong>
        Safaricom (M-PESA line) delivery is coming soon —
        SMS to Safaricom numbers may not go through yet.
      </div>
    </div>`;

  // ════════════════════════════════════════════════════════════
  //  1. WALLET HELPERS
  // ════════════════════════════════════════════════════════════

  async function getWalletBalance(schoolId) {
    const r = await fetch(WALLET_BALANCE(schoolId));
    if (!r.ok) throw new Error('Could not load wallet balance');
    return await r.json();
  }

  async function initiateTopup(schoolId, amount, phone) {
    const r = await fetch(WALLET_TOPUP, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ schoolId, amount, phone }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Top-up failed');
    return data;
  }

  async function pollTopup(txRef, onStatus) {
    const start   = Date.now();
    const timeout = 90_000;
    while (Date.now() - start < timeout) {
      await _sleep(3000);
      try {
        const r    = await fetch(WALLET_STATUS(txRef));
        const data = await r.json();
        onStatus?.(data.status, data);
        if (data.status === 'confirmed') return data;
        if (data.status === 'failed')    throw new Error('Payment failed or cancelled');
      } catch (e) {
        if (e.message.includes('failed')) throw e;
      }
    }
    throw new Error('Payment confirmation timed out. Check your M-Pesa messages.');
  }

  // ════════════════════════════════════════════════════════════
  //  2. LEGACY SETTINGS HELPERS
  // ════════════════════════════════════════════════════════════

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

  async function loadSenderId(schoolId) {
    try {
      const snap = await db().collection('settings').doc(schoolId).get();
      return snap.exists ? (snap.data().smsSenderId || '') : '';
    } catch (_) { return ''; }
  }

  // ════════════════════════════════════════════════════════════
  //  3. CORE SEND — central wallet
  // ════════════════════════════════════════════════════════════

  async function sendSchoolSMS(schoolId, to, message, from = '') {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const r = await fetch(`${BACKEND}/api/sms/send-school`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ schoolId, to, message, from }),
      signal:  controller.signal,
    });
    const data = await r.json();
    if (r.status === 402) throw Object.assign(new Error(data.message || 'Insufficient balance'), { code: 'INSUFFICIENT_BALANCE', balance: data.balance });
    if (!r.ok)            throw new Error(data.error || `Server error ${r.status}`);
    return data;
  }

  async function sendSMS(apiKey, username, to, message, from = '') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(SMS_PROXY_LEGACY, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ apiKey, username, to, message, from }),
        signal:  controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') throw new Error('SMS proxy timed out — wait 30s and retry.');
      throw new Error('Network error: ' + err.message);
    }
    clearTimeout(timer);
    const data = await res.json().catch(() => { throw new Error(`Proxy error: ${res.status}`); });
    if (!res.ok) throw new Error(data?.message || `Proxy error: ${res.status}`);
    return data;
  }

  // ════════════════════════════════════════════════════════════
  //  4. MESSAGE BUILDER — results
  // ════════════════════════════════════════════════════════════

  function buildResultsSMS({ studentName, grade, stream, term, year, schoolName, subjects, overallAvg, level, points, rank, totalStudents }) {
    const classStr = stream ? `${grade}${stream}` : grade;
    const header   = `${schoolName} ${term} ${year}\n${studentName} (${classStr})\n`;
    const body     = subjects.map(s => `${s.name}:${_fmtScore(s.score ?? s.marks)}(${s.grade || '-'})`).join(' ');
    const summary  = (overallAvg != null)
      ? `\nAvg:${overallAvg}% ${level} ${points}pts${rank ? ` Pos:${rank}/${totalStudents}` : ''}`
      : '';
    return `${header}${body}${summary}`;
  }

  function _fmtScore(v) {
    const n = Number(v);
    return Number.isInteger(n) ? String(n) : n.toFixed(1);
  }

  // ════════════════════════════════════════════════════════════
  //  5. BULK SENDER — results
  // ════════════════════════════════════════════════════════════

  async function sendBulkResults(schoolId, recipients, opts = {}) {
    const { term, year, schoolName, senderId = '', onProgress } = opts;

    const payload = recipients
      .filter(r => r.parentPhone)
      .map(r => ({
        to:      normalisePhone(r.parentPhone),
        from:    senderId || '',
        message: buildResultsSMS({
          studentName: r.studentName, grade: r.grade, stream: r.stream,
          term, year, schoolName, subjects: r.subjects,
          overallAvg: r.overallAvg, level: r.level, points: r.points,
          rank: r.rank, totalStudents: r.totalStudents,
        }),
        meta: { studentName: r.studentName, grade: r.grade, stream: r.stream,
                parentPhone: r.parentPhone },
      }));

    const results = [];
    let idx = 0;
    for (const r of recipients) {
      if (!r.parentPhone) {
        const entry = { ...r, status: 'skipped', reason: 'No phone number' };
        results.push(entry);
        onProgress?.(++idx, recipients.length, entry);
      }
    }

    if (payload.length === 0) return results;

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 120_000);

    const r = await fetch(SMS_SEND_SCHOOL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ schoolId, recipients: payload, type: 'results' }),
      signal:  controller.signal,
    });

    const data = await r.json().catch(() => { throw new Error(`Server error ${r.status}`); });

    if (r.status === 402) {
      throw Object.assign(
        new Error(data.message || 'Wallet empty — top up to send SMS'),
        { code: 'INSUFFICIENT_BALANCE', balance: data.balance }
      );
    }
    if (!r.ok) throw new Error(data.error || `Server error ${r.status}`);

    const serverResults = data.results || [];
    for (let i = 0; i < serverResults.length; i++) {
      const sr    = serverResults[i];
      const orig  = recipients.find(r => r.parentPhone && normalisePhone(r.parentPhone) === sr.to) || {};
      const entry = { ...orig, status: sr.status, reason: sr.reason || sr.atStatus || '', phone: sr.to };
      results.push(entry);
      onProgress?.(++idx, recipients.length, entry);
    }

    return results;
  }

  // ════════════════════════════════════════════════════════════
  //  6. WAKE PROXY
  // ════════════════════════════════════════════════════════════

  async function _wakeProxy(onStatus) {
    onStatus?.('Waking up SMS server…');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      await fetch(`${BACKEND}/api/health`, { signal: controller.signal });
      clearTimeout(timer);
      onStatus?.('Server ready.');
      return true;
    } catch (e) {
      clearTimeout(timer);
      onStatus?.(e.name === 'AbortError' ? 'Server still waking — retrying…' : 'Server unreachable.');
      return false;
    }
  }

  // ════════════════════════════════════════════════════════════
  //  7. WALLET MODAL
  // ════════════════════════════════════════════════════════════

  function openWalletModal(preloadSchoolId) {
    const existing = document.getElementById('_cbeWalletModal');
    if (existing) existing.remove();

    const schoolId = preloadSchoolId || _schoolId();

    const overlay = document.createElement('div');
    overlay.id = '_cbeWalletModal';
    overlay.style.cssText = `
      position:fixed;inset:0;background:rgba(0,0,0,.55);
      backdrop-filter:blur(8px);z-index:99999;
      display:flex;align-items:flex-start;justify-content:center;
      padding:20px;overflow-y:auto;
      font-family:'Plus Jakarta Sans',ui-sans-serif,sans-serif;
    `;

    overlay.innerHTML = `
      <div id="_cbeWalletBox" style="
        background:#fff;border-radius:16px;width:100%;max-width:420px;
        box-shadow:0 32px 80px rgba(0,0,0,.3);overflow-y:auto;max-height:90vh;
        animation:_wIn .22s cubic-bezier(.22,1,.36,1);
      ">
        <style>
          @keyframes _wIn{from{opacity:0;transform:scale(.94) translateY(14px)}to{opacity:1;transform:none}}
          #_cbeWalletBox input{
            width:100%;box-sizing:border-box;height:40px;padding:0 12px;
            border:1.5px solid #dce1ec;border-radius:8px;
            font-family:inherit;font-size:13px;outline:none;transition:border-color .14s;
          }
          #_cbeWalletBox input:focus{border-color:#1a56db;box-shadow:0 0 0 3px rgba(26,86,219,.1);}
          #_cbeWalletBox label{
            display:block;font-size:10.5px;font-weight:700;color:#64748b;
            text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;
          }
          #_cbeWalletBox .wfield{margin-bottom:14px;}
          ._w-status{display:none;border-radius:8px;padding:10px 14px;
            font-size:12.5px;line-height:1.6;margin-top:8px;}
          ._amt-btn{
            padding:7px 14px;border-radius:7px;border:1.5px solid #c7d9ff;
            background:#eff4ff;color:#1a56db;font-family:inherit;font-size:12px;
            font-weight:700;cursor:pointer;transition:all .12s;
          }
          ._amt-btn:hover{background:#1a56db;color:#fff;border-color:#1a56db;}
        </style>

        <!-- Header -->
        <div style="
          background:linear-gradient(135deg,#0f172a 0%,#065f46 60%,#059669 100%);
          padding:20px 24px;color:#fff;
        ">
          <div style="font-size:15px;font-weight:800;letter-spacing:-.2px;margin-bottom:6px;">
            💳 SMS Wallet
          </div>
          <div id="_wBalanceDisplay" style="
            font-size:32px;font-weight:900;letter-spacing:-1px;margin-bottom:2px;
          ">KES —</div>
          <div style="font-size:11px;opacity:.7;">
            <span id="_wSmsCount">— SMS</span> remaining · KES ${SMS_COST}/SMS
          </div>
        </div>

        <!-- Stats row -->
        <div id="_wStats" style="
          display:grid;grid-template-columns:1fr 1fr;
          border-bottom:1px solid #f1f5f9;
        ">
          <div style="padding:12px 20px;border-right:1px solid #f1f5f9;">
            <div style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.4px;margin-bottom:2px;">Total Topped Up</div>
            <div id="_wTotalIn"  style="font-size:16px;font-weight:800;color:#0f172a;">KES —</div>
          </div>
          <div style="padding:12px 20px;">
            <div style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.4px;margin-bottom:2px;">Total Spent</div>
            <div id="_wTotalOut" style="font-size:16px;font-weight:800;color:#0f172a;">KES —</div>
          </div>
        </div>

        <!-- Top-up form -->
        <div style="padding:20px 24px 8px;">
          <div class="wfield">
            <label>Top-Up Amount (KES)</label>
            <div style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
              <button class="_amt-btn" onclick="document.getElementById('_wAmount').value='50'">50</button>
              <button class="_amt-btn" onclick="document.getElementById('_wAmount').value='100'">100</button>
              <button class="_amt-btn" onclick="document.getElementById('_wAmount').value='200'">200</button>
              <button class="_amt-btn" onclick="document.getElementById('_wAmount').value='500'">500</button>
              <button class="_amt-btn" onclick="document.getElementById('_wAmount').value='1000'">1,000</button>
            </div>
            <input id="_wAmount" type="number" min="10" placeholder="Or enter custom amount (min KES 10)">
          </div>
          <div class="wfield">
            <label>M-Pesa Phone Number</label>
            <input id="_wPhone" type="tel" placeholder="+254712345678">
          </div>

          <div style="
            background:#f0fdf4;border:1px solid #bbf7d0;border-left:3px solid #059669;
            border-radius:6px;padding:9px 13px;font-size:11.5px;color:#065f46;line-height:1.6;
          ">
            💡 You'll receive an M-Pesa prompt on your phone. Enter your PIN to confirm.
            SMS credits are added instantly after payment.
          </div>

          <div id="_wStatus" class="_w-status"></div>
        </div>

        <!-- Footer -->
        <div style="padding:14px 24px 20px;display:flex;justify-content:space-between;gap:8px;">
          <button
            onclick="document.getElementById('_cbeWalletModal').remove()"
            style="padding:9px 18px;border-radius:8px;border:1.5px solid #e2e8f0;
              background:none;font-family:inherit;font-size:12.5px;font-weight:600;
              cursor:pointer;color:#64748b;">
            Close
          </button>
          <button id="_wTopupBtn"
            onclick="window.CBE_SMS._doTopup('${_esc(schoolId)}')"
            style="padding:9px 24px;border-radius:8px;background:#059669;color:#fff;
              border:none;font-family:inherit;font-size:12.5px;font-weight:700;cursor:pointer;">
            📲 Top Up via M-Pesa
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

    _loadWalletDisplay(schoolId);

    if (schoolId) {
      db().collection('settings').doc(schoolId).get().then(snap => {
        if (!snap.exists) return;
        const d = snap.data();
        const ph = document.getElementById('_wPhone');
        if (ph && d.phone) ph.value = d.phone;
      }).catch(() => {});
    }
  }

  async function _loadWalletDisplay(schoolId) {
    try {
      const w = await getWalletBalance(schoolId);
      const balEl   = document.getElementById('_wBalanceDisplay');
      const cntEl   = document.getElementById('_wSmsCount');
      const inEl    = document.getElementById('_wTotalIn');
      const outEl   = document.getElementById('_wTotalOut');
      if (balEl) balEl.textContent = `KES ${w.balance.toFixed(2)}`;
      if (cntEl) cntEl.textContent = `${Math.floor(w.balance / SMS_COST)} SMS`;
      if (inEl)  inEl.textContent  = `KES ${(w.totalTopups || 0).toFixed(2)}`;
      if (outEl) outEl.textContent = `KES ${(w.totalSpent  || 0).toFixed(2)}`;
    } catch (_) {}
  }

  function _wStatus(msg, type = 'info') {
    const el = document.getElementById('_wStatus');
    if (!el) return;
    const styles = {
      info:    'background:#eff4ff;color:#1e3a8a;border:1px solid #c7d9ff;',
      success: 'background:#f0fdf4;color:#065f46;border:1px solid #bbf7d0;',
      error:   'background:#fef2f2;color:#991b1b;border:1px solid #fecaca;',
      warning: 'background:#fef3c7;color:#92400e;border:1px solid #fcd34d;',
      loading: 'background:#f8fafc;color:#334155;border:1px solid #e2e8f0;',
    };
    el.style.cssText = (styles[type] || styles.info) + 'display:block;';
    el.innerHTML     = msg;
  }

  async function _doTopup(schoolId) {
    const amount   = Number(document.getElementById('_wAmount')?.value);
    const rawPhone = document.getElementById('_wPhone')?.value.trim();
    const btn      = document.getElementById('_wTopupBtn');

    if (!amount || amount < 10) { _wStatus('⚠️ Minimum top-up is KES 10.', 'warning'); return; }
    if (!rawPhone)               { _wStatus('⚠️ Enter your M-Pesa phone number.', 'warning'); return; }

    btn.disabled = true; btn.textContent = '⏳ Sending prompt…';
    _wStatus('⏳ Sending M-Pesa prompt — check your phone…', 'loading');

    try {
      const { txRef } = await initiateTopup(schoolId, amount, rawPhone);
      _wStatus('📲 <strong>M-Pesa prompt sent!</strong> Enter your PIN to confirm.<br><span style="color:#64748b;font-size:11px;">Waiting for confirmation…</span>', 'info');

      btn.textContent = '⏳ Waiting for payment…';

      await pollTopup(txRef, (status) => {
        if (status === 'confirmed') return;
        _wStatus(`⏳ Payment status: <strong>${status}</strong> — waiting…`, 'loading');
      });

      _wStatus(`✅ <strong>KES ${amount} added!</strong> Your SMS wallet has been topped up.`, 'success');
      btn.textContent = '✓ Done!';
      btn.style.background = '#1a56db';

      await _loadWalletDisplay(schoolId);

    } catch (e) {
      _wStatus('❌ ' + _esc(e.message), 'error');
      btn.disabled = false; btn.textContent = '📲 Top Up via M-Pesa';
    }
  }

  // ════════════════════════════════════════════════════════════
  //  8. SEND MODAL — results
  // ════════════════════════════════════════════════════════════

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
      display:flex;align-items:flex-start;justify-content:center;
      padding:20px;overflow-y:auto;
      font-family:'Plus Jakarta Sans',sans-serif;
    `;

    modal.innerHTML = `
      <div style="background:#fff;border-radius:14px;width:100%;max-width:520px;
        box-shadow:0 24px 60px rgba(0,0,0,.3);overflow-y:auto;max-height:90vh;
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
          padding:18px 22px;color:#fff;">
          <div style="font-size:16px;font-weight:800;margin-bottom:2px;">📱 Send Results via SMS</div>
          <div style="font-size:11.5px;opacity:.75;">${_esc(schoolName)} · ${_esc(term)} ${_esc(year)}</div>
        </div>

        <!-- Network notice -->
        ${NETWORK_NOTICE}

        <!-- Body -->
        <div style="padding:18px 22px;">

          <!-- Wallet balance bar -->
          <div id="_smsWalletBar" style="
            display:flex;align-items:center;justify-content:space-between;
            background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:8px;
            padding:9px 14px;margin-bottom:14px;
          ">
            <div style="font-size:12px;color:#64748b;font-weight:600;">
              💳 SMS Wallet:
              <span id="_smsWalletBal" style="color:#0f172a;font-weight:800;">Loading…</span>
            </div>
            <button onclick="window.CBE_SMS.openWalletModal('${_esc(schoolId)}')"
              style="padding:4px 12px;border-radius:6px;border:1.5px solid #c7d9ff;
                background:#eff4ff;color:#1a56db;font-family:inherit;font-size:11px;
                font-weight:700;cursor:pointer;">
              + Top Up
            </button>
          </div>

          <!-- Summary cards -->
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:16px;">
            <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:10px;text-align:center;">
              <div style="font-size:22px;font-weight:800;color:#059669;">${withPhone.length}</div>
              <div style="font-size:10.5px;color:#065f46;font-weight:600;">Will receive SMS</div>
            </div>
            <div style="background:#fef3c7;border:1px solid #fcd34d;border-radius:8px;padding:10px;text-align:center;">
              <div style="font-size:22px;font-weight:800;color:#d97706;">${withoutPhone.length}</div>
              <div style="font-size:10.5px;color:#92400e;font-weight:600;">No phone number</div>
            </div>
            <div style="background:#eff4ff;border:1px solid #c7d9ff;border-radius:8px;padding:10px;text-align:center;">
              <div style="font-size:22px;font-weight:800;color:#1a56db;">${recipients.length}</div>
              <div style="font-size:10.5px;color:#1447c0;font-weight:600;">Total students</div>
            </div>
          </div>

          <!-- Cost estimate -->
          <div id="_smsCostEst" style="
            background:#eff4ff;border:1px solid #c7d9ff;border-radius:7px;
            padding:8px 13px;font-size:12px;color:#1e3a8a;margin-bottom:14px;
          ">
            💰 Estimated cost: <strong>KES ${withPhone.length * SMS_COST}</strong>
            (${withPhone.length} SMS × KES ${SMS_COST})
          </div>

          <!-- Low balance warning -->
          <div id="_smsLowBalWarn" style="display:none;
            background:#fef2f2;border:1px solid #fecaca;border-left:3px solid #dc2626;
            border-radius:7px;padding:9px 13px;font-size:12px;color:#991b1b;margin-bottom:14px;">
            ⚠️ <strong>Insufficient wallet balance.</strong>
            <span id="_smsLowBalMsg"></span>
            <a href="#" onclick="window.CBE_SMS.openWalletModal('${_esc(schoolId)}');return false;"
              style="color:#1a56db;font-weight:700;display:block;margin-top:4px;">
              📲 Top up now →
            </a>
          </div>

          <!-- SMS Preview -->
          <div style="margin-bottom:14px;">
            <div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;
              letter-spacing:.4px;margin-bottom:6px;">SMS Preview</div>
            <div id="_smsMsgPreview" style="background:#f8fafc;border:1.5px solid #e2e8f0;
              border-radius:8px;padding:10px 14px;font-size:12px;line-height:1.8;color:#334155;
              font-family:monospace;white-space:pre-wrap;max-height:140px;overflow-y:auto;"></div>
            <div id="_smsMsgLen" style="font-size:10.5px;color:#94a3b8;margin-top:4px;text-align:right;"></div>
          </div>

          ${withoutPhone.length ? `
          <div style="background:#fef3c7;border:1px solid #fcd34d;border-left:3px solid #f59e0b;
            border-radius:6px;padding:8px 12px;font-size:11.5px;color:#92400e;
            margin-bottom:14px;line-height:1.6;">
            ⚠️ ${withoutPhone.length} student${withoutPhone.length > 1 ? 's' : ''}
            will be skipped — no parent phone number saved.
          </div>` : ''}

          <!-- Progress -->
          <div id="_smsProgress" style="display:none;">
            <div class="_sms-prog-bar">
              <div class="_sms-prog-fill" id="_smsProgFill"></div>
            </div>
            <div style="font-size:11.5px;color:#64748b;margin-bottom:8px;" id="_smsProgLabel">Preparing…</div>
            <div id="_smsLogList" style="max-height:150px;overflow-y:auto;"></div>
          </div>
        </div>

        <!-- Footer -->
        <div style="padding:12px 22px;border-top:1px solid #f1f5f9;
          display:flex;justify-content:space-between;align-items:center;gap:8px;">
          <button id="_smsCancelBtn" onclick="window.CBE_SMS._closeModal()"
            style="padding:7px 16px;border-radius:6px;border:1.5px solid #e2e8f0;
              background:none;font-family:inherit;font-size:12.5px;font-weight:600;
              cursor:pointer;color:#64748b;">Cancel</button>
          <button id="_smsSendBtn"
            onclick="window.CBE_SMS._startSend('${_esc(schoolId)}','${_esc(schoolName)}','${_esc(term)}','${_esc(year)}','${_esc(senderId)}')"
            style="padding:7px 20px;border-radius:6px;background:#1a56db;color:#fff;
              border:none;font-family:inherit;font-size:12.5px;font-weight:700;
              cursor:pointer;display:flex;align-items:center;gap:6px;">
            📤 Send to ${withPhone.length} Parent${withPhone.length !== 1 ? 's' : ''}
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) _closeModal(); });
    modal._smsRecipients = withPhone;

    // Preview
    const sample = recipients[0];
    if (sample) {
      const preview = buildResultsSMS({
        studentName: sample.studentName || 'Student Name',
        grade: sample.grade || 'Grade 4', stream: sample.stream || '',
        term, year, schoolName,
        subjects: sample.subjects?.length
          ? sample.subjects
          : [{ name: 'Math', score: 87 }, { name: 'English', score: 75 }, { name: 'Science', score: 90 }],
        overallAvg: sample.overallAvg, level: sample.level,
        points: sample.points, rank: sample.rank, totalStudents: sample.totalStudents,
      });
      const previewEl = document.getElementById('_smsMsgPreview');
      if (previewEl) previewEl.textContent = preview;
      const lenEl = document.getElementById('_smsMsgLen');
      if (lenEl) {
        const parts = Math.ceil(preview.length / 160);
        lenEl.textContent = `~${preview.length} chars · ~${parts} SMS part${parts > 1 ? 's' : ''} per student`;
      }
    }

    _checkSendModalBalance(schoolId, withPhone.length);
  }

  async function _checkSendModalBalance(schoolId, needed) {
    try {
      const w       = await getWalletBalance(schoolId);
      const balEl   = document.getElementById('_smsWalletBal');
      const warnEl  = document.getElementById('_smsLowBalWarn');
      const msgEl   = document.getElementById('_smsLowBalMsg');
      const sendBtn = document.getElementById('_smsSendBtn');

      const cost    = needed * SMS_COST;
      const enough  = w.balance >= cost;

      if (balEl) {
        balEl.textContent  = `KES ${w.balance.toFixed(2)} (${Math.floor(w.balance / SMS_COST)} SMS)`;
        balEl.style.color  = enough ? '#059669' : '#dc2626';
      }

      if (!enough && warnEl && msgEl) {
        msgEl.textContent = ` Need KES ${cost}, have KES ${w.balance.toFixed(2)}. Short by KES ${(cost - w.balance).toFixed(2)}.`;
        warnEl.style.display = 'block';
        if (sendBtn) {
          sendBtn.disabled        = true;
          sendBtn.style.background = '#94a3b8';
          sendBtn.title            = 'Top up your wallet to enable sending';
        }
      }
    } catch (_) {
      const balEl = document.getElementById('_smsWalletBal');
      if (balEl) balEl.textContent = 'Could not load';
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

    const awake = await _wakeProxy(msg => { if (progLabel) progLabel.textContent = msg; });
    if (!awake) {
      if (progLabel) progLabel.innerHTML = '❌ Could not reach SMS server. Wait 30s and try again.';
      if (sendBtn)   { sendBtn.disabled = false; sendBtn.textContent = '🔄 Retry'; }
      if (cancelBtn) { cancelBtn.disabled = false; }
      return;
    }

    if (sendBtn) sendBtn.textContent = '⏳ Sending…';
    const summary = { sent: 0, failed: 0, skipped: 0, error: 0 };
    let totalSent = 0;

    try {
      const results = await sendBulkResults(schoolId, recipients, {
        term, year, schoolName, senderId,
        onProgress(done, total, last) {
          const pct = Math.round((done / total) * 100);
          if (progFill)  progFill.style.width  = pct + '%';
          if (progLabel) progLabel.textContent  = `Sending ${done} of ${total}…`;

          if (last) {
            const s = last.status;
            summary[s] = (summary[s] || 0) + 1;
            if (s === 'sent') totalSent++;

            const dot       = `<span class="_sms-dot ${s}"></span>`;
            const name      = _esc(last.studentName || '—');
            const phone     = _esc(last.phone || last.parentPhone || '—');
            const note      = _statusNote(last);
            const noteColor = s === 'sent' ? '#059669' : s === 'skipped' ? '#d97706' : '#dc2626';
            if (logList) {
              logList.innerHTML += `
                <div class="_sms-row">
                  ${dot}
                  <span style="flex:1;font-weight:600;">${name}</span>
                  <span style="color:#94a3b8;">${phone}</span>
                  <span style="color:${noteColor};font-weight:600;">${note}</span>
                </div>`;
              logList.scrollTop = logList.scrollHeight;
            }
          }
        },
      });

      const w = await getWalletBalance(schoolId).catch(() => null);
      const balAfter = w ? `KES ${w.balance.toFixed(2)} remaining` : '';

      if (progLabel) progLabel.innerHTML =
        `✅ Done — <strong style="color:#059669;">${summary.sent} sent</strong>` +
        ` · <span style="color:#dc2626;">${(summary.failed||0) + (summary.error||0)} failed</span>` +
        ` · <span style="color:#d97706;">${summary.skipped||0} skipped</span>` +
        (balAfter ? ` · <span style="color:#64748b;font-size:11px;">${balAfter}</span>` : '');

    } catch (e) {
      if (e.code === 'INSUFFICIENT_BALANCE') {
        if (progLabel) progLabel.textContent = '';
        if (logList) logList.insertAdjacentHTML('afterend', `
          <div style="background:#fef2f2;border:1px solid #fecaca;border-left:3px solid #dc2626;
            border-radius:7px;padding:10px 14px;font-size:12px;color:#991b1b;margin-top:10px;line-height:1.7;">
            💳 <strong>Wallet ran out of credit.</strong> ${_esc(e.message)}<br>
            <a href="#" onclick="window.CBE_SMS.openWalletModal('${_esc(schoolId)}');return false;"
              style="color:#1a56db;font-weight:700;">📲 Top up your wallet →</a>
          </div>`);
      } else {
        if (progLabel) progLabel.textContent = '❌ ' + e.message;
      }
      if (sendBtn)   { sendBtn.disabled = false; sendBtn.textContent = '🔄 Retry'; }
      if (cancelBtn) { cancelBtn.disabled = false; }
      return;
    }

    if (sendBtn)   { sendBtn.textContent = '✓ Done'; sendBtn.style.background = '#059669'; }
    if (cancelBtn) { cancelBtn.disabled = false; cancelBtn.textContent = 'Close'; }
  }

  function _closeModal()      { _removeSendModal(); }
  function _removeSendModal() { document.getElementById('cbeSmsModal')?.remove(); }

  // ════════════════════════════════════════════════════════════
  //  9. ANNOUNCEMENTS
  // ════════════════════════════════════════════════════════════

  function buildAnnouncementSMS(template, { studentName, grade, stream, schoolName } = {}) {
    return String(template || '')
      .replace(/\{studentName\}/gi, studentName || '')
      .replace(/\{schoolName\}/gi, schoolName || '')
      .replace(/\{grade\}/gi, grade || '')
      .replace(/\{stream\}/gi, stream || '');
  }

  function _uniqueGrades(students) {
    const set = new Set();
    (students || []).forEach(s => { if (s.grade) set.add(s.grade); });
    return Array.from(set).sort();
  }

  function _uniqueStreams(students, grade) {
    const set = new Set();
    (students || []).forEach(s => {
      if ((!grade || s.grade === grade) && s.stream) set.add(s.stream);
    });
    return Array.from(set).sort();
  }

  function _filterRoster(students, grade, stream) {
    return (students || []).filter(s =>
      (!grade  || grade  === '__all__' || s.grade  === grade) &&
      (!stream || stream === '__all__' || s.stream === stream) &&
      s.parentPhone
    );
  }

  async function sendBulkAnnouncement(schoolId, recipients, opts = {}) {
    const { template, schoolName = '', senderId = '', onProgress } = opts;

    const payload = recipients
      .filter(r => r.parentPhone)
      .map(r => ({
        to:      normalisePhone(r.parentPhone),
        from:    senderId || '',
        message: buildAnnouncementSMS(template, {
          studentName: r.studentName, grade: r.grade, stream: r.stream, schoolName,
        }),
        meta: { studentName: r.studentName, grade: r.grade, stream: r.stream,
                parentPhone: r.parentPhone },
      }));

    const results = [];
    let idx = 0;
    for (const r of recipients) {
      if (!r.parentPhone) {
        const entry = { ...r, status: 'skipped', reason: 'No phone number' };
        results.push(entry);
        onProgress?.(++idx, recipients.length, entry);
      }
    }

    if (payload.length === 0) return results;

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 120_000);

    const r = await fetch(SMS_SEND_SCHOOL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ schoolId, recipients: payload, type: 'announcement' }),
      signal:  controller.signal,
    });

    const data = await r.json().catch(() => { throw new Error(`Server error ${r.status}`); });

    if (r.status === 402) {
      throw Object.assign(
        new Error(data.message || 'Wallet empty — top up to send the announcement'),
        { code: 'INSUFFICIENT_BALANCE', balance: data.balance }
      );
    }
    if (!r.ok) throw new Error(data.error || `Server error ${r.status}`);

    const serverResults = data.results || [];
    for (let i = 0; i < serverResults.length; i++) {
      const sr    = serverResults[i];
      const orig  = recipients.find(r => r.parentPhone && normalisePhone(r.parentPhone) === sr.to) || {};
      const entry = { ...orig, status: sr.status, reason: sr.reason || sr.atStatus || '', phone: sr.to };
      results.push(entry);
      onProgress?.(++idx, recipients.length, entry);
    }

    return results;
  }

  function openAnnouncementModal(students, schoolId, schoolSettings = {}) {
    _removeAnnouncementModal();

    const { name: schoolName = '', senderId = '' } = schoolSettings;
    const roster = (students || []).filter(s => s.parentPhone);
    const grades = _uniqueGrades(roster);

    const modal = document.createElement('div');
    modal.id    = 'cbeAnnModal';
    modal.style.cssText = `
      position:fixed;inset:0;background:rgba(0,0,0,.45);
      backdrop-filter:blur(6px);z-index:9999;
      display:flex;align-items:flex-start;justify-content:center;
      padding:12px;overflow-y:auto;
      font-family:'Plus Jakarta Sans',sans-serif;
    `;

    modal.innerHTML = `
      <div style="background:#fff;border-radius:14px;width:100%;max-width:560px;
        box-shadow:0 24px 60px rgba(0,0,0,.3);overflow:hidden;
        display:flex;flex-direction:column;
        animation:_annIn .2s cubic-bezier(.22,1,.36,1)">
        <style>
          @keyframes _annIn{from{opacity:0;transform:scale(.95) translateY(12px)}to{opacity:1;transform:none}}
          #cbeAnnModal select, #cbeAnnModal textarea {
            width:100%;box-sizing:border-box;padding:8px 11px;
            border:1.5px solid #dce1ec;border-radius:8px;font-family:inherit;
            font-size:13px;outline:none;transition:border-color .14s;background:#fff;color:#0f172a;
          }
          #cbeAnnModal select:focus, #cbeAnnModal textarea:focus{border-color:#1a56db;box-shadow:0 0 0 3px rgba(26,86,219,.1);}
          #cbeAnnModal label{display:block;font-size:10.5px;font-weight:700;color:#64748b;
            text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;}
          #cbeAnnModal .afield{margin-bottom:14px;}
          ._ann-tag{display:inline-block;background:#eff4ff;border:1px solid #c7d9ff;color:#1a56db;
            font-size:10.5px;font-weight:700;padding:2px 8px;border-radius:5px;margin:0 4px 4px 0;
            cursor:pointer;font-family:monospace;}
          ._ann-tag:hover{background:#1a56db;color:#fff;}
          ._ann-prog-bar{height:4px;background:#e2e8f0;border-radius:2px;overflow:hidden;margin:10px 0}
          ._ann-prog-fill{height:100%;background:#7c3aed;border-radius:2px;transition:width .3s;width:0}
          ._ann-row{display:flex;align-items:center;gap:10px;padding:6px 0;
            border-bottom:1px solid #f1f5f9;font-size:12.5px}
          ._ann-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
          ._ann-dot.sent{background:#059669} ._ann-dot.failed,._ann-dot.error{background:#dc2626}
          ._ann-dot.skipped{background:#d97706}
        </style>

        <!-- Header -->
        <div style="background:linear-gradient(135deg,#1e1b4b,#4c1d95 60%,#7c3aed);
          padding:18px 22px;color:#fff;flex-shrink:0;">
          <div style="font-size:16px;font-weight:800;margin-bottom:2px;">📢 Send Announcement</div>
          <div style="font-size:11.5px;opacity:.75;">${_esc(schoolName)} · Custom message to any grade or stream</div>
        </div>

        <!-- Network notice -->
        ${NETWORK_NOTICE}

        <!-- Scrollable body -->
        <div style="padding:18px 22px;overflow-y:auto;flex:1;">

          <div id="_annWalletBar" style="
            display:flex;align-items:center;justify-content:space-between;
            background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:8px;
            padding:9px 14px;margin-bottom:14px;">
            <div style="font-size:12px;color:#64748b;font-weight:600;">
              💳 SMS Wallet: <span id="_annWalletBal" style="color:#0f172a;font-weight:800;">Loading…</span>
            </div>
            <button onclick="window.CBE_SMS.openWalletModal('${_esc(schoolId)}')"
              style="padding:4px 12px;border-radius:6px;border:1.5px solid #c7d9ff;
                background:#eff4ff;color:#1a56db;font-family:inherit;font-size:11px;
                font-weight:700;cursor:pointer;">+ Top Up</button>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px;">
            <div class="afield" style="margin-bottom:0;">
              <label>Grade</label>
              <select id="_annGrade" onchange="window.CBE_SMS._annRefresh()">
                <option value="__all__">All Grades</option>
                ${grades.map(g => `<option value="${_esc(g)}">${_esc(g)}</option>`).join('')}
              </select>
            </div>
            <div class="afield" style="margin-bottom:0;">
              <label>Stream</label>
              <select id="_annStream" onchange="window.CBE_SMS._annRefresh()">
                <option value="__all__">All Streams</option>
              </select>
            </div>
          </div>

          <div id="_annCountBar" style="
            background:#f5f3ff;border:1px solid #ddd6fe;border-radius:7px;
            padding:8px 13px;font-size:12px;color:#5b21b6;margin-bottom:14px;font-weight:600;">
            👥 <span id="_annCount">0</span> parent(s) will receive this · 💰 Estimated cost: KES <span id="_annCost">0</span>
          </div>

          <div class="afield">
            <label>Message</label>
            <textarea id="_annMessage" rows="4" placeholder="e.g. Dear parent, school closes early this Friday for staff training…" oninput="window.CBE_SMS._annRefresh()"></textarea>
            <div style="margin-top:6px;">
              <span class="_ann-tag" onclick="window.CBE_SMS._annInsertTag('{studentName}')">{studentName}</span>
              <span class="_ann-tag" onclick="window.CBE_SMS._annInsertTag('{grade}')">{grade}</span>
              <span class="_ann-tag" onclick="window.CBE_SMS._annInsertTag('{schoolName}')">{schoolName}</span>
            </div>
          </div>

          <div style="margin-bottom:14px;">
            <div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;
              letter-spacing:.4px;margin-bottom:6px;">Preview</div>
            <div id="_annPreview" style="background:#f8fafc;border:1.5px solid #e2e8f0;
              border-radius:8px;padding:10px 14px;font-size:12px;line-height:1.8;color:#334155;
              font-family:monospace;white-space:pre-wrap;min-height:40px;">Type a message above to preview…</div>
          </div>

          <div id="_annLowBalWarn" style="display:none;
            background:#fef2f2;border:1px solid #fecaca;border-left:3px solid #dc2626;
            border-radius:7px;padding:9px 13px;font-size:12px;color:#991b1b;margin-bottom:14px;">
            ⚠️ <strong>Insufficient wallet balance.</strong> <span id="_annLowBalMsg"></span>
            <a href="#" onclick="window.CBE_SMS.openWalletModal('${_esc(schoolId)}');return false;"
              style="color:#1a56db;font-weight:700;display:block;margin-top:4px;">📲 Top up now →</a>
          </div>

          <div id="_annProgress" style="display:none;">
            <div class="_ann-prog-bar"><div class="_ann-prog-fill" id="_annProgFill"></div></div>
            <div style="font-size:11.5px;color:#64748b;margin-bottom:8px;" id="_annProgLabel">Preparing…</div>
            <div id="_annLogList" style="max-height:150px;overflow-y:auto;"></div>
          </div>
        </div>

        <!-- Footer — always visible (flex-shrink:0) -->
        <div style="padding:12px 22px;border-top:1px solid #f1f5f9;flex-shrink:0;
          display:flex;justify-content:space-between;align-items:center;gap:8px;">
          <button id="_annCancelBtn" onclick="window.CBE_SMS._closeAnnouncementModal()"
            style="padding:7px 16px;border-radius:6px;border:1.5px solid #e2e8f0;
              background:none;font-family:inherit;font-size:12.5px;font-weight:600;
              cursor:pointer;color:#64748b;">Cancel</button>
          <button id="_annSendBtn"
            onclick="window.CBE_SMS._startAnnouncementSend('${_esc(schoolId)}','${_esc(schoolName)}','${_esc(senderId)}')"
            style="padding:7px 20px;border-radius:6px;background:#7c3aed;color:#fff;
              border:none;font-family:inherit;font-size:12.5px;font-weight:700;
              cursor:pointer;">📤 Send Announcement</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) _closeAnnouncementModal(); });
    modal.dataset.schoolId   = schoolId;
    modal.dataset.schoolName = schoolName;
    modal._annRoster = roster;

    _annRefresh();
  }

  function _closeAnnouncementModal()  { _removeAnnouncementModal(); }
  function _removeAnnouncementModal() { document.getElementById('cbeAnnModal')?.remove(); }

  function _annInsertTag(tag) {
    const ta = document.getElementById('_annMessage');
    if (!ta) return;
    const start = ta.selectionStart ?? ta.value.length;
    const end   = ta.selectionEnd ?? ta.value.length;
    ta.value = ta.value.slice(0, start) + tag + ta.value.slice(end);
    ta.focus();
    ta.selectionStart = ta.selectionEnd = start + tag.length;
    _annRefresh();
  }

  function _annRefresh() {
    const modal = document.getElementById('cbeAnnModal');
    if (!modal) return;

    const roster    = modal._annRoster || [];
    const gradeSel  = document.getElementById('_annGrade');
    const streamSel = document.getElementById('_annStream');
    const grade     = gradeSel?.value || '__all__';

    if (streamSel) {
      const streams     = _uniqueStreams(roster, grade === '__all__' ? null : grade);
      const prevStream  = streamSel.value;
      streamSel.innerHTML = `<option value="__all__">All Streams</option>` +
        streams.map(s => `<option value="${_esc(s)}">${_esc(s)}</option>`).join('');
      if (streams.includes(prevStream)) streamSel.value = prevStream;
    }
    const stream = streamSel?.value || '__all__';

    const filtered = _filterRoster(roster, grade, stream);
    modal._annFiltered = filtered;

    const cntEl  = document.getElementById('_annCount');
    const costEl = document.getElementById('_annCost');
    if (cntEl)  cntEl.textContent  = filtered.length;
    if (costEl) costEl.textContent = filtered.length * SMS_COST;

    const template  = document.getElementById('_annMessage')?.value || '';
    const previewEl = document.getElementById('_annPreview');
    if (previewEl) {
      if (!template.trim()) {
        previewEl.textContent = 'Type a message above to preview…';
      } else {
        const sample = filtered[0] || roster[0] || {
          studentName: 'Student Name',
          grade: grade !== '__all__' ? grade : 'Grade X',
          stream: '',
        };
        previewEl.textContent = buildAnnouncementSMS(template, {
          studentName: sample.studentName, grade: sample.grade, stream: sample.stream,
          schoolName: modal.dataset.schoolName || '',
        });
      }
    }

    _checkAnnouncementBalance(modal.dataset.schoolId, filtered.length);
  }

  async function _checkAnnouncementBalance(schoolId, needed = 0) {
    try {
      const w       = await getWalletBalance(schoolId);
      const balEl   = document.getElementById('_annWalletBal');
      const warnEl  = document.getElementById('_annLowBalWarn');
      const msgEl   = document.getElementById('_annLowBalMsg');
      const sendBtn = document.getElementById('_annSendBtn');

      const cost   = needed * SMS_COST;
      const enough = w.balance >= cost;

      if (balEl) {
        balEl.textContent = `KES ${w.balance.toFixed(2)} (${Math.floor(w.balance / SMS_COST)} SMS)`;
        balEl.style.color = enough ? '#059669' : '#dc2626';
      }
      if (warnEl) warnEl.style.display = (!enough && needed > 0) ? 'block' : 'none';
      if (!enough && msgEl) {
        msgEl.textContent = ` Need KES ${cost}, have KES ${w.balance.toFixed(2)}. Short by KES ${(cost - w.balance).toFixed(2)}.`;
      }
      if (sendBtn) {
        const disable = !enough || needed === 0;
        sendBtn.disabled        = disable;
        sendBtn.style.background = disable ? '#94a3b8' : '#7c3aed';
        sendBtn.title             = needed === 0 ? 'No parents match this grade/stream filter' : '';
      }
    } catch (_) {
      const balEl = document.getElementById('_annWalletBal');
      if (balEl) balEl.textContent = 'Could not load';
    }
  }

  async function _startAnnouncementSend(schoolId, schoolName, senderId) {
    const modal      = document.getElementById('cbeAnnModal');
    const recipients = modal?._annFiltered || [];
    const template    = document.getElementById('_annMessage')?.value.trim();

    if (!template)            { alert('Write a message first.'); return; }
    if (recipients.length === 0) { alert('No parents match this grade/stream filter.'); return; }

    const sendBtn   = document.getElementById('_annSendBtn');
    const cancelBtn = document.getElementById('_annCancelBtn');
    const progress  = document.getElementById('_annProgress');
    const progFill  = document.getElementById('_annProgFill');
    const progLabel = document.getElementById('_annProgLabel');
    const logList   = document.getElementById('_annLogList');

    if (sendBtn)   { sendBtn.disabled = true; sendBtn.textContent = '⏳ Connecting…'; }
    if (cancelBtn) { cancelBtn.disabled = true; }
    if (progress)  { progress.style.display = 'block'; }

    const awake = await _wakeProxy(msg => { if (progLabel) progLabel.textContent = msg; });
    if (!awake) {
      if (progLabel) progLabel.innerHTML = '❌ Could not reach SMS server. Wait 30s and try again.';
      if (sendBtn)   { sendBtn.disabled = false; sendBtn.textContent = '🔄 Retry'; }
      if (cancelBtn) { cancelBtn.disabled = false; }
      return;
    }

    if (sendBtn) sendBtn.textContent = '⏳ Sending…';
    const summary = { sent: 0, failed: 0, skipped: 0, error: 0 };

    try {
      await sendBulkAnnouncement(schoolId, recipients, {
        template, schoolName, senderId,
        onProgress(done, total, last) {
          const pct = Math.round((done / total) * 100);
          if (progFill)  progFill.style.width = pct + '%';
          if (progLabel) progLabel.textContent = `Sending ${done} of ${total}…`;
          if (last) {
            const s = last.status;
            summary[s] = (summary[s] || 0) + 1;
            const dot   = `<span class="_ann-dot ${s}"></span>`;
            const name  = _esc(last.studentName || '—');
            const phone = _esc(last.phone || last.parentPhone || '—');
            const note  = s === 'sent' ? 'Delivered'
                        : s === 'skipped' ? 'No phone'
                        : _esc(String(last.reason || s)).slice(0, 40);
            const color = s === 'sent' ? '#059669' : s === 'skipped' ? '#d97706' : '#dc2626';
            if (logList) {
              logList.innerHTML += `
                <div class="_ann-row">
                  ${dot}
                  <span style="flex:1;font-weight:600;">${name}</span>
                  <span style="color:#94a3b8;">${phone}</span>
                  <span style="color:${color};font-weight:600;">${note}</span>
                </div>`;
              logList.scrollTop = logList.scrollHeight;
            }
          }
        },
      });

      const w = await getWalletBalance(schoolId).catch(() => null);
      const balAfter = w ? `KES ${w.balance.toFixed(2)} remaining` : '';
      if (progLabel) progLabel.innerHTML =
        `✅ Done — <strong style="color:#059669;">${summary.sent||0} sent</strong>` +
        ` · <span style="color:#dc2626;">${(summary.failed||0)+(summary.error||0)} failed</span>` +
        ` · <span style="color:#d97706;">${summary.skipped||0} skipped</span>` +
        (balAfter ? ` · <span style="color:#64748b;font-size:11px;">${balAfter}</span>` : '');

    } catch (e) {
      if (e.code === 'INSUFFICIENT_BALANCE') {
        if (progLabel) progLabel.textContent = '';
        if (logList) logList.insertAdjacentHTML('afterend', `
          <div style="background:#fef2f2;border:1px solid #fecaca;border-left:3px solid #dc2626;
            border-radius:7px;padding:10px 14px;font-size:12px;color:#991b1b;margin-top:10px;line-height:1.7;">
            💳 <strong>Wallet ran out of credit.</strong> ${_esc(e.message)}<br>
            <a href="#" onclick="window.CBE_SMS.openWalletModal('${_esc(schoolId)}');return false;"
              style="color:#1a56db;font-weight:700;">📲 Top up your wallet →</a>
          </div>`);
      } else {
        if (progLabel) progLabel.textContent = '❌ ' + e.message;
      }
      if (sendBtn)   { sendBtn.disabled = false; sendBtn.textContent = '🔄 Retry'; }
      if (cancelBtn) { cancelBtn.disabled = false; }
      return;
    }

    if (sendBtn)   { sendBtn.textContent = '✓ Done'; sendBtn.style.background = '#059669'; }
    if (cancelBtn) { cancelBtn.disabled = false; cancelBtn.textContent = 'Close'; }
  }

  // ════════════════════════════════════════════════════════════
  //  10. STANDALONE TEST MODAL
  // ════════════════════════════════════════════════════════════

  function _openTestModal(preloadSchoolId) {
    document.getElementById('_cbeTestSmsModal')?.remove();
    const resolvedId = preloadSchoolId || _schoolId();

    const overlay = document.createElement('div');
    overlay.id = '_cbeTestSmsModal';
    overlay.style.cssText = `
      position:fixed;inset:0;background:rgba(0,0,0,.5);backdrop-filter:blur(8px);z-index:99999;
      display:flex;align-items:flex-start;justify-content:center;
      padding:20px;overflow-y:auto;
      font-family:'Plus Jakarta Sans',ui-sans-serif,sans-serif;
    `;

    overlay.innerHTML = `
      <div id="_cbeTestSmsBox" style="
        background:#fff;border-radius:16px;width:100%;max-width:460px;
        box-shadow:0 32px 80px rgba(0,0,0,.35);overflow-y:auto;max-height:90vh;
        animation:_testIn .22s cubic-bezier(.22,1,.36,1);">
        <style>
          @keyframes _testIn{from{opacity:0;transform:scale(.94) translateY(14px)}to{opacity:1;transform:none}}
          #_cbeTestSmsBox input{width:100%;box-sizing:border-box;height:38px;padding:0 11px;
            border:1.5px solid #dce1ec;border-radius:7px;font-family:inherit;font-size:13px;outline:none;
            transition:border-color .14s;background:#fff;}
          #_cbeTestSmsBox input:focus{border-color:#1a56db;}
          #_cbeTestSmsBox label{display:block;font-size:10.5px;font-weight:700;color:#64748b;
            text-transform:uppercase;letter-spacing:.45px;margin-bottom:5px;}
          #_cbeTestSmsBox .field{margin-bottom:12px;}
          ._test-status{display:none;border-radius:8px;padding:10px 14px;font-size:12.5px;line-height:1.6;margin-top:12px;}
          ._test-log{font-family:monospace;font-size:11px;background:#0f172a;color:#94a3b8;
            border-radius:7px;padding:10px 12px;margin-top:10px;max-height:120px;overflow-y:auto;line-height:1.7;display:none;}
          ._test-log .ok{color:#34d399;} ._test-log .err{color:#f87171;} ._test-log .inf{color:#60a5fa;}
        </style>
        <div style="background:linear-gradient(135deg,#0f172a 0%,#1e3a8a 65%,#1a56db 100%);padding:18px 22px;color:#fff;">
          <div style="font-size:15px;font-weight:800;margin-bottom:2px;">🧪 SMS Connection Test</div>
          <div style="font-size:11px;opacity:.65;">Uses your school's own AT credentials</div>
        </div>
        <div style="padding:20px 22px 4px;">
          <div class="field"><label>AT API Key</label>
            <input id="_tApiKey" type="password" placeholder="Your Africa's Talking API key"></div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
            <div class="field"><label>AT Username</label>
              <input id="_tUsername" type="text" placeholder="sandbox"></div>
            <div class="field"><label>Sender ID (optional)</label>
              <input id="_tSenderId" type="text" placeholder="Leave blank for default"></div>
          </div>
          <div class="field"><label>Test Phone Number</label>
            <input id="_tPhone" type="tel" placeholder="+254712345678"></div>
          <div style="background:#eff4ff;border:1px solid #c7d9ff;border-left:3px solid #1a56db;
            border-radius:6px;padding:9px 13px;font-size:11.5px;color:#1e3a8a;line-height:1.6;margin-bottom:4px;">
            ℹ️ For <strong>Sandbox</strong>: use <code>sandbox</code> as username and register your number in AT Dashboard first.
          </div>
          <div id="_tStatus" class="_test-status"></div>
          <div id="_tLog" class="_test-log"></div>
        </div>
        <div style="padding:14px 22px 18px;display:flex;justify-content:space-between;align-items:center;gap:8px;">
          <button onclick="document.getElementById('_cbeTestSmsModal').remove()"
            style="padding:8px 18px;border-radius:7px;border:1.5px solid #e2e8f0;
              background:none;font-family:inherit;font-size:12.5px;font-weight:600;cursor:pointer;color:#64748b;">Close</button>
          <div style="display:flex;gap:8px;">
            <button id="_tProbeBtn" onclick="window.CBE_SMS._probeProxy()"
              style="padding:8px 16px;border-radius:7px;border:1.5px solid #c7d9ff;background:#eff4ff;
                font-family:inherit;font-size:12.5px;font-weight:700;cursor:pointer;color:#1a56db;">🔌 Ping Proxy</button>
            <button id="_tSendBtn" onclick="window.CBE_SMS._doTestSend()"
              style="padding:8px 20px;border-radius:7px;background:#1a56db;color:#fff;
                border:none;font-family:inherit;font-size:12.5px;font-weight:700;cursor:pointer;">📤 Send Test SMS</button>
          </div>
        </div>
      </div>`;

    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    if (resolvedId) _prefillTestModal(resolvedId);
  }

  async function _prefillTestModal(schoolId) {
    try {
      const snap = await db().collection('settings').doc(schoolId).get();
      if (!snap.exists) return;
      const d = snap.data();
      const f = (id, val) => { const el = document.getElementById(id); if (el && val) el.value = val; };
      f('_tApiKey', d.atApiKey); f('_tUsername', d.atUsername);
      f('_tSenderId', d.smsSenderId); f('_tPhone', d.smsTestPhone);
    } catch (_) {}
  }

  function _testStatus(msg, type = 'info') {
    const el = document.getElementById('_tStatus');
    if (!el) return;
    const styles = {
      info:'background:#eff4ff;color:#1e3a8a;border:1px solid #c7d9ff;',
      success:'background:#f0fdf4;color:#065f46;border:1px solid #bbf7d0;',
      error:'background:#fef2f2;color:#991b1b;border:1px solid #fecaca;',
      warning:'background:#fef3c7;color:#92400e;border:1px solid #fcd34d;',
      loading:'background:#f8fafc;color:#334155;border:1px solid #e2e8f0;',
    };
    el.style.cssText += styles[type] || styles.info;
    el.innerHTML = msg; el.style.display = 'block';
  }

  function _testLog(msg, cls = 'inf') {
    const el = document.getElementById('_tLog');
    if (!el) return;
    el.style.display = 'block';
    const line = document.createElement('div');
    line.className = cls;
    line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    el.appendChild(line); el.scrollTop = el.scrollHeight;
  }

  async function _probeProxy() {
    const btn = document.getElementById('_tProbeBtn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Pinging…'; }
    _testStatus('⏳ Pinging proxy…', 'loading');
    _testLog('GET ' + BACKEND + '/api/health');
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const r = await fetch(`${BACKEND}/api/health`, { signal: controller.signal });
      _testLog(`HTTP ${r.status} ${r.statusText}`, r.ok ? 'ok' : 'err');
      if (r.ok) {
        _testStatus('✅ Proxy is <strong>alive and reachable</strong>. You can send a test SMS now.', 'success');
      } else {
        _testStatus(`⚠️ Proxy returned ${r.status} — check Render logs.`, 'warning');
      }
    } catch (e) {
      const msg = e.name === 'AbortError' ? 'Proxy timed out — Render may be cold-starting. Wait 30s.' : 'Network error: ' + e.message;
      _testLog(msg, 'err'); _testStatus('❌ ' + msg, 'error');
    }
    if (btn) { btn.disabled = false; btn.textContent = '🔌 Ping Proxy'; }
  }

  async function _doTestSend() {
    const apiKey   = document.getElementById('_tApiKey')?.value.trim();
    const username = document.getElementById('_tUsername')?.value.trim();
    const senderId = document.getElementById('_tSenderId')?.value.trim() || '';
    const rawPhone = document.getElementById('_tPhone')?.value.trim();
    const btn      = document.getElementById('_tSendBtn');

    if (!apiKey)   { _testStatus('⚠️ Enter your AT API Key first.', 'warning');    return; }
    if (!username) { _testStatus('⚠️ Enter your AT Username first.', 'warning');   return; }
    if (!rawPhone) { _testStatus('⚠️ Enter a test phone number first.', 'warning'); return; }

    const phone = normalisePhone(rawPhone);
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Sending…'; }
    _testStatus('⏳ Sending test SMS — may take up to 15 s…', 'loading');
    _testLog(`Sending to ${phone}`);

    try {
      const data      = await sendSMS(apiKey, username, phone, `CBE Mark Sheet test SMS ✅\nProxy → AT pipeline working!\n— Your School System`, senderId);
      const recipient = data?.SMSMessageData?.Recipients?.[0];
      _testLog('Response: ' + JSON.stringify(data?.SMSMessageData || data), 'ok');
      if (recipient?.status === 'Success') {
        _testStatus(`✅ <strong>SMS delivered!</strong> Sent to <strong>${phone}</strong> · Cost: ${recipient?.cost || '—'} · ID: ${recipient?.messageId || '—'}`, 'success');
      } else {
        _testStatus(`⚠️ AT status: <strong>${recipient?.status || 'unknown'}</strong> — ${data?.SMSMessageData?.Message || 'Check AT dashboard.'}`, 'warning');
      }
    } catch (e) {
      _testLog('Error: ' + e.message, 'err');
      _testStatus('❌ <strong>Failed:</strong> ' + _esc(e.message), 'error');
    }
    if (btn) { btn.disabled = false; btn.textContent = '📤 Send Test SMS'; }
  }

  function _testSMS() { _openTestModal(_schoolId()); }

  // ════════════════════════════════════════════════════════════
  //  11. STANDALONE SETTINGS MODAL
  // ════════════════════════════════════════════════════════════

  function openSettingsModal(preloadSchoolId) {
    document.getElementById('_cbeSmsCfgModal')?.remove();
    const resolvedId = preloadSchoolId || _schoolId();

    const overlay = document.createElement('div');
    overlay.id = '_cbeSmsCfgModal';
    overlay.style.cssText = `
      position:fixed;inset:0;background:rgba(0,0,0,.55);backdrop-filter:blur(8px);z-index:99999;
      display:flex;align-items:flex-start;justify-content:center;
      padding:20px;overflow-y:auto;
      font-family:'Plus Jakarta Sans',ui-sans-serif,sans-serif;`;

    overlay.innerHTML = `
      <div id="_cbeSmsCfgBox" style="background:#fff;border-radius:16px;width:100%;max-width:480px;
        box-shadow:0 32px 80px rgba(0,0,0,.3);overflow-y:auto;max-height:90vh;
        animation:_cfgIn .22s cubic-bezier(.22,1,.36,1);">
        <style>
          @keyframes _cfgIn{from{opacity:0;transform:scale(.94) translateY(14px)}to{opacity:1;transform:none}}
          #_cbeSmsCfgBox input{width:100%;box-sizing:border-box;height:40px;padding:0 12px;
            border:1.5px solid #dce1ec;border-radius:8px;font-family:inherit;font-size:13px;outline:none;
            transition:border-color .14s;background:#fff;color:#0f172a;}
          #_cbeSmsCfgBox input:focus{border-color:#1a56db;box-shadow:0 0 0 3px rgba(26,86,219,.1);}
          #_cbeSmsCfgBox label{display:block;font-size:10.5px;font-weight:700;color:#64748b;
            text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;}
          #_cbeSmsCfgBox .field{margin-bottom:14px;}
          ._cfg-status{display:none;border-radius:8px;padding:10px 14px;font-size:12.5px;line-height:1.6;margin-top:4px;}
          ._cfg-badge{display:inline-flex;align-items:center;gap:5px;font-size:10.5px;font-weight:700;
            padding:3px 10px;border-radius:20px;background:#f1f5f9;color:#64748b;}
          ._cfg-badge.ok{background:#d1fae5;color:#065f46;}
        </style>
        <div style="background:linear-gradient(135deg,#0f172a 0%,#1e3a8a 60%,#1a56db 100%);padding:20px 24px;color:#fff;">
          <div style="display:flex;align-items:center;justify-content:space-between;">
            <div>
              <div style="font-size:15px;font-weight:800;margin-bottom:2px;">📱 SMS Setup</div>
              <div style="font-size:11px;opacity:.65;">Connect your Africa's Talking account</div>
            </div>
            <span id="_cfgBadge" class="_cfg-badge">Not configured</span>
          </div>
        </div>
        <div style="padding:22px 24px 8px;">
          <div class="field"><label>AT API Key *</label>
            <input id="_cfgApiKey" type="password" autocomplete="new-password" placeholder="Paste your Africa's Talking API key"></div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
            <div class="field"><label>AT Username *</label>
              <input id="_cfgUsername" type="text" autocomplete="off" placeholder="e.g. bett254"></div>
            <div class="field"><label>Sender ID (optional)</label>
              <input id="_cfgSenderId" type="text" placeholder="Leave blank for default"></div>
          </div>
          <div class="field"><label>Test Phone Number</label>
            <input id="_cfgTestPhone" type="tel" placeholder="+254712345678"></div>
          <div style="background:#eff4ff;border:1px solid #c7d9ff;border-left:3px solid #1a56db;
            border-radius:7px;padding:10px 14px;font-size:11.5px;color:#1e3a8a;line-height:1.75;margin-bottom:4px;">
            <strong>How to get your credentials:</strong><br>
            1. Go to <a href="https://africastalking.com" target="_blank" style="color:#1a56db;font-weight:600;">africastalking.com</a> → Login → your app<br>
            2. Copy <strong>API Key</strong> from Settings → API Key<br>
            3. Your <strong>Username</strong> is shown on the AT dashboard home
          </div>
          <div id="_cfgStatus" class="_cfg-status"></div>
        </div>
        <div style="padding:16px 24px 20px;display:flex;justify-content:space-between;align-items:center;gap:8px;">
          <button onclick="document.getElementById('_cbeSmsCfgModal').remove()"
            style="padding:9px 18px;border-radius:8px;border:1.5px solid #e2e8f0;background:none;
              font-family:inherit;font-size:12.5px;font-weight:600;cursor:pointer;color:#64748b;">Cancel</button>
          <div style="display:flex;gap:8px;">
            <button id="_cfgTestBtn" onclick="window.CBE_SMS._doSettingsTest()"
              style="padding:9px 16px;border-radius:8px;border:1.5px solid #bbf7d0;background:#f0fdf4;
                font-family:inherit;font-size:12.5px;font-weight:700;cursor:pointer;color:#059669;">🧪 Test SMS</button>
            <button id="_cfgSaveBtn" onclick="window.CBE_SMS._doSettingsSave()"
              style="padding:9px 22px;border-radius:8px;background:#1a56db;color:#fff;border:none;
                font-family:inherit;font-size:12.5px;font-weight:700;cursor:pointer;">💾 Save Settings</button>
          </div>
        </div>
      </div>`;

    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    if (resolvedId) _prefillSettingsModal(resolvedId);
  }

  async function _prefillSettingsModal(schoolId) {
    try {
      const snap = await db().collection('settings').doc(schoolId).get();
      if (!snap.exists) return;
      const d = snap.data();
      const f = (id, val) => { const el = document.getElementById(id); if (el && val) el.value = val; };
      f('_cfgApiKey', d.atApiKey); f('_cfgUsername', d.atUsername);
      f('_cfgSenderId', d.smsSenderId); f('_cfgTestPhone', d.smsTestPhone);
      const badge = document.getElementById('_cfgBadge');
      if (badge && d.atApiKey && d.atUsername) { badge.textContent = '✅ Configured'; badge.className = '_cfg-badge ok'; }
    } catch (_) {}
  }

  function _cfgStatus(msg, type = 'info') {
    const el = document.getElementById('_cfgStatus');
    if (!el) return;
    const styles = {
      info:'background:#eff4ff;color:#1e3a8a;border:1px solid #c7d9ff;',
      success:'background:#f0fdf4;color:#065f46;border:1px solid #bbf7d0;',
      error:'background:#fef2f2;color:#991b1b;border:1px solid #fecaca;',
      warning:'background:#fef3c7;color:#92400e;border:1px solid #fcd34d;',
      loading:'background:#f8fafc;color:#334155;border:1px solid #e2e8f0;',
    };
    el.style.cssText = styles[type] || styles.info;
    el.innerHTML = msg; el.style.display = 'block';
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
    if (!apiKey)   { _cfgStatus('⚠️ API Key is required.', 'warning');  return; }
    if (!username) { _cfgStatus('⚠️ Username is required.', 'warning'); return; }
    btn.disabled = true; btn.textContent = '⏳ Saving…';
    try {
      await saveATCredentials(schoolId, apiKey, username);
      await db().collection('settings').doc(schoolId).set({ smsSenderId: senderId, smsTestPhone: testPhone }, { merge: true });
      if (badge) { badge.textContent = '✅ Configured'; badge.className = '_cfg-badge ok'; }
      _cfgStatus('✅ <strong>Settings saved!</strong>', 'success');
    } catch (e) { _cfgStatus('❌ ' + _esc(e.message), 'error'); }
    btn.disabled = false; btn.textContent = '💾 Save Settings';
  }

  async function _doSettingsTest() {
    const apiKey   = document.getElementById('_cfgApiKey')?.value.trim();
    const username = document.getElementById('_cfgUsername')?.value.trim();
    const senderId = document.getElementById('_cfgSenderId')?.value.trim() || '';
    const rawPhone = document.getElementById('_cfgTestPhone')?.value.trim();
    const btn      = document.getElementById('_cfgTestBtn');
    if (!apiKey)   { _cfgStatus('⚠️ Enter your API Key first.', 'warning');        return; }
    if (!username) { _cfgStatus('⚠️ Enter your Username first.', 'warning');       return; }
    if (!rawPhone) { _cfgStatus('⚠️ Enter a test phone number first.', 'warning'); return; }
    btn.disabled = true; btn.textContent = '⏳ Sending…';
    _cfgStatus('⏳ Sending test SMS — may take up to 15 s…', 'loading');
    try {
      const data      = await sendSMS(apiKey, username, normalisePhone(rawPhone), `CBE Mark Sheet ✅\nSMS integration working!\n— ${username}`, senderId);
      const recipient = data?.SMSMessageData?.Recipients?.[0];
      if (recipient?.status === 'Success') {
        _cfgStatus(`✅ <strong>Test SMS sent!</strong> Delivered to ${rawPhone} · Cost: ${recipient?.cost || '—'}`, 'success');
      } else {
        _cfgStatus(`⚠️ AT responded: <strong>${recipient?.status || 'unknown'}</strong>`, 'warning');
      }
    } catch (e) { _cfgStatus('❌ ' + _esc(e.message), 'error'); }
    btn.disabled = false; btn.textContent = '🧪 Test SMS';
  }

  // ════════════════════════════════════════════════════════════
  //  12. SETTINGS PAGE HTML
  // ════════════════════════════════════════════════════════════

  function settingsHTML() {
    return `
    <div id="smsSettingsSection" style="background:#fff;border:1px solid #dce1ec;
      border-radius:10px;padding:20px;margin-top:20px;">

      <!-- Wallet block -->
      <div style="background:linear-gradient(135deg,#f0fdf4,#dcfce7);border:1px solid #bbf7d0;
        border-radius:8px;padding:16px;margin-bottom:18px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;">
        <div>
          <div style="font-size:11px;font-weight:700;color:#065f46;text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px;">💳 SMS Wallet Balance</div>
          <div id="smsWalletBalance" style="font-size:26px;font-weight:900;color:#0f172a;letter-spacing:-1px;">Loading…</div>
          <div id="smsWalletSmsCount" style="font-size:11px;color:#064e3b;margin-top:2px;">— SMS remaining</div>
        </div>
        <button onclick="CBE_SMS.openWalletModal()"
          style="padding:9px 20px;background:#059669;color:#fff;border:none;border-radius:8px;
            font-family:inherit;font-size:12.5px;font-weight:700;cursor:pointer;">
          📲 Top Up Wallet
        </button>
      </div>

      <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px;">
        <span style="font-size:20px;">📱</span>
        <div>
          <div style="font-family:'Familjen Grotesk',sans-serif;font-size:15px;font-weight:800;">SMS Settings</div>
          <div style="font-size:11.5px;color:#64748b;">Sender ID and test phone for outgoing SMS</div>
        </div>
        <span id="smsStatusBadge" style="margin-left:auto;font-size:10.5px;font-weight:700;
          padding:2px 10px;border-radius:20px;background:#f1f5f9;color:#64748b;">Loading…</span>
      </div>

      <div style="border-top:1px solid #f1f5f9;margin:14px 0;"></div>

      <div style="margin-bottom:12px;">
        <label style="display:block;font-size:11px;font-weight:700;color:#64748b;
          text-transform:uppercase;letter-spacing:.4px;margin-bottom:5px;">
          Sender ID <span style="font-size:10px;font-weight:400;text-transform:none;">(optional — must be registered with AT)</span>
        </label>
        <input id="smsSenderId" type="text" placeholder="e.g. MySchool  (leave blank to use AT default)"
          style="width:100%;height:36px;padding:0 10px;border:1.5px solid #dce1ec;border-radius:6px;
            font-family:inherit;font-size:13px;outline:none;transition:border-color .14s;"
          onfocus="this.style.borderColor='#1a56db'" onblur="this.style.borderColor='#dce1ec'">
      </div>

      <div style="margin-bottom:14px;">
        <label style="display:block;font-size:11px;font-weight:700;color:#64748b;
          text-transform:uppercase;letter-spacing:.4px;margin-bottom:5px;">
          Test Phone Number <span style="font-size:10px;font-weight:400;text-transform:none;">(used by Send Test SMS)</span>
        </label>
        <input id="smsTestPhone" type="tel" placeholder="+254712345678"
          style="width:100%;height:36px;padding:0 10px;border:1.5px solid #dce1ec;border-radius:6px;
            font-family:inherit;font-size:13px;outline:none;transition:border-color .14s;"
          onfocus="this.style.borderColor='#1a56db'" onblur="this.style.borderColor='#dce1ec'">
      </div>

      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button id="smsSaveBtn" onclick="CBE_SMS._saveSettings()"
          style="padding:7px 18px;background:#1a56db;color:#fff;border:none;border-radius:6px;
            font-family:inherit;font-size:12.5px;font-weight:700;cursor:pointer;">
          💾 Save Settings
        </button>
        <button onclick="CBE_SMS._testSMS()"
          style="padding:7px 18px;background:#f0fdf4;color:#059669;border:1.5px solid #bbf7d0;
            border-radius:6px;font-family:inherit;font-size:12.5px;font-weight:700;cursor:pointer;">
          🧪 Send Test SMS
        </button>
      </div>
      <div id="smsSaveMsg" style="font-size:12px;margin-top:8px;display:none;"></div>
    </div>`;
  }

  async function initSettingsUI(schoolId) {
    if (!schoolId) return;

    getWalletBalance(schoolId).then(w => {
      const balEl = document.getElementById('smsWalletBalance');
      const cntEl = document.getElementById('smsWalletSmsCount');
      const badge = document.getElementById('smsStatusBadge');
      if (balEl) balEl.textContent = `KES ${w.balance.toFixed(2)}`;
      if (cntEl) cntEl.textContent = `${Math.floor(w.balance / SMS_COST)} SMS remaining`;
      if (badge) {
        if (w.balance > 0) {
          badge.textContent = '✅ Wallet active'; badge.style.background = '#d1fae5'; badge.style.color = '#065f46';
        } else {
          badge.textContent = '⚠️ Wallet empty'; badge.style.background = '#fef3c7'; badge.style.color = '#92400e';
        }
      }
    }).catch(() => {
      const balEl = document.getElementById('smsWalletBalance');
      if (balEl) balEl.textContent = 'KES 0.00';
    });

    try {
      const snap = await db().collection('settings').doc(schoolId).get();
      if (snap.exists) {
        const d = snap.data();
        const si = document.getElementById('smsSenderId');
        const tp = document.getElementById('smsTestPhone');
        if (si && d.smsSenderId)  si.value = d.smsSenderId;
        if (tp && d.smsTestPhone) tp.value = d.smsTestPhone;
      }
    } catch (_) {}
  }

  async function _saveSettings() {
    const schoolId = _schoolId();
    if (!schoolId) { _showSaveMsg('⚠️ Not signed in yet — please wait.', '#dc2626'); return; }
    const senderId  = document.getElementById('smsSenderId')?.value.trim();
    const testPhone = document.getElementById('smsTestPhone')?.value.trim();
    const btn       = document.getElementById('smsSaveBtn');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      await db().collection('settings').doc(schoolId).set(
        { smsSenderId: senderId || '', smsTestPhone: testPhone || '' },
        { merge: true }
      );
      _showSaveMsg('✅ Settings saved!', '#059669');
    } catch (e) { _showSaveMsg('❌ ' + e.message, '#dc2626'); }
    btn.disabled = false; btn.textContent = '💾 Save Settings';
  }

  function _showSaveMsg(msg, color) {
    const el = document.getElementById('smsSaveMsg');
    if (!el) return;
    el.textContent = msg; el.style.color = color; el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 6000);
  }

  // ════════════════════════════════════════════════════════════
  //  UTILITIES
  // ════════════════════════════════════════════════════════════

  function _isSuccessStatus(status) {
    if (!status) return false;
    const s = String(status).toLowerCase();
    return s.includes('success') || s.includes('sent') || s.includes('submitted') || s.includes('queued');
  }

  function _isInsufficientBalance(entry) {
    const reason = (entry?.reason || entry?.atResponse?.status || '').toLowerCase();
    return reason.includes('insufficientbalance') || reason.includes('insufficient balance') ||
           reason.includes('user is not active')  || reason.includes('INSUFFICIENT_BALANCE');
  }

  function _statusNote(entry) {
    const s = entry.status;
    if (s === 'sent')    return 'Delivered';
    if (s === 'skipped') return entry.reason === 'Insufficient balance' ? 'No wallet credit' : 'No phone';
    if (_isInsufficientBalance(entry)) return 'No wallet credit';
    const raw = entry.reason || entry.atResponse?.status || s;
    return _esc(String(raw)).slice(0, 40);
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
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function _schoolId() {
    return window._schoolId || sessionStorage.getItem('cbe_school_id') || '';
  }

  // ── Public API ───────────────────────────────────────────────
  return {
    sendSMS,
    sendSchoolSMS,
    sendBulkResults,
    buildResultsSMS,
    sendBulkAnnouncement,
    buildAnnouncementSMS,
    openAnnouncementModal,
    _annRefresh,
    _annInsertTag,
    _startAnnouncementSend,
    _closeAnnouncementModal,
    getWalletBalance,
    openWalletModal,
    _doTopup,
    saveATCredentials,
    loadATCredentials,
    loadSenderId,
    openSendModal,
    _startSend,
    _closeModal,
    settingsHTML,
    initSettingsUI,
    _saveSettings,
    _testSMS,
    _openTestModal,
    _probeProxy,
    _doTestSend,
    openSettingsModal,
    _doSettingsSave,
    _doSettingsTest,
    normalisePhone,
  };

})();
