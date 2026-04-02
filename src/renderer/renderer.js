/* ═══════════════════════════════════════════════════════
   State & Config
   ═══════════════════════════════════════════════════════ */
let state = { sections: [], settings: { geminiKey: '' }, reminders: [], mailEvents: [] };
let editMode = false;
let editingSectionId = null;
let dragData = null;
let contacts = [];
let currentTab = 'todo';
let currentReminder = null;
let selectedMailTask = null;
let timelineMonth = new Date();
let agendaWeekStart = new Date();
let agendaEventsCache = [];
let agendaCalendars = [];
let agendaSelectedCalendarIds = [];
let agendaInteractionState = null;
let agendaPointerSuppressClickUntil = 0;
let selectedAgendaEventId = null;
let siteTabs = [];          // [{id, label, url, icon}]
let siteTabsInitialized = {};  // {siteTabId: true} — tracks which BrowserViews are created
let browserEventsBound = false;
const SITE_TABS_STORAGE_KEY = 'site-tabs-v2';
let agendaInitialized = false;
let composerReplyContext = null;
let leadsActiveProjectId = null;
let leadsFilter = 'all';
let leadsEditingId = null;

const uid = () => Math.random().toString(36).slice(2, 10);
const esc = s => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const EMOJIS = [
    '📋','📌','📞','💼','🤝','💻','🚀','🗂️','📊','💡',
    '🎯','🔧','⚡','🏆','📝','✨','🌟','💎','🔬','🎨',
    '📚','🔔','🏠','💰','🎓','🧪','🌍','🛠️','📦','🎪',
    '🧩','💬','📐','🔑','🏗️','⏰','🧲','🎶','🖥️','❤️',
    '🔥','🌈','🍀','💪','🧠','👁️','🎁','📱','🌐','🔗',
    '💊','🩺','📈','🔒','🛡️','⭐','💫','🎭','🧬','🔎'
];
const COLORS = ['blue', 'orange', 'green', 'purple', 'pink', 'slate'];
const COLOR_HEX = {
    blue: '#6c8aff', orange: '#f59e0b', green: '#34d399',
    purple: '#a78bfa', pink: '#f472b6', slate: '#94a3b8'
};
let modalEmoji = '📋';
let modalColor = 'blue';

/* ═══════════════════════════════════════════════════════
   Tab Switching
   ═══════════════════════════════════════════════════════ */
function switchTab(tab) {
    currentTab = tab;
    const isSiteTab = tab.startsWith('site-');
    document.querySelectorAll('.tab-btn').forEach((b) => {
        b.classList.toggle('active', b.dataset.tab === tab);
    });
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    if (isSiteTab) {
        document.getElementById('tab-site').classList.add('active');
        initSiteTabView(tab);
    } else {
        const el = document.getElementById('tab-' + tab);
        if (el) el.classList.add('active');
    }
    if (tab === 'mail') renderMailTab();
    if (tab === 'inbox') loadInbox();
    if (tab === 'graph') initGraphIfNeeded();
    if (tab === 'agenda') initAgendaIfNeeded();
    if (tab === 'leads') renderLeads();
    updateSiteTabViewVisibility();
}

/* ═══════════════════════════════════════════════════════
   API Layer
   ═══════════════════════════════════════════════════════ */
let saveTimer;

async function loadState() {
    try {
        const r = await fetch('/api/state');
        if (r.ok) {
            const data = await r.json();
            if (data.sections) state = data;
        }
    } catch {
        try {
            const raw = localStorage.getItem('todo-state');
            if (raw) state = JSON.parse(raw);
        } catch {}
    }
    if (!state.sections) state.sections = [];
    if (!state.settings) state.settings = { geminiKey: '' };
    if (!state.reminders) state.reminders = [];
    if (!state.mailEvents) state.mailEvents = [];
    // Migration: convert old isMail flag to type field, old dismissed to status
    state.sections.forEach(s => {
        s.tasks.forEach(t => {
            if (!t.type) t.type = t.isMail ? 'mail' : 'task';
        });
    });
    state.reminders.forEach(r => {
        if (!r.status) r.status = r.dismissed ? 'dismissed' : 'pending';
        if (!r.cycle) r.cycle = 1;
    });
}

async function loadContacts() {
    try {
        const r = await fetch('/api/contacts');
        if (r.ok) contacts = await r.json();
    } catch {}
}

function autoSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
        try {
            await fetch('/api/state', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(state)
            });
        } catch {
            localStorage.setItem('todo-state', JSON.stringify(state));
        }
    }, 400);
}

/* ═══════════════════════════════════════════════════════
   Rendering
   ═══════════════════════════════════════════════════════ */
function render() {
    const app = document.getElementById('app');
    const scrollY = window.scrollY;
    app.innerHTML = renderHeader() + renderProgress() + renderSections()
        + (editMode ? '<button class="add-section-btn" onclick="openSectionModal()">+ Nouvelle section</button>' : '');
    updateProgress();
    setupDragDrop();
    window.scrollTo(0, scrollY);
}

function renderHeader() {
    return `
    <header>
        <h1><i class="icon-list-checks"></i> Plan d'action</h1>
        <div class="header-actions">
            <button onclick="toggleEdit()" class="${editMode ? 'active' : ''}">
                ${editMode ? '<i class="icon-check"></i> Terminer' : '<i class="icon-pencil"></i> Éditer'}
            </button>
        </div>
    </header>`;
}

function renderProgress() {
    return `
    <div class="global-progress">
        <div class="global-progress-header">
            <span>Progression globale</span>
            <span class="counter"><strong id="gDone">0</strong> / <span id="gTotal">0</span> tâches</span>
        </div>
        <div class="progress-bar-track">
            <div class="progress-bar-fill" id="gBar"></div>
        </div>
        <div class="progress-percent" id="gPercent">0 %</div>
    </div>`;
}

function renderSections() {
    return state.sections.map(s => {
        const tasksHtml = s.tasks.map(t => renderTask(t, s.id)).join('');
        const editBtns = `
            <button class="btn-icon" onclick="event.stopPropagation();openSectionModal('${s.id}')" title="Modifier"><i class="icon-pencil"></i></button>
        `;
        const dangerBtns = editMode ? `
            <button class="btn-icon" onclick="event.stopPropagation();deleteSection('${s.id}')" title="Supprimer"><i class="icon-trash-2"></i></button>
        ` : '';
        const desc = s.description
            ? `<p class="section-desc" data-desc="${s.id}" ${s.collapsed ? 'style="display:none"' : ''}>${esc(s.description)}</p>`
            : '';
        const addBtns = editMode
            ? `<div class="add-task-buttons">
                <button onclick="addTask('${s.id}','task')">+ Tâche</button>
                <button class="mail-btn" onclick="addTask('${s.id}','mail')"><i class="icon-mail"></i> + Mail</button>
               </div>`
            : '';
        return `
        <div class="section" data-color="${esc(s.color)}" data-sid="${s.id}">
            <div class="section-header" onclick="onSectionClick('${s.id}')">
                <span class="section-title">
                    ${s.emoji} ${esc(s.title)}
                    <span class="section-badge">${esc(s.badge || '')}</span>
                </span>
                <div class="section-header-right">
                    ${editBtns}
                    ${dangerBtns}
                    <div class="section-progress-mini">
                        <div class="mini-bar"><div class="mini-fill" data-sfill="${s.id}"></div></div>
                        <span class="mini-text" data-stext="${s.id}">0%</span>
                    </div>
                </div>
            </div>
            ${desc}
            <div class="task-list" data-slist="${s.id}" ${s.collapsed ? 'style="display:none"' : ''}>
                ${tasksHtml}
                ${addBtns}
            </div>
        </div>`;
    }).join('');
}

function renderTask(t, sid) {
    const cls = [
        'task-item',
        t.done ? 'checked' : '',
        t.indent ? 'sub-task' : '',
        (t.type === 'mail' || t.isMail) ? 'is-mail' : ''
    ].filter(Boolean).join(' ');

    const check = `<div class="custom-check" onclick="toggleTask('${sid}','${t.id}')">
        <svg viewBox="0 0 24 24"><polyline points="4 12 10 18 20 6"/></svg></div>`;

    if (editMode) {
        const typeBadge = (t.type === 'mail' || t.isMail)
            ? '<span class="task-type-badge"><i class="icon-mail"></i> Mail</span>'
            : '';
        return `
        <div class="${cls}" data-sid="${sid}" data-tid="${t.id}" draggable="true">
            ${check}
            <div class="task-edit-fields">
                <input type="text" class="task-input" value="${esc(t.label)}"
                    onchange="updateTask('${sid}','${t.id}','label',this.value)"
                    onkeydown="if(event.key==='Enter'){this.blur()}">
                <input type="text" class="task-note-input" value="${esc(t.note || '')}"
                    placeholder="Note (optionnel)"
                    onchange="updateTask('${sid}','${t.id}','note',this.value)"
                    onkeydown="if(event.key==='Enter'){this.blur()}">
            </div>
            <div class="edit-actions">
                ${typeBadge}
                <button class="btn-icon" onclick="toggleIndent('${sid}','${t.id}')" title="Indenter / Désindenter">↔</button>
                <button class="btn-icon" onclick="deleteTask('${sid}','${t.id}')" title="Supprimer"><i class="icon-trash-2"></i></button>
            </div>
        </div>`;
    }

    return `
    <div class="${cls}" data-sid="${sid}" data-tid="${t.id}" draggable="true">
        ${check}
        <span class="task-label" onclick="toggleTask('${sid}','${t.id}')">
            ${esc(t.label)}${t.note ? `<span class="task-note">${esc(t.note)}</span>` : ''}
        </span>
    </div>`;
}

/* ═══════════════════════════════════════════════════════
   Progress
   ═══════════════════════════════════════════════════════ */
function updateProgress() {
    let total = 0, done = 0;
    state.sections.forEach(s => {
        let st = 0, sd = 0;
        s.tasks.forEach(t => { st++; total++; if (t.done) { sd++; done++; } });
        const sp = st ? Math.round((sd / st) * 100) : 0;
        const fill = document.querySelector(`[data-sfill="${s.id}"]`);
        const text = document.querySelector(`[data-stext="${s.id}"]`);
        if (fill) fill.style.width = sp + '%';
        if (text) text.textContent = sp + '%';
    });
    const pct = total ? Math.round((done / total) * 100) : 0;
    const gDone = document.getElementById('gDone');
    const gTotal = document.getElementById('gTotal');
    const gBar = document.getElementById('gBar');
    const gPercent = document.getElementById('gPercent');
    if (gDone) gDone.textContent = done;
    if (gTotal) gTotal.textContent = total;
    if (gBar) gBar.style.width = pct + '%';
    if (gPercent) gPercent.textContent = pct + ' %';
    if (pct === 100 && total > 0) launchConfetti();
}

/* ═══════════════════════════════════════════════════════
   Task Operations
   ═══════════════════════════════════════════════════════ */
function toggleTask(sid, tid) {
    const s = state.sections.find(x => x.id === sid);
    if (!s) return;
    const t = s.tasks.find(x => x.id === tid);
    if (!t) return;
    t.done = !t.done;

    // For mail tasks, sync with sent status
    if (t.type === 'mail' || t.isMail) {
        if (t.done && !t.sentAt) {
            markMailTaskSent(sid, tid);
        } else if (!t.done && t.sentAt) {
            unmarkMailTaskSent(sid, tid);
        }
    }

    const el = document.querySelector(`[data-sid="${sid}"][data-tid="${tid}"]`);
    if (el) el.classList.toggle('checked', t.done);
    updateProgress();
    autoSave();
    if (currentTab === 'mail') renderMailTab();
}

function updateTask(sid, tid, field, value) {
    const s = state.sections.find(x => x.id === sid);
    if (!s) return;
    const t = s.tasks.find(x => x.id === tid);
    if (!t) return;
    t[field] = value;
    autoSave();
}

function addTask(sid, type) {
    type = type || 'task';
    const s = state.sections.find(x => x.id === sid);
    if (!s) return;
    s.tasks.push({
        id: uid(), label: '', note: '', done: false, indent: 0,
        type: type, isMail: type === 'mail',
        mailTo: '', mailFrom: '', mailSubject: '', mailBody: '',
        sentAt: null, respondedAt: null
    });
    render();
    autoSave();
    const inputs = document.querySelectorAll(`[data-sid="${sid}"] .task-input`);
    if (inputs.length) inputs[inputs.length - 1].focus();
}

function deleteTask(sid, tid) {
    const s = state.sections.find(x => x.id === sid);
    if (!s) return;
    s.tasks = s.tasks.filter(t => t.id !== tid);
    render();
    autoSave();
}

function toggleIndent(sid, tid) {
    const s = state.sections.find(x => x.id === sid);
    if (!s) return;
    const t = s.tasks.find(x => x.id === tid);
    if (!t) return;
    t.indent = t.indent ? 0 : 1;
    render();
    autoSave();
}

/* ═══════════════════════════════════════════════════════
   Section Operations
   ═══════════════════════════════════════════════════════ */
function onSectionClick(sid) {
    if (editMode) return;
    const s = state.sections.find(x => x.id === sid);
    if (!s) return;
    s.collapsed = !s.collapsed;
    const list = document.querySelector(`[data-slist="${s.id}"]`);
    const desc = document.querySelector(`[data-desc="${s.id}"]`);
    if (list) list.style.display = s.collapsed ? 'none' : '';
    if (desc) desc.style.display = s.collapsed ? 'none' : '';
    autoSave();
}

function deleteSection(sid) {
    if (!confirm('Supprimer cette section et toutes ses tâches ?')) return;
    state.sections = state.sections.filter(s => s.id !== sid);
    render();
    autoSave();
}

/* ═══════════════════════════════════════════════════════
   Edit Mode
   ═══════════════════════════════════════════════════════ */
function toggleEdit() {
    editMode = !editMode;
    document.body.classList.toggle('edit-mode', editMode);
    render();
}

/* ═══════════════════════════════════════════════════════
   Drag & Drop
   ═══════════════════════════════════════════════════════ */
function setupDragDrop() {
    document.querySelectorAll('.task-item[draggable]').forEach(el => {
        el.addEventListener('dragstart', e => {
            dragData = { sid: el.dataset.sid, tid: el.dataset.tid };
            el.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
        });
        el.addEventListener('dragend', () => {
            el.classList.remove('dragging');
            document.querySelectorAll('.drag-over').forEach(x => x.classList.remove('drag-over'));
            dragData = null;
        });
    });

    document.querySelectorAll('.section').forEach(sec => {
        sec.addEventListener('dragover', e => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            sec.classList.add('drag-over');
        });
        sec.addEventListener('dragleave', e => {
            if (!sec.contains(e.relatedTarget)) sec.classList.remove('drag-over');
        });
        sec.addEventListener('drop', e => {
            e.preventDefault();
            sec.classList.remove('drag-over');
            if (!dragData) return;
            const targetSid = sec.dataset.sid;
            if (dragData.sid === targetSid) return;
            const from = state.sections.find(s => s.id === dragData.sid);
            const to = state.sections.find(s => s.id === targetSid);
            if (!from || !to) return;
            const idx = from.tasks.findIndex(t => t.id === dragData.tid);
            if (idx === -1) return;
            const [task] = from.tasks.splice(idx, 1);
            to.tasks.push(task);
            render();
            autoSave();
            showToast('Tâche déplacée', 'success', 1500);
        });
    });
}

/* ═══════════════════════════════════════════════════════
   Section Modal (create / edit + emoji picker)
   ═══════════════════════════════════════════════════════ */
function openSectionModal(sid) {
    editingSectionId = sid || null;
    const s = sid ? state.sections.find(x => x.id === sid) : null;

    document.getElementById('sectionModalTitle').textContent = s ? 'Modifier la section' : 'Nouvelle section';
    document.getElementById('sectionTitleInput').value = s ? s.title : '';
    document.getElementById('sectionBadgeInput').value = s ? (s.badge || '') : '';
    document.getElementById('sectionDescInput').value = s ? (s.description || '') : '';

    modalEmoji = s ? s.emoji : '📋';
    modalColor = s ? s.color : 'blue';

    renderEmojiGrid();
    renderColorPicker();
    document.getElementById('sectionModal').classList.add('show');
}

function closeSectionModal() {
    document.getElementById('sectionModal').classList.remove('show');
    editingSectionId = null;
}

function renderEmojiGrid() {
    document.getElementById('emojiGrid').innerHTML = EMOJIS.map((e, i) =>
        `<button type="button" class="emoji-btn ${e === modalEmoji ? 'selected' : ''}"
            onclick="selectEmoji(${i})">${e}</button>`
    ).join('');
}

function selectEmoji(idx) {
    modalEmoji = EMOJIS[idx];
    renderEmojiGrid();
}

function renderColorPicker() {
    document.getElementById('colorPicker').innerHTML = COLORS.map((c, i) =>
        `<div class="color-dot ${c === modalColor ? 'selected' : ''}"
            style="background:${COLOR_HEX[c]}" onclick="selectColor(${i})"></div>`
    ).join('');
}

function selectColor(idx) {
    modalColor = COLORS[idx];
    renderColorPicker();
}

function saveSectionModal() {
    const title = document.getElementById('sectionTitleInput').value.trim();
    if (!title) { document.getElementById('sectionTitleInput').focus(); return; }
    const badge = document.getElementById('sectionBadgeInput').value.trim();
    const desc = document.getElementById('sectionDescInput').value.trim();

    if (editingSectionId) {
        const s = state.sections.find(x => x.id === editingSectionId);
        if (s) {
            s.title = title; s.badge = badge; s.description = desc;
            s.emoji = modalEmoji; s.color = modalColor;
        }
    } else {
        state.sections.push({
            id: uid(), emoji: modalEmoji, title, badge, color: modalColor,
            description: desc, collapsed: false, tasks: []
        });
    }
    closeSectionModal();
    render();
    autoSave();
}

/* ═══════════════════════════════════════════════════════
   Settings Modal
   ═══════════════════════════════════════════════════════ */
function openSettings() {
    document.getElementById('settingsModal').classList.add('show');
}

function closeSettings() {
    document.getElementById('settingsModal').classList.remove('show');
}

function toggleSettingsSection(id) {
    const body = document.getElementById(id);
    const sectionKey = id.replace('settings-', '');
    const chevron = document.getElementById('chevron-' + sectionKey);
    if (!body) return;
    const isOpen = body.classList.contains('open');
    body.classList.toggle('open', !isOpen);
    if (chevron) chevron.classList.toggle('open', !isOpen);
}

function saveSettings() {
    closeSettings();
}

function saveMailToolsSettings() {
    const input = document.getElementById('geminiKeyInput');
    state.settings.geminiKey = (input?.value || '').trim();
    autoSave();
    showToast('Cle Gemini sauvegardee.', 'success');
}

function applyThemeMode(mode) {
    const normalized = mode === 'light' ? 'light' : 'dark';
    document.body.classList.toggle('light-mode', normalized === 'light');
    const btn = document.getElementById('themeToggleBtn');
    if (btn) {
        btn.innerHTML = normalized === 'light'
            ? '<i class="icon-moon"></i> Mode sombre'
            : '<i class="icon-sun"></i> Mode clair';
    }
}

function toggleThemeMode() {
    const current = state.settings.uiTheme === 'light' ? 'light' : 'dark';
    const next = current === 'light' ? 'dark' : 'light';
    state.settings.uiTheme = next;
    applyThemeMode(next);
    autoSave();
}

async function importContactsCsv() {
    const input = document.getElementById('contactsCsvInput');
    if (!input.files.length) {
        showToast('Sélectionne un fichier CSV.', 'error');
        return;
    }
    const file = input.files[0];
    const csvText = await file.text();
    showLoading('Import de l\u2019annuaire\u2026');
    try {
        const r = await fetch('/api/contacts/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ csv: csvText })
        });
        const result = await r.json();
        if (result.ok) {
            showToast(`Annuaire importé : ${result.count} contacts`, 'success', 3000);
            await loadContacts();
            document.getElementById('contactsCount').textContent = `${contacts.length} contacts chargés`;
            input.value = '';
        } else {
            showToast('Erreur : ' + (result.error || 'Erreur'), 'error', 5000);
        }
    } catch (e) {
        showToast('Erreur : ' + e.message, 'error', 5000);
    } finally {
        hideLoading();
    }
}

/* ═══════════════════════════════════════════════════════
   Contact Autocomplete (multi-recipient)
   ═══════════════════════════════════════════════════════ */
let mailRecipients = [];
let mailCcRecipients = [];

function renderMailTags() {
    const container = document.getElementById('mailToTags');
    const input = document.getElementById('mailToInput');
    container.querySelectorAll('.email-tag').forEach(t => t.remove());
    mailRecipients.forEach((email, i) => {
        const tag = document.createElement('span');
        tag.className = 'email-tag';
        const c = contacts.find(c => c.email === email);
        tag.innerHTML = `${esc(c ? c.name : email)}<span class="tag-remove" onclick="removeRecipient(${i})">&times;</span>`;
        tag.title = email;
        container.insertBefore(tag, input);
    });
}

function renderCcTags() {
    const container = document.getElementById('mailCcTags');
    const input = document.getElementById('mailCcInput');
    container.querySelectorAll('.email-tag').forEach(t => t.remove());
    mailCcRecipients.forEach((email, i) => {
        const tag = document.createElement('span');
        tag.className = 'email-tag';
        const c = contacts.find(c => c.email === email);
        tag.innerHTML = `${esc(c ? c.name : email)}<span class="tag-remove" onclick="removeCcRecipient(${i})">&times;</span>`;
        tag.title = email;
        container.insertBefore(tag, input);
    });
}

function addRecipient(email) {
    email = email.trim();
    if (!email || mailRecipients.includes(email)) return;
    mailRecipients.push(email);
    renderMailTags();
    const input = document.getElementById('mailToInput');
    input.value = '';
    document.getElementById('contactList').classList.remove('show');
}

function addCcRecipient(email) {
    email = email.trim();
    if (!email || mailCcRecipients.includes(email)) return;
    mailCcRecipients.push(email);
    renderCcTags();
    const input = document.getElementById('mailCcInput');
    input.value = '';
    document.getElementById('ccContactList').classList.remove('show');
}

function removeRecipient(index) {
    mailRecipients.splice(index, 1);
    renderMailTags();
}

function removeCcRecipient(index) {
    mailCcRecipients.splice(index, 1);
    renderCcTags();
}

function getMailToValue() {
    return mailRecipients.join(', ');
}

function getMailCcValue() {
    return mailCcRecipients.join(', ');
}

function onContactInput() {
    const input = document.getElementById('mailToInput');
    const list = document.getElementById('contactList');
    const val = input.value.toLowerCase().trim();
    if (!val || val.length < 1) { list.classList.remove('show'); return; }
    const matches = contacts.filter(c =>
        !mailRecipients.includes(c.email) &&
        (c.name.toLowerCase().includes(val) || c.email.toLowerCase().includes(val))
    ).slice(0, 10);
    if (!matches.length) { list.classList.remove('show'); return; }
    list.innerHTML = matches.map(c =>
        `<div class="autocomplete-item" onclick="selectContact('${esc(c.email)}')">
            <span class="ac-name">${esc(c.name)}</span>
            <span class="ac-email">${esc(c.email)}</span>
        </div>`
    ).join('');
    list.classList.add('show');
}

function selectContact(email) {
    addRecipient(email);
}

function selectCcContact(email) {
    addCcRecipient(email);
}

function onTagKeydown(e) {
    const input = document.getElementById('mailToInput');
    if ((e.key === 'Enter' || e.key === ',' || e.key === 'Tab') && input.value.trim()) {
        e.preventDefault();
        addRecipient(input.value.replace(/,/g, '').trim());
    }
    if (e.key === 'Backspace' && !input.value && mailRecipients.length) {
        removeRecipient(mailRecipients.length - 1);
    }
}

function onCcContactInput() {
    const input = document.getElementById('mailCcInput');
    const list = document.getElementById('ccContactList');
    const val = input.value.toLowerCase().trim();
    if (!val || val.length < 1) { list.classList.remove('show'); return; }
    const allUsed = [...mailRecipients, ...mailCcRecipients];
    const matches = contacts.filter(c =>
        !allUsed.includes(c.email) &&
        (c.name.toLowerCase().includes(val) || c.email.toLowerCase().includes(val))
    ).slice(0, 10);
    if (!matches.length) { list.classList.remove('show'); return; }
    list.innerHTML = matches.map(c =>
        `<div class="autocomplete-item" onclick="selectCcContact('${esc(c.email)}')">
            <span class="ac-name">${esc(c.name)}</span>
            <span class="ac-email">${esc(c.email)}</span>
        </div>`
    ).join('');
    list.classList.add('show');
}

function onCcTagKeydown(e) {
    const input = document.getElementById('mailCcInput');
    if ((e.key === 'Enter' || e.key === ',' || e.key === 'Tab') && input.value.trim()) {
        e.preventDefault();
        addCcRecipient(input.value.replace(/,/g, '').trim());
    }
    if (e.key === 'Backspace' && !input.value && mailCcRecipients.length) {
        removeCcRecipient(mailCcRecipients.length - 1);
    }
}

// Close autocomplete on outside click
document.addEventListener('click', e => {
    if (!e.target.closest('.autocomplete-wrapper')) {
        const list = document.getElementById('contactList');
        if (list) list.classList.remove('show');
        const ccList = document.getElementById('ccContactList');
        if (ccList) ccList.classList.remove('show');
    }
});

/* ═══════════════════════════════════════════════════════
   Mail Composer Actions
   ═══════════════════════════════════════════════════════ */
async function reformulateMail() {
    const body = document.getElementById('mailBody').value.trim();
    if (!body) { showToast('Écris un message d\'abord.', 'error'); return; }
    if (!state.settings.geminiKey) {
        showToast('Configure ta cle API Gemini dans l\'onglet Rédiger.', 'error', 3000);
        document.getElementById('geminiKeyInput')?.focus();
        return;
    }
    showLoading('L\'IA reformule ton message…');
    try {
        const r = await fetch('/api/reformulate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: state.settings.geminiKey, text: body })
        });
        const result = await r.json();
        if (result.error) {
            showToast('Erreur IA : ' + result.error, 'error', 5000);
        } else if (result.text) {
            document.getElementById('mailBody').value = result.text;
            showToast('Message reformulé !', 'success');
        }
    } catch (e) {
        showToast('Erreur : ' + e.message, 'error', 5000);
    } finally {
        hideLoading();
    }
}

function setReplyComposerContext(context) {
    composerReplyContext = context || null;
    const promptField = document.getElementById('replyPromptField');
    const originalField = document.getElementById('originalMailField');
    const originalBody = document.getElementById('originalMailBody');
    const generateBtn = document.getElementById('generateReplyBtn');
    const promptInput = document.getElementById('replyPromptInput');

    if (composerReplyContext) {
        if (promptField) promptField.style.display = '';
        if (originalField) originalField.style.display = '';
        if (generateBtn) generateBtn.style.display = '';
        if (originalBody) originalBody.value = composerReplyContext.originalText || '';
        if (promptInput && !promptInput.value.trim()) promptInput.value = 'Réponse professionnelle, claire et concise.';
    } else {
        if (promptField) promptField.style.display = 'none';
        if (originalField) originalField.style.display = 'none';
        if (generateBtn) generateBtn.style.display = 'none';
        if (originalBody) originalBody.value = '';
        if (promptInput) promptInput.value = '';
    }
}

