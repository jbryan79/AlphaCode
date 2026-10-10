import { app, BrowserWindow, dialog, ipcMain, Notification, shell, type IpcMainInvokeEvent, type IpcMainEvent } from 'electron';
import { join, resolve } from 'node:path';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { spawn } from 'node-pty';
import type { OrchestrateEvent, OrchestrateRoles, PaneConfig, Plan, SessionEvent, Task } from '../shared/types';
import { string as str, validateId, validatePane, validateWorkspace } from '../shared/domain';
import { emptyOrchestrate, validateOrchestrate } from '../shared/orchestrate';
import { OrchestrateRun } from './orchestrate';
import { assertNormalToken, StateStore } from './runtime-core';
import { TerminalManager } from './terminals';
import { ElevatedManager, isAdministrator, runElevatedHelper } from './elevated';
import { ProviderClient } from './providers';
import { MemoryVault } from './vault';

const DEFAULT_ROOT=app.getPath('home');
if(process.env.ALPHACODE_DATA_DIR)app.setPath('userData',resolve(process.env.ALPHACODE_DATA_DIR));
let window:BrowserWindow|null=null;
let elevatedApp=false;
let run:OrchestrateRun|null=null;
const pendingLaunches=new Map<string,{resolve:()=>void;reject:(e:Error)=>void}>();
const emit=(event:SessionEvent)=>{
  if(event.kind==='data'&&event.data)run?.tap(event.paneId,event.data);
  if(event.kind==='status'){const p=pendingLaunches.get(event.paneId);
    // The renderer stops the pane's old session right before relaunching it, so an `exited` here is not a failed launch.
    if(p&&event.status==='running'){pendingLaunches.delete(event.paneId);p.resolve();}else if(p&&event.status==='error'){pendingLaunches.delete(event.paneId);p.reject(new Error(event.message||'Pane failed to start'));}
    if(event.status==='exited'||event.status==='error')run?.exited(event.paneId);}
  if(window&&!window.isDestroyed())window.webContents.send('bridge:session-event',event);
};
const terminals=new TerminalManager(spawn,emit);
const dev=process.argv.includes('--dev');
const admins=new ElevatedManager(process.execPath,app.isPackaged?null:app.getAppPath(),emit);
const providers=new ProviderClient();
const stateStore=new StateStore(join(app.getPath('userData'),'state.json'));
const vault=new MemoryVault(join(DEFAULT_ROOT,'AlphaCode Vault'),process.env.CLAUDE_CONFIG_DIR?resolve(process.env.CLAUDE_CONFIG_DIR):join(DEFAULT_ROOT,'.claude'),join(process.env.LOCALAPPDATA||join(DEFAULT_ROOT,'AppData','Local'),'Programs','Obsidian','Obsidian.exe'),join(app.getPath('appData'),'obsidian','obsidian.json'),providers);
const lastStates=new Map<string,string>();
const emitOrchestrate=(event:OrchestrateEvent)=>{
  // A worker that just entered Waiting needs the user; one toast per entry, like the finish toast.
  if(event.kind==='tasks')for(const t of event.tasks){if(t.state==='waiting'&&lastStates.get(t.id)!=='waiting'&&Notification.isSupported())new Notification({title:'Worker needs you',body:`${t.title}: ${t.message||'waiting for input'}`}).show();lastStates.set(t.id,t.state);}
  if(event.kind==='off')lastStates.clear();
  if(window&&!window.isDestroyed())window.webContents.send('bridge:orchestrate-event',event);
};
const git=(args:string[],cwd:string)=>new Promise<string>((resolve,reject)=>execFile('git',args,{cwd,windowsHide:true,timeout:30000,maxBuffer:4*1024*1024},(error,stdout,stderr)=>error?reject(new Error(stderr.trim()||error.message)):resolve(stdout)));
const activePanes=()=>{const s=stateStore.current;return s?.workspaces.find(w=>w.id===s.activeWorkspaceId)?.panes||[];};
const runNote=(report:string,summary:string,r:{tasks:Task[];plan:Plan|null},roles:OrchestrateRoles)=>{
  const date=new Date().toISOString().slice(0,10),project=roles.root.split(/[\\/]/).filter(Boolean).pop()||'project';
  const rows=r.tasks.map(t=>`| ${t.id} | ${t.title.replace(/\|/g,'/')} | ${t.state} | ${t.branch||''} | ${t.model} | ${t.retries} | ${t.message.replace(/\s+/g,' ').replace(/\|/g,'/')} |`).join('\n');
  return `---\nname: run-${date}-${summary.toLowerCase().replace(/[^a-z0-9]+/g,'-').slice(0,40)}\ndescription: ${JSON.stringify(summary.replace(/\s+/g,' '))}\nmetadata:\n  type: run\n  project: ${JSON.stringify(project)}\n---\n# Orchestrate run ${date}: ${summary}\n\nProject: \`${roles.root}\`\nTest command: \`${r.plan?.tests||''}\`\n\n## Tasks\n\n| id | title | outcome | branch | model | retries | note |\n|---|---|---|---|---|---|---|\n${rows}\n\n## Report\n\n${report}\n`;
};

