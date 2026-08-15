/**
 * `npx openzoo cursor` / `npx openzoo vscode` — wire a GUI editor to the zoo.
 *
 * WHY THIS IS NOT `launch`: Cursor and VS Code are GUI apps, not processes you
 * hand env vars to. `openzoo launch <cmd>` works for terminal harnesses (claude,
 * aider) because they read ANTHROPIC_BASE_URL/OPENAI_BASE_URL at startup. An
 * editor reads its own config instead, and Cursor keeps the provider base-URL +
 * key in an ENCRYPTED internal store that no CLI can write — that half stays a
 * GUI toggle. So this command does the half that IS automatable (MCP server
 * registration, which is plain JSON) and prints the exact values to paste for
 * the half that is not, instead of pretending it did everything.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from './config.js';

const CURSOR_MCP = path.join(os.homedir(), '.cursor', 'mcp.json');
const VSCODE_MCP = path.join(os.homedir(), '.vscode', 'mcp.json');

/** Merge our server into an existing mcp.json without clobbering the user's. */
function addMcpServer(file) {
  let doc = {};
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { doc = {}; }
  const key = doc.mcpServers ? 'mcpServers' : (doc.servers ? 'servers' : 'mcpServers');
  doc[key] = doc[key] || {};
  const existed = Boolean(doc[key].openzoo);
  doc[key].openzoo = { command: 'npx', args: ['-y', 'openzoo@latest', 'mcp'] };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  return { file, existed };
}

export function setupEditor(which = 'cursor') {
  const base = `http://localhost:${config.port}/v1`;
  const file = which === 'vscode' ? VSCODE_MCP : CURSOR_MCP;
  const { existed } = addMcpServer(file);

  console.log(`openzoo → ${which}`);
  console.log('');
  console.log(`1. MCP: ${existed ? 'updated' : 'added'} "openzoo" in ${file}`);
  console.log('   tools: zoo_bind, zoo_ask, zoo_models, zoo_wallet, zoo_contexts');
  console.log('   (restart the editor to pick it up)');
  console.log('');
  console.log('2. Model routing — paste these into the editor\'s AI settings.');
  console.log('   Cursor keeps provider settings in an encrypted store, so this');
  console.log('   part cannot be scripted; it is two fields:');
  console.log('');
  console.log(`     Override OpenAI Base URL :  ${base}`);
  console.log('     OpenAI API Key           :  sk-openzoo   (any value; x402 pays, not keys)');
  console.log('');
  console.log('   Then add a model the zoo serves (Cursor validates the name):');
  console.log('     deepseek/deepseek-v4-pro-0813   ← cheap, stateless tools, recommended');
  console.log('     openai/gpt-5.6-sol-pro          ← flagship, ~34x the output cost');
  console.log('   Turn OFF the built-in models (Composer/GPT/Cursor-Grok) while the');
  console.log('   override is on — those only resolve against Cursor\'s own backend.');
  console.log('');
  console.log(`3. Proxy: ${base}   (start with: npx openzoo)`);
  console.log('');

  // OPEN THE EDITOR. The whole point of `openzoo cursor` is to end up IN the
  // editor — printing instructions and exiting made the user do the launching
  // themselves. Env vars are set for the child so any terminal the editor
  // spawns inherits the zoo, and `open -a` is used on macOS because Cursor is
  // a GUI .app, not a binary on PATH.
  const env = {
    ...process.env,
    OPENAI_BASE_URL: base,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || 'sk-openzoo',
    ANTHROPIC_BASE_URL: base,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || 'sk-openzoo',
  };
  const app = which === 'vscode' ? 'Visual Studio Code' : 'Cursor';
  const cwd = process.argv[3] && !process.argv[3].startsWith('-') ? process.argv[3] : '.';
  console.log(`opening ${app}...`);
  const child = process.platform === 'darwin'
    ? spawn('open', ['-a', app, cwd], { stdio: 'inherit', env })
    : spawn(which === 'vscode' ? 'code' : 'cursor', [cwd], { stdio: 'inherit', env, detached: true });
  child.on('error', (e) => {
    console.error(`could not open ${app}: ${e.message}`);
    console.error(process.platform === 'darwin'
      ? `try:  open -a "${app}" .`
      : `is the \`${which === 'vscode' ? 'code' : 'cursor'}\` command on PATH? (editor: Shell Command: Install '${which === 'vscode' ? 'code' : 'cursor'}' command)`);
  });
}
