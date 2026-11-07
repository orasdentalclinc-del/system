const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium: playwright } = require('playwright-core');
const chromiumPackage = require('@sparticuz/chromium');

const root = path.resolve(__dirname, '..');
const PATIENTS = 'oras-dental-patients-v3';
const VISITS = 'oras-dental-visits-v3';
const EXPENSES = 'oras-dental-expenses-v1';
const INVENTORY = 'oras-dental-inv-v1';
const LABS = 'oras-dental-labs-v1';
const PLANS = 'oras-dental-treatment-plans-v1';
const NARRATIVES = 'oras-dental-report-narratives-v1';
const RECOVERY = 'oras-dental-before-restore-v1';
let server, browser, baseURL;

before(async () => {
  server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).slice(1);
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    try {
      const data = await fs.readFile(file);
      res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8' });
      res.end(data);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;

  let executablePath = process.env.CHROME_PATH;
  let args = ['--no-sandbox'];
  let env = { ...process.env };
  if (!executablePath) {
    const c = chromiumPackage.default;
    const libDir = await chromiumPackage.inflate(path.join(root, 'node_modules/@sparticuz/chromium/bin/al2023.tar.br'));
    executablePath = await c.executablePath();
    args = c.args.filter(arg => arg !== '--disable-web-security' && arg !== '--single-process');
    env.LD_LIBRARY_PATH = [path.join(libDir, 'lib'), env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  }
  browser = await playwright.launch({ executablePath, args, env, headless: true });
});

after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

async function createContext(t, options = {}) {
  const context = await browser.newContext({ timezoneId: 'Africa/Khartoum', reducedMotion: 'reduce', ...options });
  const errors = [];
  context.on('page', page => page.on('pageerror', error => errors.push(error.stack || error.message)));
  await context.route('**/*', route => {
    if (new URL(route.request().url()).hostname === '127.0.0.1') return route.continue();
    return route.abort();
  });
  t.after(async () => {
    await context.close();
    assert.deepEqual(errors, [], `Unexpected browser exceptions:\n${errors.join('\n')}`);
  });
  return context;
}
async function open(context) {
  const page = await context.newPage();
  await page.goto(baseURL, { waitUntil: 'load' });
  return page;
}
async function login(page, role = 'manager', password = `${role}2026`) {
  await page.locator(`[data-role-login="${role}"]`).click();
  await page.locator('#rolePasswordInput').fill(password);
  await page.locator('#rolePasswordForm button[type="submit"]').click();
  await page.locator('#roleGate').waitFor({state:'hidden'});
}
async function nav(page, view) {
  await page.locator(`.sidebar [data-view="${view}"]`).click();
}
async function createPatient(page, name, file) {
  await nav(page, 'new-patient');
  if (file !== undefined) await page.locator('#pForm [name="file"]').fill(String(file));
  await page.locator('#pForm [name="fullName"]').fill(name);
  await page.locator('#pForm [name="phone"]').fill('0912345678');
  await page.locator('#pForm button[type="submit"]').click();
  await page.locator('#pForm').waitFor({state:'detached'});
}
async function data(page, key) {
  return page.evaluate(k => JSON.parse(localStorage.getItem(k) || '[]'), key);
}
async function waitCount(page,key,count) {
  try{
    await page.waitForFunction(([k,n]) => JSON.parse(localStorage.getItem(k)||'[]').length===n,[key,count]);
  }catch(error){
    const details=await page.evaluate(()=>({toast:document.getElementById('toast')?.textContent,warning:document.getElementById('storageWarning')?.textContent,modal:!document.getElementById('appModal')?.classList.contains('hidden'),fields:Array.from(document.querySelectorAll('#appModal input')).map(i=>({name:i.name,value:i.value,valid:i.checkValidity()}))}));
    throw new Error(`Timed out waiting for ${key} length ${count}: ${JSON.stringify(details)}`,{cause:error});
  }
}
async function addExpense(page, title, amount) {
  const before=(await data(page,EXPENSES)).length;
  await nav(page, 'expenses');
  await page.locator('#addExpenseBtn').click();
  await page.locator('#appModal [name="title"]').fill(title);
  await page.locator('#appModal [name="amount"]').fill(String(amount));
  await page.locator('#appModalSubmit').click();
  await waitCount(page,EXPENSES,before+1);
  assert.equal(await page.locator('#appModal').isHidden(), true);
}

test('starts without fictitious clinic records and runs its export libraries offline', async t => {
  const context = await createContext(t);
  const page = await open(context);
  const state = await page.evaluate(() => ({
    patients: patients.length, visits: visits.length, expenses: expenses.length,
    inventory: inventory.length, labs: labs.length, xlsx: XLSX.version,
    canvas: typeof html2canvas, pdf: typeof jspdf.jsPDF
  }));
  assert.deepEqual(state, { patients: 0, visits: 0, expenses: 0, inventory: 0, labs: 0, xlsx: '0.20.3', canvas: 'function', pdf: 'function' });
  await page.locator('[data-role-login="manager"]').click();
  await page.locator('#rolePasswordInput').fill('wrong-password');
  await page.locator('#rolePasswordForm button[type="submit"]').click();
  await page.waitForFunction(() => document.getElementById('rolePasswordError').textContent.includes('غير صحيحة'));
  assert.match(await page.locator('#rolePasswordError').textContent(), /غير صحيحة/);
  await page.locator('#rolePasswordInput').fill('manager2026');
  await page.locator('#rolePasswordForm button[type="submit"]').click();
  await page.locator('#roleGate').waitFor({state:'hidden'});
  assert.equal(await page.locator('#roleLogoutBtn').count(), 1);
  await page.locator('#roleLogoutBtn').click();
  assert.equal(await page.locator('#roleGate').isVisible(), true);
});

test('patient files validate and persist, and duplicate file numbers are rejected', async t => {
  const context = await createContext(t);
  const page = await open(context);
  await login(page);
  await createPatient(page, 'Patient One', '42');
  await nav(page, 'new-patient');
  await page.locator('#pForm [name="file"]').fill('42');
  await page.locator('#pForm [name="fullName"]').fill('Patient Two');
  await page.locator('#pForm [name="phone"]').fill('0911111111');
  await page.locator('#pForm button[type="submit"]').click();
  assert.equal(await page.locator('#pForm').isVisible(), true);
  assert.match(await page.locator('#toast').textContent(), /مستخدم بالفعل/);
  await page.locator('#pForm [name="file"]').fill('43');
  await page.locator('#pForm button[type="submit"]').click();
  await waitCount(page,PATIENTS,2);
  assert.deepEqual((await data(page, PATIENTS)).map(p => p.file), ['42', '43']);
  await page.reload();
  assert.deepEqual((await data(page, PATIENTS)).map(p => p.fullName), ['Patient One', 'Patient Two']);
});

test('visit totals, validation, appointment status and repeated renders stay correct', async t => {
  const context = await createContext(t);
  const page = await open(context);
  await login(page);
  await createPatient(page, 'Visit Patient', '1');
  for (let i = 0; i < 3; i++) { await nav(page, 'settings'); await nav(page, 'patients'); }
  await page.locator('#table [data-action="new-visit-for"]').first().click();
  assert.equal(await page.locator('#vTotalCost').inputValue(), '10000');
  assert.equal(await page.locator('#vDue').inputValue(), '10000');
  await page.locator('#addProcedureRowBtn').click();
  await page.locator('#addProcedureRowBtn').click();
  assert.equal(await page.locator('#procedureList .procedure-item').count(), 3);
  await page.locator('#procedureList .remove-proc-btn').nth(1).click();
  assert.equal(await page.locator('#procedureList .procedure-item').count(), 2, 'one click must remove only one row');
  await page.locator('#procedureList .proc-cost').first().fill('12000');
  await page.locator('#vPaid').fill('23000');
  await page.locator('#vForm button[type="submit"]').click();
  assert.equal(await page.locator('#vForm').isVisible(), true);
  assert.equal((await data(page, VISITS)).length, 0);
  await page.locator('#vPaid').fill('5000');
  assert.equal(await page.locator('#vTotalCost').inputValue(), '22000');
  assert.equal(await page.locator('#vDue').inputValue(), '17000');
  await page.locator('#vForm button[type="submit"]').click();
  await waitCount(page,VISITS,1);
  let saved = await data(page, VISITS);
  assert.equal(saved[0].cost, 22000);
  assert.equal(saved[0].paid, 5000);
  assert.equal(saved[0].due, 17000);
  assert.equal(saved[0].visitNum, '1');

  await nav(page, 'appointments');
  await page.locator('#content [data-view="new-appointment"]').click();
  assert.equal(await page.locator('#vForm [name="status"]').inputValue(), 'محجوزة');
  await page.locator('#vForm [name="startTime"]').fill('09:30');
  await page.locator('#vForm button[type="submit"]').click();
  await waitCount(page,VISITS,2);
  saved = await data(page, VISITS);
  assert.equal(saved[1].status, 'محجوزة');
  assert.equal(saved[1].visitNum, '2');
  assert.equal(saved[1].startTime, '09:30');
  const totals = await page.evaluate(() => { const [a,b]=reportRange(); const c=computeRange(a,b); return [c.done.length,c.rev,c.due]; });
  assert.deepEqual(totals, [1, 22000, 17000]);
  await page.reload();
  assert.equal((await data(page, VISITS)).length, 2);
});

test('expense, inventory, lab and appointment filters and form constraints work', async t => {
  const context = await createContext(t);
  const page = await open(context);
  await login(page);
  await nav(page, 'expenses');
  await page.locator('#addExpenseBtn').click();
  await page.locator('#appModalSubmit').click();
  assert.equal(await page.locator('#appModal').isVisible(), true, 'required fields must actually be required');
  await page.locator('#appModal [name="title"]').fill('Rent');
  await page.locator('#appModal [name="amount"]').fill('-5');
  assert.equal(await page.locator('#appModal [name="amount"]').evaluate(el => el.validity.rangeUnderflow), true);
  await page.locator('#appModal [name="amount"]').fill('123');
  await page.locator('#appModalSubmit').click();
  await waitCount(page,EXPENSES,1);
  assert.equal((await data(page, EXPENSES))[0].amount, 123);

  await nav(page, 'inventory');
  let inventoryCount=0;
  for (const [name, qty, minQty] of [['Gloves', '0', '0'], ['Cotton', '8', '2']]) {
    await page.locator('#addInvBtn').click();
    await page.locator('#appModal [name="name"]').fill(name);
    await page.locator('#appModal [name="qty"]').fill(qty);
    await page.locator('#appModal [name="minQty"]').fill(minQty);
    await page.locator('#appModalSubmit').click();
    await waitCount(page,INVENTORY,++inventoryCount);
  }
  const items = await data(page, INVENTORY);
  assert.equal(items[0].minQty, 0);
  assert.equal(items[0].expireDate, '');
  await page.locator('#invSearch').fill('Cotton');
  assert.match(await page.locator('#invTableContainer').textContent(), /Cotton/);
  assert.doesNotMatch(await page.locator('#invTableContainer').textContent(), /Gloves/);
  await page.locator('#invSearch').fill('');
  await page.locator('#invStatusFilter').selectOption('low');
  assert.match(await page.locator('#invTableContainer').textContent(), /Gloves/);
  assert.doesNotMatch(await page.locator('#invTableContainer').textContent(), /Cotton/);
  await page.locator('#invStatusFilter').selectOption('');
  await page.locator('#invTableContainer [data-action="update-inv-qty"]').first().click();
  assert.equal(await page.locator('#appModal [name="minQty"]').inputValue(), '0');
  await page.locator('#appModalCancel').click();

  await nav(page, 'labs');
  await page.locator('#addLabBtn').click();
  await page.locator('#appModal [name="labName"]').fill('Alpha Lab');
  await page.locator('#appModal [name="patientName"]').fill('Lab Patient');
  await page.locator('#appModal [name="cost"]').fill('90');
  await page.locator('#appModalSubmit').click();
  await waitCount(page,LABS,1);
  assert.equal((await data(page, LABS)).length, 1);
  await page.locator('#labSearch').fill('not-present');
  assert.doesNotMatch(await page.locator('#labsTableContainer').textContent(), /Alpha Lab/);
  await page.locator('#labSearch').fill('Alpha');
  assert.match(await page.locator('#labsTableContainer').textContent(), /Alpha Lab/);

  await createPatient(page, 'Appointment Person', '20');
  await page.locator('#table [data-action="new-visit-for"]').click();
  await page.locator('#vForm button[type="submit"]').click();
  await waitCount(page,VISITS,1);
  await nav(page, 'appointments');
  await page.locator('#apptSearch').fill('nothing-matches');
  assert.doesNotMatch(await page.locator('#apptsTable').textContent(), /Appointment Person/);
  await page.locator('#apptSearch').fill('Appointment Person');
  assert.match(await page.locator('#apptsTable').textContent(), /Appointment Person/);
});

test('employees cannot self-create administrator access and see only their shift', async t => {
  const context = await createContext(t);
  const page = await open(context);
  await page.evaluate(({pkey,vkey}) => {
    const now = new Date().toISOString().slice(0,10);
    localStorage.setItem(pkey, JSON.stringify([{id:'p1',file:'1',fullName:'Morning Person',phone:'0911'},{id:'p2',file:'2',fullName:'Evening Person',phone:'0912'}]));
    localStorage.setItem(vkey, JSON.stringify([{id:'v1',patientId:'p1',patientName:'Morning Person',date:now,shift:'صباح',cost:100,paid:0,due:100}, {id:'v2',patientId:'p2',patientName:'Evening Person',date:now,shift:'مساء',cost:200,paid:0,due:200}]));
  }, {pkey:PATIENTS,vkey:VISITS});
  await page.reload();
  await login(page, 'morning');
  await nav(page, 'visits');
  assert.match(await page.locator('#visitsTable').textContent(), /Morning Person/);
  assert.doesNotMatch(await page.locator('#visitsTable').textContent(), /Evening Person/);
  await page.locator('[data-action="notifications"]').click();
  assert.doesNotMatch(await page.locator('#notificationModalBody').textContent(), /Evening Person/);
  await page.locator('#dismissNotificationBtn').click();
  await page.locator('.sidebar [data-action="admin"]').click();
  await page.locator('#adminPassInput').fill('arbitrary-new-password');
  await page.locator('#adminSubmitBtn').click();
  assert.equal(await page.evaluate(() => adminUnlocked), false);
  assert.equal(await page.evaluate(() => localStorage.getItem('oras-dental-admin-v1')), null);
  await page.locator('.sidebar [data-action="admin"]').click();
  await page.locator('#adminPassInput').fill('manager2026');
  await page.locator('#adminSubmitBtn').click();
  await page.waitForFunction(() => adminUnlocked);
  assert.equal(await page.evaluate(() => adminUnlocked), true);
  await page.locator('.sidebar [data-action="admin"]').click();
  assert.deepEqual(await page.evaluate(() => [currentRole,adminUnlocked]), ['morning', false]);
});

test('reports use local dates, correct month boundaries and exclude cancelled and booked amounts', async t => {
  const context = await createContext(t);
  const page = await context.newPage();
  await page.clock.install({ time: new Date('2026-03-31T10:00:00+02:00') });
  await page.goto(baseURL);
  await page.evaluate(({vkey,ekey}) => {
    localStorage.setItem(vkey, JSON.stringify([
      {id:'v1',patientId:'p1',patientName:'P',date:'2026-03-15',status:'مكتملة',visitType:'جديد',cost:100,paid:70,due:30,items:[{procedure:'Exam',cost:100}]},
      {id:'v2',patientId:'p1',patientName:'P',date:'2026-03-16',status:'ملغاة',cost:300,paid:300,due:0},
      {id:'v3',patientId:'p1',patientName:'P',date:'2026-03-17',status:'محجوزة',cost:500,paid:0,due:500}
    ]));
    localStorage.setItem(ekey, JSON.stringify([{id:'e1',title:'Expense',date:'2026-03-10',amount:20,category:'عام',type:'متغيرة'}]));
  }, {vkey:VISITS,ekey:EXPENSES});
  await page.reload();
  await login(page);
  const result = await page.evaluate(() => {
    reportPeriod='lastmonth'; const last=reportRange().map(ymd);
    reportPeriod='month'; const c=computeRange(...reportRange());
    const monthly=computeMonthlyStats(2026,3);
    const orig=visits[0].date; visits[0].date=Date.UTC(2026,2,15)/86400000+25569;
    const numericDay=computeRange(...reportRange()).daily['2026-03-15'];
    const numericMonthly=computeMonthlyStats(2026,3).financial.revenue;
    visits[0].date=orig;
    reportCustom={from:'2020-01-01',to:'2020-01-02'};
    const printRange=reportPeriodRange();
    return {last, rev:c.rev,paid:c.paid,due:c.due,cancels:c.cancels,net:c.net,
      monthlyVisits:monthly.operational.visits,monthlyRevenue:monthly.financial.revenue,
      monthlyNet:monthly.financial.netProfit,numericDay,numericMonthly,cancelRate:c.cancelRate,completed:c.done.length,printRange:[printRange.from,printRange.to],
      badDate:normDate('2026-02-31'), excelDate:normDate(46100.9)};
  });
  assert.deepEqual(result.last, ['2026-02-01','2026-02-28']);
  assert.deepEqual([result.rev,result.paid,result.due,result.cancels,result.net], [100,70,30,1,50]);
  assert.deepEqual([result.monthlyVisits,result.monthlyRevenue,result.monthlyNet], [1,100,50]);
  assert.equal(Math.round(result.cancelRate),33);
  assert.equal(result.completed,1);
  assert.equal(result.numericDay,70);
  assert.equal(result.numericMonthly,100);
  assert.deepEqual(result.printRange, ['2026-03-01','2026-03-31']);
  assert.equal(result.badDate, '');
  assert.notEqual(result.excelDate, '');
  await nav(page, 'reports');
  assert.doesNotMatch(await page.locator('#reportTabContent').textContent(), /سير العمل بالعيادة بانتظام دون توقف/);
});

test('local day is used rather than UTC immediately after midnight', async t => {
  const context = await createContext(t);
  const page = await context.newPage();
  await page.clock.install({ time: new Date('2026-03-01T22:30:00Z') });
  await page.goto(baseURL);
  assert.equal(await page.evaluate(() => todayString()), '2026-03-02');
});

test('JSON backups include report notes and restore can be undone', async t => {
  const context = await createContext(t, { acceptDownloads: true });
  const page = await open(context);
  await login(page);
  await createPatient(page, 'Before Restore', '1');
  await page.evaluate(key => {
    narratives={'2026-01-01_2026-01-31': {achievements:['Actual note'], challenges:[], marketing:[], nextTasks:[]}};
    localStorage.setItem(key, JSON.stringify(narratives));
    window.showSaveFilePicker=undefined;
  }, NARRATIVES);
  const downloadPromise=page.waitForEvent('download');
  await page.locator('.sidebar [data-action="backup"]').click();
  const download=await downloadPromise;
  const backup=JSON.parse(await fs.readFile(await download.path(), 'utf8'));
  assert.equal(backup.data.patients[0].fullName, 'Before Restore');
  assert.equal(backup.data.narratives['2026-01-01_2026-01-31'].achievements[0], 'Actual note');

  page.on('dialog', dialog => dialog.accept());
  const imported={ data: {patients:[{id:'imported',file:'9',fullName:'Imported',phone:'0900'}], visits:[]} };
  await page.locator('#restore').setInputFiles({name:'backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(imported))});
  await page.waitForFunction(key => JSON.parse(localStorage.getItem(key)||'[]')[0]?.fullName==='Imported', PATIENTS);
  assert.equal((await data(page, PATIENTS))[0].fullName, 'Imported');
  const recovery=JSON.parse(await page.evaluate(k => localStorage.getItem(k), RECOVERY));
  assert.equal(recovery.data.patients[0].fullName, 'Before Restore');
  await nav(page, 'settings');
  await page.locator('[data-action="restore-preimport"]').click();
  await page.waitForFunction(key => JSON.parse(localStorage.getItem(key)||'[]')[0]?.fullName==='Before Restore', PATIENTS);
  assert.equal((await data(page, PATIENTS))[0].fullName, 'Before Restore');
  assert.equal(JSON.parse(await page.evaluate(k => localStorage.getItem(k), NARRATIVES))['2026-01-01_2026-01-31'].achievements[0], 'Actual note');
});

test('parallel tabs preserve different additions and reject conflicting edits', async t => {
  const context = await createContext(t);
  const a = await open(context), b = await open(context);
  await login(a); await login(b);
  await nav(a, 'new-patient'); await nav(b, 'new-patient');
  await a.locator('#pForm [name="fullName"]').fill('Tab A');
  await a.locator('#pForm [name="phone"]').fill('0911111111');
  await b.locator('#pForm [name="fullName"]').fill('Tab B');
  await b.locator('#pForm [name="phone"]').fill('0922222222');
  await a.locator('#pForm button[type="submit"]').click();
  await waitCount(a,PATIENTS,1);
  await b.locator('#pForm button[type="submit"]').click();
  assert.equal(await b.locator('#pForm').isVisible(), true);
  assert.match(await b.locator('#toast').textContent(), /مستخدم بالفعل/);
  await b.locator('#pForm [name="file"]').fill('2');
  await b.locator('#pForm button[type="submit"]').click();
  await waitCount(b,PATIENTS,2);
  assert.deepEqual((await data(a,PATIENTS)).map(p=>p.fullName).sort(), ['Tab A','Tab B']);

  await nav(a, 'patients'); await nav(b, 'patients');
  await a.locator('#table [data-action="open-patient"]').first().click();
  await b.locator('#table [data-action="open-patient"]').first().click();
  await a.locator('[data-action="edit-patient"]').click();
  await b.locator('[data-action="edit-patient"]').click();
  await a.locator('#pForm [name="fullName"]').fill('A saved');
  await b.locator('#pForm [name="fullName"]').fill('B unsaved');
  await a.locator('#pForm button[type="submit"]').click();
  await a.waitForFunction(k => JSON.parse(localStorage.getItem(k)||'[]')[0]?.fullName==='A saved',PATIENTS);
  await b.locator('#pForm button[type="submit"]').click();
  assert.equal(await b.locator('#pForm').isVisible(), true);
  assert.match(await b.locator('#toast').textContent(), /تغيّر هذا السجل/);
  assert.equal((await data(b,PATIENTS))[0].fullName, 'A saved');
  assert.equal(await b.locator('#pForm [name="fullName"]').inputValue(), 'B unsaved');
});

test('an edit modal survives unrelated updates from another tab', async t => {
  const context = await createContext(t);
  const a = await open(context), b = await open(context);
  await login(a); await login(b);
  await addExpense(a, 'First expense', 100);
  await addExpense(a, 'Second expense', 200);
  await nav(b, 'expenses');
  await b.locator('[data-action="edit-expense"]').first().click();
  const editing = await b.locator('#appModal [name="title"]').inputValue();
  await createPatient(a, 'Other Tab Patient', '1');
  await b.locator('#appModal [name="title"]').fill(editing + ' updated');
  await b.locator('#appModalSubmit').click();
  await b.waitForFunction(k => JSON.parse(localStorage.getItem(k)||'[]').some(x=>x.title.endsWith(' updated')),EXPENSES);
  assert.equal((await data(b,EXPENSES)).filter(x=>x.title.endsWith(' updated')).length, 1);
  assert.equal((await data(b,PATIENTS)).length, 1);
});

test('a failed storage write leaves the form open, warns persistently, and retries without duplicates', async t => {
  const context = await createContext(t);
  await context.addInitScript(key => {
    const original=Storage.prototype.setItem;
    window.failPatientWrite=true;
    Storage.prototype.setItem=function(k,v){
      if(window.failPatientWrite && k===key) throw new DOMException('Full', 'QuotaExceededError');
      return original.call(this,k,v);
    };
  }, PATIENTS);
  const page = await open(context);
  await login(page);
  await nav(page, 'new-patient');
  await page.locator('#pForm [name="fullName"]').fill('Retry Patient');
  await page.locator('#pForm [name="phone"]').fill('0912345678');
  await page.locator('#pForm button[type="submit"]').click();
  assert.equal(await page.locator('#pForm').isVisible(), true);
  await page.locator('#storageWarning').waitFor({state:'visible'});
  assert.equal(await page.locator('#storageWarning').isVisible(), true);
  assert.equal((await data(page,PATIENTS)).length, 0);
  await page.evaluate(() => {window.failPatientWrite=false;});
  await page.locator('#pForm button[type="submit"]').click();
  await waitCount(page,PATIENTS,1);
  assert.equal((await data(page,PATIENTS)).length, 1);
  assert.equal((await data(page,PATIENTS))[0].fullName, 'Retry Patient');
});

test('untrusted patient data is rendered as text, not executable HTML', async t => {
  const context = await createContext(t);
  const page = await open(context);
  const attack='<img src=x onerror="window.__injected=true">';
  await page.evaluate(({key,attack})=>{
    localStorage.setItem(key,JSON.stringify([{id:'bad" onmouseover="window.__injected=true',file:'1" onfocus="window.__injected=true',fullName:'Safe Name',phone:'0911',referral:[attack],allergies:[attack],medications:attack,meds:['نعم']}]));
  },{key:PATIENTS,attack});
  await page.reload();
  await login(page);
  await nav(page,'patients');
  assert.equal(await page.locator('#table img').count(),0);
  await page.locator('#table [data-action="open-patient"]').click();
  assert.equal(await page.locator('#content img').count(),0);
  assert.match(await page.locator('#content').textContent(), /<img src=x/);
  assert.equal(await page.evaluate(() => window.__injected), undefined);
  await page.locator('[data-action="edit-patient"]').click();
  assert.equal(await page.locator('#pForm [name="file"]').inputValue(),'1" onfocus="window.__injected=true');
  assert.equal(await page.evaluate(() => window.__injected), undefined);
});

test('simultaneous submissions with the same patient file do not create duplicates', async t => {
  const context=await createContext(t);
  const a=await open(context), b=await open(context);
  await login(a); await login(b);
  for(const [page,name] of [[a,'First submission'],[b,'Second submission']]){
    await nav(page,'new-patient');
    await page.locator('#pForm [name="file"]').fill('SAME');
    await page.locator('#pForm [name="fullName"]').fill(name);
    await page.locator('#pForm [name="phone"]').fill('0912345678');
  }
  await Promise.all([a.locator('#pForm button[type="submit"]').click(),b.locator('#pForm button[type="submit"]').click()]);
  await a.waitForFunction(key => JSON.parse(localStorage.getItem(key)||'[]').length===1,PATIENTS);
  await Promise.all([a.waitForFunction(()=>savesInProgress===0),b.waitForFunction(()=>savesInProgress===0)]);
  assert.equal((await data(a,PATIENTS)).length,1);
  const forms=await Promise.all([a.locator('#pForm').count(),b.locator('#pForm').count()]);
  assert.deepEqual([...forms].sort(),[0,1]);
  const loser=forms[0]===1?a:b;
  const feedback=(await loser.locator('#toast').textContent())+' '+(await loser.locator('#storageWarning').textContent());
  assert.match(feedback,/مستخدم بالفعل|استُخدم رقم الملف/);
});

test('treatment plans preserve progress, choose the newest same-day plan and generate a PDF', async t => {
  const context=await createContext(t,{acceptDownloads:true});
  const page=await open(context);
  await login(page);
  await createPatient(page,'Plan Patient','55');
  await page.locator('#table [data-action="treatment-plan"]').click();
  await page.locator('#planForm [name="c0_count"]').fill('2');
  await page.locator('#planForm [name="c0_pos"]').fill('Upper left');
  await page.locator('#planForm button[type="submit"]').click();
  await waitCount(page,PLANS,1);
  await page.locator('#planProgressForm [name="p0_done"]').fill('1');
  await page.locator('#planProgressForm button[type="submit"]').click();
  await page.waitForFunction(key=>JSON.parse(localStorage.getItem(key)||'[]')[0]?.cols?.[0]?.done==='1',PLANS);
  assert.match(await page.locator('#planProgressForm').locator('..').textContent(),/50%/);
  await page.locator('#planForm [name="c0_count"]').fill('0');
  // Clearing a planned count does not discard the already-recorded progress.
  await page.locator('#planForm [name="c0_count"]').fill('2');
  const patientId=(await data(page,PATIENTS))[0].id;
  await page.locator('[data-action="new-plan"]').click();
  await page.locator('#planForm [name="c1_count"]').fill('3');
  await page.locator('#planForm button[type="submit"]').click();
  await waitCount(page,PLANS,2);
  const ids=await data(page,PLANS);
  assert.equal(await page.evaluate(id=>getPatientPlans(id)[0].id,patientId),ids[1].id);
  assert.equal(await page.evaluate(()=>waPhone('٠٩١٢٣٤٥٦٧٨')),'249912345678');
  await page.evaluate(()=>{window.open=()=>null;});
  const downloadPromise=page.waitForEvent('download',{timeout:30000});
  await page.evaluate(id=>{sendPlanPdf(id);},patientId);
  const download=await downloadPromise;
  const pdf=await fs.readFile(await download.path());
  assert.equal(pdf.subarray(0,4).toString(),'%PDF');
  assert.ok(pdf.length>1000);
  const nonWhite=await page.evaluate(async()=>{
    const canvas=await html2canvas(document.getElementById('planPdfSheet'),{scale:1,backgroundColor:'#ffffff',logging:false});
    const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
    let count=0;
    for(let i=0;i<pixels.length;i+=16) if(pixels[i]<180 || pixels[i+1]<180 || pixels[i+2]<180) count++;
    return count;
  });
  assert.ok(nonWhite>500,'The plan capture should contain visible content, not a blank page');
});

test('Excel export/import round-trips nested plan data and rejects malformed backup collections', async t => {
  const context=await createContext(t,{acceptDownloads:true});
  const page=await open(context);
  await login(page);
  await createPatient(page,'Excel Person','77');
  const patient=(await data(page,PATIENTS))[0];
  await page.evaluate(()=>{window.showSaveFilePicker=undefined;});
  const exportPromise=page.waitForEvent('download');
  await page.locator('[data-action="export-patients"]').click();
  const exported=await fs.readFile(await (await exportPromise).path());
  const sheets=await page.evaluate(bytes=>XLSX.read(Uint8Array.from(bytes),{type:'array'}).SheetNames,[...exported]);
  assert.deepEqual(sheets,['ملفات المرضى','الزيارات','الإجراءات التفصيلية','الخطط العلاجية']);
  await page.evaluate(async p=>{
    treatmentPlans.push({id:'excel-plan',patientId:p.id,date:todayString(),cols:[{count:'2',done:'1',position:'left'}]});
    await save();
  },patient);
  const workbook=await page.evaluate(()=>{
    const book=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book,XLSX.utils.json_to_sheet(patients),'patients');
    XLSX.utils.book_append_sheet(book,XLSX.utils.json_to_sheet(treatmentPlans.map(p=>({...p,cols:JSON.stringify(p.cols)}))),'treatmentPlans');
    return Array.from(new Uint8Array(XLSX.write(book,{bookType:'xlsx',type:'array'})));
  });
  page.on('dialog',dialog=>dialog.accept());
  await page.locator('#restore').setInputFiles({name:'roundtrip.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from(workbook)});
  await page.waitForFunction(()=>document.getElementById('toast').textContent.includes('استعادة البيانات بنجاح'));
  assert.equal((await data(page,PATIENTS))[0].fullName,'Excel Person');
  assert.deepEqual((await data(page,PLANS))[0].cols[0],{count:'2',done:'1',position:'left'});
  const before=await data(page,PATIENTS);
  const invalid={data:{patients:[{id:'bad',fullName:'Bad'}],visits:{not:'an array'}}};
  await page.locator('#restore').setInputFiles({name:'invalid.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(invalid))});
  await page.waitForFunction(()=>document.getElementById('toast').textContent.includes('غير صالح'));
  assert.deepEqual(await data(page,PATIENTS),before);
  const nestedRejected=await page.evaluate(async()=>{
    try{ await applyRestoredData({visits:[{id:'v',items:{invalid:true}}]},'invalid-test'); return false; }
    catch(e){ return true; }
  });
  assert.equal(nestedRejected,true);
});

test('changed passwords use salted PBKDF2 and legacy role passwords still work', async t => {
  const context=await createContext(t);
  const page=await open(context);
  await page.evaluate(()=>localStorage.setItem('oras-dental-morning-pass-v1','legacy-pass'));
  await page.reload();
  await login(page,'morning','legacy-pass');
  await page.locator('#roleLogoutBtn').click();
  await login(page);
  await nav(page,'settings');
  await page.locator('[data-action="change-role-pass"][data-role="manager"]').click();
  await page.locator('#adminPassInput').fill('new-secure-pass');
  await page.locator('#adminSubmitBtn').click();
  await page.waitForFunction(()=>document.getElementById('adminModalTitle').textContent.includes('تأكيد كلمة المرور'));
  await page.locator('#adminPassInput').fill('new-secure-pass');
  await page.locator('#adminSubmitBtn').click();
  await page.waitForFunction(()=>String(localStorage.getItem('oras-dental-manager-pass-v1')).startsWith('pbkdf2-sha256$'));
  const stored=await page.evaluate(()=>localStorage.getItem('oras-dental-manager-pass-v1'));
  assert.match(stored,/^pbkdf2-sha256\$210000\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  assert.ok(!stored.includes('new-secure-pass'));
  await page.locator('#roleLogoutBtn').click();
  await page.locator('[data-role-login="manager"]').click();
  await page.locator('#rolePasswordInput').fill('manager2026');
  await page.locator('#rolePasswordForm button[type="submit"]').click();
  await page.waitForFunction(()=>document.getElementById('rolePasswordError').textContent.includes('غير صحيحة'));
  await page.locator('#rolePasswordInput').fill('new-secure-pass');
  await page.locator('#rolePasswordForm button[type="submit"]').click();
  await page.locator('#roleGate').waitFor({state:'hidden'});
});

test('report notes reject simultaneous edits to the same reporting period', async t => {
  const context=await createContext(t);
  const a=await open(context), b=await open(context);
  await login(a); await login(b);
  for(const page of [a,b]){
    await nav(page,'reports');
    await page.locator('[data-report-tab="print"]').click();
  }
  await a.locator('#nlist-achievements input').first().fill('First editor note');
  await a.waitForFunction(key=>Object.values(JSON.parse(localStorage.getItem(key)||'{}')).some(n=>n.achievements?.[0]==='First editor note'),NARRATIVES);
  await b.locator('#nlist-achievements input').first().fill('Second editor note');
  await b.waitForFunction(()=>document.getElementById('storageWarning').textContent.includes('ملاحظات التقرير'));
  const persisted=JSON.parse(await b.evaluate(k=>localStorage.getItem(k),NARRATIVES));
  assert.equal(Object.values(persisted)[0].achievements[0],'First editor note');
  assert.equal(await b.locator('#nlist-achievements input').first().inputValue(),'Second editor note');
});

test('a partially failed multi-collection save rolls back and can be retried', async t => {
  const context=await createContext(t);
  const page=await open(context);
  await login(page);
  await createPatient(page,'Before transaction','80');
  const result=await page.evaluate(async ({pkey,vkey})=>{
    const set=Storage.prototype.setItem;
    Storage.prototype.setItem=function(key,value){ if(key===vkey) throw new Error('simulated quota failure'); return set.call(this,key,value); };
    patients[0].fullName='After transaction';
    visits.push({id:'transaction-visit',patientId:patients[0].id,patientName:'After transaction',date:todayString(),cost:10,paid:0,due:10});
    const success=await save();
    Storage.prototype.setItem=set;
    return {success,storedPatient:JSON.parse(localStorage.getItem(pkey))[0].fullName,storedVisits:JSON.parse(localStorage.getItem(vkey)||'[]').length,inMemory:patients[0].fullName};
  },{pkey:PATIENTS,vkey:VISITS});
  assert.deepEqual(result,{success:false,storedPatient:'Before transaction',storedVisits:0,inMemory:'After transaction'});
  assert.equal(await page.evaluate(()=>save()),true);
  assert.equal((await data(page,PATIENTS))[0].fullName,'After transaction');
  assert.equal((await data(page,VISITS)).length,1);
});

test('a patient cannot be removed after another tab adds a linked visit', async t => {
  const context=await createContext(t);
  const a=await open(context), b=await open(context);
  await login(a); await login(b);
  await createPatient(a,'Linked Person','81');
  const id=(await data(a,PATIENTS))[0].id;
  await b.waitForFunction(patientId=>patients.some(p=>p.id===patientId),id);
  await nav(a,'new-patient'); // Keep this tab's collection baseline deliberately stale.
  const saved=await b.evaluate(async patientId=>{
    visits.push({id:'new-linked-visit',patientId,patientName:'Linked Person',date:todayString(),cost:100,paid:0,due:100});
    return save();
  },id);
  assert.equal(saved,true);
  const deleted=await a.evaluate(async patientId=>{patients=patients.filter(p=>p.id!==patientId); return save();},id);
  assert.equal(deleted,false);
  assert.equal((await data(a,PATIENTS)).some(p=>p.id===id),true);
  assert.equal((await data(a,VISITS)).some(v=>v.patientId===id),true);
  assert.match(await a.locator('#storageWarning').textContent(),/مرتبطة/);
});

test('corrupted report notes preserve the automatic backup until explicitly restored', async t => {
  const context=await createContext(t);
  const page=await open(context);
  const key='2026-01-01_2026-01-31';
  await page.evaluate(({nkey,key})=>{
    localStorage.setItem(nkey,'{broken');
    localStorage.setItem('oras-dental-autobackup-v1',JSON.stringify({data:{narratives:{[key]:{achievements:['Recovered note'],challenges:[],marketing:[],nextTasks:[]}}}}));
  },{nkey:NARRATIVES,key});
  await page.reload();
  await login(page);
  assert.match(await page.locator('#storageWarning').textContent(),/تالفة/);
  assert.equal(await page.evaluate(k=>narratives[k].achievements[0],key),'Recovered note');
  await createPatient(page,'After corruption','82');
  assert.equal(await page.evaluate(k=>JSON.parse(localStorage.getItem('oras-dental-autobackup-v1')).data.narratives[k].achievements[0],key),'Recovered note');
  const restored=await page.evaluate(async ({key})=>applyRestoredData({narratives:{[key]:{achievements:['Restored note'],challenges:[],marketing:[],nextTasks:[]}}},'test'),{key});
  assert.equal(restored,true);
  assert.equal(JSON.parse(await page.evaluate(k=>localStorage.getItem(k),NARRATIVES))[key].achievements[0],'Restored note');
});

test('monthly report drafts survive unrelated updates and reject conflicting edits', async t => {
  const MONTHLY='oras-dental-monthly-reports-v1';
  const context=await createContext(t);
  const a=await open(context), b=await open(context), c=await open(context);
  await login(a); await login(b); await login(c);
  await nav(a,'reports');
  await a.locator('[data-report-tab="monthly"]').click();
  await a.locator('[data-action="new-monthly"]').click();
  await a.locator('.dyn-list[data-list="achievements"] input').first().fill('Original report');
  await a.locator('#mrSaveBtn').click();
  await waitCount(a,MONTHLY,1);
  await a.locator('[data-action="edit-monthly"]').click();
  await nav(b,'reports');
  await b.locator('[data-report-tab="monthly"]').click();
  await b.locator('[data-action="edit-monthly"]').click();
  await a.locator('.dyn-list[data-list="achievements"] input').first().fill('Tab A draft');
  await b.locator('.dyn-list[data-list="achievements"] input').first().fill('Tab B draft');
  await createPatient(c,'Unrelated update','90');
  assert.equal(await a.locator('.dyn-list[data-list="achievements"] input').first().inputValue(),'Tab A draft');
  assert.equal(await b.locator('.dyn-list[data-list="achievements"] input').first().inputValue(),'Tab B draft');
  await a.locator('.dyn-list[data-list="achievements"] input').first().fill('Tab A saved');
  await a.locator('#mrSaveBtn').click();
  await a.waitForFunction(k=>JSON.parse(localStorage.getItem(k)||'[]')[0]?.achievements?.[0]==='Tab A saved',MONTHLY);
  await b.locator('#mrSaveBtn').click();
  await b.waitForFunction(()=>document.getElementById('toast').textContent.includes('تغيّر هذا السجل'));
  assert.equal((await data(b,MONTHLY))[0].achievements[0],'Tab A saved');
  assert.equal(await b.locator('.dyn-list[data-list="achievements"] input').first().inputValue(),'Tab B draft');
});

test('blocked browser storage falls back to temporary memory with a clear warning', async t => {
  const context=await createContext(t);
  await context.addInitScript(()=>{
    Object.defineProperty(window,'localStorage',{configurable:false,get(){throw new DOMException('Blocked','SecurityError');}});
  });
  const page=await open(context);
  assert.match(await page.locator('#storageWarning').textContent(),/البيانات مؤقتة/);
  await login(page);
  await nav(page,'new-patient');
  await page.locator('#pForm [name="fullName"]').fill('Temporary patient');
  await page.locator('#pForm [name="phone"]').fill('0912345678');
  await page.locator('#pForm button[type="submit"]').click();
  await page.locator('#pForm').waitFor({state:'detached'});
  assert.equal(await page.evaluate(()=>patients.length),1);
  assert.match(await page.locator('#storageWarning').textContent(),/البيانات مؤقتة/);
});

test('backups include other tabs report notes without discarding local conflicts', async t => {
  const context=await createContext(t,{acceptDownloads:true});
  const a=await open(context), b=await open(context);
  await login(a); await login(b);
  for(const page of [a,b]){
    await nav(page,'reports');
    await page.locator('[data-report-tab="print"]').click();
    await page.evaluate(()=>{window.showSaveFilePicker=undefined;});
  }
  await a.locator('#nlist-achievements input').first().fill('Persisted in first tab');
  await a.waitForFunction(key=>Object.values(JSON.parse(localStorage.getItem(key)||'{}')).some(n=>n.achievements?.[0]==='Persisted in first tab'),NARRATIVES);
  const takeBackup=async page=>{
    const promise=page.waitForEvent('download');
    await page.locator('.sidebar [data-action="backup"]').click();
    return JSON.parse(await fs.readFile(await (await promise).path(),'utf8'));
  };
  let backup=await takeBackup(b);
  assert.equal(Object.values(backup.data.narratives)[0].achievements[0],'Persisted in first tab');
  await b.locator('#nlist-achievements input').first().fill('Unsaved second tab note');
  await b.waitForFunction(()=>document.getElementById('storageWarning').textContent.includes('ملاحظات التقرير'));
  backup=await takeBackup(b);
  assert.equal(Object.values(backup.data.narratives)[0].achievements[0],'Unsaved second tab note');
  assert.equal(Object.values(JSON.parse(await b.evaluate(k=>localStorage.getItem(k),NARRATIVES)))[0].achievements[0],'Persisted in first tab');
});

test('parallel visits for one patient receive distinct visit numbers', async t => {
  const context=await createContext(t);
  const a=await open(context), b=await open(context);
  await login(a); await login(b);
  await createPatient(a,'Concurrent Visit Patient','91');
  const patient=(await data(a,PATIENTS))[0];
  await b.waitForFunction(id=>patients.some(p=>p.id===id),patient.id);
  const make=page=>page.evaluate(async p=>{
    visits.push({id:uid('visit'),patientId:p.id,patientName:p.fullName,date:todayString(),visitNum:'1',cost:100,paid:0,due:100});
    return save();
  },patient);
  const saved=await Promise.all([make(a),make(b)]);
  assert.deepEqual(saved,[true,true]);
  const numbers=(await data(a,VISITS)).map(v=>Number(v.visitNum)).sort((x,y)=>x-y);
  assert.deepEqual(numbers,[1,2]);
});

const PROCEDURES = 'oras-dental-procedures-v1';
const PRICING = 'oras-dental-pricing-v1';
const AUTOBACKUP = 'oras-dental-autobackup-v1';

test('USD prices use an explicit saved rate, preserve unlinked and historical prices, and survive backups', async t => {
  const context=await createContext(t);
  const page=await open(context); await login(page);
  await createPatient(page,'Currency Patient','910');
  await page.locator('#table [data-action="new-visit-for"]').click();
  await page.locator('#vForm button[type="submit"]').click();
  await waitCount(page,VISITS,1);
  const original=await data(page,VISITS);
  assert.equal(original[0].cost,10000);

  await nav(page,'settings');
  await page.locator('.proc-usd-input').first().fill('12.5');
  assert.equal(await page.locator('#usdExchangeRate').evaluate(el=>el.checkValidity()),false,'USD prices need a rate');
  await page.locator('#savePricingBtn').click();
  assert.equal(await page.evaluate(k=>localStorage.getItem(k),PRICING),null);
  await page.locator('#usdExchangeRate').fill('2000');
  assert.equal(await page.locator('.proc-cost-input').first().inputValue(),'25000');
  assert.equal(await page.locator('.proc-cost-input').first().evaluate(el=>el.readOnly),true);
  assert.equal(await page.locator('.proc-cost-input').nth(1).inputValue(),'18000');
  await page.locator('.proc-cost-input').nth(1).fill('19000.123');
  await page.locator('#savePricingBtn').click();
  await page.waitForFunction(k=>JSON.parse(localStorage.getItem(k)||'[]')[0]?.rate===2000,PRICING);
  assert.deepEqual((await data(page,PROCEDURES)).slice(0,2).map(p=>[p.cost,p.usdPrice??null]),[[25000,12.5],[19000.123,null]]);
  const autobackup=await page.evaluate(k=>JSON.parse(localStorage.getItem(k)),AUTOBACKUP);
  assert.equal(autobackup.data.pricing[0].rate,2000);
  assert.equal(autobackup.data.procedures[0].usdPrice,12.5);

  await page.reload(); await login(page); await nav(page,'settings');
  assert.equal(await page.locator('#usdExchangeRate').inputValue(),'2000');
  assert.equal(await page.locator('.proc-usd-input').first().inputValue(),'12.5');
  await page.locator('#usdExchangeRate').fill('3000');
  assert.equal(await page.locator('.proc-cost-input').first().inputValue(),'37500');
  await page.locator('#savePricingBtn').click();
  await page.waitForFunction(k=>JSON.parse(localStorage.getItem(k)||'[]')[0]?.rate===3000,PRICING);
  assert.equal((await data(page,PROCEDURES))[0].cost,37500);
  assert.equal((await data(page,PROCEDURES))[1].cost,19000.123,'changing the rate must not round an unlinked historical price');
  for(const bad of [[],[{id:'usd-sdg',rate:1000000000000}]]){
    assert.equal(await page.evaluate(async value=>{
      try{await applyRestoredData({pricing:value},'invalid-pricing-combination');return false;}catch(e){return true;}
    },bad),true,'a partial restore must not leave a linked price without a usable rate');
  }
  assert.equal((await data(page,PRICING))[0].rate,3000);
  assert.deepEqual(await data(page,VISITS),original,'changing exchange rates must not reprice saved visits');
  await nav(page,'visits');
  await page.locator(`#visitsTable [data-action="edit-visit"][data-id="${original[0].id}"]`).click();
  assert.equal(await page.locator('#vTotalCost').inputValue(),'10000','editing an old visit must open its saved price');

  await nav(page,'patients');
  await page.locator('#table [data-action="new-visit-for"]').click();
  assert.equal(await page.locator('#vTotalCost').inputValue(),'37500','new visits use the current converted price');
  await nav(page,'settings');
  await page.locator('.proc-usd-input').first().fill('');
  assert.equal(await page.locator('.proc-cost-input').first().evaluate(el=>el.readOnly),false);
  await page.locator('.proc-cost-input').first().fill('40000');
  await page.locator('#usdExchangeRate').fill('4000');
  assert.equal(await page.locator('.proc-cost-input').first().inputValue(),'40000','unlinked prices remain manual');
  await page.locator('#savePricingBtn').click();
  await page.waitForFunction(k=>JSON.parse(localStorage.getItem(k)||'[]')[0]?.rate===4000,PRICING);
  assert.deepEqual([(await data(page,PROCEDURES))[0].cost,(await data(page,PROCEDURES))[0].usdPrice??null],[40000,null]);
  const backup=await page.evaluate(async()=>{
    let result; saveBlob=async blob=>{result=JSON.parse(await blob.text());return true;};
    await backupToJSON(); return result;
  });
  assert.equal(backup.data.pricing[0].rate,4000);
  assert.equal(backup.data.procedures[0].cost,40000);
  assert.deepEqual(backup.data.visits,original);
  await page.locator('#usdExchangeRate').fill('5000');
  await page.locator('#savePricingBtn').click();
  await page.waitForFunction(k=>JSON.parse(localStorage.getItem(k)||'[]')[0]?.rate===5000,PRICING);
  assert.equal(await page.evaluate(async saved=>applyRestoredData(saved.data,'test-pricing-restore'),backup),true);
  assert.equal((await data(page,PRICING))[0].rate,4000);
  assert.equal((await data(page,PROCEDURES))[0].cost,40000);
  assert.deepEqual(await data(page,VISITS),original);
  assert.equal(await page.evaluate(k=>JSON.parse(localStorage.getItem(k)).data.pricing[0].rate,RECOVERY),5000);
  assert.equal(await page.evaluate(async saved=>applyRestoredData(saved.data,'test-linked-pricing-restore'),autobackup),true);
  assert.equal((await data(page,PRICING))[0].rate,2000);
  assert.deepEqual([(await data(page,PROCEDURES))[0].usdPrice,(await data(page,PROCEDURES))[0].cost],[12.5,25000]);
  assert.deepEqual(await data(page,VISITS),original);
  assert.equal(await page.evaluate(async()=>{
    try{await applyRestoredData({pricing:[{id:'usd-sdg',rate:0}]},'invalid-pricing');return false;}
    catch(e){return true;}
  }),true,'invalid backup rates must be rejected');
});

test('bulk pricing rejects invalid rates and stale edits instead of overwriting another window', async t => {
  const context=await createContext(t);
  const a=await open(context), b=await open(context); await login(a); await login(b);
  await nav(a,'settings'); await nav(b,'settings');
  await a.locator('#usdExchangeRate').fill('0');
  assert.equal(await a.locator('#usdExchangeRate').evaluate(el=>el.checkValidity()),false);
  await a.locator('#usdExchangeRate').fill('1000000000000');
  await a.locator('.proc-usd-input').first().fill('2');
  assert.equal(await a.locator('.proc-usd-input').first().evaluate(el=>el.checkValidity()),false,'converted price must be within the safe limit');
  await a.locator('#usdExchangeRate').fill('1000');
  await a.locator('.proc-usd-input').first().fill('10');

  await b.locator('#usdExchangeRate').fill('2000');
  await b.locator('.proc-usd-input').first().fill('20');
  await b.locator('#savePricingBtn').click();
  await b.waitForFunction(k=>JSON.parse(localStorage.getItem(k)||'[]')[0]?.rate===2000,PRICING);
  await a.locator('#savePricingBtn').click();
  assert.match(await a.locator('#toast').textContent(),/تغيّرت الأسعار/);
  assert.equal((await data(a,PRICING))[0].rate,2000);
  assert.equal((await data(a,PROCEDURES))[0].cost,40000);
});

test('visit discounts affect net charges, debt, service revenue and the completed-only indicator', async t => {
  const context=await createContext(t,{acceptDownloads:true});
  const page=await open(context); await login(page); await createPatient(page,'Discount Patient','911');
  await page.locator('#table [data-action="new-visit-for"]').click();
  await page.locator('#addProcedureRowBtn').click();
  await page.locator('#procedureList .proc-select').nth(1).selectOption('تنظيف الأسنان');
  await page.locator('#procedureList .proc-cost').nth(1).fill('16000'); // 2,000 less than the selected catalogue price
  await page.locator('#vDiscountType').selectOption('percent');
  await page.locator('#vDiscountValue').fill('10');
  await page.locator('#vPaid').fill('5000');
  assert.deepEqual(await Promise.all(['#vGrossCost','#vDiscountAmount','#vTotalDiscount','#vTotalCost','#vDue'].map(x=>page.locator(x).inputValue())),
    ['26000','2600','4600','23400','18400']);
  await page.locator('#vForm button[type="submit"]').click(); await waitCount(page,VISITS,1);
  let visit=(await data(page,VISITS))[0];
  assert.deepEqual([visit.items[1].catalogPrice,visit.grossCost,visit.discountType,visit.discountValue,visit.discountAmount,visit.cost,visit.paid,visit.due],
    [18000,26000,'percent',10,2600,23400,5000,18400]);
  const patientId=visit.patientId;
  await page.evaluate(async patientId=>{
    for(const status of ['محجوزة','ملغاة']) visits.push({id:'excluded-'+status,patientId,date:todayString(),status,cost:9000,paid:0,due:9000,discountAmount:1000,items:[{procedure:'فحص وتشخيص',cost:10000,catalogPrice:10000}]});
    await save();
  },patientId);
  await page.locator('.sidebar button[data-view="dashboard"]').click();
  const indicator=await page.locator('#discountIndicator').textContent();
  assert.ok(indicator.includes(await page.evaluate(()=>money(4600))));
  assert.match(indicator,/لا يمثّل ديون المرضى أو النقد المفقود/);
  const computed=await page.evaluate(()=>{
    const c=computeRange(...reportRange());
    const shares=visitNetItems({items:[{procedure:'A',cost:.01},{procedure:'B',cost:.01},{procedure:'C',cost:.01}],discountAmount:.01});
    return {rev:c.rev,paid:c.paid,due:c.due,discounts:c.discounts,count:c.discountedVisits,
      services:Object.fromEntries(Object.entries(c.svc).map(([k,v])=>[k,v.total])),shares:shares.map(x=>x.cost)};
  });
  assert.deepEqual([computed.rev,computed.paid,computed.due,computed.discounts,computed.count],[23400,5000,18400,4600,1]);
  assert.deepEqual(computed.services,{'فحص وتشخيص':9000,'تنظيف الأسنان':14400});
  assert.equal(Math.round(computed.shares.reduce((a,b)=>a+b,0)*100),2,'rounded service amounts must sum to the invoice');

  await nav(page,'reports');
  assert.match(await page.locator('#reportTabContent').textContent(),/المبالغ المخفّضة المسجّلة/);
  const exportSummary=await page.evaluate(()=>{
    let book; XLSX.writeFile=wb=>{book=wb;}; exportReportExcel();
    return XLSX.utils.sheet_to_json(book.Sheets['الملخص'],{header:1});
  });
  assert.equal(exportSummary.find(row=>row[0]==='الخصومات والتخفيضات المسجّلة')[1],4600);
  await page.locator('[data-report-tab="print"]').click();
  assert.match(await page.locator('#reportTabContent').textContent(),/الخصومات والتخفيضات المسجّلة/);

  await nav(page,'visits');
  await page.evaluate(()=>{window.showSaveFilePicker=undefined;});
  const downloadPromise=page.waitForEvent('download');
  await page.locator('[data-action="export-visits"]').click();
  const bytes=await fs.readFile(await (await downloadPromise).path());
  const exportRows=await page.evaluate(bytes=>{
    const book=XLSX.read(Uint8Array.from(bytes),{type:'array'});
    return {visits:XLSX.utils.sheet_to_json(book.Sheets['الزيارات'],{header:1}),summary:XLSX.utils.sheet_to_json(book.Sheets['الملخص'],{header:1})};
  },[...bytes]);
  const header=exportRows.visits[0], actual=exportRows.visits.find(row=>row[header.indexOf('حالة الزيارة')]==='مكتملة');
  assert.equal(actual[header.indexOf('إجمالي التخفيض المسجّل (ج.س)')],4600);
  assert.equal(actual[header.indexOf('الإجمالي بعد الخصم (ج.س)')],23400);
  assert.equal(exportRows.summary.find(row=>row[0]==='التخفيضات المسجّلة (ج.س)')[1],4600);

  await page.locator(`#visitsTable [data-action="edit-visit"][data-id="${visit.id}"]`).click();
  assert.equal(await page.locator('#vDiscountType').inputValue(),'percent');
  assert.equal(await page.locator('#vTotalDiscount').inputValue(),'4600');
  await page.locator('#vPaid').fill('6000');
  await page.locator('#vForm button[type="submit"]').click();
  await page.waitForFunction(([k,id])=>JSON.parse(localStorage.getItem(k)||'[]').find(v=>v.id===id)?.paid===6000,[VISITS,visit.id]);
  visit=(await data(page,VISITS)).find(v=>v.id===visit.id);
  assert.equal(visit.due,17400); assert.equal(visit.discountAmount,2600);
  assert.equal(await page.evaluate(id=>visitTotalDiscount(visits.find(v=>v.id===id)),visit.id),4600);
});

test('visit discounts reject invalid values and allow a zero-balance 100 percent discount', async t => {
  const context=await createContext(t);
  const page=await open(context); await login(page); await createPatient(page,'Validation Patient','912');
  await page.locator('#table [data-action="new-visit-for"]').click();
  await page.locator('#vDiscountValue').fill('10001');
  assert.equal(await page.locator('#vDiscountValue').evaluate(el=>el.checkValidity()),false);
  await page.locator('#vForm button[type="submit"]').click();
  assert.equal((await data(page,VISITS)).length,0);
  await page.locator('#vDiscountType').selectOption('percent');
  await page.locator('#vDiscountValue').fill('101');
  assert.equal(await page.locator('#vDiscountValue').evaluate(el=>el.checkValidity()),false);
  await page.locator('#vDiscountValue').fill('100');
  await page.locator('#vPaid').fill('1');
  assert.equal(await page.locator('#vPaid').evaluate(el=>el.checkValidity()),false);
  assert.equal(await page.locator('#vTotalCost').inputValue(),'0');
  await page.locator('#vPaid').fill('0');
  await page.locator('#vForm button[type="submit"]').click(); await waitCount(page,VISITS,1);
  const visit=(await data(page,VISITS))[0];
  assert.deepEqual([visit.discountAmount,visit.cost,visit.paid,visit.due],[10000,0,0,0]);
});

test('legacy visits do not acquire invented discounts after catalogue prices change', async t => {
  const context=await createContext(t);
  const page=await open(context);
  await page.evaluate(({pkey,vkey})=>{
    localStorage.setItem(pkey,JSON.stringify([{id:'legacy-p',file:'913',fullName:'Legacy patient',phone:'0912345678'}]));
    localStorage.setItem(vkey,JSON.stringify([{id:'legacy-v',patientId:'legacy-p',date:todayString(),status:'مكتملة',cost:6000,paid:0,due:6000,items:[{procedure:'فحص وتشخيص',cost:6000}]}]));
  },{pkey:PATIENTS,vkey:VISITS});
  await page.reload(); await login(page);
  assert.equal(await page.evaluate(()=>visitTotalDiscount(visits[0])),0);
  await nav(page,'visits');
  await page.locator('#visitsTable [data-action="edit-visit"]').click();
  assert.equal(await page.locator('#vTotalCost').inputValue(),'6000');
  assert.equal(await page.locator('#vTotalDiscount').inputValue(),'0');
  await page.locator('#vForm button[type="submit"]').click();
  await page.waitForFunction(k=>JSON.parse(localStorage.getItem(k)||'[]')[0]?.items?.[0]?.catalogPrice===6000,VISITS);
  assert.equal(await page.evaluate(()=>visitTotalDiscount(visits[0])),0);
});

test('unsaved bulk prices are not silently discarded when navigating or changing theme', async t => {
  const context=await createContext(t);
  const page=await open(context); await login(page); await nav(page,'settings');
  await page.locator('#usdExchangeRate').fill('2000');
  await page.locator('.proc-usd-input').first().fill('11');
  let warning='';
  page.once('dialog',async d=>{warning=d.message();await d.dismiss();});
  await nav(page,'patients');
  assert.match(warning,/تغييرات أسعار غير محفوظة/);
  assert.equal(await page.locator('#pricingForm').isVisible(),true);
  assert.equal(await page.locator('.proc-usd-input').first().inputValue(),'11');
  page.once('dialog',d=>d.accept());
  await nav(page,'patients');
  assert.equal(await page.locator('#table').isVisible(),true);
  assert.equal(await page.evaluate(k=>localStorage.getItem(k),PRICING),null);
});

test('fractional visit amounts are rounded consistently across payments, balances and service reports', async t => {
  const context=await createContext(t);
  const page=await open(context); await login(page); await createPatient(page,'Fraction Patient','914');
  await page.locator('#table [data-action="new-visit-for"]').click();
  await page.locator('#procedureList .proc-cost').first().fill('10.005');
  await page.locator('#vDiscountValue').fill('0.004');
  await page.locator('#vPaid').fill('5.005');
  assert.equal(await page.locator('#vTotalCost').inputValue(),'10.01');
  assert.equal(await page.locator('#vDue').inputValue(),'5');
  await page.locator('#vForm button[type="submit"]').click(); await waitCount(page,VISITS,1);
  const saved=(await data(page,VISITS))[0];
  assert.deepEqual([saved.cost,saved.paid,saved.due],[10.01,5.01,5]);
  const computed=await page.evaluate(()=>{const c=computeRange(...reportRange()); return {rev:c.rev,services:Object.values(c.svc).map(x=>x.total)};});
  assert.equal(computed.rev,10.01);
  assert.equal(computed.services[0],10.01);
  const rounding=await page.evaluate(()=>[roundMoney(1.005),roundMoney(10.075),roundMoney(0.004),roundMoney(-1.005)]);
  assert.deepEqual(rounding,[1.01,10.08,0,-1.01]);
  const exports=await page.evaluate(async()=>{
    let reportBook,visitsBook;
    XLSX.writeFile=book=>{reportBook=book;}; exportReportExcel();
    saveWorkbook=async book=>{visitsBook=book;return true;}; await exportVisitsExcel();
    return {report:XLSX.utils.sheet_to_json(reportBook.Sheets['الملخص'],{header:1}),visits:XLSX.utils.sheet_to_json(visitsBook.Sheets['الملخص'],{header:1})};
  });
  assert.equal(exports.report.find(row=>row[0]==='إجمالي الإيراد بعد الخصومات')[1],10.01);
  assert.equal(exports.report.find(row=>row[0]==='المحصّل فعلياً')[1],5.01);
  assert.equal(exports.visits.find(row=>row[0]==='إجمالي قيمة العلاج بعد الخصم (ج.س)')[1],10.01);
  assert.equal(exports.visits.find(row=>row[0]==='إجمالي المدفوع (ج.س)')[1],5.01);
  const fallback=await page.evaluate(()=>visitNetItems({procedure:'Old',cost:70,discountAmount:30})[0].cost);
  assert.equal(fallback,70,'legacy-style imported visits should not have the discount applied twice');
  await page.evaluate(async()=>{
    visits.push({id:'imported-discount',patientId:patients[0].id,date:todayString(),status:'مكتملة',procedure:'فحص وتشخيص',grossCost:100,cost:70,discountType:'percent',discountAmount:30,paid:0,due:70});
    await save();
  });
  await nav(page,'visits');
  await page.locator('#visitsTable [data-action="edit-visit"][data-id="imported-discount"]').click();
  assert.equal(await page.locator('#vGrossCost').inputValue(),'100');
  assert.equal(await page.locator('#vDiscountType').inputValue(),'amount');
  assert.equal(await page.locator('#vDiscountValue').inputValue(),'30');
  assert.equal(await page.locator('#vTotalCost').inputValue(),'70');
  await page.locator('#vForm button[type="submit"]').click();
  await page.waitForFunction(k=>JSON.parse(localStorage.getItem(k)||'[]').find(v=>v.id==='imported-discount')?.items?.length===1,VISITS);
  assert.equal((await data(page,VISITS)).find(v=>v.id==='imported-discount').cost,70);
});

test('an incomplete dollar pricing configuration warns and uses the last saved Sudanese price', async t => {
  const context=await createContext(t);
  const page=await open(context);
  await page.evaluate(k=>localStorage.setItem(k,JSON.stringify([{id:'linked',name:'Stored procedure',cost:17000,usdPrice:10}])),PROCEDURES);
  await page.reload();
  assert.match(await page.locator('#storageWarning').textContent(),/لا تملك سعر صرف صالحاً/);
  await login(page); await nav(page,'settings');
  assert.equal(await page.locator('.proc-cost-input').first().inputValue(),'17000');
  await page.locator('#usdExchangeRate').fill('1000');
  assert.equal(await page.locator('.proc-cost-input').first().inputValue(),'10000');
  await page.locator('#savePricingBtn').click();
  await page.waitForFunction(()=>document.querySelector('#toast')?.textContent.includes('تم حفظ سعر الصرف'));
  assert.equal(await page.locator('#storageWarning').isHidden(),true);
});
