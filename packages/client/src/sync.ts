import { MAX_ATTACHMENT_MIME_TYPE_LENGTH, MAX_ATTACHMENT_NAME_LENGTH, MAX_NOTE_ATTACHMENTS, MAX_NOTE_ATTACHMENT_SIZE, decryptAttachment, decryptNote, encryptAttachment, encryptNote, isValidNoteId, normalizeNoteRecord, type EncryptedEnvelope, type Note, type NoteAttachment } from '@unkeep/core';
import {
  RelayClient,
  type RelayAttachmentStageRequest,
  type RelayChange,
  type RelayCompoundNoteReceipt,
  type RelayCompoundNoteRequest,
  type RelaySession,
} from './relay.js';
import type { ClientStorage } from './storage.js';

const LEGACY_CURSOR_PREFIX = 'unkeep-sync-cursor:';
const SYNC_STATE_PREFIX = 'unkeep-sync-state:';
const PENDING_MUTATION_PREFIX = 'unkeep-pending-mutation:';
const PENDING_COMPOUND_PREFIX = 'unkeep-pending-compound:';
const PENDING_COMPOUND_STAGE_PREFIX = 'unkeep-pending-compound-stage:';
const PENDING_COMPOUND_INDEX_PREFIX = 'unkeep-pending-compound-index:';
const QUARANTINE_PREFIX = 'unkeep-sync-quarantine:';
const MAX_PULL_CHANGES = 1000;
const MAX_QUARANTINED_RECORDS = MAX_PULL_CHANGES;
const MAX_PENDING_COMPOUNDS = 100_000;
export interface PulledAttachment { noteId:string; attachment:NoteAttachment; bytes:Uint8Array<ArrayBuffer> }
export interface PulledAttachmentTombstone { noteId:string; attachmentId:string }
export interface PulledRevision { kind:RelayChange['kind']; id:string; revision:number }
export type QuarantineReason = 'note_invalid_or_undecryptable';
export interface QuarantinedRecord { kind:'note'; id:string; revision:number; reason:QuarantineReason }
export interface PulledNotes { notes:Note[]; deletedIds:string[]; attachments:PulledAttachment[]; deletedAttachments:PulledAttachmentTombstone[]; quarantined:QuarantinedRecord[]; cursor:number; revisions:PulledRevision[] }

export interface CompoundAttachmentUpload {
  attachment:NoteAttachment;
  /** Convenient for a single small attachment already resident in memory. */
  bytes?:Uint8Array<ArrayBuffer>;
  /**
   * Preferred for batches and large files. It is invoked sequentially, may be
   * invoked more than once, and must return the same bytes until commit.
   */
  loadBytes?:()=>Promise<Uint8Array<ArrayBuffer>>;
}

export interface CompoundCommitHandle {
  noteId:string;
  mutationId:string;
  fingerprint:string;
  revision:number;
  attachmentRevisions:{id:string;revision:number;contentHash:string}[];
}

export class PendingCompoundCompletionError extends Error {
  readonly name='PendingCompoundCompletionError';

  constructor(readonly handle:CompoundCommitHandle) {
    super(`Note ${handle.noteId} has a committed compound mutation awaiting local completion`);
  }
}

export class PendingMutationCredentialMismatchError extends Error {
  readonly name='PendingMutationCredentialMismatchError';

  constructor() {
    super('Stored pending mutation belongs to another credential');
  }
}

export class PendingMutationRebaseRequiresPullError extends Error {
  readonly name='PendingMutationRebaseRequiresPullError';

  constructor(readonly currentRevision:number) {
    super(
      `Pending mutation rebase requires pulled revision ${currentRevision}`,
    );
  }
}

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
  ownerCredentialHash?:string;
  payload:Record<string,unknown>;
}

interface StoredCompoundStage {
  attachmentId:string;
  attachment:NoteAttachment;
  contentHash:string;
  stageHash?:string;
}

interface StoredCompoundStagePayload {
  version:2;
  noteId:string;
  mutationId:string;
  attachmentId:string;
  contentHash:string;
  ownerCredentialHash:string;
  payload:RelayAttachmentStageRequest;
}

interface StoredCompoundNotePayload {
  baseRevision:number;
  envelope:EncryptedEnvelope;
  deleted:false;
}

interface StoredPendingCompoundMutation {
  version:2;
  noteId:string;
  fingerprint:string;
  mutationId:string;
  ownerCredentialHash:string;
  notePayload:StoredCompoundNotePayload;
  stages:StoredCompoundStage[];
  finalPayload?:RelayCompoundNoteRequest;
  committed?:RelayCompoundNoteReceipt;
}

interface StoredPendingCompoundIndex {
  version:1;
  handles:CompoundCommitHandle[];
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
    && (!Object.hasOwn(pending,'ownerCredentialHash')
      || isStageHash(pending.ownerCredentialHash))
    && Boolean(pending.payload) && typeof pending.payload==='object' && !Array.isArray(pending.payload)
    && typeof (pending.payload as Record<string,unknown>).mutationId==='string';
}

function isRecord(value:unknown):value is Record<string,unknown> {
  return Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
}

interface RelayHttpErrorLike {
  status:number;
  code:string;
}

function isRelayHttpErrorLike(value:unknown):value is RelayHttpErrorLike {
  if(!isRecord(value))return false;
  const status=Object.getOwnPropertyDescriptor(value,'status');
  const code=Object.getOwnPropertyDescriptor(value,'code');
  return Boolean(
    status
    && 'value' in status
    && Number.isSafeInteger(status.value)
    && status.value>=400
    && status.value<=599
    && code
    && 'value' in code
    && typeof code.value==='string'
    && code.value.length>0
    && code.value.length<=256
  );
}

function shouldDiscardPendingAfterRelayError(value:unknown):boolean {
  return isRelayHttpErrorLike(value)
    && value.status<500
    && ![401,403,404,408,425,429].includes(value.status);
}

function hasKeys(value:Record<string,unknown>,required:readonly string[],optional:readonly string[]=[]):boolean {
  const allowed=new Set([...required,...optional]);
  return required.every(key=>Object.hasOwn(value,key))
    && Object.keys(value).every(key=>allowed.has(key));
}

function isEnvelope(value:unknown,keyId:string):value is EncryptedEnvelope {
  return isRecord(value)
    && hasKeys(value,['version','algorithm','keyId','iv','ciphertext'])
    && value.version===1
    && value.algorithm==='AES-GCM'
    && value.keyId===keyId
    && typeof value.iv==='string'
    && /^[A-Za-z0-9+/]{16}$/.test(value.iv)
    && typeof value.ciphertext==='string'
    && value.ciphertext.length>=24
    && value.ciphertext.length%4===0
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{4})$/.test(value.ciphertext);
}

