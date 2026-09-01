/* Injected into the Grok Bot renderer so it can boot in a normal browser.
   window.desktop matches the Electron preload surface; coordinatorPort is a
   MessagePort lookalike over WebSocket to the local hijack. */
(function ozWebShim() {
  'use strict';
  function ozReport(payload) {
    try {
      fetch('/oz-crash', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ t: Date.now(), ...payload }),
        keepalive: true,
      }).catch(() => {});
    } catch { /* */ }
    try { console.error('[oz-web]', payload); } catch { /* */ }
  }
  window.addEventListener('error', (e) => {
    ozReport({
      type: 'error',
      message: e.message,
      filename: e.filename,
      lineno: e.lineno,
      colno: e.colno,
      stack: e.error && e.error.stack,
    });
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    ozReport({
      type: 'unhandledrejection',
      message: r && r.message ? r.message : String(r),
      stack: r && r.stack,
    });
  });
  const _err = console.error.bind(console);
  let ozReporting = false;
  console.error = function ozConsoleError(...args) {
    if (!ozReporting) {
      ozReporting = true;
      try {
        const first = args[0];
        if (!(typeof first === 'string' && first.startsWith('[oz-web]'))) {
          ozReport({
            type: 'console.error',
            message: args.map((a) => {
              if (a instanceof Error) return (a.stack || a.message);
              try { return typeof a === 'string' ? a : JSON.stringify(a); } catch { return String(a); }
            }).join(' '),
          });
        }
      } catch { /* */ }
      ozReporting = false;
    }
    return _err(...args);
  };
  const ozStaged = new Map();
  function ozAsU8(bytes) {
    if (!bytes) return new Uint8Array();
    if (bytes instanceof Uint8Array) return bytes;
    if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
    if (Array.isArray(bytes)) return Uint8Array.from(bytes);
    if (typeof bytes === 'object' && bytes.length != null) {
      return Uint8Array.from({ length: Number(bytes.length) }, (_, i) => bytes[i] & 255);
    }
    return new Uint8Array();
  }
  function ozU8ToB64(u8) {
    const bytes = ozAsU8(u8);
    let bin = '';
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
    }
    return btoa(bin);
  }
  function ozMimeFromBytes(u8, name) {
    const b = ozAsU8(u8);
    const n = String(name || '').toLowerCase();
    if (n.endsWith('.png')) return 'image/png';
    if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg';
    if (n.endsWith('.gif')) return 'image/gif';
    if (n.endsWith('.webp')) return 'image/webp';
    if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
    return null;
  }
  const unsub = () => () => {};
  const persist = {
    async read(key) {
      try { return localStorage.getItem('sand.p.' + key); } catch { return null; }
    },
    async write(key, value) {
      try { localStorage.setItem('sand.p.' + key, String(value ?? '')); } catch { /* */ }
    },
    async remove(key) {
      try { localStorage.removeItem('sand.p.' + key); } catch { /* */ }
    },
    async listKeys(prefix) {
      const p = 'sand.p.' + String(prefix || '');
      const out = [];
      try {
        for (let i = 0; i < localStorage.length; i += 1) {
          const k = localStorage.key(i);
          if (k && k.startsWith(p)) out.push(k.slice('sand.p.'.length));
        }
      } catch { /* */ }
      return out;
    },
    async migrateFromLocalStorage(entries) {
      for (const e of entries || []) {
        if (e && e.key != null) await persist.write(String(e.key).replace(/^sand\.p\./, ''), e.value);
      }
      return true;
    },
  };

  const ACCOUNT = { accountId: 'openzoo', displayName: 'openzoo', email: 'openzoo@local' };
  const AUTH = {
    kind: 'logged-in',
    authId: 'openzoo',
    email: 'openzoo@local',
    displayName: 'openzoo',
    expiresAt: Date.now() + 365 * 86400 * 1000,
    profilePictureUrl: null,
    isAnysphereUser: true,
    accounts: [ACCOUNT],
  };
  const ACCESS = { state: 'granted', reason: 'none' };
  const THEME = { preference: 'dark', resolved: 'dark' };
  const LANGUAGE = { preference: 'system', resolved: 'en' };
  const EGRESS = { state: 'off', relayedStreams: 0, activeStreams: 0 };
  const UPDATE = {
    state: { type: 'disabled', reason: 'not-packaged' },
    currentVersion: '0.30.0',
    currentTrack: 'stable',
    trackOverride: null,
    buildDefaultTrack: null,
    availableTracks: ['stable'],
    isTrackManagedByPolicy: false,
    isBelowMinimumVersion: false,
    autoUpdateWhenIdleOptIn: false,
    autoUpdateWhenIdleGateEnabled: false,
  };
  const DEFAULT_MODEL = { modelId: 'x-ai/grok-4.6', maxMode: true, parameters: [] };
  let defaultModel = DEFAULT_MODEL;
  try {
    const raw = localStorage.getItem('sand.p.default-model');
    if (raw) defaultModel = JSON.parse(raw);
  } catch { /* */ }

  const plat = /Mac/i.test(navigator.platform || navigator.userAgent) ? 'darwin'
    : /Win/i.test(navigator.platform || navigator.userAgent) ? 'win32'
      : /Linux/i.test(navigator.userAgent) ? 'linux' : 'other';

  const desktop = {
    platform: plat,
    isDev: false,
    getZoomFactor: () => 1,
    storage: window.localStorage,
    capability: { agent: { clientPersistence: persist } },
    theme: {
      initial: THEME,
      get: async () => THEME,
      set: async (preference) => ({ preference, resolved: preference === 'light' ? 'light' : 'dark' }),
      onChanged: unsub,
    },
    language: {
      initial: LANGUAGE,
      get: async () => LANGUAGE,
      set: async (preference) => ({ preference, resolved: 'en' }),
      onChanged: unsub,
    },
    experiments: {
      initialSnapshot: {},
      getSnapshot: async () => ({}),
      applyFeatureFlagOverride: async () => {},
      refresh: async () => {},
      startRpcTraceWindow: async () => false,
      onChanged: unsub,
    },
    assistiveTech: { initial: false, onChanged: unsub },
    foreverBox: {
      forceRecreate: async () => ({ ok: true }),
      update: async () => ({ ok: true }),
      upgradeSchedule: {
        get: async () => null,
        schedule: async () => ({ ok: true }),
        reschedule: async () => ({ ok: true }),
        cancel: async () => ({ ok: true }),
      },
      egressTunnel: {
        initial: false,
        initialStatus: EGRESS,
        get: async () => false,
        set: async () => false,
        getStatus: async () => EGRESS,
        onChanged: unsub,
        onStatusChanged: unsub,
      },
      webauthnProxy: {
        initial: false,
        get: async () => false,
        set: async () => false,
        onChanged: unsub,
      },
      onUpdateDispatched: unsub,
      onVncUserPresence: unsub,
      onDevBoxPullProgress: unsub,
    },
    windowControls: {
      minimize: async () => {},
      toggleMaximize: async () => {},
      close: async () => {},
      setTitleBarOverlayTone: async () => {},
      resizeWidth: async () => ({ ok: true }),
    },
    onboarding: {
      getSeen: async () => true,
      setSeen: async () => {},
      onSkip: unsub,
    },
    timeZone: {
      get: async () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      setOverride: async () => {},
    },
    hardwareAcceleration: {
      get: async () => ({ enabled: true }),
      setEnabled: async () => ({ enabled: true }),
      relaunch: async () => {},
    },
    notificationPreferences: {
      get: async () => ({ sound: 'ping-1-open-blip', playSound: false }),
      set: async (preferences) => preferences,
    },
    autoReviewInstructions: {
      get: async () => ({ isEnabled: false, allowInstructions: [], blockInstructions: [] }),
      set: async (instructions) => instructions,
    },
    localToolPermission: {
      get: async () => 'always',
      set: async () => 'always',
      ceiling: async () => 'always',
      recordApproval: async () => {},
      clearApprovals: async () => {},
    },
    secrets: {
      list: async () => [],
      reveal: async () => null,
      upsert: async () => ({ ok: true }),
      remove: async () => ({ ok: true }),
    },
    update: {
      getStatus: async () => UPDATE,
      check: async () => UPDATE,
      setTrack: async () => UPDATE,
      quitAndInstall: async () => ({ ok: false }),
      setAutoUpdateWhenIdleOptIn: async () => {},
      onStatusEvent: unsub,
    },
    telemetry: {
      reportTurnClientStart() {},
      reportTurnClientOutcome() {},
      reportAgentLoad() {},
      reportAccessBlocked() {},
      reportAgentsUnreachable() {},
      reportRecoveryAction() {},
      reportRebuildLifecycle() {},
      reportReconciliation() {},
      reportBoxVisibility() {},
      reportSendLatency() {},
      reportHeapMetrics() {},
      reportSendAck() {},
      reportReactionAck() {},
      reportRenderTtfr() {},
      reportRenderStream() {},
      reportVncSession() {},
      reportVncLiveness() {},
      reportOpenComputer() {},
      reportUpdatePrompt() {},
      reportSigninGate() {},
      reportOnboardingStep() {},
      reportOnboardingCompleted() {},
      reportClientFailure() {},
      noteSentryConversation() {},
    },
    agent: {
      getPinnedAgents: async () => [],
      setPinnedAgents: async () => [],
      getSidebarSections: async () => [],
      setSidebarSections: async () => [],
      getDefaultModel: async () => defaultModel,
      setDefaultModel: async (model) => {
        defaultModel = model || defaultModel;
        try { localStorage.setItem('sand.p.default-model', JSON.stringify(defaultModel)); } catch { /* */ }
        return defaultModel;
      },
      getComputerUseModel: async () => null,
      setComputerUseModel: async () => null,
      getAvailableModels: async () => ({
        models: [
          { modelId: 'x-ai/grok-4.6', maxMode: true, parameters: [] },
          { modelId: 'x-ai/grok-4.5', maxMode: true, parameters: [] },
        ],
      }),
      readTranscriptStoreTail: async () => ({ entries: [] }),
      getPublicBotTemplate: async () => null,
      listPublicBotMarketplace: async () => [],
      getGrokBotSlackInstallState: async () => ({ installed: false }),
      startGrokBotSlackConnect: async () => ({ ok: false }),
      installGrokBotSlackApp: async () => ({ ok: false }),
      reinstallGrokBotSlackApp: async () => ({ ok: false }),
      uninstallGrokBotSlackApp: async () => ({ ok: true }),
      listGrokBotTeamAgents: async () => [],
      setGrokBotAgentVisibility: async () => ({ ok: true }),
      setGrokBotAgentSidebarHidden: async () => {},
      clientPersistence: persist,
    },
    mcp: {
      list: async () => ({ servers: [] }),
      effectivePlugins: async () => [],
      catalog: async () => [],
      teamPopularity: async () => ({}),
      pluginLogo: async () => null,
      install: async () => ({ ok: false }),
      updatePluginInstall: async () => ({ ok: false }),
      remove: async () => ({ ok: true }),
      uninstallPlugin: async () => ({ ok: true }),
      authenticate: async () => ({ ok: false }),
      renameAccount: async () => ({ ok: true }),
      removeAccount: async () => ({ ok: true }),
      setCustomInstructions: async () => ({ ok: true }),
      listServerTools: async () => [],
      toggleToolDisabled: async () => [],
      onAuthCompleted: unsub,
    },
    cursorAccount: {
      getStatus: async () => AUTH,
      login: async () => AUTH,
      addAccount: async () => AUTH,
      listAccounts: async () => ({ accounts: [ACCOUNT] }),
      switchAccount: async () => AUTH,
      removeAccount: async () => ({ ok: true }),
      getLoginFlight: async () => ({ kind: 'idle' }),
      cancelLoginFlight: async () => ({ kind: 'idle' }),
      logout: async () => ({ kind: 'logged-out' }),
      updateName: async () => AUTH,
      getAvatar: async () => null,
      getMachines: async () => [],
      updateMachineLabel: async () => ({ ok: true }),
      getWeeklyUsage: async () => ({}),
      getUsageSummary: async () => ({ includedUsageKind: 'weekly', planId: null }),
      getEnterpriseUsage: async () => ({}),
      getPrReviewPreferences: async () => ({}),
      getPrivacyModeEnabled: async () => false,
      getSandAccess: async () => ACCESS,
      getSandAccessFresh: async () => ACCESS,
      mintVoiceCallCredential: async () => ({ ok: false }),
      invokeDashboardAction: async () => ({ ok: false }),
      cancelTrial: async () => ({ ok: true }),
      setSpendLimit: async () => ({ ok: true }),
      getSelectedTeam: async () => ({ selectedTeamId: null, fallback: null }),
      listTeamMemberships: async () => [],
      checkTeamAccess: async () => ({ ok: true }),
      selectTeam: async () => ({ ok: true }),
      ackTeamFallback: async () => {},
      onStatusChanged: unsub,
      onLoginFlightChanged: unsub,
      onSelectedTeamChanged: unsub,
    },
    async openExternal(url) {
      try { window.open(String(url), '_blank', 'noopener'); } catch { /* */ }
    },
    async submitFeedback() { return { ok: true }; },
    async openCloudAgent() {},
    async getWindowState() {
      return { isMaximized: false, isFullScreen: false, isMinimized: false, isVisible: true, isFocused: document.hasFocus() };
    },
    async getBoxMigrationStatus() {
      return { operationId: null, phase: 'done', detail: '' };
    },
    async deepLinksReady() {},
    async forceGatewayReconnect() {},
    async pickAvatarSource() { return null; },
    async pickAvatarFile() { return null; },
    async generateAgentAvatarImage() { return { dataUrl: null }; },
    async resolveAttachmentMedia({ source } = {}) {
      const rec = ozStaged.get(source);
      if (!rec) return null;
      const mime = ozMimeFromBytes(rec.bytes, rec.filename);
      if (!mime) return null;
      return { kind: 'image', dataUrl: `data:${mime};base64,${ozU8ToB64(rec.bytes)}`, width: null, height: null };
    },
    async readAttachmentText({ path } = {}) {
      const rec = ozStaged.get(path);
      if (!rec) return { text: '' };
      return { text: new TextDecoder().decode(rec.bytes) };
    },
    async readAttachmentBytes({ path, maxBytes } = {}) {
      const rec = ozStaged.get(path);
      if (!rec) return new Uint8Array();
      const n = typeof maxBytes === 'number' && maxBytes > 0 ? maxBytes : rec.bytes.length;
      return rec.bytes.slice(0, n);
    },
    async downloadAttachment() { return { ok: false }; },
    async getLinkMetadata() { return null; },
    async stageAttachmentBytes({ filename, bytes } = {}) {
      const buf = ozAsU8(bytes);
      if (!buf.byteLength) return { ok: false, reason: 'failed' };
      if (buf.byteLength > 20 * 1024 * 1024) return { ok: false, reason: 'too-large' };
      const name = String(filename || 'image.png') || 'image.png';
      const id = (globalThis.crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      const stagedPath = `oz-stage-${id}-${name.replace(/[^\w.\-]+/g, '_')}`;
      ozStaged.set(stagedPath, { filename: name, bytes: buf });
      return { ok: true, path: stagedPath };
    },
    async commitStagedAttachments({ paths, filenames } = {}) {
      const ps = Array.isArray(paths) ? paths : [];
      const ns = Array.isArray(filenames) ? filenames : [];
      const out = [];
      for (let i = 0; i < ps.length; i += 1) {
        const p = ps[i];
        const rec = ozStaged.get(p);
        if (!rec) {
          if (typeof p === 'string' && p.startsWith('/openzoo-uploads/')) {
            out.push(p);
            continue;
          }
          return null;
        }
        try {
          const r = await fetch('/oz-upload', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({
              filename: ns[i] || rec.filename,
              bytesBase64: ozU8ToB64(rec.bytes),
            }),
          });
          const j = await r.json();
          if (!r.ok || !j || !j.path) return null;
          out.push(j.path);
          ozStaged.delete(p);
        } catch {
          return null;
        }
      }
      return out;
    },
    async discardStagedAttachment({ path } = {}) {
      ozStaged.delete(path);
    },
    async transcribeAudio() { return { text: '' }; },
    onFocusAgent: unsub,
    onDeepLink: unsub,
    onBoxMigration: unsub,
    onDevBoxRebuild: unsub,
    onOpenFeedback: unsub,
    onOpenAbout: unsub,
    onOpenSettings: unsub,
    onWidgetGallery: unsub,
    onForceOnboarding: unsub,
    onWindowStateEvent: unsub,
    onZoomFactorEvent: unsub,
    onNotificationSound: unsub,
  };

  window.desktop = desktop;

  const OZ_PALETTE = window.__OZ_WHO_PALETTE__ && typeof window.__OZ_WHO_PALETTE__ === 'object'
    ? window.__OZ_WHO_PALETTE__
    : {};
  if (!window.__OZ_WHO__) {
    try {
      fetch('/oz-who', { credentials: 'same-origin' })
        .then((r) => r.ok ? r.json() : null)
        .then((j) => { if (j && j.shortname) window.__OZ_WHO__ = j; })
        .catch(() => {});
    } catch { /* */ }
  }
  function ozEnsureChipCss() {
    if (document.getElementById('oz-who-chip-css')) return;
    const s = document.createElement('style');
    s.id = 'oz-who-chip-css';
    s.textContent = [
      '.oz-who-chip{position:relative;color:inherit;',
      'box-shadow:0 0 0 2px var(--oz-who,#3db8e8);border-radius:999px;',
      'background:color-mix(in srgb,var(--oz-who,#3db8e8) 20%,transparent)}',
      '.oz-who-chip::after{content:"";position:absolute;top:-4px;right:-4px;width:9px;height:9px;border-radius:50%;',
      'background:var(--oz-who,#3db8e8);box-shadow:0 0 0 2px #141414;pointer-events:none}',
    ].join('');
    (document.head || document.documentElement).appendChild(s);
  }
  function ozNameRe() {
    const keys = Object.keys(OZ_PALETTE).filter((k) => /^[a-z][a-z0-9]{1,15}$/.test(k));
    if (!keys.length) return null;
    return new RegExp('^(' + keys.join('|') + '):\\s');
  }
  function ozLooksLikeSpend(t) {
    return /this call \$|OpenRouter would|proves x402|memo x402|spent \$|::oz-spend::/i.test(String(t || ''));
  }
  function ozInnermostName(el, re) {
    const text = String(el.textContent || '').trim();
    if (text.length > 280 || ozLooksLikeSpend(text)) return null;
    const m = text.match(re);
    if (!m) return null;
    for (let i = 0; i < el.children.length; i += 1) {
      if (ozInnermostName(el.children[i], re)) return null;
    }
    return m[1];
  }
  function ozUserChip(el) {
    let cur = el;
    let best = el;
    for (let i = 0; i < 8 && cur && cur !== document.body; i += 1) {
      const r = cur.getBoundingClientRect();
      if (!r.width || r.width > 480 || r.height > 140) break;
      const t = String(cur.textContent || '').trim();
      if (t.length > 280 || ozLooksLikeSpend(t)) break;
      best = cur;
      cur = cur.parentElement;
    }
    const r = best.getBoundingClientRect();
    if (r.width > 520 || r.height > 160 || r.width < 24) return null;
    if (r.left + r.width / 2 < window.innerWidth * 0.38) return null;
    let up = best;
    for (let i = 0; i < 10 && up; i += 1) {
      if (ozLooksLikeSpend(up.textContent)) return null;
      up = up.parentElement;
    }
    return best;
  }
  function ozRingChip(el, name) {
    const color = OZ_PALETTE[name];
    if (!color) return;
    const chip = ozUserChip(el);
    if (!chip) return;
    if (chip.dataset.ozWho === name) return;
    ozEnsureChipCss();
    chip.classList.add('oz-who-chip');
    chip.style.setProperty('--oz-who', color);
    chip.dataset.ozWho = name;
  }
  function ozScanChips() {
    const re = ozNameRe();
    if (!re || !document.body) return;
    const nodes = document.body.querySelectorAll('div, p, span');
    for (let i = 0; i < nodes.length; i += 1) {
      const name = ozInnermostName(nodes[i], re);
      if (name) ozRingChip(nodes[i], name);
    }
  }
  function ozWatchChips() {
    const run = () => { try { ozScanChips(); } catch { /* */ } };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
    else run();
    try {
      const mo = new MutationObserver(run);
      const start = () => {
        if (document.body) mo.observe(document.body, { childList: true, subtree: true });
      };
      if (document.body) start();
      else document.addEventListener('DOMContentLoaded', start);
    } catch { /* */ }
    setInterval(run, 2500);
  }
  ozWatchChips();
  /* spend chip IIFE is concatenated from lib/ozSpendChip.js */

  function ozIsPhone() {
    try {
      const w = window.innerWidth || 9999;
      const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
      const noHover = window.matchMedia && window.matchMedia('(hover: none)').matches;
      const mq = window.matchMedia && (
        window.matchMedia('(max-width: 900px)').matches
        || window.matchMedia('(max-width: 720px)').matches
      );
      return w <= 900 || !!coarse || !!noHover || !!mq;
    } catch {
      return (window.innerWidth || 0) <= 900;
    }
  }
  try {
    const syncNarrow = () => {
      document.documentElement.classList.toggle('oz-narrow', ozIsPhone());
      try { ozEnsureNewChatFab(); } catch { /* */ }
    };
    syncNarrow();
    window.addEventListener('resize', syncNarrow);
    try {
      const mq = window.matchMedia('(max-width: 900px), (pointer: coarse)');
      if (mq.addEventListener) mq.addEventListener('change', syncNarrow);
      else if (mq.addListener) mq.addListener(syncNarrow);
    } catch { /* */ }
  } catch { /* */ }

  function ozFindNewChat() {
    const labeled = document.querySelectorAll('button[aria-label="New chat"]');
    for (let i = 0; i < labeled.length; i += 1) {
      if (labeled[i].id !== 'oz-new-chat') return labeled[i];
    }
    const roots = document.querySelectorAll(
      '.sand-agents-sidebar__new-actions, .sand-agents-sidebar__rail-actions, .sand-agents-sidebar__header',
    );
    for (let i = 0; i < roots.length; i += 1) {
      const btns = roots[i].querySelectorAll('button');
      for (let b = 0; b < btns.length; b += 1) {
        if (btns[b].id === 'oz-new-chat') continue;
        const al = String(btns[b].getAttribute('aria-label') || '').toLowerCase();
        if (al === 'new chat') return btns[b];
      }
    }
    return null;
  }
  function ozBtnOnScreen(el) {
    if (!el || el.id === 'oz-new-chat') return false;
    try {
      const r = el.getBoundingClientRect();
      if (r.width < 16 || r.height < 16) return false;
      if (r.bottom < 4 || r.top > (window.innerHeight || 0) - 4) return false;
      if (r.right < 4 || r.left > (window.innerWidth || 0) - 4) return false;
      const st = window.getComputedStyle(el);
      if (!st) return true;
      if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
      return true;
    } catch {
      return false;
    }
  }
  function ozFireNewChat() {
    const real = ozFindNewChat();
    if (real) {
      try { real.click(); return; } catch { /* */ }
    }
    const init = {
      key: 'n',
      code: 'KeyN',
      keyCode: 78,
      which: 78,
      bubbles: true,
      cancelable: true,
    };
    try { document.dispatchEvent(new KeyboardEvent('keydown', { ...init, metaKey: true })); } catch { /* */ }
    try { document.dispatchEvent(new KeyboardEvent('keydown', { ...init, ctrlKey: true })); } catch { /* */ }
  }
  function ozEnsureNewChatFab() {
    const orig = ozFindNewChat();
    const origVisible = ozBtnOnScreen(orig);
    let fab = document.getElementById('oz-new-chat');
    if (origVisible) {
      if (fab) fab.hidden = true;
      return;
    }
    if (!fab) {
      if (!document.body) return;
      fab = document.createElement('button');
      fab.id = 'oz-new-chat';
      fab.type = 'button';
      fab.setAttribute('aria-label', 'New chat');
      fab.textContent = '+';
      let last = 0;
      const go = (ev) => {
        try { ev.preventDefault(); ev.stopPropagation(); } catch { /* */ }
        const now = Date.now();
        if (now - last < 400) return;
        last = now;
        ozFireNewChat();
      };
      fab.addEventListener('click', go);
      fab.addEventListener('pointerup', go);
      try { document.body.appendChild(fab); } catch { /* */ }
    }
    fab.hidden = false;
  }
  (function ozWatchNewChatFab() {
    const tick = () => { try { ozEnsureNewChatFab(); } catch { /* */ } };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tick);
    else tick();
    setInterval(tick, 800);
  }());

  function ozOpenTopConversation() {
    if (window.__ozTopOpened) return true;
    const selected = document.querySelector('[data-agent-id][data-selected="true"], [data-agent-id][data-active="true"]');
    if (selected) {
      window.__ozTopOpened = true;
      return true;
    }
    const first = document.querySelector('[data-agent-id]');
    if (!first) return false;
    window.__ozTopOpened = true;
    try { first.click(); } catch { window.__ozTopOpened = false; return false; }
    return true;
  }
  (function ozWatchTopConv() {
    const tick = () => { try { ozOpenTopConversation(); } catch { /* */ } };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tick);
    else tick();
    let n = 0;
    const iv = setInterval(() => {
      n += 1;
      if (ozOpenTopConversation() || n > 40) clearInterval(iv);
    }, 250);
    try {
      const mo = new MutationObserver(tick);
      const start = () => { if (document.body) mo.observe(document.body, { childList: true, subtree: true }); };
      if (document.body) start();
      else document.addEventListener('DOMContentLoaded', start);
    } catch { /* */ }
  }());

  function fakePort(ws) {
    const listeners = { message: new Set(), close: new Set() };
    ws.addEventListener('message', (ev) => {
      let data = ev.data;
      try { if (typeof data === 'string') data = JSON.parse(data); } catch { /* keep */ }
      for (const fn of listeners.message) {
        try { fn({ data }); } catch (err) { console.warn('[oz-web] port message handler', err); }
      }
    });
    ws.addEventListener('close', () => {
      for (const fn of listeners.close) {
        try { fn({}); } catch { /* */ }
      }
    });
    return {
      postMessage(data) {
        if (ws.readyState === 1) ws.send(JSON.stringify(data));
      },
      close() { try { ws.close(); } catch { /* */ } },
      start() {},
      addEventListener(type, fn) {
        if (listeners[type]) listeners[type].add(fn);
      },
    };
  }

  let claimed = null;
  window.coordinatorPort = {
    claim(handler) {
      if (claimed != null) return null;
      claimed = handler;
      return {
        request() {
          if (claimed !== handler) return;
          const proto = location.protocol === 'https:' ? 'wss' : 'ws';
          const ws = new WebSocket(`${proto}://${location.host}/oz-coord`);
          ws.addEventListener('open', () => {
            try { handler.onPort(fakePort(ws)); } catch (err) {
              console.warn('[oz-web] onPort failed', err);
            }
          });
          ws.addEventListener('error', () => {
            console.warn('[oz-web] coordinator websocket error');
          });
        },
        release() { if (claimed === handler) claimed = null; },
      };
    },
  };
}());
