// Host-call and helper ids shared with runtime/zoo-host/src/vm.rs and helpers.rs.
export const hostIds = {
  req_method: 0, req_path: 1, req_url: 2, req_full_url: 3, req_query: 4, req_query_get: 5, req_headers: 6, req_header: 7,
  req_text: 8, req_body: 9, req_json: 10, res_status: 11, res_header: 12, res_json: 13, res_send: 14, res_end: 15,
  res_redirect: 16, env: 17, env_obj: 18, now_ms: 19, now_iso: 20, kv_get: 21, kv_exists: 22, kv_set: 23, kv_incrby: 24,
  kv_del: 25, slot: 26, payer_address: 27, program_address: 28,
};
export const helperIds = {
  cookies: 0, cookie_get: 1, cookie_has: 2, cookie_all: 3, header_has: 4, query_has: 5, query_get_all: 6, search: 7,
  assign: 8, omit: 9, from_entries: 10, array_from: 11, slice_from: 12, url: 13, num: 14, set_headers: 15,
};
