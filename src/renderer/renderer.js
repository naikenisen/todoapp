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
let composerReplyContext = null;
let leadsFilter = 'all';
let respondedMailsExpanded = false;
let appInstallConfig = null;
let neo4jDockerConfig = null;
let neo4jDockerLastActionError = '';
let neo4jDockerLastStatus = null;

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
        updateSiteTabCredentialUI();
    } else {
        const el = document.getElementById('tab-' + tab);
        if (el) el.classList.add('active');
    }
    if (tab === 'mail') renderMailTab();
    if (tab === 'inbox') loadInbox();
    if (tab === 'mailchat') checkChatbotStatus();
    if (tab === 'archive') loadArchiveMails();
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
    if (!state.archives) state.archives = [];
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
        + (editMode ? '<button class="add-section-btn" onclick="openSectionModal()">+ Nouvelle section</button>' : '')
        + renderArchives();
    updateProgress();
    setupDragDrop();
    window.scrollTo(0, scrollY);
}

function renderHeader() {
    return `
    <header>
        <div class="header-actions">
            <button onclick="toggleEdit()" class="${editMode ? 'active' : ''}">
                ${editMode ? '<i class="icon-check"></i> Terminer' : '<i class="icon-pencil"></i> Éditer'}
            </button>
        </div>
    </header>`;
}

function renderProgress() {
    const hasCompleted = state.sections.some(s => s.tasks.some(t => t.done));
    const archiveBtn = hasCompleted
        ? `<button class="btn-archive-progress" onclick="archiveCompletedTasks()" title="Archiver les tâches terminées et repartir à zéro"><i class="icon-archive"></i> Reset &amp; Archiver</button>`
        : '';
    return `
    <div class="global-progress">
        <div class="global-progress-header">
            <span>Progression globale</span>
            <div class="global-progress-right">
                ${archiveBtn}
                <span class="counter"><strong id="gDone">0</strong> / <span id="gTotal">0</span> tâches</span>
            </div>
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
                    ${esc(s.title)}
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
   Archive Operations
   ═══════════════════════════════════════════════════════ */
let archivesExpanded = false;

function renderArchives() {
    const archives = state.archives || [];
    if (!archives.length) return '';
    const totalArchived = archives.reduce((n, a) => n + a.tasks.length, 0);
    const batchesHtml = archives.slice().reverse().map(a => {
        const d = new Date(a.date);
        const dateStr = d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
        const tasksHtml = a.tasks.map(t => {
            const isMail = t.type === 'mail' || t.isMail;
            const mailBadge = isMail ? '<span class="archive-mail-badge">mail</span>' : '';
            const restoreBtn = editMode
                ? `<button class="btn-icon btn-restore" onclick="restoreFromArchive('${a.id}','${t.id}')" title="Restaurer"><i class="icon-rotate-ccw"></i></button>`
                : '';
            return `<div class="archive-task">
                <span class="archive-task-label">${esc(t.label)}</span>
                ${mailBadge}
                <span class="archive-task-section" style="border-color:${COLOR_HEX[t.sectionColor] || '#94a3b8'}">${esc(t.sectionTitle || '')}</span>
                ${restoreBtn}
            </div>`;
        }).join('');
        return `<div class="archive-batch">
            <div class="archive-batch-date">${dateStr} — ${a.tasks.length} tâche${a.tasks.length > 1 ? 's' : ''}</div>
            ${tasksHtml}
        </div>`;
    }).join('');
    return `
    <div class="archives-section">
        <div class="archives-header" onclick="archivesExpanded=!archivesExpanded;render()">
            <span class="archives-toggle">${archivesExpanded ? '▾' : '▸'}</span>
            <span>Archives</span>
            <span class="archives-count">${totalArchived} tâche${totalArchived > 1 ? 's' : ''}</span>
        </div>
        ${archivesExpanded ? `<div class="archives-body">${batchesHtml}</div>` : ''}
    </div>`;
}

function restoreFromArchive(archiveId, taskId) {
    const archives = state.archives || [];
    const archive = archives.find(a => a.id === archiveId);
    if (!archive) return;
    const task = archive.tasks.find(t => t.id === taskId);
    if (!task) return;
    // Find the original section or use the first one
    const origSection = state.sections.find(s => s.title === task.sectionTitle);
    const targetSection = origSection || state.sections[0];
    if (!targetSection) return;
    // Restore task (remove archive metadata)
    const restored = { ...task, done: false };
    delete restored.sectionTitle;
    delete restored.sectionColor;
    delete restored.archivedAt;
    targetSection.tasks.push(restored);
    // Remove from archive
    archive.tasks = archive.tasks.filter(t => t.id !== taskId);
    // Remove empty archive batches
    state.archives = archives.filter(a => a.tasks.length > 0);
    render();
    autoSave();
}

function archiveCompletedTasks() {
    const completed = [];
    const now = new Date().toISOString();
    state.sections.forEach(s => {
        const archivable = s.tasks.filter(t => {
            if (!t.done) return false;
            // Don't archive mail tasks that were sent but not yet responded to
            if ((t.type === 'mail' || t.isMail) && t.sentAt && !t.respondedAt) return false;
            return true;
        });
        archivable.forEach(t => {
            completed.push({ ...t, sectionTitle: s.title, sectionColor: s.color, archivedAt: now });
        });
        const archiveIds = new Set(archivable.map(t => t.id));
        s.tasks = s.tasks.filter(t => !archiveIds.has(t.id));
    });
    if (!completed.length) return;
    if (!state.archives) state.archives = [];
    state.archives.push({ id: uid(), date: now, tasks: completed });
    render();
    autoSave();
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
    Section Modal (create / edit)
    ═══════════════════════════════════════════════════════ */
function openSectionModal(sid) {
    editingSectionId = sid || null;
    const s = sid ? state.sections.find(x => x.id === sid) : null;

    document.getElementById('sectionModalTitle').textContent = s ? 'Modifier la section' : 'Nouvelle section';
    document.getElementById('sectionTitleInput').value = s ? s.title : '';
    document.getElementById('sectionBadgeInput').value = s ? (s.badge || '') : '';
    document.getElementById('sectionDescInput').value = s ? (s.description || '') : '';

    modalEmoji = '';
    modalColor = s ? s.color : 'blue';

    renderColorPicker();
    document.getElementById('sectionModal').classList.add('show');
}

function closeSectionModal() {
    document.getElementById('sectionModal').classList.remove('show');
    editingSectionId = null;
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
            s.emoji = ''; s.color = modalColor;
        }
    } else {
        state.sections.push({
            id: uid(), emoji: '', title, badge, color: modalColor,
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
    switchSettingsTab('general');
    loadInstallLocalSettings();
    loadNeo4jDockerConfig();
    refreshNeo4jDockerStatus();
    const contactsCount = document.getElementById('contactsCount');
    if (contactsCount) contactsCount.textContent = `${contacts.length} contacts chargés`;
}

function closeSettings() {
    document.getElementById('settingsModal').classList.remove('show');
}

function switchSettingsTab(tabKey, btn = null) {
    const key = (tabKey || 'general').trim();
    document.querySelectorAll('.settings-fs-nav-item').forEach((b) => {
        b.classList.toggle('active', b.dataset.settingsTab === key);
    });
    document.querySelectorAll('.settings-fs-tab').forEach((panel) => {
        panel.classList.toggle('active', panel.id === `settings-tab-${key}`);
    });
    if (key === 'data') {
        loadNeo4jDockerConfig();
        refreshNeo4jDockerStatus();
    }
    if (btn) btn.blur();
}

function renderInstallStorageList(paths = {}) {
    const el = document.getElementById('installStorageList');
    if (!el) return;
    const entries = [
        ['Dossier app data', paths.app_data_dir],
        ['Fichier config locale', paths.runtime_config_file],
        ['Fichier env local', paths.runtime_env_file],
        ['Base todo JSON', paths.data_json],
        ['Comptes mail', paths.accounts_file],
        ['Index inbox', paths.inbox_index_file],
        ['UIDs vus', paths.seen_uids_file],
        ['Contacts CSV', paths.contacts_csv],
        ['Dossier mails .eml', paths.mails_dir],
        ['Vault principal', paths.vault_dir],
        ['Vault mails', paths.vault_mails_dir],
        ['Vault pièces jointes', paths.vault_attachments_dir],
        ['Logs backend', paths.log_file],
    ].filter(([, value]) => value);

    el.innerHTML = entries.map(([label, value]) => `
        <div class="install-storage-item">
            <span class="install-storage-label">${esc(label)}</span>
            <span class="install-storage-path">${esc(String(value))}</span>
        </div>
    `).join('');
}

function applyInstallSettingsToForm(payload = {}) {
    const paths = payload.paths || {};
    const env = payload.env || {};

    const assign = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.value = value || '';
    };

    assign('settingMailsDirInput', paths.mails_dir || '');
    assign('settingVaultDirInput', paths.vault_dir || '');
    assign('settingNeo4jUriInput', env.NEO4J_URI || '');
    assign('settingNeo4jUserInput', env.NEO4J_USER || '');
    assign('settingNeo4jPasswordInput', env.NEO4J_PASSWORD || '');
    assign('settingGeminiApiInput', env.GEMINI_API_KEY || '');
    assign('settingGeminiModelInput', env.GEMINI_MODEL || '');
    assign('settingGeminiFallbackInput', env.GEMINI_FALLBACK_MODELS || '');
    assign('settingEmbeddingModelInput', env.EMBEDDING_MODEL || '');

    renderInstallStorageList(paths);
}

async function loadInstallLocalSettings() {
    try {
        const r = await fetch('/api/app-config');
        const data = await r.json();
        if (!r.ok || !data.ok) throw new Error(data.error || 'Impossible de charger la configuration locale');
        appInstallConfig = data;
        applyInstallSettingsToForm(data);
    } catch (e) {
        showToast(`Chargement config locale: ${e.message || e}`, 'error', 3500);
    }
}

async function saveInstallLocalSettings(options = {}) {
    const quiet = !!options.quiet;
    const payload = {
        paths: {
            mails_dir: (document.getElementById('settingMailsDirInput')?.value || '').trim(),
            vault_dir: (document.getElementById('settingVaultDirInput')?.value || '').trim(),
        },
        env: {
            NEO4J_URI: (document.getElementById('settingNeo4jUriInput')?.value || '').trim(),
            NEO4J_USER: (document.getElementById('settingNeo4jUserInput')?.value || '').trim(),
            NEO4J_PASSWORD: (document.getElementById('settingNeo4jPasswordInput')?.value || '').trim(),
            GEMINI_API_KEY: (document.getElementById('settingGeminiApiInput')?.value || '').trim(),
            GEMINI_MODEL: (document.getElementById('settingGeminiModelInput')?.value || '').trim(),
            GEMINI_FALLBACK_MODELS: (document.getElementById('settingGeminiFallbackInput')?.value || '').trim(),
            EMBEDDING_MODEL: (document.getElementById('settingEmbeddingModelInput')?.value || '').trim(),
        },
    };

    try {
        const r = await fetch('/api/app-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const data = await r.json();
        if (!r.ok || !data.ok) throw new Error(data.error || 'Sauvegarde impossible');
        if (!quiet) {
            showToast('Configuration locale sauvegardée. Redémarre l\'application pour appliquer tous les changements.', 'success', 4500);
        }
        await loadInstallLocalSettings();
    } catch (e) {
        if (!quiet) {
            showToast(`Sauvegarde config locale: ${e.message || e}`, 'error', 4500);
        }
        throw e;
    }
}

function renderSystemDiagnostics(data) {
    const wrap = document.getElementById('systemDiagResults');
    if (!wrap) return;

    const checks = Array.isArray(data?.checks) ? data.checks : [];
    const pkg = data?.packages || {};

    const checkHtml = checks.map((c) => {
        const ok = !!c.ok;
        return `
            <div class="system-diag-item ${ok ? 'ok' : 'ko'}">
                <div class="system-diag-head">
                    <span class="system-diag-title">${esc(c.label || c.id || 'Check')}</span>
                    <span class="system-diag-pill ${ok ? 'ok' : 'ko'}">${ok ? 'OK' : 'À corriger'}</span>
                </div>
                <div class="system-diag-details">${esc(c.details || '')}</div>
                ${c.fix ? `<div class="system-diag-fix">Action: ${esc(c.fix)}</div>` : ''}
            </div>
        `;
    }).join('');

    const pkgHtml = Object.entries(pkg).map(([name, info]) => {
        const installed = info && info.installed === true;
        const status = info && typeof info.status === 'string' ? info.status : '';
        return `<li><strong>${esc(name)}</strong>: ${installed ? 'installé' : 'non installé'}${status ? ` (${esc(status)})` : ''}</li>`;
    }).join('');

    wrap.innerHTML = `
        <div class="system-diag-note">${esc(data?.dpkg_note || '')}</div>
        <div class="system-diag-grid">${checkHtml}</div>
        <div class="system-diag-packages">
            <div style="font-size:0.82rem;font-weight:600;margin-bottom:0.2rem">Paquets système (dpkg)</div>
            <ul>${pkgHtml || '<li>Aucune information paquet.</li>'}</ul>
        </div>
    `;
}

async function runSystemDiagnostics() {
    const wrap = document.getElementById('systemDiagResults');
    if (wrap) wrap.innerHTML = '<div class="system-diag-note">Diagnostic en cours…</div>';
    try {
        const r = await fetch('/api/system/check');
        const data = await r.json();
        if (!r.ok || data.error) throw new Error(data.error || 'Diagnostic impossible');
        renderSystemDiagnostics(data);
        showToast('Diagnostic système terminé.', 'success');
    } catch (e) {
        if (wrap) wrap.innerHTML = `<div class="system-diag-note">Erreur diagnostic: ${esc(e.message || String(e))}</div>`;
        showToast(`Diagnostic: ${e.message || e}`, 'error', 4500);
    }
}

function applyNeo4jDockerConfigToForm(cfg = {}) {
    // Config is fixed — just populate read-only fields for display.
    const assign = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.value = value ?? '';
    };
    assign('neo4jDockerContainerInput', 'neurail-neo4j');
    assign('neo4jDockerImageInput', 'neo4j:latest');
    assign('neo4jDockerVolumeInput', 'neurail-neo4j-data');
    assign('neo4jDockerBoltPortInput', 7687);
    assign('neo4jDockerHttpPortInput', 7474);
}

function renderNeo4jDockerStatus(status = {}) {
    neo4jDockerLastStatus = status;
    const el = document.getElementById('neo4jDockerStatus');

    const exists = !!status.exists;
    const running = !!status.running;
    const daemon = !!status.daemon_running;
    const dockerAccess = status.docker_access !== false;
    const reachable = !!status.neo4j_reachable;
    const health = status.health || 'n/a';
    const hasError = !!status.error;
    const actionError = (neo4jDockerLastActionError || '').trim();
    const detectedName = String(status.detected_container_name || '').trim();
    const detectedImage = String(status.detected_container_image || '').trim();
    const nameMismatch = !!status.container_name_mismatch;

    const row = (label, value, cls = '') =>
        `<div class="stg-status-row"><span class="stg-status-label">${label}</span><span class="stg-status-value ${cls}">${value}</span></div>`;

    let html = '';
    html += row('Docker', status.docker_available ? 'Installé' : 'Absent', status.docker_available ? 'stg-status-ok' : 'stg-status-ko');
    html += row('Daemon', daemon ? 'Actif' : 'Inactif', daemon ? 'stg-status-ok' : 'stg-status-ko');
    html += row('Accès Docker', dockerAccess ? 'OK' : 'Refusé', dockerAccess ? 'stg-status-ok' : 'stg-status-warn');
    html += row('Conteneur', exists ? `Présent (${esc(detectedName || String(status.config?.container_name || ''))})` : 'Absent', exists ? 'stg-status-ok' : 'stg-status-warn');
    html += row('Exécution', running ? 'En cours' : 'Arrêté', running ? 'stg-status-ok' : 'stg-status-ko');
    if (exists) html += row('Santé', esc(String(health)));
    html += row('Port Bolt', reachable ? 'Joignable' : 'Injoignable', reachable ? 'stg-status-ok' : 'stg-status-ko');

    if (hasError && !daemon && status.docker_available) {
        html += `<div class="stg-status-alert">`;
        html += `<strong style="color:#f87171">⚠ ${esc(String(status.error))}</strong><br>`;
        html += reachable
            ? `Neo4j est joignable (port Bolt ouvert). Si Neo4j tourne en natif, ignorez cette alerte.`
            : `Démarrez le daemon Docker pour gérer le conteneur.`;
        html += `<br><button class="stg-btn stg-btn-ghost stg-btn-sm" style="margin-top:.4rem" onclick="neo4jDockerAction('start-daemon')"><i class="icon-play"></i> Démarrer le daemon</button>`;
        html += `</div>`;
    } else if (hasError && daemon && !dockerAccess) {
        html += `<div class="stg-status-alert" style="border-color:rgba(251,191,36,0.4)"><strong style="color:#fbbf24">⚠ ${esc(String(status.error))}</strong><br>Exécute: <code>sudo usermod -aG docker $USER</code> puis déconnecte/reconnecte la session.</div>`;
    } else if (hasError) {
        html += `<div class="stg-status-alert" style="border-color:rgba(248,113,113,0.3)"><strong style="color:#f87171">⚠ ${esc(String(status.error))}</strong></div>`;
    } else if (!dockerAccess && reachable) {
        html += `<div class="stg-status-alert" style="border-color:rgba(251,191,36,0.3)">Accès Docker limité — Neo4j fonctionne. Pour gérer le conteneur depuis l'app: <code>sudo usermod -aG docker $USER</code> puis reconnexion.</div>`;
    }

    if (actionError) {
        html += `<div class="stg-status-alert" style="border-color:rgba(248,113,113,0.3)"><strong style="color:#f87171">Dernière action échouée:</strong><br>${esc(actionError)}</div>`;
    }

    if (el) el.innerHTML = html;
    renderNeo4jQuickAssistant(status);
}

