import { useEffect, useRef, useState } from 'react';
import GridLayout, { type Layout } from 'react-grid-layout';
import { Plus, FolderOpen, ChevronDown, GripVertical, Settings2, Maximize2, Minimize2, Copy, X, Lock, Unlock, Shield, Terminal, Cpu, PanelLeft, ArrowUp, ArrowDown, Download, Upload, Check, AlertCircle, Pencil } from 'lucide-react';
import { addPane, applyPreset, balancedLayout, createPane, defaultState, dropTarget, duplicatePane, fillSinglePane, id, moveWorkspace, PANE_TYPES, PRESETS, removePane, reorderPane, swapPane } from '../shared/domain';
import type { AppState, GridItem, LocalProfile, PaneConfig, PaneType, SessionEvent, SessionStatus, Workspace } from '../shared/types';
import TerminalPane from './TerminalPane';
import LocalPane from './LocalPane';
import PaneEditor from './PaneEditor';
import ProfileEditor from './ProfileEditor';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';

const PaneIcon=({type,size}:{type:PaneType;size:number})=>type==='powershell-admin'?<Shield size={size}/>:type==='local-model'?<Cpu size={size}/>:<Terminal size={size}/>;
function NameDialog({title,initial,onSave,onClose}: {title:string;initial:string;onSave:(name:string)=>void;onClose:()=>void}) {
  const [name,setName]=useState(initial);
  return <div className="modal-backdrop"><form role="dialog" aria-modal="true" aria-label={title} className="modal small-modal" onSubmit={e=>{e.preventDefault();if(name.trim())onSave(name.trim());}}><header><h2>{title}</h2><button type="button" aria-label="Close name dialog" onClick={onClose}><X size={16}/></button></header><label>Workspace name<input autoFocus value={name} maxLength={100} onChange={e=>setName(e.target.value)}/></label><footer><button type="button" onClick={onClose}>Cancel</button><button className="primary" type="submit" disabled={!name.trim()}>Save workspace</button></footer></form></div>;
}
export default function App() {
  const [state,setState]=useState<AppState|null>(null),[statuses,setStatuses]=useState<Record<string,SessionEvent>>({}),[focused,setFocused]=useState(''),[maximized,setMaximized]=useState('');
  const [relaunch,setRelaunch]=useState<Record<string,number>>({}),[editor,setEditor]=useState<PaneConfig|null>(null),[profileEditor,setProfileEditor]=useState<LocalProfile|null>(null),[nameDialog,setNameDialog]=useState<'rename'|'save-as'|null>(null),[addOpen,setAddOpen]=useState(false),[sidebar,setSidebar]=useState(true),[moveMode,setMoveMode]=useState<'reflow'|'swap'>('reflow'),[notice,setNotice]=useState(''),[saveLabel,setSaveLabel]=useState('Saved locally'),[width,setWidth]=useState(1100),[viewport,setViewport]=useState(850),[statePath,setStatePath]=useState('');
  const gridHost=useRef<HTMLDivElement>(null),dragOrigin=useRef<GridItem[]>([]),stateRef=useRef(state);stateRef.current=state;
  const workspace=state?.workspaces.find(w=>w.id===state.activeWorkspaceId);
  const report=(message:string)=>setNotice(message.replace(/^Error:\s*/,''));
  useEffect(()=>{
    if(!window.bridge){report('Open AlphaCode in its desktop app to access terminals.');return;}
    Promise.all([window.bridge.loadState(),window.bridge.appInfo()]).then(([saved,info])=>{setStatePath(info.statePath);const loaded=saved||defaultState(info.root),next={...loaded,workspaces:loaded.workspaces.map(fillSinglePane)};setState(next);setFocused(next.workspaces.find(w=>w.id===next.activeWorkspaceId)?.panes[0]?.id||'');}).catch(e=>report(`Saved workspace could not load: ${e}`));
    return window.bridge.onSessionEvent(e=>{if(e.kind==='status')setStatuses(previous=>({...previous,[e.paneId]:e}));});
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
  const stopAll=async()=>{if(!workspace)return;await Promise.all(workspace.panes.map(p=>p.type==='local-model'?window.bridge.cancelChat(p.id):window.bridge.stopSession(p.id)));};
  const switchWorkspace=async(workspaceId:string)=>{
    if(workspaceId===state?.activeWorkspaceId)return;
    if(workspace?.panes.some(p=>isActive(p.id))&&!window.confirm('Loading a workspace ends the current terminal sessions. Continue?'))return;
    try{await stopAll();setMaximized('');setStatuses({});setState(s=>s?{...s,activeWorkspaceId:workspaceId}:s);setFocused(state?.workspaces.find(w=>w.id===workspaceId)?.panes[0]?.id||'');}catch(e){report(String(e));}
  };
  const closePane=async(p:PaneConfig)=>{
    if(isActive(p.id)&&!window.confirm(`Close ${p.title} and end its session?`))return;
    try{await window.bridge.stopSession(p.id);await window.bridge.cancelChat(p.id);update(w=>removePane(w,p.id));if(maximized===p.id)setMaximized('');}catch(e){report(String(e));}
  };
  const savePane=async(p:PaneConfig)=>{
    const old=workspace?.panes.find(x=>x.id===p.id);if(!old)return;
    const launchChanged=old.type!==p.type||old.cwd!==p.cwd||old.command!==p.command||JSON.stringify(old.args)!==JSON.stringify(p.args);
    const wasActive=isActive(p.id),restartable=p.type!=='powershell-admin'&&p.type!=='local-model';
    if(launchChanged&&wasActive&&!window.confirm(restartable?'Apply this configuration? The current session ends and a new one starts in its place.':'Apply this configuration and stop the current session?'))return;
    try{if(launchChanged){await window.bridge.stopSession(p.id);await window.bridge.cancelChat(p.id);setStatuses(prev=>({...prev,[p.id]:{paneId:p.id,kind:'status',status:'idle'}}));}
      update(w=>({...w,panes:w.panes.map(x=>x.id===p.id?p:x)}));setEditor(null);
      if(launchChanged&&wasActive&&restartable)setRelaunch(r=>({...r,[p.id]:(r[p.id]||0)+1}));
    }catch(e){report(String(e));}
  };
  const add=(type:PaneType,cwd?:string)=>{
    if(!workspace||workspace.panes.length>=32){report('A workspace supports up to 32 panes.');return;}
    const base=createPane(type,cwd||workspace.root,type==='local-model'?state?.profiles[0]?.id:'');
    const pane={...base,title:cwd?.split(/[\\/]/).filter(Boolean).pop()||base.title,autoStart:false};update(w=>addPane(w,pane));setFocused(pane.id);if(!cwd)setEditor(pane);setAddOpen(false);
  };
  const addFromFolder=async()=>{setAddOpen(false);try{const cwd=await window.bridge.chooseDirectory();if(cwd)add('claude',cwd);}catch(e){report(String(e));}};
  const changeFolder=async(p:PaneConfig)=>{try{const cwd=await window.bridge.chooseDirectory();if(cwd&&cwd!==p.cwd)await savePane({...p,cwd});}catch(e){report(String(e));}};
  const closeAll=async()=>{
    if(!workspace?.panes.length||!window.confirm(`Close all ${workspace.panes.length} panes and end their sessions?`))return;
    try{await stopAll();setMaximized('');setStatuses({});update(w=>({...w,panes:[],layout:[]}));}catch(e){report(String(e));}
  };
  const preset=async(count:typeof PRESETS[number])=>{
    if(!workspace)return;
    const removed=workspace.panes.slice(count);
    if(removed.length&&!window.confirm(`Use ${count} panes? This closes ${removed.length} pane${removed.length===1?'':'s'} and their sessions.`))return;
    try{await Promise.all(removed.map(async p=>{await window.bridge.stopSession(p.id);await window.bridge.cancelChat(p.id);}));update(w=>applyPreset(w,count));setMaximized('');}catch(e){report(String(e));}
  };
  const copyPane=(p:PaneConfig)=>{if((workspace?.panes.length||0)>=32){report('A workspace supports up to 32 panes.');return;}update(w=>duplicatePane(w,p.id));};
  const reorder=(from:string,to:string)=>{if(workspace?.locked)return;update(w=>moveMode==='swap'?swapPane(w,from,to):reorderPane(w,from,to));};
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
  if(!state||!workspace)return <main className="loading"><Terminal size={28}/><h1>AlphaCode</h1><p>by JABSystems</p><p>{notice||'Loading your local workspace…'}</p></main>;
  const rowCount=Math.max(1,Math.ceil(workspace.panes.length/2));const gridRows=rowCount*4;const rowHeight=Math.max(28,Math.floor((viewport-8*(gridRows-1))/gridRows));
  const running=workspace.panes.filter(p=>isActive(p.id)).length;
  return <div className={`app-shell ${sidebar?'':'sidebar-hidden'}`}>
    <header className="app-toolbar"><div className="brand"><span className="brand-mark"><Terminal size={17}/></span><strong>AlphaCode</strong></div>{!sidebar&&<><span className="toolbar-divider"/><span className="workspace-title">{workspace.name}</span></>}
      <div className="toolbar-actions"><button className="ghost" aria-label="Toggle workspace sidebar" onClick={()=>setSidebar(!sidebar)}><PanelLeft size={16}/></button><div className="presets" aria-label="Layout presets">{PRESETS.map(n=><button key={n} className={workspace.panes.length===n?'selected':''} onClick={()=>void preset(n)}>{n}<span> pane{n===1?'':'s'}</span></button>)}</div>
      <button className="ghost" aria-label={workspace.locked?'Unlock layout':'Lock layout'} title={workspace.locked?'Unlock layout':'Lock layout'} onClick={()=>update(w=>({...w,locked:!w.locked}))}>{workspace.locked?<Lock size={14}/>:<Unlock size={14}/>}<span>{workspace.locked?'Layout locked':'Layout editable'}</span></button>
      <div className="add-menu"><button className="primary" aria-expanded={addOpen} onClick={()=>setAddOpen(!addOpen)}><Plus size={15}/>Add pane<ChevronDown size={13}/></button>{addOpen&&<div className="dropdown">{PANE_TYPES.map(t=><button key={t.type} onClick={()=>add(t.type)}><PaneIcon type={t.type} size={14}/><span>{t.label}</span></button>)}<button className="dropdown-folder" onClick={()=>void addFromFolder()}><FolderOpen size={14}/><span>Browse for a folder…</span></button></div>}</div></div>
    </header>
    {sidebar&&<aside className="sidebar"><section className="workspace-section"><div className="section-heading"><span>Workspace</span><button aria-label="Rename workspace" onClick={()=>setNameDialog('rename')}><Pencil size={12}/></button></div><select aria-label="Load workspace" value={workspace.id} onChange={e=>void switchWorkspace(e.target.value)}>{state.workspaces.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select><button className="project-path" onClick={()=>void chooseRoot()} title={workspace.root}><FolderOpen size={14}/><span>{workspace.root}</span></button><div className="workspace-buttons"><button onClick={()=>setNameDialog('save-as')}><Copy size={12}/>Save as</button><button aria-label="Export workspace" title="Export workspace JSON" onClick={()=>window.bridge.exportWorkspace(workspace).catch(e=>report(String(e)))}><Download size={14}/></button><button aria-label="Import workspace" title="Import workspace JSON" onClick={()=>void importLayout()}><Upload size={14}/></button></div></section>
      <section className="pane-list-section"><div className="section-heading"><span>Panes</span></div><div className="pane-list">{workspace.panes.map((p,n)=><div key={p.id} data-color={p.color||''} className={`pane-list-item ${focused===p.id?'active':''}`} draggable={!workspace.locked} onDragStart={e=>e.dataTransfer.setData('text/plain',p.id)} onDragOver={e=>{if(!workspace.locked)e.preventDefault();}} onDrop={e=>{e.preventDefault();reorder(e.dataTransfer.getData('text/plain'),p.id);}}><button className="pane-list-name" onClick={()=>{setFocused(p.id);if(maximized)setMaximized(p.id);document.getElementById(`pane-${p.id}`)?.scrollIntoView({block:'nearest'});}}><span className={`status-dot ${getStatus(p.id)}`}/><PaneIcon type={p.type} size={13}/><span>{p.title}</span></button><div className="list-reorder"><button disabled={workspace.locked||n===0} aria-label={`Move ${p.title} up`} onClick={()=>reorder(p.id,workspace.panes[n-1].id)}><ArrowUp size={10}/></button><button disabled={workspace.locked||n===workspace.panes.length-1} aria-label={`Move ${p.title} down`} onClick={()=>reorder(p.id,workspace.panes[n+1].id)}><ArrowDown size={10}/></button></div></div>)}</div></section>
      <section className="profiles-section"><div className="section-heading"><span>Local model profiles</span><button aria-label="Add local model profile" onClick={()=>setProfileEditor({id:id(),name:'New profile',provider:'ollama',endpoint:'http://localhost:11434',model:'',systemPrompt:'You are a helpful assistant.',contextSize:32768,temperature:0.7})}><Plus size={13}/></button></div>{state.profiles.map(p=><button className="profile-list-item" key={p.id} onClick={()=>setProfileEditor(p)}><Cpu size={14}/><span><strong>{p.name}</strong><small>{p.model||'Select a model'}</small></span><Settings2 size={12}/></button>)}</section>
    </aside>}
    <main className="workspace-main"><div className="workspace-subbar"><span>{maximized?'Focused pane':workspace.locked?<>Layout locked<Lock size={11}/></>:workspace.panes.length>1&&<>Drag a pane header to arrange<label>Drag<select aria-label="Drag behavior" value={moveMode} onChange={e=>setMoveMode(e.target.value as 'reflow'|'swap')}><option value="reflow">Reflow</option><option value="swap">Swap</option></select></label><button className="ghost" onClick={()=>update(w=>({...w,layout:balancedLayout(w.panes)}))}>Balance panes</button></>}</span><span>{maximized?<button className="ghost" onClick={()=>setMaximized('')}><Minimize2 size={12}/>Restore grid</button>:<><span className="status-dot running"/>{running} active<span className="subbar-separator">/</span>{workspace.panes.length} pane{workspace.panes.length===1?'':'s'}</>}{workspace.panes.length>0&&<button className="ghost danger" title="Close every pane and end its session" onClick={()=>void closeAll()}><X size={12}/>Close all</button>}</span></div>
      <div className={`grid-host ${maximized?'has-maximized':''}`} ref={gridHost}>
        {workspace.panes.length===0&&<div className="empty-workspace"><Terminal size={32}/><h2>Your workspace is ready</h2><p>Add a terminal or local model pane to get started.</p><button className="primary" onClick={()=>add('powershell')}><Plus size={14}/>Add PowerShell</button></div>}
        <GridLayout width={width} cols={12} rowHeight={rowHeight} margin={[8,8]} containerPadding={[0,0]} layout={workspace.layout as Layout[]} draggableHandle=".pane-drag-handle" draggableCancel=".pane-actions,button,input,select" isDraggable={!workspace.locked&&!maximized} isResizable={!workspace.locked&&!maximized&&workspace.panes.length>1} allowOverlap={moveMode==='swap'} compactType={moveMode==='swap'?null:'vertical'}
          onDragStart={()=>{dragOrigin.current=workspace.layout.map(l=>({...l}));}}
          onDragStop={(_layout,_oldItem,newItem)=>{
            // Both modes restore the pre-drag layout first: the grid library's live compaction leaves panes straddling columns and pushed below the viewport.
            const target=dropTarget(dragOrigin.current,newItem),restored=(w:Workspace)=>({...w,layout:dragOrigin.current});
            update(w=>!target?restored(w):moveMode==='swap'?swapPane(restored(w),newItem.i,target.i):reorderPane(restored(w),newItem.i,target.i));
          }}
          onResizeStop={layout=>update(w=>({...w,layout:layout.map(l=>({i:l.i,x:l.x,y:l.y,w:l.w,h:l.h,minW:3,minH:3}))}))}>
          {workspace.panes.map(p=><div key={p.id} id={`pane-${p.id}`} data-pane-id={p.id} data-pane-title={p.title} data-color={p.color||''} className={`pane ${p.type==='powershell-admin'?'admin-pane':''} ${focused===p.id?'focused':''} ${maximized===p.id?'maximized':''}`} onPointerDown={()=>{if(focused!==p.id)setFocused(p.id);}}>
            <header className="pane-header"><div className="pane-drag-handle" title={workspace.locked?'Layout locked':'Drag to arrange'}><GripVertical size={12}/><PaneIcon type={p.type} size={14}/><strong title={p.title}>{p.title}</strong></div><span className={`pane-status ${getStatus(p.id)}`} title={statuses[p.id]?.message}><span className={`status-dot ${getStatus(p.id)}`}/>{p.type==='powershell-admin'&&getStatus(p.id)==='running'?'Admin':getStatus(p.id)==='idle'?'Ready':getStatus(p.id)}</span><div className="pane-actions"><button aria-label={`Configure ${p.title}`} title="Configure and rename" onClick={()=>setEditor(p)}><Settings2 size={13}/></button><button aria-label={`Duplicate ${p.title}`} title="Duplicate configuration" onClick={()=>copyPane(p)}><Copy size={12}/></button><button aria-label={maximized===p.id?`Restore ${p.title}`:`Maximize ${p.title}`} title="Focus pane" onClick={()=>{setMaximized(maximized===p.id?'':p.id);setFocused(p.id);}}>{maximized===p.id?<Minimize2 size={13}/>:<Maximize2 size={13}/>}</button><button aria-label={`Close ${p.title}`} title="Close pane" onClick={()=>void closePane(p)}><X size={13}/></button></div></header>
            <button className="pane-directory" title={`${p.cwd}\nClick to change folder`} aria-label={`Change folder for ${p.title}`} onClick={()=>void changeFolder(p)}><FolderOpen size={11}/><span>{p.cwd}</span>{p.type==='powershell-admin'&&<span className="admin-label">UAC session</span>}</button>
            {p.type==='local-model'?<LocalPane pane={p} profiles={state.profiles} onProfile={profileId=>update(w=>({...w,panes:w.panes.map(x=>x.id===p.id?{...x,profileId}:x)}))} onEditProfile={profileId=>setProfileEditor(state.profiles.find(x=>x.id===profileId)||null)} onStatus={(status,message)=>setStatuses(prev=>({...prev,[p.id]:{paneId:p.id,kind:'status',status,message}}))}/>:<TerminalPane pane={p} status={getStatus(p.id)} focused={focused===p.id} message={statuses[p.id]?.message} relaunch={relaunch[p.id]||0} onError={report}/>}
          </div>)}
        </GridLayout>
      </div>
    </main>
    <footer className="app-statusbar"><span><span className="status-dot running"/>Local terminal cockpit</span><span>{workspace.locked?'Layout locked':'Layout editable'}<span className="statusbar-separator">|</span><span className="save-state" title={statePath?`Saved to ${statePath}`:'Saved on this computer'}><Check size={11}/>{saveLabel}</span></span></footer>
    {notice&&<div className="notice" role="status"><AlertCircle size={16}/><span>{notice}</span><button aria-label="Dismiss notification" onClick={()=>setNotice('')}><X size={14}/></button></div>}
    {editor&&<PaneEditor key={editor.id} pane={editor} profiles={state.profiles} onSave={p=>void savePane(p)} onClose={()=>setEditor(null)} onError={report}/>}
    {profileEditor&&<ProfileEditor key={profileEditor.id} profile={profileEditor} onSave={p=>{setState(s=>s?{...s,profiles:s.profiles.some(x=>x.id===p.id)?s.profiles.map(x=>x.id===p.id?p:x):[...s.profiles,p]}:s);setProfileEditor(null);}} onClose={()=>setProfileEditor(null)}/>}
    {nameDialog&&<NameDialog title={nameDialog==='rename'?'Rename workspace':'Save workspace as'} initial={nameDialog==='rename'?workspace.name:`${workspace.name} copy`} onSave={name=>void saveNamed(name)} onClose={()=>setNameDialog(null)}/>}
  </div>;
}
