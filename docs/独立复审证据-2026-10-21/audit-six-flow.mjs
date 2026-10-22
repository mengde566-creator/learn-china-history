import { chromium } from 'playwright-core';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';
const root=path.resolve('..'), out=path.join(root,'screens');fs.mkdirSync(out,{recursive:true});
const data=JSON.parse(fs.readFileSync('data/content.json'));const people=data.people.filter(p=>['xiangyu','hanxin','zuti','chenqingzhi','liuyu','xinqiji'].includes(p.id));
const b=await chromium.launch({executablePath:path.join(os.homedir(),'Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')});
const results=[];const settle=p=>p.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
try{for(const width of [390,1324]){const c=await b.newContext({viewport:{width,height:900},reducedMotion:'reduce'});const p=await c.newPage();let errs=[];p.on('pageerror',e=>errs.push(e.message));
for(const person of people)for(const [idx,entry] of person.storyList.entries()){const s=person.stories[entry.id];const key=person.id+'/'+entry.id;const result={key,width,steps:[],errors:[]};results.push(result);
try{await p.goto('http://127.0.0.1:3112/p/'+person.id,{waitUntil:'networkidle'});await p.locator('a[href="/p/'+key+'"]').first().click();await p.locator('button.cta').click();await p.evaluate(()=>document.fonts.ready);await settle(p);result.steps.push('人物入口');
await p.screenshot({path:path.join(out,person.id+'-'+entry.id+'-'+width+'-reading.png')});
for(const beat of s.beats){await p.locator('#beat-'+beat.n).scrollIntoViewIfNeeded();await p.evaluate(n=>{const el=document.getElementById('beat-'+n);window.scrollTo({top:scrollY+el.getBoundingClientRect().top-110,behavior:'instant'})},beat.n);await settle(p);
if(beat.n===3){await p.waitForFunction(k=>JSON.parse(localStorage.getItem('guanshi.progress.v1')||'{}').read?.[k]?.beat>=3,key);const saved=await p.evaluate(k=>JSON.parse(localStorage.getItem('guanshi.progress.v1')).read[k],key);await p.reload({waitUntil:'networkidle'});await p.evaluate(()=>document.fonts.ready);await settle(p);const current=await p.evaluate(k=>JSON.parse(localStorage.getItem('guanshi.progress.v1')).read[k],key);assert.equal(current.beat,saved.beat);assert.equal(current.done,saved.done);const rect=await p.locator('#beat-'+saved.beat).boundingBox();assert.ok(rect.y>=55&&rect.y<700,'续读不在视口 '+JSON.stringify(rect));result.steps.push('刷新续读');}}
await p.locator('.reader-after').waitFor();result.steps.push('读完');
const before=await p.evaluate(()=>JSON.parse(localStorage.getItem('guanshi.progress.v1')).review);
const cards=p.locator('.cards .card');assert.equal(await cards.count(),s.cards.length);
for(let i=0;i<s.cards.length;i++){await cards.nth(i).getByRole('button',{name:'点开看答案 ▸',exact:true}).click();assert.ok((await cards.nth(i).locator('div.a').innerText()).trim());}
assert.deepEqual(await p.evaluate(()=>JSON.parse(localStorage.getItem('guanshi.progress.v1')).review),before,'展开自动改复习状态');
await cards.first().getByRole('button',{name:'已掌握',exact:true}).click();await p.reload({waitUntil:'networkidle'});await settle(p);await p.locator('.reader-after').waitFor();await p.locator('.cards .card').first().getByRole('button',{name:'点开看答案 ▸',exact:true}).click();assert.equal(await p.locator('.cards .card').first().getByRole('button',{name:'已掌握',exact:true}).getAttribute('aria-pressed'),'true');result.steps.push('全部复习卡展开/状态刷新');
await p.locator('button.ask-after').click();const qs=p.locator('.seed-nav button');assert.equal(await qs.count(),s.seeds.length);for(let i=0;i<s.seeds.length;i++){await qs.nth(i).click();assert.equal(await qs.nth(i).getAttribute('aria-current'),'true');assert.ok((await p.locator('.seed-view').innerText()).trim());}await p.keyboard.press('Escape');result.steps.push('全部静态追问点击');
assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'横向溢出');
const next=person.storyList[idx+1];if(next){await p.locator('a.next').click();await p.waitForURL('**/p/'+person.id+'/'+next.id);result.steps.push('下一篇');}else{await p.goto('http://127.0.0.1:3112/p/'+person.id);result.steps.push('末篇返回人物');}
result.errors.push(...errs);errs=[];
}catch(e){result.errors.push(e.message);errs=[];}fs.writeFileSync(path.join(root,'flow-results.json'),JSON.stringify(results,null,2));console.log(width,key,result.errors.length?'FAIL '+result.errors.join(';'):'OK');}
await c.close();}}finally{await b.close();}