function renderNeo4jQuickAssistant(status = {}) {
    const hero = document.getElementById('neo4jQuickState');
    if (!hero) return;

    const dockerOk = !!status.docker_available;
    const daemonOk = !!status.daemon_running;
    const accessOk = status.docker_access !== false;
    const running = !!status.running;
    const reachable = !!status.neo4j_reachable;
    const ready = running && reachable;
    const mismatch = !!status.container_name_mismatch;

    let toneCls = 'is-warn';
    let title = 'Action requise';
    let subtitle = 'Neo4j n\'est pas encore prêt.';

    if (ready) {
        toneCls = 'is-ok';
        title = 'Neo4j prêt';
        subtitle = !accessOk
            ? 'Neo4j répond. Gestion Docker limitée (permissions socket).'
            : 'La base répond et le conteneur est en cours d\'exécution.';
    } else if (reachable) {
        toneCls = 'is-ok';
        title = 'Neo4j prêt';
        subtitle = 'Le port Bolt répond. Neo4j est accessible.';
    } else if (!dockerOk) {
        toneCls = 'is-ko';
        title = 'Docker manquant';
        subtitle = 'Installe Docker Engine pour activer Neo4j depuis l\'application.';
    } else if (!daemonOk) {
        toneCls = 'is-warn';
        title = 'Daemon Docker arrêté';
        subtitle = 'L\'assistant peut tenter de le démarrer automatiquement.';
    } else if (!accessOk) {
        toneCls = 'is-warn';
        title = 'Accès Docker refusé';
        subtitle = 'Ajoute l\'utilisateur au groupe docker puis reconnecte la session.';
    }

    hero.className = `stg-neo4j-hero ${toneCls}`;
    hero.innerHTML = `<div class="stg-neo4j-hero-title">${esc(title)}</div><div class="stg-neo4j-hero-sub">${esc(subtitle)}</div>`;
}

function getCurrentNeo4jDockerFormConfig() {
    // Fixed — always returns the canonical config.
    return {
        container_name: 'neurail-neo4j',
        image: 'neo4j:latest',
        volume: 'neurail-neo4j-data',
        bolt_port: 7687,
        http_port: 7474,
    };
}

