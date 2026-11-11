import { REGIONS, normalizeGpuModel } from './config.mjs';
import { fail } from './errors.mjs';

export function sourceProblem(source) {
  if (!source) return '源实例已不存在或未出现在当前账号的实例列表中';
  if (!source.stopped || source.running) return '克隆要求源实例已关机；程序不会自动关闭实例';
  if (!REGIONS.includes(source.region)) return '源实例地区未知或尚未支持';
  try { normalizeGpuModel(source.gpuModel); } catch { return '源实例的精确 GPU 型号无法识别'; }
  if (![1,2,3,4,5,6,7,8,10,12].includes(source.gpuCount)) return '源实例 GPU 数量未知或尚未支持';
  if (source.failed) return '源实例处于失败状态，请先在 AutoDL 核对';
  return '';
}
// 克隆的源实例只需存在、已关机、在任务地区；目标 GPU 型号和数量按任务设置，可以与源实例不同。
export function validateCloneSource(config, source) {
  const problem = sourceProblem(source);
  if (problem) fail('SOURCE_UNAVAILABLE', problem, { status: 409 });
  if (source.id !== config.sourceId || source.region !== config.regions[0] || config.regions.length !== 1)
    fail('SOURCE_MISMATCH', '源实例在 ' + source.region + '，任务地区为 ' + config.regions.join('、')
      + '；克隆只能在源实例所在地区进行，请重新同步并选择源实例', { status: 409 });
  return source;
}
export function publicInstance(source) {
  const reason = sourceProblem(source);
  return { id: source.id, region: source.region || '', gpuModel: source.gpuModel || '', gpuCount: source.gpuCount ?? null,
    status: source.stopped ? '已关机' : source.running ? '运行中' : source.failed ? '失败' : source.progress || '状态待确认',
    cloneable: !reason, reason };
}
