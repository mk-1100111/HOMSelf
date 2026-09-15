const {createApp:createCoreApp}=require('./app_core');

function installExactStockBadges(app){
  const exactStockMiddleware=(req,res,next)=>{
    const originalJson=res.json.bind(res);
    res.json=body=>{
      if((req.path==='/api/catalog'||req.path==='/api/admin/catalog-management')&&body&&Array.isArray(body.materials)){
        body={...body,materials:body.materials.map(item=>{
          if(!Number.isSafeInteger(item&&item.stock_quantity))return item;
          return {...item,reserved_stock:0,available_stock:item.stock_quantity};
        })};
      }
      return originalJson(body);
    };
    next();
  };

  // createCoreApp()가 API 라우트를 먼저 등록하므로 이 미들웨어를
  // Express 라우터의 맨 앞에 배치해 응답 직전에 재고값을 1:1로 고정한다.
  app.use(exactStockMiddleware);
  const stack=app._router&&app._router.stack;
  if(!stack||!stack.length)throw new Error('Express 라우터를 초기화할 수 없습니다.');
  stack.unshift(stack.pop());
}

function createApp(config){
  const result=createCoreApp(config);
  installExactStockBadges(result.app);
  return result;
}

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
