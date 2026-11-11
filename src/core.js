'use strict';
function listOf(data) {
  const list = Array.isArray(data) ? data : (Array.isArray(data?.list) ? data.list : data?.machines);
  if (!Array.isArray(list)) throw new Error('接口列表格式变化，请更新应用');
  return list;
}
function instance(raw) {
  const id = String(raw.uuid || raw.instance_uuid || raw.id || '');
  if (!id) throw new Error('实例缺少 ID');
  return {...resources(raw),id, name:String(raw.name || raw.instance_name || id), status:String(raw.status || raw.instance_status || 'unknown').trim().toLowerCase(), machine:machineKey(raw.machine_id || raw.machine_alias), gpu:String(raw.gpu_type_name || raw.snapshot_gpu_type_name || raw.snapshot_gpu_alias_name || raw.gpu_name || raw.gpu_type || ''), count:Number(raw.req_gpu_amount ?? raw.gpu_num ?? raw.gpu_amount ?? 1), region:String(raw.region_sign || raw.region || ''), regionName:String(raw.region_name || raw.region_sign || ''), charge:String(raw.charge_type || '')};
}
function finite(value){if(value===null||value===undefined||value==='')return null;const n=Number(value);return Number.isFinite(n)?n:null;}
function timestamp(value){
  if(!value)return null;
  const input=typeof value==='string'&&/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value)?value.replace(' ','T')+'+08:00':value;
  const n=typeof input==='number'?input<1e12?input*1000:input:Date.parse(input);return Number.isFinite(n)&&n>0?n:null;
}
function resources(raw){
  const u=raw.usage_info||{},dates=[timestamp(raw.rent_deadline),timestamp(raw.expired_at)].filter(n=>n!==null);
  return {memoryTotal:finite(u.mem_limit??raw.mem_limit??raw.mem_limit_in_byte),memoryUsed:finite(u.mem_usage??raw.mem_usage),
    systemTotal:finite(raw.root_fs_total_size??u.root_fs_total_size),systemUsed:finite(raw.root_fs_used_size??u.root_fs_used_size),
    dataTotal:finite(u.data_disk_total_size),dataUsed:finite(u.data_disk_used_size),releaseAt:dates.length?Math.min(...dates):null,
    ssh:String(raw.ssh_command||''),jupyter:String(raw.jupyter_domain||'')};
}
function balance(raw){
  const cash=finite(raw?.assets??raw?.balance),voucher=finite(raw?.voucher_balance??raw?.voucher),blocked=finite(raw?.blocked_asset??raw?.blocked_assets);
  if(cash===null)throw new Error('余额字段无法识别');
  return {cash:cash/1000,voucher:voucher===null?null:voucher/1000,blocked:blocked===null?null:blocked/1000,at:Date.now()};
}
function bill(raw){
  const amount=finite(raw.asset),at=timestamp(raw.details?.charge_from??raw.created_at??raw.confirm_at);
  return {id:String(raw.uuid??raw.id??''),amount:amount===null?null:amount/1000,at,type:String(raw.bill_type||'unknown').toLowerCase(),gpu:String(raw.details?.gpu_type||'其他'),region:String(raw.details?.region_name||raw.details?.region_sign||''),cash:finite(raw.pay_by_balance),voucher:finite(raw.pay_by_voucher)};
}
function dayKey(at){return new Date(at+8*3600000).toISOString().slice(0,10);}
function billingSummary(records,days=30,now=Date.now()){
  const today=dayKey(now),end=Date.parse(today+'T00:00:00+08:00');
  const series=Array.from({length:days},(_,i)=>({day:dayKey(end-(days-1-i)*86400000),amount:0}));
  const buckets=new Map(series.map(d=>[d.day,d])),groups={};let unknown=0;
  for(const r of records){
    if(r.at===null||r.amount===null){unknown++;continue;}
    const bucket=buckets.get(dayKey(r.at));if(!bucket)continue;
    const sign=['charge','consume','consumption'].includes(r.type)?1:['refund','return'].includes(r.type)?-1:0;
    if(!sign&&!['recharge','deposit'].includes(r.type))unknown++;
    bucket.amount+=sign*r.amount;if(sign)groups[r.gpu]=(groups[r.gpu]||0)+sign*r.amount;
  }
  return {series,total:series.reduce((n,d)=>n+d.amount,0),groups,unknown,today:series.at(-1)?.amount||0,last7:series.slice(-7).reduce((n,d)=>n+d.amount,0),month:series.filter(d=>d.day.slice(0,7)===today.slice(0,7)).reduce((n,d)=>n+d.amount,0)};
}
function pollDelay(seconds,errors,retryUntil=0,now=Date.now()){
  return Math.max(seconds*1000,Math.min(600000,seconds*1000*2**Math.min(errors,8)),retryUntil-now);
}
function machineKey(value){return String(value??'').trim().toLowerCase();}
function idleCount(value){
  if(typeof value!=='number'&&typeof value!=='string')return null;
  const input=typeof value==='string'?value.trim().replace(/,/g,''):value;
  if(input==='')return null;
  const number=Number(input);
  if(!Number.isFinite(number)||!Number.isSafeInteger(Math.trunc(number)))return null;
  return {count:Math.max(0,Math.trunc(number)),normalized:number<0?'negative_to_zero':!Number.isInteger(number)?'truncated':null};
}
function stock(raw) {
  raw = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  // 与参考实现保持一致：依次尝试主字段与别名，有限数值截取整数、负数归零。
  const fields=['gpu_idle_num','idle_gpu_num','gpu_idle_count'];
  const source=fields.find(key=>idleCount(raw[key])!==null);
  const parsed=source?idleCount(raw[source]):null;
  const idle=parsed?parsed.count:null;
  const idleIssue=parsed?null:fields.every(key=>raw[key]===null||raw[key]===undefined)?'missing':'invalid_value';
  return {id:machineKey(raw.machine_id || raw.machine_uuid || raw.id), idle,total:finite(raw.gpu_number??raw.gpu_total_num),idleIssue,normalization:parsed?.normalized||null, gpu:String(raw.gpu_type_name || raw.gpu_name || ''), region:String(raw.region_name || raw.region_sign || ''),
    regionSign:String(raw.region_sign||''),schema:Object.keys(raw).sort().slice(0,80).map(key=>key.slice(0,80)+':'+(raw[key]===null?'null':Array.isArray(raw[key])?'array':typeof raw[key]))};
}
function stockDiagnostics(markets,version){
  const unknown=markets.filter(m=>m.idle===null),reasons={};
  for(const record of unknown){const reason=record.idleIssue||'unclassified';reasons[reason]=(reasons[reason]||0)+1;}
  return {version,records:markets.length,known:markets.length-unknown.length,unknown:unknown.length,reasons,schemas:[...new Set(unknown.map(m=>m.schema.join(', ')))].slice(0,5)};
}
function stockSummary(state) {
  if(state.stockError)return {label:'目标主机库存',value:'未知',hint:'库存查询失败；不会使用旧库存自动开机'};
  if(state.target){
    const item=state.instances.find(i=>i.id===state.target);
    const rows=item?.machine?state.markets.filter(m=>m.id===item.machine):[];
    const known=rows.length>0&&rows.every(m=>Number.isSafeInteger(m.idle)&&m.idle>=0);
    // 同一主机重复记录不累加；库存不一致时采用较小值。
    return {label:'目标主机空闲 GPU',value:known?String(Math.min(...rows.map(m=>m.idle))):'未知',hint:known?`仅统计所选实例所在主机；开机需要 ${item.count} 卡`:'未查到目标主机的有效库存，请刷新；不代表有空闲卡'};
  }
  if(!state.target&&!state.watching)return {label:'目标主机空闲 GPU',value:'—',hint:'选择已有实例后自动查询；新租请进入租机候补'};
  const known=state.markets.filter(m=>Number.isSafeInteger(m.idle)&&m.idle>=0);
  const unknown=state.markets.length-known.length;
  return {label:'查询结果空闲 GPU 合计',value:String(known.reduce((sum,m)=>sum+m.idle,0)),hint:`共 ${state.markets.length} 条主机记录${unknown?`，${unknown} 条库存未知`:''}；请选择实例查看其主机库存`};
}
function canStart(item, available) {
  return ['shutdown','stopped','poweroff','power_off'].includes(item.status) && Number.isInteger(item.count) && item.count > 0 && !!item.machine && available.id === item.machine && Number.isSafeInteger(available.idle) && available.idle >= item.count;
}
function settings(input) {
  const seconds = Number(input.seconds), count = Number(input.count);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) throw new Error('检查间隔需要为 1–3600 秒');
  if (!Number.isInteger(count) || count < 1 || count > 16) throw new Error('GPU 数量需要为 1–16');
  const lowBalance=Number(input.lowBalance??10);
  if(!Number.isFinite(lowBalance)||lowBalance<0||lowBalance>1000000)throw new Error('余额提醒阈值需要为 0–1000000 元');
  return {seconds,count,lowBalance,gpu:String(input.gpu || '').trim().slice(0,100), region:String(input.region || '').trim().slice(0,80)};
}
module.exports = {listOf,instance,stock,stockDiagnostics,stockSummary,canStart,settings,balance,bill,billingSummary,dayKey,pollDelay};
