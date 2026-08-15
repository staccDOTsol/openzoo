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
 * The bare proto body for a method, or null to fall through to empty-ok.
 * Only the methods that gate entitlement or the model list are populated.
 */
export function encodeForMethod(method, models) {
  switch (method) {
    case 'AvailableModels': return encodeAvailableModels(models);
    case 'GetPlanInfo': return encodeGetPlanInfo();
    case 'GetMe': return encodeGetMe();
    case 'GetDefaultModel': return encodeGetDefaultModel(models);
    case 'IsOnNewPricing': return encodeIsOnNewPricing();
    default: return null;
  }
}

/** Connect unary framing: 5-byte prefix (flags + big-endian length) + payload. */
export function connectFrame(payload) {
  const head = Buffer.alloc(5);
  head.writeUInt8(0, 0);
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}
