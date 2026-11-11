'use strict';
const core=require('./core');
// 对照胡闹 AutoDL：仅请求选中实例的库存，第1页100条，严格按主机ID取值。
class StockClient {
  constructor(request){this.request=request;this.retryUntil=0;this.lastError=null;this.diagnostics={};this.compatible=new Map();}
  async fetch(selected){
    this.diagnostics={mode:'reference_target',selectedInstance:!!selected,hasMachineId:!!selected?.machine};
    if(!selected?.machine){this.diagnostics.mode='waiting_for_target';return [];}
    const count=Math.max(Number(selected.count),1);
    if(!Number.isInteger(count)||count>16)throw new Error('目标 GPU 数量无效');
    const body={default_order:true,gpu_idle_num:count,page_index:1,page_size:100};
    if(selected.gpu)body.gpu_type_name=[selected.gpu];
    if(selected.region)body.region_sign_list=[selected.region];
    if(selected.charge)body.charge_type=selected.charge;
    Object.assign(this.diagnostics,{requestedGpu:selected.gpu||'',requestedRegion:selected.region||'',requiredCards:count,filterFields:Object.keys(body),page:1});
    if(Date.now()<this.retryUntil)throw this.lastError;
    try{
      const raw=core.listOf(await this.request('/user/machine/list',body)),rows=raw.map(core.stock).filter(m=>m.id===selected.machine);
      this.diagnostics.returnedRecords=raw.length;this.diagnostics.matchedRecords=rows.length;
      this.retryUntil=0;this.lastError=null;
      // 没找到主机表示未知，不能使用同型号其他主机的卡。
      if(!rows.length)return [];
      const first=rows[0];first.idle=rows.some(m=>m.idle===null)?null:Math.min(...rows.map(m=>m.idle));return [first];
    }catch(error){this.diagnostics.errorCode=error.apiCode||'REQUEST_FAILED';this.lastError=error;if(error.apiCode==='DatabaseError')this.retryUntil=Date.now()+30000;throw error;}
  }
}
module.exports={StockClient};
