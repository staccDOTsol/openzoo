/* OpenZoo box — focus Cline, keep the keyboard above chrome, hamburger for files. */
(function ozMobile() {
  if (window.__ozMobileInit) return;
  window.__ozMobileInit = true;

  const VIEWPORT = 'width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content';

  // First-party /login#ozp=<password>: iOS Agent iframes the runpod origin.
  // A zoo.openzoo.fun parent cannot fill this form (ITP / cross-origin).
  function readOzp() {
    const raw = String((typeof location !== 'undefined' && location.hash) || '');
    if (!raw) return '';
    const body = raw.charAt(0) === '#' ? raw.slice(1) : raw;
    const parts = body.split('&');
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const eq = part.indexOf('=');
      const key = eq === -1 ? part : part.slice(0, eq);
      if (key !== 'ozp') continue;
      const enc = eq === -1 ? '' : part.slice(eq + 1);
      if (!enc) return '';
      try { return decodeURIComponent(enc); } catch { return enc; }
    }
    return '';
  }

  function passwordField() {
    return document.querySelector('input[type="password"], #password, input[name="password"]');
  }

  function stripOzpHash() {
    try {
      const path = (location.pathname || '/') + (location.search || '');
      history.replaceState(history.state, '', path);
    } catch { /* ignore */ }
  }

  function submitLogin(form) {
    try {
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.submit();
    } catch {
      try { form.submit(); } catch { /* ignore */ }
    }
  }

  function tryEnter() {
    if (window.__ozEnter) return;
    const pass = readOzp();
    if (!pass) return;
    const field = passwordField();
    if (!field) return;
    window.__ozEnter = true;
    field.value = pass;
    try {
      if (typeof Event === 'function' && field.dispatchEvent) {
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } catch { /* ignore */ }
    const form = field.form || (field.closest && field.closest('form')) || document.querySelector('form');
    stripOzpHash();
    if (form) submitLogin(form);
  }

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
  tryEnter();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryEnter);
  }
})();
