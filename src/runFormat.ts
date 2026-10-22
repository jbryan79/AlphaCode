import { useEffect, useState } from 'react';
import type { Task } from '../shared/types';

/** Whole minutes and seconds, or hours and minutes past the hour: "4m 07s", "1h 05m". */
export const duration=(ms:number)=>{const s=Math.max(0,Math.round(ms/1000)),h=Math.floor(s/3600),m=Math.floor(s%3600/60);return h?`${h}h ${String(m).padStart(2,'0')}m`:`${m}m ${String(s%60).padStart(2,'0')}s`;};
/** A task's running time, to now while it runs; empty before it starts. */
export const elapsed=(t:Pick<Task,'startedAt'|'finishedAt'>,now=Date.now())=>t.startedAt?duration((t.finishedAt?Date.parse(t.finishedAt):now)-Date.parse(t.startedAt)):'';
export const fmtTokens=(n:number)=>n<1000?String(n):n<1e6?`${(n/1e3).toFixed(n<1e4?1:0)}k`:`${(n/1e6).toFixed(2)}M`;
/** A task blocked on the user: a permission prompt, or a stop the run could not explain. A failed review is the orchestrator's to handle. */
export const needsYou=(t:Task)=>!t.hidden&&(t.state==='waiting'||t.state==='attention');
/** Re-render once a second while `on`, for clocks that run to now. */
export function useNow(on:boolean){const [now,setNow]=useState(Date.now());useEffect(()=>{if(!on)return;const t=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(t);},[on]);return now;}
