'use strict';
const {app,BrowserWindow,ipcMain,safeStorage,session,shell,Notification,Tray,Menu,nativeImage,clipboard} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const core = require('./core');
const demo = process.argv.includes('--demo');
if(!app.requestSingleInstanceLock()){app.exit(0);}
app.on('second-instance',()=>{if(win){win.show();win.focus();}});
let win,login,tray,token='',timer,busy=false,quitting=false,generation=0,errors=0;
let rentWorkspace=null,rentWindow=null,rentOpening=null;
async function openRentWorkspace(){
  if(demo&&!process.argv.includes('--workspace-smoke'))throw new Error('演示模式不会启动真实租机工作台，请正常启动应用后使用');
  if(rentOpening)return rentOpening;
  rentOpening=(async()=>{
    if(rentWindow&&!rentWindow.isDestroyed()){rentWindow.show();rentWindow.focus();return;}
    if(!rentWorkspace){
      const {createRentWorkspace}=require('./rent-workspace');
      const runtimeDir=demo?fs.mkdtempSync(path.join(app.getPath('temp'),'autodl-workspace-smoke-')):path.join(app.getPath('userData'),'rent-workspace');
      rentWorkspace=await createRentWorkspace(runtimeDir);
    }
    rentWindow=new BrowserWindow({width:1280,height:880,minWidth:980,minHeight:700,title:'AutoDL Companion · 新建与克隆工作台',webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
    const localOrigin=rentWorkspace.url;
    rentWindow.webContents.on('will-navigate',(event,url)=>{if(new URL(url).origin!==localOrigin)event.preventDefault();});
    rentWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    rentWindow.on('closed',()=>{rentWindow=null;log('租机工作台窗口已关闭；已启动的候补任务仍在后台运行');});
    await rentWindow.loadURL(localOrigin);
    log('已打开新建与克隆工作台；请在工作台连接专用浏览器');
  })();
  try{return await rentOpening;}finally{rentOpening=null;}
}
let state={demo,connected:false,watching:false,auto:false,target:'',instances:[],markets:[],logs:[],pending:null,updated:null,settings:{seconds:45,count:1,gpu:'RTX 4090',region:''}};
const file=()=>path.join(app.getPath('userData'),'profile.json');
let availabilityKey='';
let stockWarningKey='';
function persist(){
  if(demo)return;
  const sealed=token ? safeStorage.encryptString(token).toString('base64') : '';
  const content=JSON.stringify({sealed,settings:state.settings,pending:state.pending});
  fs.writeFileSync(file()+'.tmp',content,{mode:0o600});fs.renameSync(file()+'.tmp',file());
}
function emit(){if(win&&!win.isDestroyed())win.webContents.send('state',state);}
function log(message){state.logs.unshift({time:new Date().toLocaleTimeString('zh-CN'),message});state.logs=state.logs.slice(0,150);emit();}
function notify(message){if(Notification.isSupported())new Notification({title:'AutoDL Companion',body:message}).show();}
function halt(){generation++;clearTimeout(timer);state.watching=false;state.auto=false;emit();}
async function request(endpoint,body){
  if(!token)throw new Error('请先登录 AutoDL');
  const response=await fetch('https://www.autodl.com/api/v1'+endpoint,{method:'POST',headers:{Authorization:token,'Content-Type':'application/json;charset=UTF-8'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
  if([401,403].includes(response.status)){halt();state.connected=false;throw new Error('登录失效，请重新登录');}
  if(!response.ok)throw new Error('AutoDL 返回 HTTP '+response.status);
  const json=await response.json();
  if(!['Success','success','0'].includes(String(json.code))){
    if(/Authorize|Unauthorized/i.test(String(json.code))||/重新登录|登录超时/.test(json.msg||'')){halt();state.connected=false;}
    throw new Error(String(json.msg||json.code||'接口请求失败').slice(0,200));
  }
  return json.data;
}
async function pages(endpoint,body){
  const result=[];
  for(let page=1;page<=20;page++){
    const data=await request(endpoint,{...body,page_index:page,page_size:100});
    const list=core.listOf(data);result.push(...list);
    if(list.length<100||Number(data.max_page)===page)return result;
  }
  throw new Error('列表超过读取上限，请缩小筛选条件');
}
async function refresh(){
  if(busy)return;busy=true;const run=generation;
  try{
    if(demo){
      state.instances=[{id:'demo-instance',name:'训练实验 · 示例',status:'shutdown',machine:'demo-host',gpu:'RTX 4090',count:1,region:'westDC3',regionName:'西北B区'}];
      state.markets=[{id:'demo-host',gpu:'RTX 4090',idle:2,region:'西北B区'}];
    }else{
      const raw=await pages('/instance',{status:[],charge_type:[],date_from:'',date_to:''});
      if(run!==generation)return;
      state.instances=raw.map(core.instance);
      const selected=state.instances.find(i=>i.id===state.target);
      const body={default_order:true,gpu_idle_num:selected?selected.count:state.settings.count};
      const gpu=selected?.gpu||state.settings.gpu,region=selected?.region||state.settings.region;
      if(gpu)body.gpu_type_name=[gpu];if(region)body.region_sign_list=[region];if(selected?.charge)body.charge_type=selected.charge;
      const machines=await pages('/user/machine/list',body);
      if(run!==generation)return;
      state.markets=machines.map(core.stock); // 原始响应和实例密码不发送给界面
      const unknown=state.markets.filter(m=>m.idle===null);
      state.stockDiagnostics={version:app.getVersion(),records:state.markets.length,unknown:unknown.length,schemas:[...new Set(unknown.map(m=>m.schema.join(', ')))].slice(0,5)};
      const warningKey=JSON.stringify(state.stockDiagnostics.schemas);
      if(unknown.length&&warningKey!==stockWarningKey)log(`${unknown.length} 条主机库存格式未知，已禁止据此自动开机；可复制库存诊断反馈`);
      stockWarningKey=warningKey;
      const available=selected?state.markets.filter(m=>m.id===selected.machine&&m.idle>=selected.count):state.markets.filter(m=>m.idle>=state.settings.count);
      const key=available.map(m=>m.id).sort().join(',');
      if(state.watching&&key&&key!==availabilityKey){log('发现符合条件的空闲 GPU');notify('发现符合条件的空闲 GPU，请查看监控台');}
      availabilityKey=key;
      if(state.pending){
        const item=state.instances.find(i=>i.id===state.pending.id);
        if(item&&['running','starting','powering_on'].includes(item.status)){state.pending=null;persist();log('实例已进入 '+item.status);halt();}
      }
      if(state.watching&&state.auto&&selected&&!state.pending){
        const available=state.markets.find(m=>m.id===selected.machine);
        if(available&&core.canStart(selected,available)&&run===generation)await powerOn(selected);
      }
    }
    if(run!==generation)return;
    state.updated=new Date().toLocaleString('zh-CN');errors=0;emit();
  }catch(e){errors++;log('同步失败：'+e.message);}
  finally{busy=false;}
}
async function powerOn(item){
  if(demo){log('演示模式：模拟开机请求');return;}
  if(state.pending)throw new Error('存在待核实的开机请求，请先核实状态');
  // 写入磁盘后才发送；网络中断、应用重启均不会重复提交。
  state.pending={id:item.id,time:Date.now()};persist();emit();
  try{await request('/instance/power_on',{instance_uuid:item.id,payload:'gpu'});log('开机请求已接受，等待状态确认');notify(item.name+' 的开机请求已接受');}
  catch(e){log('开机结果待核实：'+e.message);state.auto=false;emit();}
}
async function loop(){
  const run=generation;await refresh();
  if(state.watching&&run===generation)timer=setTimeout(loop,Math.min(600,state.settings.seconds*Math.pow(2,Math.min(errors,4)))*1000);
}
function showLogin(){
  if(demo)return;
  if(login&&!login.isDestroyed()){login.focus();return;}
  login=new BrowserWindow({width:1040,height:760,parent:win,webPreferences:{partition:'persist:autodl-login',nodeIntegration:false,contextIsolation:true,sandbox:true}});
  const allowed=url=>{try{const u=new URL(url);return u.protocol==='https:'&&(u.hostname==='autodl.com'||u.hostname.endsWith('.autodl.com'));}catch{return false;}};
  login.webContents.on('will-navigate',(e,url)=>{if(!allowed(url))e.preventDefault();});
  login.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  const capture=async()=>{
    if(!login||login.isDestroyed()||!allowed(login.webContents.getURL()))return;
    const candidate=await login.webContents.executeJavaScript("localStorage.getItem('token')").catch(()=>null);
    if(candidate&&typeof candidate==='string'&&candidate.length>10){
      if(!safeStorage.isEncryptionAvailable())throw new Error('系统凭据加密不可用');
      token=candidate;state.connected=true;persist();login.close();log('已连接 AutoDL，凭据已在本机加密保存');await refresh();
    }
  };
  login.webContents.on('did-finish-load',()=>capture().catch(e=>log(e.message)));
  login.webContents.on('did-navigate-in-page',()=>capture().catch(e=>log(e.message)));
  login.loadURL('https://www.autodl.com/login?url=/console/instance/list');
}
app.whenReady().then(()=>{
  if(!demo){try{const stored=JSON.parse(fs.readFileSync(file(),'utf8'));state.settings=core.settings(stored.settings);state.pending=stored.pending||null;if(stored.sealed&&safeStorage.isEncryptionAvailable())token=safeStorage.decryptString(Buffer.from(stored.sealed,'base64'));state.connected=!!token;}catch{}}
  else state.connected=true;
  win=new BrowserWindow({width:1180,height:820,minWidth:900,minHeight:650,backgroundColor:'#10141f',webPreferences:{preload:path.join(__dirname,'preload.js'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',e=>e.preventDefault());
  win.loadFile(path.join(__dirname,'index.html'));
  if(demo&&process.argv.includes('--smoke')){
    win.webContents.on('did-finish-load',async()=>{
      try{
        await refresh();
        await new Promise(resolve=>setTimeout(resolve,1000));
        const counts=await win.webContents.executeJavaScript("({cards:document.querySelectorAll('#instanceList article').length, heading:document.getElementById('heading').textContent})");
        if(counts.cards!==1)throw new Error('演示实例未渲染');
        const image=await win.webContents.capturePage();fs.writeFileSync(app.isPackaged?path.join(app.getPath('temp'),'autodl-companion-preview.png'):path.join(__dirname,'..','preview.png'),image.toPNG());
        if(process.argv.includes('--workspace-smoke')){
          await openRentWorkspace();
          await new Promise(resolve=>setTimeout(resolve,1200));
          const ready=await rentWindow.webContents.executeJavaScript("!!document.querySelector('meta[name=\"local-token\"]') && document.body.innerText.includes('AutoDL')");
          if(!ready)throw new Error('租机工作台未渲染');
          const shot=await rentWindow.webContents.capturePage();
          fs.writeFileSync(path.join(app.getPath('temp'),'autodl-rent-workspace-preview.png'),shot.toPNG());
          console.log('RENT WORKSPACE SMOKE OK');
        }
        console.log('SMOKE OK',JSON.stringify(counts));quitting=true;app.quit();
      }catch(e){console.error('SMOKE FAILED',e);app.exit(1);}
    });
  }
  win.on('close',e=>{if(!quitting&&tray){e.preventDefault();win.hide();}});
  const pixels=Buffer.alloc(32*32*4);
  for(let y=0;y<32;y++)for(let x=0;x<32;x++){const k=(y*32+x)*4;pixels[k]=229;pixels[k+1]=125;pixels[k+2]=80;pixels[k+3]=(Math.abs(x-16)+Math.abs(y-16)<14)?255:0;}
  const icon=nativeImage.createFromBitmap(pixels,{width:32,height:32});
  tray=new Tray(icon);tray.setToolTip('AutoDL Companion');tray.setContextMenu(Menu.buildFromTemplate([{label:'打开主窗口',click:()=>win.show()},{label:'停止监控',click:halt},{label:'退出',click:()=>{quitting=true;app.quit();}}]));tray.on('double-click',()=>win.show());
  ipcMain.handle('command',async(event,action,payload)=>{
    if(event.sender!==win.webContents)throw new Error('无效请求来源');
    try{
      if(action==='state')return state;
      if(action==='login')showLogin();
      else if(action==='logout'){halt();token='';state.connected=false;state.instances=[];state.markets=[];state.target='';persist();await session.fromPartition('persist:autodl-login').clearStorageData();}
      else if(action==='settings'){if(state.watching)throw new Error('请先停止监控再修改条件');state.settings=core.settings(payload);persist();}
      else if(action==='target'){if(state.watching)throw new Error('请先停止监控再切换目标');state.target=String(payload||'');}
      else if(action==='refresh')await refresh();
      else if(action==='start'){if(!state.connected)throw new Error('请先登录');if(state.pending)throw new Error('请先核实上次开机请求');if(payload&&!state.instances.some(i=>i.id===state.target))throw new Error('请先选择实例');halt();state.watching=true;state.auto=!!payload;log(state.auto?'已开启库存监控与自动开机':'已开启库存监控');loop();}
      else if(action==='stop')halt();
      else if(action==='clearPending'){if(state.watching)throw new Error('请先停止监控');state.pending=null;persist();log('已手动确认上次请求结果');}
      else if(action==='market')await shell.openExternal('https://www.autodl.com/market/list');
      else if(action==='rentWorkspace')await openRentWorkspace();
      else if(action==='copyStockDiagnostics'){clipboard.writeText(JSON.stringify(state.stockDiagnostics||{message:'请先刷新数据'},null,2));log('已复制库存诊断（仅记录数、字段名和类型，不含字段值或登录凭据）');}
      else if(action==='instances')await shell.openExternal('https://www.autodl.com/console/instance/list');
      emit();return {ok:true};
    }catch(e){log(e.message);return {error:e.message};}
  });
});
let rentClosing=false;
app.on('before-quit',event=>{
  quitting=true;halt();
  if(rentWorkspace){
    event.preventDefault();
    if(!rentClosing){rentClosing=true;rentWorkspace.close().then(()=>{rentWorkspace=null;app.quit();}).catch(e=>{rentClosing=false;log('租机任务尚未安全退出：'+e.message);});}
  }
});
app.on('window-all-closed',()=>app.quit());
