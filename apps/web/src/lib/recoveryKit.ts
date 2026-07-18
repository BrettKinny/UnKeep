export function downloadRecoveryKit(serializedKit:string):void {
  const blob=new Blob([serializedKit],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const anchor=document.createElement('a');
  anchor.href=url;anchor.download='unkeep-recovery-kit.json';anchor.click();URL.revokeObjectURL(url);
}
