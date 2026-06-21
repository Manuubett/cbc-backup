  // ── DevTools Detection & Deterrent ──────────────────────────
(function(){
  let devOpen = false;

  function lockPage(){
    if(devOpen) return;
    devOpen = true;
    document.body.innerHTML = `
      <div style="position:fixed;inset:0;background:#0b0f1a;display:flex;align-items:center;
        justify-content:center;flex-direction:column;gap:16px;z-index:99999;font-family:sans-serif">
        <div style="font-size:48px">🔒</div>
        <div style="color:#e8f0ff;font-size:20px;font-weight:700">Access Restricted</div>
        <div style="color:#7a90b8;font-size:14px">Developer tools are not permitted on this page.</div>
        <button onclick="location.reload()" 
          style="margin-top:8px;padding:10px 24px;background:#3b82f6;color:#fff;
            border:none;border-radius:8px;cursor:pointer;font-size:14px;font-weight:600">
          Close DevTools & Reload
        </button>
      </div>`;
  }

  // Method 1: size threshold
  const threshold = 160;
  setInterval(()=>{
    if(window.outerWidth - window.innerWidth > threshold ||
       window.outerHeight - window.innerHeight > threshold){
      lockPage();
    }
  }, 1000);

  // Method 2: debugger timing trick
  setInterval(()=>{
    const start = performance.now();
    // eslint-disable-next-line no-debugger
    debugger;
    if(performance.now() - start > 100) lockPage();
  }, 2000);

  // Method 3: disable right-click
  document.addEventListener('contextmenu', e => e.preventDefault());

  // Method 4: disable F12, Ctrl+Shift+I, Ctrl+Shift+J, Ctrl+U
  document.addEventListener('keydown', e => {
    if(e.key === 'F12' ||
      (e.ctrlKey && e.shiftKey && ['I','J','C'].includes(e.key.toUpperCase())) ||
      (e.ctrlKey && e.key.toUpperCase() === 'U')){
      e.preventDefault();
      e.stopPropagation();
      return false;
    }
  });
})();
