// ── DevTools Deterrent (soft mode) ──────────────────────────
// Goal: discourage casual snooping without risking false-positive
// lockouts for legitimate admins (zoom levels, extensions, display
// scaling, etc. can all trip aggressive detection methods).
//
// Note: this cannot and does not attempt to actually *prevent*
// DevTools access — that's not something client-side JS can do.
// It just removes the easy, accidental entry points and shows a
// brief, dismissible notice if someone deliberately bypasses them.
(function () {
  const NOTICE_ID = '_devNotice';
  const NOTICE_COOLDOWN_MS = 60 * 1000; // don't re-spam within a minute
  let lastShown = 0;

  function showNotice() {
    const now = Date.now();
    if (now - lastShown < NOTICE_COOLDOWN_MS) return;
    lastShown = now;

    if (document.getElementById(NOTICE_ID)) return; // already showing

    const el = document.createElement('div');
    el.id = NOTICE_ID;
    el.style.cssText = `
      position:fixed;bottom:16px;right:16px;z-index:99999;
      background:#0f1b35;color:#e8f0ff;border:1px solid rgba(255,255,255,.12);
      border-radius:10px;padding:12px 16px;font-family:sans-serif;font-size:13px;
      max-width:280px;box-shadow:0 8px 24px rgba(0,0,0,.35);
      display:flex;align-items:flex-start;gap:10px;
      animation:_devNoticeIn .25s ease;
    `;
    el.innerHTML = `
      <span style="font-size:16px;line-height:1">ℹ️</span>
      <div style="flex:1">
        <div style="font-weight:700;margin-bottom:2px">Developer tools</div>
        <div style="color:#9aa6c4;line-height:1.4">
          This dashboard isn't intended for end-user inspection. Please contact
          an administrator if you need data from this page.
        </div>
      </div>
      <button id="_devNoticeClose" style="
        background:none;border:none;color:#7a90b8;cursor:pointer;
        font-size:14px;line-height:1;padding:0;flex-shrink:0;">✕</button>
    `;
    document.body.appendChild(el);

    const styleTag = document.createElement('style');
    styleTag.textContent = `@keyframes _devNoticeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}`;
    document.head.appendChild(styleTag);

    const close = () => el.remove();
    document.getElementById('_devNoticeClose').addEventListener('click', close);
    setTimeout(close, 6000); // auto-dismiss
  }

  // Block the easy, accidental entry points only.
  document.addEventListener('contextmenu', (e) => e.preventDefault());

  document.addEventListener('keydown', (e) => {
    const blocked =
      e.key === 'F12' ||
      (e.ctrlKey && e.shiftKey && ['I', 'J', 'C'].includes(e.key.toUpperCase())) ||
      (e.ctrlKey && e.key.toUpperCase() === 'U');
    if (blocked) {
      e.preventDefault();
      e.stopPropagation();
      showNotice();
      return false;
    }
  });
})();
