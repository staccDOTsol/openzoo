const test = require('node:test');
const assert = require('node:assert/strict');
const { isChatApp, watchChatVisibility } = require('./chat-visibility.cjs');
test('only ChatGPT and Codex app identities match', () => {
  for (const name of ['com.openai.codex','com.openai.chat','ChatGPT','Codex']) assert.equal(isChatApp({name}),true);
  for (const name of ['Terminal','Brave Browser','Electron','fake-ChatGPT','']) assert.equal(isChatApp({name}),false);
});
test('switching apps hides overlays, own controls retain state, read failure hides them', async () => {
  const apps=[{pid:1,name:'ChatGPT'},{pid:9,name:'Electron'},{pid:2,name:'Terminal'},{pid:9,name:'Electron'},new Error('unavailable'),{pid:1,name:'ChatGPT'}];
  const seen=[];
  await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(Error('visibility polling timed out')),1000);
    const stop=watchChatVisibility(active=>{
      seen.push(active);
      if(seen.length===6){stop();clearTimeout(timeout);resolve();}
    },{ownPid:9,intervalMs:5,read:async()=>{const v=apps.shift();if(v instanceof Error)throw v;return v;}});
  });
  assert.deepEqual(seen,[true,true,false,false,false,true]);
});
