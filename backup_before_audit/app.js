const MONTHS=['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
const DOWS=['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];

const state={
  settings:null,
  services:[],
  service:null,
  payment:null,
  date:null,
  slot:null,
  year:new Date().getFullYear(),
  month:new Date().getMonth(),
};

const paymentOptions=(service)=>[
  {id:'pix',icon:'💠',label:'PIX',value:`R$ ${Number(service.price_pix).toLocaleString('pt-BR',{minimumFractionDigits:2})}`},
  {id:'cartao',icon:'💳',label:'Cartão',value:`R$ ${Number(service.price_card).toLocaleString('pt-BR',{minimumFractionDigits:2})}`},
  {id:'parcelado',icon:'📆',label:'Parcelado',value:service.price_installment},
];

function qs(id){return document.getElementById(id)}
function fmtDate(date){const [y,m,d]=date.split('-');return `${d}/${m}/${y}`}
function fmtTime(min){return `${String(Math.floor(min/60)).padStart(2,'0')}:${String(min%60).padStart(2,'0')}`}
function range(slot){return `${fmtTime(slot.startMinutes)} às ${fmtTime(slot.endMinutes)}`}
function section(id){const el=qs(id);el.classList.add('revealed');el.scrollIntoView({behavior:'smooth',block:'start'})}
function step(n){for(let i=1;i<=4;i++){qs(`si${i}`).className='step-item'+(i<n?' done':i===n?' active':'')}}

async function api(url,options={}){
  const res=await fetch(url,{headers:{'Content-Type':'application/json'},...options});
  const data=await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data.error||'Erro na operação.');
  return data;
}

function renderSettings(){
  if(!state.settings) return;
  qs('logoText').textContent=`✦ ${state.settings.brandName || 'Munay'}`;
  qs('heroTitle').innerHTML=state.settings.title||'Agende sua <em>sessão</em>';
  qs('heroSubtitle').textContent=state.settings.subtitle||'';
  qs('footerLink').href=state.settings.footerLink||'#';
  qs('footerLink').textContent=(state.settings.footerLink||'munay.com.br').replace(/^https?:\/\//,'');
}

function renderServices(){
  qs('servicesGrid').innerHTML=state.services.map(service=>`
    <article class="service-card ${state.service?.id===service.id?'selected':''}" data-id="${service.id}">
      <div class="service-name">${service.name}</div>
      <div class="service-desc">${service.description || 'Atendimento terapêutico personalizado.'}</div>
      <div class="service-prices">
        <div class="price-row"><span class="lbl">PIX</span><span class="val main">R$ ${Number(service.price_pix).toLocaleString('pt-BR',{minimumFractionDigits:2})}</span></div>
        <div class="price-row"><span class="lbl">Cartão</span><span class="val">R$ ${Number(service.price_card).toLocaleString('pt-BR',{minimumFractionDigits:2})}</span></div>
        <div class="price-row"><span class="lbl">Parcelado</span><span class="val">${service.price_installment}</span></div>
      </div>
    </article>`).join('');

  document.querySelectorAll('.service-card').forEach(card=>card.onclick=()=>{
    state.service=state.services.find(service=>service.id===card.dataset.id);
    state.payment=null;state.date=null;state.slot=null;
    renderServices();renderPayments();renderSummary();step(2);section('sec2');
  });
}

function renderPayments(){
  if(!state.service) return;
  qs('payOptions').innerHTML=paymentOptions(state.service).map(option=>`
    <button class="pay-btn ${state.payment===option.id?'sel':''}" type="button" data-id="${option.id}">
      <span class="pi">${option.icon}</span><div class="plbl">${option.label}</div><div class="pv">${option.value}</div>
    </button>`).join('');
  document.querySelectorAll('.pay-btn').forEach(button=>button.onclick=()=>{
    state.payment=button.dataset.id;state.date=null;state.slot=null;renderPayments();renderCalendar();renderSummary();step(3);section('sec3');
  });
}

function renderCalendar(){
  qs('calendarLabel').textContent=`${MONTHS[state.month]} ${state.year}`;
  const first=new Date(state.year,state.month,1).getDay();
  const days=new Date(state.year,state.month+1,0).getDate();
  const today=new Date();today.setHours(0,0,0,0);
  let html=DOWS.map(day=>`<div class="cal-dow">${day}</div>`).join('');
  for(let i=0;i<first;i++) html+='<div class="cal-day"></div>';
  for(let day=1;day<=days;day++){
    const date=new Date(state.year,state.month,day);date.setHours(0,0,0,0);
    const value=`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
    const past=date<today;
    html+=`<button class="cal-day ${past?'':'avail'} ${state.date===value?'selday':''} ${date.getTime()===today.getTime()?'tod':''}" ${past?'disabled':''} data-date="${value}">${day}</button>`;
  }
  qs('calendarGrid').innerHTML=html;
  document.querySelectorAll('.cal-day.avail').forEach(btn=>btn.onclick=async()=>{
    state.date=btn.dataset.date;state.slot=null;renderCalendar();await renderSlots();renderSummary();
  });
  qs('slotsArea').innerHTML='';
}

async function renderSlots(){
  if(!state.service || !state.date) return;
  const data=await api(`/api/public/availability?serviceId=${state.service.id}&date=${state.date}`);
  if(!data.slots.length){qs('slotsArea').innerHTML='<div class="no-slots">Sem horários disponíveis para este dia.</div>';return;}
  qs('slotsArea').innerHTML=`<div class="slots-lbl">${fmtDate(state.date)} — ${data.slots.length} horário(s) disponível(is)</div><div class="slots-grid">${data.slots.map(slot=>`<button class="slot-btn ${state.slot?.startMinutes===slot.startMinutes?'selslot':''}" type="button" data-start="${slot.startMinutes}" data-end="${slot.endMinutes}">${range(slot)}</button>`).join('')}</div>`;
  document.querySelectorAll('.slot-btn').forEach(button=>button.onclick=()=>{
    state.slot={startMinutes:Number(button.dataset.start),endMinutes:Number(button.dataset.end)};renderSlots();renderSummary();step(4);section('sec4');
  });
}

function renderSummary(){
  if(!(state.service && state.payment && state.date && state.slot)){
    qs('summaryBox').innerHTML='<div class="srow"><span class="sk">Resumo</span><span class="sv">Selecione serviço, pagamento e horário</span></div>';
    return;
  }
  const payment=paymentOptions(state.service).find(item=>item.id===state.payment);
  qs('summaryBox').innerHTML=`
    <div class="srow"><span class="sk">Serviço</span><span class="sv">${state.service.name}</span></div>
    <div class="srow"><span class="sk">Data</span><span class="sv">${fmtDate(state.date)}</span></div>
    <div class="srow"><span class="sk">Horário</span><span class="sv">${range(state.slot)}</span></div>
    <div class="srow"><span class="sk">Pagamento</span><span class="sv">${payment.label}</span></div>
    <div class="srow tot"><span class="sk">Total</span><span class="sv">${payment.value}</span></div>`;
}

async function submitAppointment(){
  const name=qs('clientName').value.trim();
  const whatsapp=qs('clientWhatsapp').value.trim();
  if(!name || !whatsapp) return alert('Preencha nome e WhatsApp.');
  if(!(state.service && state.payment && state.date && state.slot)) return alert('Complete todas as etapas do agendamento.');
  qs('confirmButton').disabled=true;qs('loadingMsg').style.display='block';
  try{
    const result=await api('/api/public/appointments',{method:'POST',body:JSON.stringify({serviceId:state.service.id,paymentMethod:state.payment,date:state.date,startMinutes:state.slot.startMinutes,name,whatsapp})});
    qs('confirmationCard').classList.remove('hidden');
    qs('confirmationCard').innerHTML=`<strong>Agendamento registrado com sucesso.</strong><br>Serviço: ${result.confirmation.service}<br>Data: ${result.confirmation.date}<br>Horário: ${result.confirmation.time}<br>Status: ${result.confirmation.status}<br><br>Uma nova aba do WhatsApp será aberta para avisar o terapeuta.`;
    window.open(result.therapistWhatsappUrl,'_blank');
  }catch(error){alert(error.message)}finally{qs('confirmButton').disabled=false;qs('loadingMsg').style.display='none'}
}

async function init(){
  const [settings,services]=await Promise.all([api('/api/public/settings'),api('/api/public/services')]);
  state.settings=settings;state.services=services;
  renderSettings();renderServices();renderSummary();renderCalendar();
}

qs('prevMonth').onclick=()=>{state.month--;if(state.month<0){state.month=11;state.year--;}renderCalendar()};
qs('nextMonth').onclick=()=>{state.month++;if(state.month>11){state.month=0;state.year++;}renderCalendar()};
qs('confirmButton').onclick=submitAppointment;
qs('adminButton').onclick=()=>window.location.href='/admin.html';
init().catch(error=>{console.error(error);alert('Não foi possível carregar a agenda no momento.')});
