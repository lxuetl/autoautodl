import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { Store } from './store.mjs';
import { Engine } from './engine.mjs';
import { Notifier } from './notifications.mjs';
import { normalizeConfig, normalizeNotifications, REGIONS } from './config.mjs';
import { normalizeGpuCatalog, catalogModelCount } from './gpu-catalog.mjs';
import { officialPricing } from './matching.mjs';
import { blocksTask, sameTaskResource, canReplaceTask, conflictError } from './task-conflicts.mjs';
import { previewPricing, pricingKey, QUOTE_MAX_AGE } from './pricing.mjs';
import { normalizeImagePrefix } from './images.mjs';
import { Wallet, minimumBudget, availableMilli } from './wallet.mjs';
import { validateCloneSource, publicInstance } from './instances.mjs';
import { AppError, redact, messageOf, fail } from './errors.mjs';
import { assertLocalRequest } from './local-access.mjs';
import { AutoDLBrowserAdapter } from './adapters/autodl.mjs';
import { AiAssistant, AI_PROVIDERS } from './ai.mjs';
import { normalizePlanInput, extractConstraints, mergeConstraints, buildPlan, normalizeImageHint, pickImageOption } from './env-plan.mjs';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 启动时发现运行锁被占用：查询已在运行的后台属于哪种情况。令牌只用于本机停止请求，不返回、不打印。
export async function inspectRunningBackend(port, { fetchImpl = fetch } = {}) {
  const base = 'http://127.0.0.1:' + port;
  try {
    const html = await (await fetchImpl(base + '/', { signal: AbortSignal.timeout(3000) })).text();
    const token = html.match(/name="local-token" content="([0-9a-f]+)"/)?.[1];
    if (!token) return { kind: 'unreachable' };
    const state = await (await fetchImpl(base + '/api/state', { headers: { 'X-Local-Token': token }, signal: AbortSignal.timeout(3000) })).json();
    const active = (state.tasks || []).filter(t => ['queued','watching','preparing','submitting','verifying','reconciling'].includes(t.state)).length;
    if (!state.server) return { kind: 'legacy', active };
    const stop = () => fetchImpl(base + '/api/server/stop', { method: 'POST', headers: { 'X-Local-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }), signal: AbortSignal.timeout(15000) });
    return { kind: state.server.codeChanged ? 'outdated' : 'current', active, canStop: state.server.canStop === true, stop };
  } catch { return { kind: 'unreachable' }; }
}
export function describeRunningBackend(info, { pid, port }) {
  const head = '本项目的后台（PID ' + pid + '）已在运行，端口 ' + port + '。为避免两个程序同时抢卡，这次没有再启动一份。\n关闭网页不会停止后台，再次双击启动也不会替换它。';
  const busy = info.active ? '当前有 ' + info.active + ' 个任务正在监测、提交或等待核对。' : '';
  if (info.kind === 'current') return head + '\n它运行的就是当前代码，直接在浏览器打开 http://127.0.0.1:' + port + ' 即可。要停止它，运行 npm.cmd run stop。';
  if (info.kind === 'outdated') return head + '\n它仍在运行启动时的代码，磁盘上的程序已更新。' + busy + '正常重启时，后台会等当前页面操作结束、保存状态并关闭专用浏览器，云端实例不受影响。';
  if (info.kind === 'legacy') return head + '\n它是不支持正常停止的旧版本，新功能和1秒检查间隔都没有生效。' + busy
    + '\n请先在网页中暂停任务，确认没有“提交中/验证实例与数据/等待绑定核对”的任务；再在任务管理器“详细信息”中结束 PID ' + pid + ' 的 node.exe，关闭专用浏览器窗口，然后重新双击“启动监测台.cmd”。';
  return head + '\n但端口没有正常响应，后台可能正在启动或停止。请稍等几秒再试；若一直如此，在任务管理器中核对 PID ' + pid + ' 是否为本项目的 node.exe。';
}
// 运行锁是否已释放：文件不在、已换成别的进程，或记录的进程已不存在（异常退出留下的锁，启动时按同样规则接管）。
export function lockReleased(lockPath, pid) {
  let owner;
  try { owner = Number(fs.readFileSync(lockPath, 'utf8')); } catch { return true; }
  if (owner !== pid) return true;
  try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
}
// 正常停止后台并等待它释放运行锁。没收到回复不等于后台没收到请求（它可能已经开始停止），
// 所以先核对运行锁和端口；后台仍在正常运行时再发一次（停止请求可重复发送）。不强制结束进程，不删除运行锁。
export async function stopRunningBackend(info, { pid, port, lockPath, name = '旧后台', waitSeconds = 180, fetchImpl = fetch,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), released = () => lockReleased(lockPath, pid),
  log = console.log, warn = console.error } = {}) {
  const alive = async () => { try { return (await fetchImpl('http://127.0.0.1:' + port + '/api/health', { signal: AbortSignal.timeout(3000) })).ok; } catch { return false; } };
  const send = async () => {
    try {
      const response = await info.stop();
      if (response.ok) return { ok: true };
      const data = await response.json().catch(() => ({}));
      return { refused: 'HTTP ' + response.status + (data.message ? '，' + redact(String(data.message)) : '') };
    } catch (error) {
      return { lost: error?.name === 'TimeoutError' ? '15秒内没有回复' : '连接中断（' + (error?.cause?.code || error?.code || error?.name || '未知原因') + '）' };
    }
  };
  let result = await send();
  if (!result.refused) log(result.ok ? '已请求' + name + '正常停止，正在等待当前页面操作结束……'
    : '停止请求没有收到回复：' + result.lost + '。' + name + '可能已经开始停止，正在核对运行锁和端口……');
  for (let i = 1; i <= waitSeconds && !result.refused; i++) {
    await sleep(1000);
    if (await released()) return true;
    if (result.ok || (i !== 5 && i !== 30) || !await alive()) continue;
    result = await send();
    if (!result.refused) log(result.ok ? name + '仍在正常运行，已重新发送停止请求并收到确认，继续等待……'
      : name + '仍在正常运行，重新发送的停止请求也没有收到回复（' + result.lost + '），继续等待……');
  }
  if (result.refused) warn(name + '拒绝停止（' + result.refused + '），未做任何处理');
  else warn('等待' + (waitSeconds >= 60 ? Math.round(waitSeconds / 60) + '分钟' : waitSeconds + '秒') + '后' + name + '仍未退出，未强制结束；请查看其窗口或任务管理器' + (pid ? '中的 PID ' + pid : ''));
  return false;
}
// 后端代码指纹（文件大小与修改时间），用于提示“磁盘代码已更新但后台仍在运行旧版本”。
export function codeFingerprint(root = ROOT) {
  const files = [];
  for (const dir of ['src', 'src/adapters', 'public']) {
    let names = [];
    try { names = fs.readdirSync(path.join(root, dir)); } catch { continue; }
    for (const name of names) {
      if (!/\.(?:mjs|js|html|css)$/.test(name)) continue;
      try { const info = fs.statSync(path.join(root, dir, name)); files.push(dir + '/' + name + ':' + info.size + ':' + Math.round(info.mtimeMs)); } catch {}
    }
  }
  return createHash('sha256').update(files.sort().join('\n')).digest('hex').slice(0, 16);
}
export function createApplication({ runtimeDir = process.env.AUTODL_RUNTIME_DIR || path.join(ROOT,'.runtime'),
  adapters: suppliedAdapters, startEngine = true, lock = true, aiOptions = {}, walletOptions = {}, secretProtector,
  onStop = null, fingerprint = codeFingerprint, imageBusyWaitMs = 20000 } = {}) {
  fs.mkdirSync(runtimeDir, {recursive:true,mode:0o700});
  const lockPath = path.join(runtimeDir,'server.lock');
  if (lock) {
    try {
      const fd = fs.openSync(lockPath,'wx',0o600); fs.writeFileSync(fd,String(process.pid)); fs.closeSync(fd);
    } catch(e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = Number(fs.readFileSync(lockPath,'utf8'));
      if (!Number.isInteger(pid) || pid <= 0) fail('LOCK','运行锁内容异常，请核对没有其他服务后删除 .runtime/server.lock');
      try { process.kill(pid,0); fail('LOCK','已有服务正在使用此状态目录，请勿启动第二个抢卡进程'); }
      catch(error) { if(error.code !== 'ESRCH') throw error; }
      // 接管失效的运行锁：删除前确认锁文件仍是那个已退出的进程；写入后稍等再读一次，若被同时启动的另一进程接管就退出。
      // 避免两次几乎同时启动时，一个进程删掉另一个刚写入的锁，两个后台共用同一状态。
      if (fs.readFileSync(lockPath,'utf8') !== String(pid)) fail('LOCK','运行锁刚被另一个进程接管，请勿同时启动两个服务');
      fs.unlinkSync(lockPath);
      const fd = fs.openSync(lockPath,'wx',0o600); fs.writeFileSync(fd,String(process.pid)); fs.closeSync(fd);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60);
      if (fs.readFileSync(lockPath,'utf8') !== String(process.pid)) fail('LOCK','运行锁被同时启动的另一个进程接管，本进程退出；请勿同时启动两个服务');
    }
  }
  const releaseLock = () => {
    if (lock) { try { if (fs.readFileSync(lockPath,'utf8') === String(process.pid)) fs.unlinkSync(lockPath); } catch {} }
  };
  let store;
  try { store = new Store(runtimeDir,{secretProtector}); } catch (error) { releaseLock(); throw error; }
  const adapters = suppliedAdapters || {autodl:new AutoDLBrowserAdapter(runtimeDir)};
  const wallet = new Wallet({...walletOptions,store});
  const notifier = new Notifier(store), engine = new Engine(store,adapters,notifier,{wallet});
  let pricePreview = null;
  let instanceSync = { instances: [], checkedAt: null, error: null };
  function requireSession() {
    const session = adapters.autodl.sessionStatus?.();
    if (session?.state !== 'ready' || !session.browserOpen)
      fail('LOGIN_CHECK_REQUIRED', '请先在“连接 AutoDL”中打开专用浏览器、完成登录并检查状态，显示“会话可用”后再操作', { status: 409 });
  }
  async function browserWork(work, { waitMs = 0 } = {}) {
    // waitMs：允许等待引擎完成当前一轮检查（镜像菜单在单独标签页读取，可与监测任务交替进行）。
    for (const deadline = Date.now() + waitMs; engine.busy && !engine.stopping && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 50));
    if(engine.busy || engine.stopping) fail('BUSY','正在执行页面操作，请稍后重试；如持续忙碌，请先暂停真实任务',{status:409});
    engine.busy=true;
    try { return await work(); } finally { engine.busy=false; }
  }
  function checkTaskSlot(config, replaceTaskId = null) {
    const replaces = replaceTaskId ? store.get(replaceTaskId) : null;
    if (replaces && (!sameTaskResource(replaces, config) || !canReplaceTask(replaces))) {
      if (blocksTask(replaces, config)) throw conflictError(replaces);
      fail('TASK_CHANGED', '旧任务状态已变化或与当前资源不匹配，请重新检查后再重建', { status: 409 });
    }
    const duplicate = store.tasks().find(t => t !== replaces && blocksTask(t, config));
    if (duplicate) throw conflictError(duplicate);
    return replaces;
  }
  async function readInstances(expectedModel = '') {
    requireSession();
    try {
      if (typeof adapters.autodl.instances !== 'function') fail('INSTANCES','当前适配器不支持实例同步');
      const rows = await adapters.autodl.instances(expectedModel);
      instanceSync = { instances: rows.map(publicInstance), checkedAt: Date.now(), error: null };
      return rows;
    } catch (error) {
      instanceSync = { ...instanceSync, error: redact(messageOf(error)) };
      throw error;
    }
  }
  const ai = new AiAssistant(store, aiOptions);
  const token = randomBytes(32).toString('hex');
  const startedAt = Date.now(), startCode = fingerprint();
  let codeCheck = { at: 0, changed: false };
  function serverState() {
    // 每5秒最多重新计算一次，避免网页轮询频繁读取文件信息。
    if (Date.now() - codeCheck.at > 5000) codeCheck = { at: Date.now(), changed: fingerprint() !== startCode };
    return { startedAt, codeChanged: codeCheck.changed, canStop: typeof onStop === 'function' };
  }
  function json(res,status,body) { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(JSON.stringify(body)); }
  async function body(req) {
    let size=0, chunks=[];
    for await (const part of req) { size+=part.length; if(size>98304) fail('SIZE','请求过大',{status:413}); chunks.push(part); }
    let data;
    try { data=JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { fail('JSON','请求不是有效 JSON'); }
    if(!data || typeof data!=='object' || Array.isArray(data)) fail('JSON','请求正文必须是 JSON 对象');
    return data;
  }
  const server = http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Cross-Origin-Resource-Policy','same-origin');
    // 别的网站打开控制台后不能保留对这个标签页的引用（例如之后把它跳转到仿冒页面）。
    res.setHeader('Cross-Origin-Opener-Policy','same-origin');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const host = assertLocalRequest(req);
      const url = new URL(req.url,`http://${host}`);
      if (url.pathname === '/api/health' && req.method === 'GET') return json(res,200,{ok:true,version:'0.2.1'});
      if(url.pathname.startsWith('/api/')) {
        if(req.headers['x-local-token'] !== token) fail('TOKEN','本地访问令牌无效，请重新加载页面',{status:403});
        if(req.method === 'GET' && url.pathname === '/api/state') return json(res,200,{...store.publicState(),
          browser:{status:adapters.autodl.lastStatus || '会话不可用',busy:engine.busy,
            session:adapters.autodl.sessionStatus?.() || {state:'unavailable',label:'会话不可用',message:'请打开专用浏览器并核验登录',checkedAt:null,browserOpen:false}},
          autodlInstances: adapters.autodl.sessionStatus?.()?.state === 'ready' ? instanceSync : {instances:[],checkedAt:null,error:null},
          wallet:wallet.publicState(),credentialStorage:store.secretStorage.publicState(),regions:REGIONS,gpuCatalog:normalizeGpuCatalog(store.data.gpuCatalog),ai:ai.publicState(),aiProviders:AI_PROVIDERS,server:serverState(),now:Date.now()});
        if(req.method !== 'POST') fail('METHOD','不支持的请求方法',{status:405});
        if(!(req.headers['content-type'] || '').startsWith('application/json')) fail('CONTENT_TYPE','控制请求需使用 JSON',{status:415});
        const data = await body(req);
        // 正常停止本地后台：等待当前页面操作结束、保存状态、关闭专用浏览器。不关闭云端实例。
        if(url.pathname === '/api/server/stop') {
          if(data.confirm !== true) fail('CONFIRM','请明确确认停止本地后台',{status:400});
          if(typeof onStop !== 'function') fail('UNSUPPORTED','当前运行方式不支持从页面停止后台',{status:409});
          // 回复发完、连接关闭后再停止：停止时会断开空闲连接，过早停止可能让调用方收不到这条回复。
          res.once('close',()=>setImmediate(onStop));res.setHeader('Connection','close');
          json(res,202,{ok:true,message:'后台正在停止：等待当前页面操作结束后关闭专用浏览器；云端实例不受影响'});
          return;
        }
        if(url.pathname === '/api/ai/settings') return json(res,200,{ok:true,ai:ai.saveSettings(data)});
        if(url.pathname === '/api/ai/clear-key') return json(res,200,{ok:true,ai:ai.clearKey()});
        if(url.pathname === '/api/ai/cancel') { ai.cancel(); return json(res,200,{ok:true}); }
        if(url.pathname === '/api/ai/analyze') return json(res,200,await ai.analyze(data));
        // 环境与选卡规划：规则部分在本机完成、不调用模型；勾选模型时由模型补充，模型失败仍返回规则结果。不创建或修改任务。
        if(url.pathname === '/api/plan') {
          const input = normalizePlanInput(data), text = input.request + '\n' + input.projectText;
          const rules = extractConstraints(text, { request: input.request });
          let model = null, constraints = rules;
          if (input.useModel) {
            try {
              const out = await ai.extract(input);
              constraints = mergeConstraints(rules, out.accepted);
              model = { accepted: out.accepted.length, rejected: out.rejected, summary: out.summary, meta: out.meta };
            } catch (error) {
              if (!(error instanceof AppError)) throw error;
              model = { error: redact(messageOf(error)), code: error.code };
            }
          }
          return json(res,200,{ ...buildPlan(constraints, normalizeGpuCatalog(store.data.gpuCatalog), { gpuCount: input.gpuCount }), model,
            advisoryOnly: true, automaticExecution: false });
        }
        // 按规划结果在 AutoDL 官方镜像菜单中逐级选择（只读菜单），返回每级选项供页面填入；不提交任何任务。
        if(url.pathname === '/api/plan/image') {
          const hint = normalizeImageHint(data.hint);
          return json(res,200,await browserWork(async()=>{
            requireSession();
            if(typeof adapters.autodl.imageOptions !== 'function')fail('IMAGES','当前适配器不支持官方基础镜像同步，请更新后台');
            const path = [], levels = [];
            for (let level = 0; level < 4; level++) {
              const menu = await adapters.autodl.imageOptions(path), pick = pickImageOption(level, menu.options, hint);
              levels.push({ level, options: menu.options, label: pick.label, reason: pick.reason });
              if (!pick.label) break;
              path.push(pick.label);
            }
            return { path, complete: path.length === 4, levels, checkedAt: Date.now() };
          },{waitMs:imageBusyWaitMs}));
        }
        if(url.pathname === '/api/wallet/token') {
          wallet.setToken(data.token,{rememberToken:data.rememberToken ?? false}); await wallet.refresh({force:true});
          return json(res,200,{ok:true,wallet:wallet.publicState()});
        }
        if(url.pathname === '/api/wallet/clear-token') { wallet.clearToken(); return json(res,200,{ok:true,wallet:wallet.publicState()}); }
        if(url.pathname === '/api/wallet/refresh') { await wallet.refresh({force:true}); return json(res,200,{wallet:wallet.publicState()}); }
        if(url.pathname === '/api/wallet/preflight') {
          const config=normalizeConfig({...data,action:'observe',paidConsent:false});
          if(officialPricing(config) && (!pricePreview?.quote || pricePreview.configKey!==pricingKey(config) || Date.now()-pricePreview.checkedAt>QUOTE_MAX_AGE))
            fail('PRICE_REQUIRED','请先读取当前配置的官方报价，再预检余额；过期或无库存时不会用固定价格估算',{status:409});
          return json(res,200,{check:await wallet.check(config,officialPricing(config)?pricePreview.quote:null,{force:true}),wallet:wallet.publicState()});
        }
        if(url.pathname === '/api/autodl/images') {
          const prefix = normalizeImagePrefix(data.prefix);
          return json(res,200,await browserWork(async()=>{
            requireSession();
            if(typeof adapters.autodl.imageOptions !== 'function')fail('IMAGES','当前适配器不支持官方基础镜像同步，请更新后台');
            return adapters.autodl.imageOptions(prefix);
          },{waitMs:imageBusyWaitMs}));
        }
        // 从 AutoDL 创建页按地区同步官方 GPU 型号；保存到本机状态，重启后仍可选择，需要时再同步。
        if(url.pathname === '/api/autodl/gpus') {
          const catalog = await browserWork(async()=>{
            requireSession();
            if(typeof adapters.autodl.gpuCatalog !== 'function')fail('GPU_CATALOG','当前后台不支持同步 AutoDL 型号，请重启后台加载新版代码');
            return normalizeGpuCatalog(await adapters.autodl.gpuCatalog(REGIONS));
          },{waitMs:imageBusyWaitMs});
          // 一个型号都没读到时不覆盖上次保存的目录。
          if(!catalogModelCount(catalog)) fail('GPU_CATALOG','没有从 AutoDL 创建页读到任何 GPU 型号：'+((catalog?.regions||[]).map(row=>row.region+(row.error?'（'+row.error+'）':row.missing?'（页面没有此地区）':row.disabled?'（地区不可选）':'（无型号）')).join('、')||'页面没有可读取的地区')+'。上次同步的型号已保留，请检查专用浏览器页面后重试',{status:502});
          store.data.gpuCatalog = catalog; store.save();
          return json(res,200,catalog);
        }
        if(url.pathname === '/api/pricing/preview') {
          const config=normalizeConfig({...data,action:'observe',paidConsent:false});
          const work=async()=>{pricePreview=null;requireSession();pricePreview=await previewPricing(adapters.autodl,config);return pricePreview;};
          return json(res,200,await browserWork(work));
        }
        if(url.pathname === '/api/browser/logout') {
          if(data.clearCredentials!==undefined && typeof data.clearCredentials!=='boolean')fail('CONFIG','清除凭据选项必须为布尔值');
          const result=await browserWork(async()=>{
            if(typeof adapters.autodl.logout!=='function')fail('BROWSER','当前适配器不支持清除专用浏览器登录');
            let paused=0;
            for(const task of store.tasks())if(task.config.provider==='autodl' && ['queued','watching','preparing','submitting','verifying'].includes(task.state)) {engine.control(task,'pause');paused++;}
            instanceSync={instances:[],checkedAt:null,error:null};pricePreview=null;
            const result=await adapters.autodl.logout();
            if(data.clearCredentials===true) {
              ai.clearKey();wallet.clearToken();
              store.data.settings={webhookEnabled:false,wechatEnabled:false,rememberCredentials:false};store.save();
            }
            return {...result,paused,credentialsCleared:data.clearCredentials===true};
          });
          return json(res,200,result);
        }
        if(url.pathname === '/api/autodl/instances') {
          await browserWork(()=>readInstances());
          return json(res,200,instanceSync);
        }
        if(url.pathname === '/api/tasks') {
          const config = normalizeConfig(data), replaceTaskId = data.replaceTaskId ?? null;
          if (replaceTaskId !== null && (typeof replaceTaskId !== 'string' || !/^[\w-]{1,80}$/.test(replaceTaskId)))
            fail('CONFIG', '替换任务 ID 无效');
          const create = async () => {
            requireSession();
            if(store.tasks().length>=500) fail('LIMIT','任务数量已达500，请备份状态并更换运行目录');
            checkTaskSlot(config, replaceTaskId);
            if (config.provider === 'autodl' && config.mode === 'clone') {
              const rows=await readInstances(config.gpuModel);
              validateCloneSource(config,rows.find(i=>i.id===config.sourceId));
            }
            let balanceCheck = null;
            if (config.provider === 'autodl' && config.action === 'execute' && config.balanceGuard) {
              if(officialPricing(config)) {
                const fresh=pricePreview && pricePreview.configKey===pricingKey(config) && Date.now()-pricePreview.checkedAt<=QUOTE_MAX_AGE ? pricePreview : null;
                if(fresh?.quote)balanceCheck=await wallet.check(config,fresh.quote,{force:true});
                else {
                  const snapshot=await wallet.refresh({force:true});balanceCheck={pendingQuote:true,checkedAt:Date.now()};
                  // 暂无完整报价时，按刚读到的页面单卡价估算下限：余额确定不够就先请用户充值，不开始监测。
                  const prices=(fresh?.listed||[]).map(host=>host.price).filter(price=>Number.isFinite(price)&&price>0);
                  const need=prices.length?minimumBudget(config,Math.min(...prices)):null;
                  if(need&&availableMilli(snapshot,config)<need.requiredMilli)
                    fail('BALANCE_INSUFFICIENT','可用余额 ¥'+(availableMilli(snapshot,config)/1000).toFixed(2)+'，不足页面单卡价 ¥'+Math.min(...prices)+'/时 × '+config.gpuCount+' 卡 × '+need.hours+' 小时'+(config.balanceReserve?' + 保留余额':'')+' ≈ ¥'+need.required.toFixed(2)+'。找到空闲 GPU 也无法提交，请先充值后再开始监测',{status:409});
                }
              }
              else balanceCheck = await wallet.check(config,null,{force:true});
            }
            // 源实例/余额查询期间可能有暂停或恢复请求；落盘前再次校验旧任务状态。
            const replaces = checkTaskSlot(config, replaceTaskId);
            return store.create(config, { balanceCheck, replaces });
          };
          const task=await browserWork(create);
          return json(res,201,{task});
        }
        if(url.pathname === '/api/notifications/settings') {
          const previous=store.data.settings;store.data.settings=normalizeNotifications(data,previous);
          try {store.save();} catch(error) {store.data.settings=previous;throw error;}
          return json(res,200,{ok:true,message:'已保存。外部渠道仅在任务发现资源、完成、失败或需处理时发送通知'});
        }
        if(url.pathname === '/api/notifications/read') {
          store.data.notifications.forEach(n=>n.read=true);store.save();return json(res,200,{ok:true});
        }
        if(['/api/browser/open','/api/browser/check'].includes(url.pathname)) {
          if(engine.busy || engine.stopping) fail('BUSY','正在执行页面操作，请稍后重试；如持续忙碌，请先暂停真实任务，不会打断正在进行的提交',{status:409});
          engine.busy=true;
          try {
            const method = url.pathname.endsWith('/check') ? 'checkLogin' : 'login';
            if (typeof adapters.autodl[method] !== 'function') fail('BROWSER','当前适配器未连接真实浏览器');
            instanceSync = { instances: [], checkedAt: null, error: null };pricePreview=null;
            return json(res,200,await adapters.autodl[method]());
          } finally {engine.busy=false;}
        }
        const matched = url.pathname.match(/^\/api\/tasks\/([\w-]+)\/(pause|resume|cancel|attach|verify-data|recheck)$/);
        if(matched) {
          const task=store.get(matched[1]);
          if(matched[2] === 'attach') await engine.attach(task,data.instanceId);
          else if(matched[2] === 'recheck') {
            if(data.confirmed !== true) fail('CONFIRM','请确认已了解：仅在完整实例列表没有新增实例时才清除提交记录',{status:400});
            requireSession();
            return json(res,200,{task,result:await engine.recheck(task)});
          }
          else {
            if (matched[2] === 'resume' && !task.operation) {
              const duplicate = store.tasks().find(t => t !== task && blocksTask(t, task.config));
              if (duplicate) throw conflictError(duplicate);
            }
            engine.control(task,matched[2],data);
          }
          return json(res,200,{task});
        }
        fail('NOT_FOUND','接口不存在',{status:404});
      }
      if(req.method!=='GET') fail('METHOD','不支持的请求方法',{status:405});
      const assets = {'/':'index.html','/index.html':'index.html','/app.js':'app.js','/account.js':'account.js','/images.js':'images.js','/ai.js':'ai.js','/plan.js':'plan.js','/style.css':'style.css','/favicon.svg':'favicon.svg'};
      const asset=assets[url.pathname];
      if(!asset) fail('NOT_FOUND','页面不存在',{status:404});
      const contentType=asset.endsWith('.css')?'text/css':asset.endsWith('.js')?'text/javascript':asset.endsWith('.svg')?'image/svg+xml':'text/html';
      let content=fs.readFileSync(path.join(ROOT,'public',asset),'utf8');
      if(asset==='index.html') content=content.replace('__LOCAL_TOKEN__',token);
      res.writeHead(200,{'Content-Type':`${contentType}; charset=utf-8`,'Cache-Control':'no-store'});res.end(content);
    } catch(error) {
      const conflict = error.code === 'DUPLICATE' && error.conflict ? {
        ...error.conflict, name: redact(error.conflict.name), lastError: error.conflict.lastError ? redact(error.conflict.lastError) : null,
      } : null;
      json(res,error.status || 500,{error:error.code || 'INTERNAL',message:redact(messageOf(error)),...(conflict ? { conflict } : {})});
    }
  });
  if(startEngine) engine.start();
  let closing;
  return {server,store,engine,adapters,ai,wallet,token,close(){
    if (!closing) closing = (async () => {
      ai.close(); wallet.close();
      const closed = new Promise(resolve => server.close(resolve));
      try {
        await engine.stop(); await notifier.stop();
        await Promise.allSettled(Object.values(adapters).map(a=>a.close?.()));
        await closed;
      } finally { releaseLock(); }
    })();
    return closing;
  }};
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  let app, closing=false;
  const port=Number(process.env.PORT || 8787);
  const lockPath=path.join(process.env.AUTODL_RUNTIME_DIR || path.join(ROOT,'.runtime'),'server.lock');
  const shutdown=async()=>{if(closing)return;closing=true;await app.close();process.exit(0);};
  const start=()=>{
    app=createApplication({onStop:()=>void shutdown()});
    app.server.listen(port,'127.0.0.1',()=>console.log(`AutoDL GPU 监测台已启动：http://127.0.0.1:${port}\n仅连接真实 AutoDL，默认仅监测；关闭此进程或电脑休眠将停止检查，关闭网页不会停止。\n正常停止：在此窗口按 Ctrl+C，或在项目目录运行 npm.cmd run stop。`));
    app.server.on('error',async error=>{console.error(redact(messageOf(error)));await app.close();process.exitCode=1;});
  };
  // 已有后台在运行时说明是哪一个；代码已更新的后台可在确认后正常停止并用当前代码重启。
  const explainRunning=async error=>{
    let pid=null;try{pid=Number(fs.readFileSync(lockPath,'utf8'));}catch{}
    if(!Number.isInteger(pid)||pid<=0){console.error(redact(messageOf(error)));return 1;}
    const info=await inspectRunningBackend(port);
    console.log(describeRunningBackend(info,{pid,port}));
    if(info.kind!=='outdated'||!info.canStop||!process.stdin.isTTY)return info.kind==='current'?0:1;
    const rl=readline.createInterface({input:process.stdin,output:process.stdout});
    const answer=await rl.question('输入 Y 并回车：正常停止旧后台并用当前代码重新启动；直接回车：不处理。');rl.close();
    if(!/^y(?:es)?$/i.test(answer.trim()))return 1;
    if(!await stopRunningBackend(info,{pid,port,lockPath}))return 1;
    start();console.log('重启后请在网页中重新打开专用浏览器并检查登录状态，再恢复需要处理的任务。');return null;
  };
  for(const signal of ['SIGINT','SIGTERM','SIGHUP'])process.on(signal,()=>{if(app)void shutdown();else process.exit(130);});
  try { start(); }
  catch(error){
    if(error.code==='LOCK'){const code=await explainRunning(error).catch(e=>{console.error(redact(messageOf(e)));return 1;});if(code!==null)process.exitCode=code;}
    else{console.error(redact(messageOf(error)));process.exitCode=1;}
  }
}
