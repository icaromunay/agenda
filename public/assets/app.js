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
  refreshTimer: null,
};

const SERVICE_REFRESH_INTERVAL = 15000;

const paymentOptions = (service) => [
  { id: 'pix', icon: '💠', label: 'PIX', value: `R$ ${Number(service.price_pix).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`, note: `${service.duration_minutes} min` },
  { id: 'cartao', icon: '💳', label: 'Cartão', value: `R$ ${Number(service.price_card).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`, note: `${service.duration_minutes} min` },
  { id: 'parcelado', icon: '📆', label: 'Parcelado', value: service.price_installment, note: `${service.duration_minutes} min` },
];

function qs(id) { return document.getElementById(id); }
function fmtDate(date) { const [y, m, d] = String(date).split('-'); return `${d}/${m}/${y}`; }
function fmtTime(min) { return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`; }
function range(slot) { return `${fmtTime(slot.startMinutes)} às ${fmtTime(slot.endMinutes)}`; }
function money(value) { return `R$ ${Number(value || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`; }
function publicShiftLabel(service) {
  return service?.public_shift_label
    || (String(service?.shift_label || '').trim().toUpperCase() === 'NOTURNO'
      ? 'Turno: Noturno – Das 18h às 24h'
      : 'Turno: Diurno – até 18h');
}

function monthAvailabilityKey() {
  return `${state.service?.id || 'none'}:${state.year}-${String(state.month + 1).padStart(2, '0')}`;
}

async function api(url, options = {}) {
  const res = await fetch(url, {
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Erro na operação.');
  return data;
}

async function loadPublicData({ preserveSelection = true } = {}) {
  const previousServiceId = preserveSelection ? state.service?.id : null;
  const [settings, services] = await Promise.all([
    api(`/api/public/settings?_=${Date.now()}`),
    api(`/api/public/services?_=${Date.now()}`),
  ]);
  state.settings = settings;
  state.services = Array.isArray(services) ? services : [];

  if (previousServiceId) {
    const updatedService = state.services.find((item) => item.id === previousServiceId);
    if (updatedService) {
      state.service = updatedService;
    } else {
      state.service = null;
      state.payment = null;
      state.date = null;
      state.slot = null;
    }
  }
}

function startAutoRefresh() {
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(async () => {
    try {
      await loadPublicData({ preserveSelection: true });
      renderSettings();
      renderServices();
      renderPayments();
      renderSummary();
      if (state.service && state.payment) {
        await syncMonthAvailability({ keepSlots: Boolean(state.date) });
      }
    } catch (_error) {
      // atualização silenciosa para refletir mudanças do admin sem interromper o cliente
    }
  }, SERVICE_REFRESH_INTERVAL);
}

async function syncMonthAvailability({ keepSlots = false } = {}) {
  if (!(state.service && state.payment)) {
    renderCalendar();
    if (!keepSlots) qs('slotsArea').innerHTML = '';
    return;
  }
  const key = monthAvailabilityKey();
  const year = state.year;
  const month = state.month + 1;
  try {
    const data = await api(`/api/public/month-availability?serviceId=${state.service.id}&year=${year}&month=${month}&_=${Date.now()}`);
    state.monthAvailability[key] = data.availability || {};
  } catch (_error) {
    state.monthAvailability[key] = {};
  }
  renderCalendar();
  if (!keepSlots && !state.date) qs('slotsArea').innerHTML = '';
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
      <div class="service-shift">${publicShiftLabel(service)}</div>
      <div class="service-desc">${service.description || 'Atendimento terapêutico personalizado.'}</div>
      <div class="service-meta">
        <div class="service-duration">Duração da sessão: ${service.duration_minutes} min</div>
      </div>
      <div class="service-prices">
        <div class="price-row"><span class="lbl">PIX</span><span class="val main">${money(service.price_pix)}</span></div>
        <div class="price-row"><span class="lbl">Cartão</span><span class="val">${money(service.price_card)}</span></div>
        <div class="price-row"><span class="lbl">Parcelado</span><span class="val">${service.price_installment}</span></div>
      </div>
    </article>`).join('');

  document.querySelectorAll('.service-card').forEach((card) => {
    card.onclick = async () => {
      const nextService = state.services.find((service) => service.id === card.dataset.id);
      if (!nextService) return;
      state.service = nextService;
      state.payment = null;
      state.date = null;
      state.slot = null;
      card.classList.add('select-flash');
      renderServices();
      renderPayments();
      renderCalendar();
      qs('slotsArea').innerHTML = '';
      renderSummary();
      window.setTimeout(() => {
        step(2);
        revealAndScrollSection('sec2');
      }, 180);
    };
  });
}

function renderPayments() {
  const container = qs('payOptions');
  if (!state.service) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = paymentOptions(state.service).map((option) => `
    <button class="pay-btn ${state.payment === option.id ? 'sel' : ''}" type="button" data-id="${option.id}">
      <span class="pi">${option.icon}</span>
      <div class="plbl">${option.label}</div>
      <div class="pv">${option.value}</div>
      <div class="price-note">${option.note}</div>
    </button>`).join('');

  document.querySelectorAll('.pay-btn').forEach((button) => {
    button.onclick = async () => {
      state.payment = button.dataset.id;
      state.date = null;
      state.slot = null;
      renderPayments();
      renderSummary();
      qs('slotsArea').innerHTML = '<div class="loading-inline">Carregando datas disponíveis...</div>';
      await syncMonthAvailability();
      step(3);
      revealAndScrollSection('sec3');
      qs('slotsArea').innerHTML = '';
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
    const canInteract = Boolean(state.service && state.payment) && !past;
    const knownAvailable = Boolean(availability && availability[value]?.available);
    const className = past ? 'past' : knownAvailable ? 'avail' : 'off';
    html += `<button class="cal-day ${className} ${state.date === value ? 'selday' : ''} ${date.getTime() === today.getTime() ? 'tod' : ''}" ${canInteract ? '' : 'disabled'} data-date="${value}">${day}</button>`;
  }
  qs('calendarGrid').innerHTML = html;

  document.querySelectorAll('.cal-day:not(.empty):not(.past)').forEach((btn) => {
    btn.onclick = async () => {
      if (!(state.service && state.payment)) return;
      state.date = btn.dataset.date;
      state.slot = null;
      btn.classList.add('select-flash');
      renderCalendar();
      qs('slotsArea').innerHTML = `<div class="loading-inline">Carregando horários de ${fmtDate(state.date)}...</div>`;
      await renderSlots();
      renderSummary();
    };
  });
}

async function renderSlots() {
  if (!state.service || !state.date) {
    qs('slotsArea').innerHTML = '';
    return;
  }
  try {
    const data = await api(`/api/public/availability?serviceId=${state.service.id}&date=${state.date}&_=${Date.now()}`);
    if (!Array.isArray(data.slots) || !data.slots.length) {
      qs('slotsArea').innerHTML = '<div class="no-slots">Sem horários disponíveis para este dia.</div>';
      return;
    }
    qs('slotsArea').innerHTML = `
      <div class="slots-lbl">${fmtDate(state.date)} — ${data.slots.length} horário(s) disponível(is)</div>
      <div class="slots-grid">${data.slots.map((slot) => `<button class="slot-btn ${state.slot?.startMinutes === slot.startMinutes ? 'selslot' : ''}" type="button" data-start="${slot.startMinutes}" data-end="${slot.endMinutes}">${range(slot)}</button>`).join('')}</div>`;

    document.querySelectorAll('.slot-btn').forEach((button) => {
      button.onclick = () => {
        state.slot = { startMinutes: Number(button.dataset.start), endMinutes: Number(button.dataset.end) };
        button.classList.add('select-flash');
        renderSummary();
        window.setTimeout(() => {
          renderSlots().catch(() => null);
          step(4);
          revealAndScrollSection('sec4');
        }, 150);
      };
    });
  } catch (error) {
    qs('slotsArea').innerHTML = `<div class="slots-error">Não foi possível atualizar os horários deste dia: ${error.message}</div>`;
  }
}

function renderSummary() {
  if (!(state.service && state.payment && state.date && state.slot)) {
    qs('summaryBox').innerHTML = '<div class="srow"><span class="sk">Resumo</span><span class="sv">Selecione serviço, pagamento e horário</span></div>';
    return;
  }
  const payment = paymentOptions(state.service).find((item) => item.id === state.payment);
  qs('summaryBox').innerHTML = `
    <div class="srow"><span class="sk">Serviço</span><span class="sv">${state.service.name}</span></div>
    <div class="srow"><span class="sk">Turno</span><span class="sv">${publicShiftLabel(state.service)}</span></div>
    <div class="srow"><span class="sk">Duração</span><span class="sv">${state.service.duration_minutes} min</span></div>
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
    await api(`/api/public/client-check?name=${encodeURIComponent(name)}&whatsapp=${encodeURIComponent(whatsapp)}&_=${Date.now()}`);
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

async function refreshOnVisibility() {
  if (document.hidden) return;
  try {
    await loadPublicData({ preserveSelection: true });
    renderSettings();
    renderServices();
    renderPayments();
    renderSummary();
    if (state.service && state.payment) {
      await syncMonthAvailability({ keepSlots: true });
      if (state.date) await renderSlots();
    }
  } catch (_error) {
    // atualização silenciosa
  }
}

async function init() {
  await loadPublicData({ preserveSelection: false });
  renderSettings();
  renderServices();
  renderPayments();
  renderSummary();
  renderCalendar();
  startAutoRefresh();
}

qs('prevMonth').onclick = async () => {
  state.month -= 1;
  if (state.month < 0) {
    state.month = 11;
    state.year -= 1;
  }
  renderCalendar();
  await syncMonthAvailability({ keepSlots: false });
};

qs('nextMonth').onclick = async () => {
  state.month += 1;
  if (state.month > 11) {
    state.month = 0;
    state.year += 1;
  }
  renderCalendar();
  await syncMonthAvailability({ keepSlots: false });
};

qs('confirmButton').onclick = submitAppointment;
qs('adminButton').onclick = () => { window.location.href = '/admin.html'; };
qs('clientName').addEventListener('input', scheduleClientCheck);
qs('clientWhatsapp').addEventListener('input', scheduleClientCheck);
document.addEventListener('visibilitychange', () => { refreshOnVisibility().catch(() => null); });

init().catch((error) => {
  console.error(error);
  alert('Não foi possível carregar a agenda no momento.');
});