async function getNeo4jDockerStatus() {
    const r = await fetch('/api/neo4j/docker/status');
    return r.json();
}

async function loadNeo4jDockerConfig() {
    try {
        const r = await fetch('/api/neo4j/docker/config');
        const data = await r.json();
        if (!r.ok || data.error) throw new Error(data.error || 'Chargement config Docker impossible');
        neo4jDockerConfig = data.config || {};
        applyNeo4jDockerConfigToForm(neo4jDockerConfig);
    } catch (e) {
        showToast(`Neo4j Docker config: ${e.message || e}`, 'error', 3500);
    }
}

async function saveNeo4jDockerConfig() {
    try {
        await saveNeo4jDockerConfigRaw(getCurrentNeo4jDockerFormConfig());
        await refreshNeo4jDockerStatus();
    } catch (e) {
        showToast(`Neo4j Docker: ${e.message || e}`, 'error', 4500);
    }
}

async function refreshNeo4jDockerStatus() {
    try {
        const data = await getNeo4jDockerStatus();
        if (data.neo4j_reachable) neo4jDockerLastActionError = '';
        renderNeo4jDockerStatus(data);
    } catch (e) {
        const el = document.getElementById('neo4jDockerStatus');
        if (el) el.textContent = `Erreur statut: ${e.message || e}`;
    }
}

async function neo4jDockerAction(action, options = {}) {
    const quiet = !!options.quiet;
    const payload = { action };
    if (action === 'start' || action === 'restart' || action === 'reinstall') {
        let pwd = (document.getElementById('settingNeo4jPasswordInput')?.value || '').trim();
        if (!pwd) pwd = 'changeme'; // default password
        if (pwd) payload.neo4j_password = pwd;
    }

    try {
        const r = await fetch('/api/neo4j/docker/action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const data = await r.json();
        if (!r.ok || data.error) throw new Error(data.error || `Action ${action} échouée`);
        neo4jDockerLastActionError = '';
        renderNeo4jDockerStatus(data.status || {});
        if (!quiet) showToast(`Action Neo4j Docker '${action}' réussie.`, 'success');
        return data.status || {};
    } catch (e) {
        neo4jDockerLastActionError = e.message || String(e);
        if (!quiet) showToast(`Action Neo4j Docker '${action}': ${e.message || e}`, 'error', 5000);
        throw e;
    } finally {
        await refreshNeo4jDockerStatus();
    }
}

async function activateNeo4jGuided() {
    const btn = document.getElementById('neo4jActivateBtn');
    if (btn) btn.disabled = true;
    try {
        let status = await getNeo4jDockerStatus();
        renderNeo4jDockerStatus(status);

        if (!status.docker_available) {
            throw new Error('Docker n\'est pas installé sur ce système.');
        }

        if (!status.daemon_running) {
            await neo4jDockerAction('start-daemon', { quiet: true });
            status = await getNeo4jDockerStatus();
            renderNeo4jDockerStatus(status);
        }

        if (status.docker_access === false) {
            throw new Error('Le daemon est actif mais l\'accès Docker est refusé. Exécute: sudo usermod -aG docker $USER puis reconnecte la session.');
        }

        if (!status.running) {
            await neo4jDockerAction('start', { quiet: true });
            status = await getNeo4jDockerStatus();
            renderNeo4jDockerStatus(status);
        }

        if (status.running && status.neo4j_reachable) {
            // Test authentication with the configured password.
            await testNeo4jAuth();
            showToast('Neo4j est opérationnel.', 'success', 4000);
            return;
        }

        throw new Error('Neo4j ne répond pas encore. Clique Actualiser dans quelques secondes.');
    } catch (e) {
        neo4jDockerLastActionError = e.message || String(e);
        showToast(`Activation Neo4j: ${e.message || e}`, 'error', 5500);
        await refreshNeo4jDockerStatus();
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function testNeo4jAuth() {
    // Try the stored/default password first.
    let pwd = (document.getElementById('settingNeo4jPasswordInput')?.value || '').trim() || 'changeme';
    let r = await fetch('/api/neo4j/test-auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pwd }),
    });
    let data = await r.json();
    if (data.ok) return; // auth fine

    // Password failed — prompt the user.
    for (let attempt = 0; attempt < 3; attempt++) {
        const entered = window.prompt(
            'Le mot de passe Neo4j par défaut ne fonctionne pas.\nEntrez le mot de passe Neo4j actuel :',
        );
        if (!entered) break; // user cancelled
        r = await fetch('/api/neo4j/test-auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: entered.trim() }),
        });
        data = await r.json();
        if (data.ok) {
            const localPwdInput = document.getElementById('settingNeo4jPasswordInput');
            if (localPwdInput) localPwdInput.value = entered.trim();
            showToast('Mot de passe Neo4j validé et sauvegardé.', 'success', 4000);
            return;
        }
        showToast('Mot de passe incorrect, réessayez.', 'error', 3000);
    }
    showToast('Authentification Neo4j échouée. Changez le mot de passe dans Infrastructure > Mot de passe Neo4j.', 'error', 6000);
}

async function neo4jDockerReinstall() {
    const withVolume = confirm('Supprimer aussi le volume de données Neo4j ? (OK = oui, Annuler = non)');
    const confirmReinstall = confirm('Confirmer la réinstallation du conteneur Neo4j Docker ?');
    if (!confirmReinstall) return;
    try {
        const r = await fetch('/api/neo4j/docker/action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'reinstall', confirm: true, remove_volume: withVolume }),
        });
        const data = await r.json();
        if (!r.ok || data.error) throw new Error(data.error || 'Réinstallation échouée');
        renderNeo4jDockerStatus(data.status || {});
        showToast('Réinstallation Neo4j Docker terminée.', 'success', 5000);
    } catch (e) {
        showToast(`Réinstallation Neo4j Docker: ${e.message || e}`, 'error', 5500);
    }
}

async function changeNeo4jDockerPassword() {
    const oldPassword = (document.getElementById('neo4jCurrentPasswordInput')?.value || '').trim();
    const newPassword = (document.getElementById('neo4jNewPasswordInput')?.value || '').trim();
    if (!oldPassword || !newPassword) {
        showToast('Renseigne ancien et nouveau mot de passe.', 'error');
        return;
    }
    if (newPassword.length < 8) {
        showToast('Le nouveau mot de passe doit contenir au moins 8 caractères.', 'error');
        return;
    }
    try {
        const r = await fetch('/api/neo4j/docker/action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'change-password', old_password: oldPassword, new_password: newPassword }),
        });
        const data = await r.json();
        if (!r.ok || data.error) throw new Error(data.error || 'Changement de mot de passe échoué');

        const localPwdInput = document.getElementById('settingNeo4jPasswordInput');
        if (localPwdInput) localPwdInput.value = newPassword;
        document.getElementById('neo4jCurrentPasswordInput').value = '';
        document.getElementById('neo4jNewPasswordInput').value = '';

        renderNeo4jDockerStatus(data.status || {});
        showToast('Mot de passe Neo4j mis à jour.', 'success', 4500);
    } catch (e) {
        showToast(`Mot de passe Neo4j: ${e.message || e}`, 'error', 5000);
    }
}

function saveMailToolsSettings() {
    const input = document.getElementById('settingGeminiApiInput');
    state.settings.geminiKey = (input?.value || '').trim();
    autoSave();
    showToast('Clé Gemini sauvegardée.', 'success');
}

async function saveAISettings() {
    saveMailToolsSettings();
    await saveInstallLocalSettings();
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
        el.innerHTML = '<p class="signatures-empty">Aucune signature configurée.</p>';
        return;
    }
    el.innerHTML = sigs.map(s =>
        `<div class="signature-item">` +
        `<div class="signature-item-name">${esc(s.name)}</div>` +
        `<div class="signature-item-actions">` +
        `<button class="signature-action-edit" onclick="openSignatureModal('${s.id}')"><i class="icon-pencil"></i> Modifier</button>` +
        `<button class="signature-action-delete" onclick="deleteSignature('${s.id}')" title="Supprimer la signature"><i class="icon-trash-2"></i></button>` +
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
    if (pending.length) html += renderMailGroup('À envoyer', pending, true);
    if (waiting.length) html += renderMailGroup('En attente de réponse', waiting, true);
    if (responded.length) html += renderMailGroup('Terminés', responded, respondedMailsExpanded, 'terminated');

    container.innerHTML = html;
}

function getMailRelanceCount(taskId) {
    return (state.reminders || []).filter(r => r.taskId === taskId && r.status === 'sent').length;
}

