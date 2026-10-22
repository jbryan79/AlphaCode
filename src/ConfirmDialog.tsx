import { useEffect, useRef } from 'react';
import { AlertTriangle } from 'lucide-react';

/** A destructive confirmation. Cancel has focus, Escape cancels, and Enter never confirms by accident. Tab stays inside the dialog. */
export default function ConfirmDialog({title,body,confirmLabel,onConfirm,onCancel}: {title:string;body:string;confirmLabel:string;onConfirm:()=>void;onCancel:()=>void}) {
  const box=useRef<HTMLDivElement>(null),cancel=useRef<HTMLButtonElement>(null);
  useEffect(()=>{cancel.current?.focus();},[]);
  const keys=(e:React.KeyboardEvent)=>{
    if(e.key==='Escape'){e.preventDefault();onCancel();return;}
    if(e.key!=='Tab')return;
    const items=[...(box.current?.querySelectorAll<HTMLButtonElement>('button')||[])];if(!items.length)return;
    const at=items.indexOf(document.activeElement as HTMLButtonElement),next=e.shiftKey?(at<=0?items.length-1:at-1):(at+1)%items.length;
    e.preventDefault();items[next].focus();
  };
  return <div className="modal-backdrop confirm-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onCancel();}}>
    <div ref={box} role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-body" className="modal small-modal confirm-modal" onKeyDown={keys}>
      <header><AlertTriangle size={20}/><h2 id="confirm-title">{title}</h2></header>
      <p id="confirm-body">{body}</p>
      <footer><button ref={cancel} type="button" onClick={onCancel}>Cancel</button><button type="button" className="danger-button" onClick={onConfirm}>{confirmLabel}</button></footer>
    </div>
  </div>;
}
