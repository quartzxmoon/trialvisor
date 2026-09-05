export type Identified={id:string};
export type PagedDatabase={
  list<T=Record<string,unknown>>(table:string,options?:{limit?:number;nextToken?:string}):Promise<{items:Array<T&Identified>;nextToken?:string}>;
  delete(table:string,ids:string[]):Promise<boolean[]>;
};

export const listAllMatching=async<T extends Identified>(database:PagedDatabase,table:string,predicate:(item:T)=>boolean,limit=500):Promise<T[]>=>{
  const results:T[]=[];
  let nextToken:string|undefined;
  do{
    const page=await database.list<T>(table,{limit:100,nextToken});
    for(const item of page.items||[]){
      if(predicate(item)){
        results.push(item);
        if(results.length>=limit)return results;
      }
    }
    nextToken=page.nextToken;
  }while(nextToken);
  return results;
};

export const deleteAllRecords=async(database:PagedDatabase,table:string,maxBatches=1000)=>{
  for(let batch=0;batch<maxBatches;batch++){
    const items=(await database.list(table,{limit:100})).items;
    if(!items.length)return;
    const deleted=await database.delete(table,items.map(item=>item.id));
    if(deleted.some(ok=>!ok))throw new Error('account_delete_incomplete');
  }
  throw new Error('account_delete_limit_exceeded');
};
