const {test}=require('node:test');
const assert=require('node:assert/strict');
const {SharedSession}=require('./shared-session');
function fixture(fetchImpl=async()=>({status:200,ok:true,json:async()=>({code:'Success',data:[]})})){
  let credential='account-A',state='not_open';const events=[],tasks=[];
  const page={url:()=> 'https://www.autodl.com/console/instance/list',isClosed:()=>false,evaluate:async()=>credential};
  const adapter={page,context:{pages:()=>[page]},sessionStatus:()=>({state,browserOpen:true}),setSession(next){state=next;return this.sessionStatus();},async checkLogin(){this.setSession('ready');return this.sessionStatus();},async checkPage(){this.seenPage=this.page;this.setSession('ready');},async logout(){credential='';this.setSession('not_open');}};
  const service={adapters:{autodl:adapter},wallet:{clearToken:()=>{}},store:{tasks:()=>tasks,create:config=>{const t={config,state:'watching'};tasks.push(t);return t;},log:()=>{}},engine:{busy:false,stopping:false,step:async t=>{t.executed=true;},control:(task,action)=>{task.state=action==='pause'?'paused':'watching';}}};
  const shared=new SharedSession(service,status=>events.push(status),fetchImpl);
  return {shared,adapter,service,events,tasks,setToken:value=>credential=value};
}
test('一次浏览器验证供开机请求和租机任务共用，不暴露凭据给状态回调',async()=>{
  let authorization;
  const f=fixture(async(url,options)=>{authorization=options.headers.Authorization;return {status:200,ok:true,json:async()=>({code:'Success',data:[{uuid:'i'}]})};});
  await assert.rejects(f.shared.request('/instance',{}),/登录/);
  await f.adapter.checkLogin();
  assert.deepEqual(await f.shared.request('/instance',{}),[{uuid:'i'}]);assert.equal(authorization,'account-A');
  const task=f.service.store.create({provider:'autodl'});await f.service.engine.step(task);assert.equal(task.executed,true);
  assert.deepEqual(f.events,['ready']);assert.equal(JSON.stringify(task).includes('account-A'),false);
});
test('租机页退出同步暂停任务，清空共享会话，禁止旧账号请求',async()=>{
  const f=fixture();await f.adapter.checkLogin();const task=f.service.store.create({provider:'autodl'});
  await f.adapter.logout();assert.equal(task.state,'paused');assert.equal(f.shared.credential,'');assert.equal(f.events.at(-1),'not_open');
  await assert.rejects(f.shared.request('/instance',{}),/登录/);
});
test('切换会话后暂停旧任务，并阻止在新账号恢复旧任务',async()=>{
  const f=fixture();await f.adapter.checkLogin();const task=f.service.store.create({provider:'autodl'});
  f.setToken('account-B');await assert.rejects(f.shared.ensure(),/变更/);assert.equal(task.state,'paused');
  assert.throws(()=>f.service.engine.control(task,'resume'),/旧登录会话/);
  const fresh=f.service.store.create({provider:'autodl'});await f.service.engine.step(fresh);assert.equal(fresh.executed,true);
});
test('HTTP 401同步标记浏览器过期并暂停租机任务',async()=>{
  const f=fixture(async()=>({status:401,ok:false}));await f.adapter.checkLogin();const task=f.service.store.create({provider:'autodl'});
  await assert.rejects(f.shared.request('/instance',{}),/失效/);assert.equal(f.adapter.sessionStatus().state,'expired');assert.equal(task.state,'paused');
});
test('退出期间返回的旧请求不能恢复账号数据',async()=>{
  let complete,started;const sent=new Promise(r=>started=r);
  const f=fixture(()=>{started();return new Promise(r=>complete=r);});await f.adapter.checkLogin();
  const pending=f.shared.request('/instance',{});await sent;await f.adapter.logout();complete({status:200,ok:true,json:async()=>({code:'Success',data:['stale']})});
  await assert.rejects(pending,/变化/);
});
test('读图像与型号的临时页面仍使用自己的 page，不被共享会话包装破坏',async()=>{
  const f=fixture();await f.adapter.checkLogin();const view=Object.create(f.adapter);view.page={name:'image-tab'};
  await view.checkPage();assert.equal(view.seenPage,view.page);
});
test('网络异常不会伪装为登录成功，也不会删除浏览器凭据',async()=>{
  const f=fixture(async()=>{throw new Error('offline');});await f.adapter.checkLogin();await assert.rejects(f.shared.request('/instance',{}),/offline/);assert.equal(f.shared.credential,'account-A');
});
test('只从官方来源读取会话，不能使用其他网页的 token',async()=>{
  const f=fixture();f.adapter.page.url=()=> 'https://example.com';assert.equal(await f.shared.readCredential(),'');
});
test('人工登录后自动核验，租机引擎忙时不打断其页面',async()=>{
  const f=fixture();f.service.engine.busy=true;await f.shared.poll();assert.equal(f.events.length,0);
  f.service.engine.busy=false;await f.shared.poll();assert.deepEqual(f.events,['ready']);assert.equal(f.service.engine.busy,false);
});
test('429遵守Retry-After，冷却期间不继续调用平台',async()=>{
  let calls=0;const f=fixture(async()=>{calls++;return {status:429,ok:false,headers:{get:()=> '60'}};});await f.adapter.checkLogin();
  await assert.rejects(f.shared.request('/instance',{}),/限流/);assert.ok(f.shared.retryUntil>Date.now()+59000);
  await assert.rejects(f.shared.request('/instance',{}),/限流/);assert.equal(calls,1);
});
test('余额走GET，关机与账单沿用共享账号，任意接口不可调用',async()=>{
  const requests=[];const f=fixture(async(url,options)=>{requests.push({url,...options});return {status:200,ok:true,json:async()=>({code:'Success',data:url.endsWith('/instance')?[]:{}})};});await f.adapter.checkLogin();
  await f.shared.request('/instance',{});requests.length=0;await f.shared.request('/wallet');await f.shared.request('/instance/power_off',{instance_uuid:'i'});
  assert.equal(requests[0].method,'GET');assert.equal(requests[0].body,undefined);assert.equal(requests[1].method,'POST');assert.equal(requests[1].headers.Authorization,'account-A');
  await assert.rejects(f.shared.request('/instance/delete',{}),/不支持/);
});
test('服务异常带接口和错误码，不清除已验证账号',async()=>{
 const f=fixture(async()=>({status:200,ok:true,json:async()=>({code:'ServiceError',msg:'服务异常，请稍后重试'})}));await f.adapter.checkLogin();
 await assert.rejects(f.shared.request('/instance',{}),/\/instance：服务异常.*ServiceError/);
 assert.equal(f.shared.credential,'account-A');assert.equal(f.adapter.sessionStatus().state,'ready');
});
test('接口请求使用参考项目相同的原生fetch与JSON传输，不依赖浏览器请求上下文',async()=>{
 let sent;const f=fixture(async(url,options)=>{sent=options;return {status:200,ok:true,json:async()=>({code:'Success',data:[]})};});
 f.adapter.context.request={fetch:async()=>{throw new Error('不应走浏览器请求层');}};
 await f.adapter.checkLogin();await f.shared.request('/instance',{page_index:1});assert.equal(sent.method,'POST');assert.equal(sent.body,JSON.stringify({page_index:1}));assert.equal(sent.headers.Origin,undefined);assert.equal(sent.headers.Referer,undefined);
});
test('临时核验错误保留会话，恢复后再次发出ready事件用于自动刷新',async()=>{
 const f=fixture();await f.adapter.checkLogin();f.adapter.setSession('error');assert.equal(f.shared.credential,'account-A');
 await f.adapter.checkLogin();assert.deepEqual(f.events,['ready','error','ready']);
});
test('登录完成后只最小化一次浏览器，后续请求不会反复操作窗口',async()=>{
 const f=fixture();let minimizes=0;f.adapter.setWindowState=async state=>{if(state==='minimized')minimizes++;};
 await f.adapter.checkLogin();await f.shared.request('/instance',{});await f.adapter.checkLogin();assert.equal(minimizes,1);
});
test('实例接口验证成功后，临时网页识别失败不阻断API开机',async()=>{
 const f=fixture();await f.adapter.checkLogin();await f.shared.request('/instance',{});f.adapter.setSession('error');
 assert.deepEqual(await f.shared.request('/instance/power_on',{instance_uuid:'i'}),[]);assert.equal(f.adapter.sessionStatus().state,'error');
});
test('凭据改变后付费接口被拦下，须先重新验证实例接口',async()=>{
 const f=fixture();await f.adapter.checkLogin();await f.shared.request('/instance',{});f.adapter.setSession('error');f.setToken('account-B');
 await assert.rejects(f.shared.request('/instance/power_on',{instance_uuid:'i'}),/变化/);assert.equal(f.shared.apiVerified,'');
});
test('API只读同步不被进行中的DOM核验卡住',async()=>{
 const f=fixture();await f.adapter.checkLogin();f.adapter.setSession('checking');f.shared.checkFlight=new Promise(()=>{});
 assert.deepEqual(await f.shared.request('/instance',{}),[]);assert.equal(f.shared.apiVerified,'account-A');f.shared.checkFlight=null;
});
test('只拿到token但实例列表响应无效时不确认登录，禁止付费操作',async()=>{
 const f=fixture(async()=>({status:200,ok:true,json:async()=>({code:'Success',data:{other:[]}})}));f.adapter.setSession('unchecked');
 await assert.rejects(f.shared.request('/instance',{}),/列表格式/);assert.equal(f.shared.apiVerified,'');
 await assert.rejects(f.shared.request('/instance/power_on',{}),/接口验证/);
});

