/* جسر المالية مع نظام أوراس الحالي. يحافظ على السجلات القديمة ويزامنها مع الدفتر المالي. */
(function(){
'use strict';
const C=window.OrasFinanceCore;
if(!C){console.error('OrasFinanceCore missing');return;}
const KEY='oras-dental-finance-v2';
let state=null, ready=false;
const clone=C.clone;
function readRaw(){try{const s=localStorage.getItem(KEY);return s?JSON.parse(s):null;}catch(e){return null;}}
function migrate(){
 let s=C.emptyState();
 s.migrationWarnings.push('تم ترحيل السجلات القديمة دون اعتماد أسعار أو تواريخ استحقاق بأثر رجعي. راجعها من إعدادات التقارير قبل الإصدار الرسمي.');
 (visits||[]).forEach(v=>{
  const cost=Number(v.cost||0);
  if(cost>0){
   const items=Array.isArray(v.items)&&v.items.length?v.items:[{procedure:v.procedure||v.treatment||'خدمة قديمة',cost}];
   const lines=items.map((it,i)=>{const net=C.round2(Number(it.cost||0));return{procedureId:'legacy-'+(it.procedureId||i),name:it.procedure||'خدمة قديمة',qty:1,unitPrice:net,priceBookId:'legacy',gross:net,discountPct:0,discount:0,approval:null,net};});
   const net=C.round2(sumLines(lines));
   const inv={id:'inv-legacy-'+v.id,visitId:String(v.id),patientId:String(v.patientId||''),status:'issued',legacyUnallocatedPayment:Number(v.paid||0)>0?Number(v.paid||0):0,versions:[{visitId:String(v.id),patientId:String(v.patientId||''),serviceDate:C.isDate(v.date)?v.date:today,doctor:v.doctor||'غير محدد',lines,gross:net,discount:0,net,directMaterials:0,directLab:0,priceBookId:'legacy',legacy:true,version:1,createdAt:new Date().toISOString(),createdBy:'ترحيل قديم',reason:'ترحيل من سجل الزيارات القديم'}]};
   s.invoices.push(inv);
   s.revenuePostings.push({id:'rev-legacy-'+v.id,invoiceId:inv.id,version:1,serviceMonth:C.monthOf(inv.versions[0].serviceDate),postingMonth:C.monthOf(inv.versions[0].serviceDate),amount:net,kind:'initial',legacy:true,createdAt:new Date().toISOString()});
  } else if(Array.isArray(v.items)&&v.items.length){s.migrationWarnings.push('زيارة قديمة بلا إجمالي فاتورة: '+v.id);}
 });
 (expenses||[]).forEach(e=>{
  const paid=C.isDate(expDate(e))?expDate(e):today, amount=Number(e.amount||0);
  if(amount<=0)return;
  const id='exp-legacy-'+e.id;
  s.expenses.push({id,sourceId:String(e.id),legacy:true,versions:[{title:e.title||'مصروف قديم',amount:C.round2(amount),paidDate:paid,accrualMonth:C.monthOf(paid),category:e.category||'عام',type:e.type||'متغيرة',costKind:'operating',doctor:'',sourceId:String(e.id),reference:'',notes:e.notes||'',legacyAccrual:true,version:1,createdAt:new Date().toISOString(),createdBy:'ترحيل قديم',reason:'ترحيل من سجل المصاريف القديم'}]});
  s.expensePostings.push({id:'expp-legacy-'+e.id,expenseId:id,version:1,postingMonth:C.monthOf(paid),amount:C.round2(amount),paidDate:paid,paidDelta:C.round2(amount),category:e.category||'عام',costKind:'operating',doctor:'',kind:'initial',legacyAccrual:true,createdAt:new Date().toISOString()});
 });
 (labs||[]).forEach(l=>{const amount=Number(l.cost||0);if(amount<=0||l.status==='ملغى')return;const paid=C.isDate(l.date)?l.date:today,id='exp-lab-'+l.id;s.expenses.push({id,sourceId:'lab:'+l.id,legacy:true,versions:[{title:'معمل: '+(l.workType||l.labName||'طلب قديم'),amount:C.round2(amount),paidDate:paid,accrualMonth:C.monthOf(paid),category:'معامل أسنان',type:'متغيرة',costKind:'lab',sourceId:'lab:'+l.id,legacyAccrual:true,version:1,createdAt:new Date().toISOString(),createdBy:'ترحيل قديم',reason:'ترحيل تكلفة معمل قديمة'}]});s.expensePostings.push({id:'expp-'+id,expenseId:id,version:1,postingMonth:C.monthOf(paid),amount:C.round2(amount),paidDate:paid,paidDelta:C.round2(amount),category:'معامل أسنان',costKind:'lab',kind:'initial',legacyAccrual:true,createdAt:new Date().toISOString()});});
 return s;
}
function sumLines(lines){return lines.reduce((s,l)=>s+Number(l.net||0),0);}
function init(){const raw=readRaw();state=raw&&raw.schemaVersion===2?C.normalizeState(raw):migrate();ready=true;if(!raw)persistOnly();}
function persistOnly(){try{localStorage.setItem(KEY,JSON.stringify(state));return true;}catch(e){return false;}}
function snapshot(){return state?clone(state):null;}
function restoreState(s){if(!s||typeof s!=='object'||s.schemaVersion!==2)throw new Error('الحالة المالية غير صالحة للاستعادة.');state=C.normalizeState(s);persistOnly();}
function reload(){const raw=readRaw();if(raw&&raw.schemaVersion===2)state=C.normalizeState(raw);}
function actor(){return typeof roleTitle==='function'&&currentRole?roleTitle(currentRole):'مدير العيادة';}
function meta(extra={}){return{actor:actor(),now:new Date().toISOString(),...extra};}
async function commit(next,legacyFn){
 const before={state:clone(state),visits:clone(visits),expenses:clone(expenses),procedures:clone(procedures),labs:clone(labs),monthlyReports:clone(monthlyReports)};
 state=next;if(legacyFn)legacyFn();
 const ok=await save();
 if(!ok){state=before.state;visits=before.visits;expenses=before.expenses;procedures=before.procedures;labs=before.labs;monthlyReports=before.monthlyReports;await save();throw new Error('تعذر حفظ الدفتر المالي؛ تم التراجع عن التغيير. صدّر نسخة احتياطية ولا تغلق الصفحة.');}
 return true;
}
function syncVisit(v,inv){if(!inv){v.cost=0;v.paid=0;v.due=0;return;}const ver=C.currentInvoiceVersion(inv);v.cost=ver.net;v.due=Math.max(0,C.invoiceBalance(state,inv.id));v.paid=C.round2(ver.net-v.due);v.financeInvoiceId=inv.id;}
function findInvoiceByVisit(id){return state.invoices.find(i=>i.visitId===String(id)&&i.status!=='void');}
function findExpenseByLegacy(id){return state.expenses.find(e=>e.id===id||e.sourceId===String(id));}
function currentOpenMonth(){let m=C.monthOf(today);if(state.closings.some(c=>c.month===m)){const d=new Date(today+'T00:00:00');d.setMonth(d.getMonth()+1);m=d.toISOString().slice(0,7);}return m;}
async function handleVisitForm(form){
 const fd=new FormData(form),data=Object.fromEntries(fd.entries());
 const billingMode=data.billingMode||'invoice';
 const status=data.attendanceStatus||'مكتملة';
 const p=getPatient(data.patientId);if(p)data.patientName=p.fullName;
 if(isEmployeeRole())data.shift=currentRole==='morning'?'صباح':'مساء';
 data.status=status;data.confirmed=data.confirmed==='on';
 data.arrivalTime=data.arrivalTime||'';data.startTime=data.startTime||'';data.endTime=data.endTime||'';
 if(data.startTime&&data.endTime&&data.endTime<=data.startTime){message('نهاية الجلسة يجب أن تكون بعد بدايتها.');return false;}
 if(data.arrivalTime&&data.startTime&&data.startTime<data.arrivalTime){message('بداية العلاج لا تسبق وصول المريض.');return false;}
 const wantEdit=view==='edit-visit'&&editingVisitId;
 const idx=wantEdit?visits.findIndex(v=>v.id===editingVisitId):-1;
 if(wantEdit&&idx<0){message('الزيارة الأصلية غير موجودة.');return false;}
 const id=wantEdit?editingVisitId:uid('v');
 const serviceDate=data.date||today;
 if(!C.isDate(serviceDate)){message('تاريخ الزيارة غير صالح.');return false;}
 let next=clone(state),inv=wantEdit?findInvoiceByVisit(id):null;
 const legacyReadOnly=!!(inv&&C.currentInvoiceVersion(inv).legacy&&!C.currentInvoiceVersion(inv).legacyReviewed);
 const needsInvoice=billingMode==='invoice'&&!['no_show','cancelled','ملغاة','rescheduled'].includes(status);
 if(needsInvoice&&!legacyReadOnly){
  const lines=[];let bad=false;
  form.querySelectorAll('.procedure-item').forEach(row=>{const sel=row.querySelector('.proc-select');const qty=row.querySelector('.proc-qty');const disc=row.querySelector('.proc-discount');const reason=row.querySelector('.proc-discount-reason');if(!sel)return;const procedureId=sel.value;const book=inv?next.priceBooks.find(b=>b.id===C.currentInvoiceVersion(inv).priceBookId):C.activePriceBook(next,serviceDate);const item=book&&book.items.find(i=>i.id===procedureId);if(!item){bad=true;return;}const discountPct=Number(disc?.value||0);lines.push({procedureId,qty:Number(qty?.value||1),unitPrice:item.cost,discountPct,approval:discountPct>0?{by:actor(),role:currentRole||'manager',reason:reason?.value||'',date:serviceDate}:null});});
  if(bad||!lines.length){message('لا يوجد إصدار أسعار معلن لهذه الخدمات في تاريخ الزيارة. أعلن الأسعار من إعدادات التقارير أولاً.');return false;}
  const draft={visitId:id,patientId:data.patientId,serviceDate,doctor:data.doctor||'غير محدد',lines,notes:data.notes||''};
  try{
   if(inv){const old=C.currentInvoiceVersion(inv);const reason=data.correctionReason||'';if(!reason.trim()){message('تعديل زيارة لها فاتورة يحتاج سبب تصحيح.');return false;}const out=C.correctInvoice(next,inv.id,draft,currentOpenMonth(),meta({reason}));next=out.state;inv=out.invoice;}
   else{const out=C.addInvoice(next,draft,meta({id:'inv-'+id}));next=out.state;inv=out.invoice;}
   const paid=Number(data.paid||0);
   if(!wantEdit&&paid>0){const out=C.recordCash(next,{kind:'receipt',date:data.paymentDate||serviceDate,amount:paid,patientId:data.patientId,allocations:[{invoiceId:inv.id,amount:paid}],reference:data.paymentReference||''},meta());next=out.state;}
   if(wantEdit){const bal=C.invoiceBalance(next,inv.id);const addPaid=Number(data.additionalPaid||0);if(addPaid>0){const out=C.recordCash(next,{kind:'receipt',date:data.paymentDate||today,amount:addPaid,patientId:data.patientId,allocations:[{invoiceId:inv.id,amount:addPaid}],reference:data.paymentReference||''},meta());next=out.state;}}
  }catch(e){message(e.message);return false;}
 } else if(wantEdit&&inv&&!legacyReadOnly){message('لا يمكن تحويل فاتورة قائمة إلى زيارة بلا فاتورة؛ ألغِ الفاتورة بسبب موثق أولاً.');return false;}
 const visitData={...data,id,patientId:data.patientId,patientName:data.patientName||'',date:serviceDate,items:inv?C.currentInvoiceVersion(inv).lines.map(l=>({procedure:l.name,procedureId:l.procedureId,cost:l.net,qty:l.qty})):[],cost:inv?C.currentInvoiceVersion(inv).net:0,paid:0,due:0,billingMode,confirmed:data.confirmed,arrivalTime:data.arrivalTime,startTime:data.startTime,endTime:data.endTime};
 await commit(next,()=>{if(wantEdit){visits[idx]={...visits[idx],...visitData};syncVisit(visits[idx],inv);}else{visits.push(visitData);syncVisit(visitData,inv);}});
 editingVisitId=null;view='visits';render();message(legacyReadOnly?'تم حفظ بيانات الزيارة؛ الفاتورة القديمة تحتاج مراجعة مالية موثقة قبل تعديل قيمتها.':wantEdit?'تم حفظ التصحيح بإصدار جديد مع الاحتفاظ بالسابق.':'تم حفظ الزيارة والفاتورة وفق القواعد المعتمدة.');return true;
}
function expenseFieldsFinance(init={}){return[
 {name:'title',label:'وصف المصروف',type:'text',value:init.title||'',required:true},
 {name:'amount',label:'المبلغ (ج.س)',type:'number',value:init.amount||'',required:true},
 {name:'paidDate',label:'تاريخ الدفع الفعلي',type:'date',value:init.paidDate||init.date||today,required:true},
 {name:'accrualMonth',label:'شهر الاستحقاق (YYYY-MM)',type:'month',value:init.accrualMonth||C.monthOf(init.paidDate||init.date||today),required:true},
 {name:'type',label:'النوع',type:'select',options:[{value:'ثابتة',label:'ثابتة'},{value:'متغيرة',label:'متغيرة'}],value:init.type||'متغيرة'},
 {name:'category',label:'التصنيف المحدد',type:'select',options:EXPENSE_CATEGORIES.map(c=>({value:c,label:c})),value:init.category||'مصروفات تشغيلية'},
 {name:'costKind',label:'طبيعة التكلفة',type:'select',options:[{value:'operating',label:'مصروف تشغيلي'},{value:'material_purchase',label:'شراء مواد للتخزين (ليس استهلاكاً)'},{value:'asset_purchase',label:'شراء أصل (ليس مصروف تشغيل)'},{value:'doctor_settlement',label:'سداد أتعاب طبيب مستحقة سابقاً'},{value:'lab',label:'تكلفة معمل'},{value:'quality_rework',label:'تكلفة إعادة علاج تحملتها العيادة'}],value:init.costKind||'operating'},
 {name:'doctor',label:'الطبيب (لسداد الأتعاب)',type:'text',value:init.doctor||''},
 {name:'reference',label:'مرجع المستند/الإيصال',type:'text',value:init.reference||''},
 {name:'notes',label:'ملاحظات',type:'textarea',value:init.notes||''}
 ];}
async function addExpenseFlow(){const data=await showAppModal({title:'تسجيل مصروف',submitLabel:'حفظ',fields:expenseFieldsFinance({})});if(!data)return;try{const id=uid('exp');const out=C.addExpense(state,{...data,amount:Number(data.amount),sourceId:id},meta({id}));await commit(out.state,()=>{expenses.push({id,title:data.title,amount:Number(data.amount),type:data.type||'متغيرة',category:data.category||'مصروفات تشغيلية',date:data.paidDate,notes:data.notes||'',financeExpenseId:id});});render();message('تم تسجيل المصروف بتاريخ دفع وشهر استحقاق منفصلين.');}catch(e){message(e.message);}}
async function editExpenseFlow(id){const ex=findExpenseByLegacy(id);if(!ex){message('المصروف غير موجود في الدفتر المالي.');return;}const old=ex.versions[ex.versions.length-1];const data=await showAppModal({title:'تصحيح مصروف',submitLabel:'حفظ إصدار تصحيح',fields:[...expenseFieldsFinance(old),{name:'reason',label:'سبب التصحيح',type:'textarea',value:'',required:true}]});if(!data)return;try{let out;if(old.legacyAccrual){out=C.reviewLegacyExpense(state,ex.id,{accrualMonth:data.accrualMonth,category:data.category,reason:data.reason,approvedBy:actor()},meta());if(Number(data.amount)!==old.amount||data.title!==old.title){out=C.correctExpense(out.state,ex.id,{...data,amount:Number(data.amount)},currentOpenMonth(),meta({reason:data.reason}));}}else{out=C.correctExpense(state,ex.id,{...data,amount:Number(data.amount)},currentOpenMonth(),meta({reason:data.reason}));}await commit(out.state,()=>{const le=expenses.find(e=>e.id===id||e.id===ex.sourceId);if(le){le.title=data.title;le.amount=Number(data.amount);le.date=data.paidDate;le.category=data.category;le.type=data.type;le.notes=data.notes||'';}});render();message('تم حفظ التصحيح مع الاحتفاظ بالإصدار السابق.');}catch(e){message(e.message);}}
async function deleteExpenseFlow(id){const ex=findExpenseByLegacy(id);if(!ex){message('المصروف غير موجود.');return;}const reason=await showPromptModal('عكس مصروف','سبب العكس مطلوب؛ لا يُحذف الأثر التاريخي.','السبب','','text');if(!reason||!reason.trim())return;try{const out=C.reverseExpense(state,ex.id,currentOpenMonth(),meta({reason}));await commit(out.state,()=>{expenses=expenses.filter(e=>e.id!==id&&e.id!==ex.sourceId);});render();message('تم عكس المصروف بقيد جديد، وبقي الأثر السابق في الدفتر.');}catch(e){message(e.message);}}
async function addProcedureFlow(){if(!adminUnlocked){message('إضافة خدمة متاحة للمدير فقط.');return;}const name=await showPromptModal('إضافة خدمة','اسم الخدمة كما سيظهر في إصدار الأسعار.','اسم الخدمة','','text');if(!name||!name.trim())return;const cost=await showPromptModal('سعر موجب معلن','لا توجد خدمة مجانية معتمدة؛ سعر الصفر مرفوض.','السعر (ج.س)','','number');if(cost===null)return;if(!Number.isFinite(Number(cost))||Number(cost)<=0){message('سعر الخدمة يجب أن يكون موجباً؛ سعر الصفر مرفوض.');return;}const id=uid('p');const nextProcedures=[...procedures,{id,name:name.trim(),cost:Number(cost)}];try{const out=C.publishPriceBook(state,{effectiveFrom:today,approvedBy:actor(),reason:'إضافة خدمة بسعر موجب',items:nextProcedures.map(p=>({id:p.id,name:p.name,cost:Number(p.cost)}))},meta());await commit(out.state,()=>{procedures=nextProcedures;});render();message('تمت إضافة الخدمة ونشر سعرها في إصدار جديد.');}catch(e){message(e.message);}}
function installCapture(){
 document.addEventListener('submit',e=>{if(e.target&&e.target.id==='vForm'){e.preventDefault();e.stopPropagation();handleVisitForm(e.target).catch(err=>message(err.message||'تعذر حفظ الزيارة.'));}},true);
 document.addEventListener('click',e=>{const t=e.target;const add=t.closest&&t.closest('#addExpenseBtn');if(add){e.preventDefault();e.stopPropagation();addExpenseFlow();return;}const addProc=t.closest&&t.closest('#addProcedureBtn');if(addProc){e.preventDefault();e.stopPropagation();addProcedureFlow();return;}const btn=t.closest&&t.closest('[data-action]');if(!btn)return;const act=btn.dataset.action,id=btn.dataset.id;if(act==='edit-expense'){e.preventDefault();e.stopPropagation();editExpenseFlow(id);}else if(act==='delete-expense'){e.preventDefault();e.stopPropagation();deleteExpenseFlow(id);}else if(act==='delete-visit'){const inv=findInvoiceByVisit(id);if(inv){e.preventDefault();e.stopPropagation();message('هذه الزيارة مرتبطة بفاتورة؛ استخدم تصحيح/إلغاء الفاتورة من سجل الزيارات ولا تحذف الأثر المالي.');}}},true);
 document.addEventListener('change',e=>{if(e.target.classList&&e.target.classList.contains('proc-cost-input')){e.preventDefault();e.stopPropagation();message('تعديل الأسعار يتم بإصدار أسعار معلن من إعدادات التقارير، لا بتغيير السعر الحالي صامتاً.');render();}},true);
}
window.OrasFinanceBridge={KEY,init,get state(){return state;},get ready(){return ready;},snapshot,restoreState,reload,commit,meta,actor,currentOpenMonth,findInvoiceByVisit,findExpenseByLegacy,syncVisit,handleVisitForm,expenseFieldsFinance,addExpenseFlow,editExpenseFlow,deleteExpenseFlow,installCapture,C};
init();installCapture();
})();
