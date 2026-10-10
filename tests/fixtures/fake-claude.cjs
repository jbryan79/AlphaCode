// Stand-in for the claude CLI in e2e: honors --worktree and the positional prompt, commits one file, reports done.
const { execFileSync } = require('node:child_process'); const { writeFileSync, mkdirSync } = require('node:fs'); const { join } = require('node:path');
const args = process.argv.slice(2); const flag = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : ''; };
const name = flag('--worktree'), prompt = args[args.length - 1] || '';
if (flag('--append-system-prompt-file')) { console.log('ORCHESTRATOR READY'); setInterval(() => {}, 1000); return; } // orchestrator stub idles; the test drives the server through the CLI
const root = process.cwd(), dir = join(root, '.claude', 'worktrees', name); mkdirSync(join(root, '.claude', 'worktrees'), { recursive: true });
execFileSync('git', ['worktree', 'add', '-b', `task-${name.replace(/^task-/, '')}`, dir], { cwd: root, stdio: 'ignore' });
writeFileSync(join(dir, `${name}.txt`), prompt); execFileSync('git', ['add', '.'], { cwd: dir }); execFileSync('git', ['-c', 'user.email=e2e@x', '-c', 'user.name=e2e', 'commit', '-qm', name], { cwd: dir });
console.log(`WORKER ${name} committed`);
execFileSync('cmd.exe', ['/c', join(process.env.ALPHACODE_RUN_DIR_SHIM || '', 'alphacode.cmd'), 'report', 'done'], { stdio: 'inherit' });
setInterval(() => {}, 1000);
