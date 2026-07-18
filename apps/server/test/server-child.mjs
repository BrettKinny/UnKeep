process.env.NODE_ENV='test';

const {server}=await import('../src/index.mjs');let stopping=false;

function finish(error){
  if(error)console.error(error);
  process.exitCode=error ? 1 : 0;
  if(process.connected)process.disconnect();
}
function stop(){
  if(stopping)return;stopping=true;
  if(server.listening)server.close(finish);else finish();
}

process.on('message',message=>{if(message?.type==='stop')stop()});
process.on('disconnect',stop);process.on('SIGINT',stop);process.on('SIGTERM',stop);
server.once('error',error=>{
  if(process.connected)process.send({type:'error',error:error.message});
  finish(error);
});
server.listen(0,'127.0.0.1',()=>{
  const address=server.address();
  if(typeof address==='object'&&address&&process.connected)process.send({type:'ready',port:address.port});
});
