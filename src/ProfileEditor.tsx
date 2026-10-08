import { useState } from 'react';
import { X, RefreshCw } from 'lucide-react';
import { validateProfile } from '../shared/domain';
import type { LocalProfile } from '../shared/types';
export default function ProfileEditor({profile,onSave,onClose}: {profile:LocalProfile;onSave:(p:LocalProfile)=>void;onClose:()=>void}) {
  const [draft,setDraft]=useState({...profile}),[models,setModels]=useState<string[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const discover=async()=>{setBusy(true);setError('');try{setModels(await window.bridge.listModels(draft));}catch(e){setError(String(e));}finally{setBusy(false);}};
  return <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="profile-editor-heading">
    <header><div><h2 id="profile-editor-heading">Local model profile</h2><p>Reusable connection settings. Conversations stay independent.</p></div><button aria-label="Close profile settings" onClick={onClose}><X size={17}/></button></header>
    <form onSubmit={e=>{e.preventDefault();try{onSave(validateProfile(draft));}catch(e){setError(String(e));}}}>
      <label>Profile name<input autoFocus value={draft.name} maxLength={100} onChange={e=>setDraft({...draft,name:e.target.value})}/></label>
      <div className="form-row"><label>Provider<select value={draft.provider} onChange={e=>{setDraft({...draft,provider:e.target.value as LocalProfile['provider'],endpoint:e.target.value==='ollama'?'http://localhost:11434':'http://localhost:1234',model:''});setModels([]);}}><option value="ollama">Ollama</option><option value="lmstudio">LM Studio</option></select></label><label>Temperature<input type="number" min={0} max={2} step={0.1} value={draft.temperature} onChange={e=>setDraft({...draft,temperature:Number(e.target.value)})}/></label></div>
      <label>Endpoint<input value={draft.endpoint} onChange={e=>setDraft({...draft,endpoint:e.target.value})}/></label>
      <label>Model<div className="input-with-action"><input list="discovered-models" value={draft.model} placeholder="Model name from your local server" onChange={e=>setDraft({...draft,model:e.target.value})}/><button type="button" onClick={()=>void discover()} disabled={busy}><RefreshCw size={14}/>{busy?'Checking…':'Discover'}</button></div><datalist id="discovered-models">{models.map(m=><option key={m} value={m}/>)}</datalist></label>
      {models.length>0&&<label>Available models<select value={draft.model} onChange={e=>setDraft({...draft,model:e.target.value})}><option value="">Choose a model</option>{models.map(m=><option key={m} value={m}>{m}</option>)}</select></label>}
      <label>Context size (tokens)<input type="number" min={512} max={1048576} step={512} value={draft.contextSize} onChange={e=>setDraft({...draft,contextSize:Number(e.target.value)})}/></label>
      <label>System prompt<textarea rows={3} value={draft.systemPrompt} onChange={e=>setDraft({...draft,systemPrompt:e.target.value})}/></label>
      <p className="form-note">{draft.provider==='lmstudio'?'LM Studio context size is set when loading the model in its server.':'Ollama receives the context size for each request.'} Endpoints are limited to this computer.</p>
      {error&&<div role="alert" className="inline-error">{error}</div>}
      <footer><button type="button" onClick={onClose}>Cancel</button><button type="submit" className="primary">Save profile</button></footer>
    </form>
  </section></div>;
}