function isStageHash(value:unknown):value is string {
  return typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
}

function isPortableAttachment(value:unknown,id:string):value is NoteAttachment {
  return isRecord(value)
    && hasKeys(value,['id','name','mimeType','size'])
    && value.id===id
    && typeof value.name==='string'
    && value.name.length>0
    && value.name.length<=MAX_ATTACHMENT_NAME_LENGTH
    && typeof value.mimeType==='string'
    && value.mimeType.length>0
    && value.mimeType.length<=MAX_ATTACHMENT_MIME_TYPE_LENGTH
    && Number.isSafeInteger(value.size)
    && (value.size as number)>=0
    && (value.size as number)<=MAX_NOTE_ATTACHMENT_SIZE;
}

function isStoredCompoundStagePayload(
  value:unknown,
  expected:{
    noteId:string;
    mutationId:string;
    attachmentId:string;
    contentHash:string;
    ownerCredentialHash:string;
  },
):value is StoredCompoundStagePayload {
  return isRecord(value)
    && hasKeys(value,['version','noteId','mutationId','attachmentId','contentHash','ownerCredentialHash','payload'])
    && value.version===2
    && value.noteId===expected.noteId
    && value.mutationId===expected.mutationId
    && value.attachmentId===expected.attachmentId
    && value.contentHash===expected.contentHash
    && value.ownerCredentialHash===expected.ownerCredentialHash
    && isRecord(value.payload)
    && hasKeys(value.payload,['noteId','envelope'])
    && value.payload.noteId===expected.noteId
    && isEnvelope(value.payload.envelope,expected.attachmentId);
}

function sameJson(left:unknown,right:unknown):boolean {
  return JSON.stringify(left)===JSON.stringify(right);
}

function compareProtocolId(left:string,right:string):number {
  return left<right?-1:left>right?1:0;
}

function isStoredPendingCompoundMutation(value:unknown):value is StoredPendingCompoundMutation {
  if(!isRecord(value)||!hasKeys(
    value,
    ['version','noteId','fingerprint','mutationId','ownerCredentialHash','notePayload','stages'],
    ['finalPayload','committed'],
  ))return false;
  if(
    value.version!==2
    || typeof value.noteId!=='string'
    || !isValidNoteId(value.noteId)
    || typeof value.fingerprint!=='string'
    || !/^[a-f0-9]{64}$/.test(value.fingerprint)
    || typeof value.mutationId!=='string'
    || !isValidNoteId(value.mutationId)
    || !isStageHash(value.ownerCredentialHash)
    || !isRecord(value.notePayload)
    || !hasKeys(value.notePayload,['baseRevision','envelope','deleted'])
    || !Number.isSafeInteger(value.notePayload.baseRevision)
    || (value.notePayload.baseRevision as number)<0
    || value.notePayload.deleted!==false
    || !isEnvelope(value.notePayload.envelope,value.noteId)
    || !Array.isArray(value.stages)
    || value.stages.length===0
    || value.stages.length>MAX_NOTE_ATTACHMENTS
  )return false;

  let previousId='';
  for(const stage of value.stages) {
    if(
      !isRecord(stage)
      || !hasKeys(stage,['attachmentId','attachment','contentHash'],['stageHash'])
      || typeof stage.attachmentId!=='string'
      || !isValidNoteId(stage.attachmentId)
      || stage.attachmentId<=previousId
      || !isPortableAttachment(stage.attachment,stage.attachmentId)
      || !isStageHash(stage.contentHash)
      || (Object.hasOwn(stage,'stageHash')&&!isStageHash(stage.stageHash))
    )return false;
    previousId=stage.attachmentId;
  }

  if(Object.hasOwn(value,'finalPayload')) {
    if(
      !isRecord(value.finalPayload)
      || !hasKeys(value.finalPayload,['mutationId','baseRevision','envelope','deleted','newAttachments'])
      || value.finalPayload.mutationId!==value.mutationId
      || value.finalPayload.baseRevision!==value.notePayload.baseRevision
      || value.finalPayload.deleted!==false
      || !sameJson(value.finalPayload.envelope,value.notePayload.envelope)
      || !Array.isArray(value.finalPayload.newAttachments)
      || value.finalPayload.newAttachments.length!==value.stages.length
    )return false;
    for(let index=0;index<value.stages.length;index+=1) {
      const expected=value.stages[index];
      const attachment=value.finalPayload.newAttachments[index];
      if(
        !expected?.stageHash
        || !isRecord(attachment)
        || !hasKeys(attachment,['id','stageHash'])
        || attachment.id!==expected.attachmentId
        || attachment.stageHash!==expected.stageHash
      )return false;
    }
  }

  if(Object.hasOwn(value,'committed')) {
    if(!Object.hasOwn(value,'finalPayload')
      || !isRecord(value.committed)
      || !hasKeys(value.committed,['revision','attachmentRevisions'])
      || !Number.isSafeInteger(value.committed.revision)
      || (value.committed.revision as number)<=0
      || !Array.isArray(value.committed.attachmentRevisions)
      || value.committed.attachmentRevisions.length!==value.stages.length
    )return false;
    for(let index=0;index<value.stages.length;index+=1) {
      const revision=value.committed.attachmentRevisions[index];
      if(
        !isRecord(revision)
        || !hasKeys(revision,['id','revision'])
        || revision.id!==value.stages[index]?.attachmentId
        || !Number.isSafeInteger(revision.revision)
        || revision.revision!==(value.committed.revision as number)-value.stages.length+index
      )return false;
    }
  }
  return true;
}

function isStoredPendingCompoundIndex(value:unknown):value is StoredPendingCompoundIndex {
  if(!isRecord(value)
    || !hasKeys(value,['version','handles'])
    || value.version!==1
    || !Array.isArray(value.handles)
    || value.handles.length>MAX_PENDING_COMPOUNDS
  )return false;
  let previous='';
  return value.handles.every(handle=>{
    if(!isCompoundCommitHandle(handle)||handle.noteId<=previous)return false;
    previous=handle.noteId;
    return true;
  });
}

