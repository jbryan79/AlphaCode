// Explicit isolated verification entrypoint; never loaded by the desktop app.
import { app } from 'electron';
import { spawn } from 'node-pty';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PaneConfig, SessionEvent } from '../shared/types';
import { TerminalManager, resolveExecutable } from './terminals';
import { isAdministrator } from './elevated';

const events:SessionEvent[]=[];
const manager=new TerminalManager(spawn,event=>events.push(event));
const text=(id:string)=>events.filter(e=>e.paneId===id&&e.kind==='data').map(e=>e.data||'').join('');
async function wait(predicate:()=>boolean,label:string):Promise<void>{
  const deadline=Date.now()+15000;
  while(!predicate()){if(Date.now()>deadline)throw new Error(`${label} timed out.`);await new Promise(resolve=>setTimeout(resolve,100));}
}
async function smoke():Promise<void>{
  if(isAdministrator())throw new Error('The smoke must use a normal token.');
  const directory=await mkdtemp(join(tmpdir(),'alphacode-native-'));
  try{
    const cwdA=join(directory,'a'),cwdB=join(directory,'b');await Promise.all([mkdir(cwdA),mkdir(cwdB)]);
    const pane:PaneConfig={id:'smoke-a',type:'powershell',title:'Smoke A',cwd:cwdA,command:'',args:[],profileId:'',autoStart:false};
    const second={...pane,id:'smoke-b',title:'Smoke B',cwd:cwdB};
    await manager.start(pane,80,24);await manager.start(second,80,24);
    manager.write(pane.id,"Write-Output ('OUTPUT_' + 'A'); (Get-Location).Path\r");
    manager.write(second.id,"Write-Output ('OUTPUT_' + 'B'); (Get-Location).Path\r");
    await wait(()=>text(pane.id).includes('OUTPUT_A')&&text(pane.id).includes(cwdA)&&text(second.id).includes('OUTPUT_B')&&text(second.id).includes(cwdB),'independent output and cwd');
    if(text(pane.id).includes('OUTPUT_B')||text(second.id).includes('OUTPUT_A'))throw new Error('Terminal output crossed pane boundaries.');
    manager.resize(pane.id,100,30);manager.write(pane.id,"Write-Output ('RESIZED_' + $Host.UI.RawUI.WindowSize.Width + 'x' + $Host.UI.RawUI.WindowSize.Height)\r");
    await wait(()=>text(pane.id).includes('RESIZED_100x30'),'resize');
    for(const id of [pane.id,second.id]){const pid=events.find(e=>e.paneId===id&&e.status==='running')?.pid;if(!pid)throw new Error('Missing terminal PID.');manager.stop(id);await wait(()=>{try{process.kill(pid,0);return false;}catch{return true;}},'stopped PowerShell process');}
    // node-pty's ConPTY kill races its own exit thread when several terminals die at once (segfault). Stop a batch in one call, repeatedly.
    for(let round=0;round<5;round++){
      const batch=Array.from({length:6},(_,n)=>({...pane,id:`smoke-batch-${round}-${n}`,cwd:directory}));
      for(const p of batch)await manager.start(p,80,24);
      for(const p of batch)manager.write(p.id,`Write-Output ('UP_' + '${p.id}')\r`);
      await wait(()=>batch.every(p=>text(p.id).includes(`UP_${p.id}`)),'batch shells up');
      await manager.stopAll();
      await wait(()=>batch.every(p=>{const pid=events.find(e=>e.paneId===p.id&&e.status==='running')?.pid;try{process.kill(pid!,0);return false;}catch{return true;}}),'batch processes gone');
    }
    const claude={...pane,id:'smoke-claude',type:'claude' as const,args:['--version']};const path=resolveExecutable(claude);await manager.start(claude,80,24);
    await wait(()=>events.some(e=>e.paneId===claude.id&&e.status==='exited'),'Claude --version exit');if(!text(claude.id).includes('Claude Code'))throw new Error('Claude version invocation did not return expected output.');
    console.log(JSON.stringify({result:'NATIVE_SMOKE_PASS',electron:process.versions.electron,claudeExecutable:path,claudeVersion:text(claude.id).match(/\d+\.\d+\.\d+ \(Claude Code\)/)?.[0],checks:['normal token','separate PowerShell cwd and output','input','resize 100x30','stop and process disappearance','5 rounds of 6 terminals stopped at once','Claude --version only','application clean quit']}));
  }finally{await manager.stopAll();await rm(directory,{recursive:true,force:true});}
}
app.whenReady().then(smoke).then(()=>app.quit()).catch(error=>{console.error('NATIVE_SMOKE_FAIL:',error);manager.stopAll().finally(()=>app.exit(1));});