function renderMailGroup(title, mails, isExpanded = true, groupType = null) {
    const hasToggle = groupType === 'terminated';
    const toggleBtn = hasToggle ? `<button onclick="event.stopPropagation();toggleRespondedMailsVisibility()" class="mail-group-toggle" title="${respondedMailsExpanded ? 'Replier' : 'Déplier'}"><i class="icon-chevron-${respondedMailsExpanded ? 'down' : 'right'}"></i></button>` : '';
    let html = `<div class="mail-group-label">${toggleBtn}<span>${esc(title)}</span></div>`;
    
    const itemsHtml = mails.map(m => {
        const status = getMailTaskStatus(m);
        const statusLabel = getMailStatusLabel(status);
        const isSelected = selectedMailTask && selectedMailTask.tid === m.id;
        const relanceCount = getMailRelanceCount(m.id);
        
        // Check if mail is over 3 days old
        const isOverThreeDays = m.sentAt && !m.respondedAt && (Date.now() - m.sentAt) > 3 * 24 * 60 * 60 * 1000;

        // Color class based on relance count
        let relanceCls = '';
        if (relanceCount === 1) relanceCls = 'relance-1';
        else if (relanceCount === 2) relanceCls = 'relance-2';
        else if (relanceCount >= 3) relanceCls = 'relance-3';
        
        const cls = ['mail-item', isSelected ? 'selected' : '', m.sentAt ? 'is-sent' : '', isOverThreeDays && !relanceCls ? 'awaiting-response-over-3days' : '', relanceCls].filter(Boolean).join(' ');
        const checkDone = m.sentAt ? 'done' : '';

        const relanceBadge = relanceCount > 0
            ? `<span class="mail-relance-badge" title="${relanceCount} relance${relanceCount > 1 ? 's' : ''} envoyée${relanceCount > 1 ? 's' : ''}">↩ ${relanceCount}</span>`
            : '';

        let actionsHtml = '';
        if (status === 'sent' || status === 'waiting') {
            actionsHtml += `<button onclick="event.stopPropagation();quickRelance('${m.sectionId}','${m.id}')" title="Envoyer une relance" class="btn-relance"><i class="icon-mail"></i> Relancer</button>`;
            actionsHtml += `<button onclick="event.stopPropagation();markResponseReceived('${m.sectionId}','${m.id}')" title="Réponse reçue"><i class="icon-check"></i></button>`;
        }

        return `
        <div class="${cls}" onclick="selectMailForCompose('${m.sectionId}','${m.id}')">
            <div class="mail-item-check ${checkDone}" onclick="event.stopPropagation();toggleMailSentFromList('${m.sectionId}','${m.id}')">
                <svg viewBox="0 0 24 24"><polyline points="4 12 10 18 20 6"/></svg>
            </div>
            <div class="mail-item-info">
                <div class="mail-item-label">${m.sectionEmoji} ${esc(m.label || 'Sans titre')}${relanceBadge}</div>
                <div class="mail-item-section">${esc(m.sectionTitle)}${m.mailTo ? ' → ' + esc(m.mailTo) : ''}</div>
            </div>
            <span class="mail-item-status ${status}">${statusLabel}</span>
            <div class="mail-item-actions">${actionsHtml}</div>
        </div>`;
    }).join('');
    
    if (!isExpanded && hasToggle) {
        html += `<div class="mail-group-items-hidden">${itemsHtml}</div>`;
    } else {
        html += itemsHtml;
    }
    
    return html;
}

function toggleRespondedMailsVisibility() {
    respondedMailsExpanded = !respondedMailsExpanded;
    renderMailList();
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

async function quickRelance(sid, tid) {
    const s = state.sections.find(x => x.id === sid);
    if (!s) return;
    const t = s.tasks.find(x => x.id === tid);
    if (!t) return;

    const from = t.mailFrom || document.getElementById('mailFrom').value;
    const to = t.mailTo || '';
    if (!from) { showToast('Aucun compte expéditeur configuré.', 'error'); return; }
    if (!to) { showToast('Aucun destinataire pour cette relance.', 'error'); return; }

    const relanceCount = getMailRelanceCount(tid);
    const relanceNum = relanceCount + 1;
    const originalSubject = t.mailSubject || t.label || '';
    const originalBody = t.mailBody || '';

    const relanceSubject = `Relance : ${originalSubject}`;
    const relanceBody = `Bonjour,\n\nJe me permets de vous relancer à propos de mon mail précédent.\n\n${originalBody}\n\nCordialement,`;

    showLoading(`Envoi de la relance #${relanceNum}…`);
    try {
        const r = await fetch('/api/send-email', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ from, to, subject: relanceSubject, body: relanceBody })
        });
        const result = await r.json();
        if (!result.ok) {
            showToast('Erreur : ' + (result.error || 'Échec de l\'envoi'), 'error', 5000);
            return;
        }
    } catch (e) {
        showToast('Erreur : ' + e.message, 'error', 5000);
        return;
    } finally {
        hideLoading();
    }

    // Mark the pending reminder as sent and create the next cycle
    const pendingReminder = (state.reminders || []).find(r => r.taskId === tid && r.status === 'pending');
    if (pendingReminder) {
        const now = Date.now();
        pendingReminder.status = 'sent';
        pendingReminder.sentAt = now;
        state.mailEvents = state.mailEvents || [];
        state.mailEvents.push({
            id: uid(), taskId: tid, sectionId: sid,
            type: 'reminder_sent', date: now,
            label: originalSubject, to: t.mailTo, cycle: pendingReminder.cycle
        });
        state.reminders.push({
            id: uid(), taskId: tid, sectionId: sid,
            label: t.label || originalSubject,
            mailTo: t.mailTo || '', mailSubject: originalSubject,
            mailBody: originalBody, mailFrom: t.mailFrom || '',
            createdAt: now,
            remindAt: now + 3 * 24 * 60 * 60 * 1000,
            cycle: pendingReminder.cycle + 1, status: 'pending'
        });
    }

    autoSave();
    renderMailList();
    showToast(`Relance #${relanceNum} envoyée !`, 'success', 3000);
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
   Reminder Workflow (cycles)
   ═══════════════════════════════════════════════════════ */
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
    markResponseReceived(r.sectionId, r.taskId);
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
let selectedInboxIds = new Set();

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
        const isChecked = selectedInboxIds.has(m.id);
        const unread = !m.read ? 'unread' : '';
        const isSent = m.folder === 'sent';
        const fromDisplay = isSent ? ('→ ' + (m.to || '').split(',')[0].trim()) : (m.from_name || m.from_email || 'Inconnu');
        const preview = (m.body || '').substring(0, 80).replace(/\n/g, ' ');
        const hasAttach = m.attachments && m.attachments.length > 0;

        return `
        <div class="inbox-item ${unread} ${isSelected ? 'selected' : ''} ${isChecked ? 'checked' : ''}" onclick="openInboxMail('${esc(m.id)}')">
            <input type="checkbox" class="inbox-item-check" ${isChecked ? 'checked' : ''}
                aria-label="Sélectionner ce mail"
                onclick="event.stopPropagation();toggleMailSelection('${esc(m.id)}')">
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
function toggleMailSelection(mailId) {
    if (selectedInboxIds.has(mailId)) {
        selectedInboxIds.delete(mailId);
    } else {
        selectedInboxIds.add(mailId);
    }
    updateBatchToolbar();
    renderInboxList();
}

function clearMailSelection() {
    selectedInboxIds.clear();
    updateBatchToolbar();
    renderInboxList();
}

function updateBatchToolbar() {
    const toolbar = document.getElementById('inboxBatchToolbar');
    const countEl = document.getElementById('inboxBatchCount');
    if (!toolbar) return;
    const count = selectedInboxIds.size;
    if (count > 0) {
        toolbar.classList.remove('is-hidden');
        if (countEl) countEl.textContent = count + ' mail(s) sélectionné(s)';
    } else {
        toolbar.classList.add('is-hidden');
    }
}

function openDeleteMailModal(mailId) {
    deleteMailTarget = mailId;
    const isBatch = mailId === null;
    const modal = document.getElementById('deleteMailModal');
    const subjectEl = document.getElementById('deleteMailSubject');
    const titleEl = document.getElementById('deleteMailModalTitle');
    if (isBatch) {
        const count = selectedInboxIds.size;
        if (count === 0) return;
        if (titleEl) titleEl.textContent = `Supprimer ${count} mail(s) ?`;
        if (subjectEl) subjectEl.textContent = count + ' mail(s) sélectionné(s) seront supprimés.';
    } else {
        const mail = inboxMails.find(m => m.id === mailId);
        if (titleEl) titleEl.textContent = 'Supprimer ce mail ?';
        if (subjectEl) subjectEl.textContent = mail ? mail.subject : '';
    }
    document.getElementById('deleteOnServer').checked = false;
    modal.classList.add('show');
}

function closeDeleteMailModal() {
    document.getElementById('deleteMailModal').classList.remove('show');
    deleteMailTarget = null;
}

async function confirmDeleteMail() {
    const deleteOnServer = document.getElementById('deleteOnServer').checked;
    const isBatch = deleteMailTarget === null;

    if (isBatch) {
        if (selectedInboxIds.size === 0) return;
        const ids = [...selectedInboxIds];
        closeDeleteMailModal();
        showLoading('Suppression des mails…');
        try {
            const r = await fetch('/api/mail/delete-batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids, delete_on_server: deleteOnServer })
            });
            const result = await r.json();
            if (result.ok) {
                inboxMails = inboxMails.filter(m => !ids.includes(m.id));
                if (ids.includes(selectedInboxId)) {
                    selectedInboxId = null;
                    document.getElementById('inboxReader').innerHTML = `
                        <div class="inbox-reader-empty">
                            <i class="icon-mail-open" style="font-size:2.5rem;color:var(--text-muted)"></i>
                            <p>Sélectionne un mail pour le lire</p>
                        </div>`;
                }
                selectedInboxIds.clear();
                updateBatchToolbar();
                renderInboxList();
                updateInboxBadge();
                showToast(`${result.deleted} mail(s) supprimé(s)`, 'success');
            } else {
                showToast('Erreur : ' + (result.error || 'Erreur'), 'error', 5000);
            }
        } catch (e) {
            showToast('Erreur : ' + e.message, 'error', 5000);
        } finally {
            hideLoading();
        }
        return;
    }

    if (!deleteMailTarget) return;
    const targetId = deleteMailTarget;
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
        return `<span class="attachment-chip">
            <span class="attachment-chip-name">${esc(a.name)}</span>
            <span class="attachment-chip-size">(${sizeKB} Ko)</span>
            <button class="attachment-chip-remove" onclick="event.stopPropagation();removeAttachment(${i})">&times;</button>
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
}, 30000);

/* ═══════════════════════════════════════════════════════
   Init
   ═══════════════════════════════════════════════════════ */
