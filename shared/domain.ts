import type { AppState, GridItem, LocalProfile, PaneColor, PaneConfig, PaneType, Workspace } from './types';

export const PANE_TYPES: { type: PaneType; label: string }[] = [
  {type:'claude',label:'Claude'}, {type:'powershell',label:'PowerShell'}, {type:'powershell-admin',label:'PowerShell Admin'},
  {type:'local-model',label:'Local Model'}, {type:'codex',label:'Codex'}, {type:'gemini',label:'Gemini'},
  {type:'wsl',label:'WSL'}, {type:'cmd',label:'CMD'}, {type:'git-bash',label:'Git Bash'}, {type:'custom',label:'Custom Command'},
];
export const PANE_COLORS: { color: PaneColor; label: string }[] = [
  {color:'',label:'None'}, {color:'blue',label:'Blue'}, {color:'green',label:'Green'}, {color:'amber',label:'Amber'},
  {color:'purple',label:'Purple'}, {color:'red',label:'Red'}, {color:'teal',label:'Teal'},
];
export const id = () => globalThis.crypto.randomUUID();
export const balancedLayout = (panes: PaneConfig[]): GridItem[] => panes.length===1?[{ i:panes[0].id, x:0, y:0, w:12, h:4, minW:3, minH:3 }]:panes.map((p,n) => ({ i:p.id, x:(n%2)*6, y:Math.floor(n/2)*4, w:6, h:4, minW:3, minH:3 }));
export function createPane(type: PaneType, cwd: string, profileId = ''): PaneConfig {
  return { id:id(), type, title:PANE_TYPES.find(t=>t.type===type)?.label || 'Terminal', cwd, command:'', args:[], profileId, color:'', autoStart:type!=='powershell-admin' && type!=='local-model' && type!=='custom' };
}
export function defaultState(root: string): AppState {
  const profiles: LocalProfile[] = [
    {id:'ollama-coding',name:'Ollama · Coding',provider:'ollama',endpoint:'http://localhost:11434',model:'qwen3:8b',systemPrompt:'You are a careful coding assistant. Explain your reasoning concisely.',contextSize:32768,temperature:0.3},
    {id:'lmstudio-general',name:'LM Studio · General',provider:'lmstudio',endpoint:'http://localhost:1234',model:'',systemPrompt:'You are a helpful assistant.',contextSize:32768,temperature:0.7},
  ];
  const panes: PaneConfig[] = [...['A','B','C','D'].map(letter=>({...createPane('claude',`${root}\\workspaces\\claude-${letter.toLowerCase()}`),title:`Claude ${letter}`})),createPane('powershell',root),createPane('powershell-admin',root),{...createPane('local-model',root,profiles[0].id),title:'Local · Coding'},{...createPane('local-model',root,profiles[1].id),title:'Local · General'}];
  const workspace: Workspace = {id:id(),name:'Development',root,panes,layout:balancedLayout(panes),locked:false};
  return {version:1,activeWorkspaceId:workspace.id,workspaces:[workspace],profiles};
}
export function moveWorkspace(w: Workspace, root: string): Workspace {
  const under=(cwd:string)=>cwd===w.root||cwd.startsWith(w.root+'\\');
  return {...w,root,panes:w.panes.map(p=>under(p.cwd)?{...p,cwd:root+p.cwd.slice(w.root.length)}:p)};
}
/** A lone pane owns the whole grid; any other count keeps its layout. */
export const fillSinglePane = (w: Workspace): Workspace => w.panes.length===1?{...w,layout:balancedLayout(w.panes)}:w;
export function addPane(w: Workspace, p: PaneConfig): Workspace {
  const y=Math.max(0,...w.layout.map(l=>l.y+l.h));
  return fillSinglePane({...w,panes:[...w.panes,p],layout:[...w.layout,{i:p.id,x:0,y,w:6,h:4,minW:3,minH:3}]});
}
export function duplicatePane(w: Workspace, paneId: string): Workspace {
  const pane=w.panes.find(p=>p.id===paneId); if(!pane) return w;
  return addPane(w,{...pane,id:id(),title:`${pane.title} copy`,args:[...pane.args],autoStart:false});
}
export function removePane(w: Workspace, paneId: string): Workspace { return fillSinglePane({...w,panes:w.panes.filter(p=>p.id!==paneId),layout:w.layout.filter(l=>l.i!==paneId)}); }
export function reorderPane(w: Workspace, from: string, to: string): Workspace {
  const panes=[...w.panes]; const a=panes.findIndex(p=>p.id===from),b=panes.findIndex(p=>p.id===to);
  if(a<0||b<0||a===b)return w;
  const [p]=panes.splice(a,1); panes.splice(b,0,p); return {...w,panes,layout:balancedLayout(panes)};
}
export function swapPane(w: Workspace, a: string, b: string): Workspace {
  const first=w.layout.find(l=>l.i===a),second=w.layout.find(l=>l.i===b); if(!first||!second||a===b)return w;
  const panes=[...w.panes],ai=panes.findIndex(p=>p.id===a),bi=panes.findIndex(p=>p.id===b); [panes[ai],panes[bi]]=[panes[bi],panes[ai]];
  return {...w,panes,layout:w.layout.map(l=>l.i===a?{...second,i:a}:l.i===b?{...first,i:b}:l)};
}
/** The origin item the dropped item overlaps most, or undefined when it was dropped on empty space. */
export function dropTarget(origin: GridItem[], dropped: GridItem): GridItem | undefined {
  const overlap=(l:GridItem)=>Math.max(0,Math.min(dropped.x+dropped.w,l.x+l.w)-Math.max(dropped.x,l.x))*Math.max(0,Math.min(dropped.y+dropped.h,l.y+l.h)-Math.max(dropped.y,l.y));
  return origin.filter(l=>l.i!==dropped.i&&overlap(l)>0).sort((a,b)=>overlap(b)-overlap(a))[0];
}
export const PRESETS = [1,4,6,8] as const;
export function applyPreset(w: Workspace, count: typeof PRESETS[number]): Workspace {
  const panes=w.panes.slice(0,count); while(panes.length<count)panes.push(createPane('powershell',w.root));
  return {...w,panes,layout:balancedLayout(panes)};
}

