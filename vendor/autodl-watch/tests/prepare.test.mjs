import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoDLBrowserAdapter } from '../src/adapters/autodl.mjs';
import { testConfig } from './fixtures/config.mjs';
// 提交前准备的编排：所有页面动作均为内存替身，只记录调用顺序，不启动浏览器、不访问 AutoDL。
const host = { id: 'synthetic-host', number: '922机', region: '北京B区', gpuModel: 'RTX 4090', available: 2, total: 8,
  driver: '570.1', maxCuda: '12.8', price: 2.18, expandableGB: 500, disabled: false };
const cloneUrl = 'https://www.autodl.com/cloneInstance?id=synthetic-source&copy_data_disk=1&expand_size=0';
function prepareAdapter({ mode = 'create', baseline = [], sourceRow = null } = {}) {
  const config = testConfig({ mode, gpuModel: 'RTX 4090', cuda: '12.8', imagePath: ['PyTorch', '2.8.0', '3.12(ubuntu22.04)', '12.8'],
    sourceId: 'synthetic-source', action: 'execute', paidConsent: true, pricePolicy: 'official' });
  const task = { id: 'synthetic-task', config };
  const calls = [], page = { closed: false, url: () => mode === 'clone' ? cloneUrl : 'https://www.autodl.com/create', isClosed: () => false,
    locator: selector => { if (selector === 'body') return { innerText: async () => '配置费用：￥2.18/时\n日常费用：￥0/日' };
      if (selector === 'label.el-checkbox') return { filter: () => ({}) }; throw Error('unexpected synthetic locator: ' + selector); },
    getByRole: () => ({ count: async () => 1, isEnabled: async () => true }) };
  const adapter = new AutoDLBrowserAdapter('unused-isolated-prepare-profile');
  adapter.page = page;
  const record = name => async (...args) => { calls.push(name); return args; };
  Object.assign(adapter, { goto: record('goto'), openClone: async () => { calls.push('openClone'); return source; }, radio: record('radio'),
    checkGpuCountKept: record('checkGpuCountKept'),
    selectModel: record('selectModel'), locateHost: record('locateHost'), checkbox: record('checkbox'), settle: record('settle'),
    selectImage: async () => { calls.push('selectImage'); return config.imagePath.join(' / '); },
    scanHosts: async (region, { untilId }) => { calls.push('scanHosts'); return { hosts: untilId === host.id ? [host] : [], pages: 1, exhausted: true, stalled: false, found: true }; },
    startBaseline: async () => { calls.push('baseline:start'); return { collect: async () => { calls.push('baseline:collect'); return [...baseline, ...(sourceRow ? [sourceRow] : [])]; }, close: async () => { calls.push('baseline:close'); } }; } });
  const source = mode === 'clone' ? { id: 'synthetic-source', region: '北京B区', gpuModel: 'RTX 4090', gpuCount: 1, extraDiskGB: 0, stopped: true, sourceCuda: '12.8' } : null;
  return { adapter, task, calls, page, source };
}
const probed = (adapter, task, extra = {}) => { adapter.probed = { taskId: task.id, region: '北京B区', page: adapter.page, url: adapter.page.url(), at: Date.now(), ...extra }; };

