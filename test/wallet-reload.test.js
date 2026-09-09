import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import { walletReloader } from '../lib/wallet-reload.js';
import { loadOrCreateWallet } from '../lib/wallet.js';
import { config } from '../lib/config.js';
import { liveBalance } from '../lib/funding-status.js';

test('dropping in a wallet replaces the client without changing an in-flight signer; partial copies pause', t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'oz-wallet-reload-'));
 const prior=config.walletPath;config.walletPath=path.join(dir,'wallet.json');
 t.after(()=>{config.walletPath=prior;fs.rmSync(dir,{recursive:true,force:true});});
 const original=loadOrCreateWallet();
 const current=walletReloader(original,{file:config.walletPath,load:()=>loadOrCreateWallet({create:false})});
 const inflight=current(), imported=Keypair.generate();
 fs.writeFileSync(config.walletPath,JSON.stringify(Array.from(imported.secretKey)));
 const replacement=current();
 assert.equal(replacement.keypair.publicKey.toBase58(),imported.publicKey.toBase58());
 assert.equal(inflight.keypair.publicKey.toBase58(),original.keypair.publicKey.toBase58());
 assert.equal(current(),replacement,'legacy migration does not keep reloading');
 fs.writeFileSync(config.walletPath,'{"solana":[');
 assert.throws(current,/payments are paused/);
 assert.equal(fs.readFileSync(config.walletPath,'utf8'),'{"solana":[','partial file is not overwritten');
 fs.unlinkSync(config.walletPath);assert.throws(current,/payments are paused/);assert.equal(fs.existsSync(config.walletPath),false);
 fs.writeFileSync(config.walletPath,JSON.stringify({solana:Array.from(imported.secretKey),evm:replacement.evmPrivateKey}));
 assert.equal(current().evmPrivateKey,replacement.evmPrivateKey);
});

test('a balance read from the previous wallet cannot overwrite the replacement balance',async()=>{
 let resolveOld,reads=0;
 const balance=liveBalance(()=>++reads===1?new Promise(r=>{resolveOld=r;}):12);
 const old=balance.refresh();await Promise.resolve();balance.reset();
 assert.equal(await balance.refresh(),12);
 resolveOld(0);await old;
 assert.equal(balance.value,12);
});
