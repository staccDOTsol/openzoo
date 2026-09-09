import test from 'node:test';
import assert from 'node:assert/strict';
import { windowsArgument } from '../lib/windows-chatgpt.js';
import { launchChatGpt } from '../lib/chatgpt.js';

test('Windows quoting preserves spaces, quotes, trailing slashes and shell metacharacters as data',()=>{
 assert.equal(windowsArgument('C:\\a space\\'),'"C:\\a space\\\\"');
 assert.equal(windowsArgument('a"b'),'"a\\"b"');
 assert.equal(windowsArgument('x & whoami'),'"x & whoami"');
});
test('MSIX launch enters its registered package context and explicitly passes isolated configuration',async()=>{
 const app='C:\\Program Files\\WindowsApps\\OpenAI.Codex_1\\app\\ChatGPT.exe';
 const env={CODEX_HOME:'C:\\Users\\A Space\\.openzoo\\chatgpt',CODEX_ELECTRON_USER_DATA_PATH:'C:\\Users\\A Space\\desktop',OPENZOO_API_KEY:'sk-openzoo'};
 let calls=0;
 await launchChatGpt(app,['--example','a"b'],{platform:'win32',env,spawnImpl:()=>assert.fail('protected exe must not be spawned directly'),run:async(cmd,args,opts)=>{
  calls++;assert.equal(cmd,'powershell.exe');assert.equal(opts.windowsHide,true);assert.equal(opts.env.OPENZOO_PACKAGED_APP,app);
  const script=args.at(-1);assert.match(script,/Get-AppxPackageManifest/);assert.match(script,/Invoke-CommandInDesktopPackage/);assert.match(script,/if \(!\$result.ok\)/);
  const encoded=script.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)[1];
  const child=Buffer.from(encoded,'base64').toString('utf16le');
  const data=JSON.parse(Buffer.from(child.match(/FromBase64String\('([^']+)'\)/)[1],'base64').toString());
  assert.deepEqual(data.env,env);assert.equal(data.app,app);assert.ok(data.args.includes('--user-data-dir='));assert.match(child,/SetEnvironmentVariable/);
 }});assert.equal(calls,1);
});
test('package startup failures are not reported as success',async()=>{
 await assert.rejects(launchChatGpt('C:\\Program Files\\WindowsApps\\OpenAI.Codex_1\\app\\ChatGPT.exe',[],{platform:'win32',env:{},run:async()=>{throw Error('package launch refused');}}),/package launch refused/);
});
