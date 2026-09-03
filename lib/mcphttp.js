/**
 * MCP over Streamable HTTP, mounted on the proxy's own port at /mcp.
 *
 * WHY: `npx openzoo` should give a harness BOTH surfaces without a second
 * command — point base_url at /v1 for transparent context spilling, or add
 * /mcp for the tools (zoo_bind, zoo_ask, zoo_wallet...). Clients that spawn a
 * process still get stdio via `npx openzoo mcp`.
 *
 * Stateless on purpose: no session ids to track, no server-side state to
 * expire, and any client that reconnects just works. The MCP server object
 * itself is built once and reused across requests.
 */
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildMcpServer } from './mcp.js';

let ready = null;

async function ensure() {
  if (!ready) {
    ready = (async () => {
      const { server, client } = buildMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
        enableJsonResponse: true,
      });
      await server.connect(transport);
      return { transport, client };
    })();
  }
  return ready;
}

/** Read and JSON-parse a request body. MCP posts are small. */
function readJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(undefined);
      try { resolve(JSON.parse(raw)); } catch { resolve(undefined); }
    });
    req.on('error', () => resolve(undefined));
  });
}

export async function handleMcpRequest(req, res) {
  const { transport } = await ensure();
  const body = req.method === 'POST' ? await readJson(req) : undefined;
  await transport.handleRequest(req, res, body);
}
