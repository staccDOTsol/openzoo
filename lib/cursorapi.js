/**
 * ANSWER api2.cursor.sh OURSELVES — so a plan-less account can still route.
 *
 * WHY THIS EXISTS. Every config-level trick hit the same wall: the editor decides
 * client-side whether a model may be used, and that decision comes from its own
 * backend. On an entitled account the custom OpenAI endpoint works (measured: two
 * Solana settlements). On a plan-less one the editor refuses before a request
 * exists — "NOT ROUTING, 0 requests" — and nothing we write to its database can
 * reach that. Blackholing api2.cursor.sh stops the refusal but also stops the
 * catalog, which is why the picker collapses.
 *
 * So: instead of blackholing that host, SERVE it. /etc/hosts already points it at
 * 127.0.0.1; this is the thing that answers. We return the model catalog and the
 * entitlement fields ourselves, so the editor believes every model we publish is
 * available, and its inference still goes to the configured base URL — us.
 *
 * WIRE FORMAT, read out of the editor's own bundle (not guessed):
 *   POST /aiserver.v1.<Service>/<Method>, Connect-RPC, content-type
 *   application/proto (binary) or application/json.
 *   aiserver.v1.AvailableModelsResponse
 *     1 model_names  repeated string
 *     2 models       repeated AvailableModel
 *   AvailableModelsResponse.AvailableModel
 *     1 name string · 2 default_on bool · 5 supports_agent bool
 *     6 degradation_status enum(0=UNSPECIFIED) · 9 supports_thinking bool
 *     10 supports_images bool · 14 supports_max_mode bool
 *     19 supports_non_max_mode bool · 17 client_display_name string
 *     18 server_model_name string · 22 supports_plan_mode bool
 *
 * LIMITS, STATED PLAINLY: this impersonates a host the editor authenticates to,
 * so it needs a TLS cert the editor trusts (a local CA in the system store) and
 * it will break whenever the vendor changes their protobuf. It is opt-in.
 */

/** Minimal protobuf wire writer — enough for the two message shapes above. */
class Buf {
  constructor() { this.parts = []; }

  tag(field, wire) { return this.varint((field << 3) | wire); }

  varint(n) {
    const out = [];
    let v = Number(n);
    do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; out.push(b); } while (v);
    this.parts.push(Buffer.from(out));
    return this;
  }

  bool(field, v) { if (v === undefined) return this; this.tag(field, 0); return this.varint(v ? 1 : 0); }

  int(field, v) { if (v === undefined) return this; this.tag(field, 0); return this.varint(v); }

  str(field, v) {
    if (v === undefined || v === null) return this;
    const b = Buffer.from(String(v), 'utf8');
    this.tag(field, 2); this.varint(b.length); this.parts.push(b);
    return this;
  }

  msg(field, inner) {
    const b = inner.done();
    this.tag(field, 2); this.varint(b.length); this.parts.push(b);
    return this;
  }

  done() { return Buffer.concat(this.parts); }
}

/** One AvailableModel, with every gate answered in the affirmative. */
function encodeModel(m) {
  return new Buf()
    .str(1, m.name)
    .bool(2, true)                    // default_on
    .bool(5, true)                    // supports_agent
    .int(6, 0)                        // degradation_status = UNSPECIFIED
    .bool(9, true)                    // supports_thinking
    .bool(10, true)                   // supports_images
    .bool(14, true)                   // supports_max_mode  <- kills "Max Mode required"
    .bool(19, true)                   // supports_non_max_mode
    .int(15, m.contextTokenLimit ?? 200000)
    .str(17, m.label ?? m.name)       // client_display_name
    .str(18, m.name)                  // server_model_name
    .bool(21, true)                   // is_recommended_for_background_composer
    .bool(22, true);                  // supports_plan_mode
}

/** aiserver.v1.AvailableModelsResponse over the models we serve. */
export function encodeAvailableModels(models) {
  const b = new Buf();
  for (const m of models) b.str(1, m.name);          // model_names
  for (const m of models) b.msg(2, encodeModel(m));  // models
  return b.done();
}

/**
 * ENTITLEMENT RESPONSES. Measured from the backend log: once the transport works
 * (NODE_TLS_REJECT_UNAUTHORIZED=0), the editor calls a set of DashboardService/
 * AiService gRPC methods to decide the plan. Returning EMPTY reads as free tier —
 * the "upgrade" prompt. These populate the exact protobuf shapes (read from the
 * editor's own bundle) with an active pro plan and a real identity.
 */

// GetPlanInfoResponse{ 1 plan_info: PlanInfo{ 1 plan_name, 2 included_amount_cents, 5 plan_owner } }
export function encodeGetPlanInfo() {
  const planInfo = new Buf()
    .str(1, 'pro')          // plan_name
    .int(2, 99999900)       // included_amount_cents (huge headroom)
    .int(5, 1);             // plan_owner = PLAN_OWNER_STRIPE
  return new Buf().msg(1, planInfo).done();
}

// GetMeResponse{ 1 auth_id, 2 user_id, 3 email, 9 is_enterprise_user }
export function encodeGetMe() {
  return new Buf()
    .str(1, 'openzoo-user')
    .int(2, 1)
    .str(3, 'user@openzoo.local')
    .bool(9, false)
    .done();
}

