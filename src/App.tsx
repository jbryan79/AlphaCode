import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import GridLayout, { type Layout } from 'react-grid-layout';
import { Plus, FolderOpen, ChevronDown, GripVertical, Settings2, Maximize2, Minimize2, Copy, X, Lock, Unlock, Shield, Terminal, Cpu, PanelLeft, ArrowUp, ArrowDown, Download, Upload, Check, AlertCircle, Pencil, Brain, Workflow, LifeBuoy, MessageSquare, PanelRightClose } from 'lucide-react';
import { addPane, applyPreset, balancedLayout, conductorLayout, orchestrateLayout, createPane, defaultState, dropTarget, duplicatePane, fillSinglePane, id, moveWorkspace, PANE_TYPES, PRESETS, removePane, reorderPane, swapPane } from '../shared/domain';
import { emptyOrchestrate, insideRoot, taskLabel } from '../shared/orchestrate';
import type { AppState, GridItem, LocalProfile, OrchestrateEvent, OrchestrateRoles, PaneConfig, PaneType, SessionEvent, SessionStatus, Task, VaultInfo, VaultTarget, Workspace } from '../shared/types';
import TerminalPane from './TerminalPane';
import LocalPane from './LocalPane';
import VaultPane from './VaultPane';
import PaneEditor from './PaneEditor';
import ProfileEditor from './ProfileEditor';
import PaneMenu from './PaneMenu';
import ConfirmDialog from './ConfirmDialog';
import RunHeader from './RunHeader';
import RunLanes from './RunLanes';
import { elapsed, fmtTokens, needsYou } from './runFormat';
import Logo from './Logo';
import StandalonePane from './StandalonePane';
import { CHAT_PANE_ID, SUPPORT_PANE_ID, supportPrompt } from './support';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';