function getQuotedOriginalText(context = composerReplyContext) {
    if (!context || !context.originalText) return '';
    return '\n\n--- Le ' + (context.date || '') + ', ' + (context.from || '') + ' a écrit :\n' + context.originalText;
}

function getComposerFinalBodyText() {
    const draft = document.getElementById('mailBody').value.trim();
    if (!composerReplyContext) return draft;
    return (draft + getQuotedOriginalText()).trim();
}

function buildHtmlBodyWithOptionalQuote(bodyText, signatureHtml, quoteText) {
    const escapedBody = String(bodyText || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br>');
    const escapedQuote = String(quoteText || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br>');
    const quoteBlock = escapedQuote
        ? '<blockquote style="margin:1em 0 0.6em;padding:0.7em 0.9em;border-left:3px solid #9ca3af;background:#f7f7f7;color:#374151">' + escapedQuote + '</blockquote>'
        : '';
    return '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>' +
        '<p style="white-space:pre-wrap;font-family:Arial,sans-serif;margin:0 0 1em">' + escapedBody + '</p>' +
        quoteBlock +
        '<hr style="border:none;border-top:1px solid #ccc;margin:1em 0">' +
        signatureHtml +
        '</body></html>';
}

async function generateReplyFromPrompt() {
    if (!composerReplyContext) {
        showToast('Ce mode est disponible uniquement en réponse à un mail.', 'error');
        return;
    }
    if (!state.settings.geminiKey) {
        showToast('Configure ta cle API Gemini dans l\'onglet Rédiger.', 'error', 3000);
        document.getElementById('geminiKeyInput')?.focus();
        return;
    }
    const prompt = (document.getElementById('replyPromptInput')?.value || '').trim();
    if (!prompt) {
        showToast('Ajoute un prompt Gemini pour orienter la réponse.', 'error');
        document.getElementById('replyPromptInput')?.focus();
        return;
    }

    showLoading('Génération de la réponse avec Gemini…');
    try {
        const r = await fetch('/api/generate-reply', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                token: state.settings.geminiKey,
                prompt,
                subject: document.getElementById('mailSubject').value.trim(),
                from: composerReplyContext.from || '',
                original_text: composerReplyContext.originalText || '',
                draft: document.getElementById('mailBody').value.trim()
            })
        });
        const result = await r.json();
        if (result.error) {
            showToast('Erreur IA : ' + result.error, 'error', 5000);
        } else if (result.text) {
            document.getElementById('mailBody').value = result.text.trim();
            showToast('Réponse générée.', 'success');
        }
    } catch (e) {
        showToast('Erreur : ' + e.message, 'error', 5000);
    } finally {
        hideLoading();
    }
}

async function saveMailEml() {
    const from = document.getElementById('mailFrom').value;
    const to = getMailToValue();
    const subject = document.getElementById('mailSubject').value.trim();
    const body = getComposerFinalBodyText();
    if (!to || !subject) { showToast('Remplis le(s) destinataire(s) et le sujet.', 'error'); return; }
    const signatureHtml = getActiveSignatureHtml();
    const html_body = signatureHtml
        ? buildHtmlBodyWithOptionalQuote(document.getElementById('mailBody').value.trim(), signatureHtml, getQuotedOriginalText())
        : null;
    try {
        const r = await fetch('/api/save-eml', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ from, to, subject, body, html_body })
        });
        const result = await r.json();
        if (result.ok) {
            showToast('Fichier .eml enregistré dans Téléchargements !', 'success', 3000);
        } else {
            showToast('Erreur : ' + (result.error || 'Échec'), 'error', 5000);
        }
    } catch (e) {
        showToast('Erreur : ' + e.message, 'error', 5000);
    }
}

/* openInThunderbird removed — all sending goes through SMTP */

/* ═══════════════════════════════════════════════════════
   HTML Signatures
   ═══════════════════════════════════════════════════════ */
let editingSignatureId = null;

function openSignatureModal(id = null) {
    editingSignatureId = id || null;
    const sig = id ? (state.settings.signatures || []).find(s => s.id === id) : null;
    document.getElementById('signatureModalTitle').innerHTML =
        id ? '<i class="icon-pen-line"></i> Modifier la signature' : '<i class="icon-pen-line"></i> Nouvelle signature';
    document.getElementById('signatureNameInput').value = sig ? sig.name : '';
    document.getElementById('signatureHtmlInput').value = sig ? sig.html : '';
    updateSignatureEditPreview();
    document.getElementById('signatureModal').classList.add('show');
}

function closeSignatureModal() {
    document.getElementById('signatureModal').classList.remove('show');
    editingSignatureId = null;
}

function updateSignatureEditPreview() {
    const html = document.getElementById('signatureHtmlInput').value;
    document.getElementById('signatureEditPreview').innerHTML = html;
}

function saveSignatureFromModal() {
    const name = document.getElementById('signatureNameInput').value.trim();
    const html = document.getElementById('signatureHtmlInput').value.trim();
    if (!name) { showToast('Donne un nom à ta signature.', 'error'); return; }
    if (!html) { showToast('Le contenu HTML est vide.', 'error'); return; }
    if (!state.settings.signatures) state.settings.signatures = [];
    if (editingSignatureId) {
        const idx = state.settings.signatures.findIndex(s => s.id === editingSignatureId);
        if (idx >= 0) state.settings.signatures[idx] = { id: editingSignatureId, name, html };
    } else {
        state.settings.signatures.push({ id: uid(), name, html });
    }
    autoSave();
    closeSignatureModal();
    renderSignaturesList();
    updateSignatureSelectors();
    showToast('Signature enregistrée.', 'success');
}

function deleteSignature(id) {
    if (!state.settings.signatures) return;
    state.settings.signatures = state.settings.signatures.filter(s => s.id !== id);
    autoSave();
    renderSignaturesList();
    updateSignatureSelectors();
    showToast('Signature supprimée.', 'success');
}

function renderSignaturesList() {
    const el = document.getElementById('signaturesList');
    if (!el) return;
    const sigs = state.settings.signatures || [];
    if (!sigs.length) {
        el.innerHTML = '<p style="color:var(--text-muted);font-size:0.82rem;margin:0.3rem 0">Aucune signature configurée.</p>';
        return;
    }
    el.innerHTML = sigs.map(s =>
        `<div style="display:flex;align-items:center;justify-content:space-between;gap:0.5rem;padding:0.4rem 0;border-bottom:1px solid var(--card-border)">` +
        `<span style="font-size:0.88rem">${esc(s.name)}</span>` +
        `<div style="display:flex;gap:0.4rem">` +
        `<button onclick="openSignatureModal('${s.id}')" style="padding:0.2rem 0.5rem;font-size:0.75rem"><i class="icon-pencil"></i></button>` +
        `<button onclick="deleteSignature('${s.id}')" style="padding:0.2rem 0.5rem;font-size:0.75rem;background:var(--accent-red)!important;border-color:var(--accent-red)!important;color:white!important"><i class="icon-trash-2"></i></button>` +
        `</div></div>`
    ).join('');
}

function updateSignatureSelectors() {
    const sigs = state.settings.signatures || [];
    document.querySelectorAll('.signature-select').forEach(sel => {
        const current = sel.value;
        sel.innerHTML = '<option value="">-- Aucune signature --</option>' +
            sigs.map(s => `<option value="${s.id}"${s.id === current ? ' selected' : ''}>${esc(s.name)}</option>`).join('');
    });
    onSignatureChange();
}

function onSignatureChange() {
    const sel = document.getElementById('mailSignatureSelect');
    const preview = document.getElementById('signaturePreview');
    const field = document.getElementById('signaturePreviewField');
    if (!sel || !preview || !field) return;
    const sig = sel.value ? (state.settings.signatures || []).find(s => s.id === sel.value) : null;
    if (sig) {
        preview.innerHTML = sig.html;
        field.style.display = '';
    } else {
        preview.innerHTML = '';
        field.style.display = 'none';
    }
}

function getActiveSignatureHtml() {
    const sel = document.getElementById('mailSignatureSelect');
    if (!sel || !sel.value) return null;
    const sig = (state.settings.signatures || []).find(s => s.id === sel.value);
    return sig ? sig.html : null;
}

function buildHtmlBody(bodyText, signatureHtml) {
    const escaped = bodyText
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br>');
    return '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>' +
        '<p style="white-space:pre-wrap;font-family:Arial,sans-serif;margin:0 0 1em">' + escaped + '</p>' +
        '<hr style="border:none;border-top:1px solid #ccc;margin:1em 0">' +
        signatureHtml +
        '</body></html>';
}

/* ═══════════════════════════════════════════════════════
   Run mail_to_md.py
   ═══════════════════════════════════════════════════════ */
async function runV3() {
    const outEl = document.getElementById('v3output');
    outEl.style.display = 'block';
    outEl.textContent = '⏳ Exécution de mail_to_md.py en cours…\n';
    try {
        const r = await fetch('/api/run-mail-to-md', { method: 'POST' });
        const result = await r.json();
        if (result.ok) {
            outEl.textContent = result.output || 'Terminé (aucune sortie)';
            await loadInbox();
            showToast('mail_to_md.py exécuté avec succès !', 'success');
        } else {
            outEl.textContent = 'Erreur :\n' + (result.error || result.output || 'Erreur inconnue');
            showToast('Erreur mail_to_md.py', 'error', 3000);
        }
    } catch (e) {
        outEl.textContent = 'Erreur réseau : ' + e.message;
        showToast('Erreur : ' + e.message, 'error', 5000);
    }
}

/* ═══════════════════════════════════════════════════════
   Mail Tab — Helpers
   ═══════════════════════════════════════════════════════ */
function getAllMailTasks() {
    const mails = [];
    state.sections.forEach(s => {
        s.tasks.forEach(t => {
            if (t.type === 'mail' || t.isMail) {
                mails.push({ ...t, sectionId: s.id, sectionTitle: s.title, sectionEmoji: s.emoji });
            }
        });
    });
    return mails;
}

function getMailTaskStatus(t) {
    if (t.respondedAt) return 'responded';
    if (t.sentAt) {
        const hasActiveReminder = (state.reminders || []).some(r =>
            r.taskId === t.id && r.status === 'pending'
        );
        return hasActiveReminder ? 'waiting' : 'sent';
    }
    return 'pending';
}

function getMailStatusLabel(status) {
    switch(status) {
        case 'pending': return 'À envoyer';
        case 'sent': return 'Envoyé';
        case 'waiting': return 'En attente';
        case 'responded': return 'Répondu';
        default: return '';
    }
}

/* ═══════════════════════════════════════════════════════
   Mail Tab — Main Render
   ═══════════════════════════════════════════════════════ */
function renderMailTab() {
    renderMailList();
    updateMailComposerState();
    updateMailBadge();
}

function renderMailList() {
    const container = document.getElementById('mail-pending-list');
    if (!container) return;
    const mails = getAllMailTasks();

    if (!mails.length) {
        container.innerHTML = `
            <h2><i class="icon-mail"></i> Mails à traiter</h2>
            <div class="mail-pending-empty">
                Aucun mail à traiter. Crée un mail depuis l'onglet Todo<br>(mode édition → <strong><i class="icon-mail"></i> + Mail</strong>).
            </div>`;
        return;
    }

    const pending = mails.filter(m => !m.sentAt && !m.respondedAt);
    const waiting = mails.filter(m => m.sentAt && !m.respondedAt);
    const responded = mails.filter(m => m.respondedAt);

    let html = '<h2><i class="icon-mail"></i> Mails à traiter</h2>';
    if (pending.length) html += renderMailGroup('À envoyer', pending);
    if (waiting.length) html += renderMailGroup('En attente de réponse', waiting);
    if (responded.length) html += renderMailGroup('Terminés', responded);

    container.innerHTML = html;
}

function renderMailGroup(title, mails) {
    let html = `<div class="mail-group-label">${esc(title)}</div>`;
    html += mails.map(m => {
        const status = getMailTaskStatus(m);
        const statusLabel = getMailStatusLabel(status);
        const isSelected = selectedMailTask && selectedMailTask.tid === m.id;
        
        // Check if mail is over 3 days old
        const isOverThreeDays = m.sentAt && !m.respondedAt && (Date.now() - m.sentAt) > 3 * 24 * 60 * 60 * 1000;
        
        const cls = ['mail-item', isSelected ? 'selected' : '', m.sentAt ? 'is-sent' : '', isOverThreeDays ? 'awaiting-response-over-3days' : ''].filter(Boolean).join(' ');
        const checkDone = m.sentAt ? 'done' : '';

        let actionsHtml = '';
        if (status === 'sent' || status === 'waiting') {
            actionsHtml += `<button onclick="event.stopPropagation();markResponseReceived('${m.sectionId}','${m.id}')" title="Réponse reçue"><i class="icon-check"></i></button>`;
        }

        return `
        <div class="${cls}" onclick="selectMailForCompose('${m.sectionId}','${m.id}')">
            <div class="mail-item-check ${checkDone}" onclick="event.stopPropagation();toggleMailSentFromList('${m.sectionId}','${m.id}')">
                <svg viewBox="0 0 24 24"><polyline points="4 12 10 18 20 6"/></svg>
            </div>
            <div class="mail-item-info">
                <div class="mail-item-label">${m.sectionEmoji} ${esc(m.label || 'Sans titre')}</div>
                <div class="mail-item-section">${esc(m.sectionTitle)}${m.mailTo ? ' → ' + esc(m.mailTo) : ''}</div>
            </div>
            <span class="mail-item-status ${status}">${statusLabel}</span>
            <div class="mail-item-actions">${actionsHtml}</div>
        </div>`;
    }).join('');
    return html;
}

/* ═══════════════════════════════════════════════════════
   Mail Tab — Composer Integration
   ═══════════════════════════════════════════════════════ */
function selectMailForCompose(sid, tid) {
    const s = state.sections.find(x => x.id === sid);
    if (!s) return;
    const t = s.tasks.find(x => x.id === tid);
    if (!t) return;

    selectedMailTask = { sid, tid };
    setReplyComposerContext(null);

    mailRecipients = t.mailTo ? t.mailTo.split(',').map(e => e.trim()).filter(Boolean) : [];
    renderMailTags();
    document.getElementById('mailSubject').value = t.mailSubject || t.label || '';
    document.getElementById('mailBody').value = t.mailBody || '';
    if (t.mailFrom) {
        const sel = document.getElementById('mailFrom');
        for (let i = 0; i < sel.options.length; i++) {
            if (sel.options[i].value === t.mailFrom) { sel.selectedIndex = i; break; }
        }
    }

    updateMailComposerState();
    renderMailList();
    document.getElementById('mailComposer').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function deselectMailTask() {
    selectedMailTask = null;
    setReplyComposerContext(null);
    mailRecipients = [];
    mailCcRecipients = [];
    renderMailTags();
    renderCcTags();
    document.getElementById('mailSubject').value = '';
    document.getElementById('mailBody').value = '';
    updateMailComposerState();
    renderMailList();
}

function updateMailComposerState() {
    const composer = document.getElementById('mailComposer');
    const banner = document.getElementById('selectedTaskBanner');
    const sentActions = document.getElementById('mailSentActions');
    if (!composer || !banner) return;

    if (selectedMailTask) {
        const s = state.sections.find(x => x.id === selectedMailTask.sid);
        const t = s ? s.tasks.find(x => x.id === selectedMailTask.tid) : null;
        if (t) {
            composer.classList.add('has-selection');
            const status = getMailTaskStatus(t);
            banner.innerHTML = `
                <div class="selected-task-banner">
                    <span><i class="icon-mail"></i> <strong>${esc(t.label || 'Sans titre')}</strong></span>
                    ${status !== 'pending' ? `<span class="mail-item-status ${status}" style="margin-left:0.5rem">${getMailStatusLabel(status)}</span>` : ''}
                    <button class="deselect-btn" onclick="deselectMailTask()">✕</button>
                </div>`;
            if (sentActions) {
                if (!t.sentAt) {
                    sentActions.style.display = '';
                    sentActions.innerHTML = `<button class="btn-sent-confirm" onclick="markCurrentMailSent()"><i class="icon-check"></i> Marquer comme envoyé</button>`;
                } else if (!t.respondedAt) {
                    sentActions.style.display = '';
                    sentActions.innerHTML = `<button class="btn-response-received" onclick="markCurrentResponseReceived()"><i class="icon-mail-check"></i> Réponse reçue</button>`;
                } else {
                    sentActions.style.display = 'none';
                }
            }
            return;
        }
    }

    composer.classList.remove('has-selection');
    banner.innerHTML = '';
    if (sentActions) sentActions.style.display = 'none';
}

function saveMailFieldsToTask() {
    if (!selectedMailTask) return;
    const s = state.sections.find(x => x.id === selectedMailTask.sid);
    if (!s) return;
    const t = s.tasks.find(x => x.id === selectedMailTask.tid);
    if (!t) return;
    t.mailTo = getMailToValue();
    t.mailFrom = document.getElementById('mailFrom').value;
    t.mailSubject = document.getElementById('mailSubject').value.trim();
    t.mailBody = document.getElementById('mailBody').value.trim();
    if (!t.label && t.mailSubject) t.label = t.mailSubject;
    autoSave();
}

function markCurrentMailSent() {
    if (!selectedMailTask) return;
    saveMailFieldsToTask();
    markMailTaskSent(selectedMailTask.sid, selectedMailTask.tid);
    autoSave();
    renderMailTab();
    render();
    showToast('Mail marqué comme envoyé ! Rappel dans 3 jours.', 'success', 3000);
}

function markCurrentResponseReceived() {
    if (!selectedMailTask) return;
    markResponseReceived(selectedMailTask.sid, selectedMailTask.tid);
}

/* ═══════════════════════════════════════════════════════
   Mail Sent / Response Tracking
   ═══════════════════════════════════════════════════════ */
function markMailTaskSent(sid, tid) {
    const s = state.sections.find(x => x.id === sid);
    if (!s) return;
    const t = s.tasks.find(x => x.id === tid);
    if (!t || t.sentAt) return;

    const now = Date.now();
    t.sentAt = now;
    t.done = true;

    state.mailEvents = state.mailEvents || [];
    state.mailEvents.push({
        id: uid(), taskId: tid, sectionId: sid,
        type: 'sent', date: now,
        label: t.mailSubject || t.label, to: t.mailTo
    });

    state.reminders = state.reminders || [];
    state.reminders.push({
        id: uid(), taskId: tid, sectionId: sid,
        label: t.mailSubject || t.label,
        mailTo: t.mailTo || '', mailSubject: t.mailSubject || t.label,
        mailBody: t.mailBody || '', mailFrom: t.mailFrom || '',
        createdAt: now,
        remindAt: now + 3 * 24 * 60 * 60 * 1000,
        cycle: 1, status: 'pending'
    });
}

function unmarkMailTaskSent(sid, tid) {
    const s = state.sections.find(x => x.id === sid);
    if (!s) return;
    const t = s.tasks.find(x => x.id === tid);
    if (!t) return;
    t.sentAt = null;
    t.respondedAt = null;
    state.mailEvents = (state.mailEvents || []).filter(e => e.taskId !== tid);
    state.reminders = (state.reminders || []).filter(r => r.taskId !== tid || r.status === 'sent');
}

function markResponseReceived(sid, tid) {
    const s = state.sections.find(x => x.id === sid);
    if (!s) return;
    const t = s.tasks.find(x => x.id === tid);
    if (!t) return;

    const now = Date.now();
    t.respondedAt = now;

    state.mailEvents = state.mailEvents || [];
    state.mailEvents.push({
        id: uid(), taskId: tid, sectionId: sid,
        type: 'response', date: now, label: t.mailSubject || t.label
    });

    (state.reminders || []).forEach(r => {
        if (r.taskId === tid && r.status === 'pending') r.status = 'responded';
    });

    autoSave();
    if (currentTab === 'mail') renderMailTab();
    showToast('Réponse reçue ! Rappels annulés.', 'success');
}

function toggleMailSentFromList(sid, tid) {
    const s = state.sections.find(x => x.id === sid);
    if (!s) return;
    const t = s.tasks.find(x => x.id === tid);
    if (!t) return;

    if (!t.sentAt) {
        if (!t.mailSubject && !t.label) {
            selectMailForCompose(sid, tid);
            showToast('Remplis d\'abord les détails du mail.', 'error');
            return;
        }
        markMailTaskSent(sid, tid);
        showToast('Mail marqué comme envoyé !', 'success');
    } else {
        unmarkMailTaskSent(sid, tid);
        t.done = false;
        showToast('Envoi annulé.', 'success');
    }

    autoSave();
    render();
    renderMailTab();
}

/* ═══════════════════════════════════════════════════════
   Timeline
   ═══════════════════════════════════════════════════════ */
function renderTimeline() {
    const container = document.getElementById('timeline-container');
    if (!container) return;

    const now = new Date();
    const year = timelineMonth.getFullYear();
    const month = timelineMonth.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const monthName = timelineMonth.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });

    const events = getTimelineEvents(year, month);

    let html = `
        <div class="timeline-header">
            <h2><i class="icon-calendar"></i> ${esc(monthName.charAt(0).toUpperCase() + monthName.slice(1))}</h2>
            <div class="timeline-nav">
                <button onclick="navigateTimeline(-1)">◀</button>
                <button onclick="navigateTimeline(0)">Aujourd'hui</button>
                <button onclick="navigateTimeline(1)">▶</button>
            </div>
        </div>
        <div class="timeline-scroll">
            <div class="timeline-track">
                <div class="timeline-line"></div>`;

    for (let d = 1; d <= daysInMonth; d++) {
        const date = new Date(year, month, d);
        const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        const isToday = (d === now.getDate() && month === now.getMonth() && year === now.getFullYear());
        const dayEvents = events.filter(e => e.dateStr === dateStr);
        const dayName = date.toLocaleDateString('fr-FR', { weekday: 'short' }).slice(0, 2);

        const colClass = isToday ? 'timeline-day timeline-today-col' : 'timeline-day';
        html += `<div class="${colClass}" data-date="${dateStr}">`;
        html += `<div class="timeline-day-label">${dayName}<br>${d}</div>`;

        if (dayEvents.length > 0) {
            const order = { 'reminder-due': 0, 'sent': 1, 'reminder-sent': 2, 'reminder-pending': 3, 'response': 4 };
            const sorted = [...dayEvents].sort((a, b) => (order[a.dotClass] || 5) - (order[b.dotClass] || 5));
            const primary = sorted[0];
            html += `<div class="timeline-dot ${primary.dotClass}"
                onclick="showTimelinePopover(event, '${dateStr}')"
                title="${esc(primary.tooltip)}"></div>`;
            html += `<div class="timeline-event-label">${dayEvents.length > 1 ? dayEvents.length + ' évén.' : esc(primary.shortLabel)}</div>`;
        } else if (isToday) {
            html += `<div class="timeline-dot today-marker"></div>`;
            html += `<div class="timeline-event-label">Auj.</div>`;
        } else {
            html += `<div class="timeline-dot empty"></div>`;
        }

        html += '</div>';
    }

    html += `</div></div>`;
    container.innerHTML = html;

    if (month === now.getMonth() && year === now.getFullYear()) {
        const todayCol = container.querySelector('.timeline-today-col');
        if (todayCol) {
            const scroll = container.querySelector('.timeline-scroll');
            scroll.scrollLeft = todayCol.offsetLeft - scroll.clientWidth / 2;
        }
    }
}

function getTimelineEvents(year, month) {
    const events = [];
    const now = Date.now();
    const monthStart = new Date(year, month, 1).getTime();
    const monthEnd = new Date(year, month + 1, 0, 23, 59, 59).getTime();

    (state.mailEvents || []).forEach(e => {
        if (e.date >= monthStart && e.date <= monthEnd) {
            const d = new Date(e.date);
            const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
            let dotClass, tooltip, shortLabel;
            switch (e.type) {
                case 'sent':
                    dotClass = 'sent'; tooltip = `Envoyé : ${e.label}`; shortLabel = e.label || 'Mail'; break;
                case 'reminder_sent':
                    dotClass = 'reminder-sent'; tooltip = `Relance #${e.cycle || '?'} : ${e.label}`; shortLabel = `Relance #${e.cycle || '?'}`; break;
                case 'response':
                    dotClass = 'response'; tooltip = `Réponse : ${e.label}`; shortLabel = 'Réponse'; break;
                default: return;
            }
            events.push({ ...e, dateStr, dotClass, tooltip, shortLabel });
        }
    });

    (state.reminders || []).forEach(r => {
        if (r.status === 'dismissed' || r.status === 'responded' || r.status === 'sent') return;
        if (r.remindAt >= monthStart && r.remindAt <= monthEnd) {
            const d = new Date(r.remindAt);
            const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
            const isDue = r.remindAt <= now;
            const dotClass = isDue ? 'reminder-due' : 'reminder-pending';
            const tooltip = isDue ? `⚠ Rappel dû : ${r.label}` : `Rappel prévu : ${r.label}`;
            const shortLabel = isDue ? '⚠ Rappel' : `J+${r.cycle * 3}`;
            events.push({ ...r, dateStr, dotClass, tooltip, shortLabel, isReminder: true, reminderId: r.id });
        }
    });

    return events;
}

function navigateTimeline(direction) {
    if (direction === 0) {
        timelineMonth = new Date();
    } else {
        timelineMonth = new Date(timelineMonth.getFullYear(), timelineMonth.getMonth() + direction, 1);
    }
    renderTimeline();
}

