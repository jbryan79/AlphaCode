import { taskLabel } from '../shared/orchestrate';
import type { Task } from '../shared/types';

export interface RunSnapshot { workspace: string; root: string; on: boolean; approved: boolean; finished: string; tasks: Task[]; errors: string[]; statePath: string; }

/** Pane ids for the two sessions that live outside every workspace. */
export const CHAT_PANE_ID='multimodel-chat',SUPPORT_PANE_ID='multimodel-support';

// A pane argument is capped at 4096 characters (validatePane); stay clear of it.
const LIMIT=3800;
const clean=(s:string)=>s.replace(/[\x00-\x1f\x7f]+/g,' ').replace(/\s{2,}/g,' ').trim();

/**
 * The message Ask for help hands the Support agent: one line, because it is either typed into a live
 * Claude session (a newline would submit early) or passed as the first prompt of a new one.
 */
export function supportPrompt(r: RunSnapshot): string {
  const dataDir=r.statePath.replace(/[\\/][^\\/]+$/,'');
  const run=!r.on?(r.finished?`finished: ${r.finished}`:'stopped'):r.finished?`completed: ${r.finished}`:r.approved?'running, plan approved':'running, plan not yet approved';
  const tasks=r.tasks.length?r.tasks.map(t=>`${t.id} "${t.title}" ${taskLabel(t)} (${t.model}${t.retries?`, retried ${t.retries}x`:''}${t.branch?`, branch ${t.branch}`:''})${t.message?`: ${t.message.slice(0,200)}`:''}`).join('; '):'none';
  const head=`[Multimodel support] My Orchestrate run needs help. Workspace "${r.workspace}", project ${r.root||'unknown'}. Run: ${run}. Tasks: ${tasks}.`;
  const errors=r.errors.length?` Recent app errors: ${r.errors.slice(-5).map(e=>e.slice(0,240)).join(' | ')}.`:'';
  const tail=` App data: ${dataDir} (state.json, orchestrate\\<run id>\\ holds each run's plan, hooks and playbook). You are in the Multimodel source; read it to find the cause. Explain what went wrong and how to recover the run. Do not change files in the orchestrated project unless I ask.`;
  return clean(head+errors).slice(0,LIMIT-tail.length)+tail;
}
