import { test, expect } from 'bun:test';
import { GraphStore } from '../../src/graph/store.ts';
import { searchNodes, getNeighborhood } from '../../src/graph/queries.ts';
import { handler } from '../../src/tools/query-graph.ts';
import { NodeLabel } from '../../src/model/node-labels.ts';

test('search filters the entire candidate set before limiting matches', () => {
 const s=new GraphStore(':memory:'); const p=s.upsertProject('/p','p',null);
 try {
  s.transaction(()=>{for(let i=0;i<1001;i++)s.insertNode({projectId:p,label:NodeLabel.ApexClass,name:`Class${i}`,qualifiedName:`Class${i}`,properties:{last:i===1000}});});
  expect(searchNodes(s,{projectId:p,qualifiedNamePattern:'^Class1000$',limit:1}).map(n=>n.name)).toEqual(['Class1000']);
  expect(searchNodes(s,{projectId:p,propertyFilters:{last:true},limit:1}).map(n=>n.name)).toEqual(['Class1000']);
  expect(searchNodes(s,{projectId:p,namePattern:'missing',limit:1})).toEqual([]);
 } finally {s.close();}
});
test('Cypher rejects unknown operators and mixed aggregates, treats literals literally, and paginates counts',async()=>{
 const s=new GraphStore(':memory:');const p=s.upsertProject('/p','p',null);
 try {
  for(const name of ['Class0','DELETE','a_b','a%b','WITH','CALL'])s.insertNode({projectId:p,label:NodeLabel.ApexClass,name,qualifiedName:name});
  const call=(query:string)=>handler({project_id:p,query},s) as Promise<{error?:string;rows?:unknown[][]}>;
  expect((await call("MATCH (n) WHERE n.name != 'Class0' RETURN n.name")).error).toBeDefined();
  for(const keyword of ['DELETE','WITH','CALL'])expect((await call(`MATCH (n) WHERE n.name = '${keyword}' RETURN n.name`)).rows).toEqual([[keyword]]);
  expect((await call("MATCH (n) WHERE n.name CONTAINS '_' RETURN n.name")).rows).toEqual([['a_b']]);
  expect((await call("MATCH (n) WHERE n.name CONTAINS '%' RETURN n.name")).rows).toEqual([['a%b']]);
  expect((await call('MATCH (n) RETURN n.name,count(n)')).error).toBeDefined();
  expect((await call('MATCH (n) RETURN count(n) LIMIT 0')).rows).toEqual([]);
  expect((await call('MATCH (n) RETURN count(n) SKIP 1')).rows).toEqual([]);
 } finally {s.close();}
});
test('neighborhood cannot return a center belonging to another project',()=>{
 const s=new GraphStore(':memory:');const a=s.upsertProject('/a','a',null),b=s.upsertProject('/b','b',null);
 try {const n=s.insertNode({projectId:b,label:NodeLabel.ApexClass,name:'Secret',qualifiedName:'Secret'});expect(getNeighborhood(s,a,n).nodes).toEqual([]);}finally{s.close();}
});
test('multiword predicates allow whitespace while malformed keyword and string syntax fails',async()=>{
 const s=new GraphStore(':memory:');const p=s.upsertProject('/syntax','syntax',null);
 try {
  s.insertNode({projectId:p,label:NodeLabel.ApexClass,name:'abc',qualifiedName:'abc'});
  const call=(query:string)=>handler({project_id:p,query},s) as Promise<{error?:string;rows?:unknown[][]}>;
  expect((await call("MATCH (n) WHERE n.name STARTS   WITH 'a' RETURN n.name")).rows).toEqual([['abc']]);
  expect((await call("MATCH (n) WHERE n.name STARTS 'a' RETURN n.name")).error).toBeDefined();
  expect((await call("MATCH (n) RETURN n ORDER n.name")).error).toBeDefined();
 }finally{s.close();}
});
test('Unicode prefix and suffix filters count characters consistently',async()=>{
 const s=new GraphStore(':memory:');const p=s.upsertProject('/unicode','unicode',null);
 try {
  for(const name of ['😀ABC','ABC😀'])s.insertNode({projectId:p,label:NodeLabel.ApexClass,name,qualifiedName:name});
  const call=(query:string)=>handler({project_id:p,query},s) as Promise<{rows?:unknown[][]}>;
  expect((await call("MATCH (n) WHERE n.name STARTS WITH '😀' RETURN n.name")).rows).toEqual([['😀ABC']]);
  expect((await call("MATCH (n) WHERE n.name ENDS WITH '😀' RETURN n.name")).rows).toEqual([['ABC😀']]);
 }finally{s.close();}
});