(async function init() {
    await Promise.all([loadState(), loadContacts()]);

    // Restore custom site tabs from persisted app state (with legacy migration).
    initSiteTabs();

    // Security migration: never keep GitHub password in plain JSON state.
    if (state.settings && Object.prototype.hasOwnProperty.call(state.settings, 'githubPassword')) {
        delete state.settings.githubPassword;
    }

    render();
    if (!state.settings) state.settings = {};
    applyThemeMode(state.settings.uiTheme || 'dark');

    const geminiInput = document.getElementById('geminiKeyInput');

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

    const btnMin = document.getElementById('btn-minimize');
    const btnMax = document.getElementById('btn-maximize');
    const btnClose = document.getElementById('btn-close');
    if (btnMin) btnMin.addEventListener('click', () => api.minimize());
    if (btnMax) btnMax.addEventListener('click', () => api.maximize());
    if (btnClose) btnClose.addEventListener('click', () => api.close());
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
   MailChat (Chatbot)
   ═══════════════════════════════════════════════════════ */
let chatbotNeo4jAvailable = null; // null = not checked
let chatbotIngestPollTimer = null;
let chatbotLoading = false;
let mailchatRawResults = [];
let mailchatLastResults = [];
let mailchatLastAnswer = '';
const mailchatDetailsCache = new Map();
let mailchatPeriodFilter = 'all';
let mailchatGraphSimulation = null;

function mailchatLog(msg, data = null) {
    if (data !== null) {
        console.log(`[MailChat] ${msg}`, data);
    } else {
        console.log(`[MailChat] ${msg}`);
    }
}

function setChatbotQueryInfo(message, kind = 'info') {
    const info = document.getElementById('chatbotQueryInfo');
    if (!info) return;
    const color = kind === 'error' ? '#f38ba8' : (kind === 'success' ? '#4ade80' : 'var(--text-muted)');
    info.style.color = color;
    info.textContent = message || '';
}

function setChatbotPeriodFilter(period, btn) {
    mailchatPeriodFilter = period || 'all';
    document.querySelectorAll('#chatbotPeriodFilters .mailchat-chip').forEach((b) => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    applyMailchatResults(mailchatRawResults, mailchatLastAnswer);
}

function getTimePeriodRange(period) {
    if (period === 'all') return null;
    const now = new Date();
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);

    if (period === 'today') {
        return { start, end: now };
    }
    if (period === 'week') {
        const day = (start.getDay() + 6) % 7;
        start.setDate(start.getDate() - day);
        return { start, end: now };
    }
    if (period === 'month') {
        start.setDate(1);
        return { start, end: now };
    }
    if (period === 'year') {
        start.setMonth(0, 1);
        return { start, end: now };
    }
    return null;
}

function parseMailDate(value) {
    if (!value) return null;
    const fromIso = Date.parse(value);
    if (!Number.isNaN(fromIso)) return new Date(fromIso);
    const m = String(value).match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m) {
        const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`);
        if (!Number.isNaN(d.getTime())) return d;
    }
    return null;
}

function filterResultsByPeriod(results) {
    const range = getTimePeriodRange(mailchatPeriodFilter);
    if (!range) return results;
    return (results || []).filter((r) => {
        const d = parseMailDate(r.date);
        if (!d) return false;
        return d >= range.start && d <= range.end;
    });
}

function collectSemanticFields() {
    return {
        who: (document.getElementById('chatbotFieldWho')?.value || '').trim(),
        docType: (document.getElementById('chatbotFieldDocType')?.value || '').trim(),
        context: (document.getElementById('chatbotFieldContext')?.value || '').trim(),
        period: (document.getElementById('chatbotFieldPeriod')?.value || '').trim(),
        attachment: (document.getElementById('chatbotFieldAttachment')?.value || '').trim(),
        comment: (document.getElementById('chatbotComment')?.value || '').trim(),
    };
}

function buildSemanticQuestion(fields) {
    const parts = [];
    if (fields.who) parts.push(`Expéditeur/personne: ${fields.who}`);
    if (fields.docType) parts.push(`Type recherché: ${fields.docType}`);
    if (fields.context) parts.push(`Contexte: ${fields.context}`);
    if (fields.period) parts.push(`Période: ${fields.period}`);
    if (fields.attachment === 'oui') parts.push('Le mail doit contenir une pièce jointe');
    if (fields.attachment === 'non') parts.push('Le mail ne doit pas contenir de pièce jointe');
    if (fields.comment) parts.push(`Commentaire: ${fields.comment}`);
    return parts.join(' | ').trim();
}

function clearChatbotSemanticFields() {
    const ids = [
        'chatbotFieldWho',
        'chatbotFieldDocType',
        'chatbotFieldContext',
        'chatbotFieldPeriod',
        'chatbotFieldAttachment',
        'chatbotComment',
    ];
    for (const id of ids) {
        const el = document.getElementById(id);
        if (!el) continue;
        if (el.tagName === 'SELECT') el.selectedIndex = 0;
        else el.value = '';
    }
    mailchatRawResults = [];
    mailchatLastResults = [];
    mailchatLastAnswer = '';
    mailchatDetailsCache.clear();
    renderMailchatAnswer('', 'Remplissez les champs puis lancez une recherche.');
    renderMailchatResults([]);
    renderMailchatAttachments([]);
    renderMailchatGraph([]);
    setChatbotQueryInfo('');
}

function renderMailchatAnswer(answer, fallbackText = '') {
    const pane = document.getElementById('chatbotAnswerPane');
    if (!pane) return;
    if (answer) {
        const safeAnswer = answer.replace(/https?:\/\/\S+/gi, '').trim();
        pane.innerHTML = `<div class="chatbot-answer-box">${marked.parse(esc(safeAnswer))}</div>`;
        return;
    }
    pane.innerHTML = `<div class="chatbot-welcome"><p>${esc(fallbackText || 'Aucune synthèse IA pour cette recherche.')}</p></div>`;
}

function renderMailchatResults(results) {
    const pane = document.getElementById('chatbotResultsPane');
    if (!pane) return;
    if (!results || !results.length) {
        pane.innerHTML = '<div class="chatbot-welcome"><p>Aucun mail trouvé.</p></div>';
        return;
    }
    pane.innerHTML = results.map((r, i) => {
        const preview = (r.body_snippet || '').replace(/\s+/g, ' ').trim();
        return `
            <div class="mailchat-result-item mailchat-result-clickable" onclick="openMailchatMailReader(${i})" title="Ouvrir dans une fenêtre">
                <div class="mailchat-result-summary">
                    <strong>${esc(r.subject || 'Sans sujet')}</strong>
                    <span class="mailchat-result-meta">📅 ${esc(r.date || '?')} · 👤 ${esc(r.sender_name || r.sender_email || '?')} · score ${esc(String(r.score ?? '?'))}</span>
                    ${preview ? `<span class="mailchat-result-preview">${esc(preview)}</span>` : ''}
                </div>
            </div>
        `;
    }).join('');
}

function renderMailchatAttachments(results) {
    const pane = document.getElementById('chatbotAttachmentsList');
    if (!pane) return;
    if (!results || !results.length) {
        pane.innerHTML = '<div class="chatbot-welcome"><p>Aucune pièce jointe détectée.</p></div>';
        return;
    }
    const groups = [];
    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const attachments = Array.isArray(r.attachments) ? r.attachments.filter(Boolean) : [];
        if (!attachments.length) continue;
        groups.push(`
            <div class="mailchat-att-group">
                <h4>${esc(r.subject || `Mail ${i + 1}`)}</h4>
                ${attachments.map((a) =>
                    `<button class="mailchat-att-btn" onclick='openChatbotAttachment(${JSON.stringify(r.mail_id || "")}, ${JSON.stringify(a)}, ${JSON.stringify(r.eml_file || "")})'>📎 ${esc(a)}</button>`
                ).join('')}
            </div>
        `);
    }
    pane.innerHTML = groups.length
        ? groups.join('')
        : '<div class="chatbot-welcome"><p>Aucune pièce jointe détectée.</p></div>';
}

function renderMailchatGraph(results) {
    const svgEl = document.getElementById('chatbotGraphSvg');
    const pane = document.getElementById('chatbotGraphPane');
    const legend = document.getElementById('chatbotGraphLegend');
    if (!svgEl || !pane || !legend) return;

    const svg = d3.select(svgEl);
    svg.selectAll('*').remove();
    legend.innerHTML = '';

    if (mailchatGraphSimulation) {
        mailchatGraphSimulation.stop();
        mailchatGraphSimulation = null;
    }

    const rect = svgEl.getBoundingClientRect();
    const width = Math.max(220, rect.width || pane.clientWidth - 16);
    const height = Math.max(150, rect.height || 220);
    svg.attr('viewBox', `0 0 ${width} ${height}`)
       .attr('preserveAspectRatio', 'xMidYMid meet');

    const nodes = [];
    const links = [];
    const seen = new Map();
    const addNode = (id, label, group) => {
        if (!seen.has(id)) {
            const n = { id, label, group };
            seen.set(id, n);
            nodes.push(n);
        }
        return seen.get(id);
    };

    (results || []).forEach((r, idx) => {
        const emailId = `email:${r.mail_id || r.eml_file || idx}`;
        addNode(emailId, r.subject || `Mail ${idx + 1}`, 'email');

        const sender = (r.sender_name || r.sender_email || '').trim();
        if (sender) {
            const senderId = `sender:${sender.toLowerCase()}`;
            addNode(senderId, sender, 'sender');
            links.push({ source: senderId, target: emailId });
        }

        (r.topics || []).forEach((t) => {
            const tid = `topic:${String(t).toLowerCase()}`;
            addNode(tid, t, 'topic');
            links.push({ source: emailId, target: tid });
        });

        (r.attachments || []).forEach((a) => {
            const aid = `att:${String(a).toLowerCase()}`;
            addNode(aid, a, 'attachment');
            links.push({ source: emailId, target: aid });
        });
    });

    if (!nodes.length) {
        svg.append('text')
            .attr('x', width / 2)
            .attr('y', height / 2)
            .attr('text-anchor', 'middle')
            .attr('fill', 'var(--text-muted)')
            .attr('font-size', 12)
            .text('Aucune zone de graphe à afficher');
        legend.innerHTML = '<div class="mailchat-legend-empty">Aucune entité à lister</div>';
        return;
    }

    const color = (g) => {
        if (g === 'email') return '#7dd3fc';
        if (g === 'sender') return '#86efac';
        if (g === 'attachment') return '#fdba74';
        return '#c4b5fd';
    };

    const g = svg.append('g');

    // Enable zoom & pan on the graph
    const zoomBehavior = d3.zoom()
        .scaleExtent([0.3, 4])
        .on('zoom', (event) => g.attr('transform', event.transform));
    svg.call(zoomBehavior);
    const link = g.append('g')
        .selectAll('line')
        .data(links)
        .enter()
        .append('line')
        .attr('stroke', 'rgba(148,163,184,0.35)')
        .attr('stroke-width', 1);

    const node = g.append('g')
        .selectAll('circle')
        .data(nodes)
        .enter()
        .append('circle')
        .attr('r', (d) => d.group === 'email' ? 6 : 4)
        .attr('fill', (d) => color(d.group));

    const label = g.append('g')
        .selectAll('text')
        .data(nodes)
        .enter()
        .append('text')
        .attr('font-size', 9)
        .attr('fill', 'var(--text-muted)')
        .attr('pointer-events', 'none')
        .text((d) => {
            const s = String(d.label || '');
            return s.length > 26 ? `${s.slice(0, 25)}…` : s;
        });

    node.append('title').text((d) => d.label);

    mailchatGraphSimulation = d3.forceSimulation(nodes)
        .force('link', d3.forceLink(links).id((d) => d.id).distance((l) => l.source.group === 'email' || l.target.group === 'email' ? 52 : 38))
        .force('charge', d3.forceManyBody().strength(-80))
        .force('center', d3.forceCenter(width / 2, height / 2))
        .force('collision', d3.forceCollide().radius((d) => d.group === 'email' ? 9 : 6))
        .on('tick', () => {
            link
                .attr('x1', (d) => d.source.x)
                .attr('y1', (d) => d.source.y)
                .attr('x2', (d) => d.target.x)
                .attr('y2', (d) => d.target.y);
            node
                .attr('cx', (d) => d.x)
                .attr('cy', (d) => d.y);
            label
                .attr('x', (d) => d.x + 8)
                .attr('y', (d) => d.y + 3);
        })
        .on('end', () => {
            // Auto-fit graph to bounds after simulation settles
            const bbox = g.node().getBBox();
            if (bbox.width > 0 && bbox.height > 0) {
                const pad = 14;
                const scale = Math.min(
                    width / (bbox.width + pad * 2),
                    height / (bbox.height + pad * 2),
                    1.5
                );
                const tx = width / 2 - (bbox.x + bbox.width / 2) * scale;
                const ty = height / 2 - (bbox.y + bbox.height / 2) * scale;
                svg.transition().duration(400)
                    .call(zoomBehavior.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
            }
        });

    const grouped = {
        email: nodes.filter((n) => n.group === 'email').map((n) => n.label),
        sender: nodes.filter((n) => n.group === 'sender').map((n) => n.label),
        topic: nodes.filter((n) => n.group === 'topic').map((n) => n.label),
        attachment: nodes.filter((n) => n.group === 'attachment').map((n) => n.label),
    };
    legend.innerHTML = [
        ['Emails', grouped.email],
        ['Expéditeurs', grouped.sender],
        ['Topics', grouped.topic],
        ['Pièces jointes', grouped.attachment],
    ].map(([title, items]) => {
        if (!items.length) return '';
        return `
            <div class="mailchat-legend-group">
                <h5>${esc(title)} (${items.length})</h5>
                <ul>${items.map((it) => `<li>${esc(it)}</li>`).join('')}</ul>
            </div>
        `;
    }).join('');
}

function applyMailchatResults(results, answer) {
    mailchatRawResults = Array.isArray(results) ? results : [];
    mailchatLastAnswer = answer || '';
    const filtered = filterResultsByPeriod(mailchatRawResults);
    mailchatLastResults = filtered;
    mailchatDetailsCache.clear();
    renderMailchatAnswer(mailchatLastAnswer, filtered.length ? 'Aucune réponse IA générée.' : 'Aucun résultat trouvé pour la période sélectionnée.');
    renderMailchatResults(filtered);
    renderMailchatAttachments(filtered);
    renderMailchatGraph(filtered);
}

async function loadChatbotPeriodMails() {
    try {
        setChatbotQueryInfo('Chargement des mails pour la période…');
        const r = await fetch('/api/inbox');
        const inbox = r.ok ? await r.json() : [];
        const pseudo = (inbox || []).map((m) => ({
            subject: m.subject || 'Sans sujet',
            date: m.date || '',
            sender_name: m.from_name || '',
            sender_email: m.from_email || '',
            recipients: [],
            topics: [],
            attachments: m.attachments || [],
            score: '-',
            body_snippet: (m.body || '').slice(0, 240),
            eml_file: m.eml_file || '',
            mail_id: m.id || '',
        }));

        applyMailchatResults(pseudo, 'Affichage direct des mails de la période sélectionnée (sans recherche sémantique).');
        setChatbotQueryInfo(`Période ${mailchatPeriodFilter}: ${mailchatLastResults.length} mail(s).`, 'success');
    } catch (err) {
        setChatbotQueryInfo(`⚠️ ${err.message || err}`, 'error');
    }
}

function openMarkdownReaderWindow({ subject, date, sender }, rawMarkdown) {
        const safeSubject = esc(subject || 'Sans sujet');
        const meta = `📅 ${esc(date || '?')} · 👤 ${esc(sender || '?')}`;
        const isDark = false; // Always use light background for readability
        const renderedBody = marked.parse(rawMarkdown || '(contenu indisponible)');

        const htmlDoc = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${safeSubject}</title>
<style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        background: ${isDark ? '#0B0F1A' : '#F9FAFB'};
        color: ${isDark ? '#E5E7EB' : '#111827'};
        padding: 2rem;
        line-height: 1.7;
        max-width: 800px;
        margin: 0 auto;
    }
    .reader-header {
        border-bottom: 1px solid ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'};
        padding-bottom: 1rem;
        margin-bottom: 1.5rem;
    }
    .reader-subject { font-size: 1.3rem; font-weight: 700; margin-bottom: 0.4rem; }
    .reader-meta { font-size: 0.82rem; color: ${isDark ? '#9CA3AF' : '#4B5563'}; }
    .reader-body { font-size: 0.92rem; }
    .reader-body p, .reader-body ul, .reader-body ol, .reader-body blockquote, .reader-body pre { margin: 0 0 0.75rem; }
    .reader-body h1, .reader-body h2, .reader-body h3 { margin: 1.2rem 0 0.5rem; }
    .reader-body hr {
        border: none;
        border-top: 1px solid ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'};
        margin: 1rem 0;
    }
    .reader-body a { color: #3B82F6; text-decoration: underline; }
    .reader-body blockquote {
        border-left: 3px solid ${isDark ? '#374151' : '#D1D5DB'};
        padding-left: 1rem;
        color: ${isDark ? '#9CA3AF' : '#6B7280'};
    }
    .reader-body pre {
        background: ${isDark ? '#1F2937' : '#F3F4F6'};
        padding: 0.8rem;
        border-radius: 6px;
        overflow-x: auto;
        font-size: 0.85rem;
    }
    .reader-body code {
        background: ${isDark ? '#1F2937' : '#F3F4F6'};
        padding: 0.15rem 0.35rem;
        border-radius: 3px;
        font-size: 0.88em;
    }
    .reader-body img { max-width: 100%; border-radius: 6px; }
</style>
</head>
<body>
    <div class="reader-header">
        <div class="reader-subject">${safeSubject}</div>
        <div class="reader-meta">${meta}</div>
    </div>
    <div class="reader-body">${renderedBody}</div>
</body>
</html>`;

        const win = window.open('', '_blank', 'width=820,height=700');
        if (win) {
                win.document.write(htmlDoc);
                win.document.close();
        }
}

async function openMailchatMailReader(index) {
    const result = mailchatLastResults[index];
    if (!result) return;

    // Fetch the full markdown content
    let raw = '';
    if (result.eml_file) {
        const mdName = result.eml_file.endsWith('.md') ? result.eml_file : result.eml_file;
        for (const tryPath of [`mails/${mdName}`, mdName]) {
            try {
                const vr = await fetch('/api/vault/read?path=' + encodeURIComponent(tryPath));
                if (vr.ok) {
                    const vj = await vr.json();
                    if (vj.ok && vj.content) {
                        raw = String(vj.content).replace(/^---[\s\S]*?---\s*/, '').trim();
                        break;
                    }
                }
            } catch (_) {}
        }
    }
    if (!raw) {
        try {
            let mail = null;
            if (result.mail_id) {
                const r = await fetch('/api/mail/' + encodeURIComponent(result.mail_id));
                if (r.ok) mail = await r.json();
            } else if (result.eml_file) {
                const r = await fetch('/api/mail/by-eml?eml_file=' + encodeURIComponent(result.eml_file));
                if (r.ok) mail = await r.json();
            }
            if (mail?.body) raw = mail.body;
            else if (mail?.body_html) {
                raw = String(mail.body_html)
                    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
                    .replace(/<\s*\/\s*(p|div|li|tr|h[1-6])\s*>/gi, '\n')
                    .replace(/<[^>]+>/g, ' ')
                    .replace(/[ \t]+/g, ' ')
                    .replace(/\n{3,}/g, '\n\n')
                    .trim();
            }
        } catch (_) {}
    }
    if (!raw) raw = result.body_snippet || '(contenu indisponible)';

        openMarkdownReaderWindow(
                {
                        subject: result.subject || 'Sans sujet',
                        date: result.date || '?',
                        sender: result.sender_name || result.sender_email || '?',
                },
                raw,
        );
}

function setChatbotSyncProgress(state) {
    const wrap = document.getElementById('chatbotSyncProgress');
    const label = document.getElementById('chatbotSyncLabel');
    const pct = document.getElementById('chatbotSyncPercent');
    const bar = document.getElementById('chatbotSyncBar');
    const meta = document.getElementById('chatbotSyncMeta');
    if (!wrap || !label || !pct || !bar || !meta) return;

    if (!state || (!state.running && !state.finished)) {
        wrap.classList.add('is-hidden');
        return;
    }

    wrap.classList.remove('is-hidden');
    const total = Number(state.total || 0);
    const processed = Number(state.processed || 0);
    const percent = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
    const phase = state.phase || 'starting';
    const source = state.source || '';
    const ingested = Number(state.ingested || 0);

    label.textContent = state.running ? `Sync Neo4j (${phase})` : 'Sync Neo4j terminée';
    pct.textContent = `${percent}%`;
    bar.style.width = `${percent}%`;

    let metaText = `${processed}/${total} traités · ${ingested} ingérés`;
    if (source) metaText += ` · ${source}`;
    if (state.current_file) metaText += ` · ${state.current_file}`;
    if (state.error) metaText += ` · erreur: ${state.error}`;
    meta.textContent = metaText;
}

async function pollChatbotIngestStatus() {
    try {
        const r = await fetch('/api/neo4j/ingest-status');
        const data = await r.json();
        setChatbotSyncProgress(data);
        if (!data.running) {
            if (chatbotIngestPollTimer) {
                clearInterval(chatbotIngestPollTimer);
                chatbotIngestPollTimer = null;
            }
            if (data.finished) {
                if (data.error) {
                    setChatbotQueryInfo(`⚠️ Sync: ${data.error}`, 'error');
                } else {
                    setChatbotQueryInfo(`✅ ${data.ingested || 0} email(s) synchronisés dans Neo4j.`, 'success');
                }
            }
            checkChatbotStatus();
        }
    } catch (err) {
        mailchatLog('status poll failed', err?.message || err);
    }
}

async function checkChatbotStatus() {
    mailchatLog('checking Neo4j status');
    const dot = document.getElementById('chatbotStatusDot');
    const text = document.getElementById('chatbotStatusText');
    dot.className = 'chatbot-status-dot loading';
    text.textContent = 'Connexion à Neo4j…';
    try {
        const r = await fetch('/api/neo4j/status');
        const data = await r.json();
        mailchatLog('Neo4j status response', data);
        chatbotNeo4jAvailable = data.available;
        if (data.available) {
            dot.className = 'chatbot-status-dot online';
            text.textContent = 'Neo4j connecté';
        } else {
            dot.className = 'chatbot-status-dot offline';
            text.textContent = 'Neo4j non disponible';
        }
    } catch {
        mailchatLog('Neo4j status fetch failed');
        chatbotNeo4jAvailable = false;
        dot.className = 'chatbot-status-dot offline';
        text.textContent = 'Erreur de connexion';
    }
}

function openChatbotAttachment(mailId, attachmentName, emlFile) {
    const qs = new URLSearchParams();
    if (mailId) qs.set('id', String(mailId));
    if (emlFile) qs.set('eml_file', String(emlFile));
    qs.set('name', String(attachmentName || ''));
    const url = `/api/mail/attachment?${qs.toString()}`;
    window.open(url, '_blank', 'noopener');
}

async function sendChatbotQuery() {
    if (chatbotLoading) return;
    const fields = collectSemanticFields();
    let question = buildSemanticQuestion(fields);
    if (!question) return;

    const useLLM = document.getElementById('chatbotUseLLM')?.checked ?? true;
    const autoRewrite = document.getElementById('chatbotAutoRewrite')?.checked ?? true;
    const endpoint = useLLM ? '/api/chatbot/query' : '/api/chatbot/search';

    mailchatLog('query submitted', { question, fields, useLLM, autoRewrite });
    setChatbotQueryInfo('Recherche en cours…');
    renderMailchatAnswer('', 'Analyse en cours…');
    renderMailchatResults([]);
    renderMailchatAttachments([]);

    chatbotLoading = true;
    try {
        if (autoRewrite) {
            const n = await fetch('/api/chatbot/normalize', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ question, fields }),
            });
            const nd = await n.json();
            if (!nd.error && nd.normalized_question) {
                question = nd.normalized_question;
            }
        }

        const r = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question, top_k: 10, generate: useLLM }),
        });
        const data = await r.json();
        mailchatLog('query response', {
            ok: !data.error,
            count: data.count,
            retrieval: data.retrieval,
            question_rewritten: data.question_rewritten,
        });

        if (data.error) {
            setChatbotQueryInfo(`⚠️ ${data.error}`, 'error');
            renderMailchatAnswer('', 'Erreur de recherche.');
        } else {
            const mode = data.llm_used
                ? 'Mode GraphRAG + synthèse IA'
                : 'Mode GraphRAG (sans synthèse IA)';
            const rewriteNote = data.question_rewritten && data.retrieval_question
                ? ` · Requête optimisée: ${data.retrieval_question}`
                : '';
            const warning = data.llm_warning ? ` · ${data.llm_warning}` : '';
            setChatbotQueryInfo(`${mode}${rewriteNote}${warning}`, data.llm_warning ? 'error' : 'success');

            applyMailchatResults(Array.isArray(data.results) ? data.results : [], data.answer || '');
        }
    } catch (err) {
        mailchatLog('query failed', err?.message || err);
        setChatbotQueryInfo(`⚠️ ${err.message}`, 'error');
        renderMailchatAnswer('', 'Erreur réseau.');
    } finally {
        chatbotLoading = false;
    }
}

