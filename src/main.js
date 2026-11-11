'use strict';
const {app,BrowserWindow,WebContentsView,ipcMain,shell,dialog,Notification,Tray,Menu,nativeImage,clipboard} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const core = require('./core');
const {StockClient}=require('./stock-client');
const stockClient=new StockClient((endpoint,body)=>request(endpoint,body));
const demo = process.argv.includes('--demo');
if(demo&&process.argv.includes('--smoke'))app.setPath('userData',fs.mkdtempSync(path.join(app.getPath('temp'),'autodl-desktop-smoke-')));
if(!app.requestSingleInstanceLock()){app.exit(0);}
app.on('second-instance',()=>{if(win){win.show();win.focus();}});
let win,tray,sessionTimer,timer,dataTimer,refreshAgain=false,busy=false,quitting=false,generation=0,errors=0;
let rentWorkspace=null,rentView=null,rentOpening=null,activeTab='dashboard';
const rentTabs={market:'dashboard',messages:'notifications',ai:'ai',notifications:'settings'};
function layoutRent(){
  if(!rentView||!win)return;
  const visible=Object.hasOwn(rentTabs,activeTab);
  rentView.setVisible(visible);
  const [width,height]=win.getContentSize();
  rentView.setBounds({x:220,y:110,width:Math.max(1,width-220),height:Math.max(1,height-110)});
}
async function openRentWorkspace(createView=true){
  if(demo&&!process.argv.includes('--workspace-smoke'))throw new Error('演示模式不会启动真实租机功能');
  if(rentOpening){await rentOpening;if(!createView||rentView)return;}
  rentOpening=(async()=>{
    if(!rentWorkspace){
      const {createRentWorkspace}=require('./rent-workspace');
      const runtimeDir=demo?fs.mkdtempSync(path.join(app.getPath('temp'),'autodl-workspace-smoke-')):path.join(app.getPath('userData'),'rent-workspace');
      rentWorkspace=await createRentWorkspace(runtimeDir,onSharedSession);
      installOneMachine(rentWorkspace.service);
      if(!demo)sessionTimer=setInterval(()=>{queuePowerSuccess();emit();rentWorkspace?.sharedSession.poll().catch(()=>{});},3000);
    }
    if(createView&&!rentView){
      rentView=new WebContentsView({webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
      win.contentView.addChildView(rentView);rentView.setVisible(false);
      rentView.webContents.on('will-navigate',(event,url)=>{if(new URL(url).origin!==rentWorkspace.url)event.preventDefault();});
      rentView.webContents.setWindowOpenHandler(()=>({action:'deny'}));
      await rentView.webContents.loadURL(rentWorkspace.url);
      await rentView.webContents.insertCSS(fs.readFileSync(path.join(__dirname,'rent-desktop.css'),'utf8'));
    }
  })();
  try{await rentOpening;}finally{rentOpening=null;}
}
async function selectTab(name){
  const allowed=['dashboard','instances','billing','settings',...Object.keys(rentTabs)];
  if(!allowed.includes(name))throw new Error('未知页面');
  activeTab=name;layoutRent();
  if(name==='billing')void refreshBilling().catch(e=>log(e.message));
  if(Object.hasOwn(rentTabs,name)){
    await openRentWorkspace();
    // 异步加载完成时以最后选择的页面为准，避免切走后又覆盖当前页面。
    if(Object.hasOwn(rentTabs,activeTab))await rentView.webContents.executeJavaScript(`document.querySelector('[data-view="${rentTabs[activeTab]}"]').click()`);
    if(activeTab==='market')await rentView.webContents.executeJavaScript("document.querySelector('[data-mode=create]').click();window.scrollTo(0,0)");
    layoutRent();
  }
}
let state={demo,connected:false,auth:'signedOut',syncing:false,lastError:'',watching:false,auto:false,target:'',instances:[],markets:[],stockError:'',logs:[],pending:null,oneMachine:null,updated:null,nextCheckAt:null,balance:null,balanceError:'',bills:[],billingAt:null,billingError:'',billingBusy:false,actionBusy:false,settings:{seconds:5,count:1,gpu:'RTX 4090',region:'',lowBalance:10}};
const file=()=>path.join(app.getPath('userData'),'profile.json');
let availabilityKey='';
let stockWarningKey='',balanceAlerted=false;let balanceAttempt=0;
function persist(){
  if(demo)return;
  const content=JSON.stringify({settings:state.settings,pending:state.pending,oneMachine:state.oneMachine,homeTask:state.homeTask,homeMode:state.homeMode});
  fs.writeFileSync(file()+'.tmp',content,{mode:0o600});fs.renameSync(file()+'.tmp',file());
}
function publicState(){const snapshot=rentWorkspace?.service?.wallet?.snapshot;if(state.connected&&snapshot)state.balance={cash:snapshot.balance,voucher:snapshot.vouchers,blocked:snapshot.blocked,at:snapshot.checkedAt};return {...state,rentalTasks:(rentWorkspace?.service?.store.tasks()||[]).map(t=>({id:t.id,mode:t.config.mode,state:t.state,progress:t.lastProgress||t.lastError||'',result:t.result?.id||t.operation?.receipt?.instanceId||''})),stockSummary:core.stockSummary(state),billingSummaries:Object.fromEntries([14,30,35].map(days=>[days,core.billingSummary(state.bills,days)]))};}
function emit(){if(win&&!win.isDestroyed())win.webContents.send('state',publicState());updateTray();}
function log(message){state.logs.unshift({time:new Date().toLocaleTimeString('zh-CN'),message});state.logs=state.logs.slice(0,150);emit();}
function notify(message){if(Notification.isSupported())new Notification({title:'AutoDL Companion',body:message}).show();}
function halt(){generation++;clearTimeout(timer);clearTimeout(dataTimer);state.watching=false;state.auto=false;state.nextCheckAt=null;emit();}
function scheduleDataRefresh(delay=15000){
  clearTimeout(dataTimer);
  if(demo||quitting||!state.connected||state.watching)return;
  dataTimer=setTimeout(()=>refresh(),delay);dataTimer.unref?.();
}
function onSharedSession(status){
  if(demo)return;
  const ready=status==='ready',transient=['error','network_blocked','unknown'].includes(status);
  if(!ready&&!transient){halt();state.instances=[];state.markets=[];state.stockError='';stockClient.retryUntil=0;stockClient.compatible.clear();state.target='';state.updated=null;state.balance=null;state.bills=[];state.billingAt=null;state.balanceError='';state.billingError='';balanceAttempt=0;balanceAlerted=false;}
  state.connected=ready||transient&&state.connected;
  state.auth=ready?'verified':['expired','login_required'].includes(status)?'expired':status==='changed'?'checking':transient?'unverified':'signedOut';
  state.lastError=status==='changed'?'账号会话已变更，旧任务已暂停，请重新选择实例':status==='expired'?'登录已失效，请重新登录':transient?'会话核验暂时失败，保留数据并自动重试':'';
  emit();
  if(ready){schedulePowerCheck(0);if(busy||state.actionBusy)refreshAgain=true;else scheduleDataRefresh(0);}
}
async function workspaceAction(action){
  await openRentWorkspace(false);
  if(action==='check'&&rentWorkspace.sharedSession.checkFlight)return rentWorkspace.sharedSession.checkFlight;
  if(action==='open'&&rentWorkspace.sharedSession.checkFlight){await rentWorkspace.sharedSession.checkFlight;if(state.connected)return {message:'账号已连接'};}
  const deadline=Date.now()+25000;
  while(rentWorkspace.service.engine.busy&&!rentWorkspace.service.engine.stopping&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,200));
  if(rentWorkspace.service.engine.busy)throw new Error('当前页面操作尚未结束，请稍候；未重复打开浏览器');
  const response=await fetch(rentWorkspace.url+'/api/browser/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Local-Token':rentWorkspace.service.token},body:JSON.stringify({})});
  const result=await response.json();
  if(!response.ok)throw new Error(result.message||'账号操作失败，请稍后重试');
  return result;
}
async function request(endpoint,body){
  if(!rentWorkspace)throw new Error('请先登录 AutoDL');
  return rentWorkspace.sharedSession.request(endpoint,body);
}
async function pages(endpoint,body,useBootstrap=false){
  const result=[];
  for(let page=1;page<=20;page++){
    const cached=useBootstrap&&page===1&&endpoint==='/instance'?rentWorkspace?.sharedSession.takeBootstrap?.():null;
    const data=cached??await request(endpoint,{...body,page_index:page,page_size:100});
    const list=core.listOf(data);result.push(...list);
    if(list.length<100||Number(data.max_page)===page)return result;
  }
  throw new Error('列表超过读取上限，请缩小筛选条件');
}
async function refresh(){
  if(busy||state.actionBusy)return;clearTimeout(dataTimer);busy=true;state.syncing=true;state.lastError='';emit();const run=generation;
  try{
    if(demo){
      state.instances=[{id:'demo-instance',name:'训练实验 · 示例',status:'shutdown',machine:'demo-host',gpu:'RTX 4090',count:1,region:'westDC3',regionName:'西北B区'}];
      state.markets=[{id:'demo-host',gpu:'RTX 4090',idle:2,total:8,region:'西北B区'}];
      Object.assign(state.instances[0],{memoryTotal:32*2**30,memoryUsed:12*2**30,systemTotal:30*2**30,systemUsed:10*2**30,dataTotal:50*2**30,dataUsed:20*2**30,releaseAt:Date.now()+7*86400000});state.balance={cash:58,voucher:10,blocked:0,at:Date.now()};state.target='demo-instance';
    }else{
      const raw=await pages('/instance',{status:[],charge_type:[],date_from:'',date_to:''},true);
      if(run!==generation)return;
      state.instances=raw.map(core.instance);state.connected=true;state.auth='verified';emit();
      if(Date.now()-balanceAttempt>=60000)void refreshBalance();
      reconcilePowerRows(state.instances);
      const selected=state.instances.find(i=>i.id===state.target);
      try{
        const queryStock=!!selected;
        const markets=queryStock?await stockClient.fetch(selected,state.settings):[];
        if(!queryStock)stockClient.diagnostics={mode:'waiting_for_target',message:'请选择已有实例；新租请使用新建实例'};
        if(run!==generation)return;
        state.markets=markets;state.stockError='';
      }catch(error){
        if(run!==generation)return;
        state.markets=[];state.stockError=error.message;
        state.stockDiagnostics={version:app.getVersion(),request:stockClient.diagnostics};
        if(state.lastStockMessage!==error.message){log('库存暂不可用：'+error.message+'；实例与余额继续更新');state.lastStockMessage=error.message;}
      }
      if(!state.stockError)state.lastStockMessage='';
      const unknown=state.markets.filter(m=>m.idle===null);
      state.stockDiagnostics={...core.stockDiagnostics(state.markets,app.getVersion()),request:stockClient.diagnostics};
      const warningKey=JSON.stringify([state.stockDiagnostics.schemas,state.stockDiagnostics.reasons]);
      const reasonLabels={negative:'负库存',fractional:'非整数',out_of_range:'超出有效范围',non_finite:'非有限数',missing:'缺少字段',invalid_type:'类型异常',conflicting:'字段冲突'};
      const reasons=Object.entries(state.stockDiagnostics.reasons).map(([key,count])=>`${reasonLabels[key]||key} ${count} 条`).join('，');
      if(unknown.length&&warningKey!==stockWarningKey)log(`同步完成：${state.stockDiagnostics.known} 条库存正常，${unknown.length} 条暂不可确认（${reasons}）；异常库存不参与自动开机`);
      stockWarningKey=warningKey;
      const available=selected?state.markets.filter(m=>m.id===selected.machine&&m.idle>=selected.count):state.markets.filter(m=>m.idle>=state.settings.count);
      const key=available.map(m=>m.id).sort().join(',');
      if(state.watching&&key&&key!==availabilityKey){log('发现符合条件的空闲 GPU');if(!state.auto)notify('发现符合条件的空闲 GPU，请查看监控台');}
      availabilityKey=key;
      if(state.watching&&state.auto&&selected&&!state.pending){
        const available=state.markets.find(m=>m.id===selected.machine);
        if(available&&core.canStart(selected,available)&&run===generation)await powerOn(selected);
      }
    }
    if(run!==generation)return;
    state.updated=new Date().toLocaleString('zh-CN');errors=state.stockError?errors+1:0;state.lastError=state.stockError?'实例已同步；库存暂不可用，等待自动重试':'';emit();
    if(!demo&&Date.now()-balanceAttempt>=60000)await refreshBalance();
  }catch(e){if(run===generation){errors++;state.lastError=e.message;if(state.auth==='checking'){state.auth='unverified';state.connected=false;}log('同步失败：'+e.message);}}
  finally{busy=false;state.syncing=false;emit();const queued=refreshAgain;refreshAgain=false;scheduleDataRefresh(queued?0:core.pollDelay(15,errors,Math.max(rentWorkspace?.sharedSession.retryUntil||0,stockClient.retryUntil)));}
}
// 单台模式的提交归属持久化；结果不明时绝不释放给另一条候补。
function claimMachine(owner){
  if(state.oneMachine && state.oneMachine.owner!==owner)throw new Error('只抢一台：另一条候补已提交或已成功，当前任务不再提交');
  if(state.oneMachine?.done)throw new Error('只抢一台：本组已经完成');
  if(!state.oneMachine){state.oneMachine={owner,at:Date.now(),done:false};persist();}
}
function queuePowerSuccess(){
  const group=state.oneMachine,service=rentWorkspace?.service;
  if(demo||!group?.done||!group.owner.startsWith('power:')||!service?.store.enqueueNotification)return;
  const id=group.owner.slice(6),item=state.instances.find(i=>i.id===id);
  // 与租用共用持久化通知队列；组标识稳定，重启/重复核实不会重复入队。
  try{service.store.enqueueNotification({id:'power-'+group.at+'-'+id,config:{name:'已有实例开机 · '+(item?.name||id)}},'completed',
    '抢机成功：已有 GPU 实例已运行。实例 ID：'+id+'。其他未提交候补已结束，请及时使用。');}
  catch(error){if(state.notificationError!==error.message){state.notificationError=error.message;log('成功通知入队失败，将自动重试：'+error.message);}}
}
function finishMachine(owner){
  if(state.oneMachine?.owner!==owner)return;
  const alreadyDone=state.oneMachine.done;state.oneMachine.done=true;persist();queuePowerSuccess();if(alreadyDone)return;halt();
  const service=rentWorkspace?.service;
  for(const t of service?.store.tasks()||[])if(t.id!==owner&&!t.operation&&['queued','watching','preparing','paused'].includes(t.state))service.engine.control(t,'cancel');
  log('已获得一台实例，整组候补结束');if(owner.startsWith('power:'))notify('抢机成功：已有实例已运行，其他候补已结束');
}
function installOneMachine(service){
  // 兼容升级前已经提交的租用任务，不能把它当作空闲的提交名额。
  const existing=service.store.tasks().find(t=>t.operation&&!['completed','cancelled'].includes(t.state));
  if(!state.oneMachine&&existing){state.oneMachine={owner:existing.id,at:Date.now(),done:false};persist();}
  service.engine.beforeAcquire=async task=>{
    if(state.actionBusy)throw new Error('正在启动首页抢机组，请稍后重试');
    if(state.pending)throw new Error('已有实例电源请求正在核实，暂不提交租用');
    if(!state.oneMachine&&state.auto&&state.target){
      const item=state.instances.find(i=>i.id===state.target);
      if(item){const rows=await stockClient.fetch(item,state.settings);const host=rows.find(m=>m.id===item.machine);
        if(host&&core.canStart(item,host)){await powerOn(item,true);throw new Error('已有实例有空闲资源，已优先开机，暂停租用提交');}}
    }
    claimMachine(task.id);
  };
  const step=service.engine.step.bind(service.engine);
  service.engine.step=async task=>{
    if(state.oneMachine&&state.oneMachine.owner!==task.id&&!task.operation){service.store.patch(task,{nextCheckAt:Date.now()+15000});return;}
    try{return await step(task);}finally{
      if(state.oneMachine?.owner===task.id){
        if(task.state==='completed')finishMachine(task.id);
        else if(!task.operation){state.oneMachine=null;persist();}
      }
    }
  };
}
// 独立只读核实：不查询库存，不重发电源操作，也不依赖监控开关。
let powerTimer=null,powerChecking=false;
function schedulePowerCheck(delay=5000){
  clearTimeout(powerTimer);
  if(demo||quitting||!state.pending||!state.connected)return;
  powerTimer=setTimeout(()=>void verifyPower(),Math.max(delay,(rentWorkspace?.sharedSession.retryUntil||0)-Date.now()));
  powerTimer.unref?.();
}
function reconcilePowerRows(rows){
  const pending=state.pending;if(!pending||state.actionBusy)return;
  const item=rows.find(i=>i.id===pending.id);
  pending.checkedAt=Date.now();pending.status=item?.status||'not_found';pending.error='';
  const done=item&&(pending.action==='off'?['shutdown','stopped','poweroff','power_off'].includes(item.status):item.status==='running');
  if(done){state.pending=null;clearTimeout(powerTimer);persist();if(pending.action!=='off')finishMachine('power:'+pending.id);halt();log('已自动确认实例'+(pending.action==='off'?'关机':'开机')+'完成');scheduleDataRefresh();}
  else emit();
}
async function verifyPower(){
  if(powerChecking||state.actionBusy||!state.pending||!state.connected){schedulePowerCheck();return;}
  powerChecking=true;const pending=state.pending,run=generation;
  try{
    const rows=(await pages('/instance',{status:[],charge_type:[],date_from:'',date_to:''})).map(core.instance);
    if(state.pending!==pending||run!==generation)return;
    state.instances=rows;reconcilePowerRows(rows);
  }catch(error){if(state.pending===pending){pending.error=error.message;emit();}}
  finally{powerChecking=false;schedulePowerCheck(state.pending?.error?15000:5000);}
}
async function powerOn(item,priority=false){
  if(demo){log('演示模式：模拟开机请求');return;}
  if(rentWorkspace?.service.engine.busy&&!priority)return;
  if(state.pending)throw new Error('存在待核实的开机请求，请先核实状态');
  // 写入磁盘后才发送；网络中断、应用重启均不会重复提交。
  await rentWorkspace.sharedSession.ensureApi();
  claimMachine('power:'+item.id);
  state.pending={id:item.id,time:Date.now()};persist();emit();
  try{await request('/instance/power_on',{instance_uuid:item.id,payload:'gpu'});log('开机请求已接受，等待状态确认');}
  catch(e){log('开机结果待核实：'+e.message);notify('开机请求未能确认，请核实实例状态');state.auto=false;emit();}
  finally{schedulePowerCheck(0);}
}
async function loop(){
  const run=generation;await refresh();
  if(state.watching&&run===generation){const delay=core.pollDelay(state.settings.seconds,errors,Math.max(rentWorkspace?.sharedSession.retryUntil||0,stockClient.retryUntil));state.nextCheckAt=Date.now()+delay;timer=setTimeout(loop,delay);emit();}
}
async function refreshBalance(){
  const run=generation;balanceAttempt=Date.now();
  try{
    const wallet=rentWorkspace?.service?.wallet;
    const snapshot=wallet?await wallet.refresh():null;
    const value=snapshot?{cash:snapshot.balance,voucher:snapshot.vouchers,blocked:snapshot.blocked,at:snapshot.checkedAt}:core.balance(await request('/wallet'));
    if(run!==generation)return;
    state.balance=value;state.balanceError='';
    if(value.cash<state.settings.lowBalance&&!balanceAlerted){balanceAlerted=true;notify(`现金余额 ¥${value.cash.toFixed(2)}，低于提醒阈值 ¥${state.settings.lowBalance}`);log('现金余额不足提醒（代金券不计入现金阈值）');}
    if(value.cash>=state.settings.lowBalance)balanceAlerted=false;
  }catch(e){if(run===generation)state.balanceError=e.message;}
  emit();
}
async function refreshBilling(force=false){
  if(state.billingBusy||(!force&&state.billingAt&&Date.now()-state.billingAt<120000))return;
  if(!state.connected)throw new Error('请先登录');
  const run=generation;state.billingBusy=true;state.billingError='';emit();
  try{
    const end=core.dayKey(Date.now()),start=core.dayKey(Date.now()-34*86400000),rows=[],seen=new Set();let complete=false;
    if(demo){for(let n=0;n<35;n++)rows.push({id:String(n),at:Date.now()-n*86400000,type:n%8===0?'refund':'charge',amount:n%7+1,gpu:'RTX 4090',region:'西北B区'});complete=true;}
    else for(let page=1;page<=20;page++){
      const data=await request('/bill/list',{order_uuid:'',sub_name:'',date_from:start,date_to:end,page_index:page,page_size:500,bill_type:''});
      if(run!==generation)return;
      const list=core.listOf(data);
      for(const raw of list){const row=core.bill(raw);if(row.id&&!seen.has(row.id)){seen.add(row.id);rows.push(row);}}
      if(list.length<500||(Number.isFinite(Number(data.result_total))&&page*500>=Number(data.result_total))){complete=true;break;}
    }
    if(run!==generation)return;
    state.bills=rows;state.billingAt=Date.now();if(!complete)state.billingError='账单超过 10000 条，当前统计不完整';
  }catch(e){if(run===generation)state.billingError=e.message;}
  finally{state.billingBusy=false;emit();}
}
async function manualPower(payload){
  if(!payload||!['on','off'].includes(payload.action))throw new Error('无效电源操作');
  if(busy||state.actionBusy)throw new Error('正在同步或提交，请稍后再试');
  if(state.pending)throw new Error('请先核实上一笔电源请求');
  if(!state.connected)throw new Error('请先登录');
  if(rentWorkspace?.service.engine.busy)throw new Error('租机任务正在执行页面操作，请稍后再试');
  const conflicts=rentWorkspace?.service.store.tasks().some(t=>t.config.sourceId===payload.id&&['queued','watching','preparing','submitting','verifying'].includes(t.state));
  if(conflicts)throw new Error('此实例正在作为克隆源，请先暂停克隆任务再操作电源');
  halt();state.actionBusy=true;emit();
  try{
    const rows=demo?state.instances:(await pages('/instance',{status:[],charge_type:[],date_from:'',date_to:''})).map(core.instance);
    const item=rows.find(i=>i.id===payload.id);if(!item)throw new Error('实例不存在，请刷新');
    const allowed=payload.action==='on'?['shutdown','stopped','poweroff','power_off']:['running'];
    if(!allowed.includes(item.status))throw new Error('实例状态已变化，当前不能执行此操作');
    if(demo){item.status=payload.action==='on'?'running':'shutdown';log('演示模式：模拟'+(payload.action==='on'?'开机':'关机'));return;}
    if(rentWorkspace)await rentWorkspace.sharedSession.ensureApi();
    if(payload.action==='on')claimMachine('power:'+item.id);
    state.pending={id:item.id,action:payload.action,time:Date.now()};persist();emit();
    await request('/instance/power_'+payload.action,{instance_uuid:item.id,...(payload.action==='on'?{payload:'gpu'}:{})});
    log('电源请求已接受，正在自动核实实例状态');
  }catch(e){log('电源操作未完成：'+e.message);notify('电源操作未完成，请查看操作记录并核实实例状态');throw e;}finally{state.actionBusy=false;emit();schedulePowerCheck(0);scheduleDataRefresh();}
}
async function checkUpdates(){
  const response=await fetch('https://api.github.com/repos/lxuetl/autoautodl/releases',{headers:{Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error('无法检查更新：HTTP '+response.status);
  const releases=await response.json();
  const latest=releases.filter(r=>!r.draft&&/^v?\d+\.\d+\.\d+$/.test(r.tag_name)).sort((a,b)=>b.tag_name.replace(/^v/,'').localeCompare(a.tag_name.replace(/^v/,''),undefined,{numeric:true}))[0];
  log(latest?`当前 ${app.getVersion()}；已发布 ${latest.tag_name}。测试版不会自动降级，请在发布页核对版本。`:'尚无已发布版本');
}
async function startHomeGroup(input){
  if(!input||!['power','clone','both'].includes(input.mode))throw new Error('请选择候补方式');
  if(!state.connected||state.pending||state.actionBusy||state.watching||state.oneMachine)throw new Error('请先连接账号并处理已有提交或已完成的抢机组');
  const item=state.instances.find(i=>i.id===state.target);if(!item)throw new Error('请选择已有实例');
  const service=rentWorkspace?.service;
  if(service?.store.tasks().some(t=>t.operation&&!['completed','cancelled'].includes(t.state)))throw new Error('已有租用请求待核实，不能开启另一组');
  for(const t of service?.store.tasks()||[])if(!t.operation&&['queued','watching','preparing'].includes(t.state))service.engine.control(t,'pause');
  if(input.mode!=='power'){
    await openRentWorkspace(false);state.actionBusy=true;emit();
    try{
      const response=await fetch(rentWorkspace.url+'/api/tasks',{method:'POST',headers:{'Content-Type':'application/json','X-Local-Token':rentWorkspace.service.token},body:JSON.stringify({
        ...input.clone,gpuModel:input.clone?.inheritSource!==false?item.gpu:input.clone.gpuModel,gpuCount:input.clone?.inheritSource!==false?item.count:input.clone.gpuCount,regions:[item.regionName],provider:'autodl',mode:'clone',action:'execute',paidConsent:input.paidConsent===true,sourceId:item.id,
        balanceGuard:true,pricePolicy:'official',storageDailyLimit:null,pollSeconds:state.settings.seconds,scanScope:'first-page',name:input.mode==='clone'?'首页 · 仅克隆':'首页 · 开机或克隆（只抢一台）'
      })});
      const result=await response.json();if(!response.ok)throw new Error(result.message||'克隆配置未通过检查');state.homeTask=result.task.id;
    }finally{state.actionBusy=false;emit();}
  }
  state.homeMode=input.mode;persist();
  if(input.mode==='clone'){halt();log('已开始仅克隆候补，源实例不会自动开机');scheduleDataRefresh();}
  else startMonitoring(true);
}
function startMonitoring(auto){
  if(!state.connected)throw new Error('请先登录');
  if(state.pending)throw new Error('请先核实上次电源请求');
  if(state.actionBusy)throw new Error('正在提交电源请求');
  if(!state.instances.some(i=>i.id===state.target))throw new Error('请先选择实例');
  halt();state.watching=true;state.auto=!!auto;log(auto?'已开启库存监控与自动开机':'已开启库存监控');void loop();
}
let trayKey='';
function updateTray(){
  if(!tray)return;
  const key=JSON.stringify([state.connected,state.watching,state.auto,state.target,!!state.pending,state.actionBusy,state.instances.map(i=>[i.id,i.name])]);
  if(key===trayKey)return;trayKey=key;
  const handle=fn=>()=>Promise.resolve().then(fn).catch(e=>log(e.message));
  tray.setContextMenu(Menu.buildFromTemplate([
    {label:'打开主窗口',click:()=>{win.show();win.focus();}},
    {label:'刷新数据',enabled:state.connected,click:handle(refresh)},
    {label:'监控目标',enabled:!state.watching&&state.instances.length>0,submenu:state.instances.map(i=>({label:i.name,type:'radio',checked:i.id===state.target,click:()=>{state.target=i.id;availabilityKey='';emit();}}))},
    {label:'仅监控',enabled:state.connected&&!state.pending&&!state.actionBusy,click:handle(()=>startMonitoring(false))},
    {label:state.auto?'停止自动开机':'启动自动开机',enabled:state.connected&&!!state.target&&!state.pending&&!state.actionBusy,click:handle(async()=>{
      if(state.auto){halt();return;}
      const target=state.target,item=state.instances.find(i=>i.id===target);
      const answer=await dialog.showMessageBox(win,{type:'question',buttons:['取消','启用自动开机'],defaultId:0,cancelId:0,message:`对“${item?.name||target}”启用自动有卡开机？`,detail:'开机后平台将按规则计费。'});
      if(answer.response===1&&state.target===target)startMonitoring(true);
    })},
    {label:'停止全部开机监控',enabled:state.watching,click:halt},
    {label:'检查更新',click:handle(checkUpdates)},
    {label:'退出',click:()=>{quitting=true;app.quit();}}
  ]));
}
let loginFlight=null;
async function showLogin(){
  if(demo||state.connected)return;
  if(loginFlight)return loginFlight;
  loginFlight=(async()=>{await workspaceAction('open');log(state.connected?'账号已连接，正在自动同步数据':'请在专用浏览器完成一次登录，完成后自动同步');})();
  try{await loginFlight;}finally{loginFlight=null;}
}
app.whenReady().then(()=>{
  if(!demo){try{const stored=JSON.parse(fs.readFileSync(file(),'utf8'));state.settings=core.settings(stored.settings);state.pending=stored.pending||null;state.oneMachine=stored.oneMachine||null;state.homeTask=stored.homeTask||null;state.homeMode=stored.homeMode||'power';persist();}catch{}}
  else {state.connected=true;state.auth='demo';}
  win=new BrowserWindow({width:1180,height:820,minWidth:900,minHeight:650,backgroundColor:'#10141f',webPreferences:{preload:path.join(__dirname,'preload.js'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',e=>e.preventDefault());
  win.on('resize',layoutRent);
  win.loadFile(path.join(__dirname,'index.html'));

  if(demo&&process.argv.includes('--smoke')){
    win.webContents.on('did-finish-load',async()=>{
      try{
          if(process.argv.includes('--browser-smoke')){
            const {chromium}=await import('playwright');
            const browser=await chromium.launch({channel:'msedge',headless:true});
            try{const page=await browser.newPage();await page.setContent('<title>AutoDL packaging check</title>');if(await page.title()!=='AutoDL packaging check')throw Error('浏览器依赖检查失败');}
            finally{await browser.close();}
            console.log('PLAYWRIGHT LAUNCH OK',process.resourcesPath);fs.writeFileSync(path.join(app.getPath('temp'),'autodl-browser-check-'+process.pid+'.json'),JSON.stringify({ok:true,resources:process.resourcesPath,at:Date.now()}));
          }
        if(process.argv.includes('--browser-only')){quitting=true;app.quit();return;}
        await refresh();
        await new Promise(resolve=>setTimeout(resolve,1000));
        const counts=await win.webContents.executeJavaScript("({cards:document.querySelectorAll('#instanceList article').length, heading:document.getElementById('heading').textContent})");
        if(counts.cards!==1)throw new Error('演示实例未渲染');
        const loginHidden=await win.webContents.executeJavaScript("render({...current,demo:false,connected:true,auth:'verified'});document.getElementById('login').hidden&&document.getElementById('checkLogin').hidden&&!document.getElementById('logout').hidden");
        if(!loginHidden)throw new Error('已登录时仍显示登录按钮');
        await win.webContents.executeJavaScript("render({...current,demo:true})");
        await win.webContents.executeJavaScript("switchTab('instances')");
        await new Promise(resolve=>setTimeout(resolve,150));
        const darkInstance=await win.webContents.executeJavaScript(`['.instance-card .chip-icon','.instance-card .actions button:first-child'].every(selector=>{const e=document.querySelector(selector),c=getComputedStyle(e).backgroundColor.match(/[\\d.]+/g).map(Number);return Math.max(...c.slice(0,3))<130;})`);
        if(!darkInstance)throw Error('实例图标或监控按钮仍有浅色背景');
        fs.writeFileSync(path.join(app.getPath('temp'),'autodl-instances-preview.png'),(await win.webContents.capturePage()).toPNG());
        await win.webContents.executeJavaScript("switchTab('dashboard')");
        await new Promise(resolve=>setTimeout(resolve,150));
        const homeReady=await win.webContents.executeJavaScript(`(()=>{
          const mode=document.getElementById('homeMode');mode.value='clone';mode.dispatchEvent(new Event('change'));
          const good=mode.options.length===3&&!document.getElementById('homeClone').hidden&&document.getElementById('cloneGpu').value==='RTX 4090'&&document.getElementById('cloneRegion').readOnly;
          mode.value='both';mode.dispatchEvent(new Event('change'));const both=!document.getElementById('homeClone').hidden;
          mode.value='power';mode.dispatchEvent(new Event('change'));return good&&both&&document.getElementById('homeClone').hidden;
        })()`);
        if(!homeReady)throw new Error('首页三模式或源配置自动填充异常');
        const motionReady=await win.webContents.executeJavaScript(`(async()=>{
          const before=current;render({...before,watching:true});const ring=document.querySelector('.orbit-track');
          const initial=getComputedStyle(ring).transform;await new Promise(r=>setTimeout(r,180));
          const moved=matchMedia('(prefers-reduced-motion: reduce)').matches||getComputedStyle(ring).transform!==initial;
          const gauges=document.querySelectorAll('#targetResources svg').length===3;
          render(before);return moved&&gauges&&!document.querySelector('.monitor-hero').classList.contains('is-live');
        })()`);
        if(!motionReady)throw Error('监控动画状态或资源仪表异常');
        const image=await win.webContents.capturePage();fs.writeFileSync(app.isPackaged?path.join(app.getPath('temp'),'autodl-companion-preview.png'):path.join(__dirname,'..','preview.png'),image.toPNG());
        await win.webContents.executeJavaScript("switchTab('billing')");
        await refreshBilling();
        await new Promise(resolve=>setTimeout(resolve,200));
        const billingReady=await win.webContents.executeJavaScript("document.querySelectorAll('#billRows tr').length===35 && document.querySelectorAll('#billChart rect').length===30");
        if(!billingReady)throw new Error('账单页面未正常渲染');
        const drill=await win.webContents.executeJavaScript("document.querySelector('#billChart rect').dispatchEvent(new MouseEvent('click'));document.querySelectorAll('#billRows tr').length");
        if(drill!==1)throw new Error('账单按天筛选失败');
        await win.webContents.executeJavaScript("document.getElementById('allBills').click()");
        fs.writeFileSync(path.join(app.getPath('temp'),'autodl-billing-preview.png'),(await win.webContents.capturePage()).toPNG());
        await win.webContents.executeJavaScript("window.app.call('settings',{seconds:1,count:1,gpu:'RTX 4090',region:'',lowBalance:10})");
        if(state.settings.seconds!==1)throw new Error('1秒设置未生效');
        await manualPower({id:'demo-instance',action:'on'});
        if(state.instances[0].status!=='running')throw new Error('演示开机未生效');
        await manualPower({id:'demo-instance',action:'off'});
        if(state.instances[0].status!=='shutdown')throw new Error('演示关机未生效');
        console.log('BILLING / SETTINGS / POWER SMOKE OK');
        if(process.argv.includes('--workspace-smoke')){
          await win.webContents.executeJavaScript("switchTab('market')");
          await openRentWorkspace();
          await new Promise(resolve=>setTimeout(resolve,1200));
          const ready=await rentView.webContents.executeJavaScript("!!document.querySelector('meta[name=\"local-token\"]') && document.body.innerText.includes('AutoDL')");
          if(!ready)throw new Error('租机工作台未渲染');
          const sharedReady=await rentView.webContents.executeJavaScript(`(()=>{
            const saved=appState.browser;appState.browser={session:{state:'ready',sharedAccount:true,pageState:'unchecked',browserOpen:true,label:'共享账号已连接',message:'已复用监控台登录'}};renderBrowser();
            const previousSync=syncGpuCatalog;let syncCalls=0;syncGpuCatalog=()=>{syncCalls++};appState.browser.session.readySince=Date.now();window.dispatchEvent(new Event('appstatechange'));syncGpuCatalog=previousSync;
            const ok=syncCalls===0&&document.querySelector('#open-browser').hidden&&document.querySelector('#check-browser').hidden&&document.querySelector('#autodl-title').textContent==='共享 AutoDL 账号';
            appState.browser=saved;renderBrowser();return ok;
          })()`);
          if(!sharedReady)throw Error('共享登录仍显示重复登录入口');
          if(BrowserWindow.getAllWindows().length!==1)throw new Error('租机不应创建额外窗口');
          await selectTab('messages');await selectTab('dashboard');
          if(rentView.getVisible())throw new Error('离开租机页面后视图未隐藏');
          await selectTab('market');
          const lightPanels=await rentView.webContents.executeJavaScript(`(()=>{
            document.querySelector('[data-mode=create]').click();
            return [...document.querySelectorAll('#task-form *')].filter(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e),c=s.backgroundColor.match(/[\\d.]+/g)?.map(Number);return r.width>100&&r.height>35&&c&&c.length>=3&&(c.length<4||c[3]>.5)&&c[0]>215&&c[1]>215&&c[2]>215;}).map(e=>e.tagName+':'+(e.id||e.className)+':'+e.outerHTML.slice(0,140));
          })()`);
          if(lightPanels.length)throw Error('新建表单仍有浅色大背景：'+lightPanels.join(','));
          await rentView.webContents.executeJavaScript("document.querySelector('.pricing-card').scrollIntoView({block:'start'})");
          await new Promise(resolve=>setTimeout(resolve,200));
          fs.writeFileSync(path.join(app.getPath('temp'),'autodl-pricing-dark-preview.png'),(await rentView.webContents.capturePage()).toPNG());
          await rentView.webContents.executeJavaScript('window.scrollTo(0,0)');
          const shot=await rentView.webContents.capturePage();
          fs.writeFileSync(path.join(app.getPath('temp'),'autodl-rent-workspace-preview.png'),shot.toPNG());
          await selectTab('messages');
          const messageReady=await rentView.webContents.executeJavaScript(`(()=>{
            const saved=appState.notifications;appState.notifications=[{id:'fixture-one',name:'演示 · 开机成功',event:'completed',message:'目标实例已运行',taskId:'fixture',at:Date.now(),read:false,deliveries:{wechat:{ok:true,at:Date.now(),attempts:1}}},{id:'fixture-two',name:'演示 · 通知异常',event:'attention',message:'接口暂时不可用',taskId:'fixture',at:Date.now(),read:true,deliveries:{webhook:{ok:false,attempts:2,error:'HTTP 503',nextAttemptAt:Date.now()+30000}}}];
            renderNotifications();const all=document.querySelectorAll('.notification-item').length===2;
            document.querySelector('#message-status').value='failed';renderNotifications();const failed=document.querySelectorAll('.notification-item').length===1&&document.querySelector('#notification-list').textContent.includes('503');
            document.querySelector('#message-status').value='all';document.querySelector('#message-search').value='开机';renderNotifications();const search=document.querySelectorAll('.notification-item').length===1;
            document.querySelector('#message-search').value='';renderNotifications();const detail=document.querySelector('.notification-item details');detail.open=true;
            const color=getComputedStyle(detail.querySelector('.delivery-detail')).backgroundColor.match(/[\\d.]+/g).map(Number);const dark=Math.max(...color.slice(0,3))<130;
            appState.notifications=saved;renderNotifications();return all&&failed&&search&&dark;
          })()`);
          if(!messageReady)throw Error('消息中心筛选或渠道详情异常');
          fs.writeFileSync(path.join(app.getPath('temp'),'autodl-messages-preview.png'),(await rentView.webContents.capturePage()).toPNG());
          await selectTab('notifications');
          const guideReady=await rentView.webContents.executeJavaScript(`(()=>{document.querySelector('#guide-webhook').click();const opened=document.querySelector('#webhook-help').open;document.querySelector('#guide-wechat').click();return opened&&document.querySelector('#wechat-help').open;})()`);
          if(!guideReady)throw Error('通知配置引导未响应');
          await rentView.webContents.executeJavaScript("document.querySelector('#webhook-help').open=false;document.querySelector('#wechat-help').open=false;window.scrollTo(0,0)");
          await new Promise(resolve=>setTimeout(resolve,250));
          fs.writeFileSync(path.join(app.getPath('temp'),'autodl-notification-guide.png'),(await rentView.webContents.capturePage()).toPNG());
          console.log('RENT WORKSPACE / NOTIFICATION GUIDE SMOKE OK');

        }
        await win.webContents.executeJavaScript("switchTab('dashboard')");
        win.setSize(900,650);
        await new Promise(resolve=>setTimeout(resolve,200));
        const compact=await win.webContents.executeJavaScript("document.documentElement.scrollWidth<=document.documentElement.clientWidth");
        if(!compact)throw new Error('小窗口出现水平溢出');
        await win.webContents.executeJavaScript("render({...current,connected:false,auth:'signedOut',target:'',instances:[],markets:[],balance:null,bills:[],billingAt:null,stockSummary:{value:'—',label:'目标主机空闲 GPU',hint:'请选择实例'}})");
        await new Promise(resolve=>setTimeout(resolve,150));
        const unknown=await win.webContents.executeJavaScript("document.querySelectorAll('.resource-card circle').length===3 && document.querySelectorAll('.resource-card svg text')[0].textContent==='—'");
        if(!unknown)throw new Error('未知资源不应显示为零');
        fs.writeFileSync(path.join(app.getPath('temp'),'autodl-empty-compact-preview.png'),(await win.webContents.capturePage()).toPNG());
        console.log('VISUAL / EMPTY / COMPACT SMOKE OK');
        console.log('SMOKE OK',JSON.stringify(counts));quitting=true;app.quit();
      }catch(e){console.error('SMOKE FAILED',e);fs.writeFileSync(path.join(app.getPath('temp'),'autodl-smoke-error-'+process.pid+'.json'),JSON.stringify({error:e.message,stack:e.stack,resources:process.resourcesPath,at:Date.now()}));app.exit(1);}
    });
  }
  win.on('close',e=>{if(!quitting&&tray){e.preventDefault();win.hide();}});
  const pixels=Buffer.alloc(32*32*4);
  for(let y=0;y<32;y++)for(let x=0;x<32;x++){const k=(y*32+x)*4;pixels[k]=229;pixels[k+1]=125;pixels[k+2]=80;pixels[k+3]=(Math.abs(x-16)+Math.abs(y-16)<14)?255:0;}
  const icon=nativeImage.createFromBitmap(pixels,{width:32,height:32});
  tray=new Tray(icon);tray.setToolTip('AutoDL Companion');updateTray();tray.on('double-click',()=>win.show());
  ipcMain.handle('command',async(event,action,payload)=>{
    if(event.sender!==win.webContents)throw new Error('无效请求来源');
    try{
      if(action==='state')return publicState();
      if(action==='login')await showLogin();
      else if(action==='checkLogin'){await workspaceAction('check');await refresh();}
      else if(action==='logout'){await workspaceAction('logout');persist();log('已退出共享账号，开机监控与租机任务均已停止；已提交结果仍需核实');}
      else if(action==='settings'){const next=core.settings(payload);if(state.watching&&['gpu','region','count'].some(k=>next[k]!==state.settings[k]))throw new Error('监控中只能修改频率和余额阈值，请停止后再改筛选');state.settings=next;balanceAlerted=false;persist();if(state.watching&&!busy){clearTimeout(timer);const delay=core.pollDelay(next.seconds,errors,Math.max(rentWorkspace?.sharedSession.retryUntil||0,stockClient.retryUntil));state.nextCheckAt=Date.now()+delay;timer=setTimeout(loop,delay);}}
      else if(action==='target'){if(state.watching||rentWorkspace?.service.store.tasks().some(t=>t.id===state.homeTask&&['queued','watching','preparing','submitting','verifying'].includes(t.state)))throw new Error('请先停止当前候补再切换目标');state.target=String(payload||'');state.markets=[];state.stockError='';stockClient.retryUntil=0;availabilityKey='';scheduleDataRefresh(0);}
      else if(action==='refresh')await refresh();
      else if(action==='startHome')await startHomeGroup(payload);
      else if(action==='start')startMonitoring(!!payload);
      else if(action==='stop'){halt();const t=rentWorkspace?.service.store.tasks().find(t=>t.id===state.homeTask);if(t&&!['completed','cancelled'].includes(t.state))rentWorkspace.service.engine.control(t,'pause');scheduleDataRefresh();}
      else if(action==='power'){await manualPower(payload);await refresh();}
      else if(action==='balance')await refreshBalance();
      else if(action==='billing')await refreshBilling(true);
      else if(action==='testNotification')notify('测试通知：GPU 空闲、开机结果和低余额提醒将显示在这里');
      else if(action==='updates')await checkUpdates();
      else if(action==='releases')await shell.openExternal('https://github.com/lxuetl/autoautodl/releases');
      else if(action==='copySSH'){const item=state.instances.find(i=>i.id===payload);if(!item?.ssh)throw new Error('尚无 SSH 命令');clipboard.writeText(item.ssh);}
      else if(action==='jupyter'){const item=state.instances.find(i=>i.id===payload);const url=new URL(item?.jupyter?.startsWith('http')?item.jupyter:'https://'+item?.jupyter);if(url.protocol!=='https:'||!(url.hostname==='autodl.com'||url.hostname.endsWith('.autodl.com'))||url.username||url.password)throw new Error('Jupyter 地址无法确认，请使用官方控制台');await shell.openExternal(url.href);}
      else if(action==='clearPending'){if(state.watching)throw new Error('请先停止监控');state.pending=null;persist();log('已手动确认上次请求结果');}
      else if(action==='market')await shell.openExternal('https://www.autodl.com/market/list');
      else if(action==='tab')await selectTab(String(payload));
      else if(action==='copyStockDiagnostics'){clipboard.writeText(JSON.stringify(state.stockDiagnostics||{message:'请先刷新数据'},null,2));log('已复制库存诊断（含 GPU/地区筛选、记录数、字段名和类型，不含实例 ID 或登录凭据）');}
      else if(action==='instances')await shell.openExternal('https://www.autodl.com/console/instance/list');
      emit();return {ok:true};
    }catch(e){log(e.message);return {error:e.message};}
  });
});
let rentClosing=false;
app.on('before-quit',event=>{
  quitting=true;clearTimeout(powerTimer);halt();clearInterval(sessionTimer);clearTimeout(dataTimer);
  if(rentWorkspace){
    event.preventDefault();
    if(!rentClosing){rentClosing=true;rentWorkspace.close().then(()=>{rentWorkspace=null;app.quit();}).catch(e=>{rentClosing=false;log('租机任务尚未安全退出：'+e.message);});}
  }
});
app.on('will-quit',()=>{if(rentView&&!rentView.webContents.isDestroyed())rentView.webContents.close();});
app.on('window-all-closed',()=>app.quit());
