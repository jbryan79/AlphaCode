import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Settings2, Trash2 } from 'lucide-react';

/** Right-click menu for a sidebar pane. Opens at the pointer, stays on screen, and closes on any outside click, Escape, scroll, resize or window blur. */
export default function PaneMenu({x,y,title,disabledReason,onConfigure,onDelete,onClose}: {x:number;y:number;title:string;disabledReason:string;onConfigure:()=>void;onDelete:()=>void;onClose:()=>void}) {
  const menu=useRef<HTMLDivElement>(null),[pos,setPos]=useState({left:x,top:y});
  useLayoutEffect(()=>{const r=menu.current?.getBoundingClientRect();if(!r)return;setPos({left:Math.max(4,Math.min(x,window.innerWidth-r.width-4)),top:Math.max(4,Math.min(y,window.innerHeight-r.height-4))});},[x,y]);
  useEffect(()=>{
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const outside=(e:MouseEvent)=>{if(!menu.current?.contains(e.target as Node))onClose();};
    const close=()=>onClose();
    window.addEventListener('mousedown',outside,true);window.addEventListener('scroll',close,true);window.addEventListener('resize',close);window.addEventListener('blur',close);
    return()=>{window.removeEventListener('mousedown',outside,true);window.removeEventListener('scroll',close,true);window.removeEventListener('resize',close);window.removeEventListener('blur',close);};
  },[]);
  const keys=(e:React.KeyboardEvent)=>{
    if(e.key==='Escape'||e.key==='Tab'){e.preventDefault();onClose();return;}
    if(e.key!=='ArrowDown'&&e.key!=='ArrowUp'&&e.key!=='Home'&&e.key!=='End')return;
    e.preventDefault();const items=[...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')||[])];if(!items.length)return;
    const at=items.indexOf(document.activeElement as HTMLButtonElement);
    const next=e.key==='Home'?0:e.key==='End'?items.length-1:e.key==='ArrowDown'?(at+1)%items.length:(at<=0?items.length-1:at-1);
    items[next].focus();
  };
  const run=(action:()=>void)=>()=>{onClose();action();};
  return <div ref={menu} className="pane-menu" role="menu" aria-label={`${title} actions`} style={pos} onKeyDown={keys} onContextMenu={e=>e.preventDefault()}>
    <button role="menuitem" disabled={!!disabledReason} title={disabledReason||undefined} onClick={run(onConfigure)}><Settings2 size={13}/>Configure…</button>
    <hr/>
    <button role="menuitem" className="danger-item" disabled={!!disabledReason} title={disabledReason||undefined} onClick={run(onDelete)}><Trash2 size={13}/>Delete pane</button>
    {disabledReason&&<p className="pane-menu-note">{disabledReason}</p>}
  </div>;
}
