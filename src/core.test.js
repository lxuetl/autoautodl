const {test}=require('node:test');const assert=require('node:assert/strict');const core=require('./core');
test('只允许关机实例在同一主机且库存满足时开机',()=>{const i=core.instance({uuid:'i',machine_id:'m',status:'shutdown',req_gpu_amount:2});assert.equal(core.canStart(i,{id:'m',idle:2}),true);assert.equal(core.canStart(i,{id:'other',idle:9}),false);assert.equal(core.canStart(i,{id:'m',idle:1}),false);assert.equal(core.canStart({...i,status:'running'},{id:'m',idle:9}),false);});
test('缺失或无效库存显示未知，不中断同步，也不触发开机',()=>{
  const item=core.instance({uuid:'i',machine_id:'m',status:'shutdown',req_gpu_amount:1});
  for(const value of [undefined,null,'',true,[],{},'Infinity']){
    const s=core.stock({machine_id:'m',gpu_idle_num:value});assert.equal(s.idle,null);assert.equal(core.canStart(item,s),false);
  }
  assert.equal(core.stock(null).idle,null);
});
test('混合库存记录保留可识别的记录，不将总卡数当空闲卡数',()=>{
  const records=[{machine_id:'a',gpu_idle_num:'2'},{machine_id:'b',gpu_all_num:8},{machine_id:'c',gpu_idle_num:null,idle_gpu_num:3}].map(core.stock);
  assert.deepEqual(records.map(r=>r.idle),[2,null,3]);
  assert.equal(core.stock({gpu_idle_num:1,idle_gpu_num:4}).idle,1);
});
test('诊断只包含字段名和类型，不包含字段值',()=>{
  const s=core.stock({machine_id:'sensitive-host',token:'sensitive-token',gpu_idle_num:null});
  assert.ok(s.schema.includes('token:string'));assert.equal(JSON.stringify(s.schema).includes('sensitive'),false);
});
test('无主机标识绝不自动开机',()=>{assert.equal(core.canStart({status:'shutdown',machine:'',count:1},{id:'',idle:9}),false);});
test('对齐参考实现的有限数值转换、负值归零和字段优先级',()=>{
  for(const [value,count] of [[-1,0],[0.5,0],[1.9,1],[' 2 ',2],['1,000',1000],['1.5',1]])assert.equal(core.stock({gpu_idle_num:value}).idle,count);
  assert.equal(core.stock({gpu_idle_num:-1,idle_gpu_num:2}).idle,0);
  assert.equal(core.stock({gpu_idle_num:'bad',idle_gpu_num:'2'}).idle,2);
  for(const value of [Number.MAX_SAFE_INTEGER+1,Infinity])assert.equal(core.stock({gpu_idle_num:value}).idle,null);
});
test('93条中1条负库存不会阻断同步或开机监控',()=>{
  const records=Array.from({length:92},()=>core.stock({gpu_idle_num:2}));
  records.push(core.stock({gpu_idle_num:-1,machine_id:'private-host'}));
  const report=core.stockDiagnostics(records,'0.2.3-test.1');
  assert.equal(report.known,93);assert.equal(report.unknown,0);assert.deepEqual(report.reasons,{});
  assert.equal(records[92].idle,0);
  assert.equal(core.canStart({status:'shutdown',machine:'private-host',count:1},records[92]),false);
  assert.equal(JSON.stringify(report).includes('private-host'),false);
});
test('主机ID统一空格与大小写，并接受 machines 列表容器',()=>{
  const i=core.instance({uuid:'i',machine_id:' ABC ',status:'Shutdown',req_gpu_amount:1});
  assert.equal(core.canStart(i,core.stock({machine_id:'abc',gpu_idle_num:1})),true);
  assert.equal(core.listOf({machines:[1]}).length,1);
});
test('用户输入有范围限制',()=>{assert.throws(()=>core.settings({seconds:0,count:1}));assert.throws(()=>core.settings({seconds:45,count:0}));assert.equal(core.settings({seconds:45,count:2}).count,2);});
test('拒绝未知列表结构',()=>{assert.throws(()=>core.listOf({foo:[]}));assert.deepEqual(core.listOf({list:[]}),[]);});

test('目标主机统计排除其他主机，不将查询合计当成开机库存',()=>{
  const state={target:'i',instances:[{id:'i',machine:'m',count:2}],markets:[{id:'other',idle:64},{id:'m',idle:0}]};
  assert.equal(core.stockSummary(state).value,'0');
  assert.equal(core.stockSummary({...state,target:'',watching:true}).value,'64');
  assert.equal(core.stockSummary({...state,markets:[{id:'other',idle:64}]}).value,'未知');
  assert.equal(core.stockSummary({...state,markets:[{id:'m',idle:null}]}).value,'未知');
  assert.equal(core.stockSummary({...state,target:'missing'}).value,'未知');
  assert.equal(core.stockSummary({...state,markets:[{id:'m',idle:2},{id:'m',idle:3}]}).value,'2');
});
test('检查间隔允许1秒，限流等待高于配置间隔，失败会逐步退避',()=>{
  assert.equal(core.settings({seconds:1,count:1}).seconds,1);
  assert.throws(()=>core.settings({seconds:0,count:1}));
  assert.equal(core.pollDelay(1,0),1000);assert.equal(core.pollDelay(1,3),8000);
  assert.equal(core.pollDelay(1,0,31000,1000),30000);
  assert.equal(core.pollDelay(3600,8),3600000);
});
test('金额以千分元换算，缺失现金不能冒充零余额',()=>{
  const b=core.balance({assets:12345,voucher_balance:2000,blocked_asset:500});
  assert.equal(b.cash,12.345);assert.equal(b.voucher,2);assert.equal(b.blocked,.5);
  assert.throws(()=>core.balance({}));assert.equal(core.balance({assets:0}).voucher,null);
});
test('账单按北京时间统计，充值不算消费，退款抵扣消费，未知值可见',()=>{
  const now=Date.parse('2026-11-11T12:00:00+08:00');
  const rows=[{id:1,bill_type:'charge',asset:10000,created_at:'2026-11-11 00:01:00'},{id:2,bill_type:'refund',asset:3000,created_at:'2026-11-11 01:00:00'},{id:3,bill_type:'recharge',asset:100000,created_at:'2026-11-11 02:00:00'},{id:4,asset:null,created_at:'bad'}].map(core.bill);
  const summary=core.billingSummary(rows,14,now);assert.equal(summary.total,7);assert.equal(summary.series.at(-1).amount,7);assert.equal(summary.unknown,1);
});
test('资源字段保留未知值，最早释放时间有效，不传递密码',()=>{
  const item=core.instance({uuid:'i',usage_info:{mem_limit:1024,mem_usage:256},rent_deadline:'2026-12-01 00:00:00',expired_at:'2026-11-20 00:00:00',root_password:'secret'});
  assert.equal(item.memoryTotal,1024);assert.equal(item.dataUsed,null);assert.equal(item.releaseAt,Date.parse('2026-11-20T00:00:00+08:00'));assert.equal(JSON.stringify(item).includes('secret'),false);
});
test('今日/七天/本月汇总跨月时不会混入上月消费',()=>{
 const now=Date.parse('2026-11-02T12:00:00+08:00');
 const records=[['2026-10-31',5],['2026-11-01',2],['2026-11-02',3]].map(([day,amount])=>({at:Date.parse(day+'T01:00:00+08:00'),amount,type:'charge',gpu:'GPU'}));
 const s=core.billingSummary(records,35,now);assert.equal(s.today,3);assert.equal(s.last7,10);assert.equal(s.month,5);
});
