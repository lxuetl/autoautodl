'use strict';
// 唯一会话来源是本应用的专用浏览器。凭据只在主进程内短暂使用，不发送给 UI 或另存一份。
const {createHash}=require('node:crypto');
class SharedSession {
  constructor(service,onChange=()=>{},fetchImpl=globalThis.fetch) {
    this.fetch=fetchImpl;this.retryUntil=0;
    this.service=service;this.adapter=service.adapters.autodl;this.onChange=onChange;
    this.credential='';this.epoch=0;this.last='';this.polling=false;this.nextCheck=0;this.checkFlight=null;this.apiVerified='';this.minimizedCredential='';
    const adapter=this.adapter;
    adapter.accountSession=()=>{
      const page=adapter.sessionStatus();
      if(this.apiVerified&&this.apiVerified===this.credential&&page.browserOpen&&!['expired','login_required','human_required','closed','not_open'].includes(page.state))
        return {...page,state:'ready',sharedAccount:true,pageState:page.state,label:'共享账号已连接',message:'已复用监控台的 AutoDL 登录，无需再次登录；执行前会自动检查页面。'};
      return {...page,sharedAccount:true};
    };
    const originalSet=adapter.setSession.bind(adapter);
    adapter.setSession=(state,options)=>{
      const result=originalSet(state,options);
      if(['expired','login_required','not_open','closed','human_required','error','network_blocked','unknown'].includes(state))this.invalidate(state);
      return result;
    };
    const check=adapter.checkLogin.bind(adapter);
    adapter.checkLogin=(options)=>{
      if(this.checkFlight)return this.checkFlight;
      const operation=(async()=>{const result=await check(options);if(adapter.sessionStatus().state==='ready')await this.ensure({skipWait:true});return result;})();
      this.checkFlight=operation;
      operation.finally(()=>{if(this.checkFlight===operation)this.checkFlight=null;}).catch(()=>{});
      return operation;
    };
    const shared=this,checkPage=adapter.checkPage;
    adapter.checkPage=async function(){const result=await checkPage.call(this);await shared.ensure();return result;};
    const logout=adapter.logout.bind(adapter);
    adapter.logout=async()=>{this.invalidate('not_open');service.wallet?.clearToken();return logout();};
    const create=service.store.create.bind(service.store);
    service.store.create=(config,options)=>{if(!this.credential)throw new Error('请先验证共享账号');return create({...config,sharedSession:this.key()},options);};
    const step=service.engine.step.bind(service.engine);
    service.engine.step=async task=>{
      try{await this.ensure();this.assertTask(task);}catch(error){this.pause();service.store.log(task,'warn',error.message);return;}
      return step(task);
    };
    const control=service.engine.control.bind(service.engine);
    service.engine.control=(task,action,value)=>{if(action==='resume')this.assertTask(task);return control(task,action,value);};
    for(const name of ['attach','recheck'])if(typeof service.engine[name]==='function'){
      const original=service.engine[name].bind(service.engine);
      service.engine[name]=async(task,...args)=>{await this.ensure();this.assertTask(task);return original(task,...args);};
    }
  }
  key(){return this.credential?createHash('sha256').update(this.credential).digest('hex'):'';}
  assertTask(task){if(!this.credential||task.config.sharedSession!==this.key())throw new Error('此任务属于旧登录会话，不能在当前账号继续执行；请核实旧提交结果后重新建立任务');}
  pause(){
    for(const task of this.service.store.tasks())if(task.config.provider==='autodl'&&['queued','watching','preparing','submitting','verifying'].includes(task.state))this.service.engine.control(task,'pause');
  }
  publish(status){if(status!==this.last){this.last=status;this.onChange(status);}}
  invalidate(status='expired'){
    if(this.credential&&!['error','network_blocked','unknown'].includes(status)){this.epoch++;this.credential='';}
    if(!['error','network_blocked','unknown'].includes(status)){this.apiVerified='';this.service.wallet?.clearToken();}
    this.pause();if(!this.apiVerified||!['error','network_blocked','unknown'].includes(status))this.publish(status);
  }
  async readCredential(){
    const adapter=this.adapter;
    if(!adapter.context||!adapter.page||adapter.page.isClosed())return '';
    const page=[adapter.sessionPage,adapter.page,...adapter.context.pages()].find(p=>{
      if(!p||p.isClosed())return false;
      try{return new URL(p.url()).origin==='https://www.autodl.com';}catch{return false;}
    });
    if(!page)return '';
    return page.evaluate(()=>location.origin==='https://www.autodl.com'?(localStorage.getItem('token')||''):'');
  }
  async ensure({readOnly=false,skipWait=false}={}){
    if(this.checkFlight&&!skipWait)await this.checkFlight;
    const status=this.adapter.sessionStatus().state;
    const priorRead=(readOnly||this.apiVerified===this.credential&&!!this.apiVerified)&&!!this.credential&&['checking','error','network_blocked','unknown','unchecked'].includes(status);
    if(status!=='ready'&&!priorRead){const error=new Error(['checking','error','network_blocked','unknown','unchecked'].includes(status)?'共享会话正在核验，暂缓操作并自动重试':'账号需要登录或人工验证');error.code='SESSION_NOT_READY';throw error;}

    const credential=await this.readCredential();
    if(!credential){this.adapter.setSession('login_required',{checked:true});throw new Error('登录凭据不可用，请重新登录');}
    if(priorRead&&credential!==this.credential){this.invalidate('changed');throw new Error('会话凭据发生变化，等待重新核验');}
    if(credential!==this.credential){
      const changed=!!this.credential;this.epoch++;this.credential=credential;
      if(changed){this.pause();this.service.wallet?.clearToken();this.publish('changed');this.adapter.prepared=null;this.adapter.probed=null;}
      this.publish('ready');
      await this.minimizeOnce(credential);
      if(changed)throw new Error('登录会话已变更，已暂停旧任务；请刷新并重新选择实例');
    }
    if(!priorRead)this.publish('ready');
    return credential;
  }
  async minimizeOnce(credential){if(this.minimizedCredential===credential)return;this.minimizedCredential=credential;await this.adapter.setWindowState?.('minimized');}
  takeBootstrap(){
    const value=this.bootstrap;this.bootstrap=null;
    return value&&value.epoch===this.epoch&&Date.now()-value.at<5000?value.data:null;
  }
  async ensureApi(){
    await this.request('/instance',{date_from:'',date_to:'',page_index:1,page_size:100,status:[],charge_type:[]});
  }
  async poll(){
    if(this.polling||this.service.engine.busy||this.service.engine.stopping)return;
    this.polling=true;
    try{
      const credential=await this.readCredential();
      if(!credential){if(this.credential)this.adapter.setSession('login_required',{checked:true});return;}
      if(this.apiVerified===credential&&this.credential===credential)return;
      if((credential!==this.credential||this.adapter.sessionStatus().state!=='ready')&&Date.now()>=this.nextCheck){
        this.nextCheck=Date.now()+(this.apiVerified?30000:5000);
        // 与租机引擎共享互斥，人工登录完成后自动核验，不干扰正在提交的页面。
        if(!['human_required','expired','closed','not_open'].includes(this.adapter.sessionStatus().state)&&this.apiVerified!==credential)await this.ensureApi().catch(()=>{});
        if(this.apiVerified===credential)return;
        this.service.engine.busy=true;
        try{await this.adapter.checkLogin({interactive:false});}finally{this.service.engine.busy=false;}
      }
    }finally{this.polling=false;}
  }
  async request(endpoint,body){
    if(!['/instance','/user/machine/list','/instance/power_on','/instance/power_off','/wallet','/bill/list'].includes(endpoint))throw new Error('不支持的共享账号请求');
    if(Date.now()<this.retryUntil){const error=new Error('平台限流，等待后重试');error.retryUntil=this.retryUntil;throw error;}
    // 与参考项目一致，接口登录以实例接口的成功响应为依据，不依赖网页布局识别。
    const status=this.adapter.sessionStatus().state;
    if(['human_required','expired','closed','not_open'].includes(status))throw new Error('账号需要登录或人工验证');
    const credential=await this.readCredential();
    if(!credential)throw new Error('请先在专用浏览器登录 AutoDL');
    const changed=!!this.credential&&credential!==this.credential;
    if(changed){this.pause();this.service.wallet?.clearToken();this.apiVerified='';this.publish('changed');this.adapter.prepared=null;this.adapter.probed=null;}
    if(credential!==this.credential){this.epoch++;this.credential=credential;}
    if(changed&&endpoint!=='/instance')throw new Error('会话已变化，先重新同步实例');
    if(endpoint!=='/instance'&&this.apiVerified!==credential&&(status!=='ready'||['/instance/power_on','/instance/power_off'].includes(endpoint)))throw new Error('账号尚未通过接口验证，正在等待实例同步');
    const epoch=this.epoch,url='https://www.autodl.com/api/v1'+endpoint,method=endpoint==='/wallet'?'GET':'POST';
    const headers={Authorization:credential,Accept:'application/json, text/plain, */*','User-Agent':'AutoDL-Companion/0.6.5 (Windows)',...(method==='POST'?{'Content-Type':'application/json;charset=UTF-8'}:{})};
    let response;
    try{response=await this.fetch(url,{method,headers,body:method==='POST'?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000)});}
    catch(error){throw new Error(endpoint+' 请求未完成：'+(error.name==='TimeoutError'?'超时':String(error.message).slice(0,100)));}

