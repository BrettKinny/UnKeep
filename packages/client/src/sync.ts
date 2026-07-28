import { decryptAttachment, decryptNote, encryptAttachment, encryptNote, normalizeNoteRecord, type EncryptedEnvelope, type Note, type NoteAttachment } from '@unkeep/core';
import { RelayClient, RelayHttpError, type RelayChange, type RelaySession } from './relay.js';
import type { ClientStorage } from './storage.js';

const LEGACY_CURSOR_PREFIX = 'unkeep-sync-cursor:';
const SYNC_STATE_PREFIX = 'unkeep-sync-state:';
const PENDING_MUTATION_PREFIX = 'unkeep-pending-mutation:';
export interface PulledAttachment { noteId:string; attachment:NoteAttachment; bytes:Uint8Array<ArrayBuffer> }
export interface PulledAttachmentTombstone { noteId:string; attachmentId:string }
export interface PulledRevision { kind:RelayChange['kind']; id:string; revision:number }
export interface PulledNotes { notes:Note[]; deletedIds:string[]; attachments:PulledAttachment[]; deletedAttachments:PulledAttachmentTombstone[]; cursor:number; revisions:PulledRevision[] }

export class AttachmentDeletedError extends Error {
  constructor(readonly noteId:string,readonly attachmentId:string) {
    super(`Attachment ${attachmentId} has been deleted`);
    this.name='AttachmentDeletedError';
  }
}

interface StoredSyncState {
  version:1;
  cursor:number;
  revisions:Record<string,number>;
}

interface StoredPendingMutation {
  version:1;
  kind:RelayChange['kind'];
  id:string;
  fingerprint:string;
  payload:Record<string,unknown>;
}

function revisionKey(kind:RelayChange['kind'],id:string):string { return `${kind}:${id}`; }
function emptySyncState():StoredSyncState { return {version:1,cursor:0,revisions:{}}; }
function isStoredSyncState(value:unknown):value is StoredSyncState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state=value as Partial<StoredSyncState>;
  return state.version===1
    && Number.isSafeInteger(state.cursor) && state.cursor!>=0
    && Boolean(state.revisions) && typeof state.revisions==='object' && !Array.isArray(state.revisions)
    && Object.values(state.revisions!).every(revision=>Number.isSafeInteger(revision) && revision>=0);
}

function isStoredPendingMutation(value:unknown):value is StoredPendingMutation {
  if (!value || typeof value!=='object' || Array.isArray(value)) return false;
  const pending=value as Partial<StoredPendingMutation>;
  return pending.version===1
    && (pending.kind==='note'||pending.kind==='attachment')
    && typeof pending.id==='string'
    && typeof pending.fingerprint==='string'
    && Boolean(pending.payload) && typeof pending.payload==='object' && !Array.isArray(pending.payload)
    && typeof (pending.payload as Record<string,unknown>).mutationId==='string';
}

async function sha256(value:Uint8Array<ArrayBuffer>):Promise<string> {
  const digest=new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',value));
  return [...digest].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}

export class EncryptedSync {
  private readonly relay: RelayClient;
  private stateOperations:Promise<void>=Promise.resolve();
  private readonly mutationOperations=new Map<string,Promise<unknown>>();

