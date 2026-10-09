import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent, type IpcMainEvent } from 'electron';
import { join, resolve } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node-pty';
import type { PaneConfig, SessionEvent } from '../shared/types';
import { validateId, validatePane, validateWorkspace } from '../shared/domain';
import { assertNormalToken, StateStore } from './runtime-core';
import { TerminalManager } from './terminals';
import { ElevatedManager, isAdministrator, runElevatedHelper } from './elevated';
import { ProviderClient } from './providers';

const DEFAULT_ROOT=app.getPath('home');
if(process.env.ALPHACODE_DATA_DIR)app.setPath('userData',resolve(process.env.ALPHACODE_DATA_DIR));
let window:BrowserWindow|null=null;
let elevatedApp=false;
const emit=(event:SessionEvent)=>{if(window&&!window.isDestroyed())window.webContents.send('bridge:session-event',event);};
const terminals=new TerminalManager(spawn,emit);
const dev=process.argv.includes('--dev');
const admins=new ElevatedManager(process.execPath,app.isPackaged?null:app.getAppPath(),emit);
const providers=new ProviderClient();
const stateStore=new StateStore(join(app.getPath('userData'),'state.json'));

function authorized(event:IpcMainInvokeEvent|IpcMainEvent):void{
  if(!window||event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame)throw new Error('Untrusted IPC caller.');
}
function handle(channel:string,fn:(...args:any[])=>unknown):void{ipcMain.handle(channel,(event,...args)=>{authorized(event);return fn(...args);});}
function listen(channel:string,fn:(...args:any[])=>void):void{ipcMain.on(channel,(event,...args)=>{try{authorized(event);fn(...args);}catch(error){if(typeof args[0]==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(args[0]))emit({paneId:args[0],kind:'status',status:'error',message:(error as Error).message});}});}

function registerIpc():void{
  handle('bridge:load-state',()=>stateStore.load());
  handle('bridge:save-state',state=>stateStore.save(state));
  handle('bridge:app-info',()=>({version:app.getVersion(),platform:process.platform,statePath:stateStore.path,appElevated:elevatedApp,root:DEFAULT_ROOT}));
  handle('bridge:choose-directory',async()=>{const result=await dialog.showOpenDialog(window!,{title:'Choose working directory',defaultPath:DEFAULT_ROOT,properties:['openDirectory','createDirectory']});return result.canceled?null:result.filePaths[0]||null;});
  handle('bridge:export-workspace',async value=>{const workspace=validateWorkspace(value);const result=await dialog.showSaveDialog(window!,{title:'Export workspace',defaultPath:`${workspace.name.replace(/[^a-zA-Z0-9 _-]/g,'_')}.json`,filters:[{name:'Workspace JSON',extensions:['json']}]});if(result.canceled||!result.filePath)return false;await writeFile(result.filePath,JSON.stringify({format:'alphacode-workspace',version:1,workspace},null,2),'utf8');return true;});
  handle('bridge:import-workspace',async()=>{const result=await dialog.showOpenDialog(window!,{title:'Import workspace configuration',properties:['openFile'],filters:[{name:'Workspace JSON',extensions:['json']}]});if(result.canceled||!result.filePaths[0])return null;const input=await readFile(result.filePaths[0],'utf8');if(input.length>4*1024*1024)throw new Error('Workspace file exceeds the 4 MB limit.');const data=JSON.parse(input);if(data.format!=='alphacode-workspace'||data.version!==1)throw new Error('Unsupported workspace export format.');return validateWorkspace(data.workspace);});
  handle('bridge:start-session',async(value:PaneConfig,cols:number,rows:number)=>{const pane=validatePane(value);if(pane.type==='powershell-admin'){if(terminals.has(pane.id))throw new Error('Stop this normal session before changing it to Admin PowerShell.');try{await admins.start(pane,cols,rows);}catch(error){emit({paneId:pane.id,kind:'status',status:'error',message:(error as Error).message,elevated:false});throw error;}}else{if(admins.has(pane.id))throw new Error('Stop the Admin PowerShell session before changing its type.');await terminals.start(pane,cols,rows);}});
  handle('bridge:stop-session',async(paneId:string)=>{validateId(paneId);providers.cancel(paneId);if(admins.has(paneId))admins.stop(paneId);else terminals.stop(paneId);});
  listen('bridge:write-session',(id:string,data:string)=>{if(admins.has(id))admins.write(id,data);else terminals.write(id,data);});
  listen('bridge:resize-session',(id:string,cols:number,rows:number)=>{if(admins.has(id))admins.resize(id,cols,rows);else terminals.resize(id,cols,rows);});
  handle('bridge:list-models',profile=>providers.listModels(profile));
  handle('bridge:chat',(id,profile,messages)=>providers.chat(id,profile,messages));
  handle('bridge:cancel-chat',(id:string)=>providers.cancel(id));
}

