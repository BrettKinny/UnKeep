import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

test('claims a server once and syncs opaque records', async t => {
  const port=31000+Math.floor(Math.random()*1000);const data=mkdtempSync(join(tmpdir(),'unkeep-'));
  const child=spawn(process.execPath,['src/index.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:String(port),UNKEEP_DATA_DIR:data,UNKEEP_SETUP_TOKEN:'test-setup-token'}});
  t.after(()=>child.kill());await new Promise((resolve,reject)=>{let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);child.stdout.on('data',chunk=>{if(String(chunk).includes('listening'))resolve()});child.once('error',reject);child.once('exit',code=>reject(new Error(`server exited ${code}: ${stderr}`)))});
  const api=`http://127.0.0.1:${port}/api/v1`;
  let response=await fetch(`${api}/status`);assert.deepEqual((await response.json()).initialized,false);
  response=await fetch(`${api}/setup/claim`,{method:'POST',headers:{authorization:'Setup test-setup-token','content-type':'application/json'},body:JSON.stringify({deviceId:'device-one',name:'Test'})});assert.equal(response.status,201);const claimed=await response.json();assert.ok(claimed.deviceCredential);
  response=await fetch(`${api}/setup/claim`,{method:'POST',headers:{authorization:'Setup test-setup-token','content-type':'application/json'},body:JSON.stringify({deviceId:'device-two'})});assert.equal(response.status,409);
  const headers={authorization:`Device ${claimed.deviceCredential}`,'content-type':'application/json'};
  const envelope={version:1,algorithm:'AES-GCM',keyId:'note-one',iv:'opaque',ciphertext:'opaque'};
  response=await fetch(`${api}/notes/note-one`,{method:'PUT',headers,body:JSON.stringify({mutationId:'mutation-one',envelope,deleted:false})});assert.equal(response.status,200);
  response=await fetch(`${api}/changes?since=0`,{headers});const changes=await response.json();assert.equal(changes.changes.length,1);assert.deepEqual(changes.changes[0].envelope,envelope);
});