  constructor(private readonly session: RelaySession, private readonly masterKey: Uint8Array<ArrayBuffer>, private readonly storage:ClientStorage) {
    this.relay = new RelayClient(session.endpoint, session.credential);
  }
  private async loadState():Promise<StoredSyncState> {
    const stored=await this.storage.get<unknown>(SYNC_STATE_PREFIX+this.session.instanceId);
    if (stored!==null) {
      if (!isStoredSyncState(stored)) throw new Error('Stored sync checkpoint is invalid');
      return stored;
    }
    // Legacy cursors had no per-record revisions. A safe migration must replay
    // from zero so the first protected write cannot use an unknown base.
    const legacyCursor=Number(await this.storage.get<number|string>(LEGACY_CURSOR_PREFIX+this.session.instanceId)??0);
    if (!Number.isSafeInteger(legacyCursor) || legacyCursor<0) throw new Error('Stored legacy sync cursor is invalid');
    return emptySyncState();
  }
  private async state():Promise<StoredSyncState> { await this.stateOperations;return this.loadState(); }
  private updateState(change:(state:StoredSyncState)=>void):Promise<void> {
    const operation=this.stateOperations.then(async()=>{
      const current=await this.loadState();
      const next:StoredSyncState={version:1,cursor:current.cursor,revisions:{...current.revisions}};
      change(next);
      await this.storage.set(SYNC_STATE_PREFIX+this.session.instanceId,next);
    });
    this.stateOperations=operation.catch(()=>undefined);
    return operation;
  }
  private async knownRevision(kind:RelayChange['kind'],id:string):Promise<number> {
    return (await this.state()).revisions[revisionKey(kind,id)]??0;
  }
  private rememberRevision(kind:RelayChange['kind'],id:string,revision:number):Promise<void> {
    return this.updateState(state=>{const key=revisionKey(kind,id);state.revisions[key]=Math.max(state.revisions[key]??0,revision)});
  }
  private pendingMutationKey(kind:RelayChange['kind'],id:string):string {
    return `${PENDING_MUTATION_PREFIX}${encodeURIComponent(this.session.instanceId)}:${kind}:${encodeURIComponent(id)}`;
  }
  private runMutation<T>(key:string,operation:()=>Promise<T>):Promise<T> {
    const previous=this.mutationOperations.get(key)??Promise.resolve();
    const current=previous.catch(()=>undefined).then(operation);
    this.mutationOperations.set(key,current);
    return current.finally(()=>{if(this.mutationOperations.get(key)===current)this.mutationOperations.delete(key)});
  }
  private async sendPending(key:string,pending:StoredPendingMutation):Promise<number> {
    let result:{revision:number};
    try {
      result=pending.kind==='note'
        ? await this.relay.putNote(pending.id,pending.payload)
        : await this.relay.putAttachment(pending.id,pending.payload);
    } catch(error) {
      // A deterministic client error did not leave an ambiguous successful
      // request to retry. Network, parse, and server failures remain pending.
      if(error instanceof RelayHttpError&&error.status<500)await this.storage.delete(key);
      throw error;
    }
    await this.rememberRevision(pending.kind,pending.id,result.revision);
    await this.storage.delete(key);
    return result.revision;
  }
  private mutate(
    kind:RelayChange['kind'],
    id:string,
    fingerprint:string,
    payload:(baseRevision:number)=>Promise<Record<string,unknown>>,
  ):Promise<number> {
    const key=this.pendingMutationKey(kind,id);
    return this.runMutation(key,async()=>{
      const stored=await this.storage.get<unknown>(key);
      if(stored!==null) {
        if(!isStoredPendingMutation(stored)||stored.kind!==kind||stored.id!==id) {
          throw new Error(`Stored pending ${kind} mutation is invalid`);
        }
        const revision=await this.sendPending(key,stored);
        if(stored.fingerprint===fingerprint)return revision;
      }

      const baseRevision=await this.knownRevision(kind,id);
      const pending:StoredPendingMutation={
        version:1,
        kind,
        id,
        fingerprint,
        payload:await payload(baseRevision),
      };
      await this.storage.set(key,pending);
      return this.sendPending(key,pending);
    });
  }
  async getCursor():Promise<number> { return (await this.state()).cursor; }

