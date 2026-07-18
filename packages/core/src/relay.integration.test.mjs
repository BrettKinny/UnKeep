import { expect, test } from 'vitest';
import { startTestServer } from '@unkeep/server/test';

test('claims a relay credential and reads an encrypted note from the change feed',async()=>{
  const relay=await startTestServer();
  try {
    const claim=await fetch(`${relay.endpoint}/setup/claim`,{
      method:'POST',headers:{authorization:`Setup ${relay.setupToken}`,'content-type':'application/json'},
      body:JSON.stringify({deviceId:'vitest-device',name:'Vitest'}),
    });
    expect(claim.status).toBe(201);const {deviceCredential}=await claim.json();expect(deviceCredential).toBeTruthy();
    const headers={authorization:`Device ${deviceCredential}`,'content-type':'application/json'};
    const envelope={version:1,algorithm:'AES-GCM',keyId:'vitest-note',iv:'opaque-iv',ciphertext:'opaque-ciphertext'};
    const put=await fetch(`${relay.endpoint}/notes/vitest-note`,{
      method:'PUT',headers,body:JSON.stringify({mutationId:'vitest-mutation',envelope,deleted:false}),
    });
    expect(put.status).toBe(200);
    const response=await fetch(`${relay.endpoint}/changes?since=0`,{headers});
    expect(response.status).toBe(200);const changes=await response.json();
    expect(changes.changes).toHaveLength(1);expect(changes.changes[0]).toMatchObject({kind:'note',id:'vitest-note',envelope,deleted:false});
  } finally { await relay.stop(); }
});
