import { useState } from 'react';
import { FolderOpen, X } from 'lucide-react';
import { PANE_COLORS, PANE_TYPES } from '../shared/domain';
import type { LocalProfile, PaneColor, PaneConfig, PaneType } from '../shared/types';
export default function PaneEditor({pane,profiles,onSave,onClose,onError}: {pane:PaneConfig;profiles:LocalProfile[];onSave:(p:PaneConfig)=>void;onClose:()=>void;onError:(m:string)=>void}) {
  const [draft,setDraft]=useState({...pane}),[args,setArgs]=useState(pane.args.join('\n'));
  return <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="pane-editor-heading">
    <header><div><h2 id="pane-editor-heading">Configure pane</h2><p>Its position and session belong to this pane.</p></div><button aria-label="Close pane settings" onClick={onClose}><X size={17}/></button></header>
    <form onSubmit={e=>{e.preventDefault();if(!draft.title.trim()){onError('A pane name is required.');return;}onSave({...draft,title:draft.title.trim(),args:args.split('\n').filter(Boolean)});}}>
      <label>Pane name<input autoFocus value={draft.title} maxLength={100} onChange={e=>setDraft({...draft,title:e.target.value})}/></label>
      <label>Pane type<select value={draft.type} onChange={e=>setDraft({...draft,type:e.target.value as PaneType,autoStart:false})}>{PANE_TYPES.map(t=><option key={t.type} value={t.type}>{t.label}</option>)}</select></label>
      <label>Accent color<select value={draft.color||''} onChange={e=>setDraft({...draft,color:e.target.value as PaneColor})}>{PANE_COLORS.map(c=><option key={c.color} value={c.color}>{c.label}</option>)}</select></label>
      <label>Working directory<div className="input-with-action"><input value={draft.cwd} onChange={e=>setDraft({...draft,cwd:e.target.value})}/><button type="button" aria-label="Choose working directory" onClick={()=>window.bridge.chooseDirectory().then(cwd=>{if(cwd)setDraft({...draft,cwd});}).catch(e=>onError(String(e)))}><FolderOpen size={16}/></button></div></label>
      {draft.type==='local-model'||draft.type==='vault'?<label>Local model profile<select value={draft.profileId} onChange={e=>setDraft({...draft,profileId:e.target.value})}><option value="">Choose profile</option>{profiles.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>:<>
        {draft.type!=='powershell-admin'&&<><label>{draft.type==='custom'?'Executable or script path':'Executable override (optional)'}<input placeholder={draft.type==='custom'?'C:\\Tools\\tool.exe':'Use the default installed command'} value={draft.command} onChange={e=>setDraft({...draft,command:e.target.value})}/></label>
        <label>Arguments (one per line)<textarea rows={3} value={args} onChange={e=>setArgs(e.target.value)}/></label></>}
        {draft.type==='powershell-admin'?<p className="admin-note">Only PowerShell can run in this elevated pane. Start it explicitly to request UAC permission.</p>:<label className="checkbox"><input type="checkbox" checked={draft.autoStart} onChange={e=>setDraft({...draft,autoStart:e.target.checked})}/>Start this session when workspace loads</label>}
      </>}
      <p className="form-note">Changing a type, directory, or command stops the current session. Use Start to launch the new configuration. Renaming preserves the session.</p>
      <footer><button type="button" onClick={onClose}>Cancel</button><button className="primary" type="submit">Apply changes</button></footer>
    </form>
  </section></div>;
}
