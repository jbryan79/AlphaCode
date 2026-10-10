import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const USAGE = `usage: alphacode <command>
  panes                                   list panes with roles and task states
  plan <plan.json> [--approved]           post the task split (prompt files resolve next to the plan)
  task start <id>                         launch the worker for a task
  task status [id]                        state, elapsed seconds, branch, last lines
  task wait [id ...] [--timeout <s>]      block until a listed task changes (max 240 s)
  task retry <id> <feedback.md>           send feedback to the worker, keeping its context
  ask <paneId> <prompt.md>                ask a Local Model (advisor) pane
  finish <report.md>                      mark the run done, toast, vault note
  report done|failed|stop|waiting [msg]   worker only: report this pane's own status`;

async function stdinJson(stdin: NodeJS.ReadableStream | null): Promise<any> {
  if (!stdin || (stdin as any).isTTY) return {};
  const text = await Promise.race([new Promise<string>(r => { let s = ''; stdin.on('data', c => { s += c; }); stdin.on('end', () => r(s)); stdin.on('error', () => r(s)); }), new Promise<string>(r => setTimeout(() => { stdin.pause(); r(''); }, 300))]);
  try { return text.trim() ? JSON.parse(text) : {}; } catch { return {}; }
}
const text = async (file: string, max: number) => { const t = await readFile(resolve(file), 'utf8'); if (t.length > max) throw new Error(`${file} exceeds ${max} characters`); return t; };

export async function main(argv: string[], env: NodeJS.ProcessEnv, stdin: NodeJS.ReadableStream | null): Promise<{ code: number; out: string; err: string }> {
  const [cmd, ...rest] = argv; const flag = (name: string) => { const i = rest.indexOf(name); return i >= 0 ? rest.splice(i, 2)[1] : undefined; }; const has = (name: string) => { const i = rest.indexOf(name); if (i >= 0) rest.splice(i, 1); return i >= 0; };
  try {
    if (cmd === 'report') {
      const url = env.ALPHACODE_CONTROL_URL, token = env.ALPHACODE_HOOK_TOKEN, paneId = env.ALPHACODE_PANE_ID; if (!token || !paneId) throw new Error('report runs only inside a worker pane (ALPHACODE_HOOK_TOKEN and ALPHACODE_PANE_ID are set there)');
      const [kind, ...msg] = rest; if (!['done', 'failed', 'stop', 'waiting'].includes(kind || '')) throw new Error(USAGE);
      const input = await stdinJson(stdin);
      return await send(url || '', token, 'POST', '/report', { paneId, kind, message: msg.join(' '), notificationType: input.notification_type });
    }
    const url = env.ALPHACODE_CONTROL_URL, token = env.ALPHACODE_CONTROL_TOKEN; if (!url || !token) throw new Error('ALPHACODE_CONTROL_URL and ALPHACODE_CONTROL_TOKEN are missing; alphacode runs inside the orchestrator pane');
    const api = (method: string, path: string, body?: unknown) => send(url, token, method, path, body);
    switch (cmd) {
      case 'panes': return await api('GET', '/panes');
      case 'plan': { const approved = has('--approved'); const file = rest[0]; if (!file) throw new Error(USAGE); const plan = JSON.parse(await text(file, 1048576)); const base = dirname(resolve(file));
        if (Array.isArray(plan.tasks)) for (const t of plan.tasks) if (typeof t?.prompt === 'string' && /\.md$/i.test(t.prompt)) t.prompt = await text(resolve(base, t.prompt), 65536);
        return await api('POST', '/plan', { ...plan, approved }); }
      case 'task': { const [sub, ...a] = rest;
        if (sub === 'start' && a[0]) return await api('POST', `/tasks/${a[0]}/start`);
        if (sub === 'status') return await api('GET', a[0] ? `/tasks/${a[0]}` : '/tasks');
        if (sub === 'wait') { const timeout = flag('--timeout'); return await api('GET', `/tasks/wait?ids=${encodeURIComponent(rest.slice(1).join(','))}&timeout=${encodeURIComponent(timeout || '240')}`); }
        if (sub === 'retry' && a[0] && a[1]) return await api('POST', `/tasks/${a[0]}/retry`, { feedback: await text(a[1], 65536) });
        throw new Error(USAGE); }
      case 'ask': if (rest[0] && rest[1]) return await api('POST', `/ask/${rest[0]}`, { prompt: await text(rest[1], 262144) }); throw new Error(USAGE);
      case 'finish': if (rest[0]) return await api('POST', '/finish', { report: await text(rest[0], 1048576) }); throw new Error(USAGE);
      default: throw new Error(USAGE);
    }
  } catch (error) { return { code: 1, out: '', err: (error as Error).message }; }
}
async function send(url: string, token: string, method: string, path: string, body?: unknown): Promise<{ code: number; out: string; err: string }> {
  if (!url) throw new Error('ALPHACODE_CONTROL_URL is missing');
  const r = await fetch(url.replace(/\/$/, '') + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  return r.ok ? { code: 0, out: JSON.stringify(data, null, 2), err: '' } : { code: 1, out: '', err: `${r.status}: ${(data as any).error || 'request failed'}` };
}
if (require.main === module) void main(process.argv.slice(2), process.env, process.stdin).then(r => { if (r.out) process.stdout.write(r.out + '\n'); if (r.err) process.stderr.write(r.err + '\n'); process.exitCode = r.code; });
