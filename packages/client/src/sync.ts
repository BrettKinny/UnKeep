import { decryptAttachment, decryptNote, encryptAttachment, encryptNote, isValidNoteId, normalizeNoteRecord, type EncryptedEnvelope, type Note, type NoteAttachment } from '@unkeep/core';
import { RelayClient, RelayHttpError, type RelayChange, type RelaySession } from './relay.js';
import type { ClientStorage } from './storage.js';

const LEGACY_CURSOR_PREFIX = 'unkeep-sync-cursor:';
const SYNC_STATE_PREFIX = 'unkeep-sync-state:';
const PENDING_MUTATION_PREFIX = 'unkeep-pending-mutation:';
const QUARANTINE_PREFIX = 'unkeep-sync-quarantine:';
const MAX_PULL_CHANGES = 1000;
const MAX_QUARANTINED_RECORDS = MAX_PULL_CHANGES;
export interface PulledAttachment { noteId:string; attachment:NoteAttachment; bytes:Uint8Array<ArrayBuffer> }
export interface PulledAttachmentTombstone { noteId:string; attachmentId:string }
export interface PulledRevision { kind:RelayChange['kind']; id:string; revision:number }
export type QuarantineReason = 'note_invalid_or_undecryptable';
export interface QuarantinedRecord { kind:'note'; id:string; revision:number; reason:QuarantineReason }
export interface PulledNotes { notes:Note[]; deletedIds:string[]; attachments:PulledAttachment[]; deletedAttachments:PulledAttachmentTombstone[]; quarantined:QuarantinedRecord[]; cursor:number; revisions:PulledRevision[] }

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