export function string(value: unknown, name: string, max=4096): string {
  if(typeof value!=='string'||value.length>max||value.includes('\0')) throw new Error(`Invalid ${name}`); return value;
}
export function validateId(value: unknown): string {
  const result=string(value,'identifier',100); if(!/^[a-zA-Z0-9_-]+$/.test(result))throw new Error('Invalid identifier'); return result;
}
export function validateProfile(value: unknown): LocalProfile {
  const p=value as LocalProfile; if(!p||!['ollama','lmstudio'].includes(p.provider))throw new Error('Invalid local model provider');
  const endpoint=string(p.endpoint,'endpoint'); const url=new URL(endpoint);
  if(!['http:','https:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash)throw new Error('Endpoint must be an HTTP(S) loopback address');
  if(!Number.isInteger(p.contextSize)||p.contextSize<512||p.contextSize>1048576||!Number.isFinite(p.temperature)||p.temperature<0||p.temperature>2)throw new Error('Invalid model parameters');
  return {id:validateId(p.id),name:string(p.name,'profile name',100),provider:p.provider,endpoint,model:string(p.model,'model',500),systemPrompt:string(p.systemPrompt,'system prompt',32000),contextSize:p.contextSize,temperature:p.temperature};
}
export function validatePane(value: unknown): PaneConfig {
  const p=value as PaneConfig; if(!p||!PANE_TYPES.some(t=>t.type===p.type)||typeof p.autoStart!=='boolean')throw new Error('Invalid pane');
  if(!Array.isArray(p.args)||p.args.length>100)throw new Error('Invalid command arguments');
  const color=p.color||''; if(!PANE_COLORS.some(c=>c.color===color))throw new Error('Invalid pane color');
  return {id:validateId(p.id),type:p.type,title:string(p.title,'pane title',100),cwd:string(p.cwd,'working directory'),command:string(p.command,'command'),args:p.args.map(a=>string(a,'argument')),profileId:string(p.profileId,'profile ID',100),color,autoStart:p.type==='powershell-admin'?false:p.autoStart};
}
export function validateWorkspace(value: unknown): Workspace {
  const w=value as Workspace; if(!w||!Array.isArray(w.panes)||w.panes.length>32||!Array.isArray(w.layout)||typeof w.locked!=='boolean')throw new Error('Invalid workspace');
  const panes=w.panes.map(validatePane),ids=new Set(panes.map(p=>p.id)); if(ids.size!==panes.length)throw new Error('Duplicate pane IDs');
  const layout:GridItem[]=w.layout.map(l=>{
    if(!l||!ids.has(l.i)||![l.x,l.y,l.w,l.h].every(Number.isInteger)||l.x<0||l.x>11||l.y<0||l.y>10000||l.w<3||l.w>12||l.x+l.w>12||l.h<3||l.h>100)throw new Error('Invalid pane layout');
    return {i:l.i,x:l.x,y:l.y,w:l.w,h:l.h,minW:3,minH:3};
  });
  if(new Set(layout.map(l=>l.i)).size!==panes.length||layout.length!==panes.length)throw new Error('Layout must contain each pane once');
  return {id:validateId(w.id),name:string(w.name,'workspace name',100),root:string(w.root,'project directory'),panes,layout,locked:w.locked};
}
export function validateState(value: unknown): AppState {
  const s=value as AppState; if(!s||s.version!==1||!Array.isArray(s.workspaces)||s.workspaces.length<1||s.workspaces.length>50||!Array.isArray(s.profiles)||s.profiles.length>50)throw new Error('Unsupported or invalid saved state');
  const workspaces=s.workspaces.map(validateWorkspace),profiles=s.profiles.map(validateProfile); const activeWorkspaceId=validateId(s.activeWorkspaceId);
  if(!workspaces.some(w=>w.id===activeWorkspaceId)||new Set(workspaces.map(w=>w.id)).size!==workspaces.length||new Set(profiles.map(p=>p.id)).size!==profiles.length)throw new Error('Invalid workspace or profile IDs');
  const allIds=workspaces.flatMap(w=>w.panes.map(p=>p.id)); if(new Set(allIds).size!==allIds.length)throw new Error('Pane IDs must be globally unique');
  return {version:1,activeWorkspaceId,workspaces,profiles};
}
