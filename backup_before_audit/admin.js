const state={token:'',settings:null};
const viewMeta={dashboard:['Dashboard','Visão geral do sistema'],appointments:['Agendamentos','Pesquisa, filtros e confirmação'],clients:['Clientes','Base de relacionamento'],services:['Serviços','CRUD completo'],blocks:['Bloqueios','Datas e horários indisponíveis'],reports:['Relatórios','Resumo comercial e operacional'],settings:['Configurações','Google Agenda, WhatsApp, horários e personalização'],security:['Segurança','Senha administrativa e proteção']};
const $=id=>document.getElementById(id);
const authHeaders=()=>({Authorization:`Bearer ${state.token}`,'Content-Type':'application/json'});

async function api(url,options={}){
  const res=await fetch(url,{...options,headers:options.headers||authHeaders()});
  const data=await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data.error||'Erro na operação.');
  return data;
}
function fmtDate(date){if(!date) return '-';const [y,m,d]=String(date).split('-');return `${d}/${m}/${y}`}
function fmtTime(min){return `${String(Math.floor(min/60)).padStart(2,'0')}:${String(min%60).padStart(2,'0')}`}
function fmtRange(a){return `${fmtTime(a.start_minutes)} às ${fmtTime(a.end_minutes)}`}
function badge(status){return `<span class="badge ${status}">${status}</span>`}
function listOrEmpty(items,empty='Nenhum registro encontrado.'){return items.length?`<div class="list">${items.join('')}</div>`:`<div class="item">${empty}</div>`}
function googleBadge(connected){return connected?'🟢 Google Conectado':'🔴 Desconectado'}
function qsParam(name){return new URLSearchParams(window.location.search).get(name)}

function buildSettingsBody(){
  const f=$('settingsForm');
  return {
    brand_name:f.brand_name.value,
    title:f.title.value,
    subtitle:f.subtitle.value,
    therapist_name:f.therapist_name.value,
    therapist_whatsapp:f.therapist_whatsapp.value,
    notifications_whatsapp:f.notifications_whatsapp.value,
    footer_link:f.footer_link.value,
    logo_url:f.logo_url.value,
    google_email:f.google_email.value,
    google_calendar_id:f.google_calendar_id.value,
    google_client_id:f.google_client_id.value,
    google_client_secret:f.google_client_secret.value,
    google_redirect_uri:f.google_redirect_uri.value,
    google_refresh_token:f.google_refresh_token.value,
    database_url:f.database_url.value,
    work_start:f.work_start.value,
    work_end:f.work_end.value,
    slot_interval:Number(f.slot_interval.value),
    confirmation_message:f.confirmation_message.value,
    reminder_message:f.reminder_message.value,
    notification_immediate:f.notification_immediate.checked,
    notification_24h:f.notification_24h.checked,
    notification_1h:f.notification_1h.checked,
    notification_15m:f.notification_15m.checked,
    notify_email:f.notify_email.checked,
    notify_push:f.notify_push.checked,
    allowed_weekdays:[1,2,3,4,5],
    vacations:[],
    holidays:[],
  };
}

function renderGoogleStatus(settings,status=null){
  const connected=status?.connected ?? settings?.google_connected ?? false;
  const lastSync=status?.lastSyncAt ?? settings?.last_google_sync_at ?? null;
  const email=status?.email ?? settings?.google_email ?? '-';
  const calendarId=status?.calendarId ?? settings?.google_calendar_id ?? '-';
  $('settingsStatus').innerHTML=`<strong>${googleBadge(connected)}</strong>\nEmail: ${email || '-'}\nCalendar ID: ${calendarId || '-'}\nÚltima sincronização: ${lastSync ? new Date(lastSync).toLocaleString('pt-BR') : 'Nunca'}`;
}