const windowPath=join(app.getPath('userData'),'window.json');
/** Last window geometry, or {} on first launch or an unreadable file. Only finite integers are accepted. */
function lastWindow():{x?:number;y?:number;width?:number;height?:number;maximized?:boolean}{
  try{const w=JSON.parse(readFileSync(windowPath,'utf8'));const int=(v:unknown)=>Number.isInteger(v)?v as number:undefined;return {x:int(w.x),y:int(w.y),width:int(w.width),height:int(w.height),maximized:w.maximized===true};}catch{return {};}
}
async function createWindow():Promise<void>{
  const last=lastWindow(); // ponytail: no display-bounds check; Electron clamps partially off-screen windows, a removed monitor may need a drag back.
  window=new BrowserWindow({width:1560,height:1050,minWidth:960,minHeight:640,title:'AlphaCode by JABSystems',icon:join(app.getAppPath(),'public','icon.ico'),backgroundColor:'#131619',show:false,webPreferences:{preload:join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
  // Electron applies a rectangle a pixel or two off at fractional display scaling (electron/electron#10862), and a hidden window is
  // worse than a shown one. Restore while hidden, correct once shown, and on close let an unchanged window keep the numbers it was
  // restored from, so the error never compounds across launches.
  const rect=last.width&&last.height?{x:last.x??0,y:last.y??0,width:last.width,height:last.height}:null;
  let restored='';
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',event=>event.preventDefault());
  window.once('ready-to-show',()=>{if(!window)return;if(rect)window.setContentBounds(rect);window.show();if(rect)window.setContentBounds(rect);if(last.maximized)window.maximize();restored=JSON.stringify(window.getContentBounds());});
  window.on('close',()=>{try{const maximized=window!.isMaximized(),current=maximized?window!.getNormalBounds():window!.getContentBounds();
    // ponytail: a maximized window keeps the rectangle it was restored from; a resize made before maximizing in the same session is not kept.
    const unchanged=maximized||JSON.stringify(current)===restored;writeFileSync(windowPath,JSON.stringify({...(unchanged&&last.width?last:current),maximized}));}catch{/* Geometry is a convenience; never block closing on it. */}});
  window.on('closed',()=>{window=null;});
  if(dev)await window.loadURL('http://127.0.0.1:5173');else await window.loadFile(join(__dirname,'../../dist/index.html'));
}

const helperIndex=process.argv.indexOf('--alphacode-admin-helper');
if(helperIndex>=0){
  // The helper owns no BrowserWindow, renderer, or IPC handlers.
  app.whenReady().then(()=>runElevatedHelper(process.argv[helperIndex+1]||'',spawn)).catch(error=>{console.error('AlphaCode helper:',(error as Error).message);app.exit(1);});
}else{
  app.whenReady().then(async()=>{elevatedApp=isAdministrator();assertNormalToken(elevatedApp);for(const suffix of ['a','b','c','d'])await mkdir(join(DEFAULT_ROOT,'workspaces',`claude-${suffix}`),{recursive:true});registerIpc();await createWindow();}).catch(error=>{dialog.showErrorBox('AlphaCode cannot start',(error as Error).message);app.exit(1);});
  app.on('window-all-closed',()=>app.quit());
  let quitting=false;
  app.on('before-quit',event=>{if(quitting)return;quitting=true;event.preventDefault();admins.stopAll();providers.cancelAll();Promise.all([terminals.stopAll(),stateStore.flush()]).finally(()=>app.quit());});
}
