import { decryptAttachment, decryptNote, encryptAttachment, encryptNote, type EncryptedEnvelope, type Note, type NoteAttachment } from '@unkeep/core';
import { RelayClient, type RelaySession } from './relayClient.js';

const CURSOR_PREFIX = 'unkeep-sync-cursor:';
export interface PulledNotes { notes: Note[]; deletedIds: string[]; cursor: number }

export class EncryptedSync {
  private readonly relay: RelayClient;
  constructor(private readonly session: RelaySession, private readonly masterKey: Uint8Array<ArrayBuffer>) {
    this.relay = new RelayClient(session.endpoint, session.credential);
  }
  get cursor(): number { return Number(localStorage.getItem(CURSOR_PREFIX + this.session.instanceId) ?? 0); }
  private setCursor(cursor:number) { localStorage.setItem(CURSOR_PREFIX + this.session.instanceId,String(cursor)); }
  async push(note:Note):Promise<number> {
    const portable:Note={...note,images:note.images?.map(({id,name,mimeType,size})=>({id,name,mimeType,size}))};
    const envelope=await encryptNote(portable,this.masterKey,{ownerId:this.session.instanceId,noteId:note.id});
    const {revision}=await this.relay.putNote(note.id,{mutationId:crypto.randomUUID(),envelope,deleted:note.deleted??false,deviceId:this.session.deviceId});
    return revision;
  }
  async uploadAttachment(noteId:string,attachment:NoteAttachment,bytes:Uint8Array<ArrayBuffer>):Promise<void> {
    const envelope=await encryptAttachment(bytes,this.masterKey,{ownerId:this.session.instanceId,noteId,attachmentId:attachment.id});
    await this.relay.putAttachment(attachment.id,{mutationId:crypto.randomUUID(),noteId,envelope,deleted:false,deviceId:this.session.deviceId});
  }
  async downloadAttachment(noteId:string,attachment:NoteAttachment):Promise<NoteAttachment> {
    const row=await this.relay.getAttachment(attachment.id);
    const bytes=await decryptAttachment(row.envelope as EncryptedEnvelope,this.masterKey,{ownerId:this.session.instanceId,noteId,attachmentId:attachment.id});
    return {...attachment,url:URL.createObjectURL(new Blob([bytes],{type:attachment.mimeType}))};
  }
  async pull(since:number=this.cursor):Promise<PulledNotes> {
    const {changes,cursor}=await this.relay.changes(since); const notes:Note[]=[]; const deletedIds:string[]=[];
    const latest=new Map(changes.filter(c=>c.kind==='note').map(c=>[c.id,c]));
    for(const row of latest.values()) {
      const note=await decryptNote(row.envelope as EncryptedEnvelope,this.masterKey,{ownerId:this.session.instanceId,noteId:row.id});
      if(row.deleted||note.deleted) deletedIds.push(row.id); else { if(note.images?.length) note.images=await Promise.all(note.images.map(async attachment=>{try{return await this.downloadAttachment(note.id,attachment)}catch{return attachment}})); notes.push(note); }
    }
    this.setCursor(cursor); return {notes,deletedIds,cursor};
  }
  subscribe(onWake:()=>void):()=>void { const timer=window.setInterval(onWake,15_000); return ()=>window.clearInterval(timer); }
}
