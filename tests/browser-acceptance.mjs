import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import fs from 'node:fs';
import zlib from 'node:zlib';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
if(!fs.existsSync('/tmp/al2023/lib/libnss3.so')){fs.mkdirSync('/tmp/al2023',{recursive:true});fs.writeFileSync('/tmp/al2023.tar',zlib.brotliDecompressSync(fs.readFileSync('node_modules/@sparticuz/chromium/bin/al2023.tar.br')));execFileSync('tar',['-xf','/tmp/al2023.tar','-C','/tmp/al2023']);}
process.env.LD_LIBRARY_PATH='/tmp/al2023/lib:/tmp'+(process.env.LD_LIBRARY_PATH?':'+process.env.LD_LIBRARY_PATH:'');
const browser=await puppeteer.launch({args:chromium.args,executablePath:await chromium.executablePath(),headless:true});
const page=await browser.newPage();
await page.setViewport({width:1400,height:1000});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto('http://127.0.0.1:3000',{waitUntil:'networkidle2',timeout:60000});
await page.evaluate(()=>{localStorage.clear();location.reload();});
await page.waitForNavigation({waitUntil:'networkidle2'});
await page.evaluate(()=>{setCurrentRole('manager');closeRoleGate();view='reports';render();});
await page.waitForSelector('[data-fin-tab="setup"]');
await page.click('[data-fin-tab="setup"]');
await page.waitForSelector('#finPriceForm');
// Publish prices from existing procedures
await page.evaluate(()=>{const f=document.getElementById('finPriceForm');f.effectiveFrom.value='2026-01-01';f.reason.value='أسعار اختبار المتصفح';procedures.forEach(p=>{const i=f.querySelector(`[name="price_${p.id}"]`);if(i)i.value=p.cost||1000;});f.requestSubmit();});
await new Promise(r=>setTimeout(r,300));
// Doctor policy
await page.evaluate(()=>{const f=document.getElementById('finDoctorForm');f.doctor.value='د. اختبار';f.effectiveFrom.value='2026-01-01';f.method.value='revenue_percent';f.rate.value='10';f.requestSubmit();});
await new Promise(r=>setTimeout(r,200));
// Material and FX
await page.evaluate(()=>{const f=document.getElementById('finMaterialForm');f.month.value='2026-10';f.amount.value='200';f.source.value='جرد اختبار';f.requestSubmit();});
await new Promise(r=>setTimeout(r,200));
await page.evaluate(()=>{const f=document.getElementById('finFxForm');f.rate.value='1000';f.effectiveFrom.value='2026-01-01';f.reason.value='سعر اختبار';f.requestSubmit();});
await new Promise(r=>setTimeout(r,200));
// Add visit via UI form
await page.evaluate(()=>{view='new-visit';render();});
await page.waitForSelector('#vForm');
await page.evaluate(()=>{const f=document.getElementById('vForm');f.date.value='2026-10-10';f.doctor.value='د. اختبار';f.querySelector('[name="confirmed"]').checked=true;f.arrivalTime.value='09:00';f.startTime.value='09:10';f.endTime.value='09:40';f.querySelector('.proc-select').selectedIndex=0;f.querySelector('.proc-cost').value=f.querySelector('.proc-select').selectedOptions[0].dataset.cost;f.querySelector('.proc-qty').value='2';f.paid.value='1000';f.paymentDate.value='2026-10-10';calcVisitTotals();f.requestSubmit();});
await new Promise(r=>setTimeout(r,400));
let st=await page.evaluate(()=>({visits:visits.length, invoices:OrasFinanceBridge.state.invoices.length, cash:OrasFinanceBridge.state.cashEvents.length, toast:document.getElementById('toast').textContent}));
console.log('visit save',st);assert.ok(st.invoices>=1);assert.ok(st.cash>=1);
// Generic expense 10% should block issue
await page.evaluate(()=>{view='reports';render();});
await page.waitForSelector('[data-fin-tab="dash"]');
await page.evaluate(()=>{const C=OrasFinanceCore,B=OrasFinanceBridge;const r=C.computeReport(B.state,{year:2026,month:10,visits});const amt=C.round2((r.expenses||1000)/9);const out=C.addExpense(B.state,{title:'عام سهواً',amount:amt,paidDate:'2026-10-20',accrualMonth:'2026-10',category:'عام'},B.meta());return B.commit(out.state,()=>expenses.push({id:out.expense.id,title:'عام سهواً',amount:amt,date:'2026-10-20',category:'عام'}));});
await page.evaluate(()=>{const f=document.getElementById('finMonth');f.value='2026-10';f.dispatchEvent(new Event('change',{bubbles:true}));});
await new Promise(r=>setTimeout(r,200));
const blocked=await page.evaluate(()=>document.querySelector('[data-fin-action="issue"]').disabled);
assert.equal(blocked,true);
console.log('generic expense blocks issue',blocked);
// Zero price service rejected via core/UI bridge
const zero=await page.evaluate(()=>{try{OrasFinanceCore.publishPriceBook(OrasFinanceBridge.state,{effectiveFrom:'2026-11-01',approvedBy:'مدير',items:[{id:'z',name:'صفر',cost:0}]},{});return false;}catch(e){return e.message;}});
assert.match(zero,/صفر/);console.log('zero price rejected',zero);
// Remove generic expense by reversal to allow issue
await page.evaluate(()=>{const B=OrasFinanceBridge,C=OrasFinanceCore;const ex=B.state.expenses.find(e=>e.versions.at(-1).category==='عام');const out=C.reverseExpense(B.state,ex.id,'2026-10',B.meta({reason:'إلغاء بند عام اختباري'}));return B.commit(out.state,()=>{expenses=expenses.filter(e=>e.id!==ex.id);});});
await page.evaluate(()=>{view='reports';render();});
await new Promise(r=>setTimeout(r,200));
// Issue and close October
await page.evaluate(()=>{document.querySelector('[data-fin-action="issue"]').click();});
await new Promise(r=>setTimeout(r,300));
let issues=await page.evaluate(()=>OrasFinanceBridge.state.reportIssues.length);assert.ok(issues>=1);
await page.evaluate(()=>{document.querySelector('[data-fin-action="close"]').click();});
await new Promise(r=>setTimeout(r,300));
const closed=await page.evaluate(()=>OrasFinanceBridge.state.closings.some(c=>c.month==='2026-10'));assert.equal(closed,true);
// Correct invoice in closed month via edit visit
const vid=await page.evaluate(()=>visits.find(v=>v.date==='2026-10-10').id);
await page.evaluate(id=>{editingVisitId=id;view='edit-visit';render();},vid);
await page.waitForSelector('#vForm [name="correctionReason"]');
await page.evaluate(()=>{const f=document.getElementById('vForm');f.correctionReason.value='تصحيح كمية بعد الإغلاق';f.querySelector('.proc-qty').value='3';calcVisitTotals();f.requestSubmit();});
await new Promise(r=>setTimeout(r,400));
const corr=await page.evaluate(()=>{const inv=OrasFinanceBridge.state.invoices.find(i=>i.visitId===visits.find(v=>v.date==='2026-10-10').id);return{versions:inv.versions.length,posting:inv.versions.at(-1).postingMonth,old:inv.versions[0].net,new:inv.versions.at(-1).net};});
console.log('closed correction',corr);assert.ok(corr.versions>=2);assert.notEqual(corr.posting,'2026-10');
// Empty August in series
await page.evaluate(()=>{view='reports';render();});
await page.click('[data-fin-tab="dash"]');
await page.waitForSelector('#finMonth');
await page.evaluate(()=>{const f=document.getElementById('finMonth');f.value='2026-08';f.dispatchEvent(new Event('change',{bubbles:true}));});
await new Promise(r=>setTimeout(r,200));
const aug=await page.evaluate(()=>document.body.innerText.includes('2026-08')&&document.body.innerText.includes('لا بيانات'));assert.equal(aug,true);
// FX change 30%
await page.click('[data-fin-tab="setup"]');
await page.waitForSelector('#finFxForm');
await page.evaluate(()=>{const f=document.getElementById('finFxForm');f.rate.value='1300';f.effectiveFrom.value='2026-11-01';f.reason.value='تغيير 30%';f.requestSubmit();});
await new Promise(r=>setTimeout(r,300));
const fx=await page.evaluate(()=>OrasFinanceBridge.state.fxHistory.at(-1));assert.equal(fx.changePct,30);
const usd=await page.evaluate(()=>{const C=OrasFinanceCore,B=OrasFinanceBridge;const r=C.computeReport(B.state,{year:2026,month:10,visits});return {sdg:r.revenue,usd:r.revenueUSD,rate:r.fxRate};});assert.equal(usd.rate,1300);assert.equal(usd.usd,Math.round((usd.sdg/1300)*100)/100);
// Print PDF A4 and check pages
await page.click('[data-fin-tab="print"]');
await page.waitForSelector('.fin-screen .fin-page');
await page.evaluate(()=>{document.body.classList.add('printing-finance');let area=document.getElementById('financePrintArea');if(!area){area=document.createElement('div');area.id='financePrintArea';document.body.appendChild(area);}area.innerHTML=document.querySelector('.fin-screen').innerHTML;});
await page.pdf({path:'/tmp/oras-report.pdf',format:'A4',printBackground:true,preferCSSPageSize:true});
const pdf=fs.readFileSync('/tmp/oras-report.pdf');const pages=(pdf.toString('latin1').match(/\/Type\s*\/Page\b/g)||[]).length;console.log('pdf pages',pages);assert.equal(pages,4);
const firstPageText=await page.evaluate(()=>document.querySelector('#financePrintArea .fin-page')?.innerText||'');assert.ok(firstPageText.includes('ما المشكلة'));assert.ok(firstPageText.includes('المطلوب'));
// Backup includes finance
const backup=await page.evaluate(()=>{const d={patients,visits,expenses,finance:OrasFinanceBridge.snapshot()};return !!d.finance&&d.finance.schemaVersion===2;});assert.equal(backup,true);
console.log('pageerrors',errors);
await browser.close();
assert.equal(errors.length,0);
console.log('BROWSER ACCEPTANCE PASS (synthetic; original October still not verified)');
