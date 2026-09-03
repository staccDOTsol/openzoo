// Pack the openzoo sidecar the same way grokui-app does: production
// node_modules + overlay of unpublished repo files + ad-hoc mac sign.
// No grokui.mjs copy — this wrapper's UI is status.html; the canvas is
// the vendor Grok Bot.
const grokuiAfterPack = require('../../grokui-app/build/afterPack.js');

exports.default = async function afterPack(context) {
  grokuiAfterPack.copyNodeModules(context);
  grokuiAfterPack.signAdHocIfNeeded(context);
};