function showTimelinePopover(evt, dateStr) {
    document.querySelectorAll('.timeline-popover').forEach(p => p.remove());

    const year = timelineMonth.getFullYear();
    const month = timelineMonth.getMonth();
    const dayEvents = getTimelineEvents(year, month).filter(e => e.dateStr === dateStr);
    if (!dayEvents.length) return;

    const dot = evt.target;
    const popover = document.createElement('div');
    popover.className = 'timeline-popover show';

    let html = '';
    dayEvents.forEach(e => {
        html += `<div style="margin-bottom:0.5rem;">`;
        html += `<div class="timeline-popover-title">${esc(e.tooltip)}</div>`;
        html += `<div class="timeline-popover-actions">`;

        if (e.isReminder && e.dotClass === 'reminder-due') {
            html += `<button onclick="handleDueReminder('${e.reminderId}')"><i class="icon-sparkles"></i> Générer relance IA</button>`;
            html += `<button onclick="markReminderResponseReceived('${e.reminderId}')"><i class="icon-check"></i> Réponse reçue</button>`;
            html += `<button onclick="editReminderDate('${e.reminderId}')"><i class="icon-calendar"></i> Modifier la date</button>`;
            html += `<button class="danger" onclick="dismissReminderFromTimeline('${e.reminderId}')"><i class="icon-trash-2"></i> Supprimer</button>`;
        } else if (e.isReminder && e.dotClass === 'reminder-pending') {
            html += `<button onclick="handleDueReminder('${e.reminderId}')"><i class="icon-sparkles"></i> Traiter maintenant</button>`;
            html += `<button onclick="markReminderResponseReceived('${e.reminderId}')"><i class="icon-check"></i> Réponse reçue</button>`;
            html += `<button onclick="editReminderDate('${e.reminderId}')"><i class="icon-calendar"></i> Modifier la date</button>`;
            html += `<button class="danger" onclick="dismissReminderFromTimeline('${e.reminderId}')"><i class="icon-trash-2"></i> Supprimer</button>`;
        } else if (e.type === 'sent' || e.type === 'reminder_sent') {
            html += `<button onclick="selectMailForCompose('${e.sectionId}','${e.taskId}')"><i class="icon-mail"></i> Voir le mail</button>`;
        }

        html += `</div></div>`;
    });

    popover.innerHTML = html;
    dot.parentElement.style.position = 'relative';
    dot.parentElement.appendChild(popover);

    const scroll = dot.closest('.timeline-scroll');
    if (scroll) {
        const margin = 10;
        let popRect = popover.getBoundingClientRect();
        const scrollRect = scroll.getBoundingClientRect();

        // If the popover is clipped at the top, render it below the dot instead.
        if (popRect.top < scrollRect.top + margin) {
            popover.classList.add('below');
            popRect = popover.getBoundingClientRect();
        }

        // Keep the popover fully visible vertically within the timeline viewport.
        if (popRect.bottom > scrollRect.bottom - margin) {
            scroll.scrollTop += popRect.bottom - (scrollRect.bottom - margin);
            popRect = popover.getBoundingClientRect();
        }
        if (popRect.top < scrollRect.top + margin) {
            scroll.scrollTop -= (scrollRect.top + margin) - popRect.top;
            popRect = popover.getBoundingClientRect();
        }

        // Keep the popover visible horizontally as well.
        if (popRect.right > scrollRect.right - margin) {
            scroll.scrollLeft += popRect.right - (scrollRect.right - margin);
            popRect = popover.getBoundingClientRect();
        }
        if (popRect.left < scrollRect.left + margin) {
            scroll.scrollLeft -= (scrollRect.left + margin) - popRect.left;
        }
    }

    setTimeout(() => {
        const close = (ev) => {
            if (!popover.contains(ev.target) && ev.target !== dot) {
                popover.remove();
                document.removeEventListener('click', close);
            }
        };
        document.addEventListener('click', close);
    }, 10);
}

/* ═══════════════════════════════════════════════════════
   Reminder Workflow (cycles)
   ═══════════════════════════════════════════════════════ */
async function handleDueReminder(rid) {
    const r = (state.reminders || []).find(x => x.id === rid);
    if (!r) return;

    document.querySelectorAll('.timeline-popover').forEach(p => p.remove());

    if (!state.settings.geminiKey) {
        showToast('Configure ta clé API Gemini dans les paramètres', 'error', 3000);
        openSettings();
        return;
    }

    showLoading('L\'IA génère une relance…');
    try {
        const res = await fetch('/api/generate-reminder', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                token: state.settings.geminiKey,
                to: r.mailTo,
                subject: r.mailSubject || r.label,
                body: r.mailBody || r.label,
                cycle: r.cycle
            })
        });
        const result = await res.json();
        if (result.ok && result.reminder) {
            currentReminder = { rid, ...result.reminder, to: r.mailTo, from: r.mailFrom };
            document.getElementById('reminderTo').value = r.mailTo || '';
            document.getElementById('reminderSubject').value = result.reminder.subject || '';
            document.getElementById('reminderBody').value = result.reminder.body || '';
            document.getElementById('reminderModal').classList.add('show');
            showToast('Relance générée !', 'success');
        } else {
            showToast('Erreur IA : ' + (result.error || 'Échec'), 'error', 5000);
        }
    } catch (e) {
        showToast('Erreur : ' + e.message, 'error', 5000);
    } finally {
        hideLoading();
    }
}

function markReminderSent(rid) {
    const r = (state.reminders || []).find(x => x.id === rid);
    if (!r) return;

    const now = Date.now();
    r.status = 'sent';
    r.sentAt = now;

    state.mailEvents = state.mailEvents || [];
    state.mailEvents.push({
        id: uid(), taskId: r.taskId, sectionId: r.sectionId,
        type: 'reminder_sent', date: now,
        label: r.mailSubject || r.label, to: r.mailTo, cycle: r.cycle
    });

    state.reminders.push({
        id: uid(), taskId: r.taskId, sectionId: r.sectionId,
        label: r.label, mailTo: r.mailTo,
        mailSubject: r.mailSubject, mailBody: r.mailBody, mailFrom: r.mailFrom || '',
        createdAt: now,
        remindAt: now + 3 * 24 * 60 * 60 * 1000,
        cycle: r.cycle + 1, status: 'pending'
    });

    autoSave();
    renderMailTab();
}

function confirmReminderSent() {
    if (!currentReminder) return;
    markReminderSent(currentReminder.rid);
    closeReminderModal();
    showToast('Rappel envoyé. Prochain cycle dans 3 jours.', 'success', 3000);
}

function confirmReminderResponseReceived() {
    if (!currentReminder) return;
    markReminderResponseReceived(currentReminder.rid);
    closeReminderModal();
}

function markReminderResponseReceived(rid) {
    const r = (state.reminders || []).find(x => x.id === rid);
    if (!r) return;
    document.querySelectorAll('.timeline-popover').forEach(p => p.remove());
    markResponseReceived(r.sectionId, r.taskId);
}

function dismissReminderFromTimeline(rid) {
    const r = (state.reminders || []).find(x => x.id === rid);
    if (!r) return;
    document.querySelectorAll('.timeline-popover').forEach(p => p.remove());
    r.status = 'dismissed';
    autoSave();
    renderMailTab();
    showToast('Rappel supprimé.', 'success');
}

function editReminderDate(rid) {
    const r = (state.reminders || []).find(x => x.id === rid);
    if (!r) return;
    document.querySelectorAll('.timeline-popover').forEach(p => p.remove());

    const currentDate = new Date(r.remindAt);
    const dateStr = `${currentDate.getFullYear()}-${String(currentDate.getMonth()+1).padStart(2,'0')}-${String(currentDate.getDate()).padStart(2,'0')}`;
    const newDateStr = prompt('Nouvelle date du rappel (AAAA-MM-JJ) :', dateStr);
    if (!newDateStr) return;

    const parsed = new Date(newDateStr + 'T09:00:00');
    if (isNaN(parsed.getTime())) {
        showToast('Date invalide.', 'error');
        return;
    }

    r.remindAt = parsed.getTime();
    autoSave();
    renderTimeline();
    showToast('Date du rappel modifiée.', 'success');
}

function closeReminderModal() {
    document.getElementById('reminderModal').classList.remove('show');
    currentReminder = null;
}

async function reformulateReminder() {
    const body = document.getElementById('reminderBody').value.trim();
    if (!body) { showToast('Écris un message d\'abord.', 'error'); return; }
    if (!state.settings.geminiKey) {
        showToast('Configure ta clé API Gemini dans les paramètres', 'error', 3000);
        return;
    }
    showLoading('L\'IA reformule la relance…');
    try {
        const r = await fetch('/api/reformulate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: state.settings.geminiKey, text: body })
        });
        const result = await r.json();
        if (result.text) {
            document.getElementById('reminderBody').value = result.text;
            showToast('Relance reformulée !', 'success');
        } else {
            showToast('Erreur IA : ' + (result.error || 'Échec'), 'error', 5000);
        }
    } catch (e) {
        showToast('Erreur : ' + e.message, 'error', 5000);
    } finally {
        hideLoading();
    }
}

async function saveReminderEml() {
    const to = document.getElementById('reminderTo').value.trim();
    const subject = document.getElementById('reminderSubject').value.trim();
    const body = document.getElementById('reminderBody').value.trim();
    if (!subject) { showToast('Sujet requis', 'error'); return; }
    try {
        const r = await fetch('/api/save-eml', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ to, subject, body })
        });
        const result = await r.json();
        if (result.ok) {
            showToast('Relance enregistrée (.eml) !', 'success', 3000);
        } else {
            showToast('Erreur : ' + (result.error || 'Échec'), 'error', 5000);
        }
    } catch (e) {
        showToast('Erreur : ' + e.message, 'error', 5000);
    }
}

async function sendReminderSMTP() {
    const to = document.getElementById('reminderTo').value.trim();
    const subject = document.getElementById('reminderSubject').value.trim();
    const body = document.getElementById('reminderBody').value.trim();
    const from = currentReminder?.from || document.getElementById('mailFrom').value;
    if (!subject || !to) { showToast('Destinataire et sujet requis', 'error'); return; }
    showLoading('Envoi de la relance via SMTP…');
    try {
        const r = await fetch('/api/send-email', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ from, to, subject, body })
        });
        const result = await r.json();
        if (result.ok) {
            showToast('Relance envoyée !', 'success');
            if (currentReminder) {
                markReminderSent(currentReminder.rid);
                closeReminderModal();
            }
        } else {
            showToast('Erreur : ' + (result.error || 'Échec'), 'error', 5000);
        }
    } catch (e) {
        showToast('Erreur : ' + e.message, 'error', 5000);
    } finally {
        hideLoading();
    }
}

function updateMailBadge() {
    const now = Date.now();
    const pending = getAllMailTasks().filter(m => !m.sentAt);
    const dueReminders = (state.reminders || []).filter(r => r.status === 'pending' && r.remindAt <= now);
    const total = pending.length + dueReminders.length;
    const tabBtn = document.querySelector('.tab-btn[data-tab="mail"]');
    if (tabBtn) {
        tabBtn.innerHTML = total > 0
            ? `<i class="icon-send"></i> Rédiger <span style="font-size:0.7em;color:var(--accent-orange)">● ${total}</span>`
            : '<i class="icon-send"></i> Rédiger';
    }
}

/* ═══════════════════════════════════════════════════════
   Toast & Loading
   ═══════════════════════════════════════════════════════ */
let toastTimer;
function showToast(msg, type = 'success', duration = 2000) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast show ' + type;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.className = 'toast', duration);
}

function showLoading(msg) {
    document.getElementById('loadingText').textContent = msg || 'Chargement…';
    document.getElementById('loading').classList.add('show');
}
function hideLoading() {
    document.getElementById('loading').classList.remove('show');
}

/* ═══════════════════════════════════════════════════════
   Confetti
   ═══════════════════════════════════════════════════════ */
function launchConfetti() {
    const canvas = document.getElementById('confetti');
    const ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const particles = [];
    const colors = ['#6c8aff','#34d399','#f59e0b','#a78bfa','#f472b6','#fff'];
    for (let i = 0; i < 150; i++) {
        particles.push({
            x: Math.random() * canvas.width,
            y: Math.random() * canvas.height - canvas.height,
            r: Math.random() * 6 + 2,
            color: colors[Math.floor(Math.random() * colors.length)],
            tilt: Math.random() * 10 - 5,
            speed: Math.random() * 3 + 2,
            opacity: 1,
        });
    }
    let frame = 0;
    function draw() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        let alive = false;
        particles.forEach(p => {
            if (p.opacity <= 0) return;
            alive = true;
            p.y += p.speed;
            p.tilt += 0.05;
            p.opacity -= 0.005;
            ctx.globalAlpha = Math.max(0, p.opacity);
            ctx.fillStyle = p.color;
            ctx.beginPath();
            ctx.ellipse(p.x + Math.sin(p.tilt) * 15, p.y, p.r, p.r * 0.6, p.tilt, 0, Math.PI * 2);
            ctx.fill();
        });
        ctx.globalAlpha = 1;
        if (alive && frame < 300) { frame++; requestAnimationFrame(draw); }
        else ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    draw();
}

/* ═══════════════════════════════════════════════════════
   Inbox — State
   ═══════════════════════════════════════════════════════ */
let inboxMails = [];
let selectedInboxId = null;
let inboxFilter = 'all';
let deleteMailTarget = null;
let inboxFolder = 'inbox'; // 'inbox' or 'sent'

/* ═══════════════════════════════════════════════════════
   Inbox — Load & Render
   ═══════════════════════════════════════════════════════ */
async function loadInbox() {
    try {
        const endpoint = inboxFolder === 'sent' ? '/api/inbox/sent' : '/api/inbox';
        const r = await fetch(endpoint);
        if (r.ok) inboxMails = await r.json();
    } catch {}
    renderInboxList();
    updateInboxBadge();
}

function toggleInboxFolder() {
    inboxFolder = inboxFolder === 'inbox' ? 'sent' : 'inbox';
    const btn = document.getElementById('inboxFolderBtn');
    if (btn) {
        btn.innerHTML = inboxFolder === 'sent'
            ? '<i class="icon-send"></i> Envoyés'
            : '<i class="icon-inbox"></i> Reçus';
    }
    selectedInboxId = null;
    document.getElementById('inboxReader').innerHTML = `
        <div class="inbox-reader-empty">
            <i class="icon-mail-open" style="font-size:2.5rem;color:var(--text-muted)"></i>
            <p>Sélectionne un mail pour le lire</p>
        </div>`;
    loadInbox();
}

function filterInbox() {
    renderInboxList();
}

function setInboxFilter(filter, btn) {
    inboxFilter = filter;
    document.querySelectorAll('.inbox-filter-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    renderInboxList();
}

function getFilteredInbox() {
    const query = (document.getElementById('inboxSearch')?.value || '').toLowerCase().trim();
    let mails = [...inboxMails];

    if (inboxFilter === 'unread') mails = mails.filter(m => !m.read);
    if (inboxFilter === 'starred') mails = mails.filter(m => m.starred);

    if (query) {
        mails = mails.filter(m =>
            (m.subject || '').toLowerCase().includes(query) ||
            (m.from_name || '').toLowerCase().includes(query) ||
            (m.from_email || '').toLowerCase().includes(query) ||
            (m.body || '').toLowerCase().includes(query)
        );
    }

    return mails;
}

function renderInboxList() {
    const container = document.getElementById('inboxList');
    if (!container) return;

    const mails = getFilteredInbox();

    if (!mails.length) {
        container.innerHTML = `<div style="padding:2rem;text-align:center;color:var(--text-muted)">
            ${inboxMails.length ? 'Aucun résultat' : 'Boîte de réception vide. Clique sur Relever pour récupérer le courrier.'}
        </div>`;
        return;
    }

    container.innerHTML = mails.map(m => {
        const isSelected = selectedInboxId === m.id;
        const unread = !m.read ? 'unread' : '';
        const isSent = m.folder === 'sent';
        const fromDisplay = isSent ? ('→ ' + (m.to || '').split(',')[0].trim()) : (m.from_name || m.from_email || 'Inconnu');
        const preview = (m.body || '').substring(0, 80).replace(/\n/g, ' ');
        const hasAttach = m.attachments && m.attachments.length > 0;

        return `
        <div class="inbox-item ${unread} ${isSelected ? 'selected' : ''}" onclick="openInboxMail('${esc(m.id)}')">
            <div class="inbox-item-dot"></div>
            <span class="inbox-item-star ${m.starred ? 'starred' : ''}"
                onclick="event.stopPropagation();toggleInboxStar('${esc(m.id)}')">★</span>
            <div class="inbox-item-content">
                <div class="inbox-item-top">
                    <span class="inbox-item-from">${esc(fromDisplay)}</span>
                    <span class="inbox-item-date">${esc(m.date || '')}</span>
                </div>
                <div class="inbox-item-subject">${esc(m.subject || 'Sans sujet')}</div>
                <div class="inbox-item-preview">${esc(preview)}</div>
                ${hasAttach ? '<div class="inbox-item-attach"><i class="icon-paperclip"></i> ' + m.attachments.length + ' pièce(s) jointe(s)</div>' : ''}
            </div>
        </div>`;
    }).join('');
}

/* ═══════════════════════════════════════════════════════
   Inbox — Read Mail
   ═══════════════════════════════════════════════════════ */
async function openInboxMail(mailId) {
    selectedInboxId = mailId;
    let mail = inboxMails.find(m => m.id === mailId);
    if (!mail) return;

    // Refresh selected mail details (HTML body, attachments) from backend.
    try {
        const r = await fetch('/api/mail/' + encodeURIComponent(mailId));
        if (r.ok) {
            const fresh = await r.json();
            const idx = inboxMails.findIndex(m => m.id === mailId);
            if (idx !== -1) inboxMails[idx] = fresh;
            mail = fresh;
        }
    } catch {}

    // Mark as read
    if (!mail.read) {
        mail.read = true;
        fetch('/api/mail/mark-read', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: mailId, read: true })
        }).catch(() => {});
        updateInboxBadge();
    }

    renderInboxList();
    renderInboxReader(mail);
}

function renderInboxReader(mail) {
    const reader = document.getElementById('inboxReader');
    if (!reader) return;

    const attachHtml = mail.attachments && mail.attachments.length > 0
        ? `<div class="inbox-reader-attach">
            <h4><i class="icon-paperclip"></i> Pièces jointes</h4>
            ${mail.attachments.map((a, i) =>
                `<button class="att-item-btn" onclick="openInboxAttachment('${esc(mail.id)}', ${i}, '${esc(a)}')">
                    <i class="icon-paperclip"></i> ${esc(a)}
                </button>`
            ).join('')}
           </div>`
        : '';

    const hasHtml = !!(mail.body_html && mail.body_html.trim());
    const htmlContainer = hasHtml
        ? `<div class="inbox-reader-html"><iframe id="mailHtmlFrame" sandbox=""></iframe></div>`
        : `<div class="inbox-reader-body">${esc(mail.body || '(aucun contenu)')}</div>`;

    reader.innerHTML = `
        <div class="inbox-reader-header">
            <div class="inbox-reader-subject">${esc(mail.subject || 'Sans sujet')}</div>
            <div class="inbox-reader-meta">
                <span><strong>De :</strong> ${esc(mail.from_name || '')} &lt;${esc(mail.from_email || '')}&gt;</span>
                <span><strong>À :</strong> ${esc(mail.to || '')}</span>
                ${mail.cc ? `<span><strong>Cc :</strong> ${esc(mail.cc)}</span>` : ''}
                <span><strong>Date :</strong> ${esc(mail.date || '')}</span>
                <span><strong>Compte :</strong> ${esc(mail.account || '')}</span>
                ${mail.folder === 'sent' ? '<span style="color:var(--accent-green);font-weight:600">📤 Envoyé</span>' : ''}
            </div>
            <div class="inbox-reader-actions">
                <button onclick="replyToMail('${esc(mail.id)}')"><i class="icon-reply"></i> Répondre</button>
                <button onclick="replyToMail('${esc(mail.id)}', true)"><i class="icon-reply"></i> Répondre à tous</button>
                <button onclick="forwardMail('${esc(mail.id)}')"><i class="icon-forward"></i> Transférer</button>
                <button onclick="exportMailGraph('${esc(mail.id)}')"><i class="icon-book-open"></i> Exporter</button>
                <button onclick="toggleInboxRead('${esc(mail.id)}')">${mail.read ? '<i class="icon-mail-open"></i> Marquer non lu' : '<i class="icon-mail"></i> Marquer lu'}</button>
                <button class="danger" onclick="openDeleteMailModal('${esc(mail.id)}')"><i class="icon-trash-2"></i> Supprimer</button>
            </div>
        </div>
        ${htmlContainer}
        ${attachHtml}`;

    if (hasHtml) {
        const frame = document.getElementById('mailHtmlFrame');
        if (frame) frame.srcdoc = mail.body_html;
    }
}

function openInboxAttachment(mailId, idx, name) {
    const url = `/api/mail/attachment?id=${encodeURIComponent(mailId)}&idx=${idx}&name=${encodeURIComponent(name)}`;
    window.open(url, '_blank', 'noopener');
}

/* ═══════════════════════════════════════════════════════
   Inbox — Actions
   ═══════════════════════════════════════════════════════ */
async function fetchEmails() {
    const statusEl = document.getElementById('inbox-status');
    statusEl.style.display = 'block';
    statusEl.className = 'inbox-status loading';
    statusEl.textContent = 'Connexion aux serveurs (POP3/IMAP/Gmail OAuth)…';

    try {
        const r = await fetch('/api/fetch-emails', { method: 'POST' });
        const result = await r.json();
        if (result.error) {
            statusEl.className = 'inbox-status error';
            statusEl.textContent = 'Erreur : ' + result.error;
        } else {
            await loadInbox();
            const errStr = result.errors && result.errors.length
                ? ` (${result.errors.length} erreur(s))`
                : '';
            statusEl.className = 'inbox-status success';
            statusEl.textContent = `${result.new_count} nouveau(x) mail(s) récupéré(s)${errStr}`;
        }
    } catch (e) {
        statusEl.className = 'inbox-status error';
        statusEl.textContent = 'Erreur réseau : ' + e.message;
    }

    setTimeout(() => { statusEl.style.display = 'none'; }, 5000);
}

async function toggleInboxStar(mailId) {
    const mail = inboxMails.find(m => m.id === mailId);
    if (!mail) return;
    mail.starred = !mail.starred;
    // Persist star state
    fetch('/api/mail/mark-read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: mailId, read: mail.read, starred: mail.starred })
    }).catch(() => {});
    renderInboxList();
}

async function toggleInboxRead(mailId) {
    const mail = inboxMails.find(m => m.id === mailId);
    if (!mail) return;
    mail.read = !mail.read;
    fetch('/api/mail/mark-read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: mailId, read: mail.read })
    }).catch(() => {});
    renderInboxList();
    renderInboxReader(mail);
    updateInboxBadge();
}

function replyToMail(mailId, replyAll) {
    const mail = inboxMails.find(m => m.id === mailId);
    if (!mail) return;
    switchTab('mail');
    selectedMailTask = null;
    updateMailComposerState();
    renderMailList();
    // Pre-fill composer
    mailRecipients = mail.from_email ? [mail.from_email] : [];
    mailCcRecipients = [];

    if (replyAll) {
        // Add all To: recipients (except our account) to To
        const toAddrs = (mail.to || '').split(',').map(e => e.trim()).filter(e => e && e !== mail.account);
        toAddrs.forEach(addr => {
            if (!mailRecipients.includes(addr)) mailRecipients.push(addr);
        });
        // Add CC recipients
        if (mail.cc) {
            const ccAddrs = mail.cc.split(',').map(e => e.trim()).filter(e => e && e !== mail.account);
            mailCcRecipients = ccAddrs;
        }
    }

    renderMailTags();
    renderCcTags();
    document.getElementById('mailSubject').value = 'Re: ' + (mail.subject || '').replace(/^Re:\s*/i, '');
    document.getElementById('mailBody').value = '';
    setReplyComposerContext({
        originalText: mail.body || '',
        date: mail.date || '',
        from: mail.from_name || mail.from_email || ''
    });
    // Try to match account
    const fromSel = document.getElementById('mailFrom');
    if (mail.account) {
        for (let i = 0; i < fromSel.options.length; i++) {
            if (fromSel.options[i].value === mail.account) { fromSel.selectedIndex = i; break; }
        }
    }
    document.getElementById('mailBody').focus();
}

function forwardMail(mailId) {
    const mail = inboxMails.find(m => m.id === mailId);
    if (!mail) return;
    switchTab('mail');
    selectedMailTask = null;
    updateMailComposerState();
    renderMailList();
    setReplyComposerContext(null);
    mailRecipients = [];
    mailCcRecipients = [];
    renderMailTags();
    renderCcTags();
    document.getElementById('mailSubject').value = 'Fwd: ' + (mail.subject || '').replace(/^Fwd:\s*/i, '');
    const fwdBody = '\n\n--- Mail transféré ---\n'
        + 'De : ' + (mail.from_name || '') + ' <' + (mail.from_email || '') + '>\n'
        + 'Date : ' + (mail.date || '') + '\n'
        + 'À : ' + (mail.to || '') + '\n'
        + (mail.cc ? 'Cc : ' + mail.cc + '\n' : '')
        + 'Sujet : ' + (mail.subject || '') + '\n\n'
        + (mail.body || '');
    document.getElementById('mailBody').value = fwdBody;
    document.getElementById('mailToInput').focus();
}

async function exportMailGraph(mailId) {
    showLoading('Export vers Graph…');
    try {
        const r = await fetch('/api/mail/export-graph', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: mailId })
        });
        const result = await r.json();
        if (result.ok) {
            showToast('Exporté vers Graph !', 'success', 3000);
        } else {
            showToast('Erreur : ' + (result.error || 'Erreur'), 'error', 5000);
        }
    } catch (e) {
        showToast('Erreur : ' + e.message, 'error', 5000);
    } finally {
        hideLoading();
    }
}

async function exportAllGraph() {
    showLoading('Export de tous les mails vers Graph…');
    try {
        const r = await fetch('/api/mail/export-graph-all', { method: 'POST' });
        const result = await r.json();
        if (result.ok) {
            const errStr = result.errors && result.errors.length
                ? ` (${result.errors.length} erreur(s))`
                : '';
            showToast(`${result.exported} mail(s) exporté(s)${errStr}`, 'success', 3000);
        } else {
            showToast('Erreur : ' + (result.error || 'Erreur'), 'error', 5000);
        }
    } catch (e) {
        showToast('Erreur : ' + e.message, 'error', 5000);
    } finally {
        hideLoading();
    }
}

/* ═══════════════════════════════════════════════════════
   Inbox — Delete
   ═══════════════════════════════════════════════════════ */
function openDeleteMailModal(mailId) {
    deleteMailTarget = mailId;
    const mail = inboxMails.find(m => m.id === mailId);
    document.getElementById('deleteMailSubject').textContent = mail ? mail.subject : '';
    document.getElementById('deleteOnServer').checked = false;
    document.getElementById('deleteMailModal').classList.add('show');
}

function closeDeleteMailModal() {
    document.getElementById('deleteMailModal').classList.remove('show');
    deleteMailTarget = null;
}

async function confirmDeleteMail() {
    if (!deleteMailTarget) return;
    const targetId = deleteMailTarget;
    const deleteOnServer = document.getElementById('deleteOnServer').checked;
    closeDeleteMailModal();
    showLoading('Suppression du mail…');
    try {
        const r = await fetch('/api/mail/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: targetId, delete_on_server: deleteOnServer })
        });
        const result = await r.json();
        if (result.ok) {
            inboxMails = inboxMails.filter(m => m.id !== targetId);
            if (selectedInboxId === targetId) {
                selectedInboxId = null;
                document.getElementById('inboxReader').innerHTML = `
                    <div class="inbox-reader-empty">
                        <i class="icon-mail-open" style="font-size:2.5rem;color:var(--text-muted)"></i>
                        <p>Sélectionne un mail pour le lire</p>
                    </div>`;
            }
            renderInboxList();
            updateInboxBadge();
            showToast('Mail supprimé', 'success');
        } else {
            showToast('Erreur : ' + (result.error || 'Erreur'), 'error', 5000);
        }
    } catch (e) {
        showToast('Erreur : ' + e.message, 'error', 5000);
    } finally {
        hideLoading();
    }
}

