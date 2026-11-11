// 展示层：不改变会话、轮询或付费操作。
function svgElement(tag,attrs={}){const n=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [k,v] of Object.entries(attrs))n.setAttribute(k,v);return n;}
function stateLabel(status){return ({running:'运行中',shutdown:'已关机',stopped:'已关机',poweroff:'已关机',power_off:'已关机',starting:'启动中',powering_on:'启动中',stopping:'关机中'})[status]||status||'未知';}
function gauge(label,total,used){
  const known=Number.isFinite(total)&&total>0&&Number.isFinite(used)&&used>=0,free=known?Math.max(0,total-used):null,pct=known?Math.max(0,Math.min(100,free/total*100)):null;
  const card=document.createElement('article');card.className='resource-card';card.dataset.resource=label;const svg=svgElement('svg',{viewBox:'0 0 72 72',role:'img','aria-label':label+(known?'剩余 '+Math.round(pct)+'%':'未知')});
  svg.append(svgElement('circle',{cx:36,cy:36,r:29,fill:'none',stroke:'#edf2f5','stroke-width':6}));
  const colors=label==='内存'?['#ab87ff','#56c8ff']:label==='系统盘'?['#47d9f5','#58f1c5']:['#ffb95b','#ff7b9f'];const gid='gauge-'+label;const defs=svgElement('defs');const gradient=svgElement('linearGradient',{id:gid,x1:'0%',y1:'0%',x2:'100%',y2:'100%'});colors.forEach((color,i)=>gradient.append(svgElement('stop',{offset:i?'100%':'0%','stop-color':color})));defs.append(gradient);svg.prepend(defs);
  if(known)svg.append(svgElement('circle',{cx:36,cy:36,r:29,fill:'none',stroke:pct<15?'#ffb95b':'url(#'+gid+')','stroke-width':6,'stroke-linecap':'round','stroke-dasharray':`${pct/100*182.21} 182.21`,transform:'rotate(-90 36 36)'}));
  const value=svgElement('text',{x:36,y:40,'text-anchor':'middle','font-size':15,'font-weight':600,fill:'#29495b'});value.setAttribute('font-size','10');value.textContent=known?storage(free):'—';svg.append(value);
  const detail=document.createElement('div'),number=text('strong',known?storage(free):'尚无数据');number.className='resource-number';detail.append(text('small',label+'剩余'),number,text('p',known?'总量 '+storage(total):'等待平台上报'));card.append(svg,detail);return card;
}
// 固定分区：主监测、右侧操作、资源仪表、动态与守护信息。
const hero=document.querySelector('.dashboard-detail > .host-panel');hero.classList.add('monitor-hero');
const controls=document.querySelector('.home-setup');controls.classList.add('control-panel');document.querySelector('.dashboard-side').prepend(controls);
const heroBody=document.createElement('div');heroBody.className='sentinel-body';
const orbit=document.createElement('div');orbit.className='sentinel-orbit';orbit.innerHTML='<div class="orbit-track"><i></i></div><div class="orbit-value"><strong id="sentinelCount">—</strong><span>空闲 GPU</span><small id="sentinelNeed">等待选择实例</small></div>';
const summary=document.createElement('div');summary.className='sentinel-summary';summary.append($('hostTitle'),$('hostMeta'));const status=text('h3','等待连接');status.id='sentinelStatus';summary.prepend(status);const tags=document.createElement('div');tags.id='sentinelTags';summary.append(tags);heroBody.append(orbit,summary);hero.querySelector('.sectionTitle').after(heroBody);
const heroTitle=text('h2','GPU 空闲哨兵');hero.querySelector('.sectionTitle>div').append(heroTitle);
const resourcePanel=document.createElement('section');resourcePanel.className='runtime-panel';resourcePanel.innerHTML='<div class="sectionTitle"><div><small>RUNTIME RESOURCES</small><h2>实例资源余量</h2></div><span id="runtimeState" class="badge">等待数据</span></div>';
$('targetResources').before(resourcePanel);resourcePanel.append($('targetResources'));
const guard=document.createElement('article');guard.className='guard-panel';guard.innerHTML='<small>GUARDRAILS</small><h2>守护状态</h2><dl><div><dt>检查频率</dt><dd id="guardFrequency">—</dd></div><div><dt>账号状态</dt><dd id="guardAccount">—</dd></div><div><dt>候补策略</dt><dd>只抢一台</dd></div></dl>';
const wallet=document.querySelector('.wallet-panel');guard.append(wallet);document.querySelector('#dashboard>.columns').append(guard);
const baseRender=render;
render=function(s){
  baseRender(s);
  const list=$('allTasks');list.replaceChildren();
  function progressRow(label,status,detail){const row=document.createElement('div');row.className='task-row';const body=document.createElement('div');body.append(text('strong',status),text('p',detail));row.append(text('span',label),body);list.append(row);}
  if(s.pending||s.watching)progressRow('已有实例',s.pending?'已提交 · 自动核实中':'等待空闲 GPU',s.instances.find(i=>i.id===(s.pending?.id||s.target))?.name||s.target);
  for(const t of s.rentalTasks||[])progressRow(t.mode==='clone'?'克隆':'新建',({queued:'等待检查',watching:'等待空闲 GPU',preparing:'核对配置',submitting:'正在提交',verifying:'资源已提交 · 等待就绪',completed:'已完成',paused:'已暂停',cancelled:'已取消',attention:'需要处理',reconciling:'核实提交结果',expired:'已到期'})[t.state]||t.state,t.progress||t.result||'尚未提交');
  if(!list.children.length)list.append(text('p',s.oneMachine?.done?'本组已完成，已获得一台实例。':'暂无任务。选择上方模式后开始排队。'));
  $('login').hidden=s.connected&&!s.demo;
  $('login').disabled=s.auth==='checking';
  $('checkLogin').hidden=s.connected&&!s.demo;
  $('logout').hidden=!s.connected&&!['expired','unverified'].includes(s.auth);
  $('connection').textContent=s.demo?'演示数据 · 未连接真实账号':s.connected?(s.auth==='unverified'?'账号已连接 · 核验重试中':'AutoDL 账号已连接'):$('connection').textContent;
  const homeActive=(s.rentalTasks||[]).some(t=>t.id===s.homeTask&&['queued','watching','preparing','submitting','verifying'].includes(t.state));
  $('stop').disabled=!s.watching&&!homeActive;
  $('startAuto').disabled=$('startAuto').disabled||homeActive||s.watching||!!s.oneMachine;
  if(homeActive&&!s.watching)$('watch').textContent='克隆候补中';
  if(!s.connected&&!s.demo)$('nInstances').textContent='—';
  $('dashboardBalance').textContent=money(s.balance?.cash);$('balanceMeta').textContent=s.balanceError?'同步失败 · '+s.balanceError:s.balance?'现金余额 · '+new Date(s.balance.at).toLocaleTimeString()+' 更新':'登录后同步账户余额';
  const item=s.instances.find(i=>i.id===s.target),host=item?s.markets.find(m=>m.id===item.machine):null;
  $('sentinelCount').textContent=host&&Number.isInteger(host.idle)?host.idle:'—';
  $('sentinelNeed').textContent=item?'需要 '+item.count+' 张 GPU':'等待选择实例';
  $('sentinelStatus').textContent=!s.connected&&!s.demo?'连接账号开始监测':!item?'选择监控目标':item.status==='running'?'实例正在使用 GPU':s.pending?'请求已提交 · 核实中':host?.idle>=item.count?'发现可用 GPU':s.stockError?'库存暂不可确认':s.watching?'正在等待空闲 GPU':'准备就绪';
  hero.classList.toggle('is-live',s.watching||s.syncing||!!s.pending);
  $('sentinelTags').replaceChildren(...[item?.regionName,item?.machine,item?item.count+' 卡 · '+(item.charge||'按平台计费'):'',s.updated?'更新于 '+s.updated:'尚未同步'].filter(Boolean).map(v=>text('span',v)));
  $('runtimeState').textContent=item?stateLabel(item.status):'等待数据';$('guardFrequency').textContent='每 '+s.settings.seconds+' 秒';$('guardAccount').textContent=s.demo?'演示模式':s.connected?'已连接':'未连接';
  $('hostTitle').textContent=item?item.gpu+' × '+item.count:'选择一个监控目标';$('hostMeta').textContent=item?item.name+' · '+item.regionName+' · '+stateLabel(item.status):'在下方选择已有实例，查看目标主机库存';
  $('hostBadge').textContent=host&&Number.isInteger(host.idle)?host.idle+' 卡空闲':'库存待确认';$('hostBadge').className='badge'+(host?.idle>=item?.count?' ready':'');
  $('gpuSlots').replaceChildren();
  if(host&&Number.isSafeInteger(host.total)&&host.total>0&&host.total<=64&&Number.isSafeInteger(host.idle)){
    const grid=document.createElement('div');grid.className='slot-grid';grid.title='按空闲数量示意，不代表物理卡槽编号';
    for(let i=0;i<host.total;i++){const slot=document.createElement('div');slot.className='gpu-slot'+(i<host.idle?' free':'');slot.append(text('b',String(i+1).padStart(2,'0')),text('span',i<host.idle?'空闲':'占用'));grid.append(slot);}$('gpuSlots').append(grid);
  }else{const empty=text('div',host?'空闲 '+(host.idle??'未知')+' 卡 · 总卡数未确认':'选定目标后显示 GPU 空闲数量');empty.className='empty-state';$('gpuSlots').append(empty);}
  const resources=[['内存',item?.memoryTotal,item?.memoryUsed],['系统盘',item?.systemTotal,item?.systemUsed],['数据盘',item?.dataTotal,item?.dataUsed]],signature=JSON.stringify(resources);if($('targetResources').dataset.signature!==signature){$('targetResources').dataset.signature=signature;$('targetResources').replaceChildren(...resources.map(args=>gauge(...args)));}
  [...$('instanceList').querySelectorAll('article')].forEach((card,index)=>{
    const i=s.instances[index],actions=card.lastElementChild;card.className='instance-card';card.firstElementChild.remove();
    const heading=document.createElement('div');heading.className='instance-heading';const identity=document.createElement('div');identity.className='identity';const icon=text('span','▦');icon.className='chip-icon';const name=document.createElement('div');name.append(text('h2',i.name),text('small',i.gpu+' × '+i.count));identity.append(icon,name);
    const badge=text('span',stateLabel(i.status));badge.className='badge'+(i.status==='running'?' ready':'');heading.append(identity,badge);
    const meta=text('p',i.regionName+' · '+i.id);meta.className='instance-meta';const resources=document.createElement('div');resources.className='instance-resources';
    for(const [label,total,used] of [['内存',i.memoryTotal,i.memoryUsed],['系统盘',i.systemTotal,i.systemUsed],['数据盘',i.dataTotal,i.dataUsed]]){const cell=document.createElement('div'),line=document.createElement('div');line.className='usage-line';const known=Number.isFinite(total)&&total>0&&Number.isFinite(used);line.append(text('span',label),text('b',known?storage(Math.max(0,total-used))+' 可用':'暂无用量'));cell.append(line);if(known){const bar=document.createElement('progress');bar.max=total;bar.value=Math.max(0,total-used);bar.title='剩余 '+storage(Math.max(0,total-used))+' / '+storage(total);bar.setAttribute('aria-label',label+bar.title);cell.append(bar);}resources.append(cell);}
    const release=text('p',i.releaseAt?'释放时间 '+new Date(i.releaseAt).toLocaleString('zh-CN')+' · '+(i.releaseAt>Date.now()?'约 '+Math.ceil((i.releaseAt-Date.now())/3600000)+' 小时后':'已到期'):'释放时间尚未提供');release.className='release-line';card.prepend(heading,meta,resources,release);card.append(actions);
  });
};
const baseAccount=renderAccount;
renderAccount=function(s){
  baseAccount(s);
  const buckets=s.billingSummaries[Number($('billingDays').value)].series,svg=$('billChart');svg.replaceChildren();
  if(!s.billingAt){const empty=svgElement('text',{x:350,y:110,'text-anchor':'middle','font-size':13,fill:'#8a9bac'});empty.textContent='同步账单后查看消费趋势';svg.append(empty);return;}
  const positive=Math.max(1,...buckets.map(b=>b.amount)),negative=Math.max(0,...buckets.map(b=>-b.amount)),top=18,bottom=210,left=47,right=685,scale=(bottom-top)/(positive+negative),zero=top+positive*scale,step=(right-left)/buckets.length;
  for(let i=0;i<=4;i++){const amount=positive-(positive+negative)*i/4,y=top+(bottom-top)*i/4;svg.append(svgElement('line',{x1:left,x2:right,y1:y,y2:y,stroke:'#e8eef3','stroke-dasharray':'3 5'}));const label=svgElement('text',{x:left-8,y:y+3,'text-anchor':'end','font-size':9,fill:'#91a0af'});label.textContent=amount.toFixed(1);svg.append(label);}
  svg.append(svgElement('line',{x1:left,x2:right,y1:zero,y2:zero,stroke:'#b7c9d2'}));
  buckets.forEach((b,i)=>{const rect=svgElement('rect',{x:left+i*step+2,y:b.amount>=0?zero-b.amount*scale:zero,width:Math.max(2,step-5),height:Math.max(1,Math.abs(b.amount)*scale),rx:3,fill:b.day===billDay?'#164b55':b.amount>=0?'#43a68a':'#d8a66d',tabindex:0,role:'button','aria-label':b.day+' '+money(b.amount)+'，查看流水'});const title=svgElement('title');title.textContent=b.day+' '+money(b.amount);rect.append(title);rect.onmouseenter=()=>{$('chartReadout').textContent=b.day+' · 净消费 '+money(b.amount)+' · 点击查看流水';};rect.onfocus=rect.onmouseenter;rect.onclick=()=>{billDay=b.day;renderAccount(current);};rect.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();billDay=b.day;renderAccount(current);}};svg.append(rect);if(i===0||i===buckets.length-1||(i%7===0&&i<buckets.length-3)){const label=svgElement('text',{x:left+(i+.5)*step,y:233,'text-anchor':'middle','font-size':9,fill:'#91a0af'});label.textContent=b.day.slice(5).replace('-','/');svg.append(label);}});
  const unit=svgElement('text',{x:10,y:12,'font-size':9,fill:'#91a0af'});unit.textContent='元';svg.append(unit);
  const entries=Object.entries(s.billingSummaries[Number($('billingDays').value)].groups).sort((a,b)=>b[1]-a[1]),max=Math.max(1,...entries.map(([,v])=>Math.abs(v)));
  $('billGroups').replaceChildren(...entries.map(([label,amount])=>{const row=document.createElement('div');row.className='composition-item';const line=document.createElement('div');line.className='usage-line';line.append(text('span',label),text('b',money(amount)));const bar=document.createElement('progress');bar.max=max;bar.value=Math.abs(amount);bar.setAttribute('aria-label',label+' 净消费 '+money(amount));row.append(line,bar);return row;}));if(!entries.length)$('billGroups').append(text('p','暂无消费构成数据'));
};
$('goBilling').onclick=()=>switchTab('billing');
