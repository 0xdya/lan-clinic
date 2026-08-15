/**
 * app.js - LAN Clinic Renderer Logic
 * Manages UI state, REST API calls, and Socket.io real-time LAN synchronization.
 */

// ─────────────────────────────────────────────
// Application State
// ─────────────────────────────────────────────
const state = {
  role: 'doctor', // 'doctor' | 'secretary'
  hostIp: '127.0.0.1',
  port: 3000,
  socket: null,
  queue: [],
  activeQueueItem: null,
  doctorFilter: 'all',
  secretaryFilter: 'all',
  notesDebounceTimer: null,
};

// ─────────────────────────────────────────────
// API Helper
// ─────────────────────────────────────────────
function getApiBaseUrl() {
  return `http://${state.hostIp}:${state.port}/api`;
}

async function apiFetch(endpoint, options = {}) {
  const url = `${getApiBaseUrl()}${endpoint}`;
  try {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json', ...options.headers },
      ...options,
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'API call failed');
    return json;
  } catch (err) {
    console.error(`[API Error] ${endpoint}:`, err);
    throw err;
  }
}

// ─────────────────────────────────────────────
// Initialization & Role Modal Handling
// ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Pre-fill LAN IP if available
  try {
    const sys = await window.electronAPI.getSystemInfo();
    state.hostIp = sys.ip;
    document.getElementById('server-ip-input').value = sys.ip;
  } catch (e) {
    console.warn('[App] System info unavailable in browser test mode');
  }

  // Setup Event Listeners
  document.getElementById('btn-confirm-role').addEventListener('click', handleRoleConfirm);
  document.getElementById('btn-switch-role').addEventListener('click', switchRole);
  document.getElementById('btn-save-notes').addEventListener('click', manualSaveNotes);

  // Notes editor auto-save on typing (debounced)
  const notesArea = document.getElementById('doctor-notes-editor');
  notesArea.addEventListener('input', handleNotesTyping);
});

function selectRoleCard(role) {
  state.role = role;
  document.getElementById('card-role-doctor').classList.toggle('selected', role === 'doctor');
  document.getElementById('card-role-secretary').classList.toggle('selected', role === 'secretary');

  const ipBox = document.getElementById('ip-config-box');
  if (role === 'secretary') {
    ipBox.classList.add('active');
  } else {
    ipBox.classList.remove('active');
  }
}

async function handleRoleConfirm() {
  const modal = document.getElementById('role-modal-overlay');
  const roleBadge = document.getElementById('role-badge');

  if (state.role === 'doctor') {
    // Start local server (Doctor Host)
    try {
      const serverRes = await window.electronAPI.startServer();
      if (!serverRes.success) {
        alert(`فشل تشغيل خادم الطبيب: ${serverRes.error}`);
        return;
      }
      state.hostIp = serverRes.ip || '127.0.0.1';
    } catch (err) {
      console.warn('[App] Start server IPC error, using local fallback:', err);
    }

    roleBadge.textContent = 'طبيب (Doctor Host)';
    roleBadge.className = 'role-badge doctor';

    document.getElementById('doctor-view').classList.remove('hidden');
    document.getElementById('secretary-view').classList.add('hidden');
  } else {
    // Secretary Client Mode
    const customIp = document.getElementById('server-ip-input').value.trim();
    state.hostIp = customIp || state.hostIp || '127.0.0.1';

    roleBadge.textContent = 'سكرتارية (Secretary Client)';
    roleBadge.className = 'role-badge secretary';

    document.getElementById('secretary-view').classList.remove('hidden');
    document.getElementById('doctor-view').classList.add('hidden');
  }

  modal.classList.add('hidden');

  // Display Host IP in header
  document.getElementById('host-ip-display').textContent = `IP: ${state.hostIp}`;

  // Initialize Socket.io connection & load initial queue data
  initSocketConnection();
  await loadQueueData();

  if (state.role === 'secretary') {
    await loadPatientSearchResults();
  }
}

