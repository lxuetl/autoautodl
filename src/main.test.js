const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');const path=require('node:path');
function mainContext(){
 const app={requestSingleInstanceLock:()=>true,on:()=>{},whenReady:()=>({then:()=>{}}),getPath:()=>'/fixture',getVersion:()=> 'test'};
 const writes=[];const fakeFS={writeFileSync:(...args)=>writes.push(args),renameSync:()=>{}};
 const context=vm.createContext({require:name=>name==='electron'?{app,Notification:{isSupported:()=>false}}:name==='node:fs'?fakeFS:name==='./core'?require('./core'):require(name),__dirname,process:{argv:[]},Buffer,URL,AbortSignal,setTimeout,clearTimeout,clearInterval,console});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'main.js'),'utf8'),context);
 vm.runInContext("state.connected=true;pages=async()=>[{uuid:'i',status:'shutdown'}];request=async()=>({});",context);
 return {run:source=>vm.runInContext(source,context),writes};
}
test('手动开机先持久化意图，未核实前禁止重复提交',async()=>{
 const h=mainContext();await h.run("manualPower({id:'i',action:'on'})");assert.equal(h.run('state.pending.id'),'i');assert.equal(h.writes.length,2);
 await assert.rejects(h.run("manualPower({id:'i',action:'on'})"),/核实/);
});
test('电源请求网络结果不明保留锁定，不能重试重复扣费',async()=>{
 const h=mainContext();h.run("request=async()=>{throw new Error('timeout');}");await assert.rejects(h.run("manualPower({id:'i',action:'on'})"),/timeout/);
 assert.equal(h.run('state.pending.action'),'on');assert.equal(h.run('state.actionBusy'),false);
});
test('关机前重新读到已关机状态时不发送请求',async()=>{
 const h=mainContext();await assert.rejects(h.run("manualPower({id:'i',action:'off'})"),/状态已变化/);assert.equal(h.writes.length,0);
});
test('正在同步时拒绝手动电源操作',async()=>{
 const h=mainContext();h.run('busy=true');await assert.rejects(h.run("manualPower({id:'i',action:'on'})"),/正在同步/);assert.equal(h.writes.length,0);
});
test('主窗口与托盘共用启动校验，待核实或正在提交时不能启用自动开机',()=>{
 const h=mainContext();h.run("state.pending={id:'i'}");assert.throws(()=>h.run('startMonitoring(true)'),/核实/);
 h.run('state.pending=null;state.actionBusy=true');assert.throws(()=>h.run('startMonitoring(true)'),/提交/);
 h.run('state.actionBusy=false');assert.throws(()=>h.run('startMonitoring(true)'),/选择实例/);
});
test('登录成功遇到正在同步时保留一次待刷新，完成后调度而非丢失',async()=>{
 const h=mainContext();h.run("busy=true;onSharedSession('ready')");assert.equal(h.run('refreshAgain'),true);
 h.run("busy=false;balanceAttempt=Date.now();pages=async(endpoint)=>endpoint==='/instance'?[]:[];");
 await h.run('refresh()');assert.equal(h.run('refreshAgain'),false);assert.equal(h.run('!!dataTimer'),true);h.run('clearTimeout(dataTimer)');
});
test('普通服务同步失败不会把已登录账号改成未登录，并安排重试',async()=>{
 const h=mainContext();h.run("state.auth='verified';pages=async()=>{throw new Error('/instance：服务异常');}");
 await h.run('refresh()');assert.equal(h.run('state.connected'),true);assert.equal(h.run('state.auth'),'verified');assert.equal(h.run('!!dataTimer'),true);h.run('clearTimeout(dataTimer)');
});

test('库存DatabaseError不阻断实例与余额同步，旧库存清除且不自动开机',async()=>{
 const h=mainContext();h.run("state.target='i';state.markets=[{id:'m',idle:8}];state.auto=true;state.watching=true;pages=async()=>[{uuid:'i',machine_id:'m',status:'shutdown'}];request=async(endpoint)=>{if(endpoint==='/user/machine/list')throw Object.assign(new Error('DatabaseError'),{apiCode:'DatabaseError'});if(endpoint==='/wallet')return {assets:50000};throw new Error('不应发出开机请求');};");
 await h.run('refresh()');assert.equal(h.run('state.instances.length'),1);assert.equal(h.run('state.markets.length'),0);assert.equal(h.run('state.balance.cash'),50);assert.match(h.run('state.stockError'),/DatabaseError/);assert.equal(h.run('state.pending'),null);h.run('halt()');
});
test('未选目标也未主动监控时不发全市场库存请求，但同步实例和余额',async()=>{
 const h=mainContext();h.run("state.target='';request=async(endpoint)=>{if(endpoint==='/wallet')return {assets:1000};throw new Error('不应请求全市场库存');}");
 await h.run('refresh()');assert.equal(h.run('state.stockError'),'');assert.equal(h.run('stockClient.diagnostics.mode'),'waiting_for_target');assert.equal(h.run('state.balance.cash'),1);h.run('halt()');
});

