import { describe, expect, it } from 'vitest';
import { mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { validatePane, validateState, validateProfile } from '../shared/domain';
import { StateStore, decodeHelperConfig, makeElevationLaunch, ProtocolDecoder, validateHelperPacket, assertNormalToken } from '../electron/runtime-core';
import { ProviderClient } from '../electron/providers';
import { TerminalManager, executableLaunch } from '../electron/terminals';

const pane = { id:'p1',type:'powershell' as const,title:'PowerShell',cwd:'D:\\Dev',command:'',args:[],profileId:'',color:'' as const,autoStart:true };
const workspace = { id:'w1',name:'Main',root:'D:\\Dev',panes:[pane],layout:[{i:'p1',x:0,y:0,w:6,h:3,minW:3,minH:3}],locked:false };
const state = { version:1 as const,activeWorkspaceId:'w1',workspaces:[workspace],profiles:[] };
const profile = { id:'local',name:'Local',provider:'ollama' as const,endpoint:'http://127.0.0.1:11434',model:'test',systemPrompt:'Be helpful',contextSize:4096,temperature:0.4 };

describe('runtime trust boundaries', () => {
  it('validates independent pane IDs and rejects malformed state', () => {
    expect(validatePane(pane)).toEqual(pane);
    expect(validateState(state)).toEqual(state);
    expect(() => validatePane({...pane,id:'../escape'})).toThrow();
    expect(() => validateState({...state,workspaces:[{...workspace,panes:[pane,pane]}]})).toThrow();
    expect(() => validateState({...state,activeWorkspaceId:'missing'})).toThrow();
    expect(() => validateState({...state,workspaces:[{...workspace,layout:[{...workspace.layout[0],i:'missing'}]}]})).toThrow();
  });
  it('permits only explicit loopback provider hosts', () => {
    for (const endpoint of ['http://127.0.0.1:8080','http://localhost:8080','http://[::1]:8080']) expect(validateProfile({...profile,endpoint}).endpoint).toBe(endpoint);
    for (const endpoint of ['http://evil.example','http://127.0.0.1.evil.example','http://192.168.1.2','file:///tmp','http://user:pass@localhost']) expect(() => validateProfile({...profile,endpoint})).toThrow();
  });
  it('rejects elevated application tokens and arbitrary helper commands', () => {
    expect(() => assertNormalToken(true)).toThrow(/Administrator/);
    expect(() => assertNormalToken(false)).not.toThrow();
    const encode = (data:unknown) => Buffer.from(JSON.stringify(data)).toString('base64');
    expect(decodeHelperConfig(encode({paneId:'p1',cwd:'D:\\Dev',cols:80,rows:24,pipe:'\\\\.\\pipe\\alphacode-test',nonce:'a'.repeat(64),shell:'powershell'})).shell).toBe('powershell');
    expect(() => decodeHelperConfig(encode({command:'cmd.exe'}))).toThrow();
  });
  it('uses the same Electron executable and an encoded helper argument for UAC', () => {
    const launch = makeElevationLaunch('C:\\Program Files\\AlphaCode\\AlphaCode.exe',null,'YWJj');
    expect(launch.file).toMatch(/powershell\.exe$/);
    expect(launch.args.join(' ')).toContain('-Verb RunAs');
    expect(launch.args.join(' ')).toContain('-WindowStyle Hidden');
    expect(launch.args.join(' ')).toContain('--alphacode-admin-helper');
    const dev = makeElevationLaunch('C:\\node_modules\\electron.exe',"D:\\Dev\\app's folder",'YWJj');
    expect(dev.args.join(' ')).toContain("app''s folder");
  });
  it('decodes fragmented authenticated helper protocol and bounds packets', () => {
    const parser = new ProtocolDecoder();
    expect(parser.push('{"kind":"hello",')).toEqual([]);
    expect(parser.push('"nonce":"abc"}\n{"kind":"data","data":"hi"}\n')).toEqual([{kind:'hello',nonce:'abc'},{kind:'data',data:'hi'}]);
    expect(() => new ProtocolDecoder().push('x'.repeat(1024*1024+1))).toThrow();
    expect(() => validateHelperPacket({kind:'resize',cols:-1,rows:24})).toThrow();
    expect(() => validateHelperPacket({kind:'execute',command:'bad'})).toThrow();
  });
  it('writes validated atomic state with a recoverable backup', async () => {
    const path = join(await mkdtemp(join(tmpdir(),'alphacode-')), 'state.json');
    const store = new StateStore(path);
    expect(await store.load()).toBeNull();
    await store.save(state);
    await store.save({...state,workspaces:[{...workspace,name:'Updated'}]});
    expect(JSON.parse(await readFile(path+'.bak','utf8')).workspaces[0].name).toBe('Main');
    await writeFile(path,'corrupt');
    expect((await store.load())?.workspaces[0].name).toBe('Main');
    await expect(store.save({...state,version:2} as any)).rejects.toThrow();
  });
  it('saves while another process holds the state file open for reading',async()=>{
    const path=join(await mkdtemp(join(tmpdir(),'alphacode-busy-')),'state.json');const store=new StateStore(path);await store.save(state);
    const handle=await open(path,'r');setTimeout(()=>handle.close(),60);
    await store.save({...state,workspaces:[{...workspace,name:'Busy'}]});
    expect(JSON.parse(await readFile(path,'utf8')).workspaces[0].name).toBe('Busy');
  });
  it('saves and reloads an intentionally empty workspace',async()=>{
    const path=join(await mkdtemp(join(tmpdir(),'alphacode-empty-')),'state.json');const store=new StateStore(path);
    const empty={...state,workspaces:[{...workspace,panes:[],layout:[]}]};await store.save(empty);expect(await store.load()).toEqual(empty);
  });
  it('reports corruption and preserves both original files against autosave',async()=>{
    const path=join(await mkdtemp(join(tmpdir(),'alphacode-corrupt-')),'state.json');await writeFile(path,'primary-corrupt');await writeFile(path+'.bak','backup-corrupt');const store=new StateStore(path);
    await expect(store.load()).rejects.toThrow(/invalid|corrupt/i);await expect(store.save(state)).rejects.toThrow(/preserv|recover/i);
    expect(await readFile(path,'utf8')).toBe('primary-corrupt');expect(await readFile(path+'.bak','utf8')).toBe('backup-corrupt');
  });
});

describe('local model sessions', () => {
  it('discovers and chats through separate Ollama/LM Studio payloads', async () => {
    const seen:any[]=[];
    const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;seen.push({url:req.url,body:body?JSON.parse(body):null});res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url==='/api/tags'?{models:[{name:'test'}]}:req.url==='/v1/models'?{data:[{id:'lm'}]}:req.url==='/api/chat'?{message:{content:'ollama answer'}}:{choices:[{message:{content:'lm answer'}}]}));});
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const endpoint=`http://127.0.0.1:${(server.address() as any).port}`;
    const client=new ProviderClient(1000);
    try {
      expect(await client.listModels({...profile,endpoint})).toEqual(['test']);
      expect(await client.chat('p1',{...profile,endpoint},[{role:'user',content:'one'}])).toBe('ollama answer');
      expect(await client.listModels({...profile,endpoint,provider:'lmstudio'})).toEqual(['lm']);
      expect(await client.chat('p2',{...profile,endpoint,provider:'lmstudio'},[{role:'user',content:'two'}])).toBe('lm answer');
      expect(seen[1].body.options.num_ctx).toBe(4096);
      expect(seen[1].body.messages).toEqual([{role:'system',content:'Be helpful'},{role:'user',content:'one'}]);
      expect(seen[3].body.messages.at(-1).content).toBe('two');
      expect(seen[3].body.stream).toBe(false);
    } finally { await new Promise<void>(resolve=>server.close(()=>resolve())); }
  });
  it('cancels requests by pane without cancelling another pane', async () => {
    const server=createServer((req,res)=>{if(req.url==='/api/chat'){setTimeout(()=>res.end(JSON.stringify({message:{content:'done'}})),150);}});
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const client=new ProviderClient(1000); const p={...profile,endpoint:`http://127.0.0.1:${(server.address() as any).port}`};
    try {const first=client.chat('a',p,[{role:'user',content:'a'}]);const second=client.chat('b',p,[{role:'user',content:'b'}]);client.cancel('a');await expect(first).rejects.toThrow(/cancel/i);await expect(second).resolves.toBe('done');}
    finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  });
  it('bounds provider waiting time and describes provider HTTP errors',async()=>{
    const server=createServer((req,res)=>{if(req.url==='/api/tags'){res.writeHead(503);res.end('unavailable');}});
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const client=new ProviderClient(30);const p={...profile,endpoint:`http://127.0.0.1:${(server.address() as any).port}`};
    try{await expect(client.listModels(p)).rejects.toThrow(/HTTP 503/);await expect(client.chat('timeout',p,[{role:'user',content:'wait'}])).rejects.toThrow(/timed out/);}
    finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  });
});