/* ═══════════════════════════════════════════════════════
   Inbox — Badge
   ═══════════════════════════════════════════════════════ */
function updateInboxBadge() {
    const unread = inboxMails.filter(m => !m.read).length;
    const tabBtn = document.querySelector('.tab-btn[data-tab="inbox"]');
    if (tabBtn) {
        tabBtn.innerHTML = unread > 0 ? `<i class="icon-inbox"></i> Inbox <span style="font-size:0.75em;color:var(--accent-blue)">(${unread})</span>` : '<i class="icon-inbox"></i> Inbox';
    }
}

/* ═══════════════════════════════════════════════════════
   Accounts Modal
   ═══════════════════════════════════════════════════════ */
let accountsData = [];

function normalizeAccountDefaults(acc = {}) {
    const provider = (acc.provider || 'custom').toLowerCase();
    const authType = provider === 'gmail_oauth' ? 'oauth2' : (acc.auth_type || 'password');
    const email = (acc.email || '').trim();
    return {
        provider,
        auth_type: authType,
        email,
        protocol: provider === 'gmail_oauth' ? 'imap' : (acc.protocol || 'imap'),
        pop3_server: acc.pop3_server || '',
        pop3_port: acc.pop3_port || 995,
        pop3_ssl: acc.pop3_ssl !== false,
        imap_server: provider === 'gmail_oauth' ? 'imap.gmail.com' : (acc.imap_server || ''),
        imap_port: provider === 'gmail_oauth' ? 993 : (acc.imap_port || 993),
        imap_ssl: provider === 'gmail_oauth' ? true : (acc.imap_ssl !== false),
        imap_post_action: acc.imap_post_action || 'mark_read',
        smtp_server: provider === 'gmail_oauth' ? 'smtp.gmail.com' : (acc.smtp_server || ''),
        smtp_port: provider === 'gmail_oauth' ? 587 : (acc.smtp_port || 587),
        smtp_starttls: provider === 'gmail_oauth' ? true : (acc.smtp_starttls !== false),
        smtp_ssl: provider === 'gmail_oauth' ? false : !!acc.smtp_ssl,
        username: provider === 'gmail_oauth' ? email : (acc.username || ''),
        password: provider === 'gmail_oauth' ? '' : (acc.password || ''),
        enabled: acc.enabled !== false,
        oauth_client_id: acc.oauth_client_id || '',
        oauth_client_secret: acc.oauth_client_secret || '',
        oauth_redirect_uri: acc.oauth_redirect_uri || 'http://127.0.0.1:8080/api/oauth/google/callback',
        oauth_scope: acc.oauth_scope || 'https://mail.google.com/',
        oauth_refresh_token: acc.oauth_refresh_token || '',
        oauth_access_token: acc.oauth_access_token || '',
        oauth_token_expiry: acc.oauth_token_expiry || 0,
    };
}

async function openAccountsModal() {
    try {
        const r = await fetch('/api/accounts');
        if (r.ok) {
            const raw = await r.json();
            accountsData = raw.map(normalizeAccountDefaults);
        }
    } catch {}
    renderAccountsList();
    document.getElementById('accountsModal').classList.add('show');
}

function closeAccountsModal() {
    document.getElementById('accountsModal').classList.remove('show');
}

function renderAccountsList() {
    const container = document.getElementById('accountsList');
    if (!accountsData.length) {
        container.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;margin-bottom:1rem">Aucun compte configuré.</p>';
        return;
    }
    container.innerHTML = accountsData.map((rawAcc, i) => {
        const acc = normalizeAccountDefaults(rawAcc);
        accountsData[i] = acc;
        const isGmailOAuth = acc.provider === 'gmail_oauth';
        const isConnected = !!acc.oauth_refresh_token;
        return `
        <div class="account-card" data-idx="${i}">
            <button class="account-delete" onclick="removeAccount(${i})" title="Supprimer">✕</button>

            <div class="form-group">
                <label>Type de compte</label>
                <select onchange="changeAccountProvider(${i}, this.value)" style="width:100%;background:var(--bg-surface);border:1px solid var(--card-border);border-radius:var(--radius-sm);padding:0.35rem 0.5rem;color:var(--text);font-size:0.78rem;cursor:pointer">
                    <option value="custom" ${!isGmailOAuth ? 'selected' : ''}>Standard (POP3/IMAP/SMTP)</option>
                    <option value="gmail_oauth" ${isGmailOAuth ? 'selected' : ''}>Gmail (OAuth 2.0)</option>
                </select>
            </div>

            <div class="form-group">
                <label>Adresse email</label>
                <div style="display:flex;gap:0.4rem;align-items:center">
                    <input type="text" value="${esc(acc.email || '')}" onchange="accountsData[${i}].email=this.value;accountsData[${i}].username=this.value" placeholder="user@example.com" style="flex:1" id="accEmail_${i}">
                    ${isGmailOAuth ?
                        `<button onclick="startGoogleOAuthForAccount(${i})" style="white-space:nowrap;padding:0.3rem 0.6rem;background:var(--accent-blue);color:white;border:none;border-radius:var(--radius-sm);cursor:pointer;font-size:0.72rem" title="Connecter Google">🔐 Connecter Google</button>` :
                        `<button onclick="autoconfigAccount(${i})" style="white-space:nowrap;padding:0.3rem 0.6rem;background:var(--accent-purple);color:white;border:none;border-radius:var(--radius-sm);cursor:pointer;font-size:0.72rem" title="Auto-détecter les paramètres">⚡ Autoconfig</button>`
                    }
                </div>
            </div>

            ${isGmailOAuth ? `
            <div class="form-row">
                <div class="form-group">
                    <label>Google OAuth Client ID</label>
                    <input type="text" value="${esc(acc.oauth_client_id || '')}" onchange="accountsData[${i}].oauth_client_id=this.value" placeholder="Votre Client ID OAuth Google">
                </div>
                <div class="form-group">
                    <label>Google OAuth Client Secret</label>
                    <input type="password" value="${esc(acc.oauth_client_secret || '')}" onchange="accountsData[${i}].oauth_client_secret=this.value" placeholder="Votre Client Secret OAuth Google">
                </div>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label>Redirect URI</label>
                    <input type="text" value="${esc(acc.oauth_redirect_uri || '')}" onchange="accountsData[${i}].oauth_redirect_uri=this.value" placeholder="http://127.0.0.1:8080/api/oauth/google/callback">
                </div>
                <div class="form-group">
                    <label>Scope</label>
                    <input type="text" value="${esc(acc.oauth_scope || '')}" onchange="accountsData[${i}].oauth_scope=this.value" placeholder="https://mail.google.com/">
                </div>
            </div>
            <div class="form-group" style="padding:0.45rem 0.6rem;border:1px solid var(--card-border);border-radius:var(--radius-sm);background:var(--progress-bg)">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:0.6rem;flex-wrap:wrap">
                    <span style="font-size:0.78rem;color:${isConnected ? 'var(--accent-green)' : 'var(--text-muted)'}">
                        ${isConnected ? 'Connecté à Google (refresh token enregistré)' : 'Pas encore connecté à Google'}
                    </span>
                    ${isConnected ? `<button onclick="disconnectGoogleOAuthForAccount(${i})" style="padding:0.28rem 0.55rem;background:#ef4444;color:white;border:none;border-radius:var(--radius-sm);cursor:pointer;font-size:0.72rem">Déconnecter</button>` : ''}
                </div>
                <small style="margin-top:0.4rem">IMAP: imap.gmail.com:993 (SSL) | SMTP: smtp.gmail.com:587 (STARTTLS)</small>
            </div>` : `
            <div class="form-group">
                <label>Protocole de réception</label>
                <select onchange="accountsData[${i}].protocol=this.value;renderAccountsList()" style="width:100%;background:var(--bg-surface);border:1px solid var(--card-border);border-radius:var(--radius-sm);padding:0.35rem 0.5rem;color:var(--text);font-size:0.78rem;cursor:pointer">
                    <option value="pop3" ${(acc.protocol||'pop3')==='pop3'?'selected':''}>POP3</option>
                    <option value="imap" ${acc.protocol==='imap'?'selected':''}>IMAP</option>
                </select>
            </div>
            ${(acc.protocol||'pop3') === 'pop3' ? `
            <div class="form-row">
                <div class="form-group">
                    <label>Serveur POP3</label>
                    <input type="text" value="${esc(acc.pop3_server || '')}" onchange="accountsData[${i}].pop3_server=this.value" placeholder="pop.example.com">
                </div>
                <div class="form-group">
                    <label>Port POP3</label>
                    <input type="number" value="${acc.pop3_port || 995}" onchange="accountsData[${i}].pop3_port=parseInt(this.value)">
                </div>
            </div>` : `
            <div class="form-row">
                <div class="form-group">
                    <label>Serveur IMAP</label>
                    <input type="text" value="${esc(acc.imap_server || '')}" onchange="accountsData[${i}].imap_server=this.value" placeholder="imap.example.com">
                </div>
                <div class="form-group">
                    <label>Port IMAP</label>
                    <input type="number" value="${acc.imap_port || 993}" onchange="accountsData[${i}].imap_port=parseInt(this.value)">
                </div>
            </div>
            <div class="form-group">
                <label>Après téléchargement</label>
                <select onchange="accountsData[${i}].imap_post_action=this.value" style="width:100%;background:var(--bg-surface);border:1px solid var(--card-border);border-radius:var(--radius-sm);padding:0.35rem 0.5rem;color:var(--text);font-size:0.78rem;cursor:pointer">
                    <option value="mark_read" ${(acc.imap_post_action||'mark_read')==='mark_read'?'selected':''}>Marquer comme lus (conserver sur le serveur)</option>
                    <option value="delete" ${acc.imap_post_action==='delete'?'selected':''}>Supprimer du serveur</option>
                </select>
            </div>`}
            <div class="form-row">
                <div class="form-group">
                    <label>Serveur SMTP</label>
                    <input type="text" value="${esc(acc.smtp_server || '')}" onchange="accountsData[${i}].smtp_server=this.value" placeholder="smtp.example.com">
                </div>
                <div class="form-group">
                    <label>Port SMTP</label>
                    <input type="number" value="${acc.smtp_port || 587}" onchange="accountsData[${i}].smtp_port=parseInt(this.value)">
                </div>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label>Identifiant</label>
                    <input type="text" value="${esc(acc.username || '')}" onchange="accountsData[${i}].username=this.value" placeholder="user@example.com">
                </div>
                <div class="form-group">
                    <label>Mot de passe</label>
                    <input type="password" value="${esc(acc.password || '')}" onchange="accountsData[${i}].password=this.value">
                </div>
            </div>`}

            <div class="form-row">
                ${!isGmailOAuth && (acc.protocol||'pop3') === 'pop3' ? `
                <label class="account-toggle">
                    <input type="checkbox" ${acc.pop3_ssl !== false ? 'checked' : ''} onchange="accountsData[${i}].pop3_ssl=this.checked">
                    POP3 SSL
                </label>` : ''}
                ${!isGmailOAuth && (acc.protocol||'imap') === 'imap' ? `
                <label class="account-toggle">
                    <input type="checkbox" ${acc.imap_ssl !== false ? 'checked' : ''} onchange="accountsData[${i}].imap_ssl=this.checked">
                    IMAP SSL
                </label>` : ''}
                <label class="account-toggle">
                    <input type="checkbox" ${acc.smtp_starttls !== false ? 'checked' : ''} onchange="accountsData[${i}].smtp_starttls=this.checked" ${isGmailOAuth ? 'disabled' : ''}>
                    SMTP STARTTLS
                </label>
                <label class="account-toggle">
                    <input type="checkbox" ${acc.smtp_ssl ? 'checked' : ''} onchange="accountsData[${i}].smtp_ssl=this.checked" ${isGmailOAuth ? 'disabled' : ''}>
                    SMTP SSL
                </label>
                <label class="account-toggle">
                    <input type="checkbox" ${acc.enabled !== false ? 'checked' : ''} onchange="accountsData[${i}].enabled=this.checked">
                    Activé
                </label>
            </div>
        </div>
    `;
    }).join('');
}

function changeAccountProvider(idx, provider) {
    const base = normalizeAccountDefaults(accountsData[idx]);
    if (provider === 'gmail_oauth') {
        accountsData[idx] = normalizeAccountDefaults({ ...base, provider: 'gmail_oauth', auth_type: 'oauth2', protocol: 'imap' });
    } else {
        accountsData[idx] = normalizeAccountDefaults({ ...base, provider: 'custom', auth_type: 'password' });
    }
    renderAccountsList();
}

function addAccountForm() {
    accountsData.push(normalizeAccountDefaults({ provider: 'custom', protocol: 'imap' }));
    renderAccountsList();
}

function removeAccount(idx) {
    accountsData.splice(idx, 1);
    renderAccountsList();
}

async function startGoogleOAuthForAccount(idx) {
    const acc = normalizeAccountDefaults(accountsData[idx]);
    accountsData[idx] = acc;
    if (!acc.email || !acc.email.includes('@')) {
        showToast('Saisis une adresse Gmail valide avant de connecter Google.', 'error', 4000);
        return;
    }
    if (!acc.oauth_client_id) {
        showToast('Renseigne le Client ID OAuth Google.', 'error', 4000);
        return;
    }

    showLoading('Préparation de la connexion Google OAuth…');
    try {
        await fetch('/api/accounts/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accounts: accountsData })
        });

        const r = await fetch('/api/oauth/google/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: acc.email })
        });
        const result = await r.json();
        if (!result.ok || !result.auth_url) {
            showToast('Erreur OAuth: ' + (result.error || 'URL manquante'), 'error', 5000);
            return;
        }

        const opened = window.electronAPI && window.electronAPI.openExternal
            ? await window.electronAPI.openExternal(result.auth_url)
            : false;
        if (!opened) window.open(result.auth_url, '_blank', 'noopener');

        showToast('Connexion Google ouverte dans ton navigateur.', 'success', 3500);
    } catch (e) {
        showToast('Erreur OAuth: ' + e.message, 'error', 5000);
    } finally {
        hideLoading();
    }
}

function disconnectGoogleOAuthForAccount(idx) {
    const acc = normalizeAccountDefaults(accountsData[idx]);
    acc.oauth_access_token = '';
    acc.oauth_refresh_token = '';
    acc.oauth_token_expiry = 0;
    accountsData[idx] = acc;
    renderAccountsList();
}

async function saveAccountsFromModal() {
    try {
        const sanitized = accountsData.map((accRaw) => {
            const acc = normalizeAccountDefaults(accRaw);
            if (acc.provider === 'gmail_oauth') {
                acc.auth_type = 'oauth2';
                acc.protocol = 'imap';
                acc.username = acc.email;
                acc.password = '';
                acc.imap_server = 'imap.gmail.com';
                acc.imap_port = 993;
                acc.imap_ssl = true;
                acc.smtp_server = 'smtp.gmail.com';
                acc.smtp_port = 587;
                acc.smtp_ssl = false;
                acc.smtp_starttls = true;
                if (!acc.oauth_redirect_uri) acc.oauth_redirect_uri = 'http://127.0.0.1:8080/api/oauth/google/callback';
                if (!acc.oauth_scope) acc.oauth_scope = 'https://mail.google.com/';
            }
            return acc;
        });

        const r = await fetch('/api/accounts/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accounts: sanitized })
        });
        const result = await r.json();
        if (result.ok) {
            accountsData = sanitized;
            closeAccountsModal();
            showToast('Comptes enregistrés', 'success');
            updateMailFromOptions();
        } else {
            showToast('Erreur : ' + (result.error || 'Erreur'), 'error', 5000);
        }
    } catch (e) {
        showToast('Erreur : ' + e.message, 'error', 5000);
    }
}

function updateMailFromOptions() {
    const select = document.getElementById('mailFrom');
    if (!select) return;
    const previous = select.value;
    const enabled = accountsData.filter(acc => acc.email && acc.enabled !== false);
    select.innerHTML = '';

    if (!enabled.length) {
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = 'Aucun compte expéditeur';
        select.appendChild(placeholder);
        return;
    }

    enabled.forEach(acc => {
        const opt = document.createElement('option');
        opt.value = acc.email;
        opt.textContent = acc.provider === 'gmail_oauth' ? `${acc.email} (Gmail OAuth)` : acc.email;
        select.appendChild(opt);
    });

    const hasPrev = enabled.some(acc => acc.email === previous);
    select.value = hasPrev ? previous : enabled[0].email;
}

/* ═══════════════════════════════════════════════════════
   SMTP Send from Composer
   ═══════════════════════════════════════════════════════ */
async function sendMailSMTP() {
    const from = document.getElementById('mailFrom').value;
    const to = getMailToValue();
    const cc = getMailCcValue();
    const subject = document.getElementById('mailSubject').value.trim();
    const body = getComposerFinalBodyText();
    if (!from) { showToast('Configure d\'abord un compte expéditeur.', 'error'); return; }
    if (!to || !subject) { showToast('Remplis le(s) destinataire(s) et le sujet.', 'error'); return; }

    // Save to task if associated
    if (selectedMailTask) saveMailFieldsToTask();

    // Prepare attachments as base64
    const attachments = await prepareAttachmentsForSend();

    const signatureHtml = getActiveSignatureHtml();
    const html_body = signatureHtml
        ? buildHtmlBodyWithOptionalQuote(document.getElementById('mailBody').value.trim(), signatureHtml, getQuotedOriginalText())
        : null;

    showLoading('Envoi du mail via SMTP…');
    try {
        const r = await fetch('/api/send-email', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ from, to, subject, body, cc, html_body, attachments: attachments.length ? attachments : undefined })
        });
        const result = await r.json();
        if (result.ok) {
            showToast('Mail envoyé et sauvegardé !', 'success', 3000);
            clearAttachments();
            // Mark associated task as sent
            if (selectedMailTask) {
                markMailTaskSent(selectedMailTask.sid, selectedMailTask.tid);
                autoSave();
                renderMailTab();
                render();
            }
            setReplyComposerContext(null);
        } else {
            showToast('Erreur : ' + (result.error || 'Erreur'), 'error', 5000);
        }
    } catch (e) {
        showToast('Erreur : ' + e.message, 'error', 5000);
    } finally {
        hideLoading();
    }
}

/* ═══════════════════════════════════════════════════════
   Attachments management
   ═══════════════════════════════════════════════════════ */
let pendingAttachments = []; // { file: File, name: string }

function handleAttachmentFiles(files) {
    for (const file of files) {
        if (!pendingAttachments.find(a => a.name === file.name && a.file.size === file.size)) {
            pendingAttachments.push({ file, name: file.name });
        }
    }
    renderAttachmentList();
    // Reset input so same file can be re-added
    document.getElementById('attachmentInput').value = '';
}

function removeAttachment(idx) {
    pendingAttachments.splice(idx, 1);
    renderAttachmentList();
}

function clearAttachments() {
    pendingAttachments = [];
    renderAttachmentList();
}

function renderAttachmentList() {
    const list = document.getElementById('attachmentList');
    const placeholder = document.getElementById('attachmentPlaceholder');
    if (!pendingAttachments.length) {
        list.innerHTML = '';
        placeholder.style.display = '';
        return;
    }
    placeholder.style.display = 'none';
    list.innerHTML = pendingAttachments.map((a, i) => {
        const sizeKB = (a.file.size / 1024).toFixed(1);
        return `<span style="display:inline-flex;align-items:center;gap:0.25rem;background:var(--bg-surface);border:1px solid var(--card-border);border-radius:var(--radius-sm);padding:0.15rem 0.5rem;font-size:0.75rem;color:var(--text)">
            📎 ${esc(a.name)} <span style="color:var(--text-muted)">(${sizeKB} Ko)</span>
            <button onclick="event.stopPropagation();removeAttachment(${i})" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:0.85rem;padding:0 0.15rem">&times;</button>
        </span>`;
    }).join('');
}

async function prepareAttachmentsForSend() {
    const results = [];
    for (const att of pendingAttachments) {
        const data = await fileToBase64(att.file);
        results.push({
            filename: att.name,
            content_type: att.file.type || 'application/octet-stream',
            data: data
        });
    }
    return results;
}

function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const b64 = reader.result.split(',')[1];
            resolve(b64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

// Drag & drop support for attachment zone
(function initAttachmentDragDrop() {
    document.addEventListener('DOMContentLoaded', () => {
        const zone = document.getElementById('attachmentZone');
        if (!zone) return;
        zone.addEventListener('dragover', e => { e.preventDefault(); zone.style.borderColor = 'var(--accent-blue)'; });
        zone.addEventListener('dragleave', () => { zone.style.borderColor = 'var(--card-border)'; });
        zone.addEventListener('drop', e => {
            e.preventDefault();
            zone.style.borderColor = 'var(--card-border)';
            if (e.dataTransfer.files.length) handleAttachmentFiles(e.dataTransfer.files);
        });
    });
})();

/* ═══════════════════════════════════════════════════════
   Email Autoconfig (Mozilla Thunderbird DB)
   ═══════════════════════════════════════════════════════ */
async function autoconfigAccount(idx) {
    const emailInput = document.getElementById('accEmail_' + idx);
    const email = emailInput ? emailInput.value.trim() : accountsData[idx].email;
    if (!email || !email.includes('@')) {
        showToast('Saisis d\'abord une adresse email valide.', 'error');
        return;
    }
    accountsData[idx].email = email;
    showLoading('Recherche de la configuration pour ' + email.split('@')[1] + '…');
    try {
        const r = await fetch('/api/autoconfig', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });
        const result = await r.json();
        if (result.ok && result.config) {
            const cfg = result.config;
            if (cfg.imap) {
                accountsData[idx].protocol = 'imap';
                accountsData[idx].imap_server = cfg.imap.server;
                accountsData[idx].imap_port = cfg.imap.port;
                accountsData[idx].imap_ssl = cfg.imap.ssl;
                accountsData[idx].username = cfg.imap.username || email;
            }
            if (cfg.smtp) {
                accountsData[idx].smtp_server = cfg.smtp.server;
                accountsData[idx].smtp_port = cfg.smtp.port;
                accountsData[idx].smtp_ssl = cfg.smtp.ssl || false;
                accountsData[idx].smtp_starttls = cfg.smtp.starttls || false;
                if (!accountsData[idx].username) {
                    accountsData[idx].username = cfg.smtp.username || email;
                }
            }
            renderAccountsList();
            const source = cfg.source === 'mozilla' ? 'base Mozilla Thunderbird' : 'détection automatique';
            showToast(`Configuration trouvée (${source}) !`, 'success', 3000);
        } else {
            showToast(result.error || 'Aucune configuration trouvée.', 'error', 4000);
        }
    } catch (e) {
        showToast('Erreur : ' + e.message, 'error', 5000);
    } finally {
        hideLoading();
    }
}

/* ═══════════════════════════════════════════════════════
   Periodic mail badge update
   ═══════════════════════════════════════════════════════ */
setInterval(() => {
    updateMailBadge();
    if (currentTab === 'mail') renderTimeline();
}, 30000);

/* ═══════════════════════════════════════════════════════
   Init
   ═══════════════════════════════════════════════════════ */
(async function init() {
    await Promise.all([loadState(), loadContacts()]);

    // Security migration: never keep GitHub password in plain JSON state.
    if (state.settings && Object.prototype.hasOwnProperty.call(state.settings, 'githubPassword')) {
        delete state.settings.githubPassword;
    }

    render();
    if (!state.settings) state.settings = {};
    applyThemeMode(state.settings.uiTheme || 'dark');

    const geminiInput = document.getElementById('geminiKeyInput');
    const contactsCount = document.getElementById('contactsCount');

    if (geminiInput) geminiInput.value = state.settings.geminiKey || '';
    if (contactsCount) contactsCount.textContent = contacts.length ? `${contacts.length} contacts chargés` : '';

    initSiteTabs();
    initLeadsState();

    renderSignaturesList();
    updateSignatureSelectors();

    autoSave();
    updateMailBadge();
    loadInbox().then(() => {
        updateInboxBadge();
        // Populate From dropdown with account emails
        fetch('/api/accounts').then(r => r.json()).then(accs => {
            accountsData = (Array.isArray(accs) ? accs : []).map(normalizeAccountDefaults);
            updateMailFromOptions();
        }).catch(() => {});
    });
    if (currentTab === 'mail') renderMailTab();
})();

/* ═══════════════════════════════════════════════════════
   Custom Titlebar Controls
   ═══════════════════════════════════════════════════════ */
(function initTitlebar() {
    const api = window.electronAPI;
    if (!api) return; // not running in Electron

    document.getElementById('btn-minimize').addEventListener('click', () => api.minimize());
    document.getElementById('btn-maximize').addEventListener('click', () => api.maximize());
    document.getElementById('btn-close').addEventListener('click', () => api.close());
})();

/* ═══════════════════════════════════════════════════════
   Custom Context Menu (right-click)
   ═══════════════════════════════════════════════════════ */
document.addEventListener('contextmenu', (e) => {
    const api = window.electronAPI;
    if (!api) return; // browser fallback = default context menu
    e.preventDefault();

    const taskItem = e.target.closest('.task-item');
    const params = {
        hasSelection: !!window.getSelection().toString(),
        isEditable: e.target.matches('input, textarea, [contenteditable]'),
        isTask: !!taskItem,
        taskId: taskItem ? taskItem.dataset.tid : null,
        sectionId: taskItem ? taskItem.dataset.sid : null,
        isTaskDone: taskItem ? taskItem.classList.contains('checked') : false,
    };

    api.showContextMenu(params);
});

// Listen for context menu actions from main process
if (window.electronAPI) {
    window.electronAPI.onContextMenuAction('context-menu:toggle-task', (tid, sid) => {
        if (typeof toggleTask === 'function') toggleTask(sid, tid);
    });
    window.electronAPI.onContextMenuAction('context-menu:delete-task', (tid, sid) => {
        if (typeof deleteTask === 'function') deleteTask(sid, tid);
    });
}

// VS Code-like zoom shortcuts: Ctrl/Cmd +/- and Ctrl/Cmd 0
document.addEventListener('keydown', (e) => {
    const api = window.electronAPI;
    if (!api || !(e.ctrlKey || e.metaKey)) return;

    if (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd') {
        e.preventDefault();
        api.zoomIn();
    } else if (e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract') {
        e.preventDefault();
        api.zoomOut();
    } else if (e.key === '0') {
        e.preventDefault();
        api.zoomReset();
    }
});

/* ═══════════════════════════════════════════════════════
   Vault Graph (D3.js force-directed — local IPC scan)
   ═══════════════════════════════════════════════════════ */
let d3Sim = null;
let graphData = null;
let graphHiddenGroups = new Set();
let d3Zoom = null;
let d3SvgG = null;
let graphNodeMap = {};
let graphPathLookup = {};
let selectedGraphNode = null;
let graphTickQueued = false;
let graphCurrentZoomK = 1;
let graphRepulsionStrength = 120;

let graphDataLoaded = false;

const GROUP_COLORS = { mail: '#89b4fa', md: '#a6e3a1', attachment: '#fab387', orphan: '#6c7086' };

