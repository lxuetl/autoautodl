const {test}=require('node:test');const assert=require('node:assert/strict');const core=require('./core');
test('只允许关机实例在同一主机且库存满足时开机',()=>{const i=core.instance({uuid:'i',machine_id:'m',status:'shutdown',req_gpu_amount:2});assert.equal(core.canStart(i,{id:'m',idle:2}),true);assert.equal(core.canStart(i,{id:'other',idle:9}),false);assert.equal(core.canStart(i,{id:'m',idle:1}),false);assert.equal(core.canStart({...i,status:'running'},{id:'m',idle:9}),false);});
test('缺失或无效库存显示未知，不中断同步，也不触发开机',()=>{
  const item=core.instance({uuid:'i',machine_id:'m',status:'shutdown',req_gpu_amount:1});
  for(const value of [undefined,null,'',true,[],{},-1,1.2,'Infinity','1.5']){
    const s=core.stock({machine_id:'m',gpu_idle_num:value});assert.equal(s.idle,null);assert.equal(core.canStart(item,s),false);
  }
  assert.equal(core.stock(null).idle,null);
});
test('混合库存记录保留可识别的记录，不将总卡数当空闲卡数',()=>{
  const records=[{machine_id:'a',gpu_idle_num:'2'},{machine_id:'b',gpu_all_num:8},{machine_id:'c',gpu_idle_num:null,idle_gpu_num:3}].map(core.stock);
  assert.deepEqual(records.map(r=>r.idle),[2,null,3]);
  assert.equal(core.stock({gpu_idle_num:1,idle_gpu_num:4}).idle,null);
});
test('诊断只包含字段名和类型，不包含字段值',()=>{
  const s=core.stock({machine_id:'sensitive-host',token:'sensitive-token',gpu_idle_num:null});
  assert.ok(s.schema.includes('token:string'));assert.equal(JSON.stringify(s.schema).includes('sensitive'),false);
});
test('无主机标识绝不自动开机',()=>{assert.equal(core.canStart({status:'shutdown',machine:'',count:1},{id:'',idle:9}),false);});
test('用户输入有范围限制',()=>{assert.throws(()=>core.settings({seconds:0,count:1}));assert.throws(()=>core.settings({seconds:45,count:0}));assert.equal(core.settings({seconds:45,count:2}).count,2);});
test('拒绝未知列表结构',()=>{assert.throws(()=>core.listOf({foo:[]}));assert.deepEqual(core.listOf({list:[]}),[]);});
