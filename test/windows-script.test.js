import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { packagedLaunchScript } from '../lib/windows-chatgpt.js';
test('Windows PowerShell parses both stages of packaged activation', {skip:process.platform!=='win32'},()=>{
 const outer=packagedLaunchScript({app:'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1\\app\\ChatGPT.exe',args:'"--user-data-dir=C:\\Users\\A Space\\desktop"',env:{CODEX_HOME:'C:\\Users\\A Space\\.openzoo\\chatgpt',OPENZOO_API_KEY:'sk-openzoo'},statusFile:'C:\\Users\\A Space\\Temp\\launch.json'});
 const child=Buffer.from(outer.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)[1],'base64').toString('utf16le');
 for(const source of [outer,child]) {
  const result=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','$t=$null;$e=$null;[void][System.Management.Automation.Language.Parser]::ParseInput($env:OPENZOO_TEST_SCRIPT,[ref]$t,[ref]$e);if($e.Count){$e|ForEach-Object{$_.Message};exit 1};Write-Output "OK"'],{env:{...process.env,OPENZOO_TEST_SCRIPT:source},windowsHide:true,encoding:'utf8'});
  assert.equal(result.trim(),'OK');
 }
});
