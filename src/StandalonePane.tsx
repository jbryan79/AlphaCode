import type { ReactNode } from 'react';
import { FolderOpen, RotateCcw } from 'lucide-react';
import type { PaneConfig, SessionStatus } from '../shared/types';
import TerminalPane from './TerminalPane';

/**
 * A Claude session that belongs to no workspace: the Chat view and the Support dock. It keeps its own folder,
 * survives workspace switches and Orchestrate runs, and offers a fresh conversation without touching any pane.
 */
export default function StandalonePane({pane,label,detail,status,message,focused,relaunch,className='',actions,onChangeFolder,onNew,onError}: {pane:PaneConfig;label:string;detail:string;status:SessionStatus;message?:string;focused:boolean;relaunch:number;className?:string;actions?:ReactNode;onChangeFolder:()=>void;onNew:()=>void;onError:(s:string)=>void}) {
  const live=['running','busy','starting'].includes(status);
  return <section className={`solo ${className}`} aria-label={label}>
    <header className="solo-header">
      <div className="solo-title"><strong>{label}</strong><span>{detail}</span></div>
      <button className="solo-folder" title={`${pane.cwd}\nClick to change folder`} aria-label={`Change folder for ${label}`} onClick={onChangeFolder}><FolderOpen size={12}/><span>{pane.cwd||'Choose a folder'}</span></button>
      <span className={`pane-status ${status}`}><span className={`status-dot ${status}`}/>{status==='idle'?'Ready':status}</span>
      {actions}
      <button className="ghost" title="End this conversation and start a new one" disabled={!live&&status==='idle'} onClick={onNew}><RotateCcw size={12}/>New chat</button>
    </header>
    <div className="solo-body"><TerminalPane pane={pane} status={status} focused={focused} message={message} relaunch={relaunch} onError={onError}/></div>
  </section>;
}
