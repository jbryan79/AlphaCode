import { contextBridge, ipcRenderer } from 'electron';
import type { BridgeApi, SessionEvent } from '../shared/types';

const bridge:BridgeApi={
  loadState:()=>ipcRenderer.invoke('bridge:load-state'),
  saveState:state=>ipcRenderer.invoke('bridge:save-state',state),
  appInfo:()=>ipcRenderer.invoke('bridge:app-info'),
  chooseDirectory:()=>ipcRenderer.invoke('bridge:choose-directory'),
  exportWorkspace:workspace=>ipcRenderer.invoke('bridge:export-workspace',workspace),
  importWorkspace:()=>ipcRenderer.invoke('bridge:import-workspace'),
  startSession:(pane,cols,rows)=>ipcRenderer.invoke('bridge:start-session',pane,cols,rows),
  stopSession:paneId=>ipcRenderer.invoke('bridge:stop-session',paneId),
  writeSession:(paneId,data)=>ipcRenderer.send('bridge:write-session',paneId,data),
  resizeSession:(paneId,cols,rows)=>ipcRenderer.send('bridge:resize-session',paneId,cols,rows),
  onSessionEvent:callback=>{const listener=(_event:Electron.IpcRendererEvent,event:SessionEvent)=>callback(event);ipcRenderer.on('bridge:session-event',listener);return()=>ipcRenderer.removeListener('bridge:session-event',listener);},
  listModels:profile=>ipcRenderer.invoke('bridge:list-models',profile),
  chat:(paneId,profile,messages)=>ipcRenderer.invoke('bridge:chat',paneId,profile,messages),
  cancelChat:paneId=>ipcRenderer.invoke('bridge:cancel-chat',paneId),
  vaultInfo:()=>ipcRenderer.invoke('bridge:vault-info'),
  openVault:()=>ipcRenderer.invoke('bridge:open-vault'),
  showVaultFolder:()=>ipcRenderer.invoke('bridge:show-vault-folder'),
};
contextBridge.exposeInMainWorld('bridge',bridge);
