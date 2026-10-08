import { createServer, connect, type Server, type Socket } from 'node:net';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFile, execFileSync, type ChildProcess } from 'node:child_process';
import type { PaneConfig, SessionEvent } from '../shared/types';
import { validateId, validatePane } from '../shared/domain';
import { decodeHelperConfig, makeElevationLaunch, POWERSHELL, ProtocolDecoder, terminalSize, validateHelperPacket, type HelperConfig, type HelperPacket } from './runtime-core';
import { assertDirectory, type PtyFactory, type Terminal } from './terminals';

export function isAdministrator():boolean {
  const script='[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)';
  const output=execFileSync(POWERSHELL,['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,timeout:10000});return output.trim().toLowerCase()==='true';
}
const send=(socket:Socket,packet:HelperPacket)=>{if(!socket.destroyed)socket.write(JSON.stringify(packet)+'\n');};
interface AdminSession {server:Server;socket?:Socket;launcher?:ChildProcess;timer?:NodeJS.Timeout;authenticated:boolean;stopping:boolean;finish:(message:string,status:'error'|'exited')=>void}
export class ElevatedManager {
  private sessions=new Map<string,AdminSession>();
  constructor(private executable:string,private devAppPath:string|null,private emit:(event:SessionEvent)=>void){}
  has(id:string):boolean{return this.sessions.has(id);}
  async start(value:PaneConfig,cols:number,rows:number):Promise<void>{
    const pane=validatePane(value);if(pane.type!=='powershell-admin')throw new Error('Elevation is restricted to Admin PowerShell panes.');if(pane.command||pane.args.length)throw new Error('Admin PowerShell only accepts its built-in shell; custom elevated commands are disabled.');
    const size=terminalSize(cols,rows);await assertDirectory(pane.cwd);if(this.has(pane.id))return;
    const config:HelperConfig={paneId:pane.id,cwd:pane.cwd,...size,pipe:`\\\\.\\pipe\\alphacode-${randomUUID()}`,nonce:randomBytes(32).toString('hex'),shell:'powershell'};
    this.emit({paneId:pane.id,kind:'status',status:'starting',message:'Waiting for Windows elevation approval…',elevated:false});
    const server=createServer();const session:AdminSession={server,authenticated:false,stopping:false,finish:(message,status)=>{if(this.sessions.get(pane.id)!==session)return;this.sessions.delete(pane.id);if(session.timer)clearTimeout(session.timer);session.launcher?.kill();session.socket?.destroy();server.close();this.emit({paneId:pane.id,kind:'status',status,message,elevated:session.authenticated});}};this.sessions.set(pane.id,session);
    server.on('connection',socket=>{if(session.socket){socket.destroy();return;}session.socket=socket;const decoder=new ProtocolDecoder();socket.setEncoding('utf8');socket.on('data',chunk=>{try{for(const raw of decoder.push(String(chunk))){const packet=validateHelperPacket(raw);if(!session.authenticated){if(packet.kind!=='hello'||!packet.elevated||packet.nonce.length!==config.nonce.length||!timingSafeEqual(Buffer.from(packet.nonce),Buffer.from(config.nonce)))throw new Error('Elevated helper authentication failed.');session.authenticated=true;if(session.timer)clearTimeout(session.timer);this.emit({paneId:pane.id,kind:'status',status:'running',message:'Administrator PowerShell',elevated:true});continue;}if(packet.kind==='data')this.emit({paneId:pane.id,kind:'data',data:packet.data});else if(packet.kind==='exit')session.finish(`Admin PowerShell exited (${packet.exitCode}).`,'exited');else if(packet.kind==='error')session.finish(packet.message,'error');else throw new Error('Invalid helper response.');}}catch(error){session.finish((error as Error).message,'error');}});socket.on('error',error=>session.finish(`Elevated connection failed: ${error.message}`,'error'));socket.on('close',()=>session.finish(session.stopping?'Admin session stopped.':'Elevated helper disconnected.','exited'));});
    server.on('error',error=>session.finish(`Cannot open elevated session: ${error.message}`,'error'));
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(config.pipe,()=>{server.removeListener('error',reject);resolve();});});
    session.timer=setTimeout(()=>session.finish('Elevation timed out or was cancelled. Start the pane again to retry.','error'),60000);
    const launch=makeElevationLaunch(this.executable,this.devAppPath,Buffer.from(JSON.stringify(config)).toString('base64'));
    session.launcher=execFile(launch.file,launch.args,{windowsHide:true,timeout:70000},error=>{if(error)session.finish('Windows elevation was declined, cancelled, or could not start.','error');});
  }
  write(id:string,data:string):void{validateId(id);if(typeof data!=='string'||data.length>1048576)throw new Error('Terminal input is too large.');const session=this.sessions.get(id);if(session?.authenticated&&session.socket)send(session.socket,{kind:'input',data});}
  resize(id:string,cols:number,rows:number):void{validateId(id);const size=terminalSize(cols,rows);const session=this.sessions.get(id);if(session?.authenticated&&session.socket)send(session.socket,{kind:'resize',...size});}
  stop(id:string):void{validateId(id);const session=this.sessions.get(id);if(!session)return;session.stopping=true;if(session.socket&&session.authenticated){send(session.socket,{kind:'stop'});setTimeout(()=>session.finish('Admin session stopped.','exited'),1500).unref();}else session.finish('Elevation cancelled.','exited');}
  stopAll():void{for(const id of this.sessions.keys())this.stop(id);}
}

export async function runElevatedHelper(encoded:string,spawn:PtyFactory):Promise<void>{
  const config=decodeHelperConfig(encoded);if(!isAdministrator())throw new Error('The elevated helper did not receive an Administrator token.');await assertDirectory(config.cwd);
  const socket=connect(config.pipe);socket.setEncoding('utf8');const decoder=new ProtocolDecoder();let terminal:Terminal|undefined;let closed=false;
  const shutdown=()=>{if(closed)return;closed=true;try{terminal?.kill();}catch{}socket.destroy();setTimeout(()=>process.exit(0),50).unref();};
  const timeout=setTimeout(shutdown,10000);socket.on('error',shutdown);socket.on('close',shutdown);
  socket.on('connect',()=>{clearTimeout(timeout);send(socket,{kind:'hello',nonce:config.nonce,elevated:true});try{const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.ALPHACODE_DATA_DIR;terminal=spawn(POWERSHELL,['-NoLogo','-NoProfile'],{name:'xterm-256color',cols:config.cols,rows:config.rows,cwd:config.cwd,env,useConpty:true,useConptyDll:true});terminal.onData(data=>send(socket,{kind:'data',data}));terminal.onExit(({exitCode})=>{terminal=undefined;send(socket,{kind:'exit',exitCode});socket.end(shutdown);});}catch(error){send(socket,{kind:'error',message:(error as Error).message});socket.end(shutdown);}});
  socket.on('data',chunk=>{try{for(const raw of decoder.push(String(chunk))){const packet=validateHelperPacket(raw);if(packet.kind==='input')terminal?.write(packet.data);else if(packet.kind==='resize')terminal?.resize(packet.cols,packet.rows);else if(packet.kind==='stop')shutdown();else throw new Error('Invalid helper request.');}}catch{shutdown();}});
}