async function chatbotIngest() {
    const btn = document.querySelector('.chatbot-action-btn');
    if (!btn) return;
    const originalHtml = btn.innerHTML;
    btn.innerHTML = '<i class="icon-refresh-cw"></i> Sync en cours…';
    btn.disabled = true;
    mailchatLog('sync requested');

    try {
        const r = await fetch('/api/neo4j/ingest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: 'both' }),
        });
        const data = await r.json();
        mailchatLog('sync start response', data);
        if (data.error) {
            setChatbotQueryInfo(`⚠️ Sync: ${data.error}`, 'error');
        } else {
            setChatbotQueryInfo('Sync Neo4j démarrée…');
            setChatbotSyncProgress(data);
            if (chatbotIngestPollTimer) clearInterval(chatbotIngestPollTimer);
            chatbotIngestPollTimer = setInterval(pollChatbotIngestStatus, 800);
            await pollChatbotIngestStatus();
        }
    } catch (err) {
        mailchatLog('sync request failed', err?.message || err);
        setChatbotQueryInfo(`⚠️ ${err.message}`, 'error');
    } finally {
        btn.innerHTML = originalHtml;
        btn.disabled = false;
    }
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

function sitePartitionForTabId(tabId) {
    const slug = String(tabId || '')
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .slice(0, 64) || 'default';
    return `persist:site-tab-${slug}`;
}

