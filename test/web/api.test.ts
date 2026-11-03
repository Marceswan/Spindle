import { test, expect } from "bun:test";
import { GraphStore } from "../../src/graph/store.ts";
import { handleApi } from "../../src/web/api.ts";

function seeded(): GraphStore {
  const store = new GraphStore(":memory:");
  store.upsertProject("/p", "p", "64.0");
  return store;
}

async function call(store: GraphStore, path: string): Promise<{ status: number; body: any }> {
  const res = await handleApi(new Request(`http://localhost${path}`), store);
  if (res === null) return { status: 404, body: null };
  return { status: res.status, body: await res.json() };
}

test("GET /api/projects returns the project list", async () => {
  const store = seeded();
  const { status, body } = await call(store, "/api/projects");
  expect(status).toBe(200);
  expect(body[0].name).toBe("p");
  store.close();
});

test("GET /api/savings returns a summary shape", async () => {
  const store = seeded();
  const { status, body } = await call(store, "/api/savings?project=1");
  expect(status).toBe(200);
  expect(body).toHaveProperty("totalTokensSaved");
  expect(body).toHaveProperty("perTool");
  store.close();
});

test("GET /api/search returns nodes/count shape", async () => {
  const store = seeded();
  const { status, body } = await call(store, "/api/search?project=1&q=Foo");
  expect(status).toBe(200);
  expect(body).toHaveProperty("nodes");
  expect(body).toHaveProperty("count");
  store.close();
});

test("missing project param is a 400", async () => {
  const store = seeded();
  const { status } = await call(store, "/api/savings");
  expect(status).toBe(400);
  store.close();
});

test("unknown /api path returns 404 json", async () => {
  const store = seeded();
  const { status } = await call(store, "/api/nope");
  expect(status).toBe(404);
  store.close();
});

test("non-/api path returns null (handled by asset layer)", async () => {
  const store = seeded();
  const res = await handleApi(new Request("http://localhost/index.html"), store);
  expect(res).toBeNull();
  store.close();
});

test('neighborhood rejects invalid ranges and cross-project centers',async()=>{
 const store=seeded();
 try {
  const other=store.upsertProject('/other','other','64.0');
  const node=store.insertNode({projectId:other,label:'ApexClass' as import('../../src/model/node-labels.ts').NodeLabel,name:'Secret',qualifiedName:'Secret'});
  for(const suffix of ['project=-1&id=1','project=1.5&id=1','project=1&id=1&depth=-1','project=1&id=1&depth=99','project=1&id=1&cap=1.5','project=1&id=1&cap=999999']){
   expect((await call(store,'/api/neighborhood?'+suffix)).status).toBe(400);
  }
  const result=await call(store,`/api/neighborhood?project=1&id=${node}`);
  expect(result.status).toBe(404);expect(JSON.stringify(result.body)).not.toContain('Secret');
 }finally{store.close();}
});