// GetDefaultModelResponse{ 1 model, 2 thinking_model, 3 max_mode, 4 next_default_set_date }
export function encodeGetDefaultModel(models) {
  const m = (models && models[0] && models[0].name) || 'gpt-4o';
  return new Buf().str(1, m).str(2, m).bool(3, false).str(4, '').done();
}

// IsOnNewPricingResponse{ 1 is_on_new_pricing, 2 is_opted_out, 3 has_auto_spillover, 5 ... }
export function encodeIsOnNewPricing() {
  return new Buf().bool(1, false).bool(2, false).bool(3, false).bool(5, false).done();
}

/**
 * BYOK, forced on.
 *
 * Grok Bot (com.anysphere.sand) is Anysphere's app on the SAME aiserver.v1 API
 * Cursor uses, and BYOK there is a SERVER-DELIVERED FLAG, not a local setting:
 * the settings message carries `byok_enabled` at field 14 and `byok_disabled`
 * at field 19 (read from the app bundle). The empty-protobuf default this
 * server returns for unknown methods decodes byok_enabled = false, so BYOK
 * stays hidden unless we say otherwise.
 *
 * UNVERIFIED, AND IT MATTERS: flipping this reveals the BYOK surface, but the
 * ByokEntry message is only { enabled, models[] } — it has NO base_url field.
 * So this may only let you supply an xAI key (still billing xAI) rather than
 * redirect inference to the zoo. Run with OPENZOO_LOG_METHODS=1 and watch
 * whether StreamChat starts arriving here before trusting it.
 */
export function encodeByokConfig() {
  return new Buf()
    .bool(14, true)    // byok_enabled
    .bool(19, false)   // byok_disabled (admin kill-switch)
    .done();
}

/**
 * The bare proto body for a method, or null to fall through to empty-ok.
 * Only the methods that gate entitlement or the model list are populated.
 */
export function encodeForMethod(method, models) {
  // Any settings/config-shaped method carries the feature flags; answering the
  // wrong one is harmless (extra fields are ignored by proto), answering none
  // leaves BYOK off.
  if (process.env.OPENZOO_BYOK === '1' && /Config|Settings|FeatureFlags/i.test(method)) {
    return encodeByokConfig();
  }
  switch (method) {
    case 'AvailableModels': return encodeAvailableModels(models);
    case 'EnsureSandBox': {
      // HIJACK: hand Grok Bot OUR box instead of a cursorvm.com pod. The
      // orchestrator (openzoo grokbot) sets OZ_HIJACK_POD = {base,podId,token}
      // once its RunPod box is ready. Absent -> fall through to empty-ok, i.e.
      // the app gets no sandbox (harmless, and how sniff mode behaves).
      if (!process.env.OZ_HIJACK_POD) return null;
      try {
        const pod = JSON.parse(process.env.OZ_HIJACK_POD);
        return encodeEnsureSandBox(pod);
      } catch { return null; }
    }
    case 'GetGrokBotSendStatus':
      // Empty body decodes status=UNSPECIFIED → UI "Failed to send".
      // ACCEPTED=2 (aiserver.v1.GrokBotSendStatus). echo_entry_id (field 2)
      // must echo the request's message_id or the overlay never reconciles.
      return encodeGetGrokBotSendStatus();
    case 'GetPlanInfo': return encodeGetPlanInfo();
    case 'GetMe': return encodeGetMe();
    case 'GetDefaultModel': return encodeGetDefaultModel(models);
    case 'IsOnNewPricing': return encodeIsOnNewPricing();
    default: return null;
  }
}

/** Connect unary framing: 5-byte prefix (flags + big-endian length) + payload. */
/**
 * EnsureSandBox response — OUR pod, in Cursor's exact shape.
 *
 * Field map decoded from a live cursorvm.com response (2026-08-16):
 *   1 region · 2 accountId · 3 podId · 4 network_token · 5 "local"
 *   6 AGENT url (port 1337) · 7 VNC url (6080/vnc.html?...) · 8 /workspace/terminals
 *   9 ready=1 · 10 url (1340) · 11 token · 12 url (6081)
 *
 * We keep 1-5,8,9,11 plausible and repoint 6/7/10/12 at a box WE control, so
 * Grok Bot's UI connects to our sandbox instead of Cursor's. The RunPod proxy
 * fronts one port; we map the agent port there and the app's own path suffixes
 * (`/vnc.html`, the websockify query) ride along unchanged.
 *
 * HONEST LIMIT: the app will then speak Cursor's in-pod agent protocol to
 * field-6 and expect a VNC desktop at field-7. Our box must actually serve
 * those. This encoder is the redirect; whether the box satisfies the protocol
 * is a separate, unfinished problem — point it at a logging box first.
 */
/** GetGrokBotSendStatusResponse { status=ACCEPTED, echo_entry_id, accepted_at_ms } */
export function encodeGetGrokBotSendStatus(echoId = `oz-${Date.now()}`) {
  return new Buf()
    .int(1, 2)                 // GROK_BOT_SEND_STATUS_ACCEPTED
    .str(2, echoId)
    .int(4, Date.now())
    .done();
}