function switchRole() {
  if (state.socket) {
    state.socket.disconnect();
    state.socket = null;
  }
  document.getElementById('role-modal-overlay').classList.remove('hidden');
  document.getElementById('doctor-view').classList.add('hidden');
  document.getElementById('secretary-view').classList.add('hidden');
}

// ─────────────────────────────────────────────
// Socket.io Real-Time LAN Sync
// ─────────────────────────────────────────────
function initSocketConnection() {
  const serverUrl = `http://${state.hostIp}:${state.port}`;
  console.log(`[Socket] Connecting to: ${serverUrl}`);

  const dot = document.getElementById('connection-dot');
  const text = document.getElementById('connection-text');

  text.textContent = 'جاري الاتصال...';

  try {
    state.socket = io(serverUrl, {
      reconnectionAttempts: 10,
      timeout: 5000,
    });

    state.socket.on('connect', () => {
      console.log('[Socket] Connected!');
      dot.className = 'status-dot online';
      text.textContent = 'متصل بالشبكة';
    });

    state.socket.on('disconnect', () => {
      console.warn('[Socket] Disconnected!');
      dot.className = 'status-dot offline';
      text.textContent = 'انقطع الاتصال';
    });

    state.socket.on('connect_error', (err) => {
      console.error('[Socket] Connection error:', err);
      dot.className = 'status-dot offline';
      text.textContent = 'فشل الاتصال بالخادم';
    });

    // Real-time Queue Updates broadcasted from Secretary or Doctor
    state.socket.on('queue:updated', (_data) => {
      console.log('[Socket] queue:updated received');
      loadQueueData();
    });

    // Real-time Notes Updates (Doctor saved notes)
    state.socket.on('notes:updated', (data) => {
      console.log('[Socket] notes:updated received', data);
      if (state.activeQueueItem && state.activeQueueItem.id === data.queue_id) {
        state.activeQueueItem.doctor_notes = data.doctor_notes;
        if (state.role === 'doctor') {
          document.getElementById('doctor-notes-editor').value = data.doctor_notes;
          updateSaveStatus('محفوظ بالشبكة', true);
        }
      }
    });
  } catch (e) {
    console.error('[Socket] Init failed:', e);
  }
}

// ─────────────────────────────────────────────
// Queue Data Fetching & Rendering
// ─────────────────────────────────────────────
async function loadQueueData() {
  try {
    const res = await apiFetch('/queue');
    state.queue = res.data || [];

    // Find currently active patient (In Progress)
    const active = state.queue.find((q) => q.status === 'In Progress');
    state.activeQueueItem = active || null;

    if (state.role === 'doctor') {
      renderDoctorView();
    } else {
      renderSecretaryView();
    }
  } catch (err) {
    console.error('[App] Failed to load queue:', err);
  }
}

// ─────────────────────────────────────────────
// DOCTOR VIEW LOGIC
// ─────────────────────────────────────────────
function renderDoctorView() {
  const banner = document.getElementById('active-patient-banner');
  const noActiveBox = document.getElementById('no-active-patient-box');
  const notesEditor = document.getElementById('doctor-notes-editor');

  if (state.activeQueueItem) {
    // Show active patient banner
    banner.classList.remove('hidden');
    noActiveBox.classList.add('hidden');

    document.getElementById('active-queue-num').textContent = `#${state.activeQueueItem.queue_number}`;
    document.getElementById('active-patient-name').textContent = state.activeQueueItem.full_name;
    document.getElementById('active-patient-age').textContent = state.activeQueueItem.age ? `${state.activeQueueItem.age} سنة` : '--';
    document.getElementById('active-patient-phone').textContent = state.activeQueueItem.phone || '--';
    document.getElementById('active-patient-date').textContent = state.activeQueueItem.visit_date;

    // Load active patient notes if not currently editing
    if (document.activeElement !== notesEditor) {
      notesEditor.value = state.activeQueueItem.doctor_notes || '';
    }
  } else {
    // Hide active patient banner
    banner.classList.add('hidden');
    noActiveBox.classList.remove('hidden');
    if (document.activeElement !== notesEditor) {
      notesEditor.value = '';
    }
  }

  // Render Doctor Read-Only Queue Sidebar
  renderDoctorQueueList();
}

