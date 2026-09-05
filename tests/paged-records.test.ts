import assert from 'node:assert/strict';
import test from 'node:test';
import { deleteAllRecords, listAllMatching, type Identified, type PagedDatabase } from '../backend/paged-records.ts';

type RecordValue=Identified&{status:string;dueAt:string};

const databaseFor=(seed:RecordValue[])=>{
  const records=[...seed];
  let listCalls=0,deleteCalls=0;
  const database:PagedDatabase={
    async list<T>(_table,options){
      listCalls++;
      const offset=Number(options?.nextToken||0),limit=options?.limit||100;
      const items=records.slice(offset,offset+limit) as Array<T&Identified>;
      const nextToken=offset+limit<records.length?String(offset+limit):undefined;
      return{items,nextToken};
    },
    async delete(_table,ids){
      deleteCalls++;
      return ids.map(id=>{const index=records.findIndex(item=>item.id===id);if(index<0)return false;records.splice(index,1);return true});
    }
  };
  return{database,records,counts:()=>({listCalls,deleteCalls})};
};

test('discovers a due pending job beyond the former 100-record boundary',async()=>{
  const resolved=Array.from({length:120},(_,index)=>({id:'resolved-'+index,status:index%2?'DONE':'REVOKED',dueAt:'2026-01-01T00:00:00.000Z'}));
  const due={id:'due-after-boundary',status:'PENDING',dueAt:'2026-09-01T00:00:00.000Z'};
  const state=databaseFor([...resolved,due]);
  const matches=await listAllMatching<RecordValue>(state.database,'jobs',item=>item.status==='PENDING'&&item.dueAt<='2026-09-05T00:00:00.000Z',20);
  assert.deepEqual(matches.map(item=>item.id),['due-after-boundary']);
  assert.equal(state.counts().listCalls,2);
});

test('deletes every record across repeated 100-record batches',async()=>{
  const state=databaseFor(Array.from({length:257},(_,index)=>({id:'record-'+index,status:'DONE',dueAt:'2026-01-01T00:00:00.000Z'})));
  await deleteAllRecords(state.database,'tenant-data');
  assert.equal(state.records.length,0);
  assert.deepEqual(state.counts(),{listCalls:4,deleteCalls:3});
});

test('fails closed when a batch deletion is incomplete',async()=>{
  const database:PagedDatabase={
    async list<T>(){return{items:[{id:'record-1'} as T&Identified]}},
    async delete(){return[false]}
  };
  await assert.rejects(()=>deleteAllRecords(database,'tenant-data'),/account_delete_incomplete/);
});