    if(epoch!==this.epoch)throw new Error('登录会话已变化，本次结果已丢弃');
    if([401,403].includes(response.status)){this.adapter.setSession('expired',{checked:true});throw new Error('登录已失效，请重新登录');}
    if(response.status===429){
      const retry=response.headers?.get('retry-after'),seconds=Number(retry);
      this.retryUntil=Math.max(Date.now()+30000,Number.isFinite(seconds)&&seconds>0?Date.now()+seconds*1000:Date.parse(retry)||0);
      const error=new Error('平台限流，已按 Retry-After 延后检查');error.retryUntil=this.retryUntil;throw error;
    }
    if(!response.ok)throw new Error(endpoint+'：AutoDL 返回 HTTP '+response.status);
    let json;try{json=await response.json();}catch{throw new Error(endpoint+'：平台返回的不是有效 JSON');}
    if(epoch!==this.epoch)throw new Error('登录会话已变化，本次结果已丢弃');
    if(!['Success','success','0'].includes(String(json.code))){
      if(/Authorize|Unauthorized/i.test(String(json.code))||/重新登录|登录超时/.test(json.msg||''))this.adapter.setSession('expired',{checked:true});
      const error=new Error(endpoint+'：'+String(json.msg||json.message||'接口请求失败').slice(0,150)+'（code: '+String(json.code).slice(0,40)+'）');error.apiCode=String(json.code);error.endpoint=endpoint;throw error;
    }
    if(endpoint==='/instance'){
      const data=json.data,list=Array.isArray(data)?data:data?.list;
      if(!Array.isArray(list))throw new Error('实例列表格式无法识别，不能确认登录有效');
      const first=this.apiVerified!==credential;this.apiVerified=credential;
      if(first&&body?.page_index===1&&body?.page_size===100)this.bootstrap={data:json.data,epoch:this.epoch,at:Date.now()};
      this.publish('ready');
      if(first)void this.minimizeOnce(credential).catch(()=>{});
    }
    return json.data;
  }
}
module.exports={SharedSession};
