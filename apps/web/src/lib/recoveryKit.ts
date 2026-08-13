import { MAX_RECOVERY_KIT_SERIALIZED_LENGTH } from '@unkeep/core';

export const MAX_RECOVERY_KIT_FILE_SIZE = MAX_RECOVERY_KIT_SERIALIZED_LENGTH;

export async function readRecoveryKitFile(file: File): Promise<string> {
  if (file.size > MAX_RECOVERY_KIT_FILE_SIZE) {
    throw new Error('Recovery kit is too large. Recovery kit files must be 64 KiB or smaller.');
  }
  return file.text();
}

export function downloadRecoveryKit(serializedKit:string):void {
  const blob=new Blob([serializedKit],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const anchor=document.createElement('a');
  anchor.href=url;
  anchor.download='unkeep-recovery-kit.json';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(()=>URL.revokeObjectURL(url),0);
}
