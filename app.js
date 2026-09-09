const {createApp}=require('./app_core');
module.exports={createApp};

if(require.main===module){
  const {prepareStartupConfig}=require('./bootstrap');
  prepareStartupConfig(process.env).then(config=>{
    const {app,store}=createApp(config);
    const server=app.listen(config.PORT||3000,()=>console.log('HOMSelf 시작: 승인 시트의 항목은 일괄 불출 시작 전까지 대기합니다.'));
    for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close(()=>{store.close();process.exit(0);}));
  }).catch(error=>{
    console.error('HOMSelf 시작 실패:',error.name||'Error',error.message||String(error));
    process.exit(1);
  });
}
