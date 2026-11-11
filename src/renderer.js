const $=id=>document.getElementById(id);let current,tab='dashboard',initialized=false,billDay='',cloneSourceKey='';
function text(tag,value){const element=document.createElement(tag);element.textContent=value;return element;}
async function call(action,payload){try{const result=await window.app.call(action,payload);if(result?.error)$('notice').textContent=result.error;return result;}catch(e){$('notice').textContent=e.message;}}
function render(s){current=s;const labels={queued:'排队中',watching:'等待库存',preparing:'准备提交',submitting:'正在提交',verifying:'已停止抢卡，等待实例就绪',completed:'已完成',attention:'需要处理',paused:'已暂停',cancelled:'已取消',expired:'已到期',reconciling:'核对提交结果'};const rows=(s.rentalTasks||[]).map(t=>`${t.mode==='clone'?'克隆':'新租'} · ${labels[t.state]||t.state} · ${t.progress} ${t.result}`);if(s.oneMachine)rows.unshift('只抢一台 · '+(s.oneMachine.done?'已完成，其他候补已停止':'已锁定一条提交，其他候补等待')+' · '+s.oneMachine.owner);if(s.pending||s.watching)rows.unshift('已有实例开机 · '+(s.pending?'已提交，自动核实中':'等待库存')+' · '+(s.pending?.id||s.target));$('allTasks').replaceChildren(...(rows.length?rows:['暂无任务']).map(row=>text('p',row)));$('connection').textContent={signedOut:'共享账号：未登录',checking:'共享账号：正在验证',verified:'共享账号：登录已验证',expired:'共享账号：登录已失效',unverified:'共享账号：暂无法验证',demo:'演示数据 · 未连接真实账号'}[s.auth]||'共享账号：未验证';$('refresh').disabled=s.syncing;$('refresh').textContent=s.syncing?'正在同步…':'刷新数据';$('startAuto').disabled=!s.connected||s.syncing||!s.target;$('startWatch').disabled=!s.connected||s.syncing||!s.target;$('syncStatus').textContent=s.lastError|| (s.syncing?'正在核验账号并同步数据…':s.updated?'最近同步：'+s.updated:'尚未同步');$('demo').textContent=s.demo?'演示模式 · 虚构数据':'';$('nInstances').textContent=s.instances.length;$('nStock').textContent=s.stockSummary.value;$('stockLabel').textContent=s.stockSummary.label;$('stockHint').textContent=s.stockSummary.hint;$('watch').textContent=s.watching?(s.auto?'自动开机中':'监控中'):'未启动';$('updated').textContent=s.updated||'尚未同步';$('pending').hidden=!s.pending;if(s.pending)$('pending').querySelector('p').textContent=!s.connected?'待核实的电源请求：登录后自动继续核实。':s.pending.error?'自动核实暂时失败，将继续重试：'+s.pending.error:'正在自动核实电源请求，每 5 秒检查实例状态。当前：'+(s.pending.status||'等待平台返回')+'。确认完成后自动解除锁定。';
  if(!initialized){for(const key of ['gpu','region','count','seconds','lowBalance'])$(key).value=s.settings[key];initialized=true;}
  $('target').replaceChildren(new Option('请选择已有实例',''),...s.instances.map(i=>new Option(i.name+' · '+i.gpu,i.id)));$('target').value=s.target;syncHomeSource();
  $('logs').replaceChildren(...s.logs.map(l=>{const row=text('div',l.message);row.className='log';row.prepend(text('time',l.time));return row;}));
  renderAccount(s);
  $('dashboardBalance').textContent='现金余额 '+money(s.balance?.cash)+(s.balanceError?' · 查询失败：'+s.balanceError:s.balance?' · '+new Date(s.balance.at).toLocaleTimeString():' · 尚未查询');
  const selected=s.instances.find(i=>i.id===s.target),host=selected?s.markets.find(m=>m.id===selected.machine):null;
  $('gpuSlots').textContent=host?'目标主机：空闲 '+(host.idle??'未知')+' / 总卡数 '+(host.total??'未知')+(Number.isSafeInteger(host.total)&&host.total>0&&host.total<=32&&Number.isSafeInteger(host.idle)?'　'+Array.from({length:host.total},(_,i)=>i<host.idle?'▣':'□').join(' '):''):'';
  $('instanceList').replaceChildren(...s.instances.map(i=>{const card=document.createElement('article'),details=document.createElement('div');details.append(text('small',i.id),text('h2',i.name),text('p',`${i.gpu} × ${i.count} · ${i.regionName} · ${i.status}`));details.append(text('p',resourceText(i)));const actions=document.createElement('div');actions.className='actions';const button=text('button','监控此实例');button.onclick=async()=>{await call('target',i.id);switchTab('dashboard');};actions.append(button);for(const [action,label] of [['on','开机'],['off','关机']]){const b=text('button',label);b.disabled=!s.connected||s.syncing||s.actionBusy||!!s.pending||(action==='on'?!['shutdown','stopped','poweroff','power_off'].includes(i.status):i.status!=='running');b.onclick=()=>{if(confirm(action==='off'?`确认关机“${i.name}”？正在运行的训练会中断。`:`确认给“${i.name}”有卡开机？平台将按规则计费。`))call('power',{id:i.id,action});};actions.append(b);}if(i.ssh){const b=text('button','复制 SSH');b.onclick=()=>call('copySSH',i.id);actions.append(b);}if(i.jupyter){const b=text('button','Jupyter');b.onclick=()=>call('jupyter',i.id);actions.append(b);}const release=text('button','前往控制台释放');release.onclick=()=>call('instances');actions.append(release);card.append(details,actions);return card;}));
  const issues={negative:'平台上报负库存',fractional:'平台上报非整数',out_of_range:'数值超出有效范围',non_finite:'数值非有限',missing:'字段缺失',invalid_type:'字段类型异常',conflicting:'字段数值冲突'};
  $('marketList').replaceChildren(...s.markets.map(m=>{const card=document.createElement('article');card.append(text('h2',m.gpu||m.id),text('p',`${m.region} · 主机 ${m.id} · 空闲 ${m.idle===null?`暂不可确认（${issues[m.idleIssue]||'未知原因'}）`:m.idle+' 卡'}`));return card;}));
  for(const id of ['instanceList','marketList'])if(!$(id).children.length)$(id).append(text('p',s.syncing?'正在读取，请稍候…':!s.connected?'登录验证成功后显示数据。':s.updated?'当前查询没有记录。':'尚未同步，请刷新数据。'));
}
function switchTab(name){tab=name;document.querySelectorAll('.tab').forEach(el=>el.hidden=el.id!==name);document.querySelectorAll('[data-tab]').forEach(b=>b.classList.toggle('active',b.dataset.tab===name));$('heading').textContent={dashboard:'监控台',instances:'我的实例',market:'租机候补',settings:'设置',billing:'余额与账单',messages:'消息中心',ai:'AI 环境与选卡',notifications:'通知设置'}[name];document.body.classList.toggle('rent-mode',['market','messages','ai','notifications'].includes(name));call('tab',name);}
document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>switchTab(b.dataset.tab));
for(const [id,action] of Object.entries({login:'login',checkLogin:'checkLogin',logout:'logout',refresh:'refresh',stop:'stop',marketLink:'market',officialInstances:'instances',verify:'instances',copyStockDiagnostics:'copyStockDiagnostics',refreshBalance:'balance',refreshBilling:'billing',testNotification:'testNotification',updates:'updates',releases:'releases'}))$(id).onclick=()=>call(action);
$('target').onchange=()=>call('target',$('target').value);
function syncHomeSource(force=false){
 const i=current?.instances.find(i=>i.id===current.target),key=JSON.stringify([i?.id,i?.gpu,i?.count,i?.regionName]);
 $('homeClone').hidden=$('homeMode').value==='power';document.querySelectorAll('[data-home-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.homeMode===$('homeMode').value)));
 const inherit=$('cloneInherit').checked;
 if(force||key!==cloneSourceKey){
   if(force||i?.id!==JSON.parse(cloneSourceKey||'[]')[0]){$('cloneInherit').checked=true;$('cloneExtra').value=0;}
   if($('cloneInherit').checked){$('cloneGpu').value=i?.gpu||'';$('cloneCards').value=i?.count||'';}
   $('cloneRegion').value=i?.regionName||'';cloneSourceKey=key;
 }
 $('cloneGpu').disabled=$('cloneInherit').checked;$('cloneCards').disabled=$('cloneInherit').checked;
 $('cloneSourceSummary').textContent=i?'克隆源：'+i.name+' · '+i.gpu+' × '+i.count+' · '+i.regionName+'。系统盘环境自动继承；提交前重新核验源实例。':'请先选择源实例，配置将自动带入。';
}
$('homeMode').onchange=()=>syncHomeSource();
document.querySelectorAll('[data-home-mode]').forEach(b=>b.onclick=()=>{$('homeMode').value=b.dataset.homeMode;syncHomeSource();});
$('cloneInherit').onchange=()=>{if($('cloneInherit').checked)syncHomeSource(true);else syncHomeSource();};
$('startAuto').onclick=()=>{const mode=$('homeMode').value;const message={power:'仅等待已有实例开机，不克隆。',clone:'仅克隆选中的源实例，不给源实例开机。',both:'同时等待开机与克隆，只抢一台；两边都有资源时优先开机。'}[mode];if(!confirm(message+'确认开始？开机按原实例计费，克隆 GPU 和磁盘均按 AutoDL 当前官方报价计费。'))return;call('startHome',{mode,paidConsent:true,clone:{inheritSource:$('cloneInherit').checked,gpuModel:$('cloneGpu').value,gpuCount:Number($('cloneCards').value),extraDiskGB:Number($('cloneExtra').value),copyDataDisk:$('cloneCopy').checked}});};
$('startWatch').onclick=()=>call('start',false);
$('clearPending').onclick=()=>{if(confirm('你已在官方页面核实上次请求的结果，并确认可以解除锁定？'))call('clearPending');};
$('save').onclick=async()=>{const result=await call('settings',Object.fromEntries(['gpu','region','count','seconds','lowBalance'].map(k=>[k,$(k).value])));if(result?.ok)$('notice').textContent='设置已保存';};
window.app.onState(s=>render(s));call('state').then(s=>{if(s?.settings){render(s);if(s.demo)call('refresh');}});

function storage(value){return Number.isFinite(value)?(value/2**30).toFixed(1)+' GiB':'未知';}
function resourceText(i){
  const remaining=(total,used)=>Number.isFinite(total)&&Number.isFinite(used)?storage(Math.max(0,total-used))+' / '+storage(total):'未知';
  const release=i.releaseAt?new Date(i.releaseAt).toLocaleString('zh-CN')+'（'+(i.releaseAt>Date.now()?'约 '+Math.ceil((i.releaseAt-Date.now())/3600000)+' 小时后':'已到期')+'）':'未知';
  return `剩余内存 ${remaining(i.memoryTotal,i.memoryUsed)} · 系统盘 ${remaining(i.systemTotal,i.systemUsed)} · 数据盘 ${remaining(i.dataTotal,i.dataUsed)} · 释放时间 ${release}`;
}
function money(value){return Number.isFinite(value)?'¥'+value.toFixed(2):'未知';}
function renderAccount(s){
  $('balances').replaceChildren(...[['现金',s.balance?.cash],['代金券',s.balance?.voucher],['冻结',s.balance?.blocked]].map(([label,value])=>{const card=document.createElement('article');card.append(text('small',label),text('strong',money(value)));return card;}));
  $('billingStatus').textContent=[s.balanceError?'余额查询失败：'+s.balanceError:s.balance?'余额更新于 '+new Date(s.balance.at).toLocaleTimeString():'余额尚未查询',s.billingBusy?'正在同步账单…':s.billingError|| (s.billingAt?'账单更新于 '+new Date(s.billingAt).toLocaleTimeString():'账单尚未查询')].join('；');
  $('refreshBilling').disabled=s.billingBusy||!s.connected;$('refreshBalance').disabled=!s.connected;
  const days=Number($('billingDays').value),summary=s.billingSummaries[days],buckets=summary.series,groups=summary.groups,unknown=summary.unknown,total=summary.total,week=buckets.slice(-7).reduce((n,b)=>n+b.amount,0)/7;
  $('billTotal').textContent=s.billingAt?`区间净消费 ${money(total)} · 近7天日均 ${money(week)}${week>0&&Number.isFinite(s.balance?.cash)?' · 按现金估算可用 '+Math.floor(s.balance.cash/week)+' 天':''}${unknown?' · '+unknown+' 条记录无法归类':''}`:'尚未同步，不能据此判断消费为零';
  const overview=s.billingSummaries[35];$('billOverview').replaceChildren(...[['今日',overview.today],['近7天',overview.last7],['本月',overview.month]].map(([label,value])=>{const card=document.createElement('article');card.append(text('small',label+'净消费'),text('strong',s.billingAt?money(value):'尚未同步'));return card;}));
  const svg=$('billChart');svg.replaceChildren();const max=Math.max(1,...buckets.map(b=>Math.abs(b.amount))),width=680/days;
  buckets.forEach((b,i)=>{const rect=document.createElementNS('http://www.w3.org/2000/svg','rect');rect.setAttribute('x',10+i*width);rect.setAttribute('y',b.amount>=0?140-Math.abs(b.amount)/max*120:140);rect.setAttribute('width',Math.max(2,width-3));rect.setAttribute('height',Math.max(1,Math.abs(b.amount)/max*(b.amount>=0?120:30)));rect.setAttribute('fill',b.amount>=0?'#147d70':'#bc6b36');const title=document.createElementNS('http://www.w3.org/2000/svg','title');title.textContent=b.day+' '+money(b.amount);rect.setAttribute('tabindex','0');rect.setAttribute('role','button');rect.setAttribute('aria-label',title.textContent+'，查看当日流水');rect.onclick=()=>{billDay=b.day;renderAccount(current);};rect.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();billDay=b.day;renderAccount(current);}};rect.append(title);svg.append(rect);});
  for(const [x,label,anchor] of [[10,buckets[0].day,'start'],[690,buckets.at(-1).day,'end']]){const node=document.createElementNS('http://www.w3.org/2000/svg','text');node.setAttribute('x',x);node.setAttribute('y',186);node.setAttribute('font-size','10');node.setAttribute('fill','#5e6e80');node.setAttribute('text-anchor',anchor);node.textContent=label;svg.append(node);}
  $('billGroups').textContent=Object.entries(groups).sort((a,b)=>b[1]-a[1]).map(([name,amount])=>name+' '+money(amount)).join(' · ');
  if(!s.billingAt)billDay='';
  const filtered=s.bills.filter(r=>!billDay||(r.at&&new Date(r.at+8*3600000).toISOString().slice(0,10)===billDay));
  $('billDetailTitle').textContent=(billDay?billDay+' 流水':'近期流水')+'（'+filtered.length+' 条，最多显示100条）';
  $('billRows').replaceChildren(...filtered.sort((a,b)=>(b.at||0)-(a.at||0)).slice(0,100).map(r=>{const row=document.createElement('tr');for(const value of [r.at?new Date(r.at).toLocaleString('zh-CN'):'未知',({charge:'消费',refund:'退款',recharge:'充值',deposit:'充值'})[r.type]||r.type,r.gpu+' / '+r.region,money(r.amount)])row.append(text('td',value));return row;}));
}
$('billingDays').onchange=()=>{if(current)renderAccount(current);};
setInterval(()=>{if(current)$('nextCheck').textContent=current.watching?(current.nextCheckAt?'下次检查约 '+Math.max(0,Math.ceil((current.nextCheckAt-Date.now())/1000))+' 秒后 · 配置间隔 '+current.settings.seconds+' 秒':'正在检查…'):'';},500);

$('allBills').onclick=()=>{billDay='';if(current)renderAccount(current);};
