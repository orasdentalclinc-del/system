import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import fs from 'node:fs';
import zlib from 'node:zlib';
import {execFileSync} from 'node:child_process';
if(!fs.existsSync('/tmp/al2023/lib/libnss3.so')){fs.mkdirSync('/tmp/al2023',{recursive:true});fs.writeFileSync('/tmp/al2023.tar',zlib.brotliDecompressSync(fs.readFileSync('node_modules/@sparticuz/chromium/bin/al2023.tar.br')));execFileSync('tar',['-xf','/tmp/al2023.tar','-C','/tmp/al2023']);}
process.env.LD_LIBRARY_PATH='/tmp/al2023/lib:/tmp'+(process.env.LD_LIBRARY_PATH?':'+process.env.LD_LIBRARY_PATH:'');
const browser=await puppeteer.launch({args:chromium.args,executablePath:await chromium.executablePath(),headless:true});
const page=await browser.newPage();
await page.goto('file://'+process.cwd()+'/docs/reception-daily-guide.html',{waitUntil:'networkidle0'});
await page.pdf({path:'docs/reception-daily-guide.pdf',format:'A4',printBackground:true,preferCSSPageSize:true});
const pdf=fs.readFileSync('docs/reception-daily-guide.pdf');
const pages=(pdf.toString('latin1').match(/\/Type\s*\/Page\b/g)||[]).length;
console.log('guide pages',pages);
await browser.close();
if(pages!==1)process.exit(1);