function renderDoctorQueueList() {
  const container = document.getElementById('doctor-queue-list');
  const countBadge = document.getElementById('doctor-queue-count');

  let filtered = state.queue;
  if (state.doctorFilter !== 'all') {
    filtered = state.queue.filter((q) => q.status === state.doctorFilter);
  }

  countBadge.textContent = `${filtered.length} مريض`;

  if (filtered.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; color: var(--text-muted); padding: 2rem 1rem; font-size: 0.88rem;">
        لا يوجد مرضى في هذه القائمة حالياً.
      </div>
    `;
    return;
  }

  container.innerHTML = filtered
    .map((item) => {
      const statusClasses = {
        Waiting: 'waiting',
        'In Progress': 'in-progress',
        Completed: 'completed',
        Cancelled: 'cancelled',
      };
      const statusLabels = {
        Waiting: 'في الانتظار',
        'In Progress': 'في العيادة',
        Completed: 'مكتمل',
        Cancelled: 'ملغى',
      };

      const isCurrentActive = state.activeQueueItem && state.activeQueueItem.id === item.id;

      return `
        <div class="queue-item-card ${statusClasses[item.status] || ''} ${isCurrentActive ? 'in-progress' : ''}">
          <div class="item-top-row">
            <span class="item-queue-num">#${item.queue_number}</span>
            <span class="badge-status ${statusClasses[item.status] || ''}">${statusLabels[item.status]}</span>
          </div>
          <div class="item-patient-name">${escapeHtml(item.full_name)}</div>
          <div class="item-meta">
            <span>العمر: ${item.age || '--'}</span>
            <span dir="ltr">${item.phone || ''}</span>
          </div>
        </div>
      `;
    })
    .join('');
}

function filterQueue(status, btn) {
  state.doctorFilter = status;
  const tabs = btn.parentElement.querySelectorAll('.tab-btn');
  tabs.forEach((t) => t.classList.remove('active'));
  btn.classList.add('active');
  renderDoctorQueueList();
}

// Quick Notes Template Pill Insertion
function insertNoteTemplate(text) {
  const notesEditor = document.getElementById('doctor-notes-editor');
  if (notesEditor.value.trim().length > 0) {
    notesEditor.value += `\n- ${text}`;
  } else {
    notesEditor.value = `- ${text}`;
  }
  handleNotesTyping();
}

// Debounced Auto-Save for Notes
function handleNotesTyping() {
  updateSaveStatus('جاري التغيير...', false);
  if (state.notesDebounceTimer) clearTimeout(state.notesDebounceTimer);
  state.notesDebounceTimer = setTimeout(() => {
    saveDoctorNotes();
  }, 1000);
}

function manualSaveNotes() {
  if (state.notesDebounceTimer) clearTimeout(state.notesDebounceTimer);
  saveDoctorNotes();
}

async function saveDoctorNotes() {
  if (!state.activeQueueItem) {
    updateSaveStatus('لا يوجد مريض نشط لحفظ الملاحظات', false);
    return;
  }

  const notesText = document.getElementById('doctor-notes-editor').value;

  try {
    await apiFetch(`/queue/${state.activeQueueItem.id}/notes`, {
      method: 'PATCH',
      body: JSON.stringify({ doctor_notes: notesText }),
    });

    state.activeQueueItem.doctor_notes = notesText;
    updateSaveStatus('تم الحفظ بنجاح 🟢', true);

    // Notify LAN over Socket.io
    if (state.socket) {
      state.socket.emit('client:notes-change', {
        queue_id: state.activeQueueItem.id,
        doctor_notes: notesText,
      });
    }
  } catch (err) {
    updateSaveStatus('فشل الحفظ ❌', false);
  }
}

function updateSaveStatus(msg, isSaved) {
  const statusEl = document.getElementById('notes-save-status');
  statusEl.textContent = msg;
  statusEl.className = `save-indicator ${isSaved ? 'saved' : ''}`;
}

// ─────────────────────────────────────────────
// SECRETARY VIEW LOGIC
// ─────────────────────────────────────────────
function renderSecretaryView() {
  renderSecretaryQueueList();
}

function renderSecretaryQueueList() {
  const container = document.getElementById('secretary-queue-list');
  const countBadge = document.getElementById('secretary-queue-count');

  let filtered = state.queue;
  if (state.secretaryFilter !== 'all') {
    filtered = state.queue.filter((q) => q.status === state.secretaryFilter);
  }

  countBadge.textContent = `${filtered.length} مريض`;

  if (filtered.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; color: var(--text-muted); padding: 2rem 1rem; font-size: 0.88rem;">
        لا يوجد مرضى في الدور حالياً.
      </div>
    `;
    return;
  }

  container.innerHTML = filtered
    .map((item) => {
      const statusClasses = {
        Waiting: 'waiting',
        'In Progress': 'in-progress',
        Completed: 'completed',
        Cancelled: 'cancelled',
      };
      const statusLabels = {
        Waiting: 'في الانتظار',
        'In Progress': 'في العيادة',
        Completed: 'مكتمل',
        Cancelled: 'ملغى',
      };

      return `
        <div class="queue-item-card ${statusClasses[item.status] || ''}">
          <div class="item-top-row">
            <span class="item-queue-num">#${item.queue_number}</span>
            <span class="badge-status ${statusClasses[item.status] || ''}">${statusLabels[item.status]}</span>
          </div>
          <div class="item-patient-name">${escapeHtml(item.full_name)}</div>
          <div class="item-meta">
            <span>العمر: ${item.age || '--'}</span>
            <span dir="ltr">${item.phone || ''}</span>
          </div>
          
          <!-- Prominent Status Action Buttons for Secretary -->
          <div class="item-actions">
            ${
              item.status === 'Waiting'
                ? `<button class="btn-action btn-call" onclick="updateQueueStatus(${item.id}, 'In Progress')">دخل</button>`
                : ''
            }
            ${
              item.status === 'In Progress'
                ? `<button class="btn-action btn-complete" onclick="updateQueueStatus(${item.id}, 'Completed')">✅ إنهاء (Completed)</button>`
                : ''
            }
            ${
              item.status !== 'Cancelled' && item.status !== 'Completed'
                ? `<button class="btn-action btn-cancel" onclick="updateQueueStatus(${item.id}, 'Cancelled')">❌ إلغاء</button>`
                : ''
            }
          </div>
        </div>
      `;
    })
    .join('');
}

