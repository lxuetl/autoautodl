const {contextBridge,ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('app', {
  call:(action,payload)=>ipcRenderer.invoke('command',action,payload),
  onState:callback=>ipcRenderer.on('state',(_,state)=>callback(state))
});
