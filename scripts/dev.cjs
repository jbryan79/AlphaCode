const { spawn } = require('node:child_process');
const electron = require('electron');
(async()=>{
  const vite=await (await import('vite')).createServer();
  await vite.listen();
  const desktop=spawn(electron,['.','--dev'],{stdio:'inherit',env:{...process.env,ELECTRON_RUN_AS_NODE:''}});
  const quit=code=>{desktop.kill();vite.close().finally(()=>process.exit(code));};
  desktop.on('exit',code=>quit(code||0));
  process.on('SIGINT',()=>quit(0));process.on('SIGTERM',()=>quit(0));
})().catch(error=>{console.error('The frontend did not start.',error);process.exit(1);});
