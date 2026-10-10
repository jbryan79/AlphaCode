import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer } from 'node:http';
import type { AppState } from '../shared/types';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const root=resolve(__dirname,'..'),dataDir=join(root,'work','e2e-state');
let app:ElectronApplication,page:Page;const errors:string[]=[];
async function launch(){
  const env={...process.env,ALPHACODE_DATA_DIR:dataDir};delete env.ELECTRON_RUN_AS_NODE;
  app=await electron.launch({args:[root],env});page=await app.firstWindow();
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  await expect(page.getByRole('button',{name:'Add pane',exact:true})).toBeVisible();
}
test.beforeAll(async()=>{await rm(dataDir,{recursive:true,force:true});await mkdir(dataDir,{recursive:true});await launch();});
test.afterAll(async()=>{await app?.close();});
test('production dashboard, real terminals, layout editing and persistence',async()=>{
  await expect(page.locator('.pane')).toHaveCount(8);
  await expect(page.locator('.pane[data-pane-title="PowerShell Admin"] .pane-status')).toHaveText('Ready');
  await expect(page.locator('.pane[data-pane-title="Claude A"] .pane-status')).toHaveText('running');
  const info=await page.evaluate(()=>window.bridge.appInfo());expect(info.appElevated).toBe(false);
  // Observe real output while keyboard input still travels through xterm and preload.
  await page.evaluate(()=>{(window as any).testEvents=[];window.bridge.onSessionEvent(e=>(window as any).testEvents.push(e));});
  const ps=page.locator('.pane[data-pane-title="PowerShell"]');
  await expect(ps.locator('.pane-status')).toHaveText('running');
  await ps.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type("Write-Output ('ALPHACODE_' + 'PTY_OK'); (Get-Location).Path");await page.keyboard.press('Enter');
  await expect.poll(()=>page.evaluate(()=>(window as any).testEvents.filter((e:any)=>e.kind==='data').map((e:any)=>e.data).join(''))).toContain('ALPHACODE_PTY_OK');
  await expect.poll(()=>page.evaluate(()=>(window as any).testEvents.filter((e:any)=>e.kind==='data').map((e:any)=>e.data).join(''))).toContain(process.env.USERPROFILE||'');
  const claudeDirs=await page.locator('.pane').filter({has:page.locator('.pane-header strong', {hasText:/^Claude [A-D]$/})}).locator('.pane-directory>span:first-of-type').allTextContents();
  expect(new Set(claudeDirs).size).toBe(4);
  const psId=await ps.getAttribute('data-pane-id');
  // Rename preserves the session and usable terminal output.
  await page.getByRole('button',{name:'Configure PowerShell',exact:true}).click();
  await page.getByLabel('Pane name',{exact:true}).fill('Operations');await page.getByRole('button',{name:'Apply changes'}).click();
  await expect(page.locator(`.pane[data-pane-id="${psId}"] .pane-status`)).toHaveText('running');
  await page.getByRole('button',{name:'Maximize Operations',exact:true}).click();await expect(page.locator('.pane.maximized')).toHaveCount(1);
  await page.screenshot({path:join(root,'work','focused-desktop.png')});
  await page.getByRole('button',{name:'Restore Operations',exact:true}).click();
  await page.getByRole('button',{name:'Move Operations up',exact:true}).click();
  expect(await page.locator('.pane-list-name').allTextContents()).toEqual(['Claude A','Claude B','Claude C','Operations','Claude D','PowerShell Admin','Local · Coding','Local · General']);
  await expect(page.locator('.vault-section .section-heading')).toHaveText('Claude memory');
  await expect(page.locator('.vault-section .vault-meta')).toContainText(/\d+ projects · \d+ notes/);
  await page.getByRole('button',{name:'Duplicate Operations',exact:true}).click();await expect(page.locator('.pane')).toHaveCount(9);
  await expect(page.locator('.pane[data-pane-title="Operations copy"] .pane-status')).toHaveText('Ready');
  await page.getByRole('button',{name:'Close Operations copy',exact:true}).click();await expect(page.locator('.pane')).toHaveCount(8);
  await page.getByRole('button',{name:'Lock layout',exact:true}).click();await expect(page.getByRole('button',{name:'Move Operations up',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'Unlock layout',exact:true}).click();
  // Actually resize a pane with the grid handle, then verify persisted geometry.
  const pane=page.locator(`.pane[data-pane-id="${psId}"]`),handle=pane.locator('.react-resizable-handle');const box=await handle.boundingBox();
  if(!box)throw new Error('Resize handle missing');
  await page.mouse.move(box.x+6,box.y+6);await page.mouse.down();await page.mouse.move(box.x+6,box.y+70,{steps:6});await page.mouse.up();
  // Autosave persists the resize; poll the file instead of clicking a save button.
  const saved=async()=>JSON.parse(await readFile(join(dataDir,'state.json'),'utf8')) as AppState;
  await expect.poll(async()=>(await saved()).workspaces[0].layout.find(l=>l.i===psId)?.h).toBeGreaterThan(4);
  expect((await saved()).workspaces[0].panes.find(p=>p.id===psId)?.title).toBe('Operations');
  // Confirm ordinary token inside the actual PowerShell process.
  await pane.locator('.xterm-helper-textarea').focus();await page.keyboard.type("Write-Output ('TOKEN_' + ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)))");await page.keyboard.press('Enter');
  await expect.poll(()=>page.evaluate(()=>(window as any).testEvents.filter((e:any)=>e.kind==='data').map((e:any)=>e.data).join(''))).toContain('TOKEN_False');
  await page.getByRole('button',{name:'Balance panes',exact:true}).click();
  await page.screenshot({path:join(root,'work','desktop-dashboard.png')});
  await app.close();await launch();
  await expect(page.locator('.pane[data-pane-title="Operations"] .pane-status')).toHaveText('running');
  await expect(page.locator('.pane')).toHaveCount(8);
  expect(errors).toEqual([]);
});

test('local models, optional pane menu, named workspaces and preset counts',async()=>{
  const requests:any[]=[];const server=createServer((req,res)=>{
    if(req.url==='/api/tags'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({models:[{name:'fixture-coder'}]}));return;}
    let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{requests.push(JSON.parse(body));res.setHeader('Content-Type','application/json');res.end(JSON.stringify({message:{content:'Fixture response from local provider.'}}));});
  });await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('Server missing');
  try{
    await page.getByRole('button',{name:'Edit profile for Local · Coding',exact:true}).click();
    await page.getByLabel('Endpoint',{exact:true}).fill(`http://127.0.0.1:${address.port}`);await page.getByRole('button',{name:'Discover',exact:true}).click();await expect(page.getByRole('combobox',{name:'Available models',exact:true})).toBeVisible();
    await page.getByRole('combobox',{name:'Available models',exact:true}).selectOption('fixture-coder');await page.getByRole('button',{name:'Save profile',exact:true}).click();
    await page.getByLabel('Message Local · Coding',{exact:true}).fill('Check this independent session');await page.getByRole('button',{name:'Send to Local · Coding',exact:true}).click();
    await expect(page.locator('.pane[data-pane-title="Local · Coding"] .chat-transcript')).toContainText('Fixture response from local provider.');
    await expect(page.locator('.pane[data-pane-title="Local · General"] .chat-transcript')).not.toContainText('Check this independent session');
    expect(requests[0].model).toBe('fixture-coder');expect(requests[0].messages[requests[0].messages.length-1].content).toBe('Check this independent session');
    await page.getByRole('button',{name:'Add pane',exact:true}).click();
    for(const name of ['Claude','PowerShell','PowerShell Admin','Local Model','Vault','Codex','Gemini','WSL','CMD','Git Bash','Custom Command'])await expect(page.locator('.dropdown').getByRole('button',{name,exact:true})).toBeVisible();
    await page.locator('.dropdown').getByRole('button',{name:'Vault',exact:true}).click();await page.getByRole('button',{name:'Apply changes',exact:true}).click();
    await expect(page.locator('.pane[data-pane-title="Vault"] canvas.vault-graph')).toBeVisible();
    await expect(page.locator('.pane[data-pane-title="Vault"] .local-welcome')).toContainText(/\d+ notes across \d+ projects/);
    await page.getByLabel('Message Vault',{exact:true}).fill('launch zzz-no-such-project');await page.getByRole('button',{name:'Send to Vault',exact:true}).click();
    await expect(page.locator('.pane[data-pane-title="Vault"] .chat-transcript')).toContainText('Nothing in the vault');
    await page.getByRole('button',{name:'Add pane',exact:true}).click();
    await page.locator('.dropdown').getByRole('button',{name:'CMD',exact:true}).click();await page.getByLabel('Pane name',{exact:true}).fill('Quick shell');await page.getByRole('button',{name:'Apply changes',exact:true}).click();await expect(page.locator('.pane')).toHaveCount(10);
    await page.getByRole('button',{name:'Save as',exact:true}).click();await page.getByLabel('Workspace name',{exact:true}).fill('SQL Day');await page.getByRole('button',{name:'Save workspace',exact:true}).click();
    await expect(page.getByLabel('Load workspace')).toContainText('SQL Day');
    await page.getByRole('button',{name:'4 panes',exact:true}).click();await expect(page.locator('.pane')).toHaveCount(4);
    await page.getByRole('button',{name:'6 panes',exact:true}).click();await expect(page.locator('.pane')).toHaveCount(6);
    // A single session fills the grid; Close all empties the workspace and the empty state offers a fresh pane.
    await page.getByRole('button',{name:'1 pane',exact:true}).click();await expect(page.locator('.pane')).toHaveCount(1);
    const single=page.locator('.pane'),gridBox=(await page.locator('.react-grid-layout').boundingBox())!,singleBox=(await single.boundingBox())!;
    expect(singleBox.width).toBeGreaterThan(gridBox.width*0.95);
    await page.getByRole('button',{name:'Close all',exact:true}).click();await expect(page.locator('.pane')).toHaveCount(0);
    await expect(page.getByRole('button',{name:'Close all',exact:true})).toHaveCount(0);
    await expect(page.locator('.empty-workspace')).toBeVisible();await page.getByRole('button',{name:'Add PowerShell',exact:true}).click();await page.getByRole('button',{name:'Apply changes',exact:true}).click();await expect(page.locator('.pane')).toHaveCount(1);
    await expect(page.locator('.app-statusbar')).toContainText('Saved locally');
    const state=await page.evaluate(()=>window.bridge.loadState());
    const sqlDay=state!.workspaces.find(w=>w.name==='SQL Day');if(!sqlDay)throw new Error('Named workspace missing');
    await page.getByLabel('Load workspace').selectOption(sqlDay.id);await expect(page.locator('.pane')).toHaveCount(10);
    await expect(page.locator('.pane[data-pane-title="PowerShell Admin"] .pane-status')).toHaveText('Ready');
    expect(errors).toEqual([]);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('a change made just before closing the window survives, and the window geometry comes back',async()=>{
  // Compare content bounds against what Windows actually applied: display scaling can round the requested size by a pixel.
  const bounds=await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setContentBounds({x:60,y:40,width:1240,height:820});return w.getContentBounds();});
  const target=page.locator('.pane').first(),title=(await target.getAttribute('data-pane-title'))!;
  await page.getByRole('button',{name:`Configure ${title}`,exact:true}).click();
  await page.getByLabel('Pane name',{exact:true}).fill('Last minute');await page.getByRole('button',{name:'Apply changes',exact:true}).click();
  await expect(page.locator('.pane[data-pane-title="Last minute"]')).toHaveCount(1);
  // Close the window the way a user does, with no wait for the status bar.
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());await app.waitForEvent('close');
  await launch();
  await expect(page.locator('.pane[data-pane-title="Last minute"]')).toHaveCount(1);
  // Electron rounds the size by a pixel or two at fractional display scaling (electron/electron#10862); position is exact.
  const after=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getContentBounds());
  expect([after.x,after.y]).toEqual([bounds.x,bounds.y]);expect(Math.abs(after.width-bounds.width)).toBeLessThanOrEqual(3);expect(Math.abs(after.height-bounds.height)).toBeLessThanOrEqual(3);
  expect(errors).toEqual([]);
});

