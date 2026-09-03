/**
 * The Telegram PREHOOK — as close to one as the platform allows.
 *
 * Telegram's Bot API cannot see your own outgoing messages, but an MTProto
 * USERBOT logged in as you can: it receives everything you send, in every
 * chat, the moment you send it — and can edit your message in place. So
 * the intercept is: you type raw, this watcher rewrites it into your voice
 * (openzoo voice, paid x402 per message) and edits it ~a second later.
 *
 * Honest tradeoffs, stated up front:
 *  - readers can glimpse the raw version before the edit lands
 *  - edited messages show Telegram's "edited" tag
 *  - a userbot is ToS-gray; self-editing sits at the tolerated end, but
 *    this is YOUR account — keep the watcher's behavior boring
 *
 * Escapes: a message starting with "." is never touched (the raw marker);
 * neither are /commands, forwards, media captions, or anything under
 * OPENZOO_VOICE_MIN_CHARS. OPENZOO_VOICE_WATCH_CHATS (comma-separated
 * chat ids) restricts the watcher to an allowlist.
 *
 * There is NO X equivalent: the X API has no edit endpoint and no
 * pre-publish hook — the nearest X flows are composing THROUGH the bot,
 * or delete-and-repost (which destroys replies; not built by default).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const SESSION_FILE = process.env.OPENZOO_VOICE_TG_SESSION
  || path.join(os.homedir(), '.openzoo', 'voice-telegram.session');

const MIN_CHARS = Number(process.env.OPENZOO_VOICE_MIN_CHARS || 12);

function ask(q, { hidden = false } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(q, (answer) => { rl.close(); resolve(answer.trim()); });
    if (hidden) rl._writeToOutput = () => {};
  });
}

async function makeClient() {
  let TelegramClient, StringSession;
  try {
    ({ TelegramClient } = await import('telegram'));
    ({ StringSession } = await import('telegram/sessions/index.js'));
  } catch {
    throw new Error("the Telegram userbot needs the 'telegram' package — npm i telegram (in the openzoo checkout) and retry");
  }
  const apiId = Number(process.env.TELEGRAM_APP_ID || 0);
  const apiHash = process.env.TELEGRAM_APP_HASH || '';
  if (!apiId || !apiHash) {
    throw new Error('set TELEGRAM_APP_ID and TELEGRAM_APP_HASH (create an app at https://my.telegram.org/apps) — these are YOUR user-account API credentials, not a bot token');
  }
  let saved = '';
  try { saved = fs.readFileSync(SESSION_FILE, 'utf8').trim(); } catch { /* first run */ }
  const client = new TelegramClient(new StringSession(saved), apiId, apiHash, { connectionRetries: 5 });
  return { client, saved };
}

async function login(client) {
  await client.start({
    phoneNumber: () => ask('phone number (intl format): '),
    phoneCode: () => ask('code from Telegram: '),
    password: () => ask('2FA password (blank if none): ', { hidden: true }),
    onError: (e) => console.error(`  login error: ${e.message}`),
  });
  fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(SESSION_FILE, client.session.save() + '\n', { mode: 0o600 });
  console.error(`  session saved to ${SESSION_FILE} (0600) — 'openzoo voice watch' now runs headless`);
}

export async function runVoiceWatch(cmd, _args = []) {
  const { client, saved } = await makeClient();

  if (cmd === 'login') {
    await login(client);
    await client.disconnect();
    return;
  }

  if (!saved) {
    throw new Error("no userbot session yet — run 'openzoo voice login' once (interactive) first");
  }
  await client.connect();
  const me = await client.getMe();
  console.error(`openzoo voice watch: logged in as ${me.username ? '@' + me.username : me.firstName} — intercepting outgoing messages`);
  console.error(`  escape hatch: start a message with "." to send it raw · min ${MIN_CHARS} chars · Ctrl-C to stop`);

  const allow = (process.env.OPENZOO_VOICE_WATCH_CHATS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  const { NewMessage } = await import('telegram/events/index.js');
  const { voiceText } = await import('./voice.js');

  client.addEventHandler(async (event) => {
    const m = event.message;
    try {
      const text = String(m?.message || '');
      if (!m?.out || !text) return;                       // only MY outgoing text
      if (m.fwdFrom || m.viaBotId || m.media) return;     // forwards/inline/media stay raw
      if (text.startsWith('.') || text.startsWith('/')) return;
      if (text.length < MIN_CHARS) return;
      const chatId = String(m.chatId ?? '');
      if (allow.length && !allow.includes(chatId)) return;

      const { text: revised, receipt } = await voiceText(text);
      const same = revised.replace(/\s+/g, ' ').trim().toLowerCase()
        === text.replace(/\s+/g, ' ').trim().toLowerCase();
      if (!revised || same) {
        console.error(`  [${chatId}] already in voice — untouched · ${receipt}`);
        return;
      }
      await m.edit({ text: revised });
      console.error(`  [${chatId}] revised (${text.length} → ${revised.length} chars) · ${receipt}`);
    } catch (e) {
      // Never let a rewrite failure eat a message: the raw text is already
      // sent and stays; the watcher just reports and moves on.
      console.error(`  watch: ${e.message?.slice(0, 120)}`);
    }
  }, new NewMessage({ outgoing: true }));

  // Run until killed.
  await new Promise(() => {});
}
