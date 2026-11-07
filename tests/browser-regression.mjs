import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import fs from 'node:fs';
import zlib from 'node:zlib';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
if(!fs.existsSync('/tmp/al2023/lib/libnss3.so')){fs.mkdirSync('/tmp/al2023',{recursive:true});fs.writeFileSync('/tmp/al2023.tar',zlib.brotliDecompressSync(fs.readFileSync('node_modules/@sparticuz/chromium/bin/al2023.tar.br')));execFileSync('tar',['-xf','/tmp/al2023.tar','-C','/tmp/al2023']);}
process.env.LD_LIBRARY_PATH='/tmp/al2023/lib:/tmp'+(process.env.LD_LIBRARY_PATH?':'+process.env.LD_LIBRARY_PATH:'');
const browser=await puppeteer.launch({args:chromium.args,executablePath:await chromium.executablePath(),headless:true});
const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto('http://127.0.0.1:3000',{waitUntil:'networkidle2',timeout:60000});
await page.evaluate(()=>{localStorage.clear();location.reload();});await page.waitForNavigation({waitUntil:'networkidle2'});
await page.evaluate(()=>{setCurrentRole('manager');closeRoleGate();render();});
const views=await page.evaluate(()=>[...new Set([...document.querySelectorAll('[data-view]')].map(x=>x.dataset.view))]);
for(const v of views){await page.evaluate(v=>{view=v;render();},v);await new Promise(r=>setTimeout(r,120));const txt=await page.evaluate(()=>document.getElementById('content')?.innerText.trim().length||0);assert.ok(txt>0,'empty view '+v);}
const backup=await page.evaluate(async()=>{window.saveBlob=async blob=>{window.__backup=JSON.parse(await blob.text());return true;};await backupToJSON();const b=window.__backup;return !!(b&&b.data&&b.data.finance&&b.data.finance.schemaVersion===2);});assert.equal(backup,true);
console.log('views',views.length,'backup finance',backup,'pageerrors',errors);
await browser.close();assert.equal(errors.length,0);