const DEFAULT_SITE_TABS = [
    { id: 'site-default-evento', label: 'Evento', url: 'https://evento.renater.fr/', icon: 'icon-calendar-days' },
    { id: 'site-default-filesender', label: 'FileSender', url: 'https://filesender.renater.fr/', icon: 'icon-send' },
    { id: 'site-default-renavisio', label: 'RenaVisio', url: 'https://rendez-vous.renater.fr/home/renavisio', icon: 'icon-video' },
    { id: 'site-default-github', label: 'GitHub', url: 'https://github.com/', icon: 'icon-github' },
    { id: 'site-default-gemini', label: 'Gemini', url: 'https://gemini.google.com/app', icon: 'icon-sparkles' },
];

function buildDefaultSiteTabs() {
    return normalizeSiteTabs(DEFAULT_SITE_TABS);
}

/* ── Persistence ──────────────────────────────── */
function normalizeSiteTabs(input) {
    if (!Array.isArray(input)) return [];
    return input
        .filter(t => t && t.id && t.url)
        .map(t => ({
            id: String(t.id),
            label: String(t.label || hostFromAnyUrl(t.url) || 'Site'),
            url: ensureUrlWithScheme(t.url),
            icon: String(t.icon || 'icon-globe'),
            partition: (typeof t.partition === 'string' && t.partition.trim())
                ? t.partition.trim()
                : sitePartitionForTabId(t.id),
        }));
}

function saveSiteTabs() {
    siteTabs = normalizeSiteTabs(siteTabs);
    if (!state.settings) state.settings = {};
    state.settings.siteTabs = siteTabs;
    autoSave();

    // Keep legacy localStorage mirror for backward compatibility.
    try {
        localStorage.setItem(SITE_TABS_STORAGE_KEY, JSON.stringify(siteTabs));
    } catch {}
}

function loadSiteTabs() {
    const fromState = normalizeSiteTabs(state?.settings?.siteTabs);
    if (fromState.length) {
        try {
            localStorage.setItem(SITE_TABS_STORAGE_KEY, JSON.stringify(fromState));
        } catch {}
        return fromState;
    }

    try {
        const raw = localStorage.getItem(SITE_TABS_STORAGE_KEY);
        if (!raw) return buildDefaultSiteTabs();
        const parsed = JSON.parse(raw);
        const normalized = normalizeSiteTabs(parsed);

        // One-time migration localStorage -> persisted backend app state.
        if (normalized.length) {
            if (!state.settings) state.settings = {};
            state.settings.siteTabs = normalized;
            autoSave();
        }

        return normalized;
    } catch {
        return buildDefaultSiteTabs();
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
        siteTabs.push({ id, label, url, icon, partition: sitePartitionForTabId(id) });
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
        await api.browserCreateTab({
            tabId,
            url: tab.url,
            partition: tab.partition || sitePartitionForTabId(tab.id),
            activate: true
        });
    } else {
        await api.browserActivateTab(tabId);
    }

    // Update address bar
    const addr = document.getElementById('siteTabAddress');
    if (addr) addr.value = tab.url || '';

    updateSiteTabViewVisibility();
}

function updateSiteTabViewVisibility() {
    syncBrowserVisibilityForUiState();
}

function hasOpenModalOverlay() {
    return !!document.querySelector('.modal-overlay.show');
}

async function syncBrowserVisibilityForUiState() {
    const api = getBrowserApi();
    if (!api || !api.browserSetVisible) return;
    const isSiteTab = currentTab.startsWith('site-');
    const shouldShowBrowser = isSiteTab && !hasOpenModalOverlay();

    try {
        await api.browserSetVisible(shouldShowBrowser);
        if (shouldShowBrowser && siteTabsInitialized[currentTab]) {
            await api.browserActivateTab(currentTab);
            updateSiteTabViewBounds();
        }
    } catch {}
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
        // Track credential state
        if (typeof payload.hasCredentials === 'boolean' || typeof payload.hasLoginForm === 'boolean') {
            if (!siteTabCredentialState[tabId]) siteTabCredentialState[tabId] = {};
            if (typeof payload.hasCredentials === 'boolean') {
                siteTabCredentialState[tabId].hasCredentials = payload.hasCredentials;
                siteTabCredentialState[tabId].credentialId = payload.credentialId || null;
            }
            if (typeof payload.hasLoginForm === 'boolean') {
                siteTabCredentialState[tabId].hasLoginForm = payload.hasLoginForm;
            }
            if (tabId === currentTab) updateSiteTabCredentialUI();
        }
    });
    browserEventsBound = true;
}