test('探测命中后同一轮复用当前表单：不重新打开页面，实例基线并行读取后才生成报价', async () => {
  const { adapter, task, calls } = prepareAdapter({ baseline: [{ id: 'synthetic-existing01' }] });
  probed(adapter, task);
  const quote = await adapter.prepare(task, host, null);
  assert.equal(calls.includes('goto'), false); assert.equal(quote.timing.reused, true);
  assert.equal(calls[0], 'baseline:start'); assert.ok(calls.indexOf('baseline:collect') > calls.indexOf('selectImage'));
  assert.equal(calls.at(-1), 'baseline:close'); assert.deepEqual(quote.baselineIds, ['synthetic-existing01']);
  assert.equal(adapter.prepared.quote, quote); assert.equal(adapter.probed, null);
});
test('探测记录不属于本任务、地区、页面或已过期时，重新打开创建页', async () => {
  for (const extra of [{ taskId: 'other-task' }, { region: '西北B区' }, { url: 'https://www.autodl.com/console/instance/list' }, { at: Date.now() - 31000 }]) {
    const { adapter, task, calls } = prepareAdapter();
    probed(adapter, task, extra);
    const quote = await adapter.prepare(task, host, null);
    assert.equal(calls.filter(c => c === 'goto').length, 1, JSON.stringify(extra)); assert.equal(quote.timing.reused, false);
  }
  const { adapter, task, calls } = prepareAdapter();
  await adapter.prepare(task, host, null); assert.equal(calls.filter(c => c === 'goto').length, 1);
});
test('候选在准备期间消失：按竞争失败返回，基线标签页仍关闭', async () => {
  const { adapter, task, calls } = prepareAdapter(); probed(adapter, task);
  await assert.rejects(() => adapter.prepare(task, { ...host, id: 'gone-host' }, null), error => error.code === 'RESOURCE_GONE' && error.race === true && error.retryable === true);
  assert.equal(calls.at(-1), 'baseline:close'); assert.equal(adapter.prepared, null);
});
test('克隆复用表单：用同一份实例基线复核源实例；源已开机时停止', async () => {
  const sourceRow = { id: 'synthetic-source', region: '北京B区', gpuModel: 'RTX 4090', gpuCount: 1, stopped: true, running: false };
  const ok = prepareAdapter({ mode: 'clone', sourceRow }); probed(ok.adapter, ok.task);
  const quote = await ok.adapter.prepare(ok.task, host, ok.source);
  assert.equal(ok.calls.includes('openClone'), false); assert.equal(quote.copyDataDisk, true); assert.ok(ok.adapter.prepared.sourceCheckedAt > 0);
  const running = prepareAdapter({ mode: 'clone', sourceRow: { ...sourceRow, stopped: false, running: true } }); probed(running.adapter, running.task);
  await assert.rejects(() => running.adapter.prepare(running.task, host, running.source), error => error.code === 'SOURCE_UNAVAILABLE');
  const missing = prepareAdapter({ mode: 'clone' }); probed(missing.adapter, missing.task);
  await assert.rejects(() => missing.adapter.prepare(missing.task, host, missing.source), error => error.code === 'SOURCE_UNAVAILABLE');
  assert.equal(missing.calls.at(-1), 'baseline:close');
});
test('此前被拒绝的提交之后出现与任务相符的新实例（任意主机）：停止自动提交，请用户核对', async () => {
  const late = { id: 'synthetic-late0001', region: '北京B区', gpuModel: 'RTX 4090', gpuCount: 1, hostNumber: '922机' };
  const { adapter, task } = prepareAdapter({ baseline: [{ id: 'synthetic-existing01' }, late] });
  task.submitRejections = [{ at: Date.now() - 60000, baselineIds: ['synthetic-existing01'], hostNumber: '922机' }];
  probed(adapter, task);
  await assert.rejects(() => adapter.prepare(task, host, null), error => error.code === 'SUBMIT_LATE' && error.message.includes('synthetic-late0001') && error.retryable === false);
  // 延迟创建出现在另一台主机上同样停止：否则下一次在别的主机点击成功会多租一台。
  const other = prepareAdapter({ baseline: [{ id: 'synthetic-existing01' }, { ...late, hostNumber: '923机' }] });
  other.task.submitRejections = [{ at: Date.now() - 60000, baselineIds: ['synthetic-existing01'], hostNumber: '922机' }]; probed(other.adapter, other.task);
  await assert.rejects(() => other.adapter.prepare(other.task, host, null), error => error.code === 'SUBMIT_LATE' && error.message.includes('923机'));
  // 已超过30分钟的拒绝记录、与任务不符（型号、卡数或地区不同）的新实例不触发。
  const old = prepareAdapter({ baseline: [{ id: 'synthetic-existing01' }, late] });
  old.task.submitRejections = [{ at: Date.now() - 31 * 60000, baselineIds: ['synthetic-existing01'], hostNumber: '922机' }]; probed(old.adapter, old.task);
  await old.adapter.prepare(old.task, host, null);
  for (const unrelated of [{ ...late, gpuModel: 'RTX 3090' }, { ...late, gpuCount: 2 }, { ...late, region: '西北B区' }]) {
    const f = prepareAdapter({ baseline: [{ id: 'synthetic-existing01' }, unrelated] });
    f.task.submitRejections = [{ at: Date.now() - 60000, baselineIds: ['synthetic-existing01'], hostNumber: '922机' }]; probed(f.adapter, f.task);
    await f.adapter.prepare(f.task, host, null);
  }
});
test('页面上找不到“创建并开机”时停止并列出可见按钮，不当作竞争失败', async () => {
  const { adapter, task, page } = prepareAdapter(); probed(adapter, task);
  page.getByRole = () => ({ count: async () => 0 }); page.evaluate = async () => ['立即创建', '取消'];
  await assert.rejects(() => adapter.prepare(task, host, null), error => error.code === 'SUBMIT_DOM' && error.message.includes('立即创建') && error.race !== true);
});
test('选中主机后 GPU 数量被平台改掉（如“2卡起租”）：不提交，按竞争失败换主机，并标明是这台主机的问题', async () => {
  const { adapter, task, calls } = prepareAdapter(); probed(adapter, task);
  // 真实检查：卡数选项未选中或不可选。
  delete adapter.checkGpuCountKept;
  adapter.radioLabel = name => ({ count: async () => 1, locator: () => ({ isChecked: async () => name !== '1', isEnabled: async () => true }) });
  await assert.rejects(() => adapter.prepare(task, host, null), error => error.code === 'GPU_COUNT' && error.race === true && error.hostProblem === true && /起租/.test(error.message));
  assert.equal(calls.at(-1), 'baseline:close'); assert.equal(adapter.prepared, null);
  // 选项消失（倍数起租时只列出 2、4、6……）同样换主机。
  adapter.radioLabel = () => ({ count: async () => 0, locator: () => ({ isChecked: async () => false, isEnabled: async () => false }) });
  await assert.rejects(() => adapter.checkGpuCountKept(1), error => error.code === 'GPU_COUNT' && error.hostProblem === true);
});