describe('terminal lifecycle',()=>{
  it('runs npm Windows CLI shims with literal saved arguments',()=>{
    expect(executableLaunch('C:\\Tools\\codex.cmd',["it's a path",'$(Write-Host bad)'])).toMatchObject({args:['-NoLogo','-NoProfile','-Command',"& 'C:\\Tools\\codex.cmd' 'it''s a path' '$(Write-Host bad)'; exit $LASTEXITCODE"]});
    expect(executableLaunch('C:\\Tools\\claude.exe',['--help'])).toEqual({file:'C:\\Tools\\claude.exe',args:['--help']});
  });
  it('keeps output, input, cwd, resize and stop scoped to each pane',async()=>{
    const cwd=await mkdtemp(join(tmpdir(),'alphacode-pty-'));const calls:any[]=[];const events:any[]=[];
    const factory=(file:string,args:string[],options:any)=>{const terminal={pid:calls.length+10,write:(data:string)=>calls.push({write:data,pid:terminal.pid}),resize:(cols:number,rows:number)=>calls.push({resize:[cols,rows],pid:terminal.pid}),kill:()=>terminal.exit?.({exitCode:0}),onData:(callback:any)=>{terminal.data=callback;return {dispose(){}};},onExit:(callback:any)=>{terminal.exit=callback;return {dispose(){}};},data:null as any,exit:null as any};calls.push({file,args,options,terminal});return terminal;};
    const manager=new TerminalManager(factory,event=>events.push(event),()=>process.execPath);
    await manager.start({...pane,cwd},80,24);await manager.start({...pane,cwd,id:'p2'},90,30);
    calls[0].terminal.data('first');calls[1].terminal.data('second');manager.write('p1','hello');manager.resize('p2',100,40);
    expect(events.filter(e=>e.kind==='data')).toEqual([{paneId:'p1',kind:'data',data:'first'},{paneId:'p2',kind:'data',data:'second'}]);
    expect(calls[0].options.cwd).toBe(cwd);expect(calls[1].options.cwd).toBe(cwd);
    expect(calls[0].options.useConptyDll).toBe(true);
    expect(calls[2]).toMatchObject({write:'hello',pid:10});expect(calls[3]).toMatchObject({resize:[100,40],pid:11});
    manager.stop('p1');expect(manager.has('p2')).toBe(true);expect(manager.has('p1')).toBe(false);manager.stopAll();
  });
  it('refuses admin panes on the ordinary PTY route and reports bad cwd',async()=>{
    const manager=new TerminalManager(()=>{throw new Error('must not spawn');},()=>{},()=>process.execPath);
    await expect(manager.start({...pane,type:'powershell-admin'},80,24)).rejects.toThrow(/elevated helper/);
    await expect(manager.start({...pane,cwd:join(tmpdir(),'missing-'+Date.now())},80,24)).rejects.toThrow(/directory/);
  });
  it('merges launch override env keys case-insensitively so the override PATH wins',async()=>{
    const cwd=await mkdtemp(join(tmpdir(),'alphacode-env-'));const calls:any[]=[];const oldPath=process.env.Path;process.env.Path='C:\\Windows';
    const factory=(file:string,args:string[],options:any)=>{calls.push(options);return {pid:1,write(){},resize(){},kill(){},onData(){return {dispose(){}};},onExit(){return {dispose(){}};}};};
    try{const manager=new TerminalManager(factory,()=>{},()=>process.execPath);await manager.start({...pane,cwd},80,24,{env:{PATH:'D:\\run;X'}});manager.stopAll();}
    finally{if(oldPath===undefined)delete process.env.Path;else process.env.Path=oldPath;}
    const env=calls[0].env;expect(Object.keys(env).filter(k=>/^path$/i.test(k))).toHaveLength(1);expect(env[Object.keys(env).find(k=>/^path$/i.test(k))!]).toMatch(/^D:\\run;/);
  });
  it('cancels pending starts and never resurrects an old session on restart',async()=>{
    const cwd=await mkdtemp(join(tmpdir(),'alphacode-pending-'));let spawns=0;
    const factory=()=>{spawns++;return {pid:1,write(){},resize(){},kill(){},onData(){return {dispose(){}};},onExit(){return {dispose(){}};}};};
    const manager=new TerminalManager(factory,()=>{},()=>process.execPath);
    const old=manager.start({...pane,cwd},80,24);manager.stop('p1');const current=manager.start({...pane,cwd},80,24);await Promise.all([old,current]);expect(spawns).toBe(1);expect(manager.has('p1')).toBe(true);manager.stopAll();
  });
});
