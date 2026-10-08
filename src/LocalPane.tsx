import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Square, Trash2, Cpu } from 'lucide-react';
import type { ChatMessage, LocalProfile, PaneConfig } from '../shared/types';

export default function LocalPane({pane,profiles,onProfile,onEditProfile,onStatus}: {pane:PaneConfig;profiles:LocalProfile[];onProfile:(id:string)=>void;onEditProfile:(id:string)=>void;onStatus:(status:'idle'|'busy'|'error'|'running',message?:string)=>void}) {
  const [messages,setMessages]=useState<ChatMessage[]>([]),[prompt,setPrompt]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const scroll=useRef<HTMLDivElement>(null),sequence=useRef(0); const profile=profiles.find(p=>p.id===pane.profileId);
  useEffect(()=>{sequence.current++;void window.bridge.cancelChat(pane.id);setBusy(false);setMessages([]);setError('');onStatus('idle');},[pane.profileId]);
  useEffect(()=>{scroll.current?.scrollTo({top:scroll.current.scrollHeight});},[messages,busy]);
  useEffect(()=>()=>{sequence.current++;void window.bridge.cancelChat(pane.id);},[]);
  const send=async()=>{
    if(busy||!prompt.trim())return;
    if(!profile?.model){setError('Choose a model in this profile before sending.');return;}
    const mine=++sequence.current,next=[...messages,{role:'user' as const,content:prompt.trim()}];setMessages(next);setPrompt('');setBusy(true);setError('');onStatus('busy');
    try{const result=await window.bridge.chat(pane.id,profile,next);
      if(sequence.current===mine){setMessages([...next,{role:'assistant',content:result}]);onStatus('running');}
    }catch(e){if(sequence.current===mine){setError(String(e));onStatus('error',String(e));}}
    finally{if(sequence.current===mine)setBusy(false);}
  };
  const stop=()=>{sequence.current++;void window.bridge.cancelChat(pane.id);setBusy(false);onStatus('idle');};
  return <div className="local-content">
    <div className="profile-strip"><Cpu size={13}/><select aria-label={`Profile for ${pane.title}`} value={pane.profileId} disabled={busy} onChange={e=>onProfile(e.target.value)}><option value="">Choose a profile</option>{profiles.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select><button aria-label={`Edit profile for ${pane.title}`} onClick={()=>profile&&onEditProfile(profile.id)}>Configure</button></div>
    <div className="chat-transcript" ref={scroll}>
      {!messages.length&&<div className="local-welcome"><Cpu size={22}/><strong>{profile?.model||'Choose a local model'}</strong><span>{profile?.provider==='ollama'?'Ollama':'LM Studio'} · {profile?.endpoint||'Profile required'}</span><p>Independent conversation. Runs on your local model server.</p></div>}
      {messages.map((m,i)=><div className={`chat-message ${m.role}`} key={i}><span className="speaker">{m.role==='user'?'You':profile?.model||'Model'}</span><pre>{m.content}</pre></div>)}
      {busy&&<div className="thinking">Generating response…</div>}
      {error&&<div className="inline-error" role="alert">{error}</div>}
    </div>
    <form className="composer" onSubmit={e=>{e.preventDefault();void send();}}><textarea aria-label={`Message ${pane.title}`} placeholder="Ask your local model…" value={prompt} onChange={e=>setPrompt(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();void send();}}}/>{busy?<button type="button" aria-label={`Cancel response ${pane.title}`} onClick={stop}><Square size={14}/></button>:<button type="submit" aria-label={`Send to ${pane.title}`} disabled={!prompt.trim()}><ArrowUp size={16}/></button>}</form>
    <div className="terminal-footer"><span>{profile?.model||'No model selected'} · Local session</span><button disabled={busy} aria-label={`Clear conversation ${pane.title}`} onClick={()=>{setMessages([]);setError('');onStatus('idle');}}><Trash2 size={11}/>Clear</button></div>
  </div>;
}