test('orchestrate mode runs a two-task plan through stub workers', async () => {
  // Earlier tests reshape the workspace; start from the default 8 panes again.
  await app.close(); await rm(dataDir, { recursive: true, force: true }); await mkdir(dataDir, { recursive: true }); await launch();
  const repo = await mkdtemp(join(tmpdir(), 'alphacode-orch-e2e-')); let dir = '';
  try {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo }); await writeFile(join(repo, 'README.md'), '# e2e\n'); execFileSync('git', ['add', '.'], { cwd: repo }); execFileSync('git', ['-c', 'user.email=e2e@x', '-c', 'user.name=e2e', 'commit', '-qm', 'init'], { cwd: repo });
  const stub = join(root, 'tests', 'fixtures', 'fake-claude.cmd');
  // Point every Claude pane at the stub and the repo, then turn the mode on.
  for (const name of ['Claude A', 'Claude B', 'Claude C', 'Claude D']) {
    await page.getByRole('button', { name: `Configure ${name}`, exact: true }).click();
    await page.getByLabel('Executable override (optional)', { exact: true }).fill(stub); await page.getByLabel('Working directory', { exact: true }).fill(repo);
    await page.getByRole('button', { name: 'Apply changes' }).click();
  }
  await page.locator('.pane[data-pane-title="Claude A"]').click();
  await page.getByRole('button', { name: 'Turn orchestrate on', exact: true }).click();
  await expect(page.locator('.pane')).toHaveCount(6);
  await expect(page.locator('.pane[data-pane-title="Claude A"] .pane-badge')).toHaveText('Orchestrator');
  await expect(page.locator('.tasks-section')).toContainText('Waiting for a plan');
  // Drive the control channel the way the orchestrator would, using the pane's own environment.
  const env = await page.evaluate(async () => (window as any).__orchestrateEnv);
  dir = await mkdtemp(join(tmpdir(), 'alphacode-plan-'));
  await writeFile(join(dir, 'a.md'), 'A task'); await writeFile(join(dir, 'b.md'), 'B task');
  await writeFile(join(dir, 'plan.json'), JSON.stringify({ tests: '', tasks: [{ id: 'a', title: 'Alpha', files: ['a/'], model: 'sonnet', minutes: 5, advisor: false, prompt: 'a.md' }, { id: 'b', title: 'Beta', files: ['b/'], model: 'sonnet', minutes: 5, advisor: false, prompt: 'b.md' }] }));
  const cli = (...a: string[]) => execFileSync('node', [join(root, 'dist-electron', 'electron', 'cli.js'), ...a], { env: { ...process.env, ...env }, encoding: 'utf8' });
  cli('plan', join(dir, 'plan.json'));
  await expect(page.locator('.task-row')).toHaveCount(2);
  await page.getByRole('button', { name: 'Approve plan', exact: true }).click();
  cli('task', 'start', 'a'); cli('task', 'start', 'b');
  await expect(page.locator('.pane-badge', { hasText: 'Task done' })).toHaveCount(2);
  expect(execFileSync('git', ['worktree', 'list'], { cwd: repo, encoding: 'utf8' })).toContain('task-a');
  expect(await readFile(join(repo, '.claude', 'worktrees', 'task-a', 'task-a.txt'), 'utf8')).toMatch(/^Task a in worktree task-a[\s\S]*A task$/); // prompt arrived through the file
  await expect(page.locator('.app-statusbar')).toContainText('2 done');
  await writeFile(join(dir, 'r.md'), 'E2E finished.'); cli('finish', join(dir, 'r.md'));
  await expect(page.locator('.pane[data-pane-title="Claude A"] .pane-badge')).toHaveText('Done');
  await page.getByRole('button', { name: 'Turn orchestrate off', exact: true }).click();
  await expect(page.locator('.pane-badge')).toHaveCount(0);
  expect(errors).toEqual([]);
  } finally { for (const d of [repo, dir]) if (d) await rm(d, { recursive: true, force: true }).catch(() => {}); }
});
