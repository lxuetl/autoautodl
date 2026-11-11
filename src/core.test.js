const {test}=require('node:test');const assert=require('node:assert/strict');const core=require('./core');
test('只允许关机实例在同一主机且库存满足时开机',()=>{const i=core.instance({uuid:'i',machine_id:'m',status:'shutdown',req_gpu_amount:2});assert.equal(core.canStart(i,{id:'m',idle:2}),true);assert.equal(core.canStart(i,{id:'other',idle:9}),false);assert.equal(core.canStart(i,{id:'m',idle:1}),false);assert.equal(core.canStart({...i,status:'running'},{id:'m',idle:9}),false);});
test('不把缺失库存当作可开机',()=>{assert.throws(()=>core.stock({machine_id:'m'}));assert.throws(()=>core.stock({gpu_idle_num:-1}));});
test('用户输入有范围限制',()=>{assert.throws(()=>core.settings({seconds:0,count:1}));assert.throws(()=>core.settings({seconds:45,count:0}));assert.equal(core.settings({seconds:45,count:2}).count,2);});
test('拒绝未知列表结构',()=>{assert.throws(()=>core.listOf({foo:[]}));assert.deepEqual(core.listOf({list:[]}),[]);});
