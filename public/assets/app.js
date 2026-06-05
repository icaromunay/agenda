const MONTHS = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const DOWS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

const state = {
  settings: null,
  services: [],
  service: null,
  payment: null,
  date: null,
  slot: null,
  year: new Date().getFullYear(),
  month: new Date().getMonth(),
  monthAvailability: {},
};

const paymentOptions = (service) => [
  { id: 'pix', icon: '💠', label: 'PIX', value: `R$ ${Number(service.price_pix).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}` },
  { id: 'cartao', icon: '💳', label: 'Cartão', value: `R$ ${Number(service.price_card).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}` },
  { id: 'parcelado', icon: '📆', label: 'Parcelado', value: service.price_installment },
];

function qs(id) { return document.getElementById(id); }
function fmtDate(date) { const [y, m, d] = date.split('-'); return `${d}/${m}/${y}`; }
function fmtTime(min) { return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`; }
function range(slot) { return `${fmtTime(slot.startMinutes)} às ${fmtTime(slot.endMinutes)}`; }

function monthAvailabilityKey() {
  return `${state.service?.id || 'none'}:${state.year}-${String(state.month + 1).padStart(2, '0')}`;
}

async function syncMonthAvailability() {
  if (!(state.service && state.payment)) {
    renderCalendar();
    return;
  }
  const key = monthAvailabilityKey();
  const year = state.year;
  const month = state.month + 1;
  try {
    const data = await api(`/api/public/month-availability?serviceId=${state.service.id}&year=${year}&month=${month}`);
    state.monthAvailability[key] = data.availability || {};
  } catch (_error) {
    state.monthAvailability[key] = {};
  }
  renderCalendar();
}

function revealAndScrollSection(id) {
  const sectionElement = qs(id);
  if (!sectionElement) return;
  sectionElement.classList.add('revealed');
  const target = sectionElement.querySelector('.section-header') || sectionElement;
  const offset = window.innerWidth <= 700 ? 88 : 72;
  window.setTimeout(() => {
    const top = target.getBoundingClientRect().top + window.scrollY - offset;
    window.scrollTo({ top: Math.max(top, 0), behavior: 'smooth' });
  }, 120);
}

function step(n) {
  for (let i = 1; i <= 4; i += 1) {
    qs(`si${i}`).className = `step-item${i < n ? ' done' : i === n ? ' active' : ''}`;
  }
}

async function api(url, options = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Erro na operação.');
  return data;
}

function renderSettings() {
  if (!state.settings) return;
  qs('logoText').textContent = `✦ ${state.settings.brandName || 'Munay'}`;
  qs('heroTitle').innerHTML = state.settings.title || 'Agende sua <em>sessão</em>';
  qs('heroSubtitle').textContent = state.settings.subtitle || '';
  qs('footerLink').href = state.settings.footerLink || '#';
  qs('footerLink').textContent = (state.settings.footerLink || 'munay.com.br').replace(/^https?:\/\//, '');

  const steps = [
    { badge: state.settings.stepBadge1 || 'Passo 1', label: state.settings.stepLabel1 || 'Serviço', title: state.settings.sectionTitle1 || 'Escolha o serviço' },
    { badge: state.settings.stepBadge2 || 'Passo 2', label: state.settings.stepLabel2 || 'Pagamento', title: state.settings.sectionTitle2 || 'Forma de pagamento' },
    { badge: state.settings.stepBadge3 || 'Passo 3', label: state.settings.stepLabel3 || 'Data & Horário', title: state.settings.sectionTitle3 || 'Escolha a data e o horário' },
    { badge: state.settings.stepBadge4 || 'Passo 4', label: state.settings.stepLabel4 || 'Confirmação', title: state.settings.sectionTitle4 || 'Seus dados' },
  ];

  steps.forEach((item, index) => {
    const number = index + 1;
    const badge = qs(`stepBadge${number}`);
    const label = qs(`stepLabel${number}`);
    const title = qs(`sectionTitle${number}`);
    if (badge) badge.textContent = item.badge;
    if (label) label.textContent = item.label;
    if (title) title.textContent = item.title;
  });
}

function renderServices() {
  qs('servicesGrid').innerHTML = state.services.map((service) => `
    <article class="service-card ${state.service?.id === service.id ? 'selected' : ''}" data-id="${service.id}">
      <div class="service-name">${service.name}</div>
      <div class="service-desc">${service.description || 'Atendimento terapêutico personalizado.'}</div>
      <div class="service-prices">
        <div class="price-row"><span class="lbl">PIX</span><span class="val main">R$ ${Number(service.price_pix).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</span></div>
        <div class="price-row"><span class="lbl">Cartão</span><span class="val">R$ ${Number(service.price_card).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</span></div>
        <div class="price-row"><span class="lbl">Parcelado</span><span class="val">${service.price_installment}</span></div>
      </div>
    </article>`).join('');

  document.querySelectorAll('.service-card').forEach((card) => {
    card.onclick = () => {
      state.service = state.services.find((service) => service.id === card.dataset.id);
      state.payment = null;
      state.date = null;
      state.slot = null;
      renderServices();
      renderPayments();
      renderSummary();
      step(2);
      revealAndScrollSection('sec2');
    };
  });
}

function renderPayments() {
  if (!state.service) return;
  qs('payOptions').innerHTML = paymentOptions(state.service).map((option) => `
    <button class="pay-btn ${state.payment === option.id ? 'sel' : ''}" type="button" data-id="${option.id}">
      <span class="pi">${option.icon}</span><div class="plbl">${option.label}</div><div class="pv">${option.value}</div>
    </button>`).join('');
  document.querySelectorAll('.pay-btn').forEach((button) => {
    button.onclick = () => {
      state.payment = button.dataset.id;
      state.date = null;
      state.slot = null;
      renderPayments();
      renderCalendar();
      syncMonthAvailability().catch(() => null);
      renderSummary();
      step(3);
      revealAndScrollSection('sec3');
    };
  });
}

function renderCalendar() {
  qs('calendarLabel').textContent = `${MONTHS[state.month]} ${state.year}`;
  const first = new Date(state.year, state.month, 1).getDay();
  const days = new Date(state.year, state.month + 1, 0).getDate();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const availability = state.monthAvailability[monthAvailabilityKey()] || null;
  let html = DOWS.map((day) => `<div class="cal-dow">${day}</div>`).join('');
  for (let i = 0; i < first; i += 1) html += '<div class="cal-day empty"></div>';
  for (let day = 1; day <= days; day += 1) {
    const date = new Date(state.year, state.month, day);
    date.setHours(0, 0, 0, 0);
    const value = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const past = date < today;
    const available = Boolean(state.service && state.payment && availability && availability[value]?.available);
    const canClick = !past && available;
    html += `<button class="cal-day ${past ? 'past' : canClick ? 'avail' : 'off'} ${state.date === value ? 'selday' : ''} ${date.getTime() === today.getTime() ? 'tod' : ''}" ${canClick ? '' : 'disabled'} data-date="${value}">${day}</button>`;
  }
  qs('calendarGrid').innerHTML = html;
  document.querySelectorAll('.cal-day.avail').forEach((btn) => {
    btn.onclick = async () => {
      state.date = btn.dataset.date;
      state.slot = null;
      renderCalendar();
      await renderSlots();
      renderSummary();
    };
  });
  qs('slotsArea').innerHTML = '';
}

async function renderSlots() {
  if (!state.service || !state.date) return;
  const data = await api(`/api/public/availability?serviceId=${state.service.id}&date=${state.date}`);
  if (!data.slots.length) {
    qs('slotsArea').innerHTML = '<div class="no-slots">Sem horários disponíveis para este dia.</div>';
    return;
  }
  qs('slotsArea').innerHTML = `<div class="slots-lbl">${fmtDate(state.date)} — ${data.slots.length} horário(s) disponível(is)</div><div class="slots-grid">${data.slots.map((slot) => `<button class="slot-btn ${state.slot?.startMinutes === slot.startMinutes ? 'selslot' : ''}" type="button" data-start="${slot.startMinutes}" data-end="${slot.endMinutes}">${range(slot)}</button>`).join('')}</div>`;
  document.querySelectorAll('.slot-btn').forEach((button) => {
    button.onclick = () => {
      state.slot = { startMinutes: Number(button.dataset.start), endMinutes: Number(button.dataset.end) };
      renderSlots();
      renderSummary();
      step(4);
      revealAndScrollSection('sec4');
    };
  });
}

function renderSummary() {
  if (!(state.service && state.payment && state.date && state.slot)) {
    qs('summaryBox').innerHTML = '<div class="srow"><span class="sk">Resumo</span><span class="sv">Selecione serviço, pagamento e horário</span></div>';
    return;
  }
  const payment = paymentOptions(state.service).find((item) => item.id === state.payment);
  qs('summaryBox').innerHTML = `
    <div class="srow"><span class="sk">Serviço</span><span class="sv">${state.service.name}</span></div>
    <div class="srow"><span class="sk">Data</span><span class="sv">${fmtDate(state.date)}</span></div>
    <div class="srow"><span class="sk">Horário</span><span class="sv">${range(state.slot)}</span></div>
    <div class="srow"><span class="sk">Pagamento</span><span class="sv">${payment.label}</span></div>
    <div class="srow tot"><span class="sk">Total</span><span class="sv">${payment.value}</span></div>`;
}

let clientCheckTimer = null;
async function checkClientSilently() {
  const name = qs('clientName').value.trim();
  const whatsapp = qs('clientWhatsapp').value.trim();
  if (!name || !whatsapp) return;
  try {
    await api(`/api/public/client-check?name=${encodeURIComponent(name)}&whatsapp=${encodeURIComponent(whatsapp)}`);
  } catch (_error) {
    // verificação silenciosa para evitar alertas visuais ao cliente
  }
}

function scheduleClientCheck() {
  clearTimeout(clientCheckTimer);
  clientCheckTimer = setTimeout(() => { checkClientSilently().catch(() => null); }, 300);
}

async function submitAppointment() {
  const name = qs('clientName').value.trim();
  const whatsapp = qs('clientWhatsapp').value.trim();
  if (!name || !whatsapp) return alert('Preencha nome e WhatsApp.');
  if (!(state.service && state.payment && state.date && state.slot)) return alert('Complete todas as etapas do agendamento.');
  qs('confirmButton').disabled = true;
  qs('loadingMsg').style.display = 'block';
  try {
    const result = await api('/api/public/appointments', {
      method: 'POST',
      body: JSON.stringify({
        serviceId: state.service.id,
        paymentMethod: state.payment,
        date: state.date,
        startMinutes: state.slot.startMinutes,
        name,
        whatsapp,
      }),
    });
    qs('confirmationCard').classList.remove('hidden');
    qs('confirmationCard').innerHTML = `<strong>Agendamento registrado com sucesso.</strong><br>Serviço: ${result.confirmation.service}<br>Data: ${result.confirmation.date}<br>Horário: ${result.confirmation.time}<br>Status: ${result.confirmation.status}<br><br>Uma nova aba do WhatsApp será aberta com a mensagem formatada para avisar o terapeuta.`;
    if (result.therapistWhatsappUrl) window.open(result.therapistWhatsappUrl, '_blank');
  } catch (error) {
    alert(error.message);
  } finally {
    qs('confirmButton').disabled = false;
    qs('loadingMsg').style.display = 'none';
  }
}

async function init() {
  const [settings, services] = await Promise.all([api('/api/public/settings'), api('/api/public/services')]);
  state.settings = settings;
  state.services = services;
  renderSettings();
  renderServices();
  renderSummary();
  renderCalendar();
}

qs('prevMonth').onclick = () => { state.month -= 1; if (state.month < 0) { state.month = 11; state.year -= 1; } renderCalendar(); syncMonthAvailability().catch(() => null); };
qs('nextMonth').onclick = () => { state.month += 1; if (state.month > 11) { state.month = 0; state.year += 1; } renderCalendar(); syncMonthAvailability().catch(() => null); };
qs('confirmButton').onclick = submitAppointment;
qs('adminButton').onclick = () => { window.location.href = '/admin.html'; };
qs('clientName').addEventListener('input', scheduleClientCheck);
qs('clientWhatsapp').addEventListener('input', scheduleClientCheck);

init().catch((error) => {
  console.error(error);
  alert('Não foi possível carregar a agenda no momento.');
});
