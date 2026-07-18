import { decryptAttachment, decryptNote, encryptAttachment, encryptNote, type EncryptedEnvelope, type Note, type NoteAttachment } from '@unkeep/core';
import { RelayClient, type RelaySession } from './relay.js';
import type { ClientStorage } from './storage.js';

const CURSOR_PREFIX = 'unkeep-sync-cursor:';
export interface PulledAttachment { noteId:string; attachment:NoteAttachment; bytes:Uint8Array<ArrayBuffer> }
export interface PulledNotes { notes:Note[]; deletedIds:string[]; attachments:PulledAttachment[]; cursor:number }

export class EncryptedSync {
  private readonly relay: RelayClient;
  constructor(private readonly session: RelaySession, private readonly masterKey: Uint8Array<ArrayBuffer>, private readonly storage:ClientStorage) {
    this.relay = new RelayClient(session.endpoint, session.credential);
  }
  async getCursor():Promise<number> { return Number(await this.storage.get<number|string>(CURSOR_PREFIX + this.session.instanceId) ?? 0); }
  private setCursor(cursor:number) { return this.storage.set(CURSOR_PREFIX + this.session.instanceId,cursor); }
  async push(note:Note):Promise<number> {
    const portable:Note={...note,images:note.images?.map(({id,name,mimeType,size})=>({id,name,mimeType,size}))};
    const envelope=await encryptNote(portable,this.masterKey,{ownerId:this.session.instanceId,noteId:note.id});
    const {revision}=await this.relay.putNote(note.id,{mutationId:globalThis.crypto.randomUUID(),envelope,deleted:note.deleted??false,deviceId:this.session.deviceId});
    return revision;
  }
  async uploadAttachment(noteId:string,attachment:NoteAttachment,bytes:Uint8Array<ArrayBuffer>):Promise<void> {
    const envelope=await encryptAttachment(bytes,this.masterKey,{ownerId:this.session.instanceId,noteId,attachmentId:attachment.id});
    await this.relay.putAttachment(attachment.id,{mutationId:globalThis.crypto.randomUUID(),noteId,envelope,deleted:false,deviceId:this.session.deviceId});
  }
  async downloadAttachment(noteId:string,attachment:NoteAttachment):Promise<Uint8Array<ArrayBuffer>> {
    const row=await this.relay.getAttachment(attachment.id);
    return decryptAttachment(row.envelope as EncryptedEnvelope,this.masterKey,{ownerId:this.session.instanceId,noteId,attachmentId:attachment.id});
  }
  async pull(since?:number):Promise<PulledNotes> {
    const {changes,cursor}=await this.relay.changes(since ?? await this.getCursor());const notes:Note[]=[];const deletedIds:string[]=[];const attachments:PulledAttachment[]=[];
    const latest=new Map(changes.filter(c=>c.kind==='note').map(c=>[c.id,c]));
    for(const row of latest.values()) {
      const note=await decryptNote(row.envelope as EncryptedEnvelope,this.masterKey,{ownerId:this.session.instanceId,noteId:row.id});
      if(row.deleted||note.deleted) deletedIds.push(row.id); else {if(note.images?.length)for(const attachment of note.images){try{attachments.push({noteId:note.id,attachment,bytes:await this.downloadAttachment(note.id,attachment)})}catch{/* Leave attachment metadata available while its bytes are unavailable. */}}notes.push(note);}
    }
    await this.setCursor(cursor);return {notes,deletedIds,attachments,cursor};
  }
}
