import { contextBridge, ipcRenderer } from 'electron';
import type { BridgeApi, OrchestrateEvent, SessionEvent } from '../shared/types';

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
  vaultGraph:()=>ipcRenderer.invoke('bridge:vault-graph'),
  vaultAsk:(paneId,profile,question)=>ipcRenderer.invoke('bridge:vault-ask',paneId,profile,question),
  vaultResolve:(name,workspaces)=>ipcRenderer.invoke('bridge:vault-resolve',name,workspaces),
  openObsidianVault:path=>ipcRenderer.invoke('bridge:open-obsidian-vault',path),
  orchestrateStart:roles=>ipcRenderer.invoke('bridge:orchestrate-start',roles),
  orchestrateStop:()=>ipcRenderer.invoke('bridge:orchestrate-stop'),
  approvePlan:()=>ipcRenderer.invoke('bridge:approve-plan'),
  onOrchestrateEvent:callback=>{const listener=(_event:Electron.IpcRendererEvent,event:OrchestrateEvent)=>callback(event);ipcRenderer.on('bridge:orchestrate-event',listener);return()=>ipcRenderer.removeListener('bridge:orchestrate-event',listener);},
};
contextBridge.exposeInMainWorld('bridge',bridge);
