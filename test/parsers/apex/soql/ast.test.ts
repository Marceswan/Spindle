import {test,expect} from 'bun:test';
import {parseApex} from '../../../../src/parsers/apex/parse.ts';
test('real Apex SOQL tree preserves boolean, sort and literal token boundaries',()=>{
 const parsed=parseApex('/p/C.cls',"public class C { public void run() { List<Customer__c> rows=[SELECT Limit__c FROM Customer__c WHERE Email__c!=null AND Tier__c='WHERE' ORDER BY Email__c DESC]; } }");
 const refs=parsed.edges.filter(e=>e.edgeType==='REFERENCES_FIELD');
 expect(refs.map(e=>[e.toQName,e.properties?.context])).toEqual(expect.arrayContaining([
  ['Customer__c.Limit__c','SOQL_SELECT'],['Customer__c.Email__c','SOQL_WHERE'],['Customer__c.Tier__c','SOQL_WHERE'],['Customer__c.Email__c','SOQL_ORDERBY']
 ]));
 expect(refs).toHaveLength(4);
});