test('电源请求异常后独立安排核实，不依赖库存刷新',async()=>{
 const h=mainContext();h.run("request=async()=>{throw new Error('timeout')}");
 await assert.rejects(h.run("manualPower({id:'i',action:'on'})"));
 assert.equal(h.run('!!powerTimer'),true);
 h.run("pages=async()=>[{uuid:'i',status:'running'}];stockClient.fetch=async()=>{throw Error('不应查询库存')}");
 await h.run('verifyPower()');assert.equal(h.run('state.pending'),null);h.run('halt()');
});
test('启动中和未找到实例不能解除锁，运行后自动解除',()=>{
 const h=mainContext();h.run("state.pending={id:'i',action:'on'};reconcilePowerRows([{id:'i',status:'starting'}])");
 assert.equal(h.run('state.pending.status'),'starting');h.run('reconcilePowerRows([])');assert.equal(h.run('state.pending.status'),'not_found');
 h.run("reconcilePowerRows([{id:'i',status:'running'}])");assert.equal(h.run('state.pending'),null);h.run('halt()');
});

test('单台提交归属落盘，竞争者及完成后的请求均被拒绝',()=>{
 const h=mainContext();h.run("claimMachine('clone-a')");assert.equal(h.writes.length,1);
 assert.throws(()=>h.run("claimMachine('power:i')"),/只抢一台/);
 h.run("finishMachine('clone-a')");assert.equal(h.run('state.oneMachine.done'),true);
 assert.throws(()=>h.run("claimMachine('clone-a')"),/已经完成/);h.run('halt()');
});

test('首页仅开机模式暂停旧候补且不创建克隆',async()=>{
 const h=mainContext();h.run("state.target='i';state.instances=[{id:'i'}];globalThis.paused=0;globalThis.started=false;rentWorkspace={service:{store:{tasks:()=>[{id:'old',state:'watching'}]},engine:{control:()=>paused++}}};startMonitoring=()=>{started=true};");
 await h.run("startHomeGroup({mode:'power'})");assert.equal(h.run('paused'),1);assert.equal(h.run('started'),true);
});
test('已有未核实提交时首页不能另开抢机组',async()=>{
 const h=mainContext();h.run("state.pending={id:'i'};");await assert.rejects(h.run("startHomeGroup({mode:'both'})"),/已有提交/);
});

for(const mode of ['clone','both'])test('首页'+mode+'自动继承源配置并正确选择是否开机',async()=>{
 const h=mainContext();h.run("state.target='source-1';state.instances=[{id:'source-1',gpu:'RTX 4090',count:2,regionName:'西北B区'}];globalThis.started=false;globalThis.sent=null;rentWorkspace={url:'http://fixture',service:{token:'fixture',store:{tasks:()=>[]},engine:{control:()=>{}}}};openRentWorkspace=async()=>{};startMonitoring=()=>{started=true};globalThis.fetch=async(url,options)=>{sent=JSON.parse(options.body);return {ok:true,json:async()=>({task:{id:'clone-task'}})}};");
 await h.run("startHomeGroup({mode:'"+mode+"',paidConsent:true,clone:{gpuModel:'wrong',regions:['wrong'],gpuCount:8}})");
 assert.equal(h.run('sent.gpuModel'),'RTX 4090');assert.equal(h.run('sent.gpuCount'),2);assert.equal(h.run('sent.regions[0]'),'西北B区');assert.equal(h.run('sent.sourceId'),'source-1');assert.equal(h.run('sent.pricePolicy'),'official');assert.equal(h.run('sent.storageDailyLimit'),null);
 assert.equal(h.run('started'),mode==='both');assert.equal(h.run('state.homeTask'),'clone-task');h.run('halt()');
});

test('已有实例确认成功进入共享通知队列，重试使用稳定去重标识',()=>{
 const h=mainContext();h.run("globalThis.messages=new Map();rentWorkspace={service:{store:{tasks:()=>[],enqueueNotification:(task,event,message)=>messages.set(task.id+':'+event,message)},engine:{control:()=>{}}}};claimMachine('power:i');");
 h.run('queuePowerSuccess()');assert.equal(h.run('messages.size'),0);
 h.run("finishMachine('power:i');queuePowerSuccess();finishMachine('power:i')");
 assert.equal(h.run('messages.size'),1);assert.match(h.run('[...messages.values()][0]'),/实例 ID：i/);h.run('halt()');
});
test('恢复已完成开机组补入通知，克隆完成不重复入开机通知',()=>{
 const h=mainContext();h.run("globalThis.messages=[];rentWorkspace={service:{store:{enqueueNotification:(...args)=>messages.push(args)}}};state.oneMachine={owner:'clone-id',at:123,done:true};queuePowerSuccess();");
 assert.equal(h.run('messages.length'),0);h.run("state.oneMachine.owner='power:i';queuePowerSuccess()");assert.equal(h.run('messages.length'),1);
});
