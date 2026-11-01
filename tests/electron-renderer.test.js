'use strict';

// Browser exercise of the real frontend + real encrypted SQLite store through
// a test-only synchronous transport. The actual preload/IPC contract is tested
// separately; this is not a substitute for running the Windows executable.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium: playwright } = require('playwright-core');
const chromiumPackage = require('@sparticuz/chromium');
const { EncryptedStore, MIGRATION_KEY } = require('../secure-database');

const root = path.resolve(__dirname, '..');
const PASS = 'correct-passphrase-for-tests';
const PATIENTS = 'oras-dental-patients-v3';
const VISITS = 'oras-dental-visits-v3';
const RECOVERY = 'oras-dental-before-restore-v1';
let server, browser, baseURL;
const services = new Map();

before(async () => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/__rpc/')) {
      const service = services.get(url.pathname.slice('/__rpc/'.length));
      if (!service || req.method !== 'POST') { res.writeHead(404).end(); return; }
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const data = JSON.parse(body);
        let value = null;
        switch (data.operation) {
          case 'status': value={ok:true,exists:service.store.exists()}; break;
          case 'unlock': value={ok:true,...service.store.open(data.passphrase)}; break;
          case 'get':
            if (service.failGetKey === data.key) throw Object.assign(new Error('injected read failure'), {code:'INJECTED'});
            value = service.store.getItem(data.key); break;
          case 'set': service.writeCount++; service.store.setItem(data.key, data.value); break;
          case 'remove': service.writeCount++; service.store.removeItem(data.key); break;
          case 'batch': service.writeCount++; service.store.setMany(data.entries); break;
          case 'import-legacy': service.writeCount++; value = service.store.importLegacy(data.entries); break;
          case 'backup': service.store.copyEncryptedTo(service.backup); value = { ok: true, canceled: false }; break;
          default: throw new Error('Unknown operation');
        }
        res.writeHead(200, {'Content-Type':'application/json'}).end(JSON.stringify({ok:true,value}));
      } catch (error) {
        res.writeHead(200, {'Content-Type':'application/json'}).end(JSON.stringify({ok:false,code:error.code,message:error.message}));
      }
      return;
    }
    const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).slice(1);
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    try {
      const data = await fsp.readFile(file);
      res.writeHead(200, {'Content-Type': file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8'}).end(data);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
  const executablePath = process.env.CHROME_PATH || await chromiumPackage.default.executablePath();
  const libDir = await chromiumPackage.inflate(path.join(root, 'node_modules/@sparticuz/chromium/bin/al2023.tar.br'));
  const args = process.env.CHROME_PATH ? ['--no-sandbox'] : chromiumPackage.default.args.filter(arg => arg !== '--disable-web-security' && arg !== '--single-process');
  browser = await playwright.launch({ executablePath, args, headless:true, env: { ...process.env, LD_LIBRARY_PATH: [path.join(libDir,'lib'),process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') } });
});

after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

async function createEnvironment(t, {legacy={}, failGetKey=null} = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'oras-renderer-test-'));
  const filename = path.join(dir, 'clinic.sqlite3');
  const token = crypto.randomBytes(12).toString('hex');
  const store = new EncryptedStore(filename); store.open(PASS);
  const service = { store, filename, backup:path.join(dir,'backup.orasdb'), failGetKey, writeCount:0 };
  services.set(token, service);
  // The test-only RPC uses HTTP; production Electron forbids renderer network access via CSP.
  const context = await browser.newContext({ timezoneId:'Africa/Khartoum', reducedMotion:'reduce', bypassCSP:true });
  const errors = [];
  context.on('page', page => page.on('pageerror', error => errors.push(error.stack || error.message)));
  await context.addInitScript(({token,legacy}) => {
    if (location.protocol !== 'http:') return; // about:blank has an opaque origin
    if (!sessionStorage.getItem('__legacy_seeded__')) {
      for (const [key,value] of Object.entries(legacy)) localStorage.setItem(key,value);
      sessionStorage.setItem('__legacy_seeded__','1');
    }
    function call(operation, payload={}) {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/__rpc/' + token, false);
      xhr.setRequestHeader('Content-Type','application/json');
      xhr.send(JSON.stringify({operation,...payload}));
      const result = JSON.parse(xhr.responseText);
      if (!result.ok) { const error=new Error(result.message); error.code=result.code; throw error; }
      return result.value;
    }
    window.electronAPI = {
      isDesktop:true,
      storage: {
        getItem:key=>call('get',{key}),
        setItem:(key,value)=>call('set',{key,value}),
        removeItem:key=>call('remove',{key}),
        setMany:entries=>call('batch',{entries}),
        importLegacy:entries=>call('import-legacy',{entries})
      },
      backupEncrypted:async()=>call('backup'),
      openExternal:()=>{}
    };
  }, {token, legacy});
  t.after(async () => {
    await context.close();
    services.delete(token);
    service.store.close();
    await fsp.rm(dir,{recursive:true,force:true});
    assert.deepEqual(errors, [], `Unexpected browser exceptions:\n${errors.join('\n')}`);
  });
  return {context, service};
}
async function login(page, password='manager2026') {
  await page.locator('[data-role-login="manager"]').click();
  await page.locator('#rolePasswordInput').fill(password);
  await page.locator('#rolePasswordForm button[type="submit"]').click();
  await page.locator('#roleGate').waitFor({state:'hidden'});
}
async function createPatient(page, name, file) {
  await page.locator('.sidebar [data-view="new-patient"]').click();
  await page.locator('#pForm [name="file"]').fill(String(file));
  await page.locator('#pForm [name="fullName"]').fill(name);
  await page.locator('#pForm [name="phone"]').fill('0912345678');
  await page.locator('#pForm button[type="submit"]').click();
  await page.locator('#pForm').waitFor({state:'detached'});
}

test('desktop frontend saves patient only in encrypted database and survives reopening', async t => {
  const {context, service} = await createEnvironment(t);
  const page = await context.newPage();
  await page.goto(baseURL);
  assert.match(await page.locator('#storageModeMessage').textContent(), /مشفّرة/);
  await login(page);
  await createPatient(page,'اسم خاص PATIENT-SECRET',777);
  assert.equal(await page.evaluate(k=>localStorage.getItem(k),PATIENTS),null);
  assert.equal(JSON.parse(service.store.getItem(PATIENTS))[0].fullName,'اسم خاص PATIENT-SECRET');
  assert.equal(fs.readFileSync(service.filename).includes('PATIENT-SECRET'),false);
  service.store.close();
  service.store = new EncryptedStore(service.filename); service.store.open(PASS);
  await page.reload();
  await login(page);
  await page.locator('.sidebar [data-view="patients"]').click();
  await page.getByText('اسم خاص PATIENT-SECRET',{exact:true}).first().waitFor();
});

test('explicit migration preserves the legacy copy, credentials and encrypted backup until user removes keys', async t => {
  const legacyPatients=JSON.stringify([{id:'legacy-patient',file:'201',fullName:'مريض سابق PRIVATE-LEGACY',phone:'0912345678'}]);
  const legacyVisits=JSON.stringify([{id:'legacy-visit',patientId:'legacy-patient',visitNum:'1'}]);
  const legacy = {[PATIENTS]:legacyPatients,[VISITS]:legacyVisits,'oras-dental-manager-pass-v1':'legacy-manager-pass'};
  const {context,service}=await createEnvironment(t,{legacy});
  const page=await context.newPage();
  const dialogs=[];
  page.on('dialog', async d=>{dialogs.push(d.message());await d.accept();});
  await page.goto(baseURL);
  assert.equal(service.store.getItem(PATIENTS),legacyPatients);
  assert.equal(service.store.getItem(VISITS),legacyVisits);
  assert.ok(service.store.getItem(MIGRATION_KEY));
  assert.equal(await page.evaluate(k=>localStorage.getItem(k),PATIENTS),legacyPatients);
  assert.ok(dialogs.some(text=>text.includes('النسخة القديمة')));
  await login(page,'legacy-manager-pass');
  await page.locator('.sidebar [data-view="settings"]').click();
  await page.locator('[data-action="backup-encrypted"]').click();
  await page.waitForFunction(()=>document.querySelector('#toast')?.textContent.includes('تم حفظ نسخة احتياطية'));
  assert.equal(fs.readFileSync(service.backup).includes('PRIVATE-LEGACY'),false);
  const backup=new EncryptedStore(service.backup); backup.open(PASS);
  assert.equal(backup.getItem(PATIENTS),legacyPatients); backup.close();
  await page.locator('[data-action="clear-legacy"]').click();
  assert.equal(await page.evaluate(k=>localStorage.getItem(k),PATIENTS),null);
  assert.equal(service.store.getItem(PATIENTS),legacyPatients);
  assert.ok(dialogs.some(text=>text.includes('محواً آمناً')));
});

test('declining migration leaves old records intact and will not overwrite later encrypted data', async t => {
  const legacyPatients=JSON.stringify([{id:'old',file:'9',fullName:'قديم'}]);
  const {context,service}=await createEnvironment(t,{legacy:{[PATIENTS]:legacyPatients}});
  const page=await context.newPage();
  page.on('dialog', async d=>{if(d.type()==='confirm') await d.dismiss(); else await d.accept();});
  await page.goto(baseURL);
  assert.equal(service.store.getItem(PATIENTS),null);
  assert.equal(await page.evaluate(k=>localStorage.getItem(k),PATIENTS),legacyPatients);
  assert.match(await page.locator('#storageModeMessage').textContent(),/تأجيل نقل/);
  await login(page);
  await page.locator('.sidebar [data-view="settings"]').click();
  await page.evaluate(()=>{hasUnsavedStorageChanges=true;});
  await page.locator('[data-action="import-legacy"]').click();
  assert.match(await page.locator('#toast').textContent(),/تغييرات غير محفوظة/);
  assert.equal(service.store.getItem(PATIENTS),null);
  await page.evaluate(()=>{hasUnsavedStorageChanges=false;});
  await createPatient(page,'بيانات جديدة',12);
  const saved=service.store.getItem(PATIENTS);
  await page.locator('.sidebar [data-view="settings"]').click();
  await page.locator('[data-action="import-legacy"]').click();
  assert.equal(service.store.getItem(PATIENTS),saved);
  assert.equal(await page.evaluate(k=>localStorage.getItem(k),PATIENTS),legacyPatients);
  assert.match(await page.locator('#toast').textContent(),/تحتوي بيانات بالفعل/);
});

test('an encrypted database read failure disables saves and does not fall back to localStorage', async t => {
  const {context,service}=await createEnvironment(t,{failGetKey:PATIENTS});
  const page=await context.newPage(); await page.goto(baseURL);
  assert.match(await page.locator('#storageWarning').textContent(),/أُوقِف الحفظ/);
  assert.equal(await page.evaluate(k=>localStorage.getItem(k),PATIENTS),null);
  await page.locator('[data-role-login="manager"]').click();
  await page.locator('#rolePasswordInput').fill('manager2026');
  await page.locator('#rolePasswordForm button[type="submit"]').click();
  await page.waitForFunction(()=>document.querySelector('#rolePasswordError')?.textContent.includes('تعذّر'));
  assert.equal(service.writeCount,0);
});

test('Electron with a missing preload bridge is blocked instead of using plaintext localStorage', async t => {
  const context=await browser.newContext({userAgent:'Mozilla/5.0 Chrome/120 Electron/45.2.1'});
  t.after(()=>context.close());
  const page=await context.newPage(); await page.goto(baseURL);
  assert.match(await page.locator('#roleGate').textContent(),/التخزين المشفّر غير متاح/);
  assert.equal(await page.locator('[data-role-login]').count(),0);
  assert.equal(await page.evaluate(k=>localStorage.getItem(k),PATIENTS),null);
});

test('restoring multiple collections rolls back atomically when encrypted storage rejects one write', async t => {
  const {context,service}=await createEnvironment(t);
  service.store.setItem(PATIENTS,JSON.stringify([{id:'keep',file:'1',fullName:'لا يستبدل'}]));
  service.store.db.exec(`CREATE TRIGGER reject_restore BEFORE INSERT ON clinic_storage
    WHEN NEW.key='${VISITS}' BEGIN SELECT RAISE(ABORT, 'restore failure'); END;`);
  const page=await context.newPage(); await page.goto(baseURL); await login(page);
  const result=await page.evaluate(async ()=>applyRestoredData({
    patients:[{id:'new',file:'2',fullName:'مريض آخر'}],
    visits:[{id:'new-visit',patientId:'new'}]
  },'test'));
  assert.equal(result,false);
  assert.equal(JSON.parse(service.store.getItem(PATIENTS))[0].id,'keep');
  assert.equal(service.store.getItem(VISITS),null);
  assert.ok(service.store.getItem(RECOVERY));
});

test('unlock screen validates creation, rejects a wrong passphrase and accepts the correct one', async t => {
  const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'oras-unlock-test-'));
  const filename=path.join(dir,'clinic.sqlite3');
  const token=crypto.randomBytes(12).toString('hex');
  const service={store:new EncryptedStore(filename),filename,writeCount:0};
  services.set(token,service);
  const context=await browser.newContext();
  await context.addInitScript(token=>{
    if(location.protocol!=='http:') return;
    function call(operation,payload={}){
      const xhr=new XMLHttpRequest(); xhr.open('POST','/__rpc/'+token,false);
      xhr.setRequestHeader('Content-Type','application/json');xhr.send(JSON.stringify({operation,...payload}));
      const result=JSON.parse(xhr.responseText);
      return result.ok ? result.value : {ok:false,code:result.code,message:result.message};
    }
    window.electronAPI={
      databaseStatus:async()=>call('status'),
      unlockDatabase:async passphrase=>call('unlock',{passphrase}),
      enterClinic:()=>{window.__entered=true;}
    };
  },token);
  t.after(async()=>{await context.close();services.delete(token);service.store.close();await fsp.rm(dir,{recursive:true,force:true});});
  const page=await context.newPage();
  await page.goto(baseURL+'/unlock.html');
  await page.locator('#unlockForm').waitFor({state:'visible'});
  assert.match(await page.locator('#title').textContent(),/إنشاء/);
  await page.locator('#passphrase').fill('short');
  await page.locator('#unlockForm button').click();
  assert.match(await page.locator('#error').textContent(),/12 حرفاً/);
  assert.equal(fs.existsSync(filename),false);
  await page.locator('#passphrase').fill(PASS);
  await page.locator('#confirmPassphrase').fill('not matching');
  await page.locator('#unlockForm button').click();
  assert.match(await page.locator('#error').textContent(),/غير متطابقتين/);
  await page.locator('#confirmPassphrase').fill(PASS);
  await page.locator('#unlockForm button').click();
  assert.match(await page.locator('#error').textContent(),/تأكيد/);
  await page.locator('#savedPassphrase').check();
  await page.locator('#unlockForm button').click();
  await page.waitForFunction(()=>window.__entered===true);
  assert.equal(await page.locator('#passphrase').inputValue(),'');
  assert.equal(await page.evaluate(()=>localStorage.length),0);
  service.store.setItem(PATIENTS,'marker');
  service.store.close();
  const beforeHash=crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
  await page.reload();
  await page.locator('#unlockForm').waitFor({state:'visible'});
  assert.match(await page.locator('#title').textContent(),/فتح/);
  await page.locator('#passphrase').fill('wrong passphrase');
  await page.locator('#unlockForm button').click();
  assert.match(await page.locator('#error').textContent(),/غير صحيحة أو ملف قاعدة البيانات تالف/);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex'),beforeHash);
  await page.locator('#passphrase').fill(PASS);
  await page.locator('#unlockForm button').click();
  await page.waitForFunction(()=>window.__entered===true);
  assert.equal(service.store.getItem(PATIENTS),'marker');
});

test('file-loaded desktop page has local libraries and Web Crypto without writing records to localStorage', async t => {
  const context=await browser.newContext({timezoneId:'Africa/Khartoum',reducedMotion:'reduce'});
  t.after(()=>context.close());
  await context.addInitScript(()=>{
    if(location.protocol!=='file:') return;
    const records=Object.create(null);
    const api={
      getItem:key=>Object.prototype.hasOwnProperty.call(records,key)?records[key]:null,
      setItem:(key,value)=>{records[key]=value;},
      removeItem:key=>{delete records[key];},
      setMany:entries=>entries.forEach(({key,value})=>{if(value===null)delete records[key];else records[key]=value;}),
      importLegacy:entries=>{entries.forEach(({key,value})=>{records[key]=value;}); records['oras-dental-legacy-migrated-v1']='yes';}
    };
    window.electronAPI={isDesktop:true,storage:api,backupEncrypted:async()=>({ok:true,canceled:true}),openExternal:()=>{}};
  });
  const page=await context.newPage();
  await page.goto(require('node:url').pathToFileURL(path.join(root,'index.html')).href);
  const capabilities=await page.evaluate(()=>({crypto:!!crypto.subtle,xlsx:!!window.XLSX?.utils}));
  assert.deepEqual(capabilities,{crypto:true,xlsx:true});
  await login(page);
  await createPatient(page,'تجربة ملف محلي',451);
  assert.equal(await page.evaluate(k=>localStorage.getItem(k),PATIENTS),null);
  assert.equal(await page.evaluate(k=>JSON.parse(window.electronAPI.storage.getItem(k))[0].fullName,PATIENTS),'تجربة ملف محلي');
  const canvasResult=await page.evaluate(async()=>{
    const el=document.createElement('div');el.textContent='PDF test';el.style.cssText='width:200px;height:80px;background:#fff;color:#000';document.body.appendChild(el);
    try{const canvas=await html2canvas(el,{logging:false});return {width:canvas.width};}catch(error){return {error:String(error)};}finally{el.remove();}
  });
  assert.equal(canvasResult.width,200,JSON.stringify(canvasResult));
  const violated=await page.evaluate(()=>new Promise(resolve=>{
    document.addEventListener('securitypolicyviolation',event=>resolve(event.violatedDirective),{once:true});
    fetch('https://example.invalid/patient').catch(()=>{});
    setTimeout(()=>resolve('no CSP violation'),2000);
  }));
  assert.match(violated,/connect-src/);
  const downloading=page.waitForEvent('download',{timeout:10000});
  await page.evaluate(()=>{const doc=new jspdf.jsPDF();doc.text('test',20,20);doc.save('test.pdf');});
  const pdf=await fsp.readFile(await (await downloading).path());
  assert.equal(pdf.subarray(0,4).toString(),'%PDF');
});
