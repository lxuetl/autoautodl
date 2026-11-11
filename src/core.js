'use strict';
function listOf(data) {
  const list = Array.isArray(data) ? data : data?.list;
  if (!Array.isArray(list)) throw new Error('接口列表格式变化，请更新应用');
  return list;
}
function instance(raw) {
  const id = String(raw.uuid || raw.instance_uuid || raw.id || '');
  if (!id) throw new Error('实例缺少 ID');
  return {id, name:String(raw.name || raw.instance_name || id), status:String(raw.status || raw.instance_status || 'unknown'), machine:String(raw.machine_id || ''), gpu:String(raw.gpu_type_name || raw.snapshot_gpu_type_name || raw.gpu_name || ''), count:Number(raw.req_gpu_amount ?? raw.gpu_num ?? 1), region:String(raw.region_sign || ''), regionName:String(raw.region_name || raw.region_sign || ''), charge:String(raw.charge_type || '')};
}
function stock(raw) {
  raw = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const values = ['gpu_idle_num','idle_gpu_num','gpu_idle_count'].map(key => raw[key]).filter(value=>value!==null&&value!==undefined);
  const counts=[];let idleIssue=values.length?null:'missing';
  for(const value of values){
    const numeric=typeof value==='number'||(typeof value==='string'&&/^-?\d+(?:\.\d+)?$/.test(value));
    const n=numeric?Number(value):NaN;
    const issue=!numeric?'invalid_type':!Number.isFinite(n)?'non_finite':!Number.isInteger(n)?'fractional':n<0?'negative':!Number.isSafeInteger(n)?'out_of_range':null;
    if(issue)idleIssue ||= issue;else counts.push(n);
  }
  if(!idleIssue&&new Set(counts).size>1)idleIssue='conflicting';
  const idle=idleIssue?null:counts[0];
  return {id:String(raw.machine_id || raw.machine_uuid || raw.id || ''), idle,idleIssue, gpu:String(raw.gpu_type_name || raw.gpu_name || ''), region:String(raw.region_name || raw.region_sign || ''),
    schema:Object.keys(raw).sort().slice(0,80).map(key=>key.slice(0,80)+':'+(raw[key]===null?'null':Array.isArray(raw[key])?'array':typeof raw[key]))};
}
function stockDiagnostics(markets,version){
  const unknown=markets.filter(m=>m.idle===null),reasons={};
  for(const record of unknown){const reason=record.idleIssue||'unclassified';reasons[reason]=(reasons[reason]||0)+1;}
  return {version,records:markets.length,known:markets.length-unknown.length,unknown:unknown.length,reasons,schemas:[...new Set(unknown.map(m=>m.schema.join(', ')))].slice(0,5)};
}
function canStart(item, available) {
  return ['shutdown','stopped','poweroff','power_off'].includes(item.status) && Number.isInteger(item.count) && item.count > 0 && !!item.machine && available.id === item.machine && Number.isSafeInteger(available.idle) && available.idle >= item.count;
}
function settings(input) {
  const seconds = Number(input.seconds), count = Number(input.count);
  if (!Number.isInteger(seconds) || seconds < 30 || seconds > 3600) throw new Error('检查间隔需要为 30–3600 秒');
  if (!Number.isInteger(count) || count < 1 || count > 16) throw new Error('GPU 数量需要为 1–16');
  return {seconds,count,gpu:String(input.gpu || '').trim().slice(0,100), region:String(input.region || '').trim().slice(0,80)};
}
module.exports = {listOf,instance,stock,stockDiagnostics,canStart,settings};