async function initGraphIfNeeded() {
    if (graphDataLoaded) return;
    const svg = document.getElementById('graphSvg');
    if (!svg) return;
    try {
        const api = window.electronAPI;
        if (api && api.scanVaultGraph) {
            graphData = await api.scanVaultGraph();
        } else {
            const r = await fetch('/api/vault/graph');
            if (!r.ok) throw new Error('HTTP ' + r.status);
            graphData = await r.json();
        }
        if (graphData.error) throw new Error(graphData.error);
        graphDataLoaded = true;
        // Build node map for sidebar list
        graphNodeMap = {};
        graphData.nodes.forEach(n => { graphNodeMap[n.id] = n; });
        rebuildGraphPathLookup();
        buildNodeList();
        updateGraphStats();
        // Show placeholder — graph renders only on search
        showGraphPlaceholder();
    } catch (err) {
        console.error('Graph load error:', err);
        svg.innerHTML = '<text x="50%" y="50%" text-anchor="middle" fill="#f38ba8" font-size="12">Erreur : ' + err.message + '</text>';
    }
}

function showGraphPlaceholder() {
    // Destroy any running simulation
    if (d3Sim) { d3Sim.stop(); d3Sim = null; }
    const svg = d3.select('#graphSvg');
    svg.selectAll('*').remove();
    svg.node().__d3refs = null;
    document.getElementById('graphPlaceholder').style.display = '';
    document.getElementById('graphZoomControls').style.display = 'none';
}

function buildD3Graph(subNodes, subEdges, highlightIds) {
    // Stop previous simulation
    if (d3Sim) { d3Sim.stop(); d3Sim = null; }

    const svg = d3.select('#graphSvg');
    svg.selectAll('*').remove();
    const rect = svg.node().getBoundingClientRect();
    const W = rect.width || 800, H = rect.height || 600;

    // Clone data for D3 (it mutates objects)
    const nodes = subNodes.map(n => ({ ...n }));
    const nodeIndex = {};
    nodes.forEach((n, i) => { nodeIndex[n.id] = i; });
    const links = subEdges
        .filter(e => e.source in nodeIndex && e.target in nodeIndex)
        .map(e => ({ source: e.source, target: e.target }));

    // Zoom behavior — cap at 4x to avoid GPU tile memory overflow in Electron
    d3Zoom = d3.zoom().scaleExtent([0.05, 4]).on('zoom', (event) => {
        d3SvgG.attr('transform', event.transform);
        const k = event.transform.k;
        if (Math.abs(k - graphCurrentZoomK) > 0.15 || (k >= 0.6) !== (graphCurrentZoomK >= 0.6)) {
            graphCurrentZoomK = k;
            updateLabelsVisibility(k);
        }
    });
    svg.call(d3Zoom);

    d3SvgG = svg.append('g').attr('class', 'graph-g');

    // Links
    const link = d3SvgG.append('g').attr('class', 'links')
        .selectAll('line').data(links).join('line')
        .attr('stroke', '#313244').attr('stroke-width', 0.6).attr('opacity', 0.5);

    // Nodes
    const node = d3SvgG.append('g').attr('class', 'nodes')
        .selectAll('circle').data(nodes).join('circle')
        .attr('r', d => d.type === 'orphan' ? 2 : (d.type === 'attachment' ? 3 : 4))
        .attr('fill', d => GROUP_COLORS[d.group] || '#6c7086')
        .attr('stroke', d => highlightIds && highlightIds.has(d.id) ? '#cdd6f4' : '#1e1e2e')
        .attr('stroke-width', d => highlightIds && highlightIds.has(d.id) ? 1.5 : 0.5)
        .attr('opacity', d => highlightIds && !highlightIds.has(d.id) ? 0.4 : 1)
        .attr('cursor', 'pointer')
        .on('click', (event, d) => {
            event.stopPropagation();
            onNodeClick(d, nodes, links);
        })
        .call(d3.drag()
            .on('start', (event, d) => { if (!event.active) d3Sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
            .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; })
            .on('end', (event, d) => { if (!event.active) d3Sim.alphaTarget(0); d.fx = null; d.fy = null; })
        );

    // Labels (hidden by default, shown at sufficient zoom)
    const label = d3SvgG.append('g').attr('class', 'labels')
        .selectAll('text').data(nodes).join('text')
        .text(d => d.label.length > 25 ? d.label.slice(0, 22) + '…' : d.label)
        .attr('font-size', 6).attr('fill', '#6c7086')
        .attr('text-anchor', 'middle').attr('dy', d => (d.type === 'orphan' ? 6 : 10))
        .attr('pointer-events', 'none')
        .style('display', 'none');

    // Click on background to deselect
    svg.on('click', () => { clearGraphHighlight(nodes, links); closeGraphReader(); });

    // Force simulation — rAF-batched rendering
    svg.node().classList.add('simulating');

    function renderTick() {
        graphTickQueued = false;
        link.attr('x1', d => d.source.x).attr('y1', d => d.source.y)
            .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
        node.attr('cx', d => d.x).attr('cy', d => d.y);
        label.attr('x', d => d.x).attr('y', d => d.y);
    }

    d3Sim = d3.forceSimulation(nodes)
        .force('link', d3.forceLink(links).id(d => d.id).distance(90))
        .force('charge', d3.forceManyBody().strength(-graphRepulsionStrength).distanceMax(400))
        .force('center', d3.forceCenter(W / 2, H / 2))
        .force('collision', d3.forceCollide().radius(6))
        .alphaDecay(0.04)
        .on('tick', () => {
            if (!graphTickQueued) {
                graphTickQueued = true;
                requestAnimationFrame(renderTick);
            }
        })
        .on('end', () => {
            svg.node().classList.remove('simulating');
            renderTick();
            updateLabelsVisibility(graphCurrentZoomK);
        });

    // Store references for highlighting
    svg.node().__d3refs = { node, link, label, nodes, links };
}

function updateLabelsVisibility(k) {
    const svg = d3.select('#graphSvg');
    const refs = svg.node()?.__d3refs;
    if (!refs) return;
    // Only show labels when zoomed in enough (k >= 0.6), never for orphans
    if (selectedGraphNode) return; // Don't override highlight display logic
    refs.label.style('display', d => {
        if (d.type === 'orphan') return 'none';
        if (graphHiddenGroups.has(d.group)) return 'none';
        return k >= 0.6 ? null : 'none';
    });
}

function onNodeClick(d, nodes, links) {
    selectedGraphNode = d.id;
    selectNodeInList(d.id);
    highlightGraphNode(d, nodes, links);
    if (d.path) {
        openGraphReader(d.label, d.path);
    } else {
        document.getElementById('graphReaderTitle').textContent = d.label;
        document.getElementById('graphReaderBody').textContent = '(noeud orphelin — pas de fichier)';
        document.getElementById('graphReader').classList.add('open');
    }
}

function highlightGraphNode(d, nodes, links) {
    const svg = d3.select('#graphSvg');
    const refs = svg.node().__d3refs;
    if (!refs) return;
    const neighborIds = new Set([d.id]);
    links.forEach(l => {
        const src = typeof l.source === 'object' ? l.source.id : l.source;
        const tgt = typeof l.target === 'object' ? l.target.id : l.target;
        if (src === d.id) neighborIds.add(tgt);
        if (tgt === d.id) neighborIds.add(src);
    });
    refs.node.attr('opacity', n => neighborIds.has(n.id) ? 1 : 0.1)
        .attr('r', n => n.id === d.id ? 6 : (n.type === 'orphan' ? 2 : (n.type === 'attachment' ? 3 : 4)));
    refs.link.attr('opacity', l => {
        const src = typeof l.source === 'object' ? l.source.id : l.source;
        const tgt = typeof l.target === 'object' ? l.target.id : l.target;
        return (src === d.id || tgt === d.id) ? 0.8 : 0.05;
    }).attr('stroke', l => {
        const src = typeof l.source === 'object' ? l.source.id : l.source;
        const tgt = typeof l.target === 'object' ? l.target.id : l.target;
        return (src === d.id || tgt === d.id) ? '#89b4fa' : '#313244';
    });
    refs.label.attr('opacity', n => neighborIds.has(n.id) ? 1 : 0.1)
        .style('display', n => neighborIds.has(n.id) ? null : 'none');
}

function clearGraphHighlight(nodes, links) {
    selectedGraphNode = null;
    const svg = d3.select('#graphSvg');
    const refs = svg.node()?.__d3refs;
    if (!refs) return;
    refs.node.attr('opacity', 1).attr('r', d => d.type === 'orphan' ? 2 : (d.type === 'attachment' ? 3 : 4));
    refs.link.attr('opacity', 0.5).attr('stroke', '#313244');
    refs.label.attr('opacity', 1);
    updateLabelsVisibility(graphCurrentZoomK);
    document.querySelectorAll('#graphNodeList .node-item').forEach(el => el.classList.remove('active'));
}

function setGraphRepulsion(value) {
    graphRepulsionStrength = value;
    const label = document.getElementById('graphRepulsionVal');
    if (label) label.textContent = value;
    if (d3Sim) {
        d3Sim.force('charge', d3.forceManyBody().strength(-value).distanceMax(400));
        d3Sim.alpha(0.3).restart();
    }
}

function rebuildGraphPathLookup() {
    graphPathLookup = {};
    if (!graphData || !graphData.nodes) return;
    graphData.nodes.forEach(n => {
        if (!n.path) return;
        const path = normalizeVaultRelpath(n.path);
        const lowerPath = path.toLowerCase();
        const fileName = getPathBaseName(path).toLowerCase();
        graphPathLookup[lowerPath] = path;
        graphPathLookup[fileName] = path;
        graphPathLookup[n.id.toLowerCase()] = path;
        if (n.type === 'md') {
            graphPathLookup[(n.id + '.md').toLowerCase()] = path;
        }
    });
}

function getPathBaseName(relpath) {
    return String(relpath || '').split('/').pop() || '';
}

function normalizeVaultRelpath(relpath) {
    const raw = String(relpath || '').replace(/\\/g, '/');
    const parts = raw.split('/');
    const out = [];
    for (const p of parts) {
        if (!p || p === '.') continue;
        if (p === '..') {
            if (out.length) out.pop();
            continue;
        }
        out.push(p);
    }
    return out.join('/');
}

function resolveVaultLink(baseRelpath, linkTarget) {
    const raw = String(linkTarget || '').trim();
    if (!raw) return null;
    if (/^(https?:|mailto:)/i.test(raw)) {
        return { type: 'external', target: raw };
    }

    const withoutPrefix = raw.replace(/^vault:/i, '');
    const withoutQuery = withoutPrefix.split('#')[0].split('?')[0];
    const normalizedTarget = normalizeVaultRelpath(decodeURIComponent(withoutQuery));
    if (!normalizedTarget) return null;

    const baseDir = normalizeVaultRelpath(baseRelpath).split('/').slice(0, -1).join('/');
    const combined = normalizedTarget.startsWith('/')
        ? normalizeVaultRelpath(normalizedTarget.slice(1))
        : normalizeVaultRelpath((baseDir ? baseDir + '/' : '') + normalizedTarget);

    const candidates = new Set([combined, normalizedTarget, getPathBaseName(combined), getPathBaseName(normalizedTarget)]);
    if (!/\.[^./\\]+$/.test(combined)) {
        candidates.add(combined + '.md');
        candidates.add(normalizedTarget + '.md');
    }

    for (const c of candidates) {
        const found = graphPathLookup[c.toLowerCase()];
        if (found) {
            return { type: 'vault', target: found };
        }
    }
    return { type: 'vault', target: combined || normalizedTarget };
}

function preprocessGraphMarkdown(content) {
    return String(content || '')
        .replace(/!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, link, alt) => `![${alt || link}](vault:${link})`)
        .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, link, label) => `[${label || link}](vault:${link})`);
}

async function renderGraphMarkdown(title, relpath, markdownContent, bodyEl) {
    bodyEl.textContent = '';
    bodyEl.classList.add('is-markdown');

    if (typeof marked === 'undefined') {
        bodyEl.classList.remove('is-markdown');
        bodyEl.style.whiteSpace = 'pre-wrap';
        bodyEl.textContent = markdownContent;
        return;
    }

    const renderer = new marked.Renderer();
    // Disable raw HTML rendering in markdown preview.
    renderer.html = (html) => esc(html);
    marked.setOptions({ gfm: true, breaks: true, renderer });

    const rendered = marked.parse(preprocessGraphMarkdown(markdownContent));
    bodyEl.innerHTML = `<div class="graph-markdown">${rendered}</div>`;

    // Resolve inline markdown images relative to the current note.
    const imageEls = Array.from(bodyEl.querySelectorAll('img'));
    for (const img of imageEls) {
        const src = img.getAttribute('src') || '';
        const resolved = resolveVaultLink(relpath, src);
        if (!resolved) continue;
        if (resolved.type === 'external') {
            img.src = resolved.target;
            continue;
        }
        const ext = (getPathBaseName(resolved.target).split('.').pop() || '').toLowerCase();
        const api = window.electronAPI;
        if (api && api.getVaultFileUrl) {
            const res = await api.getVaultFileUrl(resolved.target);
            if (res.ok) {
                if (ext === 'pdf') {
                    const iframe = document.createElement('iframe');
                    iframe.src = res.url;
                    iframe.title = img.alt || getPathBaseName(resolved.target);
                    img.replaceWith(iframe);
                } else if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'].includes(ext)) {
                    img.src = res.url;
                } else {
                    const btn = document.createElement('a');
                    btn.href = '#';
                    btn.textContent = img.alt || getPathBaseName(resolved.target);
                    btn.onclick = (event) => {
                        event.preventDefault();
                        openGraphReader(btn.textContent, resolved.target);
                    };
                    img.replaceWith(btn);
                }
            }
        }
    }

    // Convert markdown links into in-app navigation for notes/attachments.
    bodyEl.querySelectorAll('a').forEach(a => {
        const href = a.getAttribute('href') || '';
        const resolved = resolveVaultLink(relpath, href);
        if (!resolved) return;
        a.onclick = async (event) => {
            event.preventDefault();
            if (resolved.type === 'external') {
                const api = window.electronAPI;
                if (api && api.openExternal) {
                    await api.openExternal(resolved.target);
                } else {
                    window.open(resolved.target, '_blank', 'noopener');
                }
                return;
            }
            const targetPath = resolved.target;
            const targetTitle = getPathBaseName(targetPath).replace(/\.[^/.]+$/, '');
            openGraphReader(targetTitle || title, targetPath);
        };
    });
}

async function openGraphReader(title, relpath) {
    const panel = document.getElementById('graphReader');
    const titleEl = document.getElementById('graphReaderTitle');
    const body = document.getElementById('graphReaderBody');
    titleEl.textContent = title;
    body.innerHTML = '';
    body.textContent = 'Chargement…';
    body.classList.remove('is-markdown');
    body.style.whiteSpace = 'pre-wrap';
    panel.classList.add('open');

    const ext = relpath.split('.').pop().toLowerCase();
    const imageExts = ['png','jpg','jpeg','gif','svg','webp','bmp','ico'];
    const pdfExts = ['pdf'];
    const textExts = ['md','txt','csv','json','xml','yaml','yml','html','css','js','ts','py'];
    const api = window.electronAPI;

    try {
        // ── Images: inline preview ──
        if (imageExts.includes(ext)) {
            body.textContent = '';
            body.style.whiteSpace = 'normal';
            if (api && api.getVaultFileUrl) {
                const res = await api.getVaultFileUrl(relpath);
                if (res.ok) {
                    const img = document.createElement('img');
                    img.src = res.url;
                    img.alt = title;
                    body.appendChild(img);
                } else {
                    body.textContent = 'Erreur : ' + res.error;
                }
            } else {
                body.textContent = 'Aperçu image non disponible (mode web).';
            }

        // ── PDF: inline embed ──
        } else if (pdfExts.includes(ext)) {
            body.textContent = '';
            body.style.whiteSpace = 'normal';
            if (api && api.getVaultFileUrl) {
                const res = await api.getVaultFileUrl(relpath);
                if (res.ok) {
                    const iframe = document.createElement('iframe');
                    iframe.src = res.url;
                    iframe.title = title;
                    body.appendChild(iframe);
                } else {
                    body.textContent = 'Erreur : ' + res.error;
                }
            } else {
                body.textContent = 'Aperçu PDF non disponible (mode web).';
            }

        // ── Text-based: read content ──
        } else if (textExts.includes(ext)) {
            let data;
            if (api && api.readVaultFile) {
                data = await api.readVaultFile(relpath);
            } else {
                const r = await fetch('/api/vault/read?path=' + encodeURIComponent(relpath));
                data = await r.json();
            }
            if (data.ok) {
                if (ext === 'md') {
                    await renderGraphMarkdown(title, relpath, data.content, body);
                } else {
                    body.classList.remove('is-markdown');
                    body.style.whiteSpace = 'pre-wrap';
                    body.textContent = data.content;
                }
            } else {
                body.textContent = 'Erreur : ' + (data.error || 'fichier introuvable');
            }

        // ── Other formats: open with system default ──
        } else {
            body.textContent = '';
            body.style.whiteSpace = 'normal';
            const msg = document.createElement('div');
            msg.style.cssText = 'text-align:center; padding:2rem 0; color:var(--text-muted); font-size:0.82rem;';
            msg.textContent = 'Pas d\u2019aperçu pour les fichiers .' + ext;
            body.appendChild(msg);
            const btn = document.createElement('button');
            btn.className = 'open-external-btn';
            btn.innerHTML = '<i class="icon-external-link"></i> Ouvrir avec l\u2019application par défaut';
            btn.onclick = async () => {
                if (api && api.openVaultExternal) {
                    const res = await api.openVaultExternal(relpath);
                    if (!res.ok) alert('Erreur : ' + res.error);
                }
            };
            body.appendChild(btn);
        }
    } catch (err) {
        body.textContent = 'Erreur : ' + err.message;
    }
}

function closeGraphReader() {
    const panel = document.getElementById('graphReader');
    if (panel) { panel.classList.remove('open'); panel.style.width = ''; }
    if (d3Sim) {
        const svg = d3.select('#graphSvg');
        const refs = svg.node()?.__d3refs;
        if (refs) clearGraphHighlight(refs.nodes, refs.links);
    }
}

function toggleGraphReaderExpand() {
    const panel = document.getElementById('graphReader');
    if (!panel) return;
    const wrap = panel.parentElement;
    const maxW = wrap.getBoundingClientRect().width;
    const cur = panel.getBoundingClientRect().width;
    panel.style.transition = 'width 0.2s ease';
    if (cur < maxW * 0.7) {
        panel.style.width = '85%';
    } else {
        panel.style.width = '380px';
    }
    setTimeout(() => { panel.style.transition = ''; }, 250);
}

// Resize drag handle for graph reader
(function initGraphReaderResize() {
    let dragging = false, startX = 0, startW = 0;
    document.addEventListener('mousedown', (e) => {
        if (e.target.id !== 'graphReaderResize') return;
        const panel = document.getElementById('graphReader');
        dragging = true;
        startX = e.clientX;
        startW = panel.getBoundingClientRect().width;
        panel.style.transition = 'none';
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const panel = document.getElementById('graphReader');
        const newW = Math.max(260, startW - (e.clientX - startX));
        const maxW = panel.parentElement.getBoundingClientRect().width * 0.85;
        panel.style.width = Math.min(newW, maxW) + 'px';
    });
    document.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
    });
})();

function buildNodeList() {
    const list = document.getElementById('graphNodeList');
    const sorted = [...graphData.nodes].sort((a, b) => a.label.localeCompare(b.label));
    list.innerHTML = '';
    for (const n of sorted) {
        const div = document.createElement('div');
        div.className = 'node-item';
        div.dataset.id = n.id;
        div.dataset.group = n.group;
        div.innerHTML = '<span class="node-type-dot" style="background:' + (GROUP_COLORS[n.group] || '#6c7086') + '"></span>' + esc(n.label);
        div.onclick = () => focusGraphNode(n.id);
        list.appendChild(div);
    }
}

function focusGraphNode(nodeId) {
    const node = graphNodeMap[nodeId];
    if (!node) return;
    // Trigger a search for this node's label to build its subgraph
    const input = document.getElementById('graphSearchInput');
    input.value = node.label;
    filterGraphNodes(node.label);
    // Now focus on the node in the rendered graph
    setTimeout(() => {
        const svg = d3.select('#graphSvg');
        const refs = svg.node()?.__d3refs;
        if (!refs) return;
        const target = refs.nodes.find(n => n.id === nodeId);
        if (!target) return;
        const svgEl = svg.node();
        const rect = svgEl.getBoundingClientRect();
        const transform = d3.zoomIdentity.translate(rect.width / 2, rect.height / 2).scale(2).translate(-target.x, -target.y);
        svg.transition().duration(500).call(d3Zoom.transform, transform);
        onNodeClick(target, refs.nodes, refs.links);
    }, 100);
}

