import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Wallet} from '../src/wallet.mjs';
test('共享账号钱包复用缓存与并发请求，不需要开发者Token',async()=>{
 const wallet=new Wallet();let calls=0;let release;
 wallet.useSharedAccount(async()=>{calls++;await new Promise(r=>release=r);return {balance:50,vouchers:2};},()=>true);
 const a=wallet.refresh(),b=wallet.refresh();release();await Promise.all([a,b]);await wallet.refresh();
 assert.equal(calls,1);assert.equal(wallet.publicState().sharedAccount,true);assert.equal(wallet.publicState().configured,true);
 const check=await wallet.check({gpuCount:1,maxTotalHourly:1,maxStorageDaily:0});wallet.confirm(check);
 wallet.clearToken();assert.throws(()=>wallet.confirm(check));wallet.close();
});
test('切换账号时丢弃仍在进行的旧余额查询',async()=>{
 const wallet=new Wallet();let release;
 wallet.useSharedAccount(()=>new Promise(r=>release=r),()=>true);
 const pending=wallet.refresh();wallet.clearToken();release({balance:100,vouchers:0});
 await assert.rejects(pending);assert.equal(wallet.snapshot,null);wallet.close();
});