/* ── Credential UI helpers ────────────────────── */
function updateSiteTabCredentialUI() {
    const tabState = siteTabCredentialState[currentTab] || {};
    const autofillBtn = document.getElementById('siteTabAutofillBtn');
    const saveBtn = document.getElementById('siteTabSaveCredentialBtn');
    if (autofillBtn) {
        autofillBtn.style.display = (tabState.hasCredentials && tabState.hasLoginForm) ? '' : 'none';
    }
    if (saveBtn) {
        saveBtn.style.display = tabState.hasLoginForm ? '' : 'none';
    }
}

async function siteTabAutofill() {
    const api = getBrowserApi();
    if (!api || !api.browserAutofillSavedCredential) return;
    const tabState = siteTabCredentialState[currentTab] || {};
    if (!tabState.credentialId) {
        showToast('Aucun identifiant sauvegardé pour ce site.', 'error');
        return;
    }
    const result = await api.browserAutofillSavedCredential({ tabId: currentTab, credentialId: tabState.credentialId });
    if (result && result.ok) {
        showToast('Identifiants remplis !', 'success');
    } else {
        showToast('Échec du remplissage : ' + (result?.error || 'erreur inconnue'), 'error', 3000);
    }
}

function openSaveCredentialModal() {
    const addr = document.getElementById('siteTabAddress');
    const currentUrl = addr ? addr.value : '';
    document.getElementById('credentialSaveOrigin').value = currentUrl;
    document.getElementById('credentialSaveUsername').value = '';
    document.getElementById('credentialSavePassword').value = '';
    document.getElementById('credentialSaveModal').classList.add('show');
    syncBrowserVisibilityForUiState();
}

function closeSaveCredentialModal() {
    document.getElementById('credentialSaveModal').classList.remove('show');
    syncBrowserVisibilityForUiState();
}

async function confirmSaveCredential() {
    const api = getBrowserApi();
    if (!api || !api.passwordVaultUpsert) return;
    const origin = document.getElementById('credentialSaveOrigin').value;
    const username = document.getElementById('credentialSaveUsername').value.trim();
    const password = document.getElementById('credentialSavePassword').value;
    const label = (getSiteTab(currentTab)?.label || '').trim();
    if (!username || !password) {
        showToast('Identifiant et mot de passe requis.', 'error');
        return;
    }
    const result = await api.passwordVaultUpsert({ origin, username, password, label });
    if (result && result.ok) {
        showToast('Identifiants sauvegardés avec chiffrement.', 'success');
        closeSaveCredentialModal();
        // Update credential state for the current tab
        if (!siteTabCredentialState[currentTab]) siteTabCredentialState[currentTab] = {};
        siteTabCredentialState[currentTab].hasCredentials = true;
        siteTabCredentialState[currentTab].credentialId = result.entryId || null;
        updateSiteTabCredentialUI();
    } else {
        showToast('Erreur : ' + (result?.error || 'Échec de la sauvegarde'), 'error', 4000);
    }
}

async function openManageCredentialsModal() {
    const api = getBrowserApi();
    if (!api || !api.passwordVaultList) return;
    const result = await api.passwordVaultList();
    const entries = (result && result.ok && Array.isArray(result.entries)) ? result.entries : [];
    const list = document.getElementById('credentialManagerList');
    if (!list) return;
    if (!entries.length) {
        list.innerHTML = '<p class="credentials-empty">Aucun identifiant sauvegardé.</p>';
    } else {
        list.innerHTML = entries.map(e => `
            <div class="credential-item" data-cid="${esc(e.id)}">
                <div class="credential-item-info">
                    <strong>${esc(e.origin)}</strong>
                    <span>${esc(e.label || e.origin)}</span>
                    <small>${esc(e.username)}</small>
                </div>
                <button class="credential-item-delete" onclick="deleteCredential('${esc(e.id)}')" title="Supprimer"><i class="icon-trash-2"></i></button>
            </div>
        `).join('');
    }
    document.getElementById('credentialManagerModal').classList.add('show');
}

function closeManageCredentialsModal() {
    document.getElementById('credentialManagerModal').classList.remove('show');
}

async function deleteCredential(credentialId) {
    const api = getBrowserApi();
    if (!api || !api.passwordVaultDelete) return;
    if (!confirm('Supprimer cet identifiant ?')) return;
    const result = await api.passwordVaultDelete(credentialId);
    if (result && result.ok) {
        showToast('Identifiant supprimé.', 'success');
        // Reset credential state for any tab using this credential
        Object.keys(siteTabCredentialState).forEach(tabId => {
            if (siteTabCredentialState[tabId].credentialId === credentialId) {
                siteTabCredentialState[tabId].hasCredentials = false;
                siteTabCredentialState[tabId].credentialId = null;
            }
        });
        updateSiteTabCredentialUI();
        openManageCredentialsModal(); // refresh
    } else {
        showToast('Erreur : ' + (result?.error || 'Échec'), 'error', 3000);
    }
}


let siteModalVisibilityObserverStarted = false;
function initSiteModalVisibilityBridge() {
    if (siteModalVisibilityObserverStarted) return;
    siteModalVisibilityObserverStarted = true;

    const overlays = Array.from(document.querySelectorAll('.modal-overlay'));
    if (!overlays.length) return;

    const observer = new MutationObserver(() => {
        if (currentTab.startsWith('site-')) {
            syncBrowserVisibilityForUiState();
        }
    });

    overlays.forEach((el) => {
        observer.observe(el, { attributes: true, attributeFilter: ['class'] });
    });
}

/* ── Startup restore ──────────────────────────── */
function initSiteTabs() {
    siteTabs = loadSiteTabs();
    saveSiteTabs(); // persist partition migration for old tabs
    renderSiteTabButtons();
    initSiteModalVisibilityBridge();
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
    // Ctrl+4 — switch to MailChat tab
    if ((e.ctrlKey || e.metaKey) && e.key === '4') {
        e.preventDefault();
        switchTab('mailchat');
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
        if (typeof closeReminderModal === 'function') closeReminderModal();
        if (typeof closeAccountsModal === 'function') closeAccountsModal();
        if (typeof closeDeleteMailModal === 'function') closeDeleteMailModal();
    }
    // Delete — delete selected inbox mail
    if (e.key === 'Delete' && currentTab === 'inbox' && selectedInboxId) {
        openDeleteMailModal(selectedInboxId);
    }
});

/* ═══════════════════════════════════════════════════════
   Archive Mail Tab
   ═══════════════════════════════════════════════════════ */
let archiveAllMails = [];
let archiveVisibleMails = [];
let archivePeriod = 'today';
let archiveLoaded = false;

async function loadArchiveMails() {
    if (archiveLoaded) return;
    const list = document.getElementById('archiveList');
    if (!list) return;
    list.innerHTML = '<div class="chatbot-welcome"><p>Chargement des archives…</p></div>';
    try {
        const r = await fetch('/api/vault/mails');
        if (!r.ok) throw new Error('Erreur serveur');
        archiveAllMails = await r.json();
        // Sort by date descending
        archiveAllMails.sort((a, b) => {
            const da = parseArchiveDate(a.date);
            const db = parseArchiveDate(b.date);
            return db - da;
        });
        archiveLoaded = true;
        filterArchiveMails();
    } catch (err) {
        list.innerHTML = `<div class="archive-empty">Erreur: ${esc(err.message)}</div>`;
    }
}

function parseArchiveDate(dateStr) {
    if (!dateStr) return 0;
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? 0 : d.getTime();
}

function setArchivePeriod(period) {
    archivePeriod = period || 'today';
    document.querySelectorAll('.archive-chip').forEach((chip) => {
        chip.classList.toggle('active', chip.dataset.period === archivePeriod);
    });
    filterArchiveMails();
}

function filterArchiveMails() {
    const now = new Date();
    const rangeStart = new Date(now);
    rangeStart.setHours(0, 0, 0, 0);

    if (archivePeriod === 'week') {
        const day = (rangeStart.getDay() + 6) % 7;
        rangeStart.setDate(rangeStart.getDate() - day);
    } else if (archivePeriod === 'month') {
        rangeStart.setDate(1);
    }

    const filtered = archiveAllMails.filter(m => {
        const d = parseArchiveDate(m.date);
        return d >= rangeStart.getTime() && d <= now.getTime();
    });

    archiveVisibleMails = filtered;
    renderArchiveList(filtered);
}

function renderArchiveList(mails) {
    const list = document.getElementById('archiveList');
    const count = document.getElementById('archiveCount');
    if (!list) return;
    if (count) count.textContent = `${mails.length} mail${mails.length !== 1 ? 's' : ''}`;

    if (!mails.length) {
        list.innerHTML = '<div class="archive-empty">Aucun mail trouvé pour ces critères.</div>';
        return;
    }

    list.innerHTML = mails.map((m, i) => {
        const preview = (m.body || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        return `
            <div class="archive-mail-item archive-mail-clickable" onclick="openArchiveMailReader(${i})" title="Ouvrir le markdown">
                <div class="archive-mail-summary">
                    <span class="archive-mail-subject">${esc(m.subject || m.filename || 'Sans sujet')}</span>
                    <span class="archive-mail-meta">📅 ${esc(m.date || '?')} · 👤 ${esc(m.from || '?')} → ${esc(m.to || '?')}</span>
                    ${preview ? `<span class="archive-mail-preview">${esc(preview)}</span>` : ''}
                </div>
            </div>
        `;
    }).join('');
}

function openArchiveMailReader(index) {
    const mail = archiveVisibleMails[index];
    if (!mail) return;
    openMarkdownReaderWindow(
        {
            subject: mail.subject || mail.filename || 'Sans sujet',
            date: mail.date || '?',
            sender: mail.from || '?',
        },
        mail.body || '(contenu vide)',
    );
}
