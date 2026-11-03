import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {parseAuraBundle} from '../../../src/parsers/aura/parse.ts';
test('Aura helper server actions and declared controller both remain discoverable',()=>{
 const dir=mkdtempSync(join(tmpdir(),'spindle-aura-'));
 try {
 const sources={'demo.cmp':'<aura:component controller="CustomerController"/>','demoController.js':'({ init: function(c,e,h){h.load(c);} })','demoHelper.js':'({load: function(component){component.get("c.getCustomers");}})'};
 const bundleFiles=Object.entries(sources).map(([fileName,source])=>{const absolutePath=join(dir,fileName);writeFileSync(absolutePath,source);return {fileName,absolutePath};});
 const result=parseAuraBundle({kind:'aura-bundle',absolutePath:dir,relativePath:'aura/demo',contentHash:'test',bundleName:'demo',bundleFiles});
 expect(result.edges.map(e=>e.toQName)).toEqual(expect.arrayContaining(['CustomerController','CustomerController.getCustomers']));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
