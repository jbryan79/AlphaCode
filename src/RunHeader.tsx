import { Check, LifeBuoy, Square } from 'lucide-react';
import { taskLabel } from '../shared/orchestrate';
import type { Task } from '../shared/types';
import { duration, needsYou, useNow } from './runFormat';

/**
 * The run's title row. It answers "does anything need me, and how far along is it" in one sentence,
 * and carries the one action that sentence calls for: approve the plan, or answer the agent that is waiting.
 */
export default function RunHeader({name,tasks,approved,finished,startedAt,paneTitle,onApprove,onAnswer,onStop,onHelp}: {name:string;tasks:Task[];approved:boolean;finished:string;startedAt:number;paneTitle:(paneId:string)=>string;onApprove:()=>void;onAnswer:(paneId:string)=>void;onStop:()=>void;onHelp:()=>void}) {
  const now=useNow(!finished);
  const live=tasks,done=tasks.filter(t=>t.state==='done').length,working=tasks.filter(t=>t.state==='working').length;
  // The earliest-started task that is blocked on the user leads.
  const blocked=tasks.filter(needsYou).sort((a,b)=>(a.startedAt||'').localeCompare(b.startedAt||''))[0];
  const workers=new Set(tasks.map(t=>t.paneId)).size,plural=(n:number,s:string)=>`${n} ${s}${n===1?'':'s'}`;
  const left=tasks.filter(t=>t.state!=='done').length;
  const line=finished?`Completed: ${finished}${left?` ${plural(left,'task')} did not finish; see the task list.`:''}`
    :!tasks.length?'Waiting for a plan from the orchestrator.'
    :!approved?`Plan ready: ${plural(tasks.length,'task')} across ${plural(workers,'worker')}. Nothing starts until you approve it.`
    :blocked?`${paneTitle(blocked.paneId)} needs you: ${blocked.message||taskLabel(blocked)} on “${blocked.title}”.`
    :working?`${plural(working,'task')} working. Nothing needs you.`
    :done===live.length?`All ${plural(done,'task')} done. The orchestrator reviews and merges.`
    :'Between tasks. The orchestrator assigns the next one.';
  const action=!finished&&tasks.length>0&&!approved?<button className="primary" onClick={onApprove}><Check size={14}/>Approve plan</button>
    :!finished&&blocked?<button className="primary" onClick={()=>onAnswer(blocked.paneId)}><span className="answer-dot"/>Answer {paneTitle(blocked.paneId)}</button>:null;
  return <section className={`run-header${blocked&&approved&&!finished?' needs-you':''}`} aria-label="Orchestrate run">
    <div className="run-title"><h1>{name}</h1><p>{line}</p></div>
    <dl className="run-figures">
      <div><dt>Elapsed</dt><dd>{startedAt?duration(now-startedAt):'—'}</dd></div>
      <div><dt>Done</dt><dd>{done}<span>/{live.length}</span></dd></div>
    </dl>
    <div className="run-actions">{action}<button className="ghost" title="Send this run's state to the Support agent and ask it what went wrong" onClick={onHelp}><LifeBuoy size={12}/>Ask Support</button><button className="ghost" onClick={onStop}><Square size={12}/>Stop run</button></div>
  </section>;
}
