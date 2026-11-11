import { REGIONS } from '../config.mjs';
import { gpuKey } from '../matching.mjs';
const number = value => value == null ? null : Number(value);
// 保留完整型号及显存/接口后缀，不把 A100 80GB、4090D 等降级为基础型号。
const knownGpuLine = /^(?:(?:NVIDIA|Tesla|GeForce|Quadro)\s+)*(?:(?:RTX|GTX)\s*(?:PRO\s*)?[A-Z]?\d{3,5}|TITAN(?:\s+[XVZ])?|vGPU(?:\s*[-_]?\s*\d+)?|[ABHVLTP]\d{1,4})[A-Z0-9 .+()（）/_-]*$/i;
const knownGpuSuffix = new RegExp('(?:^|\\s)(' + knownGpuLine.source.slice(1, -1) + ')$', 'i');
const sameModel = (actual, expected) => typeof expected === 'string' && !!expected && gpuKey(actual) === gpuKey(expected);
function uniqueModel(models) {
  const unique = new Map(models.map(model => [gpuKey(model), model]));
  return unique.size === 1 ? [...unique.values()][0] : '';
}
export function parseGpuStockLabel(text) {
  // 只剥离末尾完整库存 (空闲/总数)，型号本身的 (48GB) 等括号必须保留。
  const match = String(text || '').trim().match(/^(.+?)\s*[(（]\s*(\d+)\s*\/\s*(\d+)\s*[)）]\s*$/);
  return match ? { gpuModel: match[1].trim(), available: Number(match[2]), total: Number(match[3]) } : null;
}
export function parseHostRow(raw, region, expectedModel = '') {
  const cells = raw.cells || [], text = cells.join('\n');
  const lines = cells.filter(cell => !/(?:^|\n)\s*CPU[：:]/i.test(cell))
    .flatMap(cell => cell.split(/\r?\n/).map(line => line.trim()).filter(Boolean));
  // 自定义型号也必须在页面上有整行精确证据；绝不回填用户要求的型号。
  const gpuModel = uniqueModel(lines.filter(line => knownGpuLine.test(line) || sameModel(line, expectedModel)));
  const available = text.match(/(?:^|\n)\s*(\d+)\s*\/\s*(\d+)\s*(?:\n|$)/);
  // 可扩容容量：支持“1,024GB”“1.5TB”等写法；读不出时为 null（只在需要扩容时才因此排除主机）。
  const disk = text.match(/可扩容[：:]\s*(\d[\d,]*(?:\.\d+)?)\s*(GB|TB)/i);
  const driver = text.match(/驱动[：:]\s*([^\s]+)/);
  const cuda = text.match(/CUDA[：:]\s*(\d+(?:\.\d+)?)/i);
  const priceCell = cells.find(c => /[￥¥]\s*\d+(?:\.\d+)?\s*\/?\s*时/.test(c));
  const price = priceCell?.match(/[￥¥]\s*(\d+(?:\.\d+)?)/);
  // 主机号：优先取整格就是“…机”的单元格；地区与主机号写在同一格时取格内的“…机”。
  const numberCell = cells.find(c => /^\S+机$/.test(c.trim()))?.trim() || cells.map(c => c.match(/(?:^|\s)([\dA-Z]+机)(?=\s|$)/)?.[1]).find(Boolean) || '';
  return { id: raw.id, number: numberCell, region,
    gpuModel, available: available ? Number(available[1]) : null,
    total: available ? Number(available[2]) : null, expandableGB: disk ? Number(disk[1].replace(/,/g, '')) * (/^TB$/i.test(disk[2]) ? 1024 : 1) : null,
    driver: driver?.[1] || '', maxCuda: cuda?.[1] || '', price: price ? number(price[1]) : null,
    disabled: raw.disabled === true };
}
export function parseInstanceRow(text, expectedModel = '') {
  // ids：行中所有形如实例 ID 的片段。实例名称或备注也可能长这样，对账时用全部片段判断是否为新实例，不只看第一个。
  const ids = [...new Set([...text.matchAll(/\b[a-z0-9]{8,24}-[a-z0-9]{6,24}\b/gi)].map(m => m[0]))];
  const id = ids[0];
  if (!id) return null;
  const gpuEvidence = new Map();
  for (const line of text.split(/\r?\n|\t/)) {
    for (const count of line.matchAll(/[×xX*]\s*(\d+)(?![\d.])/g)) {
      const prefix = line.slice(0, count.index).trim();
      // 未知系列只接受独立型号行。已知系列可兼容表格 innerText 的同行字段。
      const model = sameModel(prefix, expectedModel) ? prefix : prefix.match(knownGpuSuffix)?.[1]?.trim();
      if (model) gpuEvidence.set(gpuKey(model) + ':' + count[1], { model, count: Number(count[1]) });
    }
  }
  const gpu = gpuEvidence.size === 1 ? [...gpuEvidence.values()][0] : null;
  const copying = /数据盘\s*(?:复制|拷贝)[中进]/.test(text);
  return { id, ids, region: REGIONS.find(r => text.includes(r)) || '', gpuModel: gpu?.model || '',
    gpuCount: gpu?.count ?? null, hostNumber: text.match(/\b[\dA-Z]+机(?![一-龥])/)?.[0] || text.match(/[\dA-Z]+机(?![一-龥])/)?.[0] || '',
    stopped: /已关机/.test(text), running: /(?:运行中|已开机)/.test(text) && !/(?:无卡模式|无卡开机|关机中|开机中)/.test(text),
    copyFailed: /数据盘[\s\S]{0,12}(?:复制|拷贝)[\s\S]{0,8}失败/.test(text),
    // 复制中优先：同一行既有“复制中”又有“复制完成后才能写入”之类的提示时，不算完成。
    copyComplete: !copying && /数据盘\s*(?:复制|拷贝)\s*(?:已)?(?:成功|完成)(?![后前时])/.test(text),
    failed: /(?:创建失败|开机失败|克隆失败)/.test(text),
    progress: copying ? '数据盘复制中' : /克隆中|创建中/.test(text) ? '系统盘克隆/创建中' : '',
    releaseDays: (() => { const m = text.match(/(\d+)\s*天[^\n]{0,24}后(?:释放|删除)/); return m ? Number(m[1]) : null; })(),
  };
}
export function parseQuoteText(text) {
  const hour = text.match(/配置费用\s*[：:]\s*[￥¥]\s*([\d.]+)\s*\/\s*时/);
  const daily = text.match(/日常费用\s*[：:]\s*[￥¥]\s*([\d.]+)\s*\/\s*日/);
  return { hourly: hour ? Number(hour[1]) : null, storageDaily: daily ? Number(daily[1]) : null };
}
