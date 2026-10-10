import { mkdir, readFile, writeFile, rename, copyFile } from 'node:fs/promises';
import { dirname, win32 } from 'node:path';
import type { AppState, ChatMessage } from '../shared/types';
import { string as str, validateId, validateState } from '../shared/domain';

export const POWERSHELL = win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const fail = (message: string): never => { throw new Error(message); };
const object = (value: unknown): Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : fail('Expected a configuration object.');
const integer = (value: unknown, min: number, max: number, name: string): number => Number.isInteger(value) && Number(value) >= min && Number(value) <= max ? Number(value) : fail(`Invalid ${name}.`);
const boolean = (value: unknown): boolean => typeof value === 'boolean' ? value : fail('Invalid boolean configuration.');
export const terminalSize = (cols: unknown, rows: unknown) => ({ cols: integer(cols, 2, 1000, 'terminal columns'), rows: integer(rows, 1, 500, 'terminal rows') });
export function validateMessages(value: unknown): ChatMessage[] {
  if(!Array.isArray(value)||value.length<1||value.length>1000)fail('Chat requires 1–1000 messages.');
  let size=0;return (value as unknown[]).map(v=>{const m=object(v);if(!['system','user','assistant'].includes(m.role))fail('Invalid chat role.');const content=str(m.content,'message',1048576);size+=content.length;if(size>2*1024*1024)fail('Conversation is too large.');return {role:m.role,content};});
}
/** Windows refuses to replace a file another handle has open (EPERM); readers such as editors, backups or the e2e poll are brief, so retry. */
const replace=async(from:string,to:string)=>{for(let i=0;;i++){try{return await rename(from,to);}catch(error){const code=(error as NodeJS.ErrnoException).code;if(i>=5||!["EPERM","EBUSY","EACCES"].includes(code||""))throw error;await new Promise(r=>setTimeout(r,25*(i+1)));}}};
export class StateStore {
  private writes:Promise<void>=Promise.resolve();
  private recoveryRequired=false;
  current:AppState|null=null;
  constructor(public path:string){}
  async load():Promise<AppState|null>{
    let invalid=false;
    for(const path of [this.path,this.path+'.bak']){try{const state=validateState(JSON.parse(await readFile(path,'utf8')));this.recoveryRequired=false;this.current=state;return state;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')invalid=true;}}
    if(invalid){this.recoveryRequired=true;throw new Error(`Saved workspace state is corrupt or invalid and no valid backup is available. Original files are preserved at ${this.path} and ${this.path}.bak. Move the invalid files aside, restart AlphaCode, then import a known-good workspace to recover.`);}
    this.recoveryRequired=false;
    return null;
  }
  save(value:unknown):Promise<void>{
    if(this.recoveryRequired)return Promise.reject(new Error('State recovery is required. Automatic saves are blocked to preserve the original invalid files. Move them aside and restart AlphaCode before saving.'));
    let state:AppState;try{state=validateState(value);}catch(error){return Promise.reject(error);}
    this.current=state;
    const next=this.writes.catch(()=>{}).then(async()=>{await mkdir(dirname(this.path),{recursive:true});const temporary=this.path+'.tmp';await writeFile(temporary,JSON.stringify(state,null,2),'utf8');try{validateState(JSON.parse(await readFile(this.path,'utf8')));await copyFile(this.path,this.path+'.bak');}catch{}await replace(temporary,this.path);});this.writes=next;return next;
  }
  /** Resolves once every save accepted so far has reached disk; quitting waits on this. */
  flush():Promise<void>{return this.writes.catch(()=>{});}
}
export function assertNormalToken(elevated:boolean):void {if(elevated)fail('AlphaCode must run without Administrator privileges. Close it and start it normally; elevate only the Admin PowerShell pane.');}
export interface HelperConfig {paneId:string;cwd:string;cols:number;rows:number;pipe:string;nonce:string;shell:'powershell'}
export function decodeHelperConfig(encoded:string):HelperConfig {
  if(encoded.length>100000||!/^[A-Za-z0-9+/=]+$/.test(encoded))fail('Invalid helper configuration.');
  const c=object(JSON.parse(Buffer.from(encoded,'base64').toString('utf8')));
  if(c.shell!=='powershell'||!/^\\\\\.\\pipe\\alphacode-[A-Za-z0-9-]+$/.test(c.pipe)||!/^[a-f0-9]{64}$/.test(c.nonce)||Object.keys(c).some(k=>!['paneId','cwd','cols','rows','pipe','nonce','shell'].includes(k)))fail('Helper accepts only authenticated PowerShell configuration.');
  return {paneId:validateId(c.paneId),cwd:str(c.cwd,'helper working directory',32768),...terminalSize(c.cols,c.rows),pipe:c.pipe,nonce:c.nonce,shell:'powershell'};
}
export function makeElevationLaunch(executable:string, appPath:string|null, encoded:string):{file:string;args:string[]} {
  if(!/^[A-Za-z0-9+/=]+$/.test(encoded))fail('Invalid encoded helper argument.');
  const quote=(s:string)=>`'${s.replace(/'/g,"''")}'`;
  // Windows argv requires quotes around paths; PowerShell quotes preserve them in ArgumentList.
  const helperArgs=[...(appPath?[`"${appPath}"`]:[]),'--alphacode-admin-helper',encoded].join(' ');
  const script=`$ErrorActionPreference='Stop'; Start-Process -FilePath ${quote(executable)} -ArgumentList ${quote(helperArgs)} -Verb RunAs -WindowStyle Hidden`;
  return {file:POWERSHELL,args:['-NoProfile','-NonInteractive','-Command',script]};
}
export type HelperPacket = {kind:'hello';nonce:string; elevated:boolean}|{kind:'data';data:string}|{kind:'input';data:string}|{kind:'resize';cols:number;rows:number}|{kind:'exit';exitCode:number}|{kind:'stop'}|{kind:'error';message:string};
export function validateHelperPacket(value:unknown):HelperPacket {
  const p=object(value);switch(p.kind){case 'hello':return {kind:'hello',nonce:str(p.nonce,'nonce',128),elevated:boolean(p.elevated)};case 'data':case 'input':return {kind:p.kind,data:str(p.data,'terminal data',1048576)};case 'resize':return {kind:'resize',...terminalSize(p.cols,p.rows)};case 'exit':return {kind:'exit',exitCode:integer(p.exitCode,-2147483648,2147483647,'exit code')};case 'stop':return {kind:'stop'};case 'error':return {kind:'error',message:str(p.message,'helper error',8192)};default:return fail('Unknown helper packet.');}
}
export class ProtocolDecoder {private buffer='';push(chunk:string):unknown[]{this.buffer+=chunk;if(Buffer.byteLength(this.buffer)>1048576)fail('Helper packet exceeds the size limit.');const result:unknown[]=[];let idx;while((idx=this.buffer.indexOf('\n'))>=0){const line=this.buffer.slice(0,idx);this.buffer=this.buffer.slice(idx+1);if(line)result.push(JSON.parse(line));}return result;}}
