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
  const idle = Number(raw.gpu_idle_num ?? raw.idle_gpu_num ?? raw.gpu_idle_count);
  if (!Number.isInteger(idle) || idle < 0) throw new Error('库存字段无法识别');
  return {id:String(raw.machine_id || raw.machine_uuid || raw.id || ''), idle, gpu:String(raw.gpu_type_name || raw.gpu_name || ''), region:String(raw.region_name || raw.region_sign || '')};
}
function canStart(item, available) {
  return ['shutdown','stopped','poweroff','power_off'].includes(item.status) && Number.isInteger(item.count) && item.count > 0 && available.id === item.machine && available.idle >= item.count;
}
function settings(input) {
  const seconds = Number(input.seconds), count = Number(input.count);
  if (!Number.isInteger(seconds) || seconds < 30 || seconds > 3600) throw new Error('检查间隔需要为 30–3600 秒');
  if (!Number.isInteger(count) || count < 1 || count > 16) throw new Error('GPU 数量需要为 1–16');
  return {seconds,count,gpu:String(input.gpu || '').trim().slice(0,100), region:String(input.region || '').trim().slice(0,80)};
}
module.exports = {listOf,instance,stock,canStart,settings};