const obsidianRunning=()=>new Promise<boolean>(resolve=>execFile('tasklist.exe',['/FI','IMAGENAME eq Obsidian.exe','/NH'],{windowsHide:true},(error,stdout)=>resolve(!error&&/obsidian\.exe/i.test(stdout))));
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
  handle('bridge:export-workspace',async value=>{const {orchestrate:_o,...workspace}=validateWorkspace(value);const result=await dialog.showSaveDialog(window!,{title:'Export workspace',defaultPath:`${workspace.name.replace(/[^a-zA-Z0-9 _-]/g,'_')}.json`,filters:[{name:'Workspace JSON',extensions:['json']}]});if(result.canceled||!result.filePath)return false;await writeFile(result.filePath,JSON.stringify({format:'alphacode-workspace',version:1,workspace},null,2),'utf8');return true;});
  handle('bridge:import-workspace',async()=>{const result=await dialog.showOpenDialog(window!,{title:'Import workspace configuration',properties:['openFile'],filters:[{name:'Workspace JSON',extensions:['json']}]});if(result.canceled||!result.filePaths[0])return null;const input=await readFile(result.filePaths[0],'utf8');if(input.length>4*1024*1024)throw new Error('Workspace file exceeds the 4 MB limit.');const data=JSON.parse(input);if(data.format!=='alphacode-workspace'||data.version!==1)throw new Error('Unsupported workspace export format.');return validateWorkspace(data.workspace);});
  handle('bridge:start-session',async(value:PaneConfig,cols:number,rows:number)=>{const pane=validatePane(value);if(pane.type==='powershell-admin'){if(terminals.has(pane.id))throw new Error('Stop this normal session before changing it to Admin PowerShell.');try{await admins.start(pane,cols,rows);}catch(error){emit({paneId:pane.id,kind:'status',status:'error',message:(error as Error).message,elevated:false});throw error;}}else{if(admins.has(pane.id))throw new Error('Stop the Admin PowerShell session before changing its type.');await terminals.start(pane,cols,rows,run?.overrides(pane.id)||{});}});
  handle('bridge:stop-session',async(paneId:string)=>{validateId(paneId);providers.cancel(paneId);if(admins.has(paneId))admins.stop(paneId);else terminals.stop(paneId);});
  listen('bridge:write-session',(id:string,data:string)=>{if(admins.has(id))admins.write(id,data);else{terminals.write(id,data);run?.typed(id);}});
  listen('bridge:resize-session',(id:string,cols:number,rows:number)=>{if(admins.has(id))admins.resize(id,cols,rows);else terminals.resize(id,cols,rows);});
  handle('bridge:list-models',profile=>providers.listModels(profile));
  handle('bridge:chat',(id,profile,messages)=>providers.chat(id,profile,messages));
  handle('bridge:cancel-chat',(id:string)=>providers.cancel(id));
  handle('bridge:vault-info',()=>vault.info());
  handle('bridge:open-vault',async()=>{
    if(!vault.obsidianInstalled())return shell.openExternal('https://obsidian.md/download');
    // Obsidian only opens vaults it already lists, so register first. A running Obsidian keeps its list in memory, so it must be told by hand once.
    if(await vault.register()&&await obsidianRunning()){await shell.openPath(vault.path);throw new Error(`Obsidian is already running and has not loaded this vault yet. In Obsidian choose "Open folder as vault" and pick ${vault.path}, or close Obsidian and click Open in Obsidian again.`);}
    await shell.openExternal(`obsidian://open?path=${encodeURIComponent(vault.path)}`);
  });
  handle('bridge:show-vault-folder',async()=>{const problem=await shell.openPath(vault.path);if(problem)throw new Error(problem);});
  handle('bridge:vault-graph',()=>vault.graph());
  handle('bridge:vault-ask',(id,profile,question)=>vault.ask(id,profile,question));
  handle('bridge:vault-resolve',(name,workspaces)=>vault.resolve(name,workspaces));
  handle('bridge:open-obsidian-vault',async(path:string)=>{await shell.openExternal(await vault.obsidianUrl(path));});
  handle('bridge:orchestrate-start',async(value:OrchestrateRoles)=>{
    const workerPaneIds=(value.workerPaneIds||[]).slice(0,5).map(validateId);
    const resume=validateOrchestrate({...emptyOrchestrate(),tasks:Array.isArray(value.resume)?value.resume.slice(0,5):[]},workerPaneIds).tasks.filter(t=>t.state==='interrupted');
    const roles:OrchestrateRoles={workspaceId:validateId(value.workspaceId),root:str(value.root,'project directory'),orchestratorPaneId:validateId(value.orchestratorPaneId),workerPaneIds,advisorPaneIds:(value.advisorPaneIds||[]).slice(0,5).map(validateId),maxWorkers:Math.min(5,Math.max(1,Number(value.maxWorkers)||5)),resume};
    const playbookPath=join(app.getPath('userData'),'orchestrate.md');if(!existsSync(playbookPath))await copyFile(join(app.getAppPath(),'public','orchestrate.md'),playbookPath);
    const prev=run;run=null;await prev?.stop().catch(()=>{});
    const r=new OrchestrateRun({runDir:join(app.getPath('userData'),'orchestrate',randomUUID()),execPath:process.execPath,cliPath:join(__dirname,'cli.js'),playbookPath,roles,panes:activePanes,git,
      launch:paneId=>new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{if(pendingLaunches.delete(paneId))reject(new Error('Pane did not start within 20 seconds.'));},20000);pendingLaunches.set(paneId,{resolve:()=>{clearTimeout(timer);resolve();},reject:e=>{clearTimeout(timer);reject(e);}});emitOrchestrate({kind:'launch',paneId});}),
      chat:async(paneId,prompt)=>{const pane=activePanes().find(p=>p.id===paneId),profile=stateStore.current?.profiles.find(p=>p.id===pane?.profileId);if(!pane||!profile)throw new Error('Advisor pane has no local model profile.');return providers.chat(paneId,profile,[{role:'user',content:prompt}]);},
      finish:async(report,summary,result)=>{try{if(Notification.isSupported())new Notification({title:'Orchestrator finished',body:summary}).show();await vault.writeNote('AlphaCode Runs',`${new Date().toISOString().slice(0,10)} ${summary}`,runNote(report,summary,result,roles));}catch(error){emitOrchestrate({kind:'error',message:`Run note was not written: ${(error as Error).message}`});}},
      emit:emitOrchestrate,log:m=>console.error(m)});
    r.writer=(id,data)=>terminals.write(id,data);r.alive=id=>terminals.has(id);
    run=r;try{await r.start();}catch(error){run=null;throw error;}
    return app.getPath('userData').endsWith('e2e-state')?{url:`http://127.0.0.1:${r.port}`,token:r.controlToken}:null;
  });
  handle('bridge:orchestrate-stop',async()=>{const r=run;run=null;if(r)await r.stop();});
  handle('bridge:approve-plan',()=>{run?.approve();});
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
  app.whenReady().then(async()=>{elevatedApp=isAdministrator();assertNormalToken(elevatedApp);app.setAppUserModelId('com.jabsystems.alphacode');for(const suffix of ['a','b','c','d'])await mkdir(join(DEFAULT_ROOT,'workspaces',`claude-${suffix}`),{recursive:true});registerIpc();await createWindow();void vault.scan();setInterval(()=>void vault.scan(),5*60*1000);}).catch(error=>{dialog.showErrorBox('AlphaCode cannot start',(error as Error).message);app.exit(1);});
  app.on('window-all-closed',()=>app.quit());
  let quitting=false;
  app.on('before-quit',event=>{if(quitting)return;quitting=true;event.preventDefault();admins.stopAll();providers.cancelAll();Promise.all([run?.stop().catch(()=>{}),terminals.stopAll(),stateStore.flush()]).finally(()=>app.quit());});
}