/** Strip Connect-RPC 5-byte envelope if present (flags=0, big-endian length). */
export function unwrapConnect(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  if (b.length >= 5 && (b[0] === 0 || b[0] === 2)) {
    const n = b.readUInt32BE(1);
    if (n > 0 && 5 + n <= b.length) return b.subarray(5, 5 + n);
  }
  return b;
}

/** Bare protobuf → {fieldNumber: string|number}. Enough for GetGrokBotSendStatusRequest
 *  {1 agent_id, 2 message_id} (measured body=76b = two uuid strings). */
export function decodeProtoFields(buf) {
  const b = unwrapConnect(buf);
  const out = {};
  let i = 0;
  while (i < b.length) {
    let key = 0;
    let shift = 0;
    while (i < b.length) {
      const v = b[i++];
      key |= (v & 0x7f) << shift;
      if (!(v & 0x80)) break;
      shift += 7;
      if (shift > 28) return out;
    }
    const field = key >>> 3;
    const wire = key & 7;
    if (wire === 0) {
      let n = 0;
      shift = 0;
      while (i < b.length) {
        const v = b[i++];
        n |= (v & 0x7f) << shift;
        if (!(v & 0x80)) break;
        shift += 7;
      }
      out[field] = n;
    } else if (wire === 2) {
      let len = 0;
      shift = 0;
      while (i < b.length) {
        const v = b[i++];
        len |= (v & 0x7f) << shift;
        if (!(v & 0x80)) break;
        shift += 7;
      }
      if (i + len > b.length) break;
      out[field] = b.subarray(i, i + len).toString('utf8');
      i += len;
    } else {
      break;
    }
  }
  return out;
}

export function encodeEnsureSandBox({ region = 'us1', accountId, podId, token, accessToken, agent, vnc, vncPath, p1340, p6081 }) {
  // per-port URLs — field 6 is the agent (1337), field 7 the VNC desktop
  // (6080), matching the live cursorvm response. RunPod fronts each port at
  // https://<id>-<port>.proxy.runpod.net, so agent !== vnc.
  // Field 4 = network_token (nto-…); field 11 = agent HTTP bearer. Mixing
  // them 401s /api/* on the real pod (measured sniff 2026-08-29).
  const auth = accessToken || token;
  const vncUrl = vncPath || `${vnc}/vnc.html?network_token=${token}&resume_lower_s=900&resume_upper_s=18000&path=websockify%3Fnetwork_token%3D${token}`;
  return new Buf()
    .str(1, region)
    .str(2, accountId)
    .str(3, podId)
    .str(4, token)
    .str(5, 'local')
    .str(6, agent)
    .str(7, vncUrl)
    .str(8, '/workspace/terminals')
    .int(9, 1)
    .str(10, p1340 || agent)
    .str(11, auth)
    .str(12, p6081 || vnc)
    .done();
}

export function connectFrame(payload) {
  const head = Buffer.alloc(5);
  head.writeUInt8(0, 0);
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

/**
 * Fake Cursor login. Grok Bot polls GET /auth/poll until the JSON has
 * accessToken + refreshToken (asar SandBackendLoginManager.waitForResult).
 * empty-ok `{}` is a 200 without those keys → login fails → "Log in with Cursor".
 * accessToken is JWT-decoded for sub/email/exp (createLoggedInStatus).
 */
export function fakeCursorJwt({
  sub = 'openzoo-user',
  email = 'user@openzoo.local',
  name = 'openzoo',
  now = Math.floor(Date.now() / 1000),
} = {}) {
  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({
    sub, email, name, exp: now + 365 * 86400, iat: now,
  })}.oz`;
}

export function fakeCursorTokens() {
  const accessToken = fakeCursorJwt();
  const refreshToken = fakeCursorJwt();
  return { accessToken, refreshToken, authId: 'openzoo-user' };
}

const LOGIN_DEEP_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>openzoo</title></head>
<body data-component="oz-fake-login">
  <p data-feature="lede">openzoo — logged in. You can close this tab.</p>
  <script>try { window.close(); } catch (e) {}</script>
</body></html>
`;

/** Path without query. Returns a reply descriptor or null. */
export function fakeCursorAuthReply(urlPath, { passthrough = false } = {}) {
  if (passthrough) return null;
  const path0 = String(urlPath || '').split('?')[0];
  const tok = fakeCursorTokens();
  if (path0 === '/auth/poll') {
    return { kind: 'poll', contentType: 'application/json', body: JSON.stringify(tok) };
  }
  if (path0 === '/oauth/token') {
    return {
      kind: 'oauth',
      contentType: 'application/json',
      body: JSON.stringify({
        access_token: tok.accessToken,
        refresh_token: tok.refreshToken,
        token_type: 'Bearer',
        expires_in: 365 * 86400,
      }),
    };
  }
  if (path0 === '/loginDeepControl') {
    return { kind: 'login-page', contentType: 'text/html; charset=utf-8', body: LOGIN_DEEP_HTML };
  }
  return null;
}
