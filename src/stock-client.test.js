const {test}=require('node:test');const assert=require('node:assert/strict');const {StockClient}=require('./stock-client');
const target={machine:'m',gpu:'RTX 4090',region:'west',count:2,charge:'payg'};
test('目标库存请求与参考协议一致，只取第1页100条并按主机ID匹配',async()=>{
 let body;const client=new StockClient(async(_,data)=>{body=data;return {list:[{machine_id:'m',gpu_idle_num:2},{machine_id:'other',gpu_idle_num:64}]};});
 const rows=await client.fetch(target);assert.deepEqual(body,{default_order:true,gpu_idle_num:2,page_index:1,page_size:100,gpu_type_name:['RTX 4090'],region_sign_list:['west'],charge_type:'payg'});assert.equal(rows.length,1);assert.equal(rows[0].idle,2);
});
test('未选目标或目标没有主机ID不发送全市场请求',async()=>{
 const client=new StockClient(async()=>{throw new Error('不得请求');});assert.deepEqual(await client.fetch(null),[]);assert.deepEqual(await client.fetch({count:1}),[]);
});
test('DatabaseError不去掉条件重试，保留错误并冷却',async()=>{
 let calls=0;const client=new StockClient(async()=>{calls++;throw Object.assign(new Error('DatabaseError'),{apiCode:'DatabaseError'});});
 await assert.rejects(client.fetch(target),/DatabaseError/);await assert.rejects(client.fetch(target),/DatabaseError/);assert.equal(calls,1);
});
test('分页结果没有目标主机时显示未知，不借用其他主机库存',async()=>{
 const client=new StockClient(async()=>({list:[{machine_id:'other',gpu_idle_num:99}],max_page:10}));assert.deepEqual(await client.fetch(target),[]);
});
test('重复目标主机记录保守取最小值，不叠加',async()=>{
 const client=new StockClient(async()=>[{machine_id:'m',gpu_idle_num:3},{machine_id:'m',gpu_idle_num:1}]);assert.equal((await client.fetch(target))[0].idle,1);
});