function filterSecretaryQueue(status, btn) {
  state.secretaryFilter = status;
  const tabs = btn.parentElement.querySelectorAll('.tab-btn');
  tabs.forEach((t) => t.classList.remove('active'));
  btn.classList.add('active');
  renderSecretaryQueueList();
}

// Add New Patient & Append to Queue
async function handlePatientRegistration(event) {
  event.preventDefault();

  const fullNameInput = document.getElementById('reg-full-name');
  const ageInput = document.getElementById('reg-age');
  const phoneInput = document.getElementById('reg-phone');

  const fullName = fullNameInput.value.trim();
  const age = ageInput.value.trim();
  const phone = phoneInput.value.trim();

  if (!fullName) return;

  try {
    // 1. Create Patient in database
    const patientRes = await apiFetch('/patients', {
      method: 'POST',
      body: JSON.stringify({ full_name: fullName, age, phone }),
    });

    const patient = patientRes.data;

    // 2. Add Patient to Today's Queue
    await apiFetch('/queue', {
      method: 'POST',
      body: JSON.stringify({ patient_id: patient.id }),
    });

    // Reset Form
    fullNameInput.value = '';
    ageInput.value = '';
    phoneInput.value = '';
    fullNameInput.focus();

    // Reload Queue & Patient List, then emit socket event
    await loadQueueData();
    await loadPatientSearchResults(document.getElementById('search-patient-input').value);
    if (state.socket) {
      state.socket.emit('client:queue-change', { action: 'add', patient_id: patient.id });
    }
  } catch (err) {
    alert(`فشل التسجيل: ${err.message}`);
  }
}