function isCompoundCommitHandle(value:unknown):value is CompoundCommitHandle {
  if(!isRecord(value)
    || !hasKeys(value,['noteId','mutationId','fingerprint','revision','attachmentRevisions'])
    || typeof value.noteId!=='string'
    || !isValidNoteId(value.noteId)
    || typeof value.mutationId!=='string'
    || !isValidNoteId(value.mutationId)
    || typeof value.fingerprint!=='string'
    || !/^[a-f0-9]{64}$/.test(value.fingerprint)
    || !Number.isSafeInteger(value.revision)
    || (value.revision as number)<=0
    || !Array.isArray(value.attachmentRevisions)
    || value.attachmentRevisions.length===0
  )return false;
  const attachmentRevisions=value.attachmentRevisions;
  const revision=value.revision as number;
  return attachmentRevisions.every((item,index)=>
    isRecord(item)
    && hasKeys(item,['id','revision','contentHash'])
    && typeof item.id==='string'
    && isValidNoteId(item.id)
    && Number.isSafeInteger(item.revision)
    && isStageHash(item.contentHash)
    && item.revision===revision-attachmentRevisions.length+index
    && (index===0||item.id>(attachmentRevisions[index-1] as {id:string}).id)
  );
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
  private readonly credentialIdentity:Promise<string>;
  private stateOperations:Promise<void>=Promise.resolve();
  private quarantineOperations:Promise<void>=Promise.resolve();
  private readonly mutationOperations=new Map<string,Promise<unknown>>();
  private readonly foreignMutationRebaseProofs=new Map<
    string,
    {pending:StoredPendingMutation;currentRevision:number}
  >();

  constructor(private readonly session: RelaySession, private readonly masterKey: Uint8Array<ArrayBuffer>, private readonly storage:ClientStorage) {
    this.relay = new RelayClient(session.endpoint, session.credential);
    this.credentialIdentity=sha256(new TextEncoder().encode(session.credential));
  }
  private async requirePendingCredential(ownerCredentialHash:string):Promise<void> {
    if(ownerCredentialHash!==await this.credentialIdentity) {
      throw new PendingMutationCredentialMismatchError();
    }
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
  private pendingCompoundKey(noteId:string):string {
    return `${PENDING_COMPOUND_PREFIX}${encodeURIComponent(this.session.instanceId)}:${encodeURIComponent(noteId)}`;
  }
  private pendingCompoundStageKey(mutationId:string,attachmentId:string):string {
    return `${PENDING_COMPOUND_STAGE_PREFIX}${encodeURIComponent(this.session.instanceId)}:${encodeURIComponent(mutationId)}:${encodeURIComponent(attachmentId)}`;
  }
  private pendingCompoundIndexKey():string {
    return PENDING_COMPOUND_INDEX_PREFIX+encodeURIComponent(this.session.instanceId);
  }
  private pendingCompoundIndex(value:unknown):StoredPendingCompoundIndex {
    if(value===null)return {version:1,handles:[]};
    if(!isStoredPendingCompoundIndex(value))throw new Error('Stored pending compound index is invalid');
    return value;
  }
  private async installPendingCompound(
    key:string,
    candidate:StoredPendingCompoundMutation,
  ):Promise<StoredPendingCompoundMutation> {
    if(!this.storage.transact) {
      throw new Error('Compound mutations require transactional client storage');
    }
    const indexKey=this.pendingCompoundIndexKey();
    let selected=candidate;
    await this.storage.transact([key,indexKey],transaction=>{
      const current=transaction.get<unknown>(key);
      if(current!==null) {
        if(!isStoredPendingCompoundMutation(current)||current.noteId!==candidate.noteId) {
          throw new Error('Stored pending compound mutation is invalid');
        }
        selected=current;
      }
      const index=this.pendingCompoundIndex(transaction.get<unknown>(indexKey));
      transaction.set(key,selected);
      if(index.handles.length)transaction.set(indexKey,index);
    });
    return selected;
  }
  private atomicCompoundUpdate(
    key:string,
    change:(value:StoredPendingCompoundMutation|null)=>StoredPendingCompoundMutation|null,
  ):Promise<void> {
    const validate=(value:unknown):StoredPendingCompoundMutation|null=>{
      if(value===null)return null;
      if(!isStoredPendingCompoundMutation(value))throw new Error('Stored pending compound mutation is invalid');
      return value;
    };
    if(this.storage.update) {
      return this.storage.update<unknown>(key,current=>change(validate(current)));
    }
    if(this.storage.transact) {
      return this.storage.transact([key],transaction=>{
        const next=change(validate(transaction.get<unknown>(key)));
        if(next===null)transaction.delete(key);
        else transaction.set(key,next);
      });
    }
    return Promise.reject(new Error('Compound mutations require atomic client storage updates'));
  }
  private async installCompoundStagePayload(
    rootKey:string,
    key:string,
    candidate:StoredCompoundStagePayload,
  ):Promise<StoredCompoundStagePayload> {
    const expected={
      noteId:candidate.noteId,
      mutationId:candidate.mutationId,
      attachmentId:candidate.attachmentId,
      contentHash:candidate.contentHash,
      ownerCredentialHash:candidate.ownerCredentialHash,
    };
    let selected=candidate;
    const select=(current:unknown):StoredCompoundStagePayload=>{
      if(current===null)return candidate;
      if(!isStoredCompoundStagePayload(current,expected)) {
        throw new Error('Stored pending compound attachment payload is invalid');
      }
      selected=current;
      return current;
    };
    if(!this.storage.transact)throw new Error('Compound mutations require transactional client storage');
    await this.storage.transact([rootKey,key],transaction=>{
      const root=transaction.get<unknown>(rootKey);
      const rootStage=isStoredPendingCompoundMutation(root)
        ? root.stages.find(stage=>stage.attachmentId===candidate.attachmentId)
        : undefined;
      if(!isStoredPendingCompoundMutation(root)
        || root.mutationId!==candidate.mutationId
        || root.committed
        || !rootStage
        || rootStage.contentHash!==candidate.contentHash
        || Boolean(rootStage.stageHash)
      )throw new Error('Stored pending compound mutation changed before attachment encryption');
      transaction.set(key,select(transaction.get<unknown>(key)));
    });
    return selected;
  }
  private async loadPendingCompound(key:string,noteId:string):Promise<StoredPendingCompoundMutation|null> {
    const value=await this.storage.get<unknown>(key);
    if(value===null)return null;
    if(!isStoredPendingCompoundMutation(value)||value.noteId!==noteId) {
      throw new Error('Stored pending compound mutation is invalid');
    }
    return value;
  }
  private compoundHandle(pending:StoredPendingCompoundMutation):CompoundCommitHandle {
    if(!pending.committed)throw new Error('Compound mutation has not committed');
    return {
      noteId:pending.noteId,
      mutationId:pending.mutationId,
      fingerprint:pending.fingerprint,
      revision:pending.committed.revision,
      attachmentRevisions:pending.committed.attachmentRevisions.map(({id,revision})=>{
        const stage=pending.stages.find(candidate=>candidate.attachmentId===id);
        if(!stage)throw new Error('Stored pending compound mutation is invalid');
        return {id,revision,contentHash:stage.contentHash};
      }),
    };
  }
  private async indexedCompoundHandle(
    pending:StoredPendingCompoundMutation,
  ):Promise<CompoundCommitHandle> {
    const handle=this.compoundHandle(pending);
    const index=this.pendingCompoundIndex(
      await this.storage.get<unknown>(this.pendingCompoundIndexKey()),
    );
    if(!index.handles.some(candidate=>sameJson(candidate,handle))) {
      throw new Error('Stored pending compound index is invalid');
    }
    return handle;
  }
  private async discardUncommittedCompound(
    key:string,
    pending:StoredPendingCompoundMutation,
    rejectedFinalPayload?:RelayCompoundNoteRequest,
  ):Promise<void> {
    if(!this.storage.transact)throw new Error('Compound mutations require transactional client storage');
    const indexKey=this.pendingCompoundIndexKey();
    const stageKeys=pending.stages.map(stage=>
      this.pendingCompoundStageKey(pending.mutationId,stage.attachmentId));
    await this.storage.transact([key,indexKey,...stageKeys],transaction=>{
      const current=transaction.get<unknown>(key);
      const index=this.pendingCompoundIndex(transaction.get<unknown>(indexKey));
      if(current===null) {
        if(index.handles.some(handle=>handle.mutationId===pending.mutationId)) {
          throw new Error('Stored pending compound index is invalid');
        }
        return;
      }
      if(!isStoredPendingCompoundMutation(current)) {
        throw new Error('Stored pending compound mutation is invalid');
      }
      if(current.mutationId!==pending.mutationId||current.committed)return;
      if(rejectedFinalPayload) {
        if(!current.finalPayload||!sameJson(current.finalPayload,rejectedFinalPayload))return;
      } else if(current.finalPayload)return;
      if(index.handles.some(handle=>handle.noteId===pending.noteId)) {
        throw new Error('Stored pending compound index is invalid');
      }
      for(const stageKey of stageKeys)transaction.delete(stageKey);
      transaction.delete(key);
    });
  }
  private rememberCompoundReceipt(noteId:string,receipt:RelayCompoundNoteReceipt):Promise<void> {
    return this.updateState(state=>{
      for(const {id,revision} of receipt.attachmentRevisions) {
        const key=revisionKey('attachment',id);
        state.revisions[key]=Math.max(state.revisions[key]??0,revision);
      }
      const key=revisionKey('note',noteId);
      state.revisions[key]=Math.max(state.revisions[key]??0,receipt.revision);
    });
  }
  private compoundResumeSources(
    pending:StoredPendingCompoundMutation,
    uploads:readonly CompoundAttachmentUpload[],
  ):Map<string,()=>Promise<Uint8Array<ArrayBuffer>>> {
    if(!Array.isArray(uploads)||uploads.length>pending.stages.length) {
      throw new Error('Compound resume attachment sources are invalid');
    }
    const sources=new Map<string,()=>Promise<Uint8Array<ArrayBuffer>>>();
    for(const upload of uploads) {
      if(!upload
        || typeof upload!=='object'
        || !upload.attachment
        || typeof upload.attachment!=='object'
        || ((upload.bytes instanceof Uint8Array)===(typeof upload.loadBytes==='function'))
        || sources.has(upload.attachment.id)
      )throw new Error('Compound resume attachment source is invalid');
      const stage=pending.stages.find(candidate=>candidate.attachmentId===upload.attachment.id);
      const {id,name,mimeType,size}=upload.attachment;
      if(!stage
        || stage.attachment.name!==name
        || stage.attachment.mimeType!==mimeType
        || stage.attachment.size!==size
      )throw new Error(`Compound resume attachment ${id} does not match the pending bundle`);
      sources.set(id,upload.bytes instanceof Uint8Array
        ? async()=>upload.bytes!
        : upload.loadBytes!);
    }
    return sources;
  }
  private async sendPendingCompound(
    key:string,
    initial:StoredPendingCompoundMutation,
    sources:ReadonlyMap<string,()=>Promise<Uint8Array<ArrayBuffer>>>,
    allowCredentialHandoff=false,
  ):Promise<CompoundCommitHandle> {
    let pending=initial;
    if(pending.committed) {
      await this.rememberCompoundReceipt(pending.noteId,pending.committed);
      return this.indexedCompoundHandle(pending);
    }
    if(!allowCredentialHandoff) {
      await this.requirePendingCredential(pending.ownerCredentialHash);
    }

    for(const staged of pending.stages) {
      const payloadKey=this.pendingCompoundStageKey(pending.mutationId,staged.attachmentId);
      if(staged.stageHash) {
        await this.storage.delete(payloadKey);
        continue;
      }
      let storedPayload=await this.storage.get<unknown>(payloadKey);
      if(storedPayload===null) {
        const load=sources.get(staged.attachmentId);
        if(!load)throw new Error(`Attachment bytes are required to resume ${staged.attachmentId}`);
        const bytes=await load();
        if(!(bytes instanceof Uint8Array)
          || bytes.byteLength!==staged.attachment.size
          || await sha256(bytes)!==staged.contentHash
        )throw new Error(`Compound attachment ${staged.attachmentId} changed before encryption`);
        const payload:StoredCompoundStagePayload={
          version:2,
          noteId:pending.noteId,
          mutationId:pending.mutationId,
          attachmentId:staged.attachmentId,
          contentHash:staged.contentHash,
          ownerCredentialHash:pending.ownerCredentialHash,
          payload:{
            noteId:pending.noteId,
            envelope:await encryptAttachment(
              bytes,
              this.masterKey,
              {
                ownerId:this.session.instanceId,
                noteId:pending.noteId,
                attachmentId:staged.attachmentId,
              },
            ),
          },
        };
        storedPayload=await this.installCompoundStagePayload(key,payloadKey,payload);
      }
      if(!isStoredCompoundStagePayload(storedPayload,{
        noteId:pending.noteId,
        mutationId:pending.mutationId,
        attachmentId:staged.attachmentId,
        contentHash:staged.contentHash,
        ownerCredentialHash:pending.ownerCredentialHash,
      }))throw new Error('Stored pending compound attachment payload is invalid');
      let stageHash:string;
      try {
        ({stageHash}=await this.relay.stageNoteAttachment(
          pending.mutationId,
          staged.attachmentId,
          storedPayload.payload,
        ));
      } catch(error) {
        if(!allowCredentialHandoff&&shouldDiscardPendingAfterRelayError(error)) {
          await this.discardUncommittedCompound(key,pending);
        }
        throw error;
      }
      await this.atomicCompoundUpdate(key,current=>{
        if(current===null||current.mutationId!==pending.mutationId) {
          throw new Error('Stored pending compound mutation changed while staging');
        }
        const index=current.stages.findIndex(stage=>stage.attachmentId===staged.attachmentId);
        const currentStage=current.stages[index];
        if(!currentStage)throw new Error('Stored pending compound mutation is invalid');
        if(currentStage.stageHash&&currentStage.stageHash!==stageHash) {
          throw new Error('Relay returned inconsistent attachment stage receipts');
        }
        if(currentStage.stageHash)return current;
        const stages=current.stages.map((stage,stageIndex)=>
          stageIndex===index?{...stage,stageHash}:stage);
        return {...current,stages};
      });
      await this.storage.delete(payloadKey);
      pending=(await this.loadPendingCompound(key,pending.noteId))!;
      if(pending.committed) {
        await this.rememberCompoundReceipt(pending.noteId,pending.committed);
        return this.indexedCompoundHandle(pending);
      }
    }

    await this.atomicCompoundUpdate(key,current=>{
      if(current===null||current.mutationId!==pending.mutationId) {
        throw new Error('Stored pending compound mutation changed before finalization');
      }
      if(current.finalPayload||current.committed)return current;
      if(current.stages.some(stage=>!stage.stageHash)) {
        throw new Error('Stored pending compound mutation has incomplete stages');
      }
      const finalPayload:RelayCompoundNoteRequest={
        mutationId:current.mutationId,
        baseRevision:current.notePayload.baseRevision,
        envelope:current.notePayload.envelope,
        deleted:false,
        newAttachments:current.stages.map(stage=>({
          id:stage.attachmentId,
          stageHash:stage.stageHash!,
        })),
      };
      return {...current,finalPayload};
    });
    pending=(await this.loadPendingCompound(key,pending.noteId))!;
    if(pending.committed) {
      await this.rememberCompoundReceipt(pending.noteId,pending.committed);
      return this.indexedCompoundHandle(pending);
    }
    if(!pending.finalPayload)throw new Error('Stored pending compound mutation is invalid');
    const finalPayload=pending.finalPayload;

    let receipt:RelayCompoundNoteReceipt;
    try {
      receipt=await this.relay.finalizeNoteWithAttachments(pending.noteId,finalPayload);
    } catch(error) {
      if(!allowCredentialHandoff&&shouldDiscardPendingAfterRelayError(error)) {
        await this.discardUncommittedCompound(key,pending,finalPayload);
      }
      throw error;
    }
    await this.rememberCompoundReceipt(pending.noteId,receipt);
    if(!this.storage.transact)throw new Error('Compound mutations require transactional client storage');
    const indexKey=this.pendingCompoundIndexKey();
    await this.storage.transact([key,indexKey],transaction=>{
      const current=transaction.get<unknown>(key);
      if(!isStoredPendingCompoundMutation(current)
        || current.mutationId!==pending.mutationId
        || !current.finalPayload
      ) {
        throw new Error('Stored pending compound mutation changed after finalization');
      }
      const index=this.pendingCompoundIndex(transaction.get<unknown>(indexKey));
      if(current.committed) {
        if(!sameJson(current.committed,receipt)) {
          throw new Error('Relay returned inconsistent compound note receipts');
        }
        const expected=this.compoundHandle(current);
        if(!index.handles.some(handle=>sameJson(handle,expected))) {
          throw new Error('Stored pending compound index is invalid');
        }
        return;
      }
      const committed:StoredPendingCompoundMutation={...current,committed:receipt};
      const handle=this.compoundHandle(committed);
      const handles=[
        ...index.handles.filter(existing=>existing.noteId!==pending.noteId),
        handle,
      ].sort((left,right)=>compareProtocolId(left.noteId,right.noteId));
      if(handles.length>MAX_PENDING_COMPOUNDS)throw new Error('Too many pending compound mutations');
      transaction.set(key,committed);
      transaction.set(indexKey,{version:1,handles} satisfies StoredPendingCompoundIndex);
    });
    pending=(await this.loadPendingCompound(key,pending.noteId))!;
    return this.indexedCompoundHandle(pending);
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
          .sort((left,right)=>left.revision-right.revision||compareProtocolId(left.id,right.id));
        const historical=[...records.values()]
          .filter(record=>!priorityIds.has(record.id))
          .sort((left,right)=>right.revision-left.revision||compareProtocolId(left.id,right.id))
          .slice(0,Math.max(0,MAX_QUARANTINED_RECORDS-priority.length));
        return [...historical,...priority]
          .sort((left,right)=>left.revision-right.revision||compareProtocolId(left.id,right.id));
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
    if(pending.ownerCredentialHash) {
      await this.requirePendingCredential(pending.ownerCredentialHash);
    }
    let result:{revision:number};
    try {
      result=pending.kind==='note'
        ? await this.relay.putNote(pending.id,pending.payload)
        : await this.relay.putAttachment(pending.id,pending.payload);
    } catch(error) {
      // A deterministic client error did not leave an ambiguous successful
      // request to retry. Network, parse, and server failures remain pending.
      if(pending.ownerCredentialHash&&shouldDiscardPendingAfterRelayError(error)) {
        await this.storage.delete(key);
      }
      throw error;
    }
    await this.rememberRevision(pending.kind,pending.id,result.revision);
    await this.storage.delete(key);
    return result.revision;
  }
  private async sendPendingAfterCredentialChange(
    key:string,
    pending:StoredPendingMutation,
  ):Promise<number> {
    const vault=await this.relay.vault();
    if(vault.vaultId!==this.session.instanceId) {
      throw new Error('Relay returned inconsistent vault identity');
    }
    const result=pending.kind==='note'
      ? await this.relay.putNote(pending.id,pending.payload)
      : await this.relay.putAttachment(pending.id,pending.payload);
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
        ownerCredentialHash:await this.credentialIdentity,
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
  /**
   * Atomically commits a note and its newly-added attachment bytes. The exact
   * encrypted bundle remains durable after the relay accepts it. Call
   * completeCompoundCommit only after the caller has durably confirmed its
   * local attachment uploads and compare-cleared the matching note outbox.
   */
  async commitNoteWithAttachments(
    note:Note,
    uploads:readonly CompoundAttachmentUpload[],
  ):Promise<CompoundCommitHandle> {
    const portable=normalizeNoteRecord(note);
    if(portable.deleted)throw new Error('A deleted note cannot add attachments');
    if(!Array.isArray(uploads)||uploads.length===0) {
      throw new Error('A compound note mutation requires at least one attachment');
    }

    const key=this.pendingCompoundKey(portable.id);
    return this.runMutation(key,async()=>{
      const metadata=new Map((portable.images??[]).map(attachment=>[attachment.id,attachment]));
      const prepared:{
        attachment:NoteAttachment;
        load:()=>Promise<Uint8Array<ArrayBuffer>>;
        contentHash:string;
      }[]=[];
      const identities=new Set<string>();
      for(const upload of uploads) {
        if(
          !upload
          || typeof upload!=='object'
          || !upload.attachment
          || typeof upload.attachment!=='object'
          || ((upload.bytes instanceof Uint8Array)===(typeof upload.loadBytes==='function'))
        )throw new Error('A compound attachment upload is invalid');
        const {id,name,mimeType,size}=upload.attachment;
        const expected=metadata.get(id);
        if(
          identities.has(id)
          || !expected
          || expected.name!==name
          || expected.mimeType!==mimeType
          || expected.size!==size
        )throw new Error(`Compound attachment ${id} does not match the note metadata`);
        identities.add(id);
        const load=upload.bytes instanceof Uint8Array
          ? async()=>upload.bytes!
          : upload.loadBytes!;
        const bytes=await load();
        if(!(bytes instanceof Uint8Array)||bytes.byteLength!==size) {
          throw new Error(`Compound attachment ${id} does not match the note metadata and bytes`);
        }
        prepared.push({
          attachment:{id,name,mimeType,size},
          load,
          contentHash:await sha256(bytes as Uint8Array<ArrayBuffer>),
        });
      }
      prepared.sort((left,right)=>compareProtocolId(left.attachment.id,right.attachment.id));
      const fingerprint=await sha256(new TextEncoder().encode(JSON.stringify({
        note:portable,
        attachments:prepared.map(({attachment,contentHash})=>({
          ...attachment,
          bytes:contentHash,
        })),
      })));
      const sources=new Map(prepared.map(({attachment,load})=>[attachment.id,load]));
      const existing=await this.loadPendingCompound(key,portable.id);
      if(existing) {
        const handle=await this.sendPendingCompound(key,existing,sources);
        if(existing.fingerprint!==fingerprint)throw new PendingCompoundCompletionError(handle);
        return handle;
      }

      const baseRevision=await this.knownRevision('note',portable.id);
      const mutationId=globalThis.crypto.randomUUID();
      const noteEnvelope=await encryptNote(
        portable,
        this.masterKey,
        {ownerId:this.session.instanceId,noteId:portable.id},
      );
      const candidate:StoredPendingCompoundMutation={
        version:2,
        noteId:portable.id,
        fingerprint,
        mutationId,
        ownerCredentialHash:await this.credentialIdentity,
        notePayload:{
          baseRevision,
          envelope:noteEnvelope,
          deleted:false,
        },
        stages:prepared.map(({attachment,contentHash})=>({
          attachmentId:attachment.id,
          attachment,
          contentHash,
        })),
      };

      const selected=await this.installPendingCompound(key,candidate);
      const handle=await this.sendPendingCompound(key,selected,sources);
      if(selected.fingerprint!==fingerprint)throw new PendingCompoundCompletionError(handle);
      return handle;
    });
  }

  /**
   * Resumes only an already-durable bundle. Exact persisted stage payloads and
   * the final payload need no source; loaders are required only for attachment
   * stages that had not yet persisted their encrypted payload.
   */
  resumePendingCompoundCommit(
    noteId:string,
    uploads:readonly CompoundAttachmentUpload[] = [],
  ):Promise<CompoundCommitHandle|null> {
    if(!isValidNoteId(noteId))return Promise.reject(new Error('Note ID is invalid'));
    const key=this.pendingCompoundKey(noteId);
    return this.runMutation(key,async()=>{
      const pending=await this.loadPendingCompound(key,noteId);
      if(!pending)return null;
      const sources=this.compoundResumeSources(pending,uploads);
      return this.sendPendingCompound(key,pending,sources);
    });
  }

  /**
   * Explicitly retries a foreign-credential bundle only after authenticating
   * the current credential to this exact vault. Any rejection preserves the
   * original durable bundle so invalid or read-only credentials cannot erase
   * the last exact payload.
   */
  resumePendingCompoundCommitAfterCredentialChange(
    noteId:string,
    uploads:readonly CompoundAttachmentUpload[] = [],
  ):Promise<CompoundCommitHandle|null> {
    if(!isValidNoteId(noteId))return Promise.reject(new Error('Note ID is invalid'));
    const key=this.pendingCompoundKey(noteId);
    return this.runMutation(key,async()=>{
      const pending=await this.loadPendingCompound(key,noteId);
      if(!pending)return null;
      if(pending.ownerCredentialHash===await this.credentialIdentity) {
        const sources=this.compoundResumeSources(pending,uploads);
        return this.sendPendingCompound(key,pending,sources);
      }
      const vault=await this.relay.vault();
      if(vault.vaultId!==this.session.instanceId) {
        throw new Error('Relay returned inconsistent vault identity');
      }
      const sources=this.compoundResumeSources(pending,uploads);
      return this.sendPendingCompound(key,pending,sources,true);
    });
  }

  /**
   * Explicitly retries an exact ordinary note or attachment payload after a
   * credential replacement. The current credential must authenticate to the
   * same vault; every failed authentication or write leaves the old retry
   * root untouched.
   */
  resumePendingMutationAfterCredentialChange(
    kind:RelayChange['kind'],
    id:string,
  ):Promise<number|null> {
    if((kind!=='note'&&kind!=='attachment')||!isValidNoteId(id)) {
      return Promise.reject(new Error('Pending mutation identity is invalid'));
    }
    const key=this.pendingMutationKey(kind,id);
    return this.runMutation(key,async()=>{
      const pending=await this.storage.get<unknown>(key);
      if(pending===null)return null;
      if(!isStoredPendingMutation(pending)||pending.kind!==kind||pending.id!==id) {
        throw new Error(`Stored pending ${kind} mutation is invalid`);
      }
      if(!pending.ownerCredentialHash
        || pending.ownerCredentialHash===await this.credentialIdentity
      )return this.sendPending(key,pending);
      try {
        const revision=await this.sendPendingAfterCredentialChange(key,pending);
        this.foreignMutationRebaseProofs.delete(key);
        return revision;
      } catch(error) {
        if(
          isRelayHttpErrorLike(error)
          && error.status===409
          && error.code==='record_conflict'
          && Number.isSafeInteger(
            (error as {currentRevision?:unknown}).currentRevision,
          )
          && Number((error as {currentRevision?:unknown}).currentRevision)>=0
        ) {
          this.foreignMutationRebaseProofs.set(key,{
            pending,
            currentRevision:Number(
              (error as {currentRevision?:unknown}).currentRevision,
            ),
          });
        }
        throw error;
      }
    });
  }

  /**
   * Retires only the exact foreign retry that this SDK instance just proved
   * stale with an authenticated `record_conflict`. The caller must retain the
   * desired plaintext/outbox and issue a fresh mutation against pulled state.
   */
  abandonPendingMutationAfterCredentialChange(
    kind:RelayChange['kind'],
    id:string,
  ):Promise<boolean> {
    if((kind!=='note'&&kind!=='attachment')||!isValidNoteId(id)) {
      return Promise.reject(new Error('Pending mutation identity is invalid'));
    }
    const key=this.pendingMutationKey(kind,id);
    return this.runMutation(key,async()=>{
      const snapshot=await this.storage.get<unknown>(key);
      if(snapshot===null)return false;
      if(!isStoredPendingMutation(snapshot)||snapshot.kind!==kind||snapshot.id!==id) {
        throw new Error(`Stored pending ${kind} mutation is invalid`);
      }
      if(!snapshot.ownerCredentialHash
        || snapshot.ownerCredentialHash===await this.credentialIdentity
      )return false;
      const proof=this.foreignMutationRebaseProofs.get(key);
      if(!proof||!sameJson(proof.pending,snapshot))return false;
      if(!this.storage.transact) {
        throw new Error('Credential handoff requires transactional client storage');
      }
      let abandoned=false;
      await this.storage.transact([key],transaction=>{
        const current=transaction.get<unknown>(key);
        if(current===null)return;
        if(!isStoredPendingMutation(current)
          || current.kind!==kind
          || current.id!==id
        )throw new Error(`Stored pending ${kind} mutation is invalid`);
        if(!sameJson(current,snapshot))return;
        transaction.delete(key);
        abandoned=true;
      });
      if(abandoned)this.foreignMutationRebaseProofs.delete(key);
      return abandoned;
    });
  }

  /**
   * Atomically replaces the exact foreign note retry that this instance just
   * proved stale with a freshly encrypted mutation for the current credential.
   * A crash leaves either the old retry or the complete replacement root.
   */
  async rebasePendingNoteAfterCredentialChange(note:Note):Promise<number> {
    const portable=normalizeNoteRecord({
      ...note,
      images:note.images?.map(({id,name,mimeType,size})=>({id,name,mimeType,size})),
    });
    const fingerprint=await sha256(
      new TextEncoder().encode(JSON.stringify(portable)),
    );
    const key=this.pendingMutationKey('note',portable.id);
    return this.runMutation(key,async()=>{
      const snapshot=await this.storage.get<unknown>(key);
      if(!isStoredPendingMutation(snapshot)
        || snapshot.kind!=='note'
        || snapshot.id!==portable.id
      )throw new Error('Stored pending note mutation is invalid');
      if(!snapshot.ownerCredentialHash
        || snapshot.ownerCredentialHash===await this.credentialIdentity
      )throw new Error('Stored pending note mutation does not belong to a replaced credential');
      const proof=this.foreignMutationRebaseProofs.get(key);
      if(!proof||!sameJson(proof.pending,snapshot)) {
        throw new Error('Stored pending note mutation has no current authenticated rebase proof');
      }
      const knownRevision=await this.knownRevision('note',portable.id);
      if(knownRevision<proof.currentRevision) {
        throw new PendingMutationRebaseRequiresPullError(proof.currentRevision);
      }
      const replacement:StoredPendingMutation={
        version:1,
        kind:'note',
        id:portable.id,
        fingerprint,
        ownerCredentialHash:await this.credentialIdentity,
        payload:{
          mutationId:globalThis.crypto.randomUUID(),
          baseRevision:knownRevision,
          envelope:await encryptNote(portable,this.masterKey,{
            ownerId:this.session.instanceId,
            noteId:portable.id,
          }),
          deleted:portable.deleted??false,
          deviceId:this.session.deviceId,
        },
      };
      if(!this.storage.transact) {
        throw new Error('Credential handoff requires transactional client storage');
      }
      let installed=false;
      await this.storage.transact([key],transaction=>{
        const current=transaction.get<unknown>(key);
        if(!sameJson(current,snapshot))return;
        transaction.set(key,replacement);
        installed=true;
      });
      if(!installed)throw new Error('Stored pending note mutation changed during credential rebase');
      this.foreignMutationRebaseProofs.delete(key);
      return this.sendPending(key,replacement);
    });
  }

  /**
   * Abandons a caller-authorized bundle only before finalization can be in
   * flight. Relay-committed or finalizing bundles are deliberately retained.
   */
  cancelPendingCompoundCommit(noteId:string):Promise<boolean> {
    if(!isValidNoteId(noteId))return Promise.reject(new Error('Note ID is invalid'));
    const key=this.pendingCompoundKey(noteId);
    return this.runMutation(key,async()=>{
      const snapshot=await this.loadPendingCompound(key,noteId);
      if(!snapshot||snapshot.committed||snapshot.finalPayload)return false;
      if(!this.storage.transact)throw new Error('Compound mutations require transactional client storage');
      const indexKey=this.pendingCompoundIndexKey();
      const stageKeys=snapshot.stages.map(stage=>
        this.pendingCompoundStageKey(snapshot.mutationId,stage.attachmentId));
      let cancelled=false;
      await this.storage.transact([key,indexKey,...stageKeys],transaction=>{
        const stored=transaction.get<unknown>(key);
        const index=this.pendingCompoundIndex(transaction.get<unknown>(indexKey));
        if(stored===null)return;
        if(!isStoredPendingCompoundMutation(stored)) {
          throw new Error('Stored pending compound mutation is invalid');
        }
        if(stored.mutationId!==snapshot.mutationId
          || stored.committed
          || stored.finalPayload
        )return;
        if(index.handles.some(handle=>handle.noteId===noteId)) {
          throw new Error('Stored pending compound index is invalid');
        }
        for(const stageKey of stageKeys)transaction.delete(stageKey);
        transaction.delete(key);
        cancelled=true;
      });
      return cancelled;
    });
  }

  /**
   * Explicitly retires an uncommitted bundle owned by a replaced credential.
   * Callers use this only when their durable note outbox and attachment bytes
   * can rebuild the mutation under the current credential.
   */
  abandonPendingCompoundAfterCredentialChange(noteId:string):Promise<boolean> {
    if(!isValidNoteId(noteId))return Promise.reject(new Error('Note ID is invalid'));
    const key=this.pendingCompoundKey(noteId);
    return this.runMutation(key,async()=>{
      const snapshot=await this.loadPendingCompound(key,noteId);
      if(!snapshot||snapshot.committed)return false;
      if(snapshot.ownerCredentialHash===await this.credentialIdentity)return false;
      if(!this.storage.transact)throw new Error('Compound mutations require transactional client storage');
      const indexKey=this.pendingCompoundIndexKey();
      const stageKeys=snapshot.stages.map(stage=>
        this.pendingCompoundStageKey(snapshot.mutationId,stage.attachmentId));
      let abandoned=false;
      await this.storage.transact([key,indexKey,...stageKeys],transaction=>{
        const stored=transaction.get<unknown>(key);
        const index=this.pendingCompoundIndex(transaction.get<unknown>(indexKey));
        if(stored===null)return;
        if(!isStoredPendingCompoundMutation(stored)) {
          throw new Error('Stored pending compound mutation is invalid');
        }
        if(
          stored.mutationId!==snapshot.mutationId
          || stored.ownerCredentialHash!==snapshot.ownerCredentialHash
          || stored.committed
        )return;
        if(index.handles.some(handle=>handle.noteId===noteId)) {
          throw new Error('Stored pending compound index is invalid');
        }
        for(const stageKey of stageKeys)transaction.delete(stageKey);
        transaction.delete(key);
        abandoned=true;
      });
      return abandoned;
    });
  }

  /**
   * Recovery hook for the crash window after a caller clears its note outbox
   * but before it clears this SDK record. It returns only relay-committed
   * bundles and never resumes network mutation work.
   */
  pendingCompoundCommit(noteId:string):Promise<CompoundCommitHandle|null> {
    if(!isValidNoteId(noteId))return Promise.reject(new Error('Note ID is invalid'));
    const key=this.pendingCompoundKey(noteId);
    return this.runMutation(key,async()=>{
      const pending=await this.loadPendingCompound(key,noteId);
      if(pending?.committed)return this.indexedCompoundHandle(pending);
      const index=this.pendingCompoundIndex(
        await this.storage.get<unknown>(this.pendingCompoundIndexKey()),
      );
      if(index.handles.some(handle=>handle.noteId===noteId)) {
        throw new Error('Stored pending compound index is invalid');
      }
      return null;
    });
  }

  /**
   * Lists every relay-committed bundle whose caller-side completion has not
   * been acknowledged. The durable index makes handles discoverable even
   * after a caller already cleared its outbox or clip intent.
   */
  async pendingCompoundCommits():Promise<CompoundCommitHandle[]> {
    await Promise.all([...this.mutationOperations.values()].map(operation=>operation.catch(()=>undefined)));
    if(!this.storage.transact)throw new Error('Compound mutations require transactional client storage');
    const indexKey=this.pendingCompoundIndexKey();
    for(let attempt=0;attempt<3;attempt+=1) {
      const snapshot=this.pendingCompoundIndex(await this.storage.get<unknown>(indexKey));
      const keys=[
        indexKey,
        ...snapshot.handles.map(handle=>this.pendingCompoundKey(handle.noteId)),
      ];
      let changed=false;
      let handles:CompoundCommitHandle[]=[];
      await this.storage.transact(keys,transaction=>{
        const current=this.pendingCompoundIndex(transaction.get<unknown>(indexKey));
        if(!sameJson(current,snapshot)) {
          changed=true;
          return;
        }
        handles=current.handles.map(indexed=>{
          const root=transaction.get<unknown>(this.pendingCompoundKey(indexed.noteId));
          if(!isStoredPendingCompoundMutation(root)||!root.committed) {
            throw new Error('Stored pending compound index is invalid');
          }
          const actual=this.compoundHandle(root);
          if(!sameJson(actual,indexed))throw new Error('Stored pending compound index is invalid');
          return actual;
        });
      });
      if(!changed)return handles;
    }
    throw new Error('Stored pending compound index changed during recovery');
  }

  /**
   * Atomically removes only the persisted bundle represented by this exact
   * committed handle. A stale or altered handle leaves newer state untouched.
   */
  completeCompoundCommit(handle:CompoundCommitHandle):Promise<boolean> {
    if(!isCompoundCommitHandle(handle))return Promise.reject(new Error('Compound commit handle is invalid'));
    const key=this.pendingCompoundKey(handle.noteId);
    return this.runMutation(key,async()=>{
      if(!this.storage.transact)throw new Error('Compound mutations require transactional client storage');
      const indexKey=this.pendingCompoundIndexKey();
      let completed=false;
      await this.storage.transact([key,indexKey],transaction=>{
        const stored=transaction.get<unknown>(key);
        const index=this.pendingCompoundIndex(transaction.get<unknown>(indexKey));
        if(stored===null) {
          if(index.handles.some(candidate=>candidate.noteId===handle.noteId)) {
            throw new Error('Stored pending compound index is invalid');
          }
          return;
        }
        if(!isStoredPendingCompoundMutation(stored)) {
          throw new Error('Stored pending compound mutation is invalid');
        }
        const current=stored;
        if(!current.committed)return;
        const matches=current.noteId===handle.noteId
          && current.mutationId===handle.mutationId
          && current.fingerprint===handle.fingerprint
          && current.committed.revision===handle.revision
          && current.committed.attachmentRevisions.length===handle.attachmentRevisions.length
          && current.committed.attachmentRevisions.every((revision,index)=>{
            const expected=handle.attachmentRevisions[index];
            const stage=current.stages[index];
            return revision.id===expected?.id
              && revision.revision===expected.revision
              && stage?.attachmentId===expected.id
              && stage.contentHash===expected.contentHash;
          });
        const indexed=index.handles.some(candidate=>sameJson(candidate,handle));
        if(matches!==indexed)throw new Error('Stored pending compound index is invalid');
        if(!matches)return;
        completed=true;
        transaction.delete(key);
        const handles=index.handles.filter(candidate=>candidate.noteId!==handle.noteId);
        if(handles.length)transaction.set(indexKey,{version:1,handles} satisfies StoredPendingCompoundIndex);
        else transaction.delete(indexKey);
      });
      return completed;
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
      if(!(isRelayHttpErrorLike(error)&&error.status===409&&error.code==='attachment_immutable'))throw error;
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