  /**
   * Persist a pull cursor only after the caller has durably applied every
   * returned note, tombstone, and attachment. Pulling by itself is read-only
   * so a failed local transaction can safely retry the same remote changes.
   */
  acknowledge(cursor:number,revisions:readonly PulledRevision[]):Promise<void> {
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      return Promise.reject(new Error('Sync cursor must be a non-negative safe integer'));
    }
    if (!Array.isArray(revisions) || revisions.some(({kind,id,revision})=>
      (kind!=='note'&&kind!=='attachment') || typeof id!=='string' || !Number.isSafeInteger(revision) || revision<0 || revision>cursor)) {
      return Promise.reject(new Error('Pulled revisions must identify valid records at or before the acknowledged cursor'));
    }
    return this.updateState(state=>{
      for (const {kind,id,revision} of revisions) {
        const key=revisionKey(kind,id);
        state.revisions[key]=Math.max(state.revisions[key]??0,revision);
      }
      state.cursor=Math.max(state.cursor,cursor);
    });
  }
  async push(note:Note):Promise<number> {
    const portable=normalizeNoteRecord({...note,images:note.images?.map(({id,name,mimeType,size})=>({id,name,mimeType,size}))});
    const fingerprint=await sha256(new TextEncoder().encode(JSON.stringify(portable)));
    return this.mutate('note',note.id,fingerprint,async baseRevision=>({
      mutationId:globalThis.crypto.randomUUID(),
      baseRevision,
      envelope:await encryptNote(portable,this.masterKey,{ownerId:this.session.instanceId,noteId:note.id}),
      deleted:note.deleted??false,
      deviceId:this.session.deviceId,
    }));
  }
  async uploadAttachment(noteId:string,attachment:NoteAttachment,bytes:Uint8Array<ArrayBuffer>):Promise<void> {
    const fingerprint=JSON.stringify({noteId,attachment,deleted:false,bytes:await sha256(bytes)});
    await this.mutate('attachment',attachment.id,fingerprint,async baseRevision=>({
      mutationId:globalThis.crypto.randomUUID(),
      baseRevision,
      noteId,
      envelope:await encryptAttachment(bytes,this.masterKey,{ownerId:this.session.instanceId,noteId,attachmentId:attachment.id}),
      deleted:false,
      deviceId:this.session.deviceId,
    }));
  }
  async deleteAttachment(noteId:string,attachment:NoteAttachment):Promise<void> {
    const fingerprint=JSON.stringify({noteId,attachment,deleted:true});
    await this.mutate('attachment',attachment.id,fingerprint,async baseRevision=>({
      mutationId:globalThis.crypto.randomUUID(),
      baseRevision,
      noteId,
      envelope:await encryptAttachment(new Uint8Array(),this.masterKey,{ownerId:this.session.instanceId,noteId,attachmentId:attachment.id}),
      deleted:true,
      deviceId:this.session.deviceId,
    }));
  }
  async downloadAttachment(noteId:string,attachment:NoteAttachment):Promise<Uint8Array<ArrayBuffer>> {
    const row=await this.relay.getAttachment(attachment.id);
    if(row.deleted)throw new AttachmentDeletedError(row.noteId,attachment.id);
    const bytes=await decryptAttachment(row.envelope as EncryptedEnvelope,this.masterKey,{ownerId:this.session.instanceId,noteId,attachmentId:attachment.id});
    if(bytes.byteLength!==attachment.size) {
      throw new Error(`Attachment ${attachment.id} expected ${attachment.size} bytes but received ${bytes.byteLength}`);
    }
    return bytes;
  }
  async pull(since?:number):Promise<PulledNotes> {
    const {changes,cursor}=await this.relay.changes(since ?? await this.getCursor());const notes:Note[]=[];const deletedIds:string[]=[];const attachments:PulledAttachment[]=[];
    const attachmentTombstones=new Map<string,PulledAttachmentTombstone>();
    for(const row of changes)if(row.kind==='attachment'&&row.deleted&&typeof row.noteId==='string')attachmentTombstones.set(row.id,{noteId:row.noteId,attachmentId:row.id});
    const latest=new Map(changes.filter(c=>c.kind==='note').map(c=>[c.id,c]));
    for(const row of latest.values()) {
      const note=await decryptNote(row.envelope as EncryptedEnvelope,this.masterKey,{ownerId:this.session.instanceId,noteId:row.id});
      if(row.deleted||note.deleted) deletedIds.push(row.id); else {
        if(note.images?.length){const available:NoteAttachment[]=[];for(const attachment of note.images){
          if(attachmentTombstones.has(attachment.id))continue;
          try{attachments.push({noteId:note.id,attachment,bytes:await this.downloadAttachment(note.id,attachment)});available.push(attachment)}
          catch(error){if(error instanceof AttachmentDeletedError)attachmentTombstones.set(attachment.id,{noteId:error.noteId,attachmentId:attachment.id});else throw error}
        }note.images=available.length?available:undefined}
        notes.push(note);
      }
    }
    return {notes,deletedIds,attachments,deletedAttachments:[...attachmentTombstones.values()],cursor,revisions:changes.map(({kind,id,revision})=>({kind,id,revision}))};
  }
}
