import {test,expect} from 'bun:test';
import {GraphStore} from '../../src/graph/store.ts';
import {handler as usage} from '../../src/tools/get-field-usage.ts';
import {handler as permissions} from '../../src/tools/get-permission-access.ts';
import {recordInvocation} from '../../src/metrics/record-invocation.ts';
import {NodeLabel} from '../../src/model/node-labels.ts';
import {EdgeType} from '../../src/model/edge-types.ts';
test('field usage preserves direct write context',async()=>{
 const s=new GraphStore(':memory:');const p=s.upsertProject('/p','p',null);
 try {
 const f=s.insertNode({projectId:p,label:NodeLabel.Field,name:'Email__c',qualifiedName:'Customer__c.Email__c'});
 const m=s.insertNode({projectId:p,label:NodeLabel.ApexMethod,name:'write',qualifiedName:'C.write()'});
 s.insertEdge({projectId:p,sourceId:m,targetId:f,edgeType:EdgeType.ReferencesField,properties:{context:'DML_WRITE'}});
 const result=await usage({project_id:p,field:'Customer__c.Email__c',include_indirect:false},s) as {apex_methods:{context:string}[]};
 expect(result.apex_methods.map(x=>x.context)).toEqual(['DML_WRITE']);
 }finally{s.close();}
});
test('explicit denial is retained in graph but excluded from grants and groups',async()=>{
 const s=new GraphStore(':memory:');const p=s.upsertProject('/p','p',null);
 try {
 const target=s.insertNode({projectId:p,label:NodeLabel.ApexClass,name:'C',qualifiedName:'C'});
 const denied=s.insertNode({projectId:p,label:NodeLabel.PermissionSet,name:'Denied',qualifiedName:'Denied'});
 const allowed=s.insertNode({projectId:p,label:NodeLabel.Profile,name:'Allowed',qualifiedName:'Allowed'});
 const group=s.insertNode({projectId:p,label:NodeLabel.PermissionSetGroup,name:'Group',qualifiedName:'Group'});
 s.insertEdge({projectId:p,sourceId:denied,targetId:target,edgeType:EdgeType.GrantsApexAccess,properties:{enabled:false}});
 s.insertEdge({projectId:p,sourceId:allowed,targetId:target,edgeType:EdgeType.GrantsApexAccess,properties:{enabled:true}});
 s.insertEdge({projectId:p,sourceId:group,targetId:denied,edgeType:EdgeType.IncludesPermset});
 expect(await permissions({project_id:p,target:{type:'ApexClass',qualified_name:'C'}},s)).toMatchObject({total_grants:1,permission_sets:[],permission_set_groups:[],profiles:[{source_qualified_name:'Allowed'}]});
 }finally{s.close();}
});
test('metrics omit query literals and unrecognized source payloads',()=>{
 const s=new GraphStore(':memory:');try {
 recordInvocation(s,{projectId:null,toolName:'query_graph',params:{query:"MATCH (n) WHERE n.name='SENTINEL' RETURN n",source:'SECRET_SOURCE'},durationMs:1,resultJson:'{}',now:0});
 const value=JSON.stringify(s.db.query('SELECT params_json FROM tool_invocation').all());
 expect(value).not.toContain('SENTINEL');expect(value).not.toContain('SECRET_SOURCE');
 }finally{s.close();}
});
