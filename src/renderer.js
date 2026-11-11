const $=id=>document.getElementById(id);let current,tab='dashboard',initialized=false;
function text(tag,value){const element=document.createElement(tag);element.textContent=value;return element;}
async function call(action,payload){try{const result=await window.app.call(action,payload);if(result?.error)$('notice').textContent=result.error;return result;}catch(e){$('notice').textContent=e.message;}}
function render(s){current=s;$('connection').textContent=s.connected?'已连接个人账号':'未连接账号';$('demo').textContent=s.demo?'演示模式 · 虚构数据':'';$('nInstances').textContent=s.instances.length;$('nStock').textContent=s.markets.reduce((n,m)=>n+m.idle,0);$('watch').textContent=s.watching?(s.auto?'自动开机中':'监控中'):'未启动';$('updated').textContent=s.updated||'尚未同步';$('pending').hidden=!s.pending;
  if(!initialized){for(const key of ['gpu','region','count','seconds'])$(key).value=s.settings[key];initialized=true;}
  $('target').replaceChildren(new Option('不选实例：按租机条件监控',''),...s.instances.map(i=>new Option(i.name+' · '+i.gpu,i.id)));$('target').value=s.target;
  $('logs').replaceChildren(...s.logs.map(l=>{const row=text('div',l.message);row.className='log';row.prepend(text('time',l.time));return row;}));
  $('instanceList').replaceChildren(...s.instances.map(i=>{const card=document.createElement('article'),details=document.createElement('div');details.append(text('small',i.id),text('h2',i.name),text('p',`${i.gpu} × ${i.count} · ${i.regionName} · ${i.status}`));const button=text('button','监控此实例');button.onclick=async()=>{await call('target',i.id);switchTab('dashboard');};card.append(details,button);return card;}));
  const unknown=s.markets.filter(m=>m.idle===null).length;
  if(unknown)$('nStock').textContent=`${s.markets.reduce((n,m)=>n+(m.idle??0),0)}（${unknown} 条未知）`;
  const issues={negative:'平台上报负库存',fractional:'平台上报非整数',out_of_range:'数值超出有效范围',non_finite:'数值非有限',missing:'字段缺失',invalid_type:'字段类型异常',conflicting:'字段数值冲突'};
  $('marketList').replaceChildren(...s.markets.map(m=>{const card=document.createElement('article');card.append(text('h2',m.gpu||m.id),text('p',`${m.region} · 主机 ${m.id} · 空闲 ${m.idle===null?`暂不可确认（${issues[m.idleIssue]||'未知原因'}）`:m.idle+' 卡'}`));return card;}));
  for(const id of ['instanceList','marketList'])if(!$(id).children.length)$(id).append(text('p','暂无数据，请连接账号并刷新。'));
}
function switchTab(name){tab=name;document.querySelectorAll('.tab').forEach(el=>el.hidden=el.id!==name);document.querySelectorAll('[data-tab]').forEach(b=>b.classList.toggle('active',b.dataset.tab===name));$('heading').textContent={dashboard:'监控台',instances:'我的实例',market:'租机候补',settings:'设置'}[name];}
document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>switchTab(b.dataset.tab));
for(const [id,action] of Object.entries({login:'login',logout:'logout',refresh:'refresh',stop:'stop',marketLink:'market',rentWorkspace:'rentWorkspace',officialInstances:'instances',verify:'instances',copyStockDiagnostics:'copyStockDiagnostics'}))$(id).onclick=()=>call(action);
$('target').onchange=()=>call('target',$('target').value);
$('startAuto').onclick=()=>{if(confirm('确认对所选实例启用自动有卡开机？开机后会按平台规则计费。'))call('start',true);};
$('startWatch').onclick=()=>call('start',false);
$('clearPending').onclick=()=>{if(confirm('你已在官方页面核实上次请求的结果，并确认可以解除锁定？'))call('clearPending');};
$('save').onclick=async()=>{const result=await call('settings',Object.fromEntries(['gpu','region','count','seconds'].map(k=>[k,$(k).value])));if(result?.ok)$('notice').textContent='设置已保存';};
window.app.onState(render);call('state').then(s=>{if(s?.settings){render(s);if(s.demo)call('refresh');}});
