/* OpenZoo box — focus Cline, keep the keyboard above chrome, hamburger for files. */
(function ozMobile() {
  if (window.__ozMobileInit) return;
  window.__ozMobileInit = true;

  const VIEWPORT = 'width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content';

  function ensureViewport() {
    let meta = document.querySelector('meta[name="viewport"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'viewport');
      document.head.appendChild(meta);
    }
    meta.setAttribute('content', VIEWPORT);
  }

  function ensureToggle() {
    if (document.getElementById('oz-chrome-toggle')) return;
    const b = document.createElement('button');
    b.id = 'oz-chrome-toggle';
    b.type = 'button';
    b.setAttribute('aria-label', 'Files and editor');
    b.setAttribute('aria-pressed', 'false');
    b.textContent = '☰';
    b.addEventListener('click', function () {
      const on = document.documentElement.classList.toggle('oz-show-chrome');
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    (document.body || document.documentElement).appendChild(b);
  }

  function keepComposerVisible() {
    function lift() {
      const el = document.activeElement;
      if (!el) return;
      const tag = (el.tagName || '').toLowerCase();
      const typing = tag === 'textarea' || tag === 'input' || el.isContentEditable;
      if (!typing) return;
      try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch { /* old webkit */ }
    }
    document.addEventListener('focusin', lift, true);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', lift);
      window.visualViewport.addEventListener('scroll', lift);
    }
    try {
      if (navigator.virtualKeyboard) navigator.virtualKeyboard.overlaysContent = true;
    } catch { /* not supported */ }
  }

  ensureViewport();
  if (document.body) ensureToggle();
  else document.addEventListener('DOMContentLoaded', ensureToggle);
  keepComposerVisible();
})();
