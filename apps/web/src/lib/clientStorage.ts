import { DeviceKeyStore, RelaySessionStore, type ClientStorage } from '@unkeep/client';

const DB_NAME = 'unkeep-keys';
const DB_VERSION = 2;
const STATE_STORE = 'client-state';
const LEGACY_KEY_STORE = 'device-keys';
const DEVICE_KEYS_KEY = 'unkeep-device-keys';

interface StateRecord { key:string; value:unknown }

function openDb():Promise<IDBDatabase> {
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open(DB_NAME,DB_VERSION);
    request.onupgradeneeded=()=>{
      if(!request.result.objectStoreNames.contains(STATE_STORE))request.result.createObjectStore(STATE_STORE,{keyPath:'key'});
    };
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
}

function requestValue<T>(request:IDBRequest<T>):Promise<T> {
  return new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)});
}

export class IndexedDbClientStorage implements ClientStorage {
  async get<T>(key:string):Promise<T|null> {
    const db=await openDb();
    let value=(await requestValue(db.transaction(STATE_STORE,'readonly').objectStore(STATE_STORE).get(key)) as StateRecord|undefined)?.value;
    let legacy=false;
    if(value===undefined&&key===DEVICE_KEYS_KEY&&db.objectStoreNames.contains(LEGACY_KEY_STORE)) {
      value=await requestValue(db.transaction(LEGACY_KEY_STORE,'readonly').objectStore(LEGACY_KEY_STORE).get('current'));
      legacy=value!==undefined;
    }
    db.close();
    if(value===undefined){const stored=localStorage.getItem(key);if(stored!==null){legacy=true;try{value=JSON.parse(stored)}catch{value=stored}}}
    if(value===undefined)return null;
    if(legacy)await this.set(key,value);
    return value as T;
  }

  async set<T>(key:string,value:T):Promise<void> {
    const db=await openDb();
    await new Promise<void>((resolve,reject)=>{
      const transaction=db.transaction(STATE_STORE,'readwrite');
      transaction.objectStore(STATE_STORE).put({key,value} satisfies StateRecord);
      transaction.oncomplete=()=>resolve();transaction.onerror=()=>reject(transaction.error);
    });
    db.close();
  }

  async delete(key:string):Promise<void> {
    const db=await openDb();
    await new Promise<void>((resolve,reject)=>{
      const transaction=db.transaction(STATE_STORE,'readwrite');transaction.objectStore(STATE_STORE).delete(key);
      transaction.oncomplete=()=>resolve();transaction.onerror=()=>reject(transaction.error);
    });
    db.close();localStorage.removeItem(key);
  }

  async update<T>(key:string,change:(value:T|null)=>T|null):Promise<void> {
    const db=await openDb();
    try {
      await new Promise<void>((resolve,reject)=>{
        const transaction=db.transaction(STATE_STORE,'readwrite');
        const store=transaction.objectStore(STATE_STORE);
        const request=store.get(key);
        let updaterError:unknown;
        request.onsuccess=()=>{
          try {
            const current=(request.result as StateRecord|undefined)?.value as T|undefined;
            const next=change(current??null);
            if(next===null)store.delete(key);else store.put({key,value:next} satisfies StateRecord);
          } catch(error) {
            updaterError=error;
            try { transaction.abort(); } catch { reject(error); }
          }
        };
        request.onerror=()=>reject(request.error);
        transaction.oncomplete=()=>resolve();
        transaction.onerror=()=>reject(updaterError??transaction.error);
        transaction.onabort=()=>reject(updaterError??transaction.error??new Error('IndexedDB update aborted'));
      });
    } finally {
      db.close();
    }
  }
}

export const clientStorage=new IndexedDbClientStorage();
export const deviceKeyStore=new DeviceKeyStore(clientStorage);
export const relaySessionStore=new RelaySessionStore(clientStorage);