function selectNodeInList(nodeId) {
    document.querySelectorAll('#graphNodeList .node-item').forEach(el => {
        el.classList.toggle('active', el.dataset.id === nodeId);
    });
    // Scroll into view
    const active = document.querySelector('#graphNodeList .node-item.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
}

function updateGraphStats() {
    if (!graphData) return;
    const el = document.getElementById('graphStats');
    const counts = { md: 0, mail: 0, attachment: 0, orphan: 0 };
    graphData.nodes.forEach(n => { counts[n.group] = (counts[n.group] || 0) + 1; });
    el.textContent = counts.md + ' notes · ' + counts.mail + ' mails · ' + counts.attachment + ' fichiers · ' + graphData.edges.length + ' liens';
}

function filterGraphNodes(query) {
    const q = query.toLowerCase().trim();
    const list = document.getElementById('graphNodeList');
    const items = list.querySelectorAll('.node-item');
    let shown = 0;
    items.forEach(el => {
        const match = !q || el.textContent.toLowerCase().includes(q);
        const groupHidden = graphHiddenGroups.has(el.dataset.group);
        const visible = match && !groupHidden;
        el.style.display = visible ? '' : 'none';
        if (visible) shown++;
    });
    document.getElementById('graphSearchResults').textContent = q ? shown + ' résultat(s)' : '';

    // Build filtered subgraph when query >= 2 chars, otherwise show placeholder
    if (q.length >= 2 && graphDataLoaded) {
        buildFilteredGraph(q);
    } else {
        showGraphPlaceholder();
    }
}

function buildFilteredGraph(query) {
    const q = query.toLowerCase();
    // Collect matching node IDs
    const matchIds = new Set();
    graphData.nodes.forEach(n => {
        if (graphHiddenGroups.has(n.group)) return;
        if (n.label.toLowerCase().includes(q)) matchIds.add(n.id);
    });
    // Also include direct neighbors of matched nodes for context
    const neighborIds = new Set(matchIds);
    graphData.edges.forEach(e => {
        if (matchIds.has(e.source)) neighborIds.add(e.target);
        if (matchIds.has(e.target)) neighborIds.add(e.source);
    });
    // Filter out hidden groups from neighbors too
    const visibleIds = new Set();
    neighborIds.forEach(id => {
        const n = graphNodeMap[id];
        if (n && !graphHiddenGroups.has(n.group)) visibleIds.add(id);
    });
    if (visibleIds.size === 0) {
        showGraphPlaceholder();
        return;
    }
    // Build subgraph data
    const subNodes = graphData.nodes.filter(n => visibleIds.has(n.id));
    const subEdges = graphData.edges.filter(e => visibleIds.has(e.source) && visibleIds.has(e.target));
    buildD3Graph(subNodes, subEdges, matchIds);
    document.getElementById('graphPlaceholder').style.display = 'none';
    document.getElementById('graphZoomControls').style.display = '';
}

function toggleGraphGroup(checkbox) {
    const group = checkbox.dataset.group;
    if (checkbox.checked) { graphHiddenGroups.delete(group); }
    else { graphHiddenGroups.add(group); }
    filterGraphNodes(document.getElementById('graphSearchInput').value);
}

function graphZoom(factor) {
    const svg = d3.select('#graphSvg');
    svg.transition().duration(200).call(d3Zoom.scaleBy, factor);
}

function graphFit() {
    const svg = d3.select('#graphSvg');
    const rect = svg.node().getBoundingClientRect();
    svg.transition().duration(400).call(d3Zoom.transform, d3.zoomIdentity.translate(rect.width / 2, rect.height / 2).scale(0.5).translate(-rect.width / 2, -rect.height / 2));
}

/* ═══════════════════════════════════════════════════════
   Leads — CRM avec hiérarchie, tâches, SMS, rappels
   ═══════════════════════════════════════════════════════ */
const ORG_TYPES = {
    association:  { label: 'Association', emoji: '🏛️', color: 'association' },
    organisation: { label: 'Organisation', emoji: '🏢', color: 'organisation' },
    entreprise:   { label: 'Entreprise', emoji: '🏭', color: 'entreprise' },
};

let leadsCurrentView = 'table'; // 'table' | 'dashboard'
let leadsEditingOrgId = null;
let leadsEditingTaskId = null;
let leadsEditingTaskLeadId = null;

function initLeadsState() {
    if (!state.leads) state.leads = { orgs: [], projects: [], team: [] };
    if (!state.leads.orgs) state.leads.orgs = [];
    // Migrate old projects to orgs if needed
    if (state.leads.projects && state.leads.projects.length && !state.leads.orgs.length) {
        state.leads.orgs = state.leads.projects.map(p => ({
            id: p.id, name: p.name, type: 'organisation', description: p.description || '',
            emoji: p.emoji || '🏢', parentId: '', leads: (p.leads || []).map(l => ({
                ...l, role: l.company || '', tasks: [], orgId: p.id
            }))
        }));
        autoSave();
    }
}

function getLeadsOrgs() { return state.leads.orgs; }
function getLeadsOrg(oid) { return getLeadsOrgs().find(o => o.id === oid) || null; }
function getOrgLeads(oid) { const o = getLeadsOrg(oid); return o ? (o.leads || []) : []; }

function getAllLeads() {
    const all = [];
    getLeadsOrgs().forEach(o => {
        (o.leads || []).forEach(l => all.push({ ...l, orgId: o.id, orgName: o.name }));
    });
    return all;
}

function getAllTasks() {
    const all = [];
    getLeadsOrgs().forEach(o => {
        (o.leads || []).forEach(l => {
            (l.tasks || []).forEach(t => all.push({
                ...t, leadId: l.id, leadName: `${l.firstName || ''} ${l.lastName || ''}`.trim(),
                leadPhone: l.phone, orgId: o.id, orgName: o.name
            }));
        });
    });
    return all;
}

/* ── View switcher ────────────────────────────── */
function setLeadsView(view, btn) {
    leadsCurrentView = view;
    document.querySelectorAll('.leads-view-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    document.querySelectorAll('.leads-view-panel').forEach(p => p.classList.remove('active'));
    const panel = document.getElementById(view === 'dashboard' ? 'leadsViewDashboard' : 'leadsViewTable');
    if (panel) panel.classList.add('active');
    if (view === 'dashboard') renderLeadsDashboard();
    else renderLeadsTable();
}

/* ── Render orchestrator ──────────────────────── */
function renderLeads() {
    initLeadsState();
    renderLeadsOrgTree();
    if (leadsCurrentView === 'dashboard') renderLeadsDashboard();
    else renderLeadsTable();
    checkLeadReminders();
}

/* ── Sidebar: Organization tree ───────────────── */
function renderLeadsOrgTree() {
    const tree = document.getElementById('leadsOrgTree');
    if (!tree) return;
    const searchVal = (document.getElementById('leadsOrgSearch')?.value || '').toLowerCase();
    const orgs = getLeadsOrgs().filter(o => !searchVal || (o.name || '').toLowerCase().includes(searchVal));

    if (!orgs.length) {
        tree.innerHTML = '<div style="padding:1rem;color:var(--text-muted);font-size:0.8rem;text-align:center">Aucune organisation.<br>Clique sur « Nouvelle organisation ».</div>';
        return;
    }

    const roots = orgs.filter(o => !o.parentId);
    let html = '';
    function renderNode(org, depth) {
        const indent = depth * 18;
        const isActive = leadsActiveProjectId === org.id;
        const type = ORG_TYPES[org.type] || ORG_TYPES.organisation;
        const leadCount = (org.leads || []).length;
        const taskCount = (org.leads || []).reduce((sum, l) => sum + (l.tasks || []).filter(t => !t.done).length, 0);
        const children = orgs.filter(c => c.parentId === org.id);
        const hasChildren = children.length > 0;

        html += `<div class="leads-org-node ${isActive ? 'active' : ''}" onclick="selectLeadsOrg('${esc(org.id)}')" oncontextmenu="event.preventDefault();openLeadOrgModal('${esc(org.id)}')">
            <span class="org-indent" style="width:${indent}px"></span>
            ${hasChildren ? '<span class="org-toggle">▾</span>' : '<span class="org-toggle" style="visibility:hidden">▾</span>'}
            <span class="org-type-badge ${esc(type.color)}">${type.emoji}</span>
            <span class="org-name">${esc(org.name)}</span>
            <span class="org-counts">
                <span title="${leadCount} lead(s)">${leadCount}<i class="icon-user" style="font-size:0.6rem"></i></span>
                ${taskCount > 0 ? `<span class="org-task-count" title="${taskCount} tâche(s) en cours">${taskCount}<i class="icon-list-checks" style="font-size:0.6rem"></i></span>` : ''}
            </span>
        </div>`;
        children.forEach(c => renderNode(c, depth + 1));
    }
    roots.forEach(r => renderNode(r, 0));
    tree.innerHTML = html;
}

function selectLeadsOrg(oid) {
    leadsActiveProjectId = oid;
    renderLeadsOrgTree();
    renderLeadsTable();
}

/* ── Main: leads table with tasks ─────────────── */
function renderLeadsTable() {
    const wrap = document.getElementById('leadsTableWrap');
    const titleEl = document.getElementById('leadsMainTitle');
    if (!wrap) return;

    const org = getLeadsOrg(leadsActiveProjectId);
    if (!org) {
        wrap.innerHTML = '<div class="leads-empty"><i class="icon-building-2"></i><p>Sélectionne une organisation pour voir ses leads et tâches</p></div>';
        if (titleEl) titleEl.innerHTML = '<i class="icon-building-2"></i> Sélectionne une organisation';
        return;
    }

    const type = ORG_TYPES[org.type] || ORG_TYPES.organisation;
    if (titleEl) titleEl.innerHTML = `${type.emoji} ${esc(org.name)} <span class="lead-role-badge ${esc(type.color)}" style="margin-left:0.3rem">${esc(type.label)}</span>`;

    let leads = (org.leads || []).slice();
    const search = (document.getElementById('leadsSearch')?.value || '').toLowerCase();
    if (search) {
        leads = leads.filter(l =>
            (l.firstName || '').toLowerCase().includes(search) ||
            (l.lastName || '').toLowerCase().includes(search) ||
            (l.role || '').toLowerCase().includes(search) ||
            (l.phone || '').toLowerCase().includes(search) ||
            (l.email || '').toLowerCase().includes(search)
        );
    }

    if (!leads.length) {
        wrap.innerHTML = `<div class="leads-empty"><i class="icon-user-plus"></i><p>Aucun lead dans cette organisation</p><button class="btn-primary" onclick="openLeadModal()" style="margin-top:0.5rem"><i class="icon-user-plus"></i> Ajouter un lead</button></div>`;
        return;
    }

    let html = '';
    leads.forEach(l => {
        const tasks = l.tasks || [];
        const doneTasks = tasks.filter(t => t.done).length;
        const totalTasks = tasks.length;
        const pendingTasks = totalTasks - doneTasks;

        html += `<div class="lead-card">
            <div class="lead-card-header" onclick="openEditLead('${esc(l.id)}')">
                <div class="lead-card-identity">
                    <div class="lead-avatar">${esc((l.firstName || '?')[0])}${esc((l.lastName || '?')[0])}</div>
                    <div>
                        <div class="lead-card-name">${esc(l.firstName || '')} ${esc(l.lastName || '')}</div>
                        <div class="lead-card-role">${esc(l.role || '—')}</div>
                    </div>
                </div>
                <div class="lead-card-meta">
                    ${l.phone ? `<span class="lead-contact-chip"><i class="icon-phone" style="font-size:0.65rem"></i> ${esc(l.phone)}</span>` : ''}
                    ${l.email ? `<span class="lead-contact-chip"><i class="icon-mail" style="font-size:0.65rem"></i> ${esc(l.email)}</span>` : ''}
                    <span class="lead-task-progress ${pendingTasks > 0 ? 'has-pending' : totalTasks > 0 ? 'all-done' : ''}">${doneTasks}/${totalTasks} tâches</span>
                    <button class="btn-icon" onclick="event.stopPropagation();openLeadTaskModalForLead('${esc(l.id)}')" title="Ajouter une tâche"><i class="icon-plus"></i></button>
                    <button class="btn-icon" onclick="event.stopPropagation();sendSingleLeadSms('${esc(l.id)}')" title="SMS"><i class="icon-message-circle"></i></button>
                </div>
            </div>`;

        if (tasks.length) {
            html += `<div class="lead-tasks-list">`;
            tasks.forEach(t => {
                const isDue = t.dueDate && !t.done && new Date(t.dueDate) < new Date();
                const smsStatus = getTaskSmsStatus(t);
                html += `<div class="lead-task-row ${t.done ? 'done' : ''} ${isDue ? 'overdue' : ''}">
                    <input type="checkbox" ${t.done ? 'checked' : ''} onclick="event.stopPropagation();toggleLeadTask('${esc(l.id)}','${esc(t.id)}')" class="lead-task-cb">
                    <span class="lead-task-title" onclick="openEditLeadTask('${esc(l.id)}','${esc(t.id)}')">${esc(t.title)}</span>
                    ${t.dueDate ? `<span class="lead-task-due ${isDue ? 'overdue' : ''}">${new Date(t.dueDate).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' })}</span>` : ''}
                    <span class="lead-task-sms-status ${esc(smsStatus.class)}" title="${esc(smsStatus.tooltip)}">${smsStatus.icon}</span>
                    ${!t.done && t.smsSentAt && !t.smsResponseReceived ? `<button class="btn-icon btn-tiny" onclick="event.stopPropagation();markTaskResponseReceived('${esc(l.id)}','${esc(t.id)}')" title="Marquer comme répondu">✓ Répondu</button>` : ''}
                </div>`;
            });
            html += `</div>`;
        }
        html += `</div>`;
    });

    wrap.innerHTML = html;
}

function getTaskSmsStatus(task) {
    if (!task.smsTemplate) return { class: 'no-sms', icon: '', tooltip: 'Pas de SMS configuré' };
    if (task.smsResponseReceived) return { class: 'sms-responded', icon: '✅', tooltip: 'Réponse reçue' };
    if (task.smsReminderSentAt) return { class: 'sms-reminded', icon: '🔔', tooltip: `Rappel envoyé le ${new Date(task.smsReminderSentAt).toLocaleDateString('fr-FR')}` };
    if (task.smsSentAt) {
        const daysSince = Math.floor((Date.now() - task.smsSentAt) / (1000 * 60 * 60 * 24));
        return { class: 'sms-sent', icon: '📨', tooltip: `SMS envoyé il y a ${daysSince}j — en attente de réponse` };
    }
    return { class: 'sms-pending', icon: '📝', tooltip: 'SMS à envoyer' };
}

/* ── Dashboard: synthesis view ────────────────── */
function renderLeadsDashboard() {
    const wrap = document.getElementById('leadsDashboardWrap');
    if (!wrap) return;

    const allTasks = getAllTasks();
    const allLeads = getAllLeads();
    const orgs = getLeadsOrgs();

    const pendingTasks = allTasks.filter(t => !t.done);
    const doneTasks = allTasks.filter(t => t.done);
    const overdueTasks = pendingTasks.filter(t => t.dueDate && new Date(t.dueDate) < new Date());
    const awaitingResponse = pendingTasks.filter(t => t.smsSentAt && !t.smsResponseReceived);
    const needsReminder = awaitingResponse.filter(t => {
        const daysSince = (Date.now() - t.smsSentAt) / (1000 * 60 * 60 * 24);
        return daysSince >= 3 && !t.smsReminderSentAt;
    });

    let html = `<div class="dash-stats">
        <div class="dash-stat-card">
            <div class="dash-stat-number">${allTasks.length}</div>
            <div class="dash-stat-label">Tâches totales</div>
        </div>
        <div class="dash-stat-card accent-green">
            <div class="dash-stat-number">${doneTasks.length}</div>
            <div class="dash-stat-label">Terminées</div>
        </div>
        <div class="dash-stat-card accent-orange">
            <div class="dash-stat-number">${pendingTasks.length}</div>
            <div class="dash-stat-label">En cours</div>
        </div>
        <div class="dash-stat-card accent-pink">
            <div class="dash-stat-number">${overdueTasks.length}</div>
            <div class="dash-stat-label">En retard</div>
        </div>
        <div class="dash-stat-card accent-blue">
            <div class="dash-stat-number">${awaitingResponse.length}</div>
            <div class="dash-stat-label">En attente de réponse</div>
        </div>
        <div class="dash-stat-card accent-purple">
            <div class="dash-stat-number">${needsReminder.length}</div>
            <div class="dash-stat-label">Rappels à envoyer</div>
        </div>
    </div>`;

    if (needsReminder.length) {
        html += `<div class="dash-section">
            <div class="dash-section-title">🔔 Rappels à envoyer (3j+ sans réponse)</div>
            <button class="btn-primary" onclick="sendAllPendingReminders()" style="margin-bottom:0.5rem;font-size:0.8rem"><i class="icon-send"></i> Envoyer tous les rappels</button>
            <div class="dash-task-list">`;
        needsReminder.forEach(t => {
            const daysSince = Math.floor((Date.now() - t.smsSentAt) / (1000 * 60 * 60 * 24));
            html += `<div class="dash-task-item reminder">
                <div class="dash-task-info">
                    <strong>${esc(t.leadName)}</strong> <span class="text-muted">— ${esc(t.orgName)}</span>
                    <div class="dash-task-title">${esc(t.title)}</div>
                </div>
                <span class="dash-task-badge">${daysSince}j sans réponse</span>
                <button class="btn-icon" onclick="sendTaskReminder('${esc(t.orgId)}','${esc(t.leadId)}','${esc(t.id)}')" title="Envoyer rappel"><i class="icon-send"></i></button>
            </div>`;
        });
        html += `</div></div>`;
    }

    // Pending tasks grouped by org
    if (pendingTasks.length) {
        html += `<div class="dash-section">
            <div class="dash-section-title">📋 Tâches en cours par organisation</div>
            <div class="dash-task-list">`;
        
        const byOrg = {};
        pendingTasks.forEach(t => {
            if (!byOrg[t.orgId]) byOrg[t.orgId] = { name: t.orgName, tasks: [] };
            byOrg[t.orgId].tasks.push(t);
        });

        Object.entries(byOrg).forEach(([orgId, data]) => {
            html += `<div class="dash-org-group">
                <div class="dash-org-header">${esc(data.name)} <span class="text-muted">(${data.tasks.length})</span></div>`;
            data.tasks.forEach(t => {
                const isDue = t.dueDate && new Date(t.dueDate) < new Date();
                const smsStatus = getTaskSmsStatus(t);
                html += `<div class="dash-task-item ${isDue ? 'overdue' : ''}">
                    <input type="checkbox" onclick="toggleLeadTaskById('${esc(t.orgId)}','${esc(t.leadId)}','${esc(t.id)}')" class="lead-task-cb">
                    <div class="dash-task-info">
                        <div class="dash-task-title">${esc(t.title)}</div>
                        <div class="dash-task-assignee"><i class="icon-user" style="font-size:0.6rem"></i> ${esc(t.leadName)} ${t.leadPhone ? `<span class="text-muted">(${esc(t.leadPhone)})</span>` : ''}</div>
                    </div>
                    ${t.dueDate ? `<span class="lead-task-due ${isDue ? 'overdue' : ''}">${new Date(t.dueDate).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' })}</span>` : ''}
                    <span class="lead-task-sms-status ${esc(smsStatus.class)}" title="${esc(smsStatus.tooltip)}">${smsStatus.icon}</span>
                </div>`;
            });
            html += `</div>`;
        });
        html += `</div></div>`;
    }

    // Recently completed
    const recentDone = doneTasks.sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0)).slice(0, 15);
    if (recentDone.length) {
        html += `<div class="dash-section">
            <div class="dash-section-title">✅ Récemment terminées</div>
            <div class="dash-task-list">`;
        recentDone.forEach(t => {
            html += `<div class="dash-task-item done">
                <span class="dash-done-check">✓</span>
                <div class="dash-task-info">
                    <div class="dash-task-title">${esc(t.title)}</div>
                    <div class="dash-task-assignee">${esc(t.leadName)} — ${esc(t.orgName)}${t.doneAt ? ` <span class="text-muted">le ${new Date(t.doneAt).toLocaleDateString('fr-FR')}</span>` : ''}</div>
                </div>
            </div>`;
        });
        html += `</div></div>`;
    }

    if (!allTasks.length) {
        html += `<div class="leads-empty"><i class="icon-list-checks"></i><p>Aucune tâche créée.<br>Ajoute des tâches aux leads pour voir la synthèse.</p></div>`;
    }

    wrap.innerHTML = html;
}

/* ── Task toggle ──────────────────────────────── */
function toggleLeadTask(leadId, taskId) {
    const org = getLeadsOrg(leadsActiveProjectId);
    if (!org) return;
    const lead = (org.leads || []).find(l => l.id === leadId);
    if (!lead) return;
    const task = (lead.tasks || []).find(t => t.id === taskId);
    if (!task) return;
    task.done = !task.done;
    task.doneAt = task.done ? Date.now() : null;
    autoSave();
    renderLeadsTable();
}

function toggleLeadTaskById(orgId, leadId, taskId) {
    const org = getLeadsOrg(orgId);
    if (!org) return;
    const lead = (org.leads || []).find(l => l.id === leadId);
    if (!lead) return;
    const task = (lead.tasks || []).find(t => t.id === taskId);
    if (!task) return;
    task.done = !task.done;
    task.doneAt = task.done ? Date.now() : null;
    autoSave();
    renderLeadsDashboard();
}

function markTaskResponseReceived(leadId, taskId) {
    const org = getLeadsOrg(leadsActiveProjectId);
    if (!org) return;
    const lead = (org.leads || []).find(l => l.id === leadId);
    if (!lead) return;
    const task = (lead.tasks || []).find(t => t.id === taskId);
    if (!task) return;
    task.smsResponseReceived = true;
    if (!lead.history) lead.history = [];
    lead.history.push({ type: 'sms_response', taskId, at: Date.now() });
    autoSave();
    renderLeadsTable();
    showToast('Réponse marquée ✓', 'success');
}

/* ── Rappels automatiques ─────────────────────── */
function checkLeadReminders() {
    const allTasks = getAllTasks();
    const needsReminder = allTasks.filter(t =>
        !t.done && t.smsSentAt && !t.smsResponseReceived && !t.smsReminderSentAt &&
        (Date.now() - t.smsSentAt) / (1000 * 60 * 60 * 24) >= 3
    );
    if (needsReminder.length > 0) {
        showToast(`🔔 ${needsReminder.length} rappel${needsReminder.length > 1 ? 's' : ''} SMS à envoyer (3j+ sans réponse) !`, 'error', 5000);
    }
    const overdue = allTasks.filter(t => !t.done && t.dueDate && new Date(t.dueDate) < new Date());
    if (overdue.length > 0) {
        showToast(`⚠️ ${overdue.length} tâche${overdue.length > 1 ? 's' : ''} en retard !`, 'error', 4000);
    }
}

setInterval(() => {
    if (currentTab === 'leads') checkLeadReminders();
}, 5 * 60 * 1000);

/* ── Send reminders ───────────────────────────── */
function sendTaskReminder(orgId, leadId, taskId) {
    const org = getLeadsOrg(orgId);
    if (!org) return;
    const lead = (org.leads || []).find(l => l.id === leadId);
    if (!lead || !lead.phone) return showToast('Ce lead n\'a pas de numéro.', 'error');
    const task = (lead.tasks || []).find(t => t.id === taskId);
    if (!task) return;

    const reminderMsg = task.smsTemplate
        ? `Rappel : ${interpolateTaskSms(task.smsTemplate, lead, org, task)}`
        : `Bonjour ${lead.firstName || ''}, ceci est un rappel concernant : ${task.title}. Merci de me recontacter.`;

    const phoneClean = lead.phone.replace(/[\s\-()]/g, '').replace(/^0/, '33');
    const waUrl = `https://wa.me/${phoneClean}?text=${encodeURIComponent(reminderMsg)}`;
    if (window.electronAPI?.openExternal) window.electronAPI.openExternal(waUrl);
    else window.open(waUrl, '_blank');

    task.smsReminderSentAt = Date.now();
    if (!lead.history) lead.history = [];
    lead.history.push({ type: 'sms_reminder', taskId, message: reminderMsg, at: Date.now() });
    autoSave();
    showToast('Rappel SMS préparé ✓', 'success');
    if (leadsCurrentView === 'dashboard') renderLeadsDashboard();
    else renderLeadsTable();
}

function sendAllPendingReminders() {
    const allTasks = getAllTasks();
    const needsReminder = allTasks.filter(t =>
        !t.done && t.smsSentAt && !t.smsResponseReceived && !t.smsReminderSentAt &&
        (Date.now() - t.smsSentAt) / (1000 * 60 * 60 * 24) >= 3
    );
    if (!needsReminder.length) return showToast('Aucun rappel à envoyer.', 'success');
    let sent = 0;
    needsReminder.forEach(t => {
        sendTaskReminder(t.orgId, t.leadId, t.id);
        sent++;
    });
    showToast(`${sent} rappel${sent > 1 ? 's' : ''} préparé${sent > 1 ? 's' : ''}.`, 'success');
}

/* ── Organization Modal ───────────────────────── */
function openLeadOrgModal(editId) {
    leadsEditingOrgId = editId || null;
    const m = document.getElementById('leadOrgModal');
    populateOrgParentSelect(editId);

    if (editId) {
        const o = getLeadsOrg(editId);
        if (!o) return;
        document.getElementById('leadOrgModalTitle').innerHTML = '<i class="icon-building-2"></i> Modifier l\'organisation';
        document.getElementById('leadOrgName').value = o.name || '';
        document.getElementById('leadOrgType').value = o.type || 'organisation';
        document.getElementById('leadOrgParent').value = o.parentId || '';
        document.getElementById('leadOrgDesc').value = o.description || '';
        document.getElementById('leadOrgDeleteBtn').style.display = '';
    } else {
        document.getElementById('leadOrgModalTitle').innerHTML = '<i class="icon-building-2"></i> Nouvelle organisation';
        document.getElementById('leadOrgName').value = '';
        document.getElementById('leadOrgType').value = 'association';
        document.getElementById('leadOrgParent').value = '';
        document.getElementById('leadOrgDesc').value = '';
        document.getElementById('leadOrgDeleteBtn').style.display = 'none';
    }
    m.classList.add('show');
}

function closeLeadOrgModal() {
    document.getElementById('leadOrgModal').classList.remove('show');
    leadsEditingOrgId = null;
}

function populateOrgParentSelect(excludeId) {
    const sel = document.getElementById('leadOrgParent');
    const orgs = getLeadsOrgs().filter(o => o.id !== excludeId);
    sel.innerHTML = '<option value="">Aucune (racine)</option>' + orgs.map(o => {
        const type = ORG_TYPES[o.type] || ORG_TYPES.organisation;
        return `<option value="${esc(o.id)}">${type.emoji} ${esc(o.name)}</option>`;
    }).join('');
}

function saveLeadOrg() {
    const name = (document.getElementById('leadOrgName').value || '').trim();
    if (!name) return showToast('Nom requis.', 'error');
    const type = document.getElementById('leadOrgType').value || 'organisation';
    const parentId = document.getElementById('leadOrgParent').value || '';
    const description = (document.getElementById('leadOrgDesc').value || '').trim();

    initLeadsState();
    if (leadsEditingOrgId) {
        const o = getLeadsOrg(leadsEditingOrgId);
        if (o) { o.name = name; o.type = type; o.parentId = parentId; o.description = description; }
    } else {
        const id = 'org-' + uid();
        state.leads.orgs.push({ id, name, type, parentId, description, leads: [] });
        leadsActiveProjectId = id;
    }
    autoSave();
    closeLeadOrgModal();
    renderLeads();
}

function deleteLeadOrg() {
    if (!leadsEditingOrgId) return;
    const org = getLeadsOrg(leadsEditingOrgId);
    if (!org || !confirm(`Supprimer "${org.name}" et tous ses leads ?`)) return;
    // Reassign children
    getLeadsOrgs().forEach(o => {
        if (o.parentId === leadsEditingOrgId) o.parentId = org.parentId || '';
    });
    state.leads.orgs = state.leads.orgs.filter(o => o.id !== leadsEditingOrgId);
    if (leadsActiveProjectId === leadsEditingOrgId) leadsActiveProjectId = null;
    autoSave();
    closeLeadOrgModal();
    renderLeads();
}

/* ── Lead Modal ───────────────────────────────── */
function openLeadModal(editId) {
    leadsEditingId = editId || null;
    const m = document.getElementById('leadModal');
    populateLeadOrgSelect();

    if (editId) {
        let lead = null, orgId = null;
        getLeadsOrgs().forEach(o => {
            const l = (o.leads || []).find(l => l.id === editId);
            if (l) { lead = l; orgId = o.id; }
        });
        if (!lead) return;
        document.getElementById('leadModalTitle').innerHTML = '<i class="icon-user"></i> Modifier le lead';
        document.getElementById('leadFirstName').value = lead.firstName || '';
        document.getElementById('leadLastName').value = lead.lastName || '';
        document.getElementById('leadPhone').value = lead.phone || '';
        document.getElementById('leadEmail').value = lead.email || '';
        document.getElementById('leadRole').value = lead.role || '';
        document.getElementById('leadOrg').value = orgId || '';
        document.getElementById('leadNotes').value = lead.notes || '';
        document.getElementById('leadDeleteBtn').style.display = '';
    } else {
        document.getElementById('leadModalTitle').innerHTML = '<i class="icon-user-plus"></i> Ajouter un lead';
        document.getElementById('leadFirstName').value = '';
        document.getElementById('leadLastName').value = '';
        document.getElementById('leadPhone').value = '';
        document.getElementById('leadEmail').value = '';
        document.getElementById('leadRole').value = '';
        document.getElementById('leadOrg').value = leadsActiveProjectId || '';
        document.getElementById('leadNotes').value = '';
        document.getElementById('leadDeleteBtn').style.display = 'none';
    }
    m.classList.add('show');
}

function closeLeadModal() {
    document.getElementById('leadModal').classList.remove('show');
    leadsEditingId = null;
}

function populateLeadOrgSelect() {
    const sel = document.getElementById('leadOrg');
    const orgs = getLeadsOrgs();
    sel.innerHTML = '<option value="">— Sélectionner —</option>' + orgs.map(o => {
        const type = ORG_TYPES[o.type] || ORG_TYPES.organisation;
        return `<option value="${esc(o.id)}">${type.emoji} ${esc(o.name)}</option>`;
    }).join('');
}

function saveLeadFromModal() {
    const orgId = document.getElementById('leadOrg').value;
    if (!orgId) return showToast('Sélectionne une organisation.', 'error');
    const org = getLeadsOrg(orgId);
    if (!org) return;

    const firstName = (document.getElementById('leadFirstName').value || '').trim();
    const lastName = (document.getElementById('leadLastName').value || '').trim();
    if (!firstName && !lastName) return showToast('Nom ou prénom requis.', 'error');

    const phone = (document.getElementById('leadPhone').value || '').trim();
    const email = (document.getElementById('leadEmail').value || '').trim();
    const role = (document.getElementById('leadRole').value || '').trim();
    const notes = (document.getElementById('leadNotes').value || '').trim();

    if (!org.leads) org.leads = [];

    if (leadsEditingId) {
        // Find and update lead (may have moved orgs)
        let lead = null, oldOrg = null;
        getLeadsOrgs().forEach(o => {
            const l = (o.leads || []).find(l => l.id === leadsEditingId);
            if (l) { lead = l; oldOrg = o; }
        });
        if (lead) {
            Object.assign(lead, { firstName, lastName, phone, email, role, notes, updatedAt: Date.now() });
            // Move to new org if changed
            if (oldOrg && oldOrg.id !== orgId) {
                oldOrg.leads = oldOrg.leads.filter(l => l.id !== leadsEditingId);
                org.leads.push(lead);
            }
        }
    } else {
        org.leads.push({
            id: 'lead-' + uid(), firstName, lastName, phone, email, role, notes, tasks: [],
            createdAt: Date.now(), updatedAt: Date.now(), history: [{ type: 'created', at: Date.now() }]
        });
    }

    autoSave();
    closeLeadModal();
    renderLeads();
}

function openEditLead(leadId) {
    openLeadModal(leadId);
}

function deleteLead() {
    if (!leadsEditingId) return;
    let lead = null, org = null;
    getLeadsOrgs().forEach(o => {
        const l = (o.leads || []).find(l => l.id === leadsEditingId);
        if (l) { lead = l; org = o; }
    });
    if (!lead || !org || !confirm(`Supprimer ${lead.firstName} ${lead.lastName} ?`)) return;
    org.leads = org.leads.filter(l => l.id !== leadsEditingId);
    autoSave();
    closeLeadModal();
    renderLeads();
}

/* ── Task Modal ───────────────────────────────── */
function openLeadTaskModal() {
    leadsEditingTaskId = null;
    leadsEditingTaskLeadId = null;
    const m = document.getElementById('leadTaskModal');
    document.getElementById('leadTaskModalTitle').innerHTML = '<i class="icon-list-checks"></i> Nouvelle tâche';
    document.getElementById('leadTaskTitle').value = '';
    document.getElementById('leadTaskDesc').value = '';
    document.getElementById('leadTaskDueDate').value = '';
    document.getElementById('leadTaskSmsTemplate').value = '';
    document.getElementById('leadTaskAutoSms').checked = true;
    document.getElementById('leadTaskAutoReminder').checked = true;
    document.getElementById('leadTaskDeleteBtn').style.display = 'none';
    populateTaskAssigneeSelect();
    m.classList.add('show');
}

function openLeadTaskModalForLead(leadId) {
    openLeadTaskModal();
    document.getElementById('leadTaskAssignee').value = leadId;
}

function openEditLeadTask(leadId, taskId) {
    leadsEditingTaskId = taskId;
    leadsEditingTaskLeadId = leadId;

    const org = getLeadsOrg(leadsActiveProjectId);
    if (!org) return;
    const lead = (org.leads || []).find(l => l.id === leadId);
    if (!lead) return;
    const task = (lead.tasks || []).find(t => t.id === taskId);
    if (!task) return;

    document.getElementById('leadTaskModalTitle').innerHTML = '<i class="icon-list-checks"></i> Modifier la tâche';
    document.getElementById('leadTaskTitle').value = task.title || '';
    document.getElementById('leadTaskDesc').value = task.description || '';
    document.getElementById('leadTaskDueDate').value = task.dueDate || '';
    document.getElementById('leadTaskSmsTemplate').value = task.smsTemplate || '';
    document.getElementById('leadTaskAutoSms').checked = !!task.autoSms;
    document.getElementById('leadTaskAutoReminder').checked = task.autoReminder !== false;
    document.getElementById('leadTaskDeleteBtn').style.display = '';
    populateTaskAssigneeSelect();
    document.getElementById('leadTaskAssignee').value = leadId;
    document.getElementById('leadTaskModal').classList.add('show');
}

function closeLeadTaskModal() {
    document.getElementById('leadTaskModal').classList.remove('show');
    leadsEditingTaskId = null;
    leadsEditingTaskLeadId = null;
}

function populateTaskAssigneeSelect() {
    const sel = document.getElementById('leadTaskAssignee');
    const leads = leadsActiveProjectId ? getOrgLeads(leadsActiveProjectId) : getAllLeads();
    sel.innerHTML = '<option value="">— Sélectionner un lead —</option>' + leads.map(l =>
        `<option value="${esc(l.id)}">${esc(l.firstName || '')} ${esc(l.lastName || '')}${l.phone ? ' (' + esc(l.phone) + ')' : ''}</option>`
    ).join('');
}

function saveLeadTask() {
    const title = (document.getElementById('leadTaskTitle').value || '').trim();
    if (!title) return showToast('Titre requis.', 'error');
    const leadId = document.getElementById('leadTaskAssignee').value;
    if (!leadId) return showToast('Sélectionne un lead.', 'error');

    const description = (document.getElementById('leadTaskDesc').value || '').trim();
    const dueDate = document.getElementById('leadTaskDueDate').value || '';
    const smsTemplate = (document.getElementById('leadTaskSmsTemplate').value || '').trim();
    const autoSmsChecked = document.getElementById('leadTaskAutoSms').checked;
    const autoReminder = document.getElementById('leadTaskAutoReminder').checked;

    // Find the lead across all orgs
    let lead = null, org = null;
    getLeadsOrgs().forEach(o => {
        const l = (o.leads || []).find(l => l.id === leadId);
        if (l) { lead = l; org = o; }
    });
    if (!lead || !org) return showToast('Lead introuvable.', 'error');
    if (!lead.tasks) lead.tasks = [];

    if (leadsEditingTaskId && leadsEditingTaskLeadId) {
        // Editing existing task
        const oldLead = (getLeadsOrg(leadsActiveProjectId)?.leads || []).find(l => l.id === leadsEditingTaskLeadId);
        if (oldLead) {
            const task = (oldLead.tasks || []).find(t => t.id === leadsEditingTaskId);
            if (task) {
                Object.assign(task, { title, description, dueDate, smsTemplate, autoSms: autoSmsChecked, autoReminder });
                // If reassigned to different lead, move the task
                if (leadsEditingTaskLeadId !== leadId) {
                    oldLead.tasks = oldLead.tasks.filter(t => t.id !== leadsEditingTaskId);
                    lead.tasks.push(task);
                }
            }
        }
    } else {
        const taskId = 'task-' + uid();
        const newTask = {
            id: taskId, title, description, dueDate, smsTemplate,
            autoSms: autoSmsChecked, autoReminder,
            done: false, smsSentAt: null, smsReminderSentAt: null, smsResponseReceived: false,
            createdAt: Date.now(), doneAt: null
        };
        lead.tasks.push(newTask);

        // Auto-send SMS if enabled and template provided
        if (autoSmsChecked && smsTemplate && lead.phone) {
            const msg = interpolateTaskSms(smsTemplate, lead, org, newTask);
            const phoneClean = lead.phone.replace(/[\s\-()]/g, '').replace(/^0/, '33');
            const waUrl = `https://wa.me/${phoneClean}?text=${encodeURIComponent(msg)}`;
            if (window.electronAPI?.openExternal) window.electronAPI.openExternal(waUrl);
            else window.open(waUrl, '_blank');
            newTask.smsSentAt = Date.now();
            if (!lead.history) lead.history = [];
            lead.history.push({ type: 'sms', taskId, message: msg, at: Date.now() });
            showToast('Message WhatsApp prêt à envoyer ✓', 'success');
        }
    }

    autoSave();
    closeLeadTaskModal();
    renderLeads();
}

function deleteLeadTask() {
    if (!leadsEditingTaskId || !leadsEditingTaskLeadId) return;
    const org = getLeadsOrg(leadsActiveProjectId);
    if (!org) return;
    const lead = (org.leads || []).find(l => l.id === leadsEditingTaskLeadId);
    if (!lead) return;
    if (!confirm('Supprimer cette tâche ?')) return;
    lead.tasks = (lead.tasks || []).filter(t => t.id !== leadsEditingTaskId);
    autoSave();
    closeLeadTaskModal();
    renderLeads();
}

function interpolateTaskSms(tpl, lead, org, task) {
    return tpl
        .replace(/\{prenom\}/gi, lead.firstName || '')
        .replace(/\{nom\}/gi, lead.lastName || '')
        .replace(/\{org\}/gi, org.name || '')
        .replace(/\{tache\}/gi, task.title || '');
}

/* ── SMS Modal (bulk) ─────────────────────────── */
function openLeadSmsModal() {
    const org = getLeadsOrg(leadsActiveProjectId);
    if (!org) return showToast('Sélectionne une organisation d\'abord.', 'error');
    const withPhone = (org.leads || []).filter(l => l.phone);
    if (!withPhone.length) return showToast('Aucun lead avec numéro de téléphone.', 'error');
    document.getElementById('smsRecipientsSummary').textContent = `${withPhone.length} destinataire(s) — ${org.name}`;
    document.getElementById('leadSmsModal').dataset.leadIds = JSON.stringify(withPhone.map(l => l.id));
    document.getElementById('leadSmsModal').dataset.orgId = org.id;
    document.getElementById('smsMessageTemplate').value = '';
    document.getElementById('smsPreview').textContent = '—';
    document.getElementById('leadSmsModal').classList.add('show');
}

function sendSingleLeadSms(leadId) {
    const org = getLeadsOrg(leadsActiveProjectId);
    if (!org) return;
    const lead = (org.leads || []).find(l => l.id === leadId);
    if (!lead || !lead.phone) return showToast('Ce lead n\'a pas de numéro.', 'error');
    document.getElementById('smsRecipientsSummary').textContent = `1 destinataire : ${lead.firstName} ${lead.lastName} (${lead.phone})`;
    document.getElementById('leadSmsModal').dataset.leadIds = JSON.stringify([leadId]);
    document.getElementById('leadSmsModal').dataset.orgId = org.id;
    document.getElementById('smsMessageTemplate').value = '';
    document.getElementById('smsPreview').textContent = '—';
    document.getElementById('leadSmsModal').classList.add('show');
}

function closeLeadSmsModal() {
    document.getElementById('leadSmsModal').classList.remove('show');
}

function previewSmsMessage() {
    const tpl = document.getElementById('smsMessageTemplate').value || '';
    const leadIdsRaw = document.getElementById('leadSmsModal').dataset.leadIds;
    const orgId = document.getElementById('leadSmsModal').dataset.orgId;
    let ids = [];
    try { ids = JSON.parse(leadIdsRaw || '[]'); } catch {}
    const org = getLeadsOrg(orgId);
    if (!org || !ids.length) { document.getElementById('smsPreview').textContent = '—'; return; }
    const first = (org.leads || []).find(l => l.id === ids[0]);
    if (!first) { document.getElementById('smsPreview').textContent = '—'; return; }
    document.getElementById('smsPreview').textContent = tpl
        .replace(/\{prenom\}/gi, first.firstName || '')
        .replace(/\{nom\}/gi, first.lastName || '')
        .replace(/\{org\}/gi, org.name || '')
        .replace(/\{tache\}/gi, '(tâche)');
}

function sendLeadsSms() {
    const tpl = (document.getElementById('smsMessageTemplate').value || '').trim();
    if (!tpl) return showToast('Message requis.', 'error');
    const leadIdsRaw = document.getElementById('leadSmsModal').dataset.leadIds;
    const orgId = document.getElementById('leadSmsModal').dataset.orgId;
    let ids = [];
    try { ids = JSON.parse(leadIdsRaw || '[]'); } catch {}
    const org = getLeadsOrg(orgId);
    if (!org || !ids.length) return;

    const logActivity = document.getElementById('smsLogActivity')?.checked !== false;
    let sentCount = 0;

    ids.forEach(id => {
        const lead = (org.leads || []).find(l => l.id === id);
        if (!lead || !lead.phone) return;
        const msg = tpl
            .replace(/\{prenom\}/gi, lead.firstName || '')
            .replace(/\{nom\}/gi, lead.lastName || '')
            .replace(/\{org\}/gi, org.name || '')
            .replace(/\{tache\}/gi, '');

        const phoneClean = lead.phone.replace(/[\s\-()]/g, '').replace(/^0/, '33');
        const waUrl = `https://wa.me/${phoneClean}?text=${encodeURIComponent(msg)}`;
        if (window.electronAPI?.openExternal) window.electronAPI.openExternal(waUrl);
        else window.open(waUrl, '_blank');

        if (logActivity) {
            if (!lead.history) lead.history = [];
            lead.history.push({ type: 'sms', message: msg, at: Date.now() });
        }
        sentCount++;
    });

    if (sentCount) {
        autoSave();
        showToast(`${sentCount} message${sentCount > 1 ? 's' : ''} WhatsApp prêt${sentCount > 1 ? 's' : ''} à envoyer.`, 'success');
    }
    closeLeadSmsModal();
    renderLeads();
}

/* ═══════════════════════════════════════════════════════
   Site Tabs — Dynamic favourite-site tabs with persistent sessions
   ═══════════════════════════════════════════════════════ */
function getBrowserApi() {
    return window.electronAPI || null;
}

function ensureUrlWithScheme(raw) {
    const v = String(raw || '').trim();
    if (!v) return 'https://www.google.com';
    if (/^https?:\/\//i.test(v)) return v;
    return 'https://' + v;
}

function hostFromAnyUrl(raw) {
    const input = String(raw || '').trim();
    if (!input) return '';
    try {
        const u = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
        return (u.hostname || '').toLowerCase();
    } catch {
        return '';
    }
}

/* ── Persistence ──────────────────────────────── */
function saveSiteTabs() {
    try {
        localStorage.setItem(SITE_TABS_STORAGE_KEY, JSON.stringify(siteTabs));
    } catch {}
}

function loadSiteTabs() {
    try {
        const raw = localStorage.getItem(SITE_TABS_STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter(t => t && t.id && t.url) : [];
    } catch {
        return [];
    }
}

function getSiteTab(tabId) {
    return siteTabs.find(t => t.id === tabId) || null;
}

/* ── Tab-bar rendering ────────────────────────── */
function renderSiteTabButtons() {
    const container = document.getElementById('siteTabButtons');
    if (!container) return;
    container.innerHTML = siteTabs.map(t => {
        const icon = esc(t.icon || 'icon-globe');
        const label = esc(t.label || hostFromAnyUrl(t.url) || 'Site');
        const isActive = currentTab === t.id;
        return `<button class="tab-btn ${isActive ? 'active' : ''}" data-tab="${esc(t.id)}" onclick="switchTab('${esc(t.id)}')" title="${esc(t.url)}"><i class="${icon}"></i><span class="tab-btn-label">${label}</span></button>`;
    }).join('');
}

/* ── Modal: add / edit site ───────────────────── */
let editingSiteTabId = null;

function openAddSiteModal() {
    editingSiteTabId = null;
    document.getElementById('siteTabModalTitle').innerHTML = '<i class="icon-globe"></i> Ajouter un site';
    document.getElementById('siteTabLabel').value = '';
    document.getElementById('siteTabUrl').value = '';
    document.getElementById('siteTabIcon').value = '';
    document.getElementById('siteTabModal').classList.add('show');
}

function openEditSiteModal() {
    const tab = getSiteTab(currentTab);
    if (!tab) return;
    editingSiteTabId = tab.id;
    document.getElementById('siteTabModalTitle').innerHTML = '<i class="icon-settings"></i> Modifier le site';
    document.getElementById('siteTabLabel').value = tab.label || '';
    document.getElementById('siteTabUrl').value = tab.url || '';
    document.getElementById('siteTabIcon').value = tab.icon || '';
    document.getElementById('siteTabModal').classList.add('show');
}

function closeSiteTabModal() {
    document.getElementById('siteTabModal').classList.remove('show');
    editingSiteTabId = null;
}

function saveSiteTabFromModal() {
    const label = (document.getElementById('siteTabLabel').value || '').trim();
    const url = ensureUrlWithScheme(document.getElementById('siteTabUrl').value || '');
    const icon = (document.getElementById('siteTabIcon').value || '').trim() || 'icon-globe';

    if (!label) return showToast('Nom d\'onglet requis.', 'error');
    if (!url || url === 'https://www.google.com' && !document.getElementById('siteTabUrl').value.trim()) {
        return showToast('URL du site requise.', 'error');
    }

    const api = getBrowserApi();

    if (editingSiteTabId) {
        const tab = getSiteTab(editingSiteTabId);
        if (tab) {
            const urlChanged = ensureUrlWithScheme(tab.url) !== url;
            tab.label = label;
            tab.url = url;
            tab.icon = icon;
            saveSiteTabs();
            renderSiteTabButtons();
            if (urlChanged && siteTabsInitialized[tab.id] && api && api.browserNavigate) {
                api.browserNavigate({ tabId: tab.id, url });
            }
        }
    } else {
        const id = 'site-' + uid();
        siteTabs.push({ id, label, url, icon });
        saveSiteTabs();
        renderSiteTabButtons();
        switchTab(id);
    }

    closeSiteTabModal();
}

async function removeSiteTab(tabId) {
    const tab = getSiteTab(tabId);
    if (!tab) return;
    if (!confirm(`Supprimer l'onglet "${tab.label}" ?`)) return;

    const api = getBrowserApi();
    siteTabs = siteTabs.filter(t => t.id !== tabId);
    delete siteTabsInitialized[tabId];
    saveSiteTabs();

    // Close the BrowserView in main process
    if (api && api.browserCloseTab) await api.browserCloseTab(tabId);

    renderSiteTabButtons();
    if (currentTab === tabId) switchTab('todo');
}

/* ── BrowserView lifecycle per site tab ───────── */
async function initSiteTabView(tabId) {
    const api = getBrowserApi();
    if (!api || !api.browserCreateTab) return;
    bindBrowserEventsIfNeeded();

    const tab = getSiteTab(tabId);
    if (!tab) return;

    if (!siteTabsInitialized[tabId]) {
        siteTabsInitialized[tabId] = true;
        await api.browserCreateTab({ tabId, url: tab.url, activate: true });
    } else {
        await api.browserActivateTab(tabId);
    }

    // Update address bar
    const addr = document.getElementById('siteTabAddress');
    if (addr) addr.value = tab.url || '';

    updateSiteTabViewVisibility();
}

function updateSiteTabViewVisibility() {
    const api = getBrowserApi();
    if (!api || !api.browserSetVisible) return;
    const isSiteTab = currentTab.startsWith('site-');
    api.browserSetVisible(isSiteTab).then(() => {
        if (!isSiteTab) return;
        if (siteTabsInitialized[currentTab]) {
            api.browserActivateTab(currentTab).then(() => updateSiteTabViewBounds());
        }
    });
}

function updateSiteTabViewBounds() {
    const api = getBrowserApi();
    if (!api || !api.browserSetBounds) return;
    const host = document.getElementById('siteTabViewport');
    if (!host) return;
    const rect = host.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 20) return;
    api.browserSetBounds({
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
    });
}

window.addEventListener('resize', () => {
    if (currentTab.startsWith('site-')) updateSiteTabViewBounds();
});
document.getElementById('app-content').addEventListener('scroll', () => {
    if (currentTab.startsWith('site-')) updateSiteTabViewBounds();
});

/* ── Navigation toolbar actions ───────────────── */
async function siteTabNavigateAddress() {
    const api = getBrowserApi();
    const input = document.getElementById('siteTabAddress');
    if (!api || !input || !currentTab.startsWith('site-')) return;
    const targetUrl = ensureUrlWithScheme(input.value);
    await api.browserNavigate({ tabId: currentTab, url: targetUrl });
}

async function siteTabGoBack() {
    const api = getBrowserApi();
    if (!api || !currentTab.startsWith('site-')) return;
    await api.browserGoBack(currentTab);
}

async function siteTabGoForward() {
    const api = getBrowserApi();
    if (!api || !currentTab.startsWith('site-')) return;
    await api.browserGoForward(currentTab);
}

async function siteTabReload() {
    const api = getBrowserApi();
    if (!api || !currentTab.startsWith('site-')) return;
    await api.browserReload(currentTab);
}

/* ── IPC event listener ───────────────────────── */
function bindBrowserEventsIfNeeded() {
    if (browserEventsBound) return;
    const api = getBrowserApi();
    if (!api || !api.onBrowserTabUpdated) return;
    api.onBrowserTabUpdated((payload) => {
        const tabId = payload?.tabId;
        if (!tabId) return;
        // Update address bar if this is the active site tab
        if (tabId === currentTab && currentTab.startsWith('site-')) {
            const addr = document.getElementById('siteTabAddress');
            if (addr && typeof payload.url === 'string') addr.value = payload.url;
        }
    });
    browserEventsBound = true;
}

/* ── Startup restore ──────────────────────────── */
function initSiteTabs() {
    siteTabs = loadSiteTabs();
    renderSiteTabButtons();
}

/* ═══════════════════════════════════════════════════════
   Agenda Google (Calendar API)
   ═══════════════════════════════════════════════════════ */
function startOfWeek(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    const day = d.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + diff);
    return d;
}

function toYmd(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function addDaysYmd(ymd, deltaDays) {
    const d = new Date(`${ymd}T00:00:00`);
    d.setDate(d.getDate() + deltaDays);
    return toYmd(d);
}

function hexToRgba(hex, alpha) {
    const value = String(hex || '').trim();
    const full = value.startsWith('#') ? value.slice(1) : value;
    const normalized = full.length === 3 ? full.split('').map((c) => c + c).join('') : full;
    if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return `rgba(137, 180, 250, ${alpha})`;
    const r = parseInt(normalized.slice(0, 2), 16);
    const g = parseInt(normalized.slice(2, 4), 16);
    const b = parseInt(normalized.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function toLocalDateTimeValue(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const h = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    return `${y}-${m}-${d}T${h}:${min}`;
}

function agendaEventKey(ev) {
    return `${ev.calendarId || 'primary'}::${ev.id || ''}`;
}

function findAgendaEventByKey(key) {
    return (agendaEventsCache || []).find((ev) => agendaEventKey(ev) === key) || null;
}

async function initAgendaIfNeeded() {
    agendaWeekStart = startOfWeek(agendaWeekStart || new Date());
    if (!agendaInitialized) {
        agendaInitialized = true;
        await loadAgendaAccounts();
    }
    await loadAgendaCalendars();
    await loadAgendaWeek();
}

async function onAgendaAccountChange() {
    await loadAgendaCalendars();
    await loadAgendaWeek();
}

async function loadAgendaAccounts() {
    const select = document.getElementById('agendaAccount');
    if (!select) return;
    select.innerHTML = '<option value="">Chargement…</option>';
    try {
        const r = await fetch('/api/calendar/accounts');
        const accounts = await r.json();
        if (!Array.isArray(accounts) || !accounts.length) {
            select.innerHTML = '<option value="">Aucun compte OAuth Google</option>';
            return;
        }
        const prev = select.value;
        select.innerHTML = accounts.map((a) => {
            const status = a.connected ? 'connecte' : 'a connecter';
            return `<option value="${esc(a.email)}">${esc(a.email)} (${status})</option>`;
        }).join('');
        if (prev && accounts.some((a) => a.email === prev)) select.value = prev;
    } catch {
        select.innerHTML = '<option value="">Erreur de chargement</option>';
    }
}

async function loadAgendaCalendars() {
    const account = (document.getElementById('agendaAccount')?.value || '').trim();
    if (!account) {
        agendaCalendars = [];
        agendaSelectedCalendarIds = [];
        renderAgendaCalendarFilters();
        return;
    }
    try {
        const r = await fetch(`/api/calendar/calendars?account=${encodeURIComponent(account)}`);
        const result = await r.json();
        if (!result.ok) throw new Error(result.error || 'Erreur agenda');

        agendaCalendars = Array.isArray(result.calendars) ? result.calendars : [];
        const ids = new Set(agendaCalendars.map((c) => c.id));
        agendaSelectedCalendarIds = (agendaSelectedCalendarIds || []).filter((id) => ids.has(id));
        if (!agendaSelectedCalendarIds.length) {
            agendaSelectedCalendarIds = agendaCalendars.filter((c) => c.selected !== false).map((c) => c.id);
        }
        if (!agendaSelectedCalendarIds.length) {
            agendaSelectedCalendarIds = agendaCalendars.map((c) => c.id);
        }
    } catch {
        agendaCalendars = [];
        agendaSelectedCalendarIds = [];
    }
    renderAgendaCalendarFilters();
}

function renderAgendaCalendarFilters() {
    const container = document.getElementById('agendaCalendarFilters');
    if (!container) return;
    if (!agendaCalendars.length) {
        container.innerHTML = '';
        return;
    }

    container.innerHTML = agendaCalendars.map((cal) => {
        const active = agendaSelectedCalendarIds.includes(cal.id);
        return `<button class="agenda-cal-chip ${active ? 'active' : ''}" onclick="toggleAgendaCalendarFilter('${encodeURIComponent(cal.id)}')">
            <span class="dot" style="background:${esc(cal.backgroundColor || '#6c8aff')}"></span>
            ${esc(cal.summary || cal.id)}
        </button>`;
    }).join('');
}

function toggleAgendaCalendarFilter(encodedId) {
    const id = decodeURIComponent(encodedId || '');
    const current = new Set(agendaSelectedCalendarIds || []);
    if (current.has(id)) current.delete(id);
    else current.add(id);
    agendaSelectedCalendarIds = [...current];
    if (!agendaSelectedCalendarIds.length) agendaSelectedCalendarIds = agendaCalendars.map((c) => c.id);
    renderAgendaCalendarFilters();
    loadAgendaWeek();
}

async function connectAgendaOAuth() {
    const select = document.getElementById('agendaAccount');
    const email = (select?.value || '').trim();
    if (!email) {
        showToast('Selectionne un compte Google OAuth.', 'error');
        return;
    }
    showLoading('Ouverture de la connexion Google pour Agenda...');
    try {
        const scope = 'https://mail.google.com/ https://www.googleapis.com/auth/calendar';
        const r = await fetch('/api/oauth/google/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, scope })
        });
        const result = await r.json();
        if (!result.ok || !result.auth_url) {
            showToast('Erreur OAuth: ' + (result.error || 'URL manquante'), 'error', 5000);
            return;
        }
        const opened = window.electronAPI && window.electronAPI.openExternal
            ? await window.electronAPI.openExternal(result.auth_url)
            : false;
        if (!opened) window.open(result.auth_url, '_blank', 'noopener');
        showToast('Connexion Google Agenda ouverte.', 'success', 3000);
    } catch (e) {
        showToast('Erreur OAuth Agenda: ' + e.message, 'error', 5000);
    } finally {
        hideLoading();
    }
}

function agendaPrevWeek() {
    agendaWeekStart = new Date(agendaWeekStart.getFullYear(), agendaWeekStart.getMonth(), agendaWeekStart.getDate() - 7);
    agendaWeekStart = startOfWeek(agendaWeekStart);
    loadAgendaWeek();
}

function agendaNextWeek() {
    agendaWeekStart = new Date(agendaWeekStart.getFullYear(), agendaWeekStart.getMonth(), agendaWeekStart.getDate() + 7);
    agendaWeekStart = startOfWeek(agendaWeekStart);
    loadAgendaWeek();
}

function agendaToday() {
    agendaWeekStart = startOfWeek(new Date());
    loadAgendaWeek();
}

function buildAgendaWeekDays(weekStartDate) {
    const days = [];
    for (let i = 0; i < 7; i++) {
        const d = new Date(weekStartDate);
        d.setDate(weekStartDate.getDate() + i);
        d.setHours(0, 0, 0, 0);
        days.push(d);
    }
    return days;
}

function splitTimedEventIntoWeekDays(ev, weekDays) {
    const out = [];
    const start = ev.start ? new Date(ev.start) : null;
    const endRaw = ev.end ? new Date(ev.end) : null;
    if (!start || isNaN(start.getTime())) return out;
    const end = endRaw && !isNaN(endRaw.getTime()) ? endRaw : new Date(start.getTime() + 30 * 60 * 1000);
    const sameDayEvent = start.toDateString() === end.toDateString();

    weekDays.forEach((day) => {
        const dayStart = new Date(day);
        const dayEnd = new Date(day);
        dayEnd.setDate(dayEnd.getDate() + 1);
        const segStart = start > dayStart ? start : dayStart;
        const segEnd = end < dayEnd ? end : dayEnd;
        if (segEnd <= segStart) return;

        const startMin = segStart.getHours() * 60 + segStart.getMinutes();
        const endMin = segEnd.getHours() * 60 + segEnd.getMinutes();
        out.push({
            event: ev,
            dayKey: toYmd(day),
            startMin,
            endMin: Math.max(endMin, startMin + 15),
            movable: sameDayEvent && !!ev.canEdit,
        });
    });
    return out;
}

function handleAgendaCardClick(evt, encodedEventKey) {
    if (Date.now() < agendaPointerSuppressClickUntil) {
        evt.preventDefault();
        evt.stopPropagation();
        return;
    }
    openAgendaEventModal(encodedEventKey);
}

function renderAgendaWeek(events) {
    const container = document.getElementById('agendaEvents');
    if (!container) return;

    const weekStartDate = startOfWeek(agendaWeekStart || new Date());
    const weekDays = buildAgendaWeekDays(weekStartDate);
    const todayYmd = toYmd(new Date());
    const allDayByDay = {};
    const timedByDay = {};
    weekDays.forEach((d) => {
        allDayByDay[toYmd(d)] = [];
        timedByDay[toYmd(d)] = [];
    });

    (events || []).forEach((ev) => {
        if (ev.allDay) {
            const startDate = ev.start ? new Date(`${ev.start}T00:00:00`) : null;
            const endDate = ev.end ? new Date(`${ev.end}T00:00:00`) : null;
            if (!startDate || isNaN(startDate.getTime())) return;
            const rangeEnd = endDate && !isNaN(endDate.getTime()) ? endDate : new Date(startDate.getTime() + 24 * 60 * 60 * 1000);

            weekDays.forEach((day) => {
                const key = toYmd(day);
                if (day >= startDate && day < rangeEnd) allDayByDay[key].push(ev);
            });
        } else {
            splitTimedEventIntoWeekDays(ev, weekDays).forEach((segment) => timedByDay[segment.dayKey].push(segment));
        }
    });

    const weekHeader = weekDays.map((day) => {
        const key = toYmd(day);
        const cls = key === todayYmd ? 'day today' : 'day';
        const weekday = day.toLocaleDateString('fr-FR', { weekday: 'short' });
        const dayLabel = day.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });
        return `<div class="${cls}">${esc(weekday)}<strong>${esc(dayLabel)}</strong></div>`;
    }).join('');

    const allDayRow = weekDays.map((day) => {
        const key = toYmd(day);
        const cards = allDayByDay[key].map((ev) => {
            const k = encodeURIComponent(agendaEventKey(ev));
            const bg = hexToRgba(ev.calendarColor || '#6c8aff', 0.2);
            const border = ev.calendarColor || '#6c8aff';
            const text = ev.calendarTextColor || 'var(--text)';
            return `<div class="agenda-event-card all-day" style="background:${esc(bg)};border-color:${esc(border)};color:${esc(text)}" onclick="handleAgendaCardClick(event, '${k}')">
                <strong>${esc(ev.summary || '(Sans titre)')}</strong>
                <div class="agenda-event-meta">${esc(ev.calendarName || 'Agenda')} • Journee entiere</div>
            </div>`;
        }).join('');
        return `<div class="agenda-all-day-cell">${cards}</div>`;
    }).join('');

    const hours = Array.from({ length: 24 }, (_, i) => i);
    const hoursHtml = hours.map((h) => `<div class="agenda-hour-slot">${String(h).padStart(2, '0')}:00</div>`).join('');

    const dayColumns = weekDays.map((day) => {
        const key = toYmd(day);
        const cls = key === todayYmd ? 'agenda-day-column today' : 'agenda-day-column';
        const segments = (timedByDay[key] || []).sort((a, b) => a.startMin - b.startMin);
        const eventsHtml = segments.map((segment) => {
            const k = encodeURIComponent(agendaEventKey(segment.event));
            const top = Math.max(0, (segment.startMin / 60) * 48);
            const duration = Math.max(18, ((segment.endMin - segment.startMin) / 60) * 48);
            const startLabel = `${String(Math.floor(segment.startMin / 60)).padStart(2, '0')}:${String(segment.startMin % 60).padStart(2, '0')}`;
            const endLabel = `${String(Math.floor(segment.endMin / 60)).padStart(2, '0')}:${String(segment.endMin % 60).padStart(2, '0')}`;
            const bg = hexToRgba(segment.event.calendarColor || '#6c8aff', 0.2);
            const border = segment.event.calendarColor || '#6c8aff';
            const text = segment.event.calendarTextColor || 'var(--text)';
            const ro = segment.movable ? '' : 'readonly';
            const handles = segment.movable ? '<div class="agenda-resize-handle top"></div><div class="agenda-resize-handle bottom"></div>' : '';
            return `<div class="agenda-event-card timed ${ro}" data-event-key="${k}" style="top:${top}px;height:${duration}px;border-color:${esc(border)};background:${esc(bg)};color:${esc(text)}" onclick="handleAgendaCardClick(event, '${k}')">${handles}
                <strong>${esc(segment.event.summary || '(Sans titre)')}</strong>
                <div class="agenda-event-meta">${esc(startLabel)} - ${esc(endLabel)} • ${esc(segment.event.calendarName || 'Agenda')}</div>
            </div>`;
        }).join('');
        return `<div class="${cls}" data-day-key="${key}">${eventsHtml}</div>`;
    }).join('');

    container.innerHTML = `
        <div class="agenda-week-header">
            <div class="agenda-time-label">Heure</div>
            ${weekHeader}
        </div>
        <div class="agenda-all-day-row">
            <div class="agenda-all-day-label">Toute la journee</div>
            ${allDayRow}
        </div>
        <div class="agenda-week-grid-wrap">
            <div class="agenda-time-grid">
                <div class="agenda-hours-column">${hoursHtml}</div>
                ${dayColumns}
            </div>
        </div>
        ${(events || []).length ? '' : '<div class="agenda-empty-state">Aucun evenement cette semaine.</div>'}
    `;

    bindAgendaInteractions();
}

function bindAgendaInteractions() {
    const cards = document.querySelectorAll('.agenda-event-card.timed:not(.readonly)');
    const dayColumns = [...document.querySelectorAll('.agenda-day-column')];
    const pxQuarter = 12;

    cards.forEach((card) => {
        card.onmousedown = (evt) => {
            if (evt.button !== 0) return;
            const topHandle = evt.target.closest('.agenda-resize-handle.top');
            const bottomHandle = evt.target.closest('.agenda-resize-handle.bottom');
            const mode = topHandle ? 'resize-top' : (bottomHandle ? 'resize-bottom' : 'move');
            const dayCol = card.closest('.agenda-day-column');
            if (!dayCol) return;

            const key = decodeURIComponent(card.dataset.eventKey || '');
            const ev = findAgendaEventByKey(key);
            if (!ev || !ev.canEdit) return;

            agendaInteractionState = {
                mode,
                card,
                key,
                sourceDayKey: dayCol.dataset.dayKey,
                targetDayKey: dayCol.dataset.dayKey,
                startY: evt.clientY,
                originalTop: parseFloat(card.style.top || '0') || 0,
                originalHeight: parseFloat(card.style.height || '24') || 24,
                changed: false,
            };
            card.classList.add(mode === 'move' ? 'dragging' : 'resizing');
            evt.preventDefault();
        };
    });

    document.onmousemove = (evt) => {
        const s = agendaInteractionState;
        if (!s) return;
        const dy = evt.clientY - s.startY;
        const gridMax = 24 * 48;

        if (s.mode === 'move') {
            let top = s.originalTop + dy;
            top = Math.max(0, Math.min(gridMax - s.originalHeight, Math.round(top / pxQuarter) * pxQuarter));
            if (Math.abs(top - s.originalTop) > 0.1) s.changed = true;
            s.card.style.top = `${top}px`;

            dayColumns.forEach((c) => c.classList.remove('drag-target'));
            const over = document.elementFromPoint(evt.clientX, evt.clientY);
            const overCol = over ? over.closest('.agenda-day-column') : null;
            if (overCol && overCol.dataset.dayKey) {
                s.targetDayKey = overCol.dataset.dayKey;
                overCol.classList.add('drag-target');
                if (s.targetDayKey !== s.sourceDayKey) s.changed = true;
            }
        } else if (s.mode === 'resize-top') {
            let top = s.originalTop + dy;
            let height = s.originalHeight - dy;
            if (height < pxQuarter) {
                height = pxQuarter;
                top = s.originalTop + (s.originalHeight - pxQuarter);
            }
            top = Math.max(0, Math.round(top / pxQuarter) * pxQuarter);
            height = Math.min(gridMax - top, Math.max(pxQuarter, Math.round(height / pxQuarter) * pxQuarter));
            if (Math.abs(top - s.originalTop) > 0.1 || Math.abs(height - s.originalHeight) > 0.1) s.changed = true;
            s.card.style.top = `${top}px`;
            s.card.style.height = `${height}px`;
        } else {
            let height = s.originalHeight + dy;
            const top = parseFloat(s.card.style.top || '0') || 0;
            height = Math.min(gridMax - top, Math.max(pxQuarter, Math.round(height / pxQuarter) * pxQuarter));
            if (Math.abs(height - s.originalHeight) > 0.1) s.changed = true;
            s.card.style.height = `${height}px`;
        }
    };

    document.onmouseup = async () => {
        const s = agendaInteractionState;
        if (!s) return;
        dayColumns.forEach((c) => c.classList.remove('drag-target'));
        s.card.classList.remove('dragging', 'resizing');

        const top = parseFloat(s.card.style.top || '0') || 0;
        const height = parseFloat(s.card.style.height || '24') || 24;
        const startMin = Math.max(0, Math.min(24 * 60 - 15, Math.round(top / pxQuarter) * 15));
        const endMin = Math.min(24 * 60, startMin + Math.max(15, Math.round(height / pxQuarter) * 15));
        const dayKey = s.targetDayKey || s.sourceDayKey;
        const changed = s.changed;
        const key = s.key;
        agendaInteractionState = null;
        if (!changed) return;

        agendaPointerSuppressClickUntil = Date.now() + 220;
        await persistAgendaTimedChange(key, dayKey, startMin, endMin);
    };
}

function dayKeyMinutesToLocal(dayKey, minutes) {
    const d = new Date(`${dayKey}T00:00:00`);
    d.setMinutes(minutes);
    return toLocalDateTimeValue(d);
}

function showAgendaApiError(result, fallbackMessage) {
    const code = (result && result.error_code) || '';
    if (code === 'CALENDAR_SCOPE_INSUFFICIENT') {
        showToast('Le compte OAuth doit etre reconnecte avec les droits Agenda. Clique sur "Connecter Google".', 'error', 6500);
        return;
    }
    if (code === 'CALENDAR_EVENT_FORBIDDEN') {
        showToast('Modification refusee par Google: evenement non modifiable avec ce compte.', 'error', 6500);
        return;
    }
    if (code === 'CALENDAR_API_DISABLED') {
        showToast('Google Calendar API desactivee sur le projet Google Cloud.', 'error', 6500);
        return;
    }
    showToast('Erreur: ' + esc((result && (result.error || result.details)) || fallbackMessage), 'error', 5000);
}

async function persistAgendaTimedChange(key, dayKey, startMin, endMin) {
    const ev = findAgendaEventByKey(key);
    if (!ev) return;
    const account = (document.getElementById('agendaAccount')?.value || '').trim();
    if (!account) return;

    showLoading('Mise a jour de l\'evenement...');
    try {
        const r = await fetch('/api/calendar/events/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                account,
                calendarId: ev.calendarId || 'primary',
                eventId: ev.id,
                allDay: false,
                startDateTime: dayKeyMinutesToLocal(dayKey, startMin),
                endDateTime: dayKeyMinutesToLocal(dayKey, endMin),
            })
        });
        const result = await r.json();
        if (!result.ok) {
            showAgendaApiError(result, 'mise a jour impossible');
            await loadAgendaWeek();
            return;
        }
        await loadAgendaWeek();
        showToast('Evenement deplace/mis a jour.', 'success');
    } catch (e) {
        showToast('Erreur reseau: ' + e.message, 'error', 5000);
        await loadAgendaWeek();
    } finally {
        hideLoading();
    }
}

function formatAgendaEventPeriod(ev) {
    if (ev.allDay) {
        const start = ev.start || '';
        const endInclusive = ev.end ? addDaysYmd(ev.end, -1) : start;
        return `${start} (journee entiere${endInclusive && endInclusive !== start ? ` jusqu'au ${endInclusive}` : ''})`;
    }
    const start = ev.start ? new Date(ev.start) : null;
    const end = ev.end ? new Date(ev.end) : null;
    const startLabel = start && !isNaN(start.getTime()) ? start.toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'short' }) : ev.start;
    const endLabel = end && !isNaN(end.getTime()) ? end.toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'short' }) : ev.end;
    return `${startLabel} -> ${endLabel}`;
}

async function loadAgendaWeek() {
    const monthLabel = document.getElementById('agendaMonthLabel');
    const countLabel = document.getElementById('agendaCountLabel');
    const container = document.getElementById('agendaEvents');
    const select = document.getElementById('agendaAccount');
    if (!monthLabel || !countLabel || !container || !select) return;

    const account = (select.value || '').trim();
    agendaWeekStart = startOfWeek(agendaWeekStart || new Date());
    const weekEnd = new Date(agendaWeekStart);
    weekEnd.setDate(agendaWeekStart.getDate() + 6);
    const weekEndExclusive = new Date(agendaWeekStart);
    weekEndExclusive.setDate(agendaWeekStart.getDate() + 7);
    monthLabel.textContent = `${agendaWeekStart.toLocaleDateString('fr-FR', { day: '2-digit', month: 'long' })} - ${weekEnd.toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' })}`;

    if (!account) {
        container.innerHTML = '<div class="agenda-empty-state">Aucun compte Google OAuth disponible.</div>';
        countLabel.textContent = '0 evenement';
        return;
    }

    container.innerHTML = '<div class="agenda-empty-state">Chargement des evenements...</div>';
    try {
        const start = toYmd(agendaWeekStart);
        const end = toYmd(weekEndExclusive);
        const cals = encodeURIComponent((agendaSelectedCalendarIds || []).join(','));
        const r = await fetch(`/api/calendar/events?start=${start}&end=${end}&account=${encodeURIComponent(account)}&calendars=${cals}`);
        const result = await r.json();
        if (!result.ok) {
            if (result.error_code === 'CALENDAR_SCOPE_INSUFFICIENT') {
                container.innerHTML = '<div class="agenda-empty-state">Le compte OAuth doit etre reconnecte avec les droits Agenda. Clique sur "Connecter Google".</div>';
                countLabel.textContent = '0 evenement';
                return;
            }
            container.innerHTML = '<div class="agenda-empty-state">Erreur: ' + esc(result.error || result.details || 'impossible de charger') + '</div>';
            countLabel.textContent = '0 evenement';
            return;
        }
        const events = Array.isArray(result.events) ? result.events : [];
        agendaCalendars = Array.isArray(result.calendars) ? result.calendars : agendaCalendars;
        if (!agendaSelectedCalendarIds.length && agendaCalendars.length) {
            agendaSelectedCalendarIds = agendaCalendars.map((c) => c.id);
        }
        renderAgendaCalendarFilters();
        agendaEventsCache = events;
        countLabel.textContent = `${events.length} evenement${events.length > 1 ? 's' : ''}`;
        renderAgendaWeek(events);
    } catch (e) {
        container.innerHTML = '<div class="agenda-empty-state">Erreur reseau: ' + esc(e.message) + '</div>';
        countLabel.textContent = '0 evenement';
    }
}

function openAgendaCreateModal() {
    const modal = document.getElementById('agendaCreateModal');
    if (!modal) return;
    const createSelect = document.getElementById('agendaCreateCalendar');
    if (createSelect) {
        const cals = agendaCalendars.length ? agendaCalendars : [{ id: 'primary', summary: 'Agenda principal' }];
        createSelect.innerHTML = cals.map((c) => `<option value="${esc(c.id)}">${esc(c.summary || c.id)}</option>`).join('');
        createSelect.value = agendaSelectedCalendarIds[0] || cals[0].id;
    }
    const baseDate = agendaWeekStart || startOfWeek(new Date());
    document.getElementById('agendaCreateSummary').value = '';
    document.getElementById('agendaCreateDate').value = toYmd(baseDate);
    document.getElementById('agendaCreateStartTime').value = '09:00';
    document.getElementById('agendaCreateEndTime').value = '10:00';
    document.getElementById('agendaCreateLocation').value = '';
    document.getElementById('agendaCreateDescription').value = '';
    document.getElementById('agendaCreateAllDay').checked = false;
    toggleAgendaCreateAllDay();
    modal.classList.add('show');
}

function closeAgendaCreateModal() {
    document.getElementById('agendaCreateModal')?.classList.remove('show');
}

function toggleAgendaCreateAllDay() {
    const allDay = !!document.getElementById('agendaCreateAllDay')?.checked;
    const timeGroup = document.getElementById('agendaCreateTimeGroup');
    if (timeGroup) timeGroup.style.display = allDay ? 'none' : 'flex';
}

async function createAgendaEvent() {
    const account = (document.getElementById('agendaAccount')?.value || '').trim();
    if (!account) return showToast('Selectionne un compte Agenda.', 'error');

    const summary = (document.getElementById('agendaCreateSummary')?.value || '').trim();
    const calendarId = (document.getElementById('agendaCreateCalendar')?.value || '').trim() || 'primary';
    const date = (document.getElementById('agendaCreateDate')?.value || '').trim();
    const allDay = !!document.getElementById('agendaCreateAllDay')?.checked;
    const startTime = (document.getElementById('agendaCreateStartTime')?.value || '').trim();
    const endTime = (document.getElementById('agendaCreateEndTime')?.value || '').trim();
    const location = (document.getElementById('agendaCreateLocation')?.value || '').trim();
    const description = (document.getElementById('agendaCreateDescription')?.value || '').trim();
    if (!summary) return showToast('Le titre est requis.', 'error');
    if (!date) return showToast('La date est requise.', 'error');

    let payload = { account, calendarId, summary, location, description };
    if (allDay) {
        payload.allDay = true;
        payload.startDate = date;
        payload.endDate = addDaysYmd(date, 1);
    } else {
        if (!startTime || !endTime) return showToast('Heure de debut et fin requises.', 'error');
        const startDt = new Date(`${date}T${startTime}`);
        const endDt = new Date(`${date}T${endTime}`);
        if (isNaN(startDt.getTime()) || isNaN(endDt.getTime()) || endDt <= startDt) return showToast('Plage horaire invalide.', 'error');
        payload.allDay = false;
        payload.startDateTime = toLocalDateTimeValue(startDt);
        payload.endDateTime = toLocalDateTimeValue(endDt);
    }

    showLoading('Creation de l\'evenement...');
    try {
        const r = await fetch('/api/calendar/events', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const result = await r.json();
        if (!result.ok) return showAgendaApiError(result, 'impossible de creer');
        closeAgendaCreateModal();
        await loadAgendaWeek();
        showToast('Evenement cree.', 'success');
    } catch (e) {
        showToast('Erreur reseau: ' + e.message, 'error', 5000);
    } finally {
        hideLoading();
    }
}

function openAgendaEventModal(encodedEventKey) {
    const eventKey = decodeURIComponent(encodedEventKey || '');
    const ev = findAgendaEventByKey(eventKey);
    if (!ev) return;
    selectedAgendaEventId = eventKey;

    document.getElementById('agendaEventTitleInput').value = ev.summary || '';
    document.getElementById('agendaEventAllDay').checked = !!ev.allDay;
    document.getElementById('agendaEventLocation').value = ev.location || '';
    document.getElementById('agendaEventDescription').value = ev.description || '';

    if (ev.allDay) {
        document.getElementById('agendaEventDate').value = ev.start || '';
    } else {
        const start = ev.start ? new Date(ev.start) : null;
        const end = ev.end ? new Date(ev.end) : null;
        if (start && !isNaN(start.getTime())) {
            document.getElementById('agendaEventDate').value = toYmd(start);
            document.getElementById('agendaEventStartTime').value = `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`;
        }
        if (end && !isNaN(end.getTime())) {
            document.getElementById('agendaEventEndTime').value = `${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`;
        }
    }
    toggleAgendaEventAllDay();

    const badge = document.getElementById('agendaEventCalendarBadge');
    badge.innerHTML = `<span class="dot" style="background:${esc(ev.calendarColor || '#6c8aff')}"></span>${esc(ev.calendarName || ev.calendarId || 'Agenda')}`;

    const canEdit = !!ev.canEdit;
    ['agendaEventTitleInput', 'agendaEventAllDay', 'agendaEventDate', 'agendaEventStartTime', 'agendaEventEndTime', 'agendaEventLocation', 'agendaEventDescription'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.disabled = !canEdit;
    });
    document.getElementById('agendaEventSaveBtn').style.display = canEdit ? '' : 'none';
    document.getElementById('agendaEventDeleteBtn').style.display = canEdit ? '' : 'none';
    document.getElementById('agendaEventModal').classList.add('show');
}

function closeAgendaEventModal() {
    selectedAgendaEventId = null;
    document.getElementById('agendaEventModal')?.classList.remove('show');
}

function toggleAgendaEventAllDay() {
    const allDay = !!document.getElementById('agendaEventAllDay')?.checked;
    const group = document.getElementById('agendaEventTimeGroup');
    if (group) group.style.display = allDay ? 'none' : 'flex';
}

async function saveSelectedAgendaEvent() {
    const ev = selectedAgendaEventId ? findAgendaEventByKey(selectedAgendaEventId) : null;
    if (!ev) return;
    const account = (document.getElementById('agendaAccount')?.value || '').trim();
    if (!account) return showToast('Selectionne un compte Agenda.', 'error');

    const summary = (document.getElementById('agendaEventTitleInput')?.value || '').trim();
    const allDay = !!document.getElementById('agendaEventAllDay')?.checked;
    const date = (document.getElementById('agendaEventDate')?.value || '').trim();
    const startTime = (document.getElementById('agendaEventStartTime')?.value || '').trim();
    const endTime = (document.getElementById('agendaEventEndTime')?.value || '').trim();
    const location = (document.getElementById('agendaEventLocation')?.value || '').trim();
    const description = (document.getElementById('agendaEventDescription')?.value || '').trim();
    if (!summary) return showToast('Le titre est requis.', 'error');
    if (!date) return showToast('La date est requise.', 'error');

    let payload = {
        account,
        calendarId: ev.calendarId || 'primary',
        eventId: ev.id,
        summary,
        location,
        description,
    };
    if (allDay) {
        payload.allDay = true;
        payload.startDate = date;
        payload.endDate = addDaysYmd(date, 1);
    } else {
        if (!startTime || !endTime) return showToast('Heure de debut et fin requises.', 'error');
        const startDt = new Date(`${date}T${startTime}`);
        const endDt = new Date(`${date}T${endTime}`);
        if (isNaN(startDt.getTime()) || isNaN(endDt.getTime()) || endDt <= startDt) return showToast('Plage horaire invalide.', 'error');
        payload.allDay = false;
        payload.startDateTime = toLocalDateTimeValue(startDt);
        payload.endDateTime = toLocalDateTimeValue(endDt);
    }

    showLoading('Enregistrement de l\'evenement...');
    try {
        const r = await fetch('/api/calendar/events/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const result = await r.json();
        if (!result.ok) return showAgendaApiError(result, 'mise a jour impossible');
        closeAgendaEventModal();
        await loadAgendaWeek();
        showToast('Evenement modifie.', 'success');
    } catch (e) {
        showToast('Erreur reseau: ' + e.message, 'error', 5000);
    } finally {
        hideLoading();
    }
}

function openSelectedAgendaEvent() {
    const ev = selectedAgendaEventId ? findAgendaEventByKey(selectedAgendaEventId) : null;
    if (!ev || !ev.htmlLink) return;
    openAgendaEvent(ev.htmlLink);
}

async function deleteSelectedAgendaEvent() {
    const ev = selectedAgendaEventId ? findAgendaEventByKey(selectedAgendaEventId) : null;
    if (!ev) return;
    if (!confirm(`Supprimer l'evenement "${ev.summary || '(Sans titre)'}" ?`)) return;

    const account = (document.getElementById('agendaAccount')?.value || '').trim();
    if (!account) return showToast('Selectionne un compte Agenda.', 'error');

    showLoading('Suppression de l\'evenement...');
    try {
        const r = await fetch('/api/calendar/events/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ account, calendarId: ev.calendarId || 'primary', eventId: ev.id })
        });
        const result = await r.json();
        if (!result.ok) return showAgendaApiError(result, 'impossible de supprimer');
        closeAgendaEventModal();
        await loadAgendaWeek();
        showToast('Evenement supprime.', 'success');
    } catch (e) {
        showToast('Erreur reseau: ' + e.message, 'error', 5000);
    } finally {
        hideLoading();
    }
}

async function openAgendaEvent(url) {
    const api = window.electronAPI;
    if (api && api.openExternal) {
        const ok = await api.openExternal(url);
        if (ok) return;
    }
    window.open(url, '_blank', 'noopener');
}

/* ═══════════════════════════════════════════════════════
   Keyboard Shortcuts
   ═══════════════════════════════════════════════════════ */
document.addEventListener('keydown', (e) => {
    // Ctrl+E — toggle edit mode
    if ((e.ctrlKey || e.metaKey) && e.key === 'e') {
        e.preventDefault();
        toggleEdit();
    }
    // Ctrl+1 — switch to Todo tab
    if ((e.ctrlKey || e.metaKey) && e.key === '1') {
        e.preventDefault();
        switchTab('todo');
    }
    // Ctrl+2 — switch to Inbox tab
    if ((e.ctrlKey || e.metaKey) && e.key === '2') {
        e.preventDefault();
        switchTab('inbox');
    }
    // Ctrl+3 — switch to Mail tab
    if ((e.ctrlKey || e.metaKey) && e.key === '3') {
        e.preventDefault();
        switchTab('mail');
    }
    // Ctrl+4 — switch to Graph tab
    if ((e.ctrlKey || e.metaKey) && e.key === '4') {
        e.preventDefault();
        switchTab('graph');
    }
    // Ctrl+5 — switch to Agenda tab
    if ((e.ctrlKey || e.metaKey) && e.key === '5') {
        e.preventDefault();
        switchTab('agenda');
    }
    // Ctrl+6 — switch to Leads tab
    if ((e.ctrlKey || e.metaKey) && e.key === '6') {
        e.preventDefault();
        switchTab('leads');
    }
    // Ctrl+7..9 — switch to site tabs (dynamic)
    if ((e.ctrlKey || e.metaKey) && ['7','8','9'].includes(e.key)) {
        const idx = parseInt(e.key) - 7;
        if (siteTabs[idx]) {
            e.preventDefault();
            switchTab(siteTabs[idx].id);
        }
    }
    // Ctrl+N — new section (when in edit mode)
    if ((e.ctrlKey || e.metaKey) && e.key === 'n' && editMode) {
        e.preventDefault();
        openSectionModal();
    }
    // Escape — close modals
    if (e.key === 'Escape') {
        closeSectionModal();
        closeSettings();
        closeGraphReader();
        if (typeof closeReminderModal === 'function') closeReminderModal();
        if (typeof closeAccountsModal === 'function') closeAccountsModal();
        if (typeof closeDeleteMailModal === 'function') closeDeleteMailModal();
        if (typeof closeAgendaCreateModal === 'function') closeAgendaCreateModal();
        if (typeof closeAgendaEventModal === 'function') closeAgendaEventModal();
        if (typeof closeLeadOrgModal === 'function') closeLeadOrgModal();
        if (typeof closeLeadModal === 'function') closeLeadModal();
        if (typeof closeLeadTaskModal === 'function') closeLeadTaskModal();
        if (typeof closeLeadSmsModal === 'function') closeLeadSmsModal();
    }
    // Delete — delete selected inbox mail
    if (e.key === 'Delete' && currentTab === 'inbox' && selectedInboxId) {
        openDeleteMailModal(selectedInboxId);
    }
});
