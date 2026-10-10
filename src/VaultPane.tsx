import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Square, Trash2, Brain } from 'lucide-react';
import type { LocalProfile, PaneConfig, VaultGraph as Graph, VaultTarget } from '../shared/types';
import { COMMAND } from '../shared/vault';
import VaultGraph from './VaultGraph';

interface Entry { role: 'user' | 'assistant' | 'system'; content: string; notes?: string[] }
export default function VaultPane({pane,profiles,workspaces,onProfile,onEditProfile,onStatus,onLaunch,onLoadWorkspace}: {pane:PaneConfig;profiles:LocalProfile[];workspaces:{id:string;name:string}[];onProfile:(id:string)=>void;onEditProfile:(id:string)=>void;onStatus:(status:'idle'|'busy'|'error'|'running',message?:string)=>void;onLaunch:(target:VaultTarget)=>void;onLoadWorkspace:(id:string)=>void}) {
  const [entries,setEntries]=useState<Entry[]>([]),[prompt,setPrompt]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[graph,setGraph]=useState<Graph|null>(null),[highlight,setHighlight]=useState<string[]>([]),[pulse,setPulse]=useState('');
  const scroll=useRef<HTMLDivElement>(null),sequence=useRef(0); const profile=profiles.find(p=>p.id===pane.profileId);
  const refresh=()=>{window.bridge.vaultGraph().then(setGraph).catch(()=>{});};
  useEffect(()=>{refresh();window.addEventListener('focus',refresh);return()=>{window.removeEventListener('focus',refresh);sequence.current++;void window.bridge.cancelChat(pane.id);};},[]);
  useEffect(()=>{scroll.current?.scrollTo({top:scroll.current.scrollHeight});},[entries,busy]);
  const say=(content:string)=>setEntries(e=>[...e,{role:'system',content}]);
  const command=async(name:string)=>{
    const targets=await window.bridge.vaultResolve(name,workspaces);
    // Only an exact or prefix match may open something on its own; a loose "contains" match is listed and the user retypes it.
    const sure=targets.filter(t=>(t.tier??2)<2),projects=sure.filter(t=>t.kind==='project'),vaults=sure.filter(t=>t.kind==='obsidian'),spaces=sure.filter(t=>t.kind==='workspace');
    if(projects.length===1){onLaunch(projects[0]);say(`Opened a Claude pane in ${projects[0].path}.`);if(vaults.length===1){await window.bridge.openObsidianVault(vaults[0].path);say(`Opened Obsidian vault ${vaults[0].name}.`);}return;}
    if(!projects.length&&vaults.length===1){await window.bridge.openObsidianVault(vaults[0].path);say(`Opened Obsidian vault ${vaults[0].name}.`);return;}
    if(!projects.length&&!vaults.length&&spaces.length===1){onLoadWorkspace(spaces[0].path);say(`Loading workspace ${spaces[0].name}.`);return;}
    say(targets.length?`${sure.length?'More than one':'No exact'} match for "${name}":\n${targets.map(t=>`- ${t.kind}: ${t.name}`).join('\n')}\nType the full name to open one.`:`Nothing in the vault, Obsidian, or your workspaces matches "${name}".`);
  };
  const send=async()=>{
    if(busy||!prompt.trim())return; const text=prompt.trim(),m=COMMAND.exec(text); setPrompt('');setError('');setEntries(e=>[...e,{role:'user',content:text}]);
    if(m){try{await command(m[2]);}catch(e){setError(String(e));}return;}
    if(!profile?.model){setError('Choose a model in this profile before asking.');return;}
    const mine=++sequence.current;setBusy(true);setHighlight([]);onStatus('busy');
    try{const r=await window.bridge.vaultAsk(pane.id,profile,text);if(sequence.current===mine){setEntries(e=>[...e,{role:'assistant',content:r.answer,notes:r.notes}]);setHighlight(r.notes);onStatus('running');refresh();}}
    catch(e){if(sequence.current===mine){setError(String(e));onStatus('error',String(e));}}
    finally{if(sequence.current===mine)setBusy(false);}
  };
  const stop=()=>{sequence.current++;void window.bridge.cancelChat(pane.id);setBusy(false);onStatus('idle');};
  const notes=graph?graph.nodes.filter(n=>n.type!=='hub').length:0,hubs=graph?graph.nodes.length-notes:0;
  return <div className="local-content vault-content">
    <div className="profile-strip"><Brain size={13}/><select aria-label={`Profile for ${pane.title}`} value={pane.profileId} disabled={busy} onChange={e=>onProfile(e.target.value)}><option value="">Choose a profile</option>{profiles.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select><button aria-label={`Edit profile for ${pane.title}`} onClick={()=>profile&&onEditProfile(profile.id)}>Configure</button></div>
    <VaultGraph graph={graph} thinking={busy} highlight={highlight} pulse={pulse}/>
    <div className="chat-transcript" ref={scroll}>
      {!entries.length&&<div className="local-welcome"><Brain size={22}/><strong>Claude memory vault</strong><span>{graph?`${notes} notes across ${hubs} projects`:'Loading vault…'}</span><p>Ask about anything Claude remembers, or type "launch &lt;project&gt;".</p></div>}
      {entries.map((m,i)=><div className={`chat-message ${m.role}`} key={i}><span className="speaker">{m.role==='user'?'You':m.role==='system'?'AlphaCode':'Vault'}</span><pre>{m.content}</pre>{m.notes?.length?<div className="note-chips">{m.notes.map(n=><button type="button" key={n} className="note-chip" onClick={()=>setPulse(`${n}:${Date.now()}`)}>{n}</button>)}</div>:null}</div>)}
      {busy&&<div className="thinking">Reading the vault…</div>}
      {error&&<div className="inline-error" role="alert">{error}</div>}
    </div>
    <form className="composer" onSubmit={e=>{e.preventDefault();void send();}}><textarea aria-label={`Message ${pane.title}`} placeholder="Ask the vault, or: launch <project>" value={prompt} onChange={e=>setPrompt(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();void send();}}}/>{busy?<button type="button" aria-label={`Cancel response ${pane.title}`} onClick={stop}><Square size={14}/></button>:<button type="submit" aria-label={`Send to ${pane.title}`} disabled={!prompt.trim()}><ArrowUp size={16}/></button>}</form>
    <div className="terminal-footer"><span>{profile?.model||'No model selected'} · Vault</span><button disabled={busy} aria-label={`Clear conversation ${pane.title}`} onClick={()=>{setEntries([]);setError('');setHighlight([]);onStatus('idle');}}><Trash2 size={11}/>Clear</button></div>
  </div>;
}