interface StoredQuarantineState {
  version:1;
  records:QuarantinedRecord[];
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

function isQuarantinedRecord(value:unknown):value is QuarantinedRecord {
  if (!value || typeof value!=='object' || Array.isArray(value)) return false;
  const record=value as Partial<QuarantinedRecord>;
  return Object.keys(value).length===4
    && record.kind==='note'
    && typeof record.id==='string'
    && isValidNoteId(record.id)
    && Number.isSafeInteger(record.revision) && record.revision!>0
    && record.reason==='note_invalid_or_undecryptable';
}

function isStoredQuarantineState(value:unknown):value is StoredQuarantineState {
  if (!value || typeof value!=='object' || Array.isArray(value)) return false;
  const state=value as Partial<StoredQuarantineState>;
  if (
    Object.keys(value).length!==2
    || state.version!==1
    || !Array.isArray(state.records)
    || state.records.length>MAX_QUARANTINED_RECORDS
    || !state.records.every(isQuarantinedRecord)
  )return false;
  return new Set(state.records.map(record=>revisionKey(record.kind,record.id))).size===state.records.length;
}

function validatePullResponse(
  value:{changes:RelayChange[];cursor:number},
  since:number,
):{changes:RelayChange[];cursor:number} {
  if (
    !value
    || typeof value!=='object'
    || !Array.isArray(value.changes)
    || value.changes.length>MAX_PULL_CHANGES
    || !Number.isSafeInteger(value.cursor)
    || value.cursor<since
  )throw new Error('Relay returned an invalid change page');

  let previousRevision=since;
  const identities=new Set<string>();
  for(const row of value.changes as unknown[]) {
    if (!row || typeof row!=='object' || Array.isArray(row)) {
      throw new Error('Relay returned an invalid change record');
    }
    const change=row as Partial<RelayChange>;
    if (
      (change.kind!=='note'&&change.kind!=='attachment')
      || typeof change.id!=='string'
      || !isValidNoteId(change.id)
      || typeof change.deleted!=='boolean'
      || !Number.isSafeInteger(change.revision)
      || change.revision!<=previousRevision
      || change.revision!>value.cursor
      || (change.kind==='attachment' && (typeof change.noteId!=='string'||!isValidNoteId(change.noteId)))
    )throw new Error('Relay returned an invalid change record');
    const identity=revisionKey(change.kind,change.id);
    if (identities.has(identity)) throw new Error('Relay returned duplicate change records');
    identities.add(identity);
    previousRevision=change.revision!;
  }
  if (
    (value.changes.length===0 && value.cursor!==since)
    || (value.changes.length>0 && previousRevision!==value.cursor)
  )throw new Error('Relay returned an invalid change cursor');
  return value;
}

async function sha256(value:Uint8Array<ArrayBuffer>):Promise<string> {
  const digest=new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',value));
  return [...digest].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}

function equalBytes(left:Uint8Array<ArrayBuffer>,right:Uint8Array<ArrayBuffer>):boolean {
  if(left.byteLength!==right.byteLength)return false;
  let difference=0;
  for(let index=0;index<left.byteLength;index++)difference|=left[index]^right[index];
  return difference===0;
}

export class EncryptedSync {
  private readonly relay: RelayClient;
  private stateOperations:Promise<void>=Promise.resolve();
  private quarantineOperations:Promise<void>=Promise.resolve();
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
      const key=SYNC_STATE_PREFIX+this.session.instanceId;
      if(this.storage.update) {
        await this.storage.update<StoredSyncState>(key,current=>{
          if(current!==null&&!isStoredSyncState(current))throw new Error('Stored sync checkpoint is invalid');
          const base=current??emptySyncState();
          const next:StoredSyncState={version:1,cursor:base.cursor,revisions:{...base.revisions}};
          change(next);
          return next;
        });
        return;
      }
      const current=await this.loadState();
      const next:StoredSyncState={version:1,cursor:current.cursor,revisions:{...current.revisions}};
      change(next);
      await this.storage.set(key,next);
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
  private quarantineKey():string {
    return QUARANTINE_PREFIX+encodeURIComponent(this.session.instanceId);
  }
  private async loadQuarantines():Promise<QuarantinedRecord[]> {
    const stored=await this.storage.get<unknown>(this.quarantineKey());
    if(stored===null)return [];
    if(!isStoredQuarantineState(stored))throw new Error('Stored sync quarantine is invalid');
    return stored.records.map(record=>({...record}));
  }
  private updateQuarantines(
    upserts:readonly QuarantinedRecord[],
    validRevisions:readonly {id:string;revision:number}[],
  ):Promise<QuarantinedRecord[]> {
    const operation=this.quarantineOperations.then(async()=>{
      const merge=(current:unknown):QuarantinedRecord[]=>{
        if(current!==null&&!isStoredQuarantineState(current)) {
          throw new Error('Stored sync quarantine is invalid');
        }
        const records=new Map(
          (current===null?[]:current.records).map(record=>[record.id,record]),
        );
        for(const {id,revision} of validRevisions) {
          const existing=records.get(id);
          if(existing&&existing.revision<=revision)records.delete(id);
        }
        for(const record of upserts) {
          const existing=records.get(record.id);
          if(!existing||existing.revision<=record.revision)records.set(record.id,{...record});
        }

        // A relay page contains at most MAX_PULL_CHANGES records, so all newly
        // quarantined records fit. Prefer them over older diagnostic history.
        const priorityIds=new Set(upserts.map(record=>record.id));
        const priority=[...records.values()]
          .filter(record=>priorityIds.has(record.id))
          .sort((left,right)=>left.revision-right.revision||left.id.localeCompare(right.id));
        const historical=[...records.values()]
          .filter(record=>!priorityIds.has(record.id))
          .sort((left,right)=>right.revision-left.revision||left.id.localeCompare(right.id))
          .slice(0,Math.max(0,MAX_QUARANTINED_RECORDS-priority.length));
        return [...historical,...priority]
          .sort((left,right)=>left.revision-right.revision||left.id.localeCompare(right.id));
      };
      let next:QuarantinedRecord[]=[];
      const key=this.quarantineKey();
      if(this.storage.update) {
        await this.storage.update<StoredQuarantineState>(key,current=>{
          next=merge(current);
          return next.length?{version:1,records:next}:null;
        });
      } else {
        const stored=await this.storage.get<unknown>(key);
        next=merge(stored);
        if(next.length)await this.storage.set(key,{version:1,records:next} satisfies StoredQuarantineState);
        else await this.storage.delete(key);
      }
      return next.map(record=>({...record}));
    });
    this.quarantineOperations=operation.then(()=>undefined,()=>undefined);
    return operation;
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
  async getQuarantinedRecords():Promise<QuarantinedRecord[]> {
    await this.quarantineOperations;
    return this.loadQuarantines();
  }

  /**
   * Persist a pull cursor only after the caller has durably applied every
   * returned note, tombstone, and attachment. Pulling by itself is read-only
   * so a failed local transaction can safely retry the same remote changes.
   */
  acknowledge(cursor:number,revisions:readonly PulledRevision[]):Promise<void> {
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      return Promise.reject(new Error('Sync cursor must be a non-negative safe integer'));
    }
    if (!Array.isArray(revisions) || revisions.length>MAX_PULL_CHANGES || revisions.some(({kind,id,revision})=>
      (kind!=='note'&&kind!=='attachment') || typeof id!=='string' || !isValidNoteId(id) || !Number.isSafeInteger(revision) || revision<0 || revision>cursor)) {
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
    try {
      await this.mutate('attachment',attachment.id,fingerprint,async baseRevision=>({
        mutationId:globalThis.crypto.randomUUID(),
        baseRevision,
        noteId,
        envelope:await encryptAttachment(bytes,this.masterKey,{ownerId:this.session.instanceId,noteId,attachmentId:attachment.id}),
        deleted:false,
        deviceId:this.session.deviceId,
      }));
    } catch(error) {
      if(!(error instanceof RelayHttpError&&error.status===409&&error.code==='attachment_immutable'))throw error;
      const acceptedRevision=await this.acceptedImmutableAttachment(noteId,attachment,bytes);
      if(acceptedRevision===null)throw error;
      await this.rememberRevision('attachment',attachment.id,acceptedRevision);
    }
  }
  private async acceptedImmutableAttachment(
    noteId:string,
    attachment:NoteAttachment,
    intendedBytes:Uint8Array<ArrayBuffer>,
  ):Promise<number|null> {
    try {
      const current=await this.relay.getAttachment(attachment.id);
      if(
        current.noteId!==noteId
        || current.deleted!==false
        || !Number.isSafeInteger(current.revision)
        || current.revision<0
        || attachment.size!==intendedBytes.byteLength
      )return null;
      const acceptedBytes=await decryptAttachment(
        current.envelope as EncryptedEnvelope,
        this.masterKey,
        {ownerId:this.session.instanceId,noteId,attachmentId:attachment.id},
      );
      return equalBytes(acceptedBytes,intendedBytes)?current.revision:null;
    } catch {
      return null;
    }
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
    const requestedSince=since??await this.getCursor();
    if(!Number.isSafeInteger(requestedSince)||requestedSince<0)throw new Error('Sync cursor must be a non-negative safe integer');
    const {changes,cursor}=validatePullResponse(await this.relay.changes(requestedSince),requestedSince);
    const notes:Note[]=[];const deletedIds:string[]=[];const attachments:PulledAttachment[]=[];
    const quarantined:QuarantinedRecord[]=[];
    const validRevisions:{id:string;revision:number}[]=[];
    const attachmentTombstones=new Map<string,PulledAttachmentTombstone>();
    for(const row of changes)if(row.kind==='attachment'&&row.deleted&&typeof row.noteId==='string')attachmentTombstones.set(row.id,{noteId:row.noteId,attachmentId:row.id});
    const latest=new Map(changes.filter(c=>c.kind==='note').map(c=>[c.id,c]));
    for(const row of latest.values()) {
      let note:Note;
      try {
        note=await decryptNote(row.envelope as EncryptedEnvelope,this.masterKey,{ownerId:this.session.instanceId,noteId:row.id});
      } catch {
        quarantined.push({kind:'note',id:row.id,revision:row.revision,reason:'note_invalid_or_undecryptable'});
        continue;
      }
      validRevisions.push({id:row.id,revision:row.revision});
      if(row.deleted||note.deleted) deletedIds.push(row.id); else {
        if(note.images?.length){const available:NoteAttachment[]=[];for(const attachment of note.images){
          if(attachmentTombstones.has(attachment.id))continue;
          try{attachments.push({noteId:note.id,attachment,bytes:await this.downloadAttachment(note.id,attachment)});available.push(attachment)}
          catch(error){if(error instanceof AttachmentDeletedError)attachmentTombstones.set(attachment.id,{noteId:error.noteId,attachmentId:attachment.id});else throw error}
        }note.images=available.length?available:undefined}
        notes.push(note);
      }
    }
    const durableQuarantines=await this.updateQuarantines(quarantined,validRevisions);
    for(const record of quarantined) {
      if(!durableQuarantines.some(durable=>
        durable.kind===record.kind&&durable.id===record.id&&durable.revision===record.revision&&durable.reason===record.reason
      ))throw new Error('Sync quarantine could not durably record a change');
    }
    return {notes,deletedIds,attachments,deletedAttachments:[...attachmentTombstones.values()],quarantined,cursor,revisions:changes.map(({kind,id,revision})=>({kind,id,revision}))};
  }
}
