import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const childScript=fileURLToPath(new URL('./server-child.mjs',import.meta.url));

function waitForExit(child,timeoutMs) {
  if(child.exitCode!==null||child.signalCode!==null)return Promise.resolve(true);
  return new Promise(resolve=>{
    const timeout=setTimeout(()=>{child.removeListener('exit',onExit);resolve(false)},timeoutMs);timeout.unref();
    function onExit(){clearTimeout(timeout);resolve(true)}
    child.once('exit',onExit);
  });
}

function waitForReady(child,logs) {
  return new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>fail(new Error(`server startup timed out${logs()}`)),5000);timeout.unref();
    function cleanup(){clearTimeout(timeout);child.removeListener('message',onMessage);child.removeListener('error',onError);child.removeListener('exit',onExit)}
    function fail(error){cleanup();reject(error)}
    function onMessage(message){if(message?.type==='ready'){cleanup();resolve(message.port)}else if(message?.type==='error')fail(new Error(`server failed to start: ${message.error}${logs()}`))}
    function onError(error){fail(error)}
    function onExit(code,signal){fail(new Error(`server exited before startup (${signal||code})${logs()}`))}
    child.on('message',onMessage);child.once('error',onError);child.once('exit',onExit);
  });
}

export async function startTestServer({
  setupToken=randomBytes(24).toString('base64url'),
  env={},
  preserveDataDir=false,
}={}) {
  const dataDir=await mkdtemp(join(tmpdir(),'unkeep-test-'));let output='';
  const child=spawn(process.execPath,[childScript],{
    env:{
      ...process.env,
      NODE_ENV:'test',
      UNKEEP_DATA_DIR:dataDir,
      UNKEEP_SETUP_TOKEN:setupToken,
      UNKEEP_RECOVERY_TOKEN:'test-distinct-recovery-token-00000001',
      ...env,
    },
    stdio:['ignore','pipe','pipe','ipc'],
  });
  child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
  const logs=()=>output ? `\n${output.trim()}` : '';
  let port;
  try { port=await waitForReady(child,logs); }
  catch(error){child.kill('SIGKILL');await waitForExit(child,1000);await rm(dataDir,{recursive:true,force:true});throw error}
  let stopPromise;
  async function stop(){
    if(stopPromise)return stopPromise;
    stopPromise=(async()=>{
      try {
        if(child.exitCode===null&&child.signalCode===null){
          const exited=waitForExit(child,5000);
          if(child.connected)child.send({type:'stop'});else child.kill();
          if(!await exited){child.kill('SIGKILL');await waitForExit(child,1000)}
        }
      } finally {
        if(!preserveDataDir)await rm(dataDir,{recursive:true,force:true});
      }
    })();
    return stopPromise;
  }
  const endpoint=`http://127.0.0.1:${port}/api/v1`;
  try {
    const response=await fetch(`${endpoint}/status`);
    if(!response.ok)throw new Error(`status returned ${response.status}`);
    const status=await response.json();
    const cleanup=()=>rm(dataDir,{recursive:true,force:true});
    return {endpoint,instanceId:status.instanceId,dataDir,setupToken,stop,cleanup};
  } catch(error) {
    await stop();
    throw error;
  }
}
