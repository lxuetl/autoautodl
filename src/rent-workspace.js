'use strict';
const path = require('node:path');
const {pathToFileURL} = require('node:url');

// 不把 Electron IPC 或主窗口中的 Token 暴露给工作台网页。
async function createRentWorkspace(runtimeDir) {
  const moduleURL = pathToFileURL(path.join(__dirname, '../vendor/autodl-watch/src/server.mjs')).href;
  const {createApplication} = await import(moduleURL);
  const service = createApplication({runtimeDir});
  try {
    await new Promise((resolve,reject) => {
      service.server.once('error',reject);
      service.server.listen(0,'127.0.0.1',resolve);
    });
    const port = service.server.address().port;
    return {service, url:`http://127.0.0.1:${port}`, close:()=>service.close()};
  } catch(error) {
    await service.close();
    throw error;
  }
}
module.exports = {createRentWorkspace};
