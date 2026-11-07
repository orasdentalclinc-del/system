/* بيانات اصطناعية لاختبار القواعد فقط — ليست سجلات عيادة أوراس ولا تقرير أكتوبر الحقيقي. */
const C=require('../finance-core.js');
const meta={now:'2026-11-01T08:00:00.000Z',actor:'مدير الاختبار'};
function build(){
 let s=C.emptyState();s.fixtureLabel='اصطناعية — ليست بيانات العيادة';
 s.chairSettings={chairs:2,workDays:[0,1,2,3,4,6],dayMinutes:480,targetVisitsMin:7,targetVisitsMax:8};
 s=C.publishPriceBook(s,{effectiveFrom:'2026-01-01',approvedBy:'مدير الاختبار',reason:'أسعار اختبار',items:[{id:'exam',name:'فحص اختبار',cost:100},{id:'filling',name:'حشوة اختبار',cost:200},{id:'root',name:'عصب اختبار',cost:300}]},meta).state;
 s=C.setDoctorPolicy(s,{doctor:'د. اختبار',effectiveFrom:'2026-01-01',method:'revenue_percent',rate:10,approvedBy:'مدير الاختبار'},meta).state;
 s=C.changeFx(s,{rate:1000,effectiveFrom:'2026-01-01',reason:'سعر اختبار',approvedBy:'مدير الاختبار'},meta).state;
 const visits=[];
 function monthVisit(month,day,costProc,extra={}){const date=`2026-${month}-${String(day).padStart(2,'0')}`,id=`v-${month}-${day}`;const v={id,patientId:'p-test',patientName:'مريض اختبار',date,status:'مكتملة',confirmed:true,chair:'كرسي 1',doctor:'د. اختبار',arrivalTime:'09:00',startTime:'09:10',endTime:'09:40',...extra};visits.push(v);if(costProc){s=C.addInvoice(s,{visitId:id,patientId:'p-test',serviceDate:date,doctor:'د. اختبار',lines:[{procedureId:costProc,qty:1,unitPrice:{exam:100,filling:200,root:300}[costProc]}]}, {...meta,id:'inv-'+id}).state;}return v;}
 monthVisit('07',10,'filling');
 monthVisit('09',10,'root');
 const oct=[];for(let d=1;d<=10;d++)oct.push(monthVisit('10',d,d%2?'exam':'filling',{chair:d%2?'كرسي 1':'كرسي 2'}));
 // 5×100 + 5×200 = 1500; أتعاب 150؛ مواد 200؛ مصروفات مباشرة 16070 => إجمالي 16420.
 s=C.addExpense(s,{title:'إيجار اختبار',amount:10000,paidDate:'2026-10-01',accrualMonth:'2026-10',category:'إيجار',type:'ثابتة'},meta).state;
 s=C.addExpense(s,{title:'مرتب اختبار',amount:6070,paidDate:'2026-10-05',accrualMonth:'2026-10',category:'مرتبات',type:'ثابتة'},meta).state;
 s=C.setMaterialCost(s,{month:'2026-10',amount:200,source:'جرد اختبار',approvedBy:'مدير الاختبار'},meta);
 s=C.setMaterialCost(s,{month:'2026-09',amount:0,source:'لا استخدام في بيانات الاختبار',approvedBy:'مدير الاختبار'},meta);
 s=C.setMaterialCost(s,{month:'2026-07',amount:0,source:'لا استخدام في بيانات الاختبار',approvedBy:'مدير الاختبار'},meta);
 // تحصيل 900 نقداً و600 دين في أكتوبر.
 s=C.recordCash(s,{kind:'receipt',date:'2026-10-20',amount:900,patientId:'p-test',allocations:[{invoiceId:'inv-v-10-1',amount:100},{invoiceId:'inv-v-10-2',amount:200},{invoiceId:'inv-v-10-3',amount:100},{invoiceId:'inv-v-10-4',amount:200},{invoiceId:'inv-v-10-5',amount:100},{invoiceId:'inv-v-10-6',amount:200}]},meta).state;
 // مقدم لعلاج نوفمبر، لا يدخل إيراد أكتوبر.
 const adv=C.recordCash(s,{kind:'advance_receipt',date:'2026-10-25',amount:500,patientId:'p-test',scope:'general',reference:'إيصال اختبار'},meta);s=adv.state;
 visits.push({id:'v-10-noshow',patientId:'p-test',date:'2026-10-12',status:'no_show',confirmed:true,chair:'كرسي 1'});
 visits.push({id:'v-10-cancel',patientId:'p-test',date:'2026-10-13',status:'cancelled',confirmed:true,chair:'كرسي 1'});
 visits.push({id:'v-10-freevisit',patientId:'p-test',date:'2026-10-14',status:'مكتملة',confirmed:true,chair:'كرسي 1',doctor:'د. اختبار',arrivalTime:'10:00',startTime:'10:05',endTime:'10:20',billingMode:'none',noInvoiceReason:'متابعة إدارية بلا خدمة طبية مسعرة في بيانات الاختبار'});
 s.qualityEvents=[{id:'q1',date:'2026-10-15',visitId:'v-10-1',type:'complaint',description:'شكوى اختبار',status:'مفتوحة'},{id:'q2',date:'2026-10-16',visitId:'v-10-2',type:'complication',description:'مضاعفة اختبار',status:'قيد المراجعة'},{id:'q3',date:'2026-10-17',visitId:'v-10-3',originalVisitId:'v-09-10',type:'retreatment',patientCharge:0,clinicCost:50,description:'إعادة علاج اختبارية تحملتها العيادة',status:'مغلقة'}];
 return{state:s,visits,meta,advanceId:adv.event.advanceId};
}
module.exports={build};
