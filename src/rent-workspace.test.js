const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createRentWorkspace}=require('./rent-workspace');

test('租机工作台只监听回环地址，API 需要本地令牌，退出释放端口',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'autodl-desktop-workspace-'));
  let workspace;
  try{
    workspace=await createRentWorkspace(dir);
    assert.equal(workspace.service.server.address().address,'127.0.0.1');
    const page=await fetch(workspace.url);
    const html=await page.text();
    assert.equal(page.status,200);
    assert.ok(html.includes('local-token'));
    assert.equal((await fetch(workspace.url+'/api/state')).status,403);
    const token=html.match(/name="local-token" content="([0-9a-f]+)"/)[1];
    const state=await (await fetch(workspace.url+'/api/state',{headers:{'X-Local-Token':token}})).json();
    assert.deepEqual(state.tasks,[]);
    await workspace.close();
    assert.equal(workspace.service.server.listening,false);
  }finally{
    if(workspace)await workspace.close();
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