// Secretary Updates Status (Waiting -> In Progress -> Completed -> Cancelled)
async function updateQueueStatus(queueId, newStatus) {
  try {
    await apiFetch(`/queue/${queueId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: newStatus }),
    });

    await loadQueueData();

    // Broadcast change instantly over LAN
    if (state.socket) {
      state.socket.emit('client:queue-change', { queue_id: queueId, status: newStatus });
    }
  } catch (err) {
    alert(`فشل تغيير حالة الدور: ${err.message}`);
  }
}

// Search Existing Patients
let searchDebounce = null;

function renderPatientSearchResults(patients, { isSearching = false } = {}) {
  const listEl = document.getElementById('search-results-list');

  if (patients.length === 0) {
    const emptyMessage = isSearching
      ? 'لم يتم العثور على مريض بهذا الاسم/الهاتف'
      : 'لا يوجد مرضى مسجلون حالياً';
    listEl.innerHTML = `<div style="padding: 0.75rem; text-align: center; color: var(--text-muted); font-size: 0.85rem;">${emptyMessage}</div>`;
  } else {
    listEl.innerHTML = patients
      .map(
        (p) => `
          <div class="search-result-item">
            <div>
              <strong>${escapeHtml(p.full_name)}</strong>
              <div style="font-size: 0.78rem; color: var(--text-secondary);">العمر: ${p.age || '--'} | هاتف: ${p.phone || '--'}</div>
            </div>
            <button class="btn-add-queue" onclick="addExistingPatientToQueue(${p.id})">➕ أضف للدور</button>
          </div>
        `
      )
      .join('');
  }

  listEl.classList.remove('hidden');
}

async function loadPatientSearchResults(query = '') {
  const listEl = document.getElementById('search-results-list');
  const trimmedQuery = query.trim();
  const endpoint = trimmedQuery
    ? `/patients?q=${encodeURIComponent(trimmedQuery)}`
    : '/patients';

  try {
    const res = await apiFetch(endpoint);
    renderPatientSearchResults(res.data || [], { isSearching: Boolean(trimmedQuery) });
  } catch (err) {
    console.error('[Search] Error:', err);
    listEl.innerHTML = `<div style="padding: 0.75rem; text-align: center; color: var(--text-muted); font-size: 0.85rem;">تعذر تحميل قائمة المرضى</div>`;
    listEl.classList.remove('hidden');
  }
}

function handlePatientSearch(query) {
  if (searchDebounce) clearTimeout(searchDebounce);

  searchDebounce = setTimeout(() => {
    loadPatientSearchResults(query);
  }, 300);
}

async function addExistingPatientToQueue(patientId) {
  try {
    await apiFetch('/queue', {
      method: 'POST',
      body: JSON.stringify({ patient_id: patientId }),
    });

    document.getElementById('search-patient-input').value = '';
    await loadQueueData();
    await loadPatientSearchResults();
    if (state.socket) {
      state.socket.emit('client:queue-change', { action: 'add', patient_id: patientId });
    }
  } catch (err) {
    alert(`تعذر إضافة المريض للدور: ${err.message}`);
  }
}

// Safety HTML escaping
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
