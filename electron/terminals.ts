import { existsSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join, win32 } from 'node:path';
import type { PaneConfig, SessionEvent } from '../shared/types';
import { validateId, validatePane } from '../shared/domain';
import { POWERSHELL, terminalSize } from './runtime-core';

export interface Terminal {pid:number;write(data:string):void;resize(cols:number,rows:number):void;kill():void;onData(callback:(data:string)=>void):{dispose():void};onExit(callback:(event:{exitCode:number;signal?:number})=>void):{dispose():void}}
export type PtyFactory=(file:string,args:string[],options:{name:string;cols:number;rows:number;cwd:string;env:NodeJS.ProcessEnv;useConpty:boolean;useConptyDll:boolean})=>Terminal;
export interface LaunchOverrides {env?:Record<string,string>;args?:string[];cwd?:string}
export function resolveExecutable(pane:PaneConfig):string {
  const defaults:Partial<Record<PaneConfig['type'],string>>={powershell:POWERSHELL,claude:'claude',codex:'codex',gemini:'gemini',wsl:'wsl.exe',cmd:process.env.ComSpec||'cmd.exe','git-bash':'C:\\Program Files\\Git\\bin\\bash.exe'};
  const requested=pane.command.trim()||defaults[pane.type];
  if(!requested)throw new Error('Configure an executable path before starting this pane.');
  if(pane.type==='claude'&&!pane.command.trim()){const installed=join(process.env.USERPROFILE||'', '.local','bin','claude.exe');if(existsSync(installed))return installed;}
  if(win32.isAbsolute(requested)){if(!existsSync(requested))throw new Error(`Executable was not found: ${requested}`);return requested;}
  try {return execFileSync('where.exe',[requested],{encoding:'utf8',windowsHide:true,timeout:5000}).split(/\r?\n/).map(path=>path.trim()).find(path=>path&&/[.](exe|cmd|bat|com)$/i.test(path)&&existsSync(path))?.trim()||missing(requested);}catch{throw new Error(`Cannot find ${requested}. Install the CLI, add it to PATH, or set its full executable path in pane configuration.`);}
}
const missing=(command:string):never=>{throw new Error(`Cannot find executable: ${command}`);};
export function executableLaunch(file:string,args:string[]):{file:string;args:string[]}{
  if(!/\.(cmd|bat)$/i.test(file))return {file,args};
  // npm CLI shims require a shell on Windows. Literal PowerShell arguments avoid
  // treating saved CLI arguments as PowerShell expressions or shell operators.
  const literal=(value:string)=>`'${value.replace(/'/g,"''")}'`;
  return {file:POWERSHELL,args:['-NoLogo','-NoProfile','-Command',`& ${literal(file)} ${args.map(literal).join(' ')}; exit $LASTEXITCODE`]};
}
// ponytail: node-pty 1.1.0's ConPTY kill walks an unlocked ptyHandles vector while each terminal's exit thread
// erases from it, so two kills within ~1ms segfault the main process. Space kills out; drop once upstream locks it.
let kills=Promise.resolve();
const queueKill=(terminal:Terminal):Promise<void>=>kills=kills.then(()=>{try{terminal.kill();}catch{}return new Promise<void>(resolve=>setTimeout(resolve,50));});
/** Tokens every assistant turn in a slice of a Claude Code transcript consumed: input, cache writes, cache reads and output. Lines that are not assistant JSON are skipped. */
export function transcriptTokens(lines:string):number{let n=0;for(const line of lines.split('\n')){if(!line.includes('"usage"'))continue;try{const u=JSON.parse(line)?.message?.usage;if(u)n+=(u.input_tokens||0)+(u.cache_creation_input_tokens||0)+(u.cache_read_input_tokens||0)+(u.output_tokens||0);}catch{}}return n;}
/** Where Claude Code writes the transcript for a session started in `cwd`: ~/.claude/projects/<cwd with every non-alphanumeric as ->/<id>.jsonl. */
export const transcriptPath=(cwd:string,id:string):string=>join(process.env.CLAUDE_CONFIG_DIR||join(homedir(),'.claude'),'projects',cwd.replace(/[^A-Za-z0-9]/g,'-'),`${id}.jsonl`);
export async function assertDirectory(cwd:string):Promise<void>{try{if(!(await stat(cwd)).isDirectory())throw new Error();}catch{throw new Error(`Working directory does not exist: ${cwd}. Choose an existing directory in pane configuration.`);}}
export class TerminalManager {
  private sessions=new Map<string,{terminal:Terminal;subscriptions:{dispose():void}[]}>();
  private pending=new Map<string,symbol>();
  constructor(private spawn:PtyFactory,private emit:(event:SessionEvent)=>void,private resolve:(pane:PaneConfig)=>string=resolveExecutable){}
  has(paneId:string):boolean{return this.sessions.has(paneId)||this.pending.has(paneId);}
  async start(value:PaneConfig,cols:number,rows:number,overrides:LaunchOverrides={}):Promise<void>{
    const pane=validatePane(value);const size=terminalSize(cols,rows);const cwd=overrides.cwd||pane.cwd;
    if(pane.type==='powershell-admin')throw new Error('Admin PowerShell requires the dedicated elevated helper.');
    if(pane.type==='local-model')throw new Error('Local model panes use the chat interface.');
    if(this.has(pane.id))return;const token=Symbol(pane.id);this.pending.set(pane.id,token);this.emit({paneId:pane.id,kind:'status',status:'starting'});
    try{await assertDirectory(cwd);if(this.pending.get(pane.id)!==token)return;const file=this.resolve(pane);const env:NodeJS.ProcessEnv={...process.env};for(const k of Object.keys(overrides.env||{}))for(const e of Object.keys(env))if(e!==k&&e.toLowerCase()===k.toLowerCase())delete env[e];Object.assign(env,overrides.env);delete env.ELECTRON_RUN_AS_NODE;delete env.CLAUDE_CODE_CHILD_SESSION;delete env.ALPHACODE_DATA_DIR;
      const args=[...(pane.args.length?pane.args:(pane.type==='powershell'?['-NoLogo','-NoProfile']:[])),...(overrides.args||[])];
      // A Claude pane gets a session id we chose (unless the caller named or resumed one), so its transcript can be found and its token total read.
      let transcript='';if(pane.type==='claude'){const i=args.indexOf('--session-id'),r=args.indexOf('--resume');let id=i>=0?args[i+1]||'':r>=0?args[r+1]||'':'';if(id.startsWith('-'))id='';if(!id&&r<0){id=randomUUID();args.push('--session-id',id);}const w=args.indexOf('--worktree');if(id)transcript=transcriptPath(w>=0&&args[w+1]?join(cwd,'.claude','worktrees',args[w+1]):cwd,id);}
      const launch=executableLaunch(file,args);const terminal=this.spawn(launch.file,launch.args,{name:'xterm-256color',...size,cwd,env,useConpty:true,useConptyDll:true});const session={terminal,subscriptions:[] as {dispose():void}[]};this.sessions.set(pane.id,session);
      if(transcript){let offset=0,total=0,rest:Buffer=Buffer.alloc(0);const tick=async()=>{try{const s=await stat(transcript);if(s.size<=offset)return;const fh=await open(transcript,'r');let chunk:Buffer;try{const buf=Buffer.alloc(s.size-offset);await fh.read(buf,0,buf.length,offset);offset=s.size;chunk=Buffer.concat([rest,buf]);}finally{await fh.close();}
        const cut=chunk.lastIndexOf(10);if(cut<0){rest=chunk;return;}total+=transcriptTokens(chunk.subarray(0,cut+1).toString('utf8'));rest=Buffer.from(chunk.subarray(cut+1));if(this.sessions.get(pane.id)===session)this.emit({paneId:pane.id,kind:'tokens',tokens:total});}catch{}};
        const timer=setInterval(()=>void tick(),5000);session.subscriptions.push({dispose:()=>clearInterval(timer)});}
      session.subscriptions.push(terminal.onData(data=>this.emit({paneId:pane.id,kind:'data',data})),terminal.onExit(({exitCode})=>{if(this.sessions.get(pane.id)!==session)return;this.sessions.delete(pane.id);for(const subscription of session.subscriptions)subscription.dispose();this.emit({paneId:pane.id,kind:'status',status:'exited',message:`Process exited (${exitCode}).`});}));
      this.emit({paneId:pane.id,kind:'status',status:'running',pid:terminal.pid,elevated:false});
    }catch(error){if(this.pending.get(pane.id)===token)this.emit({paneId:pane.id,kind:'status',status:'error',message:(error as Error).message});throw error;}finally{if(this.pending.get(pane.id)===token)this.pending.delete(pane.id);}
  }
  write(paneId:string,data:string):void{validateId(paneId);if(typeof data!=='string'||data.length>1048576)throw new Error('Terminal input is too large.');this.sessions.get(paneId)?.terminal.write(data);}
  resize(paneId:string,cols:number,rows:number):void{validateId(paneId);const size=terminalSize(cols,rows);this.sessions.get(paneId)?.terminal.resize(size.cols,size.rows);}
  stop(paneId:string):void{validateId(paneId);this.pending.delete(paneId);const session=this.sessions.get(paneId);if(session){this.sessions.delete(paneId);for(const subscription of session.subscriptions)subscription.dispose();void queueKill(session.terminal);}this.emit({paneId,kind:'status',status:'exited',message:'Session stopped.'});}
  stopAll():Promise<void>{for(const id of new Set([...this.pending.keys(),...this.sessions.keys()]))this.stop(id);return kills;}
}
