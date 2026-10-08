import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Play, RotateCcw, Square, Shield } from 'lucide-react';
import type { PaneConfig, SessionStatus } from '../shared/types';
import '@xterm/xterm/css/xterm.css';

export default function TerminalPane({pane,status,focused,message,onError}: {pane:PaneConfig;status:SessionStatus;focused:boolean;message?:string;onError:(s:string)=>void}) {
  const host=useRef<HTMLDivElement>(null),terminal=useRef<Terminal|null>(null),fit=useRef<FitAddon|null>(null),config=useRef(pane);
  const [launching,setLaunching]=useState(false); config.current=pane;
  const start=async()=>{
    if(launching)return; setLaunching(true);
    try{ fit.current?.fit(); await window.bridge.startSession(config.current,terminal.current?.cols||80,terminal.current?.rows||24); }
    catch(e){onError(String(e));} finally{setLaunching(false);}
  };
  useEffect(()=>{
    const term=new Terminal({fontFamily:'Cascadia Mono, Consolas, monospace',fontSize:12,lineHeight:1.2,scrollback:5000,cursorBlink:true,allowProposedApi:false,theme:{background:'#101214',foreground:'#dce2e8',cursor:'#b6cde2',selectionBackground:'#3c5068',black:'#21252b',red:'#e18b83',green:'#9cbf9b',yellow:'#d8ae68',blue:'#8cb7df',magenta:'#b59fcc',cyan:'#88bdc7',white:'#dce2e8'}});
    const addon=new FitAddon(); term.loadAddon(addon); term.open(host.current!); terminal.current=term; fit.current=addon;
    const unsubscribe=window.bridge.onSessionEvent(event=>{
      if(event.paneId!==pane.id)return;
      if(event.kind==='data'&&event.data)term.write(event.data);
      if(event.kind==='status'&&event.status==='error'&&event.message)term.writeln(`\r\n\x1b[31m${event.message}\x1b[0m`);
    });
    const input=term.onData(data=>window.bridge.writeSession(pane.id,data));
    const observer=new ResizeObserver(()=>{
      if(!host.current?.offsetWidth||!host.current?.offsetHeight)return;
      try{addon.fit();window.bridge.resizeSession(pane.id,term.cols,term.rows);}catch{/* A hidden maximized sibling has no viewport. */}
    });observer.observe(host.current!);
    term.attachCustomKeyEventHandler(e=>{
      if(e.type==='keydown'&&e.ctrlKey&&e.shiftKey&&e.code==='KeyC'){navigator.clipboard.writeText(term.getSelection()).catch(()=>{});return false;}
      // Plain Ctrl+V: skip xterm's ^V so the native paste event fires (Wispr Flow and other dictation tools paste this way).
      if(e.ctrlKey&&!e.shiftKey&&!e.altKey&&e.code==='KeyV')return false;
      if(e.type==='keydown'&&e.ctrlKey&&e.shiftKey&&e.code==='KeyV'){navigator.clipboard.readText().then(text=>term.paste(text)).catch(()=>{});return false;}
      return true;
    });
    if(pane.autoStart)void start();
    return()=>{unsubscribe();input.dispose();observer.disconnect();term.dispose();terminal.current=null;};
  },[]);
  useEffect(()=>{if(focused)terminal.current?.focus();},[focused]);
  const active=['running','starting'].includes(status)||launching;
  return <div className="terminal-content">
    <div ref={host} className="xterm-host" aria-label={`${pane.title} terminal`} />
    {(status==='idle'||status==='exited'||status==='error')&&!launching&&<div className="terminal-empty">
      {pane.type==='powershell-admin'?<Shield size={22}/>:<Play size={22}/>}
      <strong>{pane.type==='powershell-admin'?'Start an elevated session':status==='error'?'Session needs attention':status==='exited'?'Session ended':'Ready to start'}</strong>
      <span>{pane.type==='powershell-admin'?'Windows will ask for permission. Only this pane elevates.':message||`${pane.type==='custom'?pane.command||'Configure an executable':pane.type} in its own working directory`}</span>
      <button onClick={()=>void start()}><Play size={13}/>{pane.type==='powershell-admin'?'Start with UAC':'Start session'}</button>
    </div>}
    {launching&&pane.type==='powershell-admin'&&<div className="terminal-empty"><Shield size={22}/><strong>Waiting for Windows permission</strong><span>Approve or cancel the UAC prompt.</span><button onClick={()=>void window.bridge.stopSession(pane.id)}>Cancel launch</button></div>}
    <div className="terminal-footer"><span>{pane.type==='powershell-admin'?'Elevated PowerShell':'Independent terminal'}{status==='running'?' · Ctrl+C to interrupt':''}</span>
      <button title="Clear terminal" aria-label={`Clear ${pane.title}`} onClick={()=>terminal.current?.clear()}>Clear</button>
      {active?<button aria-label={`Stop ${pane.title}`} onClick={()=>window.bridge.stopSession(pane.id).catch(e=>onError(String(e)))}><Square size={11}/>Stop</button>:<button aria-label={`Restart ${pane.title}`} onClick={()=>void start()}><RotateCcw size={11}/>Restart</button>}
    </div>
  </div>;
}
