import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { taskLabel } from '../shared/orchestrate';
import type { Task } from '../shared/types';
import { elapsed, needsYou, useNow } from './runFormat';

type Lane={paneId:string;label:string;role:string};
const LABEL_W=150,LANE_H=26,BAR_H=18,AXIS_H=22,NEXT_W=120,CHAR_W=6.4,PAD_R=12;
const STEPS=[1,2,5,10,15,30,60,120,240].map(m=>m*60000);
const tick=(ms:number)=>{const m=Math.round(ms/60000);return m<60?`${m}m`:`${Math.floor(m/60)}h${m%60?` ${String(m%60).padStart(2,'0')}m`:''}`;};
const fit=(text:string,px:number)=>{const n=Math.floor(px/CHAR_W);return n>=text.length?text:n>3?`${text.slice(0,n-1)}…`:'';};

/**
 * Who did what, when: one lane per agent in the run, the orchestrator first, on one clock that starts with the run.
 * A task is a bar from its start to its end (or to now). Only a task waiting on the user is amber; a planned task
 * is a dashed outline where it will run next; a review is tied to the task it reviews.
 */
export default function RunLanes({lanes,tasks,startedAt,approved,finished,focused,onFocus}: {lanes:Lane[];tasks:Task[];startedAt:number;approved:boolean;finished:string;focused:string;onFocus:(paneId:string)=>void}) {
  const host=useRef<HTMLDivElement>(null),[width,setWidth]=useState(800);
  useEffect(()=>{if(!host.current)return;const o=new ResizeObserver(([e])=>setWidth(Math.max(320,e.contentRect.width)));o.observe(host.current);return()=>o.disconnect();},[]);
  const active=!finished&&tasks.some(t=>t.state==='working'||t.state==='waiting'||t.state==='attention'),now=useNow(!finished);
  const started=tasks.filter(t=>t.startedAt&&t.state!=='planned');
  const t0=startedAt||Math.min(now,...started.map(t=>Date.parse(t.startedAt)));
  const ends=started.map(t=>t.finishedAt?Date.parse(t.finishedAt):now);
  // The clock runs to now while anything runs, else to the last finish; never shorter than a minute.
  const t1=Math.max(t0+60000,active||!ends.length?now:Math.max(...ends));
  const plotX=LABEL_W,plotW=width-LABEL_W-PAD_R-NEXT_W,x=(ms:number)=>plotX+Math.max(0,Math.min(1,(ms-t0)/(t1-t0)))*plotW;
  const step=STEPS.find(s=>(t1-t0)/s<=6)||STEPS[STEPS.length-1],ticks:number[]=[];for(let s=0;s<=t1-t0;s+=step)ticks.push(s);
  const height=AXIS_H+lanes.length*LANE_H+4,laneY=(paneId:string)=>AXIS_H+Math.max(0,lanes.findIndex(l=>l.paneId===paneId))*LANE_H;
  const key=(paneId:string)=>(e:KeyboardEvent)=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onFocus(paneId);}};
  const bars=started.map(t=>{const a=x(Date.parse(t.startedAt)),b=Math.max(a+3,x(t.finishedAt?Date.parse(t.finishedAt):now));return {t,a,b};});
  const phase=finished?'Completed':!tasks.length?'Planning':!approved?'Waiting for approval':'Coordinating';
  return <div className="run-lanes" ref={host}>
    <svg width={width} height={height} role="img" aria-label="Run timeline: tasks per agent over time">
      {ticks.map(s=><g key={s}><line className="lane-grid" x1={x(t0+s)} x2={x(t0+s)} y1={AXIS_H-6} y2={height}/><text className="lane-tick" x={x(t0+s)} y={12} textAnchor={s===0?'start':'middle'}>{tick(s)}</text></g>)}
      {active&&<g><line className="lane-now" x1={x(now)} x2={x(now)} y1={AXIS_H-6} y2={height}/><text className="lane-tick now" x={x(now)+4} y={12}>now</text></g>}
      {lanes.map((l,n)=>{const y=AXIS_H+n*LANE_H;return <g key={l.paneId} className={`lane${focused===l.paneId?' focused':''}`} role="button" tabIndex={0} aria-label={`Focus ${l.label}`} onClick={()=>onFocus(l.paneId)} onKeyDown={key(l.paneId)}>
        <rect className="lane-hit" x={0} y={y} width={width} height={LANE_H}/>
        <text className="lane-label" x={8} y={y+LANE_H/2+4}>{fit(l.label,LABEL_W-70)}</text>
        <text className="lane-role" x={LABEL_W-10} y={y+LANE_H/2+4} textAnchor="end">{l.role}</text>
        {n===0&&<g><line className="lane-track" x1={x(t0)} x2={x(finished?t1:now)} y1={y+LANE_H/2} y2={y+LANE_H/2}/><text className="lane-phase" x={x(finished?t1:now)+6} y={y+LANE_H/2+4}>{phase}</text></g>}
      </g>;})}
      {bars.filter(({t})=>t.reviews).map(({t,a})=>{const src=bars.find(b=>b.t.id===t.reviews);if(!src)return null;const y1=laneY(src.t.paneId)+LANE_H/2,y2=laneY(t.paneId)+LANE_H/2;return <path key={`link-${t.id}`} className="lane-link" d={`M${src.b} ${y1} H${Math.max(src.b+4,a-4)} V${y2} H${a}`}/>;})}
      {bars.map(({t,a,b})=>{const y=laneY(t.paneId)+(LANE_H-BAR_H)/2,cls=needsYou(t)?'needs-you':t.verdict==='fail'?'sent-back':t.state,mark=t.state==='done'?(t.verdict==='fail'?'✗ ':'✓ '):t.state==='failed'?'✗ ':needsYou(t)?'▲ ':'';
        const label=fit(`${mark}${t.title}`,b-a-10),last=!bars.some(o=>o.t.paneId===t.paneId&&o.a>a);
        return <g key={t.id} className={`lane-bar ${cls}`}><title>{`${t.title} · ${taskLabel(t)}${t.retries?` · retried ${t.retries}×`:''}${elapsed(t,now)?` · ${elapsed(t,now)}`:''}${t.message?`\n${t.message}`:''}`}</title>
          <rect x={a} y={y} width={b-a} height={BAR_H} rx={2}/>
          {label?<text x={a+5} y={y+BAR_H/2+4}>{label}</text>:last?<text className="after" x={b+5} y={y+BAR_H/2+4}>{fit(`${mark}${t.title}`,NEXT_W+plotX+plotW-b-10)}</text>:null}
        </g>;})}
      {tasks.filter(t=>t.state==='planned'||(t.state==='interrupted'&&!t.startedAt)).map(t=>{const y=laneY(t.paneId)+(LANE_H-BAR_H)/2,mine=bars.filter(o=>o.t.paneId===t.paneId),a=Math.min(plotX+plotW+4,Math.max(x(now),...mine.map(o=>o.b))+6);
        return <g key={`next-${t.id}`} className="lane-bar planned"><title>{`Next: ${t.title}`}</title><rect x={a} y={y} width={NEXT_W-8} height={BAR_H} rx={2}/><text x={a+5} y={y+BAR_H/2+4}>{fit(`Next: ${t.title}`,NEXT_W-18)}</text></g>;})}
    </svg>
  </div>;
}