const PaneIcon=({type,size}:{type:PaneType;size:number})=>type==='powershell-admin'?<Shield size={size}/>:type==='local-model'?<Cpu size={size}/>:type==='vault'?<Brain size={size}/>:<Terminal size={size}/>;
function NameDialog({title,initial,onSave,onClose}: {title:string;initial:string;onSave:(name:string)=>void;onClose:()=>void}) {
  const [name,setName]=useState(initial);
  return <div className="modal-backdrop"><form role="dialog" aria-modal="true" aria-label={title} className="modal small-modal" onSubmit={e=>{e.preventDefault();if(name.trim())onSave(name.trim());}}><header><h2>{title}</h2><button type="button" aria-label="Close name dialog" onClick={onClose}><X size={16}/></button></header><label>Workspace name<input autoFocus value={name} maxLength={100} onChange={e=>setName(e.target.value)}/></label><footer><button type="button" onClick={onClose}>Cancel</button><button className="primary" type="submit" disabled={!name.trim()}>Save workspace</button></footer></form></div>;
}
export default function App() {
  const [state,setState]=useState<AppState|null>(null),[statuses,setStatuses]=useState<Record<string,SessionEvent>>({}),[focused,setFocused]=useState(''),[maximized,setMaximized]=useState('');
  const [relaunch,setRelaunch]=useState<Record<string,number>>({}),[editor,setEditor]=useState<PaneConfig|null>(null),[profileEditor,setProfileEditor]=useState<LocalProfile|null>(null),[nameDialog,setNameDialog]=useState<'rename'|'save-as'|null>(null),[addOpen,setAddOpen]=useState(false),[sidebar,setSidebar]=useState(true),[moveMode,setMoveMode]=useState<'reflow'|'swap'>('reflow'),[notice,setNotice]=useState(''),[saveLabel,setSaveLabel]=useState('Saved locally'),[width,setWidth]=useState(1100),[tokens,setTokens]=useState<Record<string,number>>({}),[sideW,setSideW]=useState(()=>{try{const v=Number(localStorage.getItem('alphacode.sidebarWidth'));return v>=200&&v<=520?v:300;}catch{return 300;}}),[viewport,setViewport]=useState(850),[statePath,setStatePath]=useState('');
  const [vault,setVault]=useState<VaultInfo|null>(null);
  const [starting,setStarting]=useState(false);
  // The app always opens on Chat; Orchestration is one click away. Not saved, on purpose.
  const [view,setView]=useState<'chat'|'orchestrate'>('chat');
  const [home,setHome]=useState(''),[sourceRoot,setSourceRoot]=useState('');
  const [supportOpen,setSupportOpen]=useState(()=>{try{return localStorage.getItem('multimodel.supportOpen')!=='0';}catch{return true;}});
  // The first prompt of a Support session started by Ask for help; cleared once it runs so Restart starts clean.
  const [supportArgs,setSupportArgs]=useState<string[]>([]),[noticeHelp,setNoticeHelp]=useState(false);
  const recentErrors=useRef<string[]>([]);
  const [menu,setMenu]=useState<{pane:PaneConfig;x:number;y:number}|null>(null);
  const [confirm,setConfirm]=useState<{title:string;body:string;confirmLabel:string;resolve:(ok:boolean)=>void}|null>(null);
  /** In-app warning for destructive actions; resolves true only when the danger button is pressed. */
  const ask=(opts:{title:string;body:string;confirmLabel:string})=>new Promise<boolean>(resolve=>setConfirm({...opts,resolve}));
  const answer=(ok:boolean)=>{confirm?.resolve(ok);setConfirm(null);};
  const [orch,setOrch]=useState<{approved:boolean;tasks:Task[];finished:string}>({approved:false,tasks:[],finished:''});
  // Panes that belong to the current run (orchestrator, workers, advisors); everything else is a side pane. Kept here, not saved: a run never survives an app restart.
  const [runPanes,setRunPanes]=useState<string[]>([]),[tab,setTab]=useState<'run'|'side'>('run'),[runStart,setRunStart]=useState(0);
  useEffect(()=>{if(focused&&runPanes.length&&focused!==SUPPORT_PANE_ID&&focused!==CHAT_PANE_ID)setTab(runPanes.includes(focused)?'run':'side');},[focused,runPanes]);
  const refreshVault=()=>{if(!window.bridge)return;window.bridge.vaultInfo().then(setVault).catch(e=>setVault({path:'',projects:0,notes:0,obsidian:false,scannedAt:'',message:String(e)}));};
  useEffect(()=>{refreshVault();window.addEventListener('focus',refreshVault);return()=>window.removeEventListener('focus',refreshVault);},[]);
  const gridHost=useRef<HTMLDivElement>(null),dragOrigin=useRef<GridItem[]>([]),stateRef=useRef(state);stateRef.current=state;
  const workspace=state?.workspaces.find(w=>w.id===state.activeWorkspaceId);
  // Every reported error is kept (last 10) so Ask for help can hand them to Support.
  const report=(message:string)=>{const m=message.replace(/^Error:\s*/,'');recentErrors.current=[...recentErrors.current.slice(-9),`${new Date().toLocaleTimeString()} ${m}`];setNoticeHelp(false);setNotice(m);};
  useEffect(()=>{
    if(!window.bridge){report('Open Multimodel in its desktop app to access terminals.');return;}
    Promise.all([window.bridge.loadState(),window.bridge.appInfo()]).then(([saved,info])=>{setStatePath(info.statePath);setHome(info.root);setSourceRoot(info.sourceRoot);const loaded=saved||defaultState(info.root),next={...loaded,workspaces:loaded.workspaces.map(fillSinglePane)};setState(next);setOrch({approved:false,tasks:next.workspaces.find(w=>w.id===next.activeWorkspaceId)?.orchestrate?.tasks||[],finished:''});setFocused(next.workspaces.find(w=>w.id===next.activeWorkspaceId)?.panes[0]?.id||'');}).catch(e=>report(`Saved workspace could not load: ${e}`));
    const offSession=window.bridge.onSessionEvent(e=>{if(e.kind==='status')setStatuses(previous=>({...previous,[e.paneId]:e}));else if(e.kind==='tokens')setTokens(previous=>({...previous,[e.paneId]:e.tokens||0}));});
    const offOrch=window.bridge.onOrchestrateEvent(e=>{
      // Live tasks come first (at most 5 worker panes); history beyond that stays in the sidebar but is not saved.
      if(e.kind==='tasks'){setOrch(o=>({...o,approved:e.approved,tasks:e.tasks,finished:e.finished}));update(w=>({...w,orchestrate:{...(w.orchestrate||emptyOrchestrate()),approved:e.approved,tasks:e.tasks.slice(0,5)}}));}
      else if(e.kind==='launch'){void window.bridge.stopSession(e.paneId).then(()=>setRelaunch(r=>({...r,[e.paneId]:(r[e.paneId]||0)+1}))).catch(err=>report(String(err)));}
      else if(e.kind==='finished'){setOrch(o=>({...o,finished:e.summary}));setNotice(`Orchestrator finished: ${e.summary}`);}
      else if(e.kind==='error'){report(e.message);setNoticeHelp(true);}
      else if(e.kind==='off')update(w=>w.orchestrate?{...w,orchestrate:{...w.orchestrate,on:false}}:w);
    });
    return()=>{offSession();offOrch();};
  },[]);
  useEffect(()=>{
    // Save at once rather than after a delay: a change made just before the window closes must still reach disk.
    if(!state)return;setSaveLabel('Saving…');window.bridge.saveState(state).then(()=>setSaveLabel('Saved locally')).catch(e=>{setSaveLabel('Save failed');report(String(e));});
  },[state]);
  useEffect(()=>{
    if(!gridHost.current)return;const observer=new ResizeObserver(([entry])=>{setWidth(Math.max(360,entry.contentRect.width));setViewport(entry.contentRect.height);});observer.observe(gridHost.current);return()=>observer.disconnect();
  },[Boolean(state),sidebar]);
  const update=(fn:(w:Workspace)=>Workspace)=>setState(s=>s?{...s,workspaces:s.workspaces.map(w=>w.id===s.activeWorkspaceId?fn(w):w)}:s);
  const getStatus=(paneId:string):SessionStatus=>statuses[paneId]?.status||'idle';
  const isActive=(paneId:string)=>['running','busy','starting'].includes(getStatus(paneId));
  const stopAll=async()=>{if(!workspace)return;await Promise.all(workspace.panes.map(p=>p.type==='local-model'||p.type==='vault'?window.bridge.cancelChat(p.id):window.bridge.stopSession(p.id)));};
  const switchWorkspace=async(workspaceId:string)=>{
    if(workspaceId===state?.activeWorkspaceId)return;
    if(workspace?.panes.some(p=>isActive(p.id))&&!await ask({title:`Load ${state?.workspaces.find(w=>w.id===workspaceId)?.name||'workspace'}?`,body:'Loading a workspace ends the current terminal sessions.',confirmLabel:'End sessions and load'}))return;
    try{if(orchestrate.on)await orchestrateOff();await stopAll();setMaximized('');setMenu(null);setStatuses({});setState(s=>s?{...s,activeWorkspaceId:workspaceId}:s);setFocused(state?.workspaces.find(w=>w.id===workspaceId)?.panes[0]?.id||'');}catch(e){report(String(e));}
  };
  const closePane=async(p:PaneConfig)=>{
    if(pinned(p)){report('Turn Orchestrate off before closing this pane; closing it would break the run.');return;}
    if(isActive(p.id)&&!await ask({title:`Delete ${p.title}?`,body:`${p.title} is running. Deleting the pane ends its session.`,confirmLabel:'End session and delete'}))return;
    // Focus moves to the neighbour so it never points at a pane that no longer exists.
    const panes=workspace?.panes||[],at=panes.findIndex(x=>x.id===p.id),neighbour=panes[at+1]||panes[at-1];
    try{await window.bridge.stopSession(p.id);await window.bridge.cancelChat(p.id);if(orchestrate.on&&p.id===orchestrate.orchestratorPaneId)await orchestrateOff();update(w=>removePane(w,p.id));if(maximized===p.id)setMaximized('');if(focused===p.id)setFocused(neighbour?.id||'');}catch(e){report(String(e));}
  };
  const savePane=async(p:PaneConfig)=>{
    const old=workspace?.panes.find(x=>x.id===p.id);if(!old)return;if(p.cwd!==old.cwd&&reserved(p.id,p.cwd))return;
    const launchChanged=old.type!==p.type||old.cwd!==p.cwd||old.command!==p.command||JSON.stringify(old.args)!==JSON.stringify(p.args);
    const wasActive=isActive(p.id),restartable=p.type!=='powershell-admin'&&p.type!=='local-model'&&p.type!=='vault';
    if(launchChanged&&wasActive&&!await ask({title:`Apply changes to ${p.title}?`,body:restartable?'The current session ends and a new one starts in its place.':'The current session stops.',confirmLabel:restartable?'Apply and restart':'Apply and stop'}))return;
    try{if(orchestrate.on&&p.id===orchestrate.orchestratorPaneId&&p.type!=='claude')await orchestrateOff();
      if(launchChanged){await window.bridge.stopSession(p.id);await window.bridge.cancelChat(p.id);setStatuses(prev=>({...prev,[p.id]:{paneId:p.id,kind:'status',status:'idle'}}));}
      update(w=>({...w,panes:w.panes.map(x=>x.id===p.id?p:x)}));setEditor(null);
      if(launchChanged&&wasActive&&restartable)setRelaunch(r=>({...r,[p.id]:(r[p.id]||0)+1}));
    }catch(e){report(String(e));}
  };
  const add=(type:PaneType,cwd?:string)=>{
    if(!workspace||workspace.panes.length>=32){report('A workspace supports up to 32 panes.');return;}
    const base=createPane(type,cwd||workspace.root,type==='local-model'||type==='vault'?state?.profiles[0]?.id:'');
    const pane={...base,title:cwd?.split(/[\\/]/).filter(Boolean).pop()||base.title,autoStart:false};update(w=>addPane(w,pane));setFocused(pane.id);if(!cwd)setEditor(pane);setAddOpen(false);
  };
  const launchProject=(t:VaultTarget)=>{if(!workspace||workspace.panes.length>=32){report('A workspace supports up to 32 panes.');return;}if(reserved('',t.path))return;const pane={...createPane('claude',t.path),title:t.name,autoStart:true};update(w=>addPane(w,pane));setFocused(pane.id);};
  const addFromFolder=async()=>{setAddOpen(false);try{const cwd=await window.bridge.chooseDirectory();if(cwd&&!reserved('',cwd))add('claude',cwd);}catch(e){report(String(e));}};
  const changeFolder=async(p:PaneConfig)=>{try{const cwd=await window.bridge.chooseDirectory();if(cwd&&cwd!==p.cwd&&!reserved(p.id,cwd))await savePane({...p,cwd});}catch(e){report(String(e));}};
  const closeAll=async()=>{
    if(orchestrate.on){report("Turn Orchestrate off before closing all panes; closing them would break the run.");return;}
    if(!workspace?.panes.length||!await ask({title:`Close all ${workspace.panes.length} panes?`,body:'Every pane closes and its session ends.',confirmLabel:'Close all panes'}))return;
    try{await stopAll();setMaximized('');setStatuses({});update(w=>({...w,panes:[],layout:[]}));}catch(e){report(String(e));}
  };
  const preset=async(count:typeof PRESETS[number])=>{
    if(!workspace)return;
    const removed=workspace.panes.slice(count);
    if(removed.length&&!await ask({title:`Use ${count} pane${count===1?'':'s'}?`,body:`${removed.map(p=>p.title).join(', ')} close${removed.length===1?'s':''} and ${removed.length===1?'its session ends':'their sessions end'}.`,confirmLabel:`Close ${removed.length} pane${removed.length===1?'':'s'}`}))return;
    try{await Promise.all(removed.map(async p=>{await window.bridge.stopSession(p.id);await window.bridge.cancelChat(p.id);}));update(w=>applyPreset(w,count));setMaximized('');}catch(e){report(String(e));}
  };
  const orchestrate=workspace?.orchestrate||emptyOrchestrate();
  const orchestrateOn=async()=>{if(starting)return;setStarting(true);try{await orchestrateStartInner();}finally{setStarting(false);}};
  const orchestrateStartInner=async()=>{
    if(!workspace)return;let started=false;
    // The orchestrator is the focused Claude pane, else the first. Max workers is the worker pane count, so it caps every Claude session the run starts (reviews included).
    const chosen=workspace.panes.find(p=>p.id===focused&&p.type==='claude')||workspace.panes.find(p=>p.type==='claude'),workers=orchestrate.maxWorkers;
    const w=chosen?orchestrateLayout(workspace,chosen.id,workers):orchestrateLayout(workspace,'',workers+1);
    const orchestrator=chosen||w.panes.find(p=>p.type==='claude'); if(!orchestrator){report('Orchestrate needs a Claude pane.');return;}
    const removed=workspace.panes.filter(p=>!w.panes.some(x=>x.id===p.id)),plural=(n:number,s:string)=>`${n} ${s}${n===1?'':'s'}`;
    // Always ask: a stray click re-lays the workspace and restarts a session.
    if(!await ask({title:`Start an Orchestrate run in ${workspace.name}?`,body:`“${orchestrator.title}” becomes the orchestrator${isActive(orchestrator.id)?' and its session restarts':''}.\n${plural(workers,'worker pane')}: at most ${plural(workers,'Claude session')} besides the orchestrator, reviews included.${removed.length?`\n${removed.map(p=>p.title).join(', ')} close${removed.length===1?'s':''} with ${removed.length===1?'its session':'their sessions'}.`:''}\nWorker sessions end; the run starts each one when its task begins, and workers take no typing while the run is on.`,confirmLabel:'Start run'}))return;
    const workerPaneIds=w.panes.filter(p=>p.type==='claude'&&p.id!==orchestrator.id).map(p=>p.id);
    const resume=orchestrate.tasks.filter(t=>t.state==='interrupted'&&workerPaneIds.includes(t.paneId));
    const roles:OrchestrateRoles={workspaceId:w.id,root:orchestrator.cwd,orchestratorPaneId:orchestrator.id,workerPaneIds,advisorPaneIds:w.panes.filter(p=>p.type==='local-model').map(p=>p.id),maxWorkers:orchestrate.maxWorkers,resume};
    try{await Promise.all(removed.map(async p=>{await window.bridge.stopSession(p.id);await window.bridge.cancelChat(p.id);}));
      const testEnv=await window.bridge.orchestrateStart(roles);started=true;setRunPanes([orchestrator.id,...workerPaneIds,...roles.advisorPaneIds]);setRunStart(Date.now());setTab('run');if(testEnv)(window as any).__orchestrateEnv={ALPHACODE_CONTROL_URL:testEnv.url,ALPHACODE_CONTROL_TOKEN:testEnv.token};
      setState(s=>s?{...s,workspaces:s.workspaces.map(x=>x.id===w.id?{...x,panes:w.panes.map(p=>workerPaneIds.includes(p.id)?{...p,cwd:orchestrator.cwd}:p),layout:w.layout,orchestrate:{...(x.orchestrate||emptyOrchestrate()),on:true,orchestratorPaneId:orchestrator.id,approved:false,tasks:resume}}:x)}:s);setMaximized('');setOrch({approved:false,tasks:resume,finished:''});
      // A worker runs only what the run launches: idle sessions from before the run would look like work.
      await Promise.all(workerPaneIds.filter(isActive).map(id=>window.bridge.stopSession(id)));
      await window.bridge.stopSession(orchestrator.id);setRelaunch(r=>({...r,[orchestrator.id]:(r[orchestrator.id]||0)+1}));setFocused(orchestrator.id);
    }catch(e){if(started)await window.bridge.orchestrateStop().catch(()=>{});report(String(e));update(x=>x.orchestrate?{...x,orchestrate:{...x.orchestrate,on:false}}:x);}
  };
  const orchestrateOff=async()=>{setRunStart(0);try{await window.bridge.orchestrateStop();}catch(e){report(String(e));}update(w=>({...w,orchestrate:{...(w.orchestrate||emptyOrchestrate()),on:false,approved:false,tasks:[]}}));setOrch({approved:false,tasks:[],finished:''});};
  const taskFor=(paneId:string)=>orch.tasks.find(t=>t.paneId===paneId);
  // The run owns its project folder: nothing else may start a session there from inside AlphaCode (an outside terminal still can).
  const reserved=(paneId:string,cwd:string)=>{const root=workspace?.panes.find(x=>x.id===orchestrate.orchestratorPaneId)?.cwd;const own=runPanes.includes(paneId)||orch.tasks.some(t=>t.paneId===paneId);if(!orchestrate.on||!root||own||!insideRoot(root,cwd))return false;report(`${root} is being orchestrated. Start other work in a different folder, or turn Orchestrate off.`);return true;};
  // While Orchestrate is on, its Claude panes belong to the run: they cannot be closed, and workers take no typing except to answer a permission prompt (waiting) or after they finish.
  const grouped=orchestrate.on&&runPanes.length>0;
  const pinned=(p:PaneConfig)=>grouped&&runPanes.includes(p.id)&&p.type==='claude';
  const locked=(p:PaneConfig)=>{if(!pinned(p)||p.id===orchestrate.orchestratorPaneId)return false;const t=taskFor(p.id);return !t||t.state==='planned'||t.state==='working'||t.state==='attention';};
  const badge=(p:PaneConfig):{cls:string;text:string}|null=>{
    if(!orchestrate.on)return null;
    if(p.id===orchestrate.orchestratorPaneId)return orch.finished?{cls:'done',text:'Completed'}:null;
    // Once the run completes, every run pane whose part ended well says so; a failed or blocked task keeps its own state.
    const t=taskFor(p.id);if(orch.finished&&runPanes.includes(p.id)&&(!t||t.state==='done'))return {cls:'done',text:'Completed'};
    // A review asking for changes takes the attention colour: the orchestrator has work to send back.
    return t&&!t.hidden?{cls:t.verdict==='fail'?'attention':t.state,text:taskLabel(t)}:null;
  };
  // Role chip for a pane in the run: who it is and which model, so a pane reads from across the room. Panes outside the run get none.
  const role=(p:PaneConfig):{text:string;model:string}|null=>{
    if(!grouped||!runPanes.includes(p.id))return null;
    if(p.id===orchestrate.orchestratorPaneId)return {text:'Orchestrator · fable',model:'fable'};
    if(p.type==='local-model')return {text:'Advisor · local',model:'local'};
    // A planned task has no session yet: no model to claim.
    const t=taskFor(p.id);return t&&!t.hidden&&t.state!=='planned'?{text:`Worker · ${t.model}`,model:t.model}:{text:'Worker',model:'idle'};
  };
  // A worker runs only what the run launches, so without a live session it holds and says what comes next instead of offering Start.
  const worker=(p:PaneConfig)=>pinned(p)&&p.id!==orchestrate.orchestratorPaneId;
  const held=(p:PaneConfig)=>{
    if(!worker(p))return undefined;const t=taskFor(p.id);
    if(t&&t.state==='planned')return {title:`Next: ${t.title}`,detail:'The orchestrator starts this task.'};
    if(t&&!t.hidden&&(t.state==='done'||t.state==='failed'))return {title:taskLabel(t),detail:'Session ended. The orchestrator reviews, retries or merges this task.'};
    return {title:'Waiting for a task',detail:'The orchestrator starts a session here when it assigns work.'};
  };
  const counts=(s:Task['state'])=>orch.tasks.filter(t=>t.state===s).length;
  // Sidebar width is a per-machine convenience, so it lives in localStorage rather than the saved workspace.
  useEffect(()=>{try{localStorage.setItem('alphacode.sidebarWidth',String(sideW));}catch{}},[sideW]);
  const resizeSidebar=(e:ReactPointerEvent)=>{e.preventDefault();const x0=e.clientX,w0=sideW;const move=(ev:PointerEvent)=>setSideW(Math.min(520,Math.max(200,w0+ev.clientX-x0)));const up=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);};window.addEventListener('pointermove',move);window.addEventListener('pointerup',up);};
  const copyPane=(p:PaneConfig)=>{if((workspace?.panes.length||0)>=32){report('A workspace supports up to 32 panes.');return;}update(w=>duplicatePane(w,p.id));};
  const conduct=(w:Workspace)=>grouped&&moveMode==='reflow'?{...w,layout:conductorLayout(w.panes,orchestrate.orchestratorPaneId)}:w;
  const reorder=(from:string,to:string)=>{if(workspace?.locked)return;update(w=>moveMode==='swap'?swapPane(w,from,to):conduct(reorderPane(w,from,to)));};
  const saveNamed=async(name:string)=>{
    if(!state||!workspace)return;
    if(nameDialog==='rename'){update(w=>({...w,name}));setNameDialog(null);return;}
    if(state.workspaces.length>=50){report('Up to 50 saved workspaces are supported.');return;}
    const paneIds=new Map(workspace.panes.map(p=>[p.id,id()]));const cloned:Workspace={...workspace,id:id(),name,panes:workspace.panes.map(p=>({...p,id:paneIds.get(p.id)!,args:[...p.args]})),layout:workspace.layout.map(l=>({...l,i:paneIds.get(l.i)!}))};
    setState({...state,workspaces:[...state.workspaces,cloned]});setNameDialog(null);setNotice(`Saved “${name}”. Select it from the workspace menu to load.`);
  };
  const importLayout=async()=>{try{const imported=await window.bridge.importWorkspace();if(!imported)return;
    const paneIds=new Map(imported.panes.map(p=>[p.id,id()]));const safe={...imported,id:id(),panes:imported.panes.map(p=>({...p,id:paneIds.get(p.id)!,autoStart:false})),layout:imported.layout.map(l=>({...l,i:paneIds.get(l.i)!}))};
    setState(s=>s?{...s,workspaces:[...s.workspaces,safe]}:s);report(`Imported “${safe.name}”. Load it from the workspace menu; sessions wait for Start.`);
  }catch(e){report(String(e));}};
  const chooseRoot=async()=>{try{const root=await window.bridge.chooseDirectory();if(root)update(w=>moveWorkspace(w,root));}catch(e){report(String(e));}};
  useEffect(()=>{try{localStorage.setItem('multimodel.supportOpen',supportOpen?'1':'0');}catch{}},[supportOpen]);
  // Ask for help's prompt has reached Support once its session runs; a later Restart must not send it again.
  useEffect(()=>{if(supportArgs.length&&getStatus(SUPPORT_PANE_ID)==='running')setSupportArgs([]);},[statuses]);
  const bump=(paneId:string)=>setRelaunch(r=>({...r,[paneId]:(r[paneId]||0)+1}));
  const newConversation=async(paneId:string)=>{try{await window.bridge.stopSession(paneId);bump(paneId);}catch(e){report(String(e));}};
  /** Chat always restarts in its new folder; Support restarts only if it was running. */
  const moveStandalone=async(paneId:string,key:'chat'|'support')=>{try{const cwd=await window.bridge.chooseDirectory();if(!cwd||reserved(paneId,cwd))return;const wasLive=isActive(paneId);await window.bridge.stopSession(paneId);setState(s=>s?{...s,[key]:{cwd}}:s);if(wasLive||key==='chat')bump(paneId);}catch(e){report(String(e));}};
  /** Hand Support the run's state: typed into its live session, or as the first prompt of a new one. */
  const askForHelp=()=>{
    if(!workspace)return;
    const root=workspace.panes.find(p=>p.id===orchestrate.orchestratorPaneId)?.cwd||workspace.root;
    const text=supportPrompt({workspace:workspace.name,root,on:orchestrate.on,approved:orch.approved,finished:orch.finished,tasks:orch.tasks.length?orch.tasks:orchestrate.tasks,errors:recentErrors.current,statePath});
    setView('orchestrate');setSupportOpen(true);setFocused(SUPPORT_PANE_ID);setNotice('');
    if(isActive(SUPPORT_PANE_ID)){window.bridge.writeSession(SUPPORT_PANE_ID,text);setTimeout(()=>window.bridge.writeSession(SUPPORT_PANE_ID,'\r'),100);}
    else{setSupportArgs([text]);bump(SUPPORT_PANE_ID);}
  };
  if(!state||!workspace)return <main className="loading"><Logo size={44}/><h1>Multimodel</h1><p>by JABSystems</p><p>{notice||'Loading your local workspace…'}</p></main>;
  const chatPane:PaneConfig={id:CHAT_PANE_ID,type:'claude',title:'Chat',cwd:state.chat?.cwd||home,command:'',args:[],profileId:'',autoStart:true,color:''};
  const supportPane:PaneConfig={id:SUPPORT_PANE_ID,type:'claude',title:'Support',cwd:state.support?.cwd||sourceRoot||home,command:'',args:supportArgs,profileId:'',autoStart:false,color:''};
  const showSidebar=sidebar&&view==='orchestrate';
  const rowHeightFor=(layout:GridItem[])=>{const rows=Math.max(4,...layout.map(l=>l.y+l.h));return Math.max(28,Math.floor((viewport-8*(rows-1))/rows));};
  const allIds=workspace.panes.map(p=>p.id),groups=grouped?[{key:'run',ids:allIds.filter(i=>runPanes.includes(i)),visible:tab==='run'},{key:'side',ids:allIds.filter(i=>!runPanes.includes(i)),visible:tab==='side'}]:[{key:'run',ids:allIds,visible:true}];
  // Layout edits made in one group's grid must not disturb the other group's panes.
  const scoped=(w:Workspace,ids:string[],op:(s:Workspace)=>Workspace):Workspace=>{const mine=(id:string)=>ids.includes(id);const out=op({...w,panes:w.panes.filter(p=>mine(p.id)),layout:w.layout.filter(l=>mine(l.i))});const queue=[...out.panes];return {...out,panes:w.panes.map(p=>mine(p.id)?queue.shift()!:p),layout:[...w.layout.filter(l=>!mine(l.i)),...out.layout]};};
  const running=workspace.panes.filter(p=>isActive(p.id)).length;
  const runOrder=(id:string)=>runPanes.indexOf(id),paneGroups=grouped?[{key:'run',label:'Agents',panes:workspace.panes.filter(p=>runPanes.includes(p.id)).sort((a,b)=>runOrder(a.id)-runOrder(b.id))},{key:'side',label:'Side panes',panes:workspace.panes.filter(p=>!runPanes.includes(p.id))}].filter(g=>g.panes.length):[{key:'all',label:'Panes',panes:workspace.panes}];
  const paneTitle=(id:string)=>workspace.panes.find(p=>p.id===id)?.title||id;
  const goTo=(paneId:string)=>{setFocused(paneId);setTab('run');if(maximized)setMaximized(paneId);};
  return <div className={`app-shell ${showSidebar?'':'sidebar-hidden'} ${orchestrate.on?'orchestrating':''} view-${view}`}style={{['--sidebar-w' as string]:`${sideW}px`} as CSSProperties}>
    <header className="app-toolbar"><div className="brand"><Logo size={24}/><strong>Multimodel</strong></div>
      <div className="view-switch" role="tablist" aria-label="View">
        <button role="tab" aria-selected={view==='chat'} className={view==='chat'?'selected':''} onClick={()=>setView('chat')}><MessageSquare size={14}/>Chat</button>
        <button role="tab" aria-selected={view==='orchestrate'} className={view==='orchestrate'?'selected':''} onClick={()=>setView('orchestrate')}><Workflow size={14}/>Orchestration{orchestrate.on&&<span className={`view-live${counts('waiting')+counts('attention')>0?' needs-you':''}`} title={orch.finished?'Run completed':'Run in progress'}/>}</button>
      </div>
      {view==='orchestrate'&&!sidebar&&<><span className="toolbar-divider"/><span className="workspace-title">{workspace.name}</span></>}
      {view==='chat'?<div className="toolbar-actions">{orchestrate.on&&<button className="ghost run-pill" onClick={()=>setView('orchestrate')}><span className="orch-live"/>{orch.finished?'Run completed':`Run on · ${counts('working')} working${counts('waiting')+counts('attention')?` · ${counts('waiting')+counts('attention')} need you`:''}`}</button>}</div>:
      <div className="toolbar-actions"><button className="ghost" aria-label="Toggle workspace sidebar" onClick={()=>setSidebar(!sidebar)}><PanelLeft size={16}/></button><div className="presets" aria-label="Layout presets">{PRESETS.map(n=><button key={n} className={workspace.panes.length===n?'selected':''} onClick={()=>void preset(n)}>{n}<span> pane{n===1?'':'s'}</span></button>)}</div>
      <button className="ghost" aria-label={workspace.locked?'Unlock layout':'Lock layout'} title={workspace.locked?'Unlock layout':'Lock layout'} onClick={()=>update(w=>({...w,locked:!w.locked}))}>{workspace.locked?<Lock size={14}/>:<Unlock size={14}/>}<span>{workspace.locked?'Layout locked':'Layout editable'}</span></button>
      <button className={`ghost orch-toggle ${orchestrate.on?'selected on':''}`} aria-label={orchestrate.on?'Turn orchestrate off':'Turn orchestrate on'} aria-pressed={orchestrate.on} disabled={starting} title={orchestrate.on?'Orchestrate is ON. Click to turn it off':'One Claude pane plans and runs tasks in the others'} onClick={()=>void (orchestrate.on?orchestrateOff():orchestrateOn())}>{orchestrate.on?<span className="orch-live"/>:<Workflow size={14}/>}<span>Orchestrate</span><span className="orch-state">{starting?'…':orchestrate.on?'On':'Off'}</span></button>
      {!orchestrate.on&&<label className="max-workers" title="Worker panes in the run: at most this many Claude sessions besides the orchestrator, reviews included"><input aria-label="Max workers" type="number" min={1} max={5} value={orchestrate.maxWorkers} onChange={e=>update(w=>({...w,orchestrate:{...(w.orchestrate||emptyOrchestrate()),maxWorkers:Math.min(5,Math.max(1,Number(e.target.value)||1))}}))}/></label>}
      <div className="add-menu"><button className="primary" aria-expanded={addOpen} onClick={()=>setAddOpen(!addOpen)}><Plus size={15}/>Add pane<ChevronDown size={13}/></button>{addOpen&&<div className="dropdown">{PANE_TYPES.map(t=><button key={t.type} onClick={()=>add(t.type)}><PaneIcon type={t.type} size={14}/><span>{t.label}</span></button>)}<button className="dropdown-folder" onClick={()=>void addFromFolder()}><FolderOpen size={14}/><span>Browse for a folder…</span></button></div>}</div></div>}
    </header>
    {showSidebar&&<aside className="sidebar"><section className="workspace-section"><div className="section-heading"><span>Workspace</span><button aria-label="Rename workspace" onClick={()=>setNameDialog('rename')}><Pencil size={12}/></button></div><select aria-label="Load workspace" value={workspace.id} onChange={e=>void switchWorkspace(e.target.value)}>{state.workspaces.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select><button className="project-path" onClick={()=>void chooseRoot()} title={workspace.root}><FolderOpen size={14}/><span>{workspace.root}</span></button><div className="workspace-buttons"><button onClick={()=>setNameDialog('save-as')}><Copy size={12}/>Save as</button><button aria-label="Export workspace" title="Export workspace JSON" onClick={()=>window.bridge.exportWorkspace(workspace).catch(e=>report(String(e)))}><Download size={14}/></button><button aria-label="Import workspace" title="Import workspace JSON" onClick={()=>void importLayout()}><Upload size={14}/></button></div></section>
      <section className="pane-list-section">{paneGroups.map(g=><div key={g.key} className="pane-group"><div className="section-heading"><span>{g.label}</span></div><div className="pane-list">{g.panes.map(p=>{const n=workspace.panes.indexOf(p);return <div key={p.id} data-pane-id={p.id} data-color={p.color||''} className={`pane-list-item ${focused===p.id?'active':''}`} aria-current={focused===p.id?'true':undefined} onContextMenu={e=>{e.preventDefault();setFocused(p.id);
        // The keyboard menu key fires this too, with no pointer position: open the menu at the row.
        const r=e.currentTarget.getBoundingClientRect(),keyboard=e.clientX===0&&e.clientY===0;setMenu({pane:p,x:keyboard?r.left+24:e.clientX,y:keyboard?r.bottom:e.clientY});}} draggable={!workspace.locked} onDragStart={e=>e.dataTransfer.setData('text/plain',p.id)} onDragOver={e=>{if(!workspace.locked)e.preventDefault();}} onDrop={e=>{e.preventDefault();reorder(e.dataTransfer.getData('text/plain'),p.id);}}><button className="pane-list-name" onClick={()=>{setFocused(p.id);if(maximized)setMaximized(p.id);document.getElementById(`pane-${p.id}`)?.scrollIntoView({block:'nearest'});}}><span className={`status-dot ${getStatus(p.id)}`}/><PaneIcon type={p.type} size={13}/><span>{p.title}</span></button><div className="list-reorder"><button disabled={workspace.locked||n===0} aria-label={`Move ${p.title} up`} onClick={()=>reorder(p.id,workspace.panes[n-1].id)}><ArrowUp size={10}/></button><button disabled={workspace.locked||n===workspace.panes.length-1} aria-label={`Move ${p.title} down`} onClick={()=>reorder(p.id,workspace.panes[n+1].id)}><ArrowDown size={10}/></button></div></div>;})}</div></div>)}</section>
      
      {orchestrate.on&&<section className="tasks-section"><div className="section-heading"><span>Tasks</span>{orch.tasks.length>0&&<span className="tasks-count">{counts('done')}/{orch.tasks.length} done</span>}</div>
        {/* Stacked, wrapping rows: the sidebar can be 200px wide and messages carry commit ranges and file lists with no spaces. */}
        {orch.tasks.length===0?<div className="tasks-empty">Waiting for a plan.</div>:orch.tasks.map(t=><button key={t.id} className={`task-row${needsYou(t)?' needs-you':''}${focused===t.paneId?' active':''}`} data-task-id={t.id} title={t.message||undefined} onClick={()=>goTo(t.paneId)}>
          <span className={`status-dot task-${t.verdict==='fail'?'attention':t.state}`}/>
          <span className="task-body"><strong>{t.title}</strong>
            <span className="task-meta"><span className="task-state">{taskLabel(t)}</span> · {paneTitle(t.paneId)} · {t.model}{elapsed(t)?` · ${elapsed(t)}`:''}{t.retries?` · retried ${t.retries}×`:''}</span>
            {t.message&&<span className="task-message">{t.message}</span>}
          </span></button>)}
      </section>}
      <section className="profiles-section"><div className="section-heading"><span>Local model profiles</span><button aria-label="Add local model profile" onClick={()=>setProfileEditor({id:id(),name:'New profile',provider:'ollama',endpoint:'http://localhost:11434',model:'',systemPrompt:'You are a helpful assistant.',contextSize:32768,temperature:0.7})}><Plus size={13}/></button></div>{state.profiles.map(p=><button className="profile-list-item" key={p.id} onClick={()=>setProfileEditor(p)}><Cpu size={14}/><span><strong>{p.name}</strong><small>{p.model||'Select a model'}</small></span><Settings2 size={12}/></button>)}</section>
      <section className="vault-section"><div className="section-heading"><span>Claude memory</span></div>
        <div className="vault-meta"><span>{vault?`${vault.projects} projects · ${vault.notes} notes`:'Scanning…'}</span>{vault?.path&&<span title={vault.path}>{vault.path}</span>}</div>
        <div className="vault-actions"><button className="primary" onClick={()=>window.bridge.openVault().catch(e=>report(String(e)))}><Brain size={13}/>{vault?.obsidian?'Open in Obsidian':'Get Obsidian'}</button><button className="ghost" onClick={()=>window.bridge.showVaultFolder().catch(e=>report(String(e)))}>Show folder</button></div>
        {vault?.message&&<div className="vault-message">{vault.message}</div>}
      </section>
    </aside>}
    {showSidebar&&<div className="sidebar-resizer" role="separator" aria-orientation="vertical" aria-label="Resize sidebar" title="Drag to resize the sidebar" onPointerDown={resizeSidebar}/>}
    <main className="chat-main" hidden={view!=='chat'}>
      <StandalonePane pane={chatPane} label="Chat" detail="A Claude Code session of its own, outside every workspace and run" status={getStatus(CHAT_PANE_ID)} message={statuses[CHAT_PANE_ID]?.message} focused={view==='chat'} relaunch={relaunch[CHAT_PANE_ID]||0} onChangeFolder={()=>void moveStandalone(CHAT_PANE_ID,'chat')} onNew={()=>void newConversation(CHAT_PANE_ID)} onError={report}/>
    </main>
    <div className="orch-view" hidden={view!=='orchestrate'}>
    <main className="workspace-main"><div className="workspace-subbar"><span>{maximized?'Focused pane':workspace.locked?<>Layout locked<Lock size={11}/></>:workspace.panes.length>1&&<>Drag a pane header to arrange<label>Drag<select aria-label="Drag behavior" value={moveMode} onChange={e=>setMoveMode(e.target.value as 'reflow'|'swap')}><option value="reflow">Reflow</option><option value="swap">Swap</option></select></label><button className="ghost" onClick={()=>update(w=>({...w,layout:grouped?conductorLayout(w.panes,orchestrate.orchestratorPaneId):balancedLayout(w.panes)}))}>Balance panes</button></>}</span><span>{maximized?<button className="ghost" onClick={()=>setMaximized('')}><Minimize2 size={12}/>Restore grid</button>:<><span className="status-dot running"/>{running} active<span className="subbar-separator">/</span>{workspace.panes.length} pane{workspace.panes.length===1?'':'s'}</>}{workspace.panes.length>0&&<button className="ghost danger" title="Close every pane and end its session" onClick={()=>void closeAll()}><X size={12}/>Close all</button>}<button className={`ghost support-toggle${supportOpen?' selected':''}`} aria-pressed={supportOpen} title={supportOpen?'Hide the Support agent':'Show the Support agent: Claude in the Multimodel source, for help with runs'} onClick={()=>setSupportOpen(!supportOpen)}><LifeBuoy size={12}/>Support</button></span></div>
      {grouped&&<><RunHeader name={workspace.name} tasks={orch.tasks} approved={orch.approved} finished={orch.finished} startedAt={runStart} paneTitle={paneTitle} onApprove={()=>window.bridge.approvePlan().catch(e=>report(String(e)))} onAnswer={goTo} onStop={()=>void orchestrateOff()} onHelp={askForHelp}/><RunLanes lanes={runPanes.filter(id=>workspace.panes.some(p=>p.id===id&&p.type==='claude')).map(id=>({paneId:id,label:paneTitle(id),role:id===orchestrate.orchestratorPaneId?'orchestrator':'worker'}))} tasks={orch.tasks} startedAt={runStart} approved={orch.approved} finished={orch.finished} focused={focused} onFocus={goTo}/><div className="orch-tabs" role="tablist" aria-label="Panes shown"><button role="tab" aria-selected={tab==='run'} className={tab==='run'?'selected':''} onClick={()=>setTab('run')}>Run panes <span>{groups[0].ids.length}</span></button><button role="tab" aria-selected={tab==='side'} className={tab==='side'?'selected':''} onClick={()=>setTab('side')}>Side panes <span>{groups[1].ids.length}</span></button></div></>}
      <div className={`grid-host ${maximized?'has-maximized':''}`} ref={gridHost}>
        {workspace.panes.length===0&&<div className="empty-workspace"><Terminal size={32}/><h2>Your workspace is ready</h2><p>Add a terminal or local model pane to get started.</p><button className="primary" onClick={()=>add('powershell')}><Plus size={14}/>Add PowerShell</button></div>}
        {groups.map(g=>{const ids=g.ids,list=workspace.panes.filter(p=>ids.includes(p.id)),groupLayout=workspace.layout.filter(l=>ids.includes(l.i));return <div key={g.key} className="grid-group" hidden={!g.visible}>
        <GridLayout width={width} cols={12} rowHeight={rowHeightFor(groupLayout)} margin={[8,8]} containerPadding={[0,0]} layout={groupLayout as Layout[]} draggableHandle=".pane-drag-handle" draggableCancel=".pane-actions,button,input,select" isDraggable={!workspace.locked&&!maximized} isResizable={false} allowOverlap={moveMode==='swap'} compactType={moveMode==='swap'?null:'vertical'}
          onDragStart={()=>{dragOrigin.current=groupLayout.map(l=>({...l}));}}
          onDragStop={(_layout,_oldItem,newItem)=>{
            // Both modes restore the pre-drag layout first: the grid library's live compaction leaves panes straddling columns and pushed below the viewport.
            const target=dropTarget(dragOrigin.current,newItem),restored=(w:Workspace)=>({...w,layout:dragOrigin.current});
            update(w=>scoped(w,ids,g=>!target?restored(g):moveMode==='swap'?swapPane(restored(g),newItem.i,target.i):reorderPane(restored(g),newItem.i,target.i)));
          }}
          onResizeStop={layout=>update(w=>scoped(w,ids,g=>({...g,layout:layout.map(l=>({i:l.i,x:l.x,y:l.y,w:l.w,h:l.h,minW:3,minH:3}))})))}>
          {list.map(p=><div key={p.id} id={`pane-${p.id}`} data-pane-id={p.id} data-pane-title={p.title} data-color={p.color||''} className={`pane ${p.type==='powershell-admin'?'admin-pane':''} ${focused===p.id?'focused':''} ${maximized===p.id?'maximized':''}`} onPointerDown={()=>{if(focused!==p.id)setFocused(p.id);}}>
            {(()=>{const b=badge(p),r=role(p),t=taskFor(p.id),next=!!(r&&t&&!t.hidden&&t.state==='planned'),title=r&&p.id===orchestrate.orchestratorPaneId?'Orchestrator':next?`Next: ${t!.title}`:r&&t&&!t.hidden?t.title:'';return <header className={`pane-header${r?' run':''}${b?` run-${b.cls}`:''}`}><div className="pane-drag-handle" title={workspace.locked?'Layout locked':'Drag to arrange'}><GripVertical size={12}/>{r?<span className="pane-role" data-model={r.model}>{r.text}</span>:<PaneIcon type={p.type} size={14}/>}<strong className={next?'next-title':undefined} title={title||p.title}>{title||p.title}</strong>{title&&<span className="pane-name">{p.title}</span>}</div>{b&&<span className={`pane-badge ${b.cls}`}>{b.text}{t&&elapsed(t)&&b.text!=='Completed'?<small> {elapsed(t)}</small>:null}</span>}{tokens[p.id]?<span className="pane-tokens" title="Tokens this session: input, cache and output">{fmtTokens(tokens[p.id])}</span>:null}<span className={`pane-status ${getStatus(p.id)}`} title={statuses[p.id]?.message||getStatus(p.id)}><span className={`status-dot ${getStatus(p.id)}`}/>{p.type==='powershell-admin'&&getStatus(p.id)==='running'?'Admin':worker(p)&&!isActive(p.id)?'No session':getStatus(p.id)==='idle'?'Ready':getStatus(p.id)}</span><div className="pane-actions"><button aria-label={`Configure ${p.title}`} title={pinned(p)?'Turn Orchestrate off to change this pane':'Configure and rename'} disabled={pinned(p)} onClick={()=>setEditor(p)}><Settings2 size={13}/></button><button aria-label={`Duplicate ${p.title}`} title="Duplicate configuration" onClick={()=>copyPane(p)}><Copy size={12}/></button><button aria-label={maximized===p.id?`Restore ${p.title}`:`Maximize ${p.title}`} title="Focus pane" onClick={()=>{setMaximized(maximized===p.id?'':p.id);setFocused(p.id);}}>{maximized===p.id?<Minimize2 size={13}/>:<Maximize2 size={13}/>}</button><button aria-label={`Close ${p.title}`} title={pinned(p)?'Turn Orchestrate off to close this pane':'Close pane'} disabled={pinned(p)} onClick={()=>void closePane(p)}><X size={13}/></button></div></header>;})()}
            <button className="pane-directory" title={`${p.cwd}\nClick to change folder`} aria-label={`Change folder for ${p.title}`} onClick={()=>void changeFolder(p)}><FolderOpen size={11}/><span>{p.cwd}</span>{p.type==='powershell-admin'&&<span className="admin-label">UAC session</span>}</button>
            {p.type==='vault'?<VaultPane pane={p} profiles={state.profiles} workspaces={state.workspaces.map(w=>({id:w.id,name:w.name}))} onProfile={profileId=>update(w=>({...w,panes:w.panes.map(x=>x.id===p.id?{...x,profileId}:x)}))} onEditProfile={profileId=>setProfileEditor(state.profiles.find(x=>x.id===profileId)||null)} onStatus={(status,message)=>setStatuses(prev=>({...prev,[p.id]:{paneId:p.id,kind:'status',status,message}}))} onLaunch={launchProject} onLoadWorkspace={id=>void switchWorkspace(id)}/>:p.type==='local-model'?<LocalPane pane={p} profiles={state.profiles} onProfile={profileId=>update(w=>({...w,panes:w.panes.map(x=>x.id===p.id?{...x,profileId}:x)}))} onEditProfile={profileId=>setProfileEditor(state.profiles.find(x=>x.id===profileId)||null)} onStatus={(status,message)=>setStatuses(prev=>({...prev,[p.id]:{paneId:p.id,kind:'status',status,message}}))}/>:<TerminalPane pane={p} locked={locked(p)} held={held(p)} status={getStatus(p.id)} focused={focused===p.id} message={statuses[p.id]?.message} relaunch={relaunch[p.id]||0} onError={report}/>}
          </div>)}
        </GridLayout>
        </div>;})}
      </div>
    </main>
    {/* Kept mounted while hidden so the Support conversation survives closing the dock. */}
    <aside className="support-dock" hidden={!supportOpen} aria-label="Support agent" onPointerDown={()=>{if(focused!==SUPPORT_PANE_ID)setFocused(SUPPORT_PANE_ID);}}>
      <StandalonePane className="support" pane={supportPane} label="Support" detail={sourceRoot&&supportPane.cwd===sourceRoot?'Claude in the Multimodel source, whichever project you orchestrate':'Claude for help with Multimodel and its runs'} status={getStatus(SUPPORT_PANE_ID)} message={statuses[SUPPORT_PANE_ID]?.message} focused={focused===SUPPORT_PANE_ID} relaunch={relaunch[SUPPORT_PANE_ID]||0} onChangeFolder={()=>void moveStandalone(SUPPORT_PANE_ID,'support')} onNew={()=>void newConversation(SUPPORT_PANE_ID)} onError={report}
        actions={<><button className="primary" title="Send the run's tasks, states and recent errors to Support and ask what went wrong" onClick={askForHelp}><LifeBuoy size={12}/>Ask for help</button><button className="ghost" aria-label="Hide Support" title="Hide Support" onClick={()=>setSupportOpen(false)}><PanelRightClose size={14}/></button></>}/>
    </aside>
    </div>
    <footer className="app-statusbar"><span><span className="status-dot running"/>{orchestrate.on?<><strong className="orch-label">{orch.finished?'Run completed':'Run on'}</strong><span className="run-counts">{counts('working')} working · {counts('waiting')+counts('attention')>0?<strong className="attention-count">{counts('waiting')+counts('attention')} need you</strong>:'0 need you'} · {counts('done')} done</span></>:view==='chat'?'Chat':'Local terminal cockpit'}</span><span><span className="save-state" title={statePath?`Saved to ${statePath}`:'Saved on this computer'}><Check size={11}/>{saveLabel}</span><span className="statusbar-separator">|</span><span className="plan-badge" title="Your Multimodel plan"><Logo size={14}/><strong>Platinum</strong><span>Unlimited credits</span></span></span></footer>
    {notice&&<div className="notice" role="status"><AlertCircle size={16}/><span>{notice}</span>{noticeHelp&&<button className="primary" onClick={askForHelp}><LifeBuoy size={12}/>Ask Support</button>}<button aria-label="Dismiss notification" onClick={()=>setNotice('')}><X size={14}/></button></div>}
    {menu&&<PaneMenu key={menu.pane.id} x={menu.x} y={menu.y} title={menu.pane.title} disabledReason={pinned(menu.pane)?'Turn Orchestrate off to change this pane':''} onConfigure={()=>setEditor(menu.pane)} onDelete={()=>void closePane(menu.pane)} onClose={()=>setMenu(null)}/>}
    {confirm&&<ConfirmDialog title={confirm.title} body={confirm.body} confirmLabel={confirm.confirmLabel} onConfirm={()=>answer(true)} onCancel={()=>answer(false)}/>}
    {editor&&<PaneEditor key={editor.id} pane={editor} profiles={state.profiles} onSave={p=>void savePane(p)} onClose={()=>setEditor(null)} onError={report}/>}
    {profileEditor&&<ProfileEditor key={profileEditor.id} profile={profileEditor} onSave={p=>{setState(s=>s?{...s,profiles:s.profiles.some(x=>x.id===p.id)?s.profiles.map(x=>x.id===p.id?p:x):[...s.profiles,p]}:s);setProfileEditor(null);}} onClose={()=>setProfileEditor(null)}/>}
    {nameDialog&&<NameDialog title={nameDialog==='rename'?'Rename workspace':'Save workspace as'} initial={nameDialog==='rename'?workspace.name:`${workspace.name} copy`} onSave={name=>void saveNamed(name)} onClose={()=>setNameDialog(null)}/>}
  </div>;
}
