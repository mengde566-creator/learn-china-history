#!/usr/bin/env node
// 在隔离预览运行，不读取用户浏览器上下文。必须显式提供目标，避免误请求主站。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import {chromium} from 'playwright-core'
import {plainSourceText} from '../lib/source-layers.mjs'
const base=process.env.BASE_URL
assert.ok(base,'请显式提供隔离预览 BASE_URL')
const data=JSON.parse(fs.readFileSync(new URL('../data/content.json',import.meta.url)))
const browser=await chromium.launch({executablePath:`${os.homedir()}/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`})
const saved={read:{'liuyu/03-guanggu':{beat:2,beatCount:7,phase:'live',done:false,at:100}},review:{'liuyu/03-guanggu':{1:'known'}},last:null},results=[]
const cases=[...Array.from({length:3},(_,i)=>({p:'chenqingzhi',s:'02-guoyang',note:3,id:'006',repeat:i+1})),{p:'caocao',s:'01-wusebang'},{p:'jingke',s:'01-yanwei'},{p:'xiangyu',s:'05-xianyang'}]
const frames=p=>p.evaluate(()=>new Promise(r=>{let n=0;function next(){if(++n>=12)r();else requestAnimationFrame(next)}requestAnimationFrame(next)})),norm=x=>plainSourceText(x).replace(/\s/g,'')
async function prepare(width,c){
 const context=await browser.newContext({viewport:{width,height:1000},reducedMotion:c.repeat===3?'no-preference':'reduce'}),page=await context.newPage(),errors=[]
 page.on('pageerror',e=>errors.push(e.message));await page.goto(base);await page.evaluate(v=>localStorage.setItem('guanshi.progress.v1',JSON.stringify(v)),saved);await page.goto(`${base}/p/${c.p}/${c.s}`,{waitUntil:'networkidle'});await page.evaluate(()=>document.fonts.ready);await page.locator('.opening-notes summary').click()
 const all=page.locator('.opening-notes button.cite'),cite=c.id?page.locator('.opening-notes .mark-block').nth(c.note).getByRole('button',{name:c.id,exact:true}):all.last(),id=await cite.innerText(),at=await cite.evaluate(el=>[...document.querySelectorAll('.opening-notes button.cite')].indexOf(el));await cite.evaluate(el=>scrollTo({top:scrollY+el.getBoundingClientRect().top-480,behavior:'instant'}));await cite.click({trial:true});await frames(page);const before={y:(await cite.boundingBox()).y,scroll:await page.evaluate(()=>scrollY),storage:await page.evaluate(()=>localStorage.getItem('guanshi.progress.v1'))};await cite.click();await page.locator(`#src-${id}`).waitFor({state:'visible'});const quote=page.locator(`#src-${id} .quote`),parts=quote.locator('.source-layer-text'),text=await parts.count()?(await parts.allTextContents()).join(''):await quote.innerText();assert.equal(norm(text),norm(data.people.find(x=>x.id===c.p).source[id].text));return {context,page,errors,cite,id,at,before}
}
try{
 for(const width of process.argv.includes('--regression-only')?[390]:[390,1440])for(const c of process.argv.includes('--regression-only')?cases.slice(0,1):cases){
  const {context,page,errors,cite,id,at,before}=await prepare(width,c);await page.locator(`#src-${id} button.back`).click();await page.waitForFunction(({at,y})=>{const el=document.querySelectorAll('.opening-notes button.cite')[at];return el&&document.activeElement===el&&Math.abs(el.getBoundingClientRect().y-y)<3},{at,y:before.y},{timeout:2500});await frames(page);assert.ok(Math.abs((await cite.boundingBox()).y-before.y)<3,'返回原位偏移');assert.equal(await page.evaluate(()=>localStorage.getItem('guanshi.progress.v1')),before.storage);assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);results.push({width,p:c.p,s:c.s,repeat:c.repeat,source:id,beforeY:before.y,afterY:(await cite.boundingBox()).y});await context.close()
 }
 if(!process.argv.includes('--regression-only')){
  for(const event of ['wheel','touchstart','pointerdown','keydown']){
   const {context,page,id}=await prepare(390,cases[0]);await page.evaluate(({id,event})=>new Promise(resolve=>{document.querySelector(`#src-${id} button.back`).click();requestAnimationFrame(()=>{window.dispatchEvent(event==='keydown'?new KeyboardEvent(event,{key:'PageDown'}):new Event(event));scrollTo({top:40,behavior:'instant'});resolve()})}),{id,event});await frames(page);assert.equal(await page.evaluate(()=>scrollY),40,'延迟返回覆盖读者主动操作');results.push({event,cancelled:true});await context.close()
  }
  const {context,page,id}=await prepare(390,cases[0]);await page.evaluate(id=>{document.querySelector(`#src-${id} button.back`).click();document.querySelector('.nav a[href="/settings"]').click()},id);await page.waitForURL('**/settings');await frames(page);assert.equal(await page.evaluate(()=>scrollY),0);results.push({navigation:'settings',pendingRestoreCancelled:true});await context.close()
 }
 const output=process.env.OPENING_RETURN_RESULTS
 if(output)fs.writeFileSync(output,JSON.stringify(results,null,2));console.log('通过：入口返回原位/焦点/存储、主动操作取消与离开页面',JSON.stringify(results))
}finally{await browser.close()}