async function login(){
  try{
    const result=await fetch('/api/admin/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:$('loginPassword').value})});
    const data=await result.json();
    if(!result.ok) throw new Error(data.error||'Falha no login.');
    state.token=data.token;
    $('loginScreen').classList.add('hidden');$('appShell').classList.remove('hidden');
    attachNavigation();await loadCurrentView();
    if(qsParam('google')==='connected') alert('Google conectado com sucesso.');
    if(qsParam('google')==='error') alert('Falha ao concluir a conexão com o Google.');
    if(qsParam('google')==='missing-config') alert('Preencha as credenciais Google antes de conectar.');
  }catch(error){$('loginError').textContent=error.message}
}

function attachNavigation(){
  document.querySelectorAll('.nav-btn').forEach(btn=>btn.onclick=()=>showView(btn.dataset.view));
}
function showView(view){
  document.querySelectorAll('.nav-btn').forEach(btn=>btn.classList.toggle('active',btn.dataset.view===view));
  document.querySelectorAll('.view').forEach(section=>section.classList.toggle('active',section.id===`view-${view}`));
  $('viewTitle').textContent=viewMeta[view][0];$('viewSubtitle').textContent=viewMeta[view][1];
  loadCurrentView(view).catch(error=>alert(error.message));
}

async function loadDashboard(){
  const data=await api('/api/admin/dashboard');
  $('dashboardCards').innerHTML=[
    ['Agendamentos de hoje',data.today],['Próximos atendimentos',data.upcoming],['Pendentes',data.pending],['Confirmados',data.confirmed],['Faturamento previsto',data.forecastRevenue||0],['Faturamento confirmado',data.confirmedRevenue||0]
  ].map(card=>`<div class="card"><strong>${card[1]}</strong><span>${card[0]}</span></div>`).join('');
  $('dashboardCalendar').innerHTML=listOrEmpty((data.calendar||[]).map(item=>`<div class="item"><strong>${fmtDate(item.appointment_date)}</strong><div class="meta">${fmtTime(item.start_minutes)} às ${fmtTime(item.end_minutes)} · ${item.status}</div></div>`),'Sem próximos atendimentos.');
  $('dashboardServices').innerHTML=listOrEmpty((data.topServices||[]).map(item=>`<div class="item"><strong>${item.service_name}</strong><div class="meta">${item.total} venda(s)</div></div>`),'Sem dados suficientes.');
}

async function loadAppointments(){
  const search=encodeURIComponent($('appointmentSearch').value||'');
  const status=encodeURIComponent($('appointmentStatus').value||'');
  const data=await api(`/api/admin/appointments?search=${search}&status=${status}`);
  $('appointmentsList').innerHTML=listOrEmpty(data.map(item=>`<div class="item"><div class="item-top"><div><h4>${item.client_name}</h4><div class="meta">${item.service_name}<br>${fmtDate(item.appointment_date)} · ${fmtRange(item)}<br>${item.client_whatsapp}<br>Google Event ID: ${item.google_event_id || 'não sincronizado'}</div></div>${badge(item.status)}</div><div class="actions"><button class="list-btn ok" onclick="confirmAppointment('${item.id}')">Confirmar atendimento</button><button class="list-btn" onclick="editAppointmentPrompt('${item.id}','${item.appointment_date}',${item.start_minutes},'${item.status}','${item.payment_method}',${JSON.stringify(item.notes||'').replace(/"/g,'&quot;')})">Editar / reagendar</button><button class="list-btn danger" onclick="deleteAppointment('${item.id}')">Excluir</button></div></div>`));
}

async function loadClients(){
  const data=await api('/api/admin/clients');
  $('clientsList').innerHTML=listOrEmpty(data.map(item=>`<div class="item"><h4>${item.name}</h4><div class="meta">WhatsApp: ${item.whatsapp}<br>Total de agendamentos: ${item.total_appointments}<br>Último atendimento: ${fmtDate(item.last_appointment)}</div></div>`));
}

async function loadServices(){
  const data=await api('/api/admin/services');
  $('servicesList').innerHTML=listOrEmpty(data.map(item=>`<div class="item"><div class="item-top"><div><h4>${item.name}</h4><div class="meta">${item.description}<br>Duração: ${item.duration_minutes} min · PIX R$ ${Number(item.price_pix).toLocaleString('pt-BR',{minimumFractionDigits:2})}<br>Cartão R$ ${Number(item.price_card).toLocaleString('pt-BR',{minimumFractionDigits:2})} · ${item.price_installment}<br>Faixa: ${item.min_hour} até ${item.max_hour}</div></div>${badge(item.active?'confirmado':'cancelado')}</div><div class="actions"><button class="list-btn" onclick='populateServiceForm(${JSON.stringify(item).replace(/'/g,"&apos;")})'>Editar</button><button class="list-btn danger" onclick="deleteService('${item.id}')">Excluir</button></div></div>`));
}

async function loadBlocks(){
  const data=await api('/api/admin/blocks');
  $('blocksList').innerHTML=listOrEmpty(data.map(item=>`<div class="item"><h4>${fmtDate(item.block_date)}</h4><div class="meta">${fmtTime(item.start_minutes)} às ${fmtTime(item.end_minutes)}<br>${item.reason}</div><div class="actions"><button class="list-btn danger" onclick="deleteBlock('${item.id}')">Excluir</button></div></div>`));
}

async function loadReports(){
  const params=[];if($('reportStart').value) params.push(`startDate=${$('reportStart').value}`);if($('reportEnd').value) params.push(`endDate=${$('reportEnd').value}`);
  const data=await api(`/api/admin/reports${params.length?'?'+params.join('&'):''}`);
  $('reportStatus').innerHTML=listOrEmpty((data.byStatus||[]).map(item=>`<div class="item"><strong>${item.status}</strong><div class="meta">${item.total} registro(s)</div></div>`));
  $('reportServices').innerHTML=listOrEmpty((data.byService||[]).map(item=>`<div class="item"><strong>${item.name}</strong><div class="meta">${item.total} venda(s)</div></div>`));
}

async function loadSettings(){
  const [settings,status]=await Promise.all([api('/api/admin/settings'),fetch('/api/google/status').then(r=>r.json()).catch(()=>({connected:false}))]);
  state.settings=settings;
  const form=$('settingsForm');
  Object.entries(settings).forEach(([key,value])=>{if(form.elements[key]){if(form.elements[key].type==='checkbox'){form.elements[key].checked=Boolean(value)}else{form.elements[key].value=value??''}}});
  renderGoogleStatus(settings,status);
}

async function loadCurrentView(view=document.querySelector('.nav-btn.active')?.dataset.view||'dashboard'){
  const handlers={dashboard:loadDashboard,appointments:loadAppointments,clients:loadClients,services:loadServices,blocks:loadBlocks,reports:loadReports,settings:loadSettings,security:async()=>{}};
  return handlers[view]();
}

async function confirmAppointment(id){
  try{
    const result=await api(`/api/admin/appointments/${id}/confirm`,{method:'POST'});
    window.open(result.whatsappUrl,'_blank');
    await loadAppointments();
    alert('Atendimento confirmado, WhatsApp aberto e Google sincronizado quando conectado.');
  }catch(error){alert(error.message)}
}
async function deleteAppointment(id){if(!confirm('Excluir este agendamento?')) return;await api(`/api/admin/appointments/${id}`,{method:'DELETE'});await loadAppointments();}
async function editAppointmentPrompt(id,date,start,status,paymentMethod,notes=''){
  const appointment_date=prompt('Nova data (AAAA-MM-DD):',date);if(!appointment_date) return;
  const start_minutes=Number(prompt('Novo início em minutos. Ex.: 540 para 09:00',String(start)));if(Number.isNaN(start_minutes)) return;
  const nextStatus=prompt('Novo status:',status)||status;
  const nextPayment=prompt('Forma de pagamento (pix/cartao/parcelado):',paymentMethod)||paymentMethod;
  const nextNotes=prompt('Observações:',String(notes||'')) ?? '';
  await api(`/api/admin/appointments/${id}`,{method:'PUT',body:JSON.stringify({appointment_date,start_minutes,status:nextStatus,payment_method:nextPayment,notes:nextNotes})});
  await loadAppointments();
}
async function deleteService(id){if(!confirm('Excluir este serviço?')) return;await api(`/api/admin/services/${id}`,{method:'DELETE'});await loadServices();}
async function deleteBlock(id){if(!confirm('Excluir este bloqueio?')) return;await api(`/api/admin/blocks/${id}`,{method:'DELETE'});await loadBlocks();}
function populateServiceForm(item){
  const form=$('serviceForm');
  Object.entries(item).forEach(([key,value])=>{
    if(form.elements[key]){
      if(form.elements[key].type==='checkbox') form.elements[key].checked=Boolean(value);
      else form.elements[key].value=value??'';
    }
  });
  form.dataset.editId=item.id;
  window.scrollTo({top:0,behavior:'smooth'});
}

$('loginButton').onclick=login;
$('loginPassword').addEventListener('keydown',e=>{if(e.key==='Enter') login()});
$('refreshButton').onclick=()=>loadCurrentView().catch(error=>alert(error.message));
$('loadAppointmentsButton').onclick=()=>loadAppointments().catch(error=>alert(error.message));
$('loadReportsButton').onclick=()=>loadReports().catch(error=>alert(error.message));
$('serviceForm').onsubmit=async(e)=>{e.preventDefault();const fd=new FormData(e.target);const body=Object.fromEntries(fd.entries());body.duration_minutes=Number(body.duration_minutes);body.price_pix=Number(body.price_pix);body.price_card=Number(body.price_card);body.sort_order=Number(body.sort_order);body.active=e.target.elements.active.checked;const editId=e.target.dataset.editId;if(editId){await api(`/api/admin/services/${editId}`,{method:'PUT',body:JSON.stringify(body)});delete e.target.dataset.editId;}else{await api('/api/admin/services',{method:'POST',body:JSON.stringify(body)});}e.target.reset();e.target.elements.active.checked=true;await loadServices();};
$('blockForm').onsubmit=async(e)=>{e.preventDefault();const fd=new FormData(e.target);const body=Object.fromEntries(fd.entries());body.start_minutes=Number(body.start_minutes);body.end_minutes=Number(body.end_minutes);await api('/api/admin/blocks',{method:'POST',body:JSON.stringify(body)});e.target.reset();await loadBlocks();};
$('settingsForm').onsubmit=async(e)=>{e.preventDefault();const result=await api('/api/admin/settings',{method:'PUT',body:JSON.stringify(buildSettingsBody())});state.settings=result;renderGoogleStatus(result);$('settingsStatus').innerHTML+=`${result.requiresRestartForDatabaseChange?'\nAlteração de banco salva. Reinicie a aplicação para assumir a nova conexão.':''}`;};
$('connectGoogleButton').onclick=async()=>{try{await api('/api/admin/settings',{method:'PUT',body:JSON.stringify(buildSettingsBody())});const result=await api('/api/google/connect-url',{method:'POST'});window.location.href=result.url;}catch(error){alert(error.message)}};
$('disconnectGoogleButton').onclick=async()=>{if(!confirm('Desconectar a conta Google atual?')) return;await api('/api/google/disconnect',{method:'POST'});const settings=await api('/api/admin/settings');renderGoogleStatus(settings,{connected:false});alert('Google desconectado com sucesso.');};
$('testGoogleButton').onclick=async()=>{const result=await api('/api/admin/settings/google/test',{method:'POST'});const settings=await api('/api/admin/settings');renderGoogleStatus(settings,result);if(!result.connected && result.reason) alert(result.reason);};
$('passwordForm').onsubmit=async(e)=>{e.preventDefault();const fd=new FormData(e.target);const body=Object.fromEntries(fd.entries());await api('/api/admin/auth/change-password',{method:'POST',body:JSON.stringify(body)});$('passwordStatus').className='status-box';$('passwordStatus').textContent='Senha alterada com sucesso.';e.target.reset();};
