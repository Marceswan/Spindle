import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphStore } from '../../src/graph/store.ts';
import { indexProject } from '../../src/pipeline/index-project.ts';

function graph(s: GraphStore): unknown {
  return {
    nodes: s.db.query('SELECT label, qualified_name FROM nodes ORDER BY label, qualified_name').all(),
    edges: s.db.query('SELECT s.qualified_name AS s, t.qualified_name AS t, e.edge_type, e.properties FROM edges e JOIN nodes s ON s.id=e.source_id JOIN nodes t ON t.id=e.target_id ORDER BY s.qualified_name,t.qualified_name,e.edge_type,e.properties').all(),
  };
}
test('incremental graph matches fresh indexing after target edits, additions, renames and deletions', async () => {
  const dir = mkdtempSync(join(tmpdir(),'spindle-parity-'));
  const classes = join(dir,'force-app/main/default/classes'); mkdirSync(classes,{recursive:true});
  writeFileSync(join(dir,'sfdx-project.json'),JSON.stringify({packageDirectories:[{path:'force-app'}]}));
  const a=join(classes,'A.cls'), b=join(classes,'B.cls');
  writeFileSync(a,'public class A { public static void run() { B.work(); } }');
  writeFileSync(b,'public class B { public static void work() {} }');
  const store = new GraphStore(':memory:');
  try {
    await indexProject(dir,store,{mode:'full'});
    const original=graph(store);
    expect((await indexProject(dir,store,{mode:'incremental'})).filesParsed).toBe(0);
    expect(graph(store)).toEqual(original);
    for (const change of [
      () => writeFileSync(b,'public class B { public static void work() { Integer x=1; } }'),
      () => rmSync(b),
      () => writeFileSync(b,'public class B { public static void work() {} }'),
      () => renameSync(b,join(classes,'Renamed.cls')),
    ]) {
      change(); await indexProject(dir,store,{mode:'incremental'});
      const fresh=new GraphStore(':memory:');
      try { await indexProject(dir,fresh,{mode:'full'}); expect(graph(store)).toEqual(graph(fresh)); } finally {fresh.close();}
    }
    rmSync(join(classes,'Renamed.cls'));
    await indexProject(dir,store,{mode:'full'});
    expect(store.db.query("SELECT id FROM nodes WHERE name='B'").all()).toEqual([]);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});
test('failed graph publication rolls back nodes, references and file hashes', async () => {
  const dir=mkdtempSync(join(tmpdir(),'spindle-rollback-'));
  const classes=join(dir,'force-app/main/default/classes');mkdirSync(classes,{recursive:true});
  writeFileSync(join(dir,'sfdx-project.json'),JSON.stringify({packageDirectories:[{path:'force-app'}]}));
  const path=join(classes,'A.cls');writeFileSync(path,'public class A {}');
  const s=new GraphStore(':memory:');
  try {
    await indexProject(dir,s,{mode:'full'}); const before=graph(s);
    s.db.exec("CREATE TRIGGER fail_insert BEFORE INSERT ON nodes WHEN NEW.name='B' BEGIN SELECT RAISE(ABORT,'test write failure'); END");
    writeFileSync(path,'public class Changed {}');writeFileSync(join(classes,'B.cls'),'public class B {}');
    await expect(indexProject(dir,s,{mode:'incremental'})).rejects.toThrow('test write failure');
    expect(graph(s)).toEqual(before);
  } finally {s.close();rmSync(dir,{recursive:true,force:true});}
});

test('email body edits, deletion and creation invalidate the metadata inventory',async()=>{
 const {cpSync}=await import('node:fs');
 const {discoverApexFiles}=await import('../../src/pipeline/discover.ts');
 const dir=mkdtempSync(join(tmpdir(),'spindle-email-parity-'));
 cpSync(join(import.meta.dir,'../fixtures/sample-sfdx-project'),dir,{recursive:true});
 const store=new GraphStore(':memory:');
 try {
  const email=(await discoverApexFiles(dir)).find(f=>f.kind==='email-template')!;
  expect(email).toBeDefined();
  const body=email.absolutePath.replace(/-meta\.xml$/,'');
  await indexProject(dir,store,{mode:'full'});
  for(const change of [()=>writeFileSync(body,'{!Customer__c.Tier__c}'),()=>rmSync(body),()=>writeFileSync(body,'{!Customer__c.Email__c}')]){
   change();expect((await indexProject(dir,store,{mode:'incremental'})).filesParsed).toBeGreaterThan(0);
   const fresh=new GraphStore(':memory:');
   try{await indexProject(dir,fresh,{mode:'full'});expect(graph(store)).toEqual(graph(fresh));}finally{fresh.close();}
  }
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