test('首次接口核验结果可供首页消费一次，窗口最小化不阻塞返回',async()=>{
 const f=fixture();f.adapter.setSession('unchecked');f.adapter.setWindowState=()=>new Promise(()=>{});
 await f.shared.ensureApi();assert.deepEqual(f.shared.takeBootstrap(),[]);assert.equal(f.shared.takeBootstrap(),null);
});
test('旧账号首次核验缓存不能跨注销复用',async()=>{
 const f=fixture();f.adapter.setSession('unchecked');await f.shared.ensureApi();
 f.shared.invalidate('expired');assert.equal(f.shared.takeBootstrap(),null);
});

test('新建页复用接口验证账号但保留页面检查状态',async()=>{
 const f=fixture();f.adapter.setSession('unchecked');await f.shared.ensureApi();
 assert.equal(f.adapter.accountSession().state,'ready');assert.equal(f.adapter.accountSession().pageState,'unchecked');
 await f.shared.ensure();f.adapter.setSession('human_required');assert.equal(f.adapter.accountSession().state,'human_required');await assert.rejects(f.shared.ensure());
});
test('共享账号显示可用后换Token仍拒绝旧任务',async()=>{
 const f=fixture();f.adapter.setSession('unchecked');await f.shared.ensureApi();f.setToken('account-B');await assert.rejects(f.shared.ensure(),/变化/);assert.notEqual(f.adapter.accountSession().state,'ready');
});

test('已验证共享账号后台轮询不再触发网页核验或打开标签页',async()=>{
 const f=fixture();f.adapter.setSession('unchecked');await f.shared.ensureApi();let checks=0;f.adapter.checkLogin=async()=>{checks++};
 await f.shared.poll();assert.equal(checks,0);assert.equal(f.adapter.sessionStatus().state,'unchecked');
});
