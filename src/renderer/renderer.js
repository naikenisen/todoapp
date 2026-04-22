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
let commercialSendersSettings = [];
let bgActivitySeq = 0;
const bgActivities = new Map();

const DEFAULT_MAIL_N2_MAP = {
    'EV': ['Congrès REVE 2024 TNE','Poster ISEV 2024 TNE','article_cart','exosarc','alcina','tne','exodiag','lymphome','exomel','pseudoprogression','evolve','krasipanc','thèse pharmacie','etude_observationnelle','memoire_des'],
    'Histologie': ['ia2hl','these_valentin','biolymph','mdh2','iabm','intensify','modèle de diffusion','sfh'],
    'imagerie': ['radiomic-opc','TMTVpred'],
    'multimodal': ['AAP ICE','FRFT-Doc','AAP MIC','AAP FRFT-Doc','CART-IA','AAP ARC','presentation thèse','PIF','financement DSPS','4 plan pour le stage en PUI'],
    'nexomedis': ['axone','article_adlis','these_alexandre','nexostock','ASH 2026'],
    'revue ia santé': ['Banque !','Préfecture !','INPI !','CrossRef !','Reconnaissance presse !','La poste Pro !','BNF !','OJS !','Comité scientifique !','Partenaires !','Graphique design !','Comptabilité !','eseo !','maison associations !','premiere soumission !','publicité'],
};

const DEFAULT_MAIL_N1_LIST = ['EV', 'Histologie', 'imagerie', 'multimodal', 'nexomedis', 'revue ia santé'];

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
    if (tab === 'mail-process') {
        refreshMailProcessSummary();
        processMyMails({ silentWhenEmpty: true });
    }
    if (tab === 'downloads') {
        ensureDownloadsAutoRefresh();
        loadDownloadsManager();
    }
    if (tab === 'annuaire') loadAnnuaire();
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
    ensureMailTaxonomySettings();
}

function ensureMailTaxonomySettings() {
    if (!state.settings) state.settings = {};

    const existing = state.settings.mailTaxonomy;
    if (!existing || typeof existing !== 'object') {
        state.settings.mailTaxonomy = {
            n1List: [...DEFAULT_MAIL_N1_LIST],
            n2Map: JSON.parse(JSON.stringify(DEFAULT_MAIL_N2_MAP)),
        };
        return;
    }

    if (!Array.isArray(existing.n1List)) {
        existing.n1List = [...DEFAULT_MAIL_N1_LIST];
    }
    if (!existing.n2Map || typeof existing.n2Map !== 'object' || Array.isArray(existing.n2Map)) {
        existing.n2Map = JSON.parse(JSON.stringify(DEFAULT_MAIL_N2_MAP));
    }

    const cleanedN1 = existing.n1List
        .map(v => String(v || '').trim())
        .filter(Boolean);
    existing.n1List = [...new Set(cleanedN1)];

    const cleanedMap = {};
    Object.entries(existing.n2Map).forEach(([k, arr]) => {
        const key = String(k || '').trim();
        if (!key) return;
        const values = Array.isArray(arr)
            ? arr.map(v => String(v || '').trim()).filter(Boolean)
            : [];
        cleanedMap[key] = [...new Set(values)];
    });
    existing.n2Map = cleanedMap;

    existing.n1List.forEach((n1) => {
        if (!existing.n2Map[n1]) existing.n2Map[n1] = [];
    });
}

function getMailTaxonomy() {
    ensureMailTaxonomySettings();
    const tax = state.settings.mailTaxonomy;
    const n1List = Array.isArray(tax.n1List) ? tax.n1List : [];
    const n2Map = (tax.n2Map && typeof tax.n2Map === 'object') ? tax.n2Map : {};
    return { n1List, n2Map };
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
        + '<button class="add-section-btn" onclick="openSectionModal()"><i class="icon-plus"></i> Nouvelle section</button>'
        + renderArchives();
    updateProgress();
    setupDragDrop();
    window.scrollTo(0, scrollY);
}

function renderHeader() {
    return '';
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
        const totalTasks = s.tasks.length;
        const tasksHtml = s.tasks.map((t, idx) => renderTask(t, s.id, idx, totalTasks)).join('');
        const modeBtn = `<button class="btn-section-mode ${editMode ? 'active' : ''}" onclick="event.stopPropagation();toggleEdit()" title="${editMode ? 'Terminer édition' : 'Éditer'}">${editMode ? 'Terminer' : 'Éditer'}</button>`;
        const editBtns = `<button class="btn-icon" onclick="event.stopPropagation();openSectionModal('${s.id}')" title="Modifier la section"><i class="icon-pencil"></i></button>`;
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
                    ${modeBtn}
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

function getPriorityColor(index, total) {
    if (total <= 1) return '#6c8aff';
    const ratio = index / (total - 1);
    // Red (urgent) → Orange → Green → Blue (less urgent)
    if (ratio <= 0.33) {
        const t = ratio / 0.33;
        const r = Math.round(239 + (245 - 239) * t);
        const g = Math.round(68 + (158 - 68) * t);
        const b = Math.round(68 + (11 - 68) * t);
        return `rgb(${r},${g},${b})`;
    } else if (ratio <= 0.66) {
        const t = (ratio - 0.33) / 0.33;
        const r = Math.round(245 + (52 - 245) * t);
        const g = Math.round(158 + (211 - 158) * t);
        const b = Math.round(11 + (153 - 11) * t);
        return `rgb(${r},${g},${b})`;
    } else {
        const t = (ratio - 0.66) / 0.34;
        const r = Math.round(52 + (108 - 52) * t);
        const g = Math.round(211 + (138 - 211) * t);
        const b = Math.round(153 + (255 - 153) * t);
        return `rgb(${r},${g},${b})`;
    }
}

function renderTask(t, sid, index, total) {
    const cls = [
        'task-item',
        t.done ? 'checked' : '',
        t.indent ? 'sub-task' : '',
        (t.type === 'mail' || t.isMail) ? 'is-mail' : ''
    ].filter(Boolean).join(' ');

    const check = `<div class="custom-check" onclick="toggleTask('${sid}','${t.id}')">
        <svg viewBox="0 0 24 24"><polyline points="4 12 10 18 20 6"/></svg></div>`;

    const priorityColor = getPriorityColor(index, total);
    const priorityBadge = `<span class="priority-badge" style="background:${priorityColor}" title="Priorité ${index + 1}">${index + 1}</span>`;

    if (editMode) {
        const typeBadge = (t.type === 'mail' || t.isMail)
            ? '<span class="task-type-badge"><i class="icon-mail"></i> Mail</span>'
            : '';
        return `
        <div class="${cls}" data-sid="${sid}" data-tid="${t.id}" draggable="true">
            ${priorityBadge}
            ${check}
            <div class="task-edit-fields">
                <input type="text" class="task-input" value="${esc(t.label)}"
                    onchange="updateTask('${sid}','${t.id}','label',this.value)"
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
        ${priorityBadge}
        ${check}
        <span class="task-label" onclick="toggleTask('${sid}','${t.id}')">
            ${esc(t.label)}
        </span>
    </div>`;
}

function startBackgroundActivity(label) {
    const text = String(label || '').trim() || 'Tâche en arrière-plan';
    const id = `bg-${++bgActivitySeq}`;
    bgActivities.set(id, { label: text, startTs: Date.now() });
    renderBackgroundActivityIndicator();
    return id;
}

function stopBackgroundActivity(id) {
    if (!id) return;
    bgActivities.delete(id);
    renderBackgroundActivityIndicator();
}

function renderBackgroundActivityIndicator() {
    const holder = document.getElementById('bgActivityIndicator');
    const countEl = document.getElementById('bgActivityCount');
    if (!holder || !countEl) return;

    const items = Array.from(bgActivities.values());
    if (!items.length) {
        holder.classList.remove('is-active');
        holder.title = 'Aucune activité en arrière-plan';
        holder.setAttribute('aria-label', 'Aucune activité en arrière-plan');
        countEl.textContent = '';
        return;
    }

    const groups = new Map();
    for (const item of items) {
        groups.set(item.label, (groups.get(item.label) || 0) + 1);
    }

    const lines = [];
    for (const [label, count] of groups.entries()) {
        lines.push(`- ${label}${count > 1 ? ` (x${count})` : ''}`);
    }

    holder.classList.add('is-active');
    holder.title = `Activités en arrière-plan:\n${lines.join('\n')}`;
    holder.setAttribute('aria-label', `Activités en arrière-plan (${items.length})`);
    countEl.textContent = String(items.length);
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
            document.querySelectorAll('.drag-above').forEach(x => x.classList.remove('drag-above'));
            document.querySelectorAll('.drag-below').forEach(x => x.classList.remove('drag-below'));
            dragData = null;
        });

        el.addEventListener('dragover', e => {
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'move';
            if (!dragData) return;
            // Show drop indicator above or below the hovered task
            const rect = el.getBoundingClientRect();
            const midY = rect.top + rect.height / 2;
            document.querySelectorAll('.drag-above, .drag-below').forEach(x => {
                x.classList.remove('drag-above', 'drag-below');
            });
            if (e.clientY < midY) {
                el.classList.add('drag-above');
            } else {
                el.classList.add('drag-below');
            }
        });

        el.addEventListener('dragleave', () => {
            el.classList.remove('drag-above', 'drag-below');
        });

        el.addEventListener('drop', e => {
            e.preventDefault();
            e.stopPropagation();
            el.classList.remove('drag-above', 'drag-below');
            if (!dragData) return;

            const targetSid = el.dataset.sid;
            const targetTid = el.dataset.tid;
            const fromSection = state.sections.find(s => s.id === dragData.sid);
            const toSection = state.sections.find(s => s.id === targetSid);
            if (!fromSection || !toSection) return;

            const fromIdx = fromSection.tasks.findIndex(t => t.id === dragData.tid);
            if (fromIdx === -1) return;

            // Determine insert position
            const rect = el.getBoundingClientRect();
            const midY = rect.top + rect.height / 2;
            let toIdx = toSection.tasks.findIndex(t => t.id === targetTid);
            if (e.clientY >= midY) toIdx += 1;

            // Same section reorder
            if (dragData.sid === targetSid) {
                if (fromIdx === toIdx || fromIdx + 1 === toIdx) return;
                const [task] = fromSection.tasks.splice(fromIdx, 1);
                const insertIdx = fromIdx < toIdx ? toIdx - 1 : toIdx;
                fromSection.tasks.splice(insertIdx, 0, task);
            } else {
                const [task] = fromSection.tasks.splice(fromIdx, 1);
                toSection.tasks.splice(toIdx, 0, task);
            }

            render();
            autoSave();
            showToast('Tâche déplacée', 'success', 1500);
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
    loadCommercialSendersSettings();
    renderMailTaxonomySettingsForm();
    const contactsCount = document.getElementById('contactsCount');
    if (contactsCount) contactsCount.textContent = `${contacts.length} contacts chargés`;
}

function renderMailTaxonomySettingsForm() {
    const n1El = document.getElementById('settingN1ListInput');
    const n2El = document.getElementById('settingN2MapInput');
    if (!n1El || !n2El) return;

    const { n1List, n2Map } = getMailTaxonomy();
    n1El.value = n1List.join('\n');

    const lines = n1List.map((n1) => {
        const n2 = Array.isArray(n2Map[n1]) ? n2Map[n1] : [];
        return `${n1}: ${n2.join(', ')}`;
    });
    n2El.value = lines.join('\n');
}

function saveMailTaxonomySettings() {
    const n1El = document.getElementById('settingN1ListInput');
    const n2El = document.getElementById('settingN2MapInput');
    if (!n1El || !n2El) return;

    const n1List = n1El.value
        .split(/\r?\n/)
        .map(v => v.trim())
        .filter(Boolean);

    const n2Map = {};
    const rawLines = n2El.value
        .split(/\r?\n/)
        .map(v => v.trim())
        .filter(Boolean);

    rawLines.forEach((line) => {
        const idx = line.indexOf(':');
        if (idx <= 0) return;
        const n1 = line.slice(0, idx).trim();
        const rhs = line.slice(idx + 1).trim();
        const n2Items = rhs
            ? rhs.split(',').map(v => v.trim()).filter(Boolean)
            : [];
        if (n1) n2Map[n1] = [...new Set(n2Items)];
    });

    const finalN1 = [...new Set(n1List)];
    finalN1.forEach((n1) => {
        if (!n2Map[n1]) n2Map[n1] = [];
    });

    state.settings.mailTaxonomy = {
        n1List: finalN1,
        n2Map,
    };

    autoSave();
    renderMailTaxonomySettingsForm();
    mpRenderN1Options();
    showToast('Niveaux N1/N2 sauvegardés.', 'success', 2500);
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
    }
    if (key === 'commercial') {
        loadCommercialSendersSettings();
    }
    if (btn) btn.blur();
}

function renderCommercialSendersSettings() {
    const container = document.getElementById('commercialSendersList');
    if (!container) return;

    if (!Array.isArray(commercialSendersSettings) || !commercialSendersSettings.length) {
        container.innerHTML = '<div class="commercial-senders-empty">Aucune adresse commerciale enregistrée.</div>';
        return;
    }

    container.innerHTML = commercialSendersSettings.map((item) => {
        const email = String(item?.email || '').trim().toLowerCase();
        const count = Number(item?.count || 0);
        const encodedEmail = encodeURIComponent(email);
        return `
            <div class="commercial-sender-row">
                <div class="commercial-sender-meta">
                    <div class="commercial-sender-email">${esc(email)}</div>
                    <div class="commercial-sender-count">${count} mail(s) indexé(s)</div>
                </div>
                <button class="stg-btn stg-btn-danger stg-btn-sm" onclick="removeCommercialSender('${encodedEmail}')"><i class="icon-trash-2"></i> Retirer</button>
            </div>`;
    }).join('');
}

async function loadCommercialSendersSettings() {
    try {
        const r = await fetch('/api/commercial/senders');
        const data = await r.json();
        if (!r.ok || !data.ok) throw new Error(data.error || 'Chargement impossible');
        commercialSendersSettings = Array.isArray(data.senders) ? data.senders : [];
        renderCommercialSendersSettings();
    } catch (e) {
        const container = document.getElementById('commercialSendersList');
        if (container) {
            container.innerHTML = `<div class="commercial-senders-empty">Erreur: ${esc(e.message || String(e))}</div>`;
        }
    }
}

async function removeCommercialSender(email) {
    const sender = decodeURIComponent(String(email || '')).trim().toLowerCase();
    if (!sender) return;
    if (!confirm(`Retirer ${sender} des adresses commerciales automatiques ?`)) return;

    showLoading('Mise à jour des adresses commerciales...');
    try {
        const r = await fetch('/api/commercial/senders/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: sender, reclassify: true }),
        });
        const data = await r.json();
        if (!r.ok || !data.ok) throw new Error(data.error || 'Suppression impossible');
        await loadCommercialSendersSettings();
        await loadInbox();
        showToast('Adresse retirée des expéditeurs commerciaux.', 'success', 2600);
    } catch (e) {
        showToast(`Erreur: ${e.message || e}`, 'error', 3600);
    } finally {
        hideLoading();
    }
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
        ['Dossier principal', paths.vault_dir],
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
    const mailsDir = (document.getElementById('settingMailsDirInput')?.value || '').trim();
    const payload = {
        paths: {
            mails_dir: mailsDir,
            vault_dir: mailsDir,
        },
        env: {
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
        if (promptField) promptField.classList.remove('is-hidden');
        if (originalField) {
            originalField.classList.remove('is-hidden');
            const label = originalField.querySelector('label');
            if (label) {
                label.textContent = composerReplyContext.type === 'forward'
                    ? 'Mail transféré (figé)' : 'Message original (figé)';
            }
        }
        if (generateBtn) generateBtn.classList.remove('is-hidden');
        if (originalBody) originalBody.value = composerReplyContext.originalText || '';
        if (promptInput && !promptInput.value.trim()) promptInput.value = 'Réponse professionnelle, claire et concise.';
    } else {
        if (promptField) promptField.classList.add('is-hidden');
        if (originalField) originalField.classList.add('is-hidden');
        if (generateBtn) generateBtn.classList.add('is-hidden');
        if (originalBody) originalBody.value = '';
        if (promptInput) promptInput.value = '';
    }
}

function getQuotedOriginalText(context = composerReplyContext) {
    if (!context || !context.originalText) return '';
    if (context.type === 'forward') {
        const lines = context.originalText.split('\n');
        return '\n\n' + lines.map(l => l ? '> ' + l : '>').join('\n');
    }
    const header = 'Le ' + (context.date || '') + ', ' + (context.from || '') + ' a écrit :';
    const lines = context.originalText.split('\n');
    return '\n\n> ' + header + '\n>\n' + lines.map(l => l ? '> ' + l : '>').join('\n');
}

function getQuoteTextForHtml(context = composerReplyContext) {
    if (!context || !context.originalText) return '';
    if (context.type === 'forward') {
        return context.originalText;
    }
    return 'Le ' + (context.date || '') + ', ' + (context.from || '') + ' a écrit :\n\n' + context.originalText;
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
        ? buildHtmlBodyWithOptionalQuote(document.getElementById('mailBody').value.trim(), signatureHtml, getQuoteTextForHtml())
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
   Mail Processing Wizard
   ═══════════════════════════════════════════════════════ */
const MP_RELEVANT_EXTS = ['.odt', '.docx', '.pdf', '.xlsx', '.csv', '.pptx'];
const MP_PROGRESS_STORAGE_KEY = 'mail-process-progress-v1';

let mpQueue = [];
let mpIndex = 0;
let mpCurrentMail = null;
let mpRelevantAtts = [];
let mpAttIndex = 0;
let mpSkipStep1 = false;
let mpSkipAttachments = false;
let mpPreparedAttachment = null;
let mpPendingDeleteCurrentMail = false;
let mpDeleteInFlight = null;

function getProcessableInboxIds() {
    return inboxMails
        .filter(m => !m.deleted && m.folder !== 'sent' && !m.processed && (m.mailbox || 'inbox') !== 'commercial')
        .sort((a, b) => {
            const daTs = Number(a?.date_ts || 0);
            const dbTs = Number(b?.date_ts || 0);
            const da = Number.isFinite(daTs) && daTs > 0 ? daTs : (a.date ? new Date(a.date).getTime() : 0);
            const db = Number.isFinite(dbTs) && dbTs > 0 ? dbTs : (b.date ? new Date(b.date).getTime() : 0);
            return (isNaN(db) ? 0 : db) - (isNaN(da) ? 0 : da);
        })
        .map(m => m.id);
}

function saveMailProcessProgress() {
    try {
        const payload = {
            queue: Array.isArray(mpQueue) ? mpQueue : [],
            index: Number(mpIndex) || 0,
            skipStep1: !!mpSkipStep1,
            skipAttachments: !!mpSkipAttachments,
        };
        localStorage.setItem(MP_PROGRESS_STORAGE_KEY, JSON.stringify(payload));
    } catch {}
}

function clearMailProcessProgress() {
    try {
        localStorage.removeItem(MP_PROGRESS_STORAGE_KEY);
    } catch {}
}

function loadMailProcessProgress() {
    try {
        const raw = localStorage.getItem(MP_PROGRESS_STORAGE_KEY);
        if (!raw) return null;
        const data = JSON.parse(raw);
        if (!Array.isArray(data?.queue)) return null;
        const idx = Math.max(0, Number(data?.index) || 0);
        return {
            queue: data.queue.filter(Boolean),
            index: idx,
            skipStep1: !!data.skipStep1,
            skipAttachments: !!data.skipAttachments,
        };
    } catch {
        return null;
    }
}

function getResumeMailProcessState() {
    const saved = loadMailProcessProgress();
    if (!saved || !saved.queue.length) return null;

    const pendingSet = new Set(getProcessableInboxIds());
    const filteredQueue = saved.queue.filter((id) => pendingSet.has(id));
    if (!filteredQueue.length) {
        clearMailProcessProgress();
        return null;
    }

    const index = Math.min(Math.max(0, saved.index), filteredQueue.length - 1);
    return {
        queue: filteredQueue,
        index,
        skipStep1: saved.skipStep1,
        skipAttachments: saved.skipAttachments,
    };
}

function mpShowStep(stepId) {
    document.querySelectorAll('#mailProcessContent .mp-step').forEach(el => el.classList.add('is-hidden'));
    document.getElementById(stepId).classList.remove('is-hidden');
    // Hide mail info block on the "done" step
    const infoBlock = document.getElementById('mpMailInfoBlock');
    if (infoBlock) infoBlock.style.display = stepId === 'mpStepDone' ? 'none' : '';
}

function mpSanitizePreviewHtml(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(String(html || ''), 'text/html');
    doc.querySelectorAll('script, style, iframe, object, embed, link, meta, base').forEach(el => el.remove());

    doc.querySelectorAll('*').forEach((el) => {
        Array.from(el.attributes).forEach((attr) => {
            const name = String(attr.name || '').toLowerCase();
            const value = String(attr.value || '').trim().toLowerCase();
            if (name.startsWith('on')) {
                el.removeAttribute(attr.name);
                return;
            }
            if ((name === 'href' || name === 'src') && (value.startsWith('javascript:') || value.startsWith('data:text/html'))) {
                el.removeAttribute(attr.name);
            }
        });
    });

    return doc.body ? doc.body.innerHTML : '';
}

function splitHeaderEmails(value) {
    const raw = String(value || '');
    if (!raw.trim()) return [];
    return raw
        .split(',')
        .map(part => {
            const m = part.match(/<([^>]+)>/);
            return (m ? m[1] : part).trim();
        })
        .filter(Boolean);
}

function dedupeEmails(list) {
    const out = [];
    const seen = new Set();
    (list || []).forEach((item) => {
        const value = String(item || '').trim();
        if (!value) return;
        const key = value.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        out.push(value);
    });
    return out;
}

function buildReplyAllRecipients(mail) {
    const myAddr = String(mail?.account || '').trim().toLowerCase();
    const toRecipients = [];
    const ccRecipients = [];

    const pushTo = (addr) => {
        const value = String(addr || '').trim();
        if (!value) return;
        const low = value.toLowerCase();
        if (myAddr && low === myAddr) return;
        toRecipients.push(value);
    };
    const pushCc = (addr) => {
        const value = String(addr || '').trim();
        if (!value) return;
        const low = value.toLowerCase();
        if (myAddr && low === myAddr) return;
        ccRecipients.push(value);
    };

    pushTo(mail?.from_email || '');
    splitHeaderEmails(mail?.to).forEach(pushTo);
    splitHeaderEmails(mail?.cc).forEach(pushCc);

    const dedupedTo = dedupeEmails(toRecipients);
    const toSet = new Set(dedupedTo.map(v => v.toLowerCase()));
    const dedupedCc = dedupeEmails(ccRecipients).filter(v => !toSet.has(v.toLowerCase()));
    return { to: dedupedTo, cc: dedupedCc };
}

function mpRenderMailPreview(mail) {
    const previewEl = document.getElementById('mpPreview');
    if (!previewEl) return;

    const bodyHtml = String(mail?.body_html || '').trim();
    if (bodyHtml) {
        previewEl.innerHTML = '<iframe id="mpPreviewFrame" sandbox=""></iframe>';
        const frame = document.getElementById('mpPreviewFrame');
        if (frame) frame.srcdoc = bodyHtml;
        return;
    }

    const bodyText = String(mail?.body || '').trim();
    if (!bodyText) {
        previewEl.innerHTML = '<div class="mp-preview-text-fallback">Aucun contenu lisible.</div>';
        return;
    }
    previewEl.innerHTML = `<div class="mp-preview-text-fallback">${esc(bodyText)}</div>`;
}

function startMailProcess(mailIds, skipDeleteStep, skipAttachmentStep = false, startIndex = 0) {
    mpQueue = mailIds;
    mpIndex = Math.max(0, Number(startIndex) || 0);
    mpSkipStep1 = !!skipDeleteStep;
    mpSkipAttachments = !!skipAttachmentStep;
    mpPendingDeleteCurrentMail = false;
    mpDeleteInFlight = null;
    saveMailProcessProgress();
    const modal = document.getElementById('mailProcessModal');
    modal.classList.add('show');
    mpProcessCurrent();
}

async function markMailProcessed(mailId) {
    if (!mailId) return;
    try {
        await fetch('/api/mail/mark-processed', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: mailId, processed: true })
        });
        const local = inboxMails.find(m => m.id === mailId);
        if (local) local.processed = true;
    } catch {}
}

async function closeMailProcess(completed = false) {
    const aborted = !completed && mpQueue.length > 0 && mpIndex < mpQueue.length;

    // If user asked to delete the current mail, finish that deletion before closing.
    if (aborted && mpPendingDeleteCurrentMail) {
        showLoading('Finalisation de la suppression serveur...');
        try {
            await mpDeleteCurrentMailOnServerAndLocally();
            showToast('Suppression demandée finalisée avant fermeture.', 'success', 2600);
        } finally {
            hideLoading();
            mpPendingDeleteCurrentMail = false;
        }
    } else if (aborted) {
        showToast('Traitement annulé : le mail courant reste non traité.', 'warning', 3200);
    }

    // If a server deletion is currently running, wait for completion before closing.
    if (mpDeleteInFlight) {
        showLoading('Finalisation de la suppression serveur...');
        try {
            await mpDeleteInFlight;
        } finally {
            hideLoading();
        }
    }

    document.getElementById('mailProcessModal').classList.remove('show');
    document.getElementById('mpReplyModal').style.display = 'none';
    mpReplyMode = null;
    if (!aborted) {
        clearMailProcessProgress();
        mpQueue = [];
        mpIndex = 0;
    } else {
        saveMailProcessProgress();
    }
    mpSkipAttachments = false;
    mpCurrentMail = null;
    mpPendingDeleteCurrentMail = false;
    mpDeleteInFlight = null;
    mpClearPreparedAttachment();
    refreshMailProcessSummary();
    if (currentTab === 'mail-process') {
        switchTab('inbox');
    }
}

function mpGetRelevantAttachments(attachments) {
    const atts = Array.isArray(attachments) ? attachments : [];
    const relevant = [];
    atts.forEach((name, idx) => {
        const ext = '.' + String(name || '').split('.').pop().toLowerCase();
        if (MP_RELEVANT_EXTS.includes(ext)) {
            relevant.push({ name, idx });
        }
    });
    return relevant;
}

async function mpDeleteCurrentMailOnServerAndLocally() {
    if (!mpCurrentMail || !mpCurrentMail.id) return false;
    const mailId = mpCurrentMail.id;
    const deletePromise = (async () => {
        const r = await fetch('/api/mail/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: mailId, delete_on_server: true })
        });

        let result = {};
        try {
            result = await r.json();
        } catch {}

        if (!r.ok || !result.ok) {
            showToast('Suppression serveur impossible: ' + (result.error || 'Erreur inconnue'), 'warning', 3500);
            return false;
        }

        const remoteMissing = !!result.remote?.already_missing;
        if (remoteMissing) {
            showToast('Mail déjà absent du serveur distant.', 'success', 2600);
        }
        return true;
    })();

    mpDeleteInFlight = deletePromise;
    try {
        return await deletePromise;
    } catch {
        showToast('Suppression serveur impossible.', 'warning', 3000);
        return false;
    } finally {
        if (mpDeleteInFlight === deletePromise) {
            mpDeleteInFlight = null;
        }
        await loadInbox();
    }
}

async function mpFinalizeCurrentMailAfterAttachmentStep() {
    if (mpPendingDeleteCurrentMail) {
        await mpDeleteCurrentMailOnServerAndLocally();
        mpPendingDeleteCurrentMail = false;
    }
    mpNextMail();
}

function mpSanitizeForFilename(value, maxLen = 50) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^[-_]+|[-_]+$/g, '')
        .slice(0, maxLen);
}

function mpAuthorForFilename(sender) {
    const raw = String(sender || '').trim();
    if (!raw) return 'inconnu';

    let base = raw;
    if (raw.includes('@')) {
        base = raw.split('@')[0] || raw;
    }

    const tokens = String(base)
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .split(/[.\s_-]+/)
        .map(s => s.trim())
        .filter(Boolean);

    if (tokens.length >= 2) {
        const firstName = tokens[0];
        const lastName = tokens[tokens.length - 1];
        const normalized = mpSanitizeForFilename(`${lastName}-${firstName}`, 50);
        return normalized || 'inconnu';
    }

    return mpSanitizeForFilename(base, 50) || 'inconnu';
}

function mpDateForFilename(mailDate) {
    const raw = String(mailDate || '').trim();
    if (!raw) return new Date().toISOString().slice(0, 10);
    const firstPart = raw.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(firstPart)) return firstPart;
    return new Date().toISOString().slice(0, 10);
}

function mpBuildClassifiedFilename(attName, shortName, mailDate) {
    const extIdx = String(attName || '').lastIndexOf('.');
    const ext = extIdx >= 0 ? String(attName).slice(extIdx).toLowerCase() : '';
    const datePart = mpDateForFilename(mailDate).replace(/-/g, '_');
    const safeName = String(shortName || 'Sans_Nom').trim();
    return `${datePart}_${safeName}${ext}`;
}

function mpUpdateFilenamePreview() {
    const preview = document.getElementById('mpFilenamePreview');
    if (!preview) return;
    const shortName = (document.getElementById('mpShortName')?.value || '').trim();
    const mailDate = mpCurrentMail?.date || '';
    const datePart = mpDateForFilename(mailDate).replace(/-/g, '_');
    const att = mpRelevantAtts?.[mpAttIndex];
    const extIdx = att ? String(att.name || '').lastIndexOf('.') : -1;
    const ext = extIdx >= 0 ? String(att.name).slice(extIdx).toLowerCase() : '';
    if (shortName && /^[^\s_]+_[^\s_]+$/.test(shortName)) {
        preview.textContent = `${datePart}_${shortName}${ext}`;
    } else {
        preview.textContent = `${datePart}_Mot1_Mot2${ext}`;
    }
}

function mpClearPreparedAttachment() {
    if (mpPreparedAttachment && mpPreparedAttachment.url) {
        URL.revokeObjectURL(mpPreparedAttachment.url);
    }
    mpPreparedAttachment = null;
    const holder = document.getElementById('mpPreparedAttachment');
    const ph = document.getElementById('mpPreparedPlaceholder');
    if (holder) holder.innerHTML = '';
    if (ph) ph.style.display = '';
}

function mpRenderPreparedAttachment() {
    const holder = document.getElementById('mpPreparedAttachment');
    const ph = document.getElementById('mpPreparedPlaceholder');
    if (!holder || !mpPreparedAttachment) return;
    if (ph) ph.style.display = 'none';

    const safeName = esc(mpPreparedAttachment.filename);
    holder.innerHTML = `
        <a
            id="mpPreparedAttachmentLink"
            class="attachment-chip"
            href="${mpPreparedAttachment.url}"
            download="${safeName}"
            draggable="true"
            title="Glisse-dépose ce fichier dans ton logiciel documentaire"
        >
            <span class="attachment-chip-name"><i class="icon-paperclip"></i> ${safeName}</span>
            <span class="attachment-chip-size">Prêt à déposer</span>
        </a>`;

    const link = document.getElementById('mpPreparedAttachmentLink');
    if (!link) return;
    link.addEventListener('dragstart', (e) => {
        const descInput = document.getElementById('mpAttachmentDescription');
        const desc = String(descInput?.value || '').trim();
        if (!desc) {
            e.preventDefault();
            showToast('Ajoute une description longue avant le glisser-déposer.', 'warning', 3200);
            return;
        }

        // Native Electron startDrag: sends the file via XDnD (same protocol as Nautilus).
        // e.preventDefault() cancels the web drag so startDrag() takes over entirely.
        if (window.electronAPI?.startDragOut && mpPreparedAttachment.filePath) {
            e.preventDefault();
            window.electronAPI.startDragOut(mpPreparedAttachment.filePath);
            return;
        }
    });
}

function mpBlobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const dataUrl = String(reader.result || '');
            const commaIdx = dataUrl.indexOf(',');
            resolve(commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : '');
        };
        reader.onerror = () => reject(reader.error || new Error('Erreur lecture fichier'));
        reader.readAsDataURL(blob);
    });
}

async function mpProcessCurrent() {
    if (mpIndex >= mpQueue.length) {
        await loadInbox();
        clearMailProcessProgress();
        mpShowStep('mpStepDone');
        refreshMailProcessSummary();
        return;
    }
    const mailId = mpQueue[mpIndex];
    document.getElementById('mpCounter').textContent = `Mail ${mpIndex + 1}/${mpQueue.length}`;

    try {
        const r = await fetch('/api/mail/' + encodeURIComponent(mailId));
        if (!r.ok) { mpNextMail(); return; }
        mpCurrentMail = await r.json();
        mpPendingDeleteCurrentMail = false;
    } catch { mpNextMail(); return; }

    document.getElementById('mpFrom').textContent = (mpCurrentMail.from_name || '') + ' <' + (mpCurrentMail.from_email || '') + '>';
    setCollapsibleHeaderField('mpTo', mpCurrentMail.to || '');
    setCollapsibleHeaderField('mpCc', mpCurrentMail.cc || '');
    document.getElementById('mpSubject').textContent = mpCurrentMail.subject || 'Sans sujet';
    document.getElementById('mpDate').textContent = mpCurrentMail.date || '';
    mpRenderMailPreview(mpCurrentMail);

    if (mpSkipStep1) {
        mpShowStep('mpStep2');
    } else {
        mpShowStep('mpStep1');
    }
}

async function mpNextMail() {
    if (mpCurrentMail && mpCurrentMail.id) {
        await markMailProcessed(mpCurrentMail.id);
    }
    mpIndex++;
    saveMailProcessProgress();
    refreshMailProcessSummary();
    mpProcessCurrent();
}

async function mpDeleteFromServer() {
    if (!mpCurrentMail) return;
    mpPendingDeleteCurrentMail = true;

    const relevant = mpGetRelevantAttachments(mpCurrentMail.attachments || []);
    if (relevant.length > 0 && !mpSkipAttachments) {
        mpRelevantAtts = relevant;
        mpAttIndex = 0;
        showToast('Pièce jointe à protéger détectée: traite-la avant suppression.', 'warning', 3200);
        mpShowAttachment();
        return;
    }

    await mpDeleteCurrentMailOnServerAndLocally();
    mpPendingDeleteCurrentMail = false;
    mpNextMail();
}

async function mpClassifyCommercial() {
    if (!mpCurrentMail || !mpCurrentMail.id) return;

    showLoading('Classement dans Commercial...');
    try {
        const r = await fetch('/api/mail/mark-commercial', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: mpCurrentMail.id }),
        });
        const result = await r.json();
        if (!r.ok || !result.ok) {
            showToast('Erreur : ' + (result.error || 'classement impossible'), 'error', 3800);
            return;
        }

        showToast('Mail classé en commercial. Les prochains mails de cet expéditeur seront aussi classés.', 'success', 3200);
        mpNextMail();
    } catch (e) {
        showToast('Erreur : ' + e.message, 'error', 3800);
    } finally {
        hideLoading();
    }
}

function mpKeepMail() {
    mpPendingDeleteCurrentMail = false;
    // Reset summary block for fresh step
    const block = document.getElementById('mpSummaryBlock');
    const textEl = document.getElementById('mpSummaryText');
    const btnSummarize = document.getElementById('mpBtnSummarize');
    const btnCopy = document.getElementById('mpBtnCopySummary');
    if (block) block.style.display = 'none';
    if (textEl) { textEl.value = ''; textEl.style.display = 'none'; }
    if (btnSummarize) { btnSummarize.style.display = ''; btnSummarize.disabled = false; }
    if (btnCopy) btnCopy.style.display = 'none';
    mpShowStep('mpStep2');
}

/* ═══════════════════════════════════════════════════════
   Mail Process — Reply & Keep / Reply & Delete
   ═══════════════════════════════════════════════════════ */
let mpReplyMode = null; // 'keep' or 'delete'

function mpReplyAndKeep() {
    mpReplyMode = 'keep';
    openMpReplyModal();
}

function mpReplyAndDelete() {
    mpReplyMode = 'delete';
    openMpReplyModal();
}

function openMpReplyModal() {
    if (!mpCurrentMail) return;

    // Populate From selector with available accounts
    const fromSel = document.getElementById('mpReplyFrom');
    const enabled = accountsData.filter(acc => acc.email && acc.enabled !== false);
    fromSel.innerHTML = '';
    if (!enabled.length) {
        fromSel.innerHTML = '<option value="">Aucun compte</option>';
    } else {
        enabled.forEach(acc => {
            const opt = document.createElement('option');
            opt.value = acc.email;
            opt.textContent = acc.provider === 'gmail_oauth' ? `${acc.email} (Gmail OAuth)` : acc.email;
            fromSel.appendChild(opt);
        });
        // Try to match the account of the current mail
        if (mpCurrentMail.account) {
            for (let i = 0; i < fromSel.options.length; i++) {
                if (fromSel.options[i].value === mpCurrentMail.account) { fromSel.selectedIndex = i; break; }
            }
        }
    }

    const recipients = buildReplyAllRecipients(mpCurrentMail);
    document.getElementById('mpReplyTo').value = recipients.to.join(', ');
    document.getElementById('mpReplyCc').value = recipients.cc.join(', ');
    document.getElementById('mpReplySubject').value = 'Re: ' + (mpCurrentMail.subject || '').replace(/^Re:\s*/i, '');
    document.getElementById('mpReplyBody').value = '';
    document.getElementById('mpReplyPrompt').value = 'Réponse professionnelle, claire et concise.';
    document.getElementById('mpReplyOriginal').value = mpCurrentMail.body || '';

    // Populate signature selector
    const sigSel = document.getElementById('mpReplySignature');
    const sigs = state.settings.signatures || [];
    sigSel.innerHTML = '<option value="">-- Aucune signature --</option>' +
        sigs.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
    onMpReplySignatureChange();

    document.getElementById('mpReplyModal').style.display = '';
    document.getElementById('mpReplyBody').focus();
}

function closeMpReplyModal() {
    document.getElementById('mpReplyModal').style.display = 'none';
    mpReplyMode = null;
}

function onMpReplySignatureChange() {
    const sel = document.getElementById('mpReplySignature');
    const preview = document.getElementById('mpReplySignaturePreview');
    const field = document.getElementById('mpReplySignaturePreviewField');
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

function getMpReplySignatureHtml() {
    const sel = document.getElementById('mpReplySignature');
    if (!sel || !sel.value) return null;
    const sig = (state.settings.signatures || []).find(s => s.id === sel.value);
    return sig ? sig.html : null;
}

async function mpReplyGenerate() {
    if (!state.settings.geminiKey) {
        showToast('Configure ta clé API Gemini dans les paramètres.', 'error', 3000);
        return;
    }
    const prompt = (document.getElementById('mpReplyPrompt').value || '').trim();
    if (!prompt) {
        showToast('Ajoute un prompt pour orienter la réponse.', 'error');
        document.getElementById('mpReplyPrompt').focus();
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
                subject: document.getElementById('mpReplySubject').value.trim(),
                from: mpCurrentMail.from_name || mpCurrentMail.from_email || '',
                original_text: mpCurrentMail.body || '',
                draft: document.getElementById('mpReplyBody').value.trim()
            })
        });
        const result = await r.json();
        if (result.error) {
            showToast('Erreur IA : ' + result.error, 'error', 5000);
        } else if (result.text) {
            document.getElementById('mpReplyBody').value = result.text.trim();
            showToast('Réponse générée.', 'success');
        }
    } catch (e) {
        showToast('Erreur : ' + e.message, 'error', 5000);
    } finally {
        hideLoading();
    }
}

async function mpReplySend() {
    const from = document.getElementById('mpReplyFrom').value;
    const to = document.getElementById('mpReplyTo').value.trim();
    const cc = document.getElementById('mpReplyCc').value.trim();
    const subject = document.getElementById('mpReplySubject').value.trim();
    const bodyDraft = document.getElementById('mpReplyBody').value.trim();

    if (!from) { showToast('Aucun compte expéditeur.', 'error'); return; }
    if (!to || !subject) { showToast('Destinataire et sujet requis.', 'error'); return; }
    if (!bodyDraft) { showToast('Le corps de la réponse est vide.', 'error'); return; }

    // Build quoted original text
    const originalText = mpCurrentMail.body || '';
    const mailDate = mpCurrentMail.date || '';
    const mailFrom = mpCurrentMail.from_name || mpCurrentMail.from_email || '';
    const quoteHeader = 'Le ' + mailDate + ', ' + mailFrom + ' a écrit :';
    const quotedLines = originalText.split('\n').map(l => l ? '> ' + l : '>').join('\n');
    const fullBody = bodyDraft + '\n\n> ' + quoteHeader + '\n>\n' + quotedLines;

    const signatureHtml = getMpReplySignatureHtml();
    const html_body = signatureHtml
        ? buildHtmlBodyWithOptionalQuote(bodyDraft, signatureHtml, originalText ? 'Le ' + mailDate + ', ' + mailFrom + ' a écrit :\n\n' + originalText : '')
        : null;

    showLoading('Envoi de la réponse via SMTP…');
    try {
        const r = await fetch('/api/send-email', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ from, to, cc, subject, body: fullBody, html_body })
        });
        const result = await r.json();
        if (result.ok) {
            showToast('Réponse envoyée !', 'success', 3000);
            closeMpReplyModal();
            // Execute the appropriate follow-up action
            if (mpReplyMode === 'delete') {
                await mpDeleteFromServer();
            } else {
                mpKeepMail();
            }
        } else {
            showToast('Erreur envoi : ' + (result.error || 'Erreur'), 'error', 5000);
        }
    } catch (e) {
        showToast('Erreur : ' + e.message, 'error', 5000);
    } finally {
        hideLoading();
    }
}

async function mpTextImportant() {
    const block = document.getElementById('mpSummaryBlock');
    const loadingEl = document.getElementById('mpSummaryLoading');
    const textEl = document.getElementById('mpSummaryText');
    const btnSummarize = document.getElementById('mpBtnSummarize');
    const btnCopy = document.getElementById('mpBtnCopySummary');

    block.style.display = '';
    loadingEl.style.display = 'block';
    textEl.value = '';
    textEl.style.display = 'none';
    if (btnSummarize) btnSummarize.disabled = true;

    try {
        const r = await fetch('/api/mail/summarize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                token: state.settings.geminiKey,
                subject: mpCurrentMail.subject || '',
                body: mpCurrentMail.body || ''
            })
        });
        const result = await r.json();
        if (result.ok) {
            textEl.value = result.text;
        } else {
            textEl.value = 'Erreur : ' + (result.error || 'Erreur inconnue');
        }
    } catch (e) {
        textEl.value = 'Erreur : ' + e.message;
    }
    loadingEl.style.display = 'none';
    textEl.style.display = 'block';
    if (btnCopy) btnCopy.style.display = '';
    if (btnSummarize) btnSummarize.style.display = 'none';
}

async function mpCopySummary() {
    const text = document.getElementById('mpSummaryText').value;
    try {
        await navigator.clipboard.writeText(text);
        showToast('Résumé copié !', 'success', 2000);
    } catch {
        showToast('Erreur de copie', 'error', 2000);
    }
}

function mpAfterSummary() {
    mpCheckAttachments();
}

function mpCheckAttachments() {
    if (mpSkipAttachments) {
        mpFinalizeCurrentMailAfterAttachmentStep();
        return;
    }
    mpRelevantAtts = mpGetRelevantAttachments(mpCurrentMail.attachments || []);
    mpAttIndex = 0;
    if (mpRelevantAtts.length > 0) {
        mpShowAttachment();
    } else {
        mpFinalizeCurrentMailAfterAttachmentStep();
    }
}

function mpShowAttachment() {
    if (mpAttIndex >= mpRelevantAtts.length) {
        mpFinalizeCurrentMailAfterAttachmentStep();
        return;
    }
    mpClearPreparedAttachment();
    const att = mpRelevantAtts[mpAttIndex];
    document.getElementById('mpAttName').textContent = att.name;
    mpShowStep('mpStep3');
}

function mpOpenAttachment() {
    if (!mpCurrentMail) return;
    const att = mpRelevantAtts[mpAttIndex];
    const url = `/api/mail/attachment?id=${encodeURIComponent(mpCurrentMail.id)}&idx=${att.idx}&name=${encodeURIComponent(att.name)}`;
    window.open(url, '_blank', 'noopener');
}

function mpDiscardAttachment() {
    mpAttIndex++;
    mpShowAttachment();
}

function mpKeepAttachment() {
    mpClearPreparedAttachment();
    mpShowStep('mpStep3b');
    const shortNameInput = document.getElementById('mpShortName');
    if (shortNameInput) shortNameInput.value = '';
    document.getElementById('mpAttachmentDescription').value = '';
    mpUpdateFilenamePreview();
}

function mpRenderN1Options(selected = '') {
    const sel = document.getElementById('mpN1');
    if (!sel) return;

    const { n1List } = getMailTaxonomy();
    sel.innerHTML = '<option value="">-- Choisir --</option>';
    n1List.forEach((n1) => {
        const opt = document.createElement('option');
        opt.value = n1;
        opt.textContent = n1;
        sel.appendChild(opt);
    });

    if (selected && n1List.includes(selected)) {
        sel.value = selected;
    } else {
        sel.value = '';
    }
}

function mpUpdateN2() {
    const n1 = document.getElementById('mpN1').value;
    const sel = document.getElementById('mpN2');
    const { n2Map } = getMailTaxonomy();
    sel.innerHTML = '';
    if (!n1 || !Array.isArray(n2Map[n1])) {
        sel.innerHTML = '<option value="">-- Choisir N1 d\'abord --</option>';
        return;
    }
    sel.innerHTML = '<option value="">-- Choisir --</option>';
    n2Map[n1].forEach(v => {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = v;
        sel.appendChild(opt);
    });
}

function mpAddN1DuringProcess() {
    const input = window.prompt('Nom du nouveau N1 (sujet principal) :', '');
    const newN1 = String(input || '').trim();
    if (!newN1) return;

    const { n1List, n2Map } = getMailTaxonomy();
    if (!n1List.includes(newN1)) {
        n1List.push(newN1);
    }
    if (!n2Map[newN1]) n2Map[newN1] = [];
    autoSave();

    mpRenderN1Options(newN1);
    mpUpdateN2();
    renderMailTaxonomySettingsForm();
    showToast(`N1 ajouté: ${newN1}`, 'success', 2200);
}

function mpAddN2DuringProcess() {
    const n1 = (document.getElementById('mpN1')?.value || '').trim();
    if (!n1) {
        showToast('Choisis d\'abord un N1.', 'warning', 2200);
        return;
    }

    const input = window.prompt(`Nom du nouveau N2 pour "${n1}" :`, '');
    const newN2 = String(input || '').trim();
    if (!newN2) return;

    const { n2Map } = getMailTaxonomy();
    if (!Array.isArray(n2Map[n1])) n2Map[n1] = [];
    if (!n2Map[n1].includes(newN2)) {
        n2Map[n1].push(newN2);
    }
    autoSave();

    mpUpdateN2();
    const n2Sel = document.getElementById('mpN2');
    if (n2Sel) n2Sel.value = newN2;
    renderMailTaxonomySettingsForm();
    showToast(`N2 ajouté: ${newN2}`, 'success', 2200);
}

async function mpCancelClassification() {
    mpClearPreparedAttachment();
    await closeMailProcess(false);
}

async function mpPrepareAttachmentForDrop() {
    const shortName = String(document.getElementById('mpShortName')?.value || '').trim();
    const description = String(document.getElementById('mpAttachmentDescription')?.value || '').trim();

    if (!shortName || !/^[^\s_]+_[^\s_]+$/.test(shortName)) {
        showToast('Le nom court doit contenir exactement 2 mots séparés par _ (ex: Facture_EDF).', 'error');
        return;
    }
    if (!description) {
        showToast('La description longue est obligatoire.', 'error');
        return;
    }
    if (!mpCurrentMail || !mpRelevantAtts[mpAttIndex]) return;

    const att = mpRelevantAtts[mpAttIndex];
    const filename = mpBuildClassifiedFilename(
        att.name,
        shortName,
        mpCurrentMail.date || ''
    );

    try {
        const url = `/api/mail/attachment?id=${encodeURIComponent(mpCurrentMail.id)}&idx=${att.idx}&name=${encodeURIComponent(att.name)}`;
        const resp = await fetch(url);
        if (!resp.ok) {
            showToast('Impossible de préparer la pièce jointe.', 'error', 3000);
            return;
        }
        const blob = await resp.blob();
        let tempFilePath = '';

        if (window.electronAPI?.writeTempFileFromBase64) {
            const b64 = await mpBlobToBase64(blob);
            const writeResult = await window.electronAPI.writeTempFileFromBase64({
                filename,
                base64: b64,
            });
            if (writeResult?.ok && writeResult.filePath) {
                tempFilePath = String(writeResult.filePath);
            }
        }

        mpClearPreparedAttachment();
        mpPreparedAttachment = {
            filename,
            contentType: blob.type || 'application/octet-stream',
            url: URL.createObjectURL(blob),
            blob,
            filePath: tempFilePath,
            description,
        };
        mpRenderPreparedAttachment();

        // Launch native GTK drag helper for apps requiring XDG portal atoms (Storga, etc.)
        if (tempFilePath && window.electronAPI?.launchDragHelper) {
            window.electronAPI.launchDragHelper({
                filePath: tempFilePath,
                displayName: filename,
            });
            showToast('Fenêtre de glisser-déposer ouverte — glisse le fichier dans Storga.', 'success', 4000);
        } else {
            showToast('Fichier prêt: glisse-dépose le chip dans ton logiciel documentaire.', 'success', 3500);
        }
    } catch (e) {
        showToast('Erreur : ' + e.message, 'error', 3000);
    }
}

async function mpSaveAttachment() {
    if (!mpPreparedAttachment) {
        showToast('Prépare d\'abord le fichier pour glisser-déposer.', 'warning', 2800);
        return;
    }

    mpClearPreparedAttachment();
    mpAttIndex++;
    mpShowAttachment();
}

async function mpClickDepositAttachment() {
    if (!mpPreparedAttachment || !mpPreparedAttachment.filePath) {
        showToast('Prépare d\'abord le fichier.', 'warning', 2800);
        return;
    }

    try {
        const result = await window.electronAPI.saveFileDialog({
            defaultPath: mpPreparedAttachment.filename || 'document',
        });
        if (result.canceled || !result.filePath) return;

        const copyResult = await window.electronAPI.copyTempFileTo({
            sourcePath: mpPreparedAttachment.filePath,
            destinationPath: result.filePath,
        });
        if (copyResult?.ok) {
            showToast('Fichier enregistré avec succès.', 'success', 2800);
        } else {
            showToast('Erreur : ' + (copyResult?.error || 'Erreur inconnue'), 'error', 3500);
        }
    } catch (e) {
        showToast('Erreur : ' + e.message, 'error', 3500);
    }
}

/* ═══════════════════════════════════════════════════════
   Mail Tab — Helpers
   ═══════════════════════════════════════════════════════ */
function getAllMailTasks() {
    const mails = [];
    state.sections.forEach(s => {
        const totalTasks = s.tasks.length;
        s.tasks.forEach((t, idx) => {
            if (t.type === 'mail' || t.isMail) {
                mails.push({ ...t, sectionId: s.id, sectionTitle: s.title, sectionEmoji: s.emoji, priorityIndex: idx, priorityTotal: totalTasks });
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

        const priorityColor = getPriorityColor(m.priorityIndex, m.priorityTotal);
        const priorityBadge = `<span class="priority-badge" style="background:${priorityColor}" title="Priorité ${m.priorityIndex + 1}">${m.priorityIndex + 1}</span>`;

        return `
        <div class="${cls}" onclick="selectMailForCompose('${m.sectionId}','${m.id}')">
            ${priorityBadge}
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
    const tabBtn = document.querySelector('.tab-btn[data-tab="mail"]');
    if (tabBtn) {
        tabBtn.innerHTML = '<i class="icon-send"></i>';
        tabBtn.setAttribute('aria-label', 'Rédiger');
        tabBtn.setAttribute('title', 'Rédiger');
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
let deleteMailTarget = null;
let inboxFolder = 'inbox'; // 'inbox' | 'commercial'
let autoFetchTimer = null;
let downloadsFiles = [];
let selectedDownloadPath = null;
let downloadsRoot = '/home/naiken/Téléchargements';
let dlPreparedFile = null;
let downloadsPreviewToken = 0;
let downloadsAutoRefreshTimer = null;
const INBOX_CACHE_PREFIX = 'neurail-inbox-cache-';
const DOWNLOADS_CACHE_KEY = 'neurail-downloads-cache';
const DOWNLOAD_NATIVE_PREVIEW_EXTS = new Set(['.pdf', '.txt']);
const DOWNLOAD_ONLYOFFICE_EXTS = new Set(['.odt', '.xlsx', '.pptx', '.docx', '.csv']);

function readLocalSnapshot(key) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function writeLocalSnapshot(key, payload) {
    try {
        localStorage.setItem(key, JSON.stringify(payload));
    } catch {}
}

function setCollapsibleHeaderField(elementId, value, maxLength = 110) {
    const el = document.getElementById(elementId);
    if (!el) return;

    const raw = String(value || '').trim();
    if (!raw) {
        el.textContent = '-';
        return;
    }

    if (raw.length <= maxLength) {
        el.textContent = raw;
        return;
    }

    const shortValue = raw.slice(0, maxLength).trimEnd() + '...';
    el.innerHTML = `<span class="collapsible-field" data-expanded="0" data-short="${esc(shortValue)}" data-full="${esc(raw)}"><span class="collapsible-value">${esc(shortValue)}</span><button class="collapsible-toggle" onclick="toggleCollapsibleField(this)">voir +</button></span>`;
}

function toggleCollapsibleField(button) {
    const holder = button?.closest('.collapsible-field');
    if (!holder) return;
    const valueEl = holder.querySelector('.collapsible-value');
    if (!valueEl) return;

    const expanded = holder.dataset.expanded === '1';
    if (expanded) {
        valueEl.textContent = holder.dataset.short || '';
        holder.dataset.expanded = '0';
        button.textContent = 'voir +';
    } else {
        valueEl.textContent = holder.dataset.full || '';
        holder.dataset.expanded = '1';
        button.textContent = 'réduire';
    }
}

function formatDownloadSize(bytes) {
    const n = Number(bytes || 0);
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function selectDownloadFileEncoded(encodedPath) {
    try {
        const decoded = decodeURIComponent(encodedPath || '');
        if (!decoded) return;
        selectedDownloadPath = decoded;
        dlPreparedFile = null;
        renderDownloadsWorkbench();
        renderDownloadsNativePreview(getSelectedDownloadFile());
    } catch {}
}

function selectDownloadFileEncodedFromEvent(event, encodedPath) {
    const target = event?.target;
    if (target?.closest('button, input, textarea, a')) return;
    selectDownloadFileEncoded(encodedPath);
}

function getSelectedDownloadFile() {
    if (!selectedDownloadPath) return null;
    return downloadsFiles.find(f => f.path === selectedDownloadPath) || null;
}

function getDownloadExt(file) {
    return String(file?.ext || '').toLowerCase();
}

function canPreviewDownloadNatively(file) {
    return DOWNLOAD_NATIVE_PREVIEW_EXTS.has(getDownloadExt(file));
}

function shouldOpenInOnlyOffice(file) {
    return DOWNLOAD_ONLYOFFICE_EXTS.has(getDownloadExt(file));
}

function buildDownloadFileApiUrl(pathValue) {
    return `/api/downloads/file?path=${encodeURIComponent(pathValue || '')}`;
}

function getFilteredDownloadsFiles() {
    const query = (document.getElementById('downloadsSearch')?.value || '').toLowerCase().trim();
    if (!query) return downloadsFiles;
    return downloadsFiles.filter((f) =>
        (f.name || '').toLowerCase().includes(query) ||
        (f.ext || '').toLowerCase().includes(query) ||
        (f.name1 || '').toLowerCase().includes(query) ||
        (f.name2 || '').toLowerCase().includes(query) ||
        (f.description || '').toLowerCase().includes(query)
    );
}

async function loadDownloadsManager(options = {}) {
    const { silent = false } = options;
    const bgToken = silent ? startBackgroundActivity('Analyse des téléchargements') : '';
    if (downloadsFiles.length === 0) {
        const cached = readLocalSnapshot(DOWNLOADS_CACHE_KEY);
        if (cached && Array.isArray(cached.files)) {
            downloadsFiles = cached.files;
            downloadsRoot = cached.root || downloadsRoot;
            renderDownloadsList();
            renderDownloadsWorkbench();
            renderDownloadsNativePreview(getSelectedDownloadFile());
        }
    }

    const statusEl = document.getElementById('downloads-status');
    if (!silent && statusEl) {
        statusEl.style.display = 'block';
        statusEl.className = 'inbox-status loading';
        statusEl.textContent = 'Analyse du dossier Téléchargements...';
    }

    try {
        const r = await fetch('/api/downloads/files');
        const result = await r.json();
        if (!r.ok || result.error) {
            if (!silent && statusEl) {
                statusEl.className = 'inbox-status error';
                statusEl.textContent = 'Erreur : ' + (result.error || 'Chargement impossible');
            }
            return;
        }

        downloadsFiles = Array.isArray(result.files) ? result.files : [];
        downloadsRoot = result.root || downloadsRoot;
        writeLocalSnapshot(DOWNLOADS_CACHE_KEY, {
            files: downloadsFiles,
            root: downloadsRoot,
            ts: Date.now(),
        });

        if (selectedDownloadPath && !downloadsFiles.some(f => f.path === selectedDownloadPath)) {
            selectedDownloadPath = null;
            dlPreparedFile = null;
        }
        if (!selectedDownloadPath && downloadsFiles.length) {
            selectedDownloadPath = downloadsFiles[0].path;
        }

        renderDownloadsList();
        renderDownloadsWorkbench();
        renderDownloadsNativePreview(getSelectedDownloadFile());

        if (!silent && statusEl) {
            statusEl.className = 'inbox-status success';
            statusEl.textContent = `${downloadsFiles.length} fichier(s) à traiter dans ${downloadsRoot}`;
            setTimeout(() => { statusEl.style.display = 'none'; }, 3200);
        }
    } catch (e) {
        if (!silent && statusEl) {
            statusEl.className = 'inbox-status error';
            statusEl.textContent = 'Erreur : ' + e.message;
        }
    } finally {
        if (bgToken) stopBackgroundActivity(bgToken);
    }
}

function ensureDownloadsAutoRefresh() {
    if (downloadsAutoRefreshTimer) return;
    downloadsAutoRefreshTimer = setInterval(() => {
        if (currentTab !== 'downloads') return;
        loadDownloadsManager({ silent: true });
    }, 4000);
}

function renderDownloadsList() {}

function updateDownloadFilenamePreview() {
    const file = getSelectedDownloadFile();
    const preview = document.getElementById('dlFilenamePreview');
    if (!file || !preview) return;

    const name1 = String(document.getElementById('dlName1')?.value || '').trim();
    const name2 = String(document.getElementById('dlName2')?.value || '').trim();
    const ext = String(file.ext || '').toLowerCase();
    if (name1 && name2) {
        preview.textContent = `${name1}_${name2}${ext}`;
    } else {
        preview.textContent = `Nom1_Nom2${ext}`;
    }
}

function getDownloadMetadataFormValues() {
    return {
        name1: String(document.getElementById('dlName1')?.value || '').trim(),
        name2: String(document.getElementById('dlName2')?.value || '').trim(),
        description: String(document.getElementById('dlDescription')?.value || '').trim(),
    };
}

async function saveDownloadMetadataOnBlur() {
    const file = getSelectedDownloadFile();
    if (!file?.path) return;

    const values = getDownloadMetadataFormValues();
    showLoading('Enregistrement des métadonnées...');
    try {
        const r = await fetch('/api/downloads/update-metadata', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                path: file.path,
                name1: values.name1,
                name2: values.name2,
                description: values.description,
            }),
        });
        const result = await r.json();
        if (!r.ok || !result.ok) {
            showToast('Erreur : ' + (result.error || 'enregistrement impossible'), 'error', 3200);
            return;
        }

        const updatedPath = result.file?.path || file.path;
        const renamed = updatedPath !== file.path;
        selectedDownloadPath = updatedPath;
        await loadDownloadsManager();
        if (renamed) {
            showToast('Fichier renommé automatiquement.', 'success', 2200);
        }
    } catch (e) {
        showToast('Erreur : ' + e.message, 'error', 3200);
    } finally {
        hideLoading();
    }
}

function renderDownloadsPreparedZone() {
    const holder = document.getElementById('downloadsPreparedAttachment');
    const ph = document.getElementById('downloadsPreparedPlaceholder');
    if (!holder) return;

    if (!dlPreparedFile) {
        holder.innerHTML = '';
        if (ph) ph.style.display = '';
        return;
    }

    if (ph) ph.style.display = 'none';
    holder.innerHTML = `
        <a id="downloadsPreparedLink" class="attachment-chip" href="#" draggable="true" title="Glisse ce fichier vers Storga">
            <span class="attachment-chip-name"><i class="icon-paperclip"></i> ${esc(dlPreparedFile.filename || 'document')}</span>
            <span class="attachment-chip-size">Prêt à déposer</span>
        </a>`;

    const link = document.getElementById('downloadsPreparedLink');
    if (!link) return;
    link.addEventListener('dragstart', (e) => {
        if (window.electronAPI?.startDragOut && dlPreparedFile.filePath) {
            e.preventDefault();
            window.electronAPI.startDragOut(dlPreparedFile.filePath);
        }
    });
}

function renderDownloadsDetail() {}

function isDownloadReadyForDrop(file) {
    return !!(String(file?.name1 || '').trim() && String(file?.name2 || '').trim() && String(file?.description || '').trim());
}

function renderDownloadsWorkbench() {
    const panel = document.getElementById('downloadsWorkbench');
    if (!panel) return;
    const list = getFilteredDownloadsFiles();

    if (!list.length) {
        panel.innerHTML = `<div class="downloads-workbench-empty">Aucun fichier correspondant.</div>`;
        renderDownloadsNativePreview(null);
        return;
    }

    if (!selectedDownloadPath || !list.some((f) => f.path === selectedDownloadPath)) {
        selectedDownloadPath = list[0].path;
    }

    const rows = list.map((f) => {
        const ready = isDownloadReadyForDrop(f);
        const deposited = !!f.deposited;
        const canDrag = ready && !deposited;
        const isSelected = selectedDownloadPath === f.path;
        const pathEncoded = encodeURIComponent(f.path || '');
        const openBtn = shouldOpenInOnlyOffice(f)
            ? `<button onclick="openDownloadFileInOnlyOfficeEncoded('${pathEncoded}')">OnlyOffice</button>`
            : `<button onclick="openDownloadFileExternallyEncoded('${pathEncoded}')">Ouvrir</button>`;
        const trashBtn = `<button onclick="trashDownloadFileEncoded('${pathEncoded}')">Supprimer</button>`;

        return `
            <tr class="${deposited ? 'is-deposited' : ''} ${isSelected ? 'is-selected' : ''}" data-path="${esc(f.path || '')}" onclick="selectDownloadFileEncodedFromEvent(event, '${pathEncoded}')">
                <td class="file-col" title="${esc(f.name || '')}">${esc(f.name || '')}</td>
                <td><input class="dw-input" data-field="name1" value="${esc(f.name1 || '')}" placeholder="Nom 1" onblur="saveDownloadRowMetadata(this)"></td>
                <td><input class="dw-input" data-field="name2" value="${esc(f.name2 || '')}" placeholder="Nom 2" onblur="saveDownloadRowMetadata(this)"></td>
                <td><textarea class="dw-input dw-textarea" data-field="description" placeholder="Description longue" onblur="saveDownloadRowMetadata(this)">${esc(f.description || '')}</textarea></td>
                <td class="state-col ${deposited ? 'state-deposited' : ''}">${deposited ? 'Déposé' : (ready ? 'Prêt' : 'À compléter')}</td>
                <td class="actions-col">
                    <button ${canDrag ? '' : 'disabled'} draggable="true" ondragstart="startDownloadRowDrag(event, '${pathEncoded}')" ondragend="finishDownloadRowDrag(event, '${pathEncoded}')">Glisser</button>
                    ${openBtn}
                    ${trashBtn}
                </td>
            </tr>`;
    }).join('');

    panel.innerHTML = `
        <table class="downloads-workbench-table">
            <thead>
                <tr>
                    <th>Fichier</th>
                    <th>Nom 1</th>
                    <th>Nom 2</th>
                    <th>Description longue</th>
                    <th>État</th>
                    <th>Actions</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>`;

    renderDownloadsNativePreview(getSelectedDownloadFile());
}

function collectDownloadRowData(row) {
    return {
        path: String(row?.dataset?.path || '').trim(),
        name1: String(row?.querySelector('[data-field="name1"]')?.value || '').trim(),
        name2: String(row?.querySelector('[data-field="name2"]')?.value || '').trim(),
        description: String(row?.querySelector('[data-field="description"]')?.value || '').trim(),
    };
}

async function saveDownloadRowMetadata(el) {
    const row = el?.closest('tr[data-path]');
    if (!row) return;
    const data = collectDownloadRowData(row);
    if (!data.path) return;

    try {
        const r = await fetch('/api/downloads/update-metadata', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });
        const result = await r.json();
        if (!r.ok || !result.ok) {
            showToast('Erreur : ' + (result.error || 'enregistrement impossible'), 'error', 3200);
            return;
        }
        await loadDownloadsManager({ silent: true });
    } catch (e) {
        showToast('Erreur : ' + e.message, 'error', 3200);
    }
}

function openDownloadFileExternallyEncoded(encodedPath) {
    try {
        const decoded = decodeURIComponent(encodedPath || '');
        if (!decoded) return;
        const file = downloadsFiles.find((f) => f.path === decoded);
        if (!file) return;
        selectedDownloadPath = file.path;
        openSelectedDownloadExternally();
    } catch {}
}

function openDownloadFileInOnlyOfficeEncoded(encodedPath) {
    try {
        const decoded = decodeURIComponent(encodedPath || '');
        if (!decoded) return;
        const file = downloadsFiles.find((f) => f.path === decoded);
        if (!file) return;
        selectedDownloadPath = file.path;
        openSelectedDownloadInOnlyOffice();
    } catch {}
}

async function trashDownloadFileEncoded(encodedPath) {
    try {
        const decoded = decodeURIComponent(encodedPath || '');
        if (!decoded) return;
        const r = await fetch('/api/downloads/trash', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: decoded }),
        });
        const result = await r.json();
        if (!r.ok || !result.ok) {
            showToast('Erreur : ' + (result.error || 'échec suppression'), 'error', 3600);
            return;
        }
        if (selectedDownloadPath === decoded) {
            selectedDownloadPath = null;
        }
        await loadDownloadsManager({ silent: true });
        showToast('Fichier déplacé dans la corbeille.', 'success', 2200);
    } catch (e) {
        showToast('Erreur : ' + e.message, 'error', 3600);
    }
}

function startDownloadRowDrag(event, encodedPath) {
    try {
        const decoded = decodeURIComponent(encodedPath || '');
        if (!decoded) {
            event.preventDefault();
            return;
        }
        if (window.electronAPI?.startDragOut) {
            event.preventDefault();
            window.electronAPI.startDragOut(decoded);
        }
    } catch {
        event.preventDefault();
    }
}

async function finishDownloadRowDrag(_event, encodedPath) {
    try {
        const decoded = decodeURIComponent(encodedPath || '');
        if (!decoded) return;
        await fetch('/api/downloads/mark-deposited', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: decoded, deposited: true }),
        });
        await loadDownloadsManager({ silent: true });
    } catch {}
}

async function trashAllDepositedDownloads() {
    const depositedCount = downloadsFiles.filter((f) => !!f.deposited).length;
    if (!depositedCount) {
        showToast('Aucun fichier déposé à envoyer à la corbeille.', 'warning', 2800);
        return;
    }

    if (!confirm(`Mettre à la corbeille ${depositedCount} fichier(s) déjà déposés dans Storga ?`)) return;

    showLoading('Déplacement en masse vers la corbeille...');
    try {
        const r = await fetch('/api/downloads/trash-deposited', { method: 'POST' });
        const result = await r.json();
        if (!r.ok || !result.ok) {
            showToast('Erreur : ' + (result.error || 'échec'), 'error', 3800);
            return;
        }
        await loadDownloadsManager();
        showToast(`${result.deleted || 0} fichier(s) déplacé(s) à la corbeille.`, 'success', 2800);
    } catch (e) {
        showToast('Erreur : ' + e.message, 'error', 3800);
    } finally {
        hideLoading();
    }
}

async function openDownloadsBatchDropWindow() {
    showLoading('Préparation de la fenêtre de dépôt...');
    try {
        const r = await fetch('/api/downloads/drop-candidates', { method: 'POST' });
        const result = await r.json();
        if (!r.ok || !result.ok) {
            showToast('Erreur : ' + (result.error || 'chargement impossible'), 'error', 3600);
            return;
        }

        const files = Array.isArray(result.files) ? result.files : [];
        if (!files.length) {
            showToast('Aucun fichier prêt: renseigne Nom 1, Nom 2 et Description.', 'warning', 3200);
            return;
        }

        if (window.electronAPI?.launchDownloadsDragHelper) {
            const launch = await window.electronAPI.launchDownloadsDragHelper({
                files,
                csvPath: result.csv_path || '',
            });
            if (!launch?.ok) {
                showToast('Erreur : ' + (launch?.error || 'ouverture impossible'), 'error', 3600);
                return;
            }
            showToast('Fenêtre native de dépôt ouverte.', 'success', 2400);
            return;
        }

        showToast('Fenêtre native indisponible dans cette session.', 'error', 3600);
    } catch (e) {
        showToast('Erreur : ' + e.message, 'error', 3600);
    } finally {
        hideLoading();
    }
}

async function renderDownloadsNativePreview(file) {
    const target = document.getElementById('downloadsNativePreview');
    if (!target) return;
    if (!file?.path) {
        target.textContent = 'Aucun fichier sélectionné.';
        return;
    }

    const token = ++downloadsPreviewToken;
    const ext = getDownloadExt(file);

    if (ext === '.pdf') {
        target.innerHTML = `<iframe class="downloads-native-frame" title="Aperçu PDF" src="${buildDownloadFileApiUrl(file.path)}"></iframe>`;
        return;
    }

    if (ext === '.txt') {
        target.innerHTML = '<div class="downloads-preview-loading">Lecture du texte...</div>';
        try {
            const r = await fetch(buildDownloadFileApiUrl(file.path));
            const textContent = r.ok ? await r.text() : `Erreur d\'aperçu: ${r.status}`;
            if (token !== downloadsPreviewToken) return;
            target.innerHTML = `<pre class="downloads-txt-preview">${esc(textContent)}</pre>`;
        } catch (e) {
            if (token !== downloadsPreviewToken) return;
            target.innerHTML = `<div class="downloads-preview-error">Erreur d'aperçu: ${esc(e.message || '')}</div>`;
        }
        return;
    }

    if (shouldOpenInOnlyOffice(file)) {
        target.innerHTML = `<div class="downloads-preview-note">Ce format est ouvert via OnlyOffice.<br>Utilise le bouton <strong>Ouvrir dans OnlyOffice</strong>.</div>`;
        return;
    }

    target.innerHTML = `<div class="downloads-preview-note">Aperçu natif non disponible pour ce format.</div>`;
}

async function prepareDownloadForDrop() {
    const file = getSelectedDownloadFile();
    if (!file) return;

    const shortName = String(document.getElementById('dlShortName')?.value || '').trim();
    const description = String(document.getElementById('dlDescription')?.value || '').trim();

    if (!shortName || !/^[^\s_]+_[^\s_]+$/.test(shortName)) {
        showToast('Le nom court doit contenir exactement 2 mots séparés par _.', 'error');
        return;
    }
    if (!description) {
        showToast('La description longue est obligatoire.', 'error');
        return;
    }

    showLoading('Préparation du fichier...');
    try {
        const r = await fetch('/api/downloads/prepare-drop', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: file.path, short_name: shortName, description }),
        });
        const result = await r.json();
        if (!r.ok || !result.ok) {
            showToast('Erreur : ' + (result.error || 'échec préparation'), 'error', 3800);
            return;
        }

        dlPreparedFile = {
            filename: result.filename,
            filePath: result.prepared_path,
            description,
        };
        renderDownloadsPreparedZone();

        if (window.electronAPI?.launchDragHelper && dlPreparedFile.filePath) {
            window.electronAPI.launchDragHelper({ filePath: dlPreparedFile.filePath, displayName: dlPreparedFile.filename });
            showToast('Fenêtre native de drag ouverte: glisse le fichier vers Storga.', 'success', 4200);
        } else {
            showToast('Fichier prêt au glisser-déposer.', 'success', 2800);
        }
    } catch (e) {
        showToast('Erreur : ' + e.message, 'error', 3800);
    } finally {
        hideLoading();
    }
}

async function savePreparedDownloadAs() {
    if (!dlPreparedFile || !dlPreparedFile.filePath) {
        showToast('Prépare d\'abord le fichier.', 'warning', 2600);
        return;
    }
    try {
        const result = await window.electronAPI.saveFileDialog({ defaultPath: dlPreparedFile.filename || 'document' });
        if (result.canceled || !result.filePath) return;
        const copy = await window.electronAPI.copyTempFileTo({
            sourcePath: dlPreparedFile.filePath,
            destinationPath: result.filePath,
        });
        if (copy?.ok) showToast('Fichier enregistré.', 'success', 2600);
        else showToast('Erreur : ' + (copy?.error || 'échec copie'), 'error', 3200);
    } catch (e) {
        showToast('Erreur : ' + e.message, 'error', 3200);
    }
}

async function openSelectedDownloadExternally() {
    const file = getSelectedDownloadFile();
    if (!file?.path) return;
    try {
        const fileUrl = `file://${encodeURI(file.path)}`;
        if (window.electronAPI?.openExternal) {
            await window.electronAPI.openExternal(fileUrl);
        }
    } catch (e) {
        showToast('Erreur ouverture : ' + e.message, 'error', 3200);
    }
}

async function openSelectedDownloadInOnlyOffice() {
    const file = getSelectedDownloadFile();
    if (!file?.path) {
        showToast('Sélectionne un fichier.', 'warning', 2400);
        return;
    }

    showLoading('Ouverture dans OnlyOffice...');
    try {
        const r = await fetch('/api/downloads/open-onlyoffice', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: file.path }),
        });
        const result = await r.json();
        if (!r.ok || !result.ok) {
            showToast('Erreur : ' + (result.error || 'OnlyOffice indisponible'), 'error', 3600);
            return;
        }
        showToast('Fichier ouvert dans OnlyOffice.', 'success', 2600);
    } catch (e) {
        showToast('Erreur : ' + e.message, 'error', 3600);
    } finally {
        hideLoading();
    }
}

async function trashSelectedDownload() {
    const file = getSelectedDownloadFile();
    if (!file?.path) {
        showToast('Sélectionne un fichier.', 'warning', 2400);
        return;
    }

    if (!confirm(`Mettre ce fichier à la corbeille ?\n\n${file.name}`)) return;

    showLoading('Déplacement vers la corbeille...');
    try {
        const r = await fetch('/api/downloads/trash', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: file.path }),
        });
        const result = await r.json();
        if (!r.ok || !result.ok) {
            showToast('Erreur : ' + (result.error || 'échec suppression'), 'error', 3600);
            return;
        }
        selectedDownloadPath = null;
        dlPreparedFile = null;
        await loadDownloadsManager();
        showToast('Fichier déplacé dans la corbeille.', 'success', 2600);
    } catch (e) {
        showToast('Erreur : ' + e.message, 'error', 3600);
    } finally {
        hideLoading();
    }
}

/* ═══════════════════════════════════════════════════════
   Inbox — Load & Render
   ═══════════════════════════════════════════════════════ */
async function loadInbox() {
    if (inboxMails.length === 0) {
        const cacheKey = INBOX_CACHE_PREFIX + inboxFolder;
        const cached = readLocalSnapshot(cacheKey);
        if (cached && Array.isArray(cached.mails)) {
            inboxMails = cached.mails;
            renderInboxList();
            updateInboxBadge();
            updateInboxFolderActions();
        }
    }

    try {
        let endpoint = '/api/inbox';
        if (inboxFolder === 'commercial') endpoint = '/api/inbox/commercial';
        const r = await fetch(endpoint);
        if (r.ok) {
            inboxMails = await r.json();
            writeLocalSnapshot(INBOX_CACHE_PREFIX + inboxFolder, {
                mails: inboxMails,
                ts: Date.now(),
            });
        }
    } catch {}
    renderInboxList();
    updateInboxBadge();
    updateInboxFolderActions();
    refreshMailProcessSummary();
}

function setInboxFolder(folder) {
    if (folder !== 'inbox' && folder !== 'commercial') return;
    if (inboxFolder === folder) return;
    inboxFolder = folder;
    selectedInboxId = null;
    document.getElementById('inboxReader').innerHTML = `
        <div class="inbox-reader-empty">
            <i class="icon-mail-open" style="font-size:2.5rem;color:var(--text-muted)"></i>
            <p>Sélectionne un mail pour le lire</p>
        </div>`;
    loadInbox();
}

function updateInboxFolderActions() {
    const isCommercial = inboxFolder === 'commercial';
    const inboxBtn = document.getElementById('inboxFolderInboxBtn');
    const commercialBtn = document.getElementById('inboxFolderCommercialBtn');
    const keepBtn = document.getElementById('btnKeepCommercial');
    const deleteCommercialBtn = document.getElementById('btnDeleteCommercial');
    if (inboxBtn) inboxBtn.classList.toggle('active', inboxFolder === 'inbox');
    if (commercialBtn) commercialBtn.classList.toggle('active', isCommercial);
    if (keepBtn) keepBtn.classList.toggle('is-hidden', !isCommercial);
    if (deleteCommercialBtn) deleteCommercialBtn.classList.toggle('is-hidden', !isCommercial);
}

async function refreshMailProcessSummary() {
    const textEl = document.getElementById('mailProcessSummaryText');
    const mainBtn = document.getElementById('btnProcessMailsMain');
    const topBtn = document.getElementById('btnProcessMailsFromTab');
    if (!textEl && !mainBtn && !topBtn) return;

    try {
        const r = await fetch('/api/inbox');
        if (!r.ok) throw new Error('Lecture Inbox impossible');
        const mails = await r.json();
        const pending = (Array.isArray(mails) ? mails : []).filter(m => !m.deleted && m.folder !== 'sent' && !m.processed && (m.mailbox || 'inbox') !== 'commercial');
        const pendingCount = pending.length;
        const resumeState = getResumeMailProcessState();
        if (textEl) {
            if (resumeState) {
                textEl.textContent = `Reprise disponible au mail ${resumeState.index + 1}/${resumeState.queue.length}.`;
            } else {
                textEl.textContent = pendingCount > 0
                    ? `${pendingCount} mail(s) non traité(s) dans Reçus.`
                    : 'Aucun mail à traiter pour le moment.';
            }
        }
        if (mainBtn) {
            mainBtn.disabled = pendingCount === 0;
            mainBtn.textContent = resumeState ? 'Reprendre le traitement' : 'Lancer le traitement';
        }
        if (topBtn) {
            topBtn.disabled = pendingCount === 0;
            topBtn.textContent = resumeState ? 'Reprendre mes mails' : 'Traiter mes mails';
        }
    } catch (e) {
        if (textEl) textEl.textContent = 'Impossible de charger le statut de traitement: ' + e.message;
        if (mainBtn) mainBtn.disabled = false;
        if (topBtn) topBtn.disabled = false;
    }
}

function filterInbox() {
    renderInboxList();
}

function getFilteredInbox() {
    const query = (document.getElementById('inboxSearch')?.value || '').toLowerCase().trim();
    let mails = [...inboxMails];

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

    // ── date helpers ──
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);

    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - now.getDay() + (now.getDay() === 0 ? -6 : 1)); // Monday
    weekStart.setHours(0, 0, 0, 0);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);

    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    function parseMailDate(dateStr) {
        if (!dateStr) return null;
        const d = new Date(dateStr);
        return isNaN(d.getTime()) ? null : d;
    }

    function getDateBucket(d) {
        if (!d) return 'older';
        const ds = d.toISOString().slice(0, 10);
        if (ds === todayStr) return 'today';
        if (d >= weekStart && d <= weekEnd) return 'week';
        if (d >= monthStart && d <= monthEnd) return 'month';
        return 'older';
    }

    const bucketLabels = {
        today: "Aujourd'hui",
        week: 'Cette semaine',
        month: 'Ce mois',
        older: 'Plus ancien'
    };

    // ── group mails by bucket, preserving order ──
    const buckets = ['today', 'week', 'month', 'older'];
    const groups = { today: [], week: [], month: [], older: [] };
    mails.forEach(m => {
        const d = parseMailDate(m.date);
        const bucket = getDateBucket(d);
        groups[bucket].push(m);
    });

    let html = '';
    for (const bucket of buckets) {
        const grp = groups[bucket];
        if (!grp.length) continue;

        html += `<div class="inbox-date-separator">${bucketLabels[bucket]}</div>`;

        grp.forEach(m => {
            const isSelected = selectedInboxId === m.id;
            const isSent = m.folder === 'sent';
            const fromDisplay = isSent ? ('→ ' + (m.to || '').split(',')[0].trim()) : (m.from_name || m.from_email || 'Inconnu');
            const preview = (m.body || '').substring(0, 80).replace(/\n/g, ' ');
            const hasAttach = m.attachments && m.attachments.length > 0;
            const isUnprocessed = !isSent && !m.processed;

            let colorClass = '';
            if (bucket === 'today') colorClass = 'inbox-today';
            else if (bucket === 'week') colorClass = 'inbox-this-week';
            else if (bucket === 'month') colorClass = 'inbox-this-month';

            html += `
            <div class="inbox-item ${isSelected ? 'selected' : ''} ${colorClass}" onclick="openInboxMail('${esc(m.id)}')">
                <div class="inbox-item-content">
                    <div class="inbox-item-top">
                        <span class="inbox-item-from">${isUnprocessed ? '<span class="inbox-item-unprocessed-dot"></span>' : ''}${esc(fromDisplay)}</span>
                        <span class="inbox-item-date">${esc(m.date || '')}</span>
                    </div>
                    <div class="inbox-item-subject">${esc(m.subject || 'Sans sujet')}</div>
                    <div class="inbox-item-preview">${esc(preview)}</div>
                    ${hasAttach ? '<div class="inbox-item-attach"><i class="icon-paperclip"></i> ' + m.attachments.length + ' pièce(s) jointe(s)</div>' : ''}
                </div>
            </div>`;
        });
    }

    container.innerHTML = html;
}

/* ═══════════════════════════════════════════════════════
   Inbox — Read Mail
   ═══════════════════════════════════════════════════════ */
async function openInboxMail(mailId) {
    selectedInboxId = mailId;
    let mail = inboxMails.find(m => m.id === mailId);
    if (!mail) return;

    if (inboxFolder === 'inbox' && !mail.processed) {
        showToast('Ce mail doit être traité via l\'onglet "Traitement" avant ouverture.', 'warning', 3000);
        return;
    }

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

    renderInboxList();
    renderInboxReader(mail);
}

function renderInboxReader(mail) {
    const reader = document.getElementById('inboxReader');
    if (!reader) return;
    const isCommercial = inboxFolder === 'commercial';

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
                <span><strong>À :</strong> <span id="readerToField"></span></span>
                ${mail.cc ? '<span><strong>Cc :</strong> <span id="readerCcField"></span></span>' : ''}
                <span><strong>Date :</strong> ${esc(mail.date || '')}</span>
                <span><strong>Compte :</strong> ${esc(mail.account || '')}</span>
                ${mail.folder === 'sent' ? '<span style="color:var(--accent-green);font-weight:600">📤 Envoyé</span>' : ''}
            </div>
            <div class="inbox-reader-actions">
                <button onclick="replyToMail('${esc(mail.id)}')"><i class="icon-reply"></i> Répondre à tous</button>
                <button onclick="forwardMail('${esc(mail.id)}')"><i class="icon-forward"></i> Transférer</button>
                ${isCommercial ? `<button onclick="keepCommercialMail('${esc(mail.id)}')"><i class="icon-bookmark"></i> Garder en reçus</button>` : ''}
                <button class="danger" onclick="openDeleteMailModal('${esc(mail.id)}')"><i class="icon-trash-2"></i> Supprimer</button>
            </div>
        </div>
        ${htmlContainer}
        ${attachHtml}`;

    if (hasHtml) {
        const frame = document.getElementById('mailHtmlFrame');
        if (frame) frame.srcdoc = mail.body_html;
    }
    setCollapsibleHeaderField('readerToField', mail.to || '');
    if (mail.cc) setCollapsibleHeaderField('readerCcField', mail.cc || '');
}

function openInboxAttachment(mailId, idx, name) {
    const url = `/api/mail/attachment?id=${encodeURIComponent(mailId)}&idx=${idx}&name=${encodeURIComponent(name)}`;
    window.open(url, '_blank', 'noopener');
}

/* ═══════════════════════════════════════════════════════
   Inbox — Actions
   ═══════════════════════════════════════════════════════ */
async function fetchEmails(options = {}) {
    const { silent = false } = options;
    const bgLabel = String(options.backgroundLabel || '').trim();
    const bgToken = (silent || bgLabel) ? startBackgroundActivity(bgLabel || 'Récupération des mails') : '';
    const statusEl = document.getElementById('inbox-status');
    if (!silent && statusEl) {
        statusEl.style.display = 'block';
        statusEl.className = 'inbox-status loading';
        statusEl.textContent = 'Connexion aux serveurs (POP3/IMAP/Gmail OAuth)…';
    }

    try {
        const r = await fetch('/api/fetch-emails', { method: 'POST' });
        const result = await r.json();
        if (result.error) {
            if (!silent && statusEl) {
                statusEl.className = 'inbox-status error';
                statusEl.textContent = 'Erreur : ' + result.error;
            }
        } else {
            await loadInbox();
            const errStr = result.errors && result.errors.length
                ? ` (${result.errors.length} erreur(s))`
                : '';
            if (!silent && statusEl) {
                statusEl.className = 'inbox-status success';
                statusEl.textContent = `${result.new_count} nouveau(x) mail(s) récupéré(s), dont ${result.commercial_count || 0} classé(s) commercial${errStr}`;
            }
        }
    } catch (e) {
        if (!silent && statusEl) {
            statusEl.className = 'inbox-status error';
            statusEl.textContent = 'Erreur réseau : ' + e.message;
        }
    } finally {
        if (bgToken) stopBackgroundActivity(bgToken);
    }

    if (!silent && statusEl) {
        setTimeout(() => { statusEl.style.display = 'none'; }, 5000);
    }
}

async function keepCommercialMail(mailId) {
    if (!mailId) return;
    showLoading('Déplacement vers les reçus…');
    try {
        const r = await fetch('/api/commercial/keep', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: [mailId] }),
        });
        const result = await r.json();
        if (!result.ok) {
            showToast('Erreur : ' + (result.error || 'échec'), 'error', 4000);
            return;
        }
        selectedInboxId = null;
        await loadInbox();
        showToast('Mail conservé dans les reçus.', 'success', 2400);
    } catch (e) {
        showToast('Erreur : ' + e.message, 'error', 4000);
    } finally {
        hideLoading();
    }
}

function keepSelectedCommercialMail() {
    if (!selectedInboxId) {
        showToast('Sélectionne un mail commercial.', 'warning', 2400);
        return;
    }
    keepCommercialMail(selectedInboxId);
}

async function deleteAllCommercialMails() {
    if (inboxFolder !== 'commercial') {
        showToast('Passe sur le dossier Commercial pour utiliser cette action.', 'warning', 2600);
        return;
    }
    if (!confirm('Supprimer TOUS les mails commerciaux localement et sur le serveur ?')) return;
    showLoading('Suppression massive des mails commerciaux…');
    try {
        const r = await fetch('/api/commercial/delete-all', { method: 'POST' });
        const result = await r.json();
        if (!result.ok) {
            showToast('Erreur : ' + (result.error || 'échec'), 'error', 5000);
            return;
        }
        selectedInboxId = null;
        await loadInbox();
        showToast(`${result.deleted || 0} mail(s) commercial(aux) supprimé(s).`, 'success', 2800);
    } catch (e) {
        showToast('Erreur : ' + e.message, 'error', 5000);
    } finally {
        hideLoading();
    }
}

async function processMyMails(options = {}) {
    const { silentWhenEmpty = false } = options;

    const modal = document.getElementById('mailProcessModal');
    if (modal?.classList.contains('show')) {
        return;
    }

    if (inboxFolder !== 'inbox') {
        inboxFolder = 'inbox';
        await loadInbox();
    }

    const resumeState = getResumeMailProcessState();
    if (resumeState) {
        startMailProcess(resumeState.queue, resumeState.skipStep1, resumeState.skipAttachments, resumeState.index);
        return;
    }

    const ids = getProcessableInboxIds();
    if (!ids.length) {
        if (!silentWhenEmpty) {
            showToast('Aucun mail à traiter.', 'warning', 2500);
        }
        clearMailProcessProgress();
        refreshMailProcessSummary();
        return;
    }
    startMailProcess(ids, false);
}

function replyToMail(mailId) {
    const mail = inboxMails.find(m => m.id === mailId);
    if (!mail) return;
    switchTab('mail');
    selectedMailTask = null;
    updateMailComposerState();
    renderMailList();
    // Pre-fill composer
    const recipients = buildReplyAllRecipients(mail);
    mailRecipients = recipients.to;
    mailCcRecipients = recipients.cc;

    renderMailTags();
    renderCcTags();
    document.getElementById('mailSubject').value = 'Re: ' + (mail.subject || '').replace(/^Re:\s*/i, '');
    document.getElementById('mailBody').value = '';
    setReplyComposerContext({
        originalText: mail.body || '',
        date: mail.date || '',
        from: mail.from_name || mail.from_email || '',
        type: 'reply'
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
    mailRecipients = [];
    mailCcRecipients = [];
    renderMailTags();
    renderCcTags();
    document.getElementById('mailSubject').value = 'Fwd: ' + (mail.subject || '').replace(/^Fwd:\s*/i, '');
    const fwdBody = '--- Mail transféré ---\n'
        + 'De : ' + (mail.from_name || '') + ' <' + (mail.from_email || '') + '>\n'
        + 'Date : ' + (mail.date || '') + '\n'
        + 'À : ' + (mail.to || '') + '\n'
        + (mail.cc ? 'Cc : ' + mail.cc + '\n' : '')
        + 'Sujet : ' + (mail.subject || '') + '\n\n'
        + (mail.body || '');
    document.getElementById('mailBody').value = '';
    setReplyComposerContext({
        originalText: fwdBody,
        date: mail.date || '',
        from: mail.from_name || mail.from_email || '',
        type: 'forward'
    });
    document.getElementById('mailToInput').focus();
}

/* ═══════════════════════════════════════════════════════
   Inbox — Delete
   ═══════════════════════════════════════════════════════ */
function openDeleteMailModal(mailId) {
    deleteMailTarget = mailId;
    const modal = document.getElementById('deleteMailModal');
    const subjectEl = document.getElementById('deleteMailSubject');
    const titleEl = document.getElementById('deleteMailModalTitle');
    const mail = inboxMails.find(m => m.id === mailId);
    if (titleEl) titleEl.textContent = 'Supprimer ce mail ?';
    if (subjectEl) subjectEl.textContent = mail ? mail.subject : '';
    modal.classList.add('show');
}

function closeDeleteMailModal() {
    document.getElementById('deleteMailModal').classList.remove('show');
    deleteMailTarget = null;
}

async function confirmDeleteMail() {
    if (!deleteMailTarget) return;
    const targetId = deleteMailTarget;
    closeDeleteMailModal();
    showLoading('Suppression du mail…');
    try {
        const r = await fetch('/api/mail/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: targetId })
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
    const tabBtn = document.querySelector('.tab-btn[data-tab="inbox"]');
    if (tabBtn) {
        tabBtn.innerHTML = '<i class="icon-inbox"></i>';
        tabBtn.setAttribute('aria-label', 'Inbox');
        tabBtn.setAttribute('title', 'Inbox');
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
        imap_post_action: acc.imap_post_action || 'keep',
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
                    <option value="keep" ${(acc.imap_post_action||'keep')==='keep'?'selected':''}>Conserver sur le serveur</option>
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
        ? buildHtmlBodyWithOptionalQuote(document.getElementById('mailBody').value.trim(), signatureHtml, getQuoteTextForHtml())
        : null;
    const isForwardMail = composerReplyContext?.type === 'forward';

    const previousIds = new Set(inboxMails.map(m => m.id));

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

            // Launch mail processing wizard for sent mails only when this is not a forward.
            await loadInbox();
            if (!isForwardMail) {
                const sentMailIds = inboxMails
                    .filter(m => !previousIds.has(m.id) && m.folder === 'sent')
                    .map(m => m.id);
                if (sentMailIds.length > 0) {
                    setTimeout(() => startMailProcess(sentMailIds, true, true), 500);
                }
            }
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

        // Live filename preview for short name field
        const shortNameInput = document.getElementById('mpShortName');
        if (shortNameInput) {
            shortNameInput.addEventListener('input', () => {
                const el = shortNameInput;
                const pos = el.selectionStart;
                // Replace spaces with _
                let v = el.value.replace(/\s+/g, '_');
                // Collapse multiple consecutive _
                v = v.replace(/_+/g, '_');
                // Allow at most one _ (exactly 2 words)
                const parts = v.split('_');
                if (parts.length > 2) {
                    v = parts[0] + '_' + parts.slice(1).join('');
                }
                if (v !== el.value) {
                    el.value = v;
                    el.setSelectionRange(pos, pos);
                }
                mpUpdateFilenamePreview();
            });
        }
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

function startAutoFetchLoop() {
    if (autoFetchTimer) clearInterval(autoFetchTimer);
    autoFetchTimer = setInterval(() => {
        if (document.hidden) return;
        fetchEmails({ silent: true, backgroundLabel: 'Récupération automatique des mails' }).catch(() => {});
    }, 90 * 1000);
}

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
    renderBackgroundActivityIndicator();
    if (!state.settings) state.settings = {};
    applyThemeMode(state.settings.uiTheme || 'dark');

    const geminiInput = document.getElementById('geminiKeyInput');

    renderSignaturesList();
    updateSignatureSelectors();
    mpRenderN1Options();

    autoSave();
    updateMailBadge();
    startAutoFetchLoop();
    loadInbox().then(() => {
        updateInboxBadge();
        // Populate From dropdown with account emails
        fetch('/api/accounts').then(r => r.json()).then(accs => {
            accountsData = (Array.isArray(accs) ? accs : []).map(normalizeAccountDefaults);
            updateMailFromOptions();
        }).catch(() => {});
    });
    setTimeout(() => {
        loadDownloadsManager({ silent: true }).catch(() => {});
    }, 800);
    setTimeout(() => {
        fetchEmails({ silent: true, backgroundLabel: 'Initialisation des mails' }).catch(() => {});
    }, 4000);
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

/* Shared session partitions — services that use the same SSO / login
   must share a single Electron partition so auth cookies persist across tabs.
   Renater services all authenticate through the same university IdP (ENT).
   Google services share the Google account session. */
const SHARED_PARTITIONS = {
    'site-default-doodle':      'persist:site-doodle',
    'site-default-filesender': 'persist:site-renater-sso',
    'site-default-jitsi':      'persist:site-jitsi',
    'site-default-gemini':     'persist:site-google',
    'site-default-calendar':   'persist:site-google',
};

const DEFAULT_SITE_TABS = [
    { id: 'site-default-doodle', label: 'Doodle', url: 'https://doodle.com/home', icon: 'icon-calendar-days', partition: 'persist:site-doodle' },
    { id: 'site-default-filesender', label: 'FileSender', url: 'https://filesender.renater.fr/', icon: 'icon-send', partition: 'persist:site-renater-sso' },
    { id: 'site-default-jitsi', label: 'Jitsi Meet', url: 'https://meet.jit.si/', icon: 'icon-video', partition: 'persist:site-jitsi' },
    { id: 'site-default-github', label: 'GitHub', url: 'https://github.com/', icon: 'icon-github' },
    { id: 'site-default-gemini', label: 'Gemini', url: 'https://gemini.google.com/app', icon: 'icon-sparkles', partition: 'persist:site-google' },
    { id: 'site-default-calendar', label: 'Google Calendar', url: 'https://calendar.google.com/', icon: 'icon-calendar-days', partition: 'persist:site-google' },
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
            partition: SHARED_PARTITIONS[t.id]
                || ((typeof t.partition === 'string' && t.partition.trim())
                    ? t.partition.trim()
                    : sitePartitionForTabId(t.id)),
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
        // Inject any new default tabs that are missing (e.g. Google Calendar).
        const defaults = buildDefaultSiteTabs();
        let changed = false;
        for (const def of defaults) {
            if (!fromState.find(t => t.id === def.id)) {
                fromState.push(def);
                changed = true;
            }
        }
        if (changed) {
            if (!state.settings) state.settings = {};
            state.settings.siteTabs = fromState;
            autoSave();
        }
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
   Annuaire Tab
   ═══════════════════════════════════════════════════════ */
let annuaireData = [];
let annuaireFiltered = [];
let annuaireSource = 'all';
let annuaireLoaded = false;

async function loadAnnuaire() {
    if (annuaireLoaded) return;
    const list = document.getElementById('annuaireList');
    if (!list) return;
    list.innerHTML = '<div class="chatbot-welcome"><p>Chargement de l\u2019annuaire…</p></div>';
    try {
        const r = await fetch('/api/annuaire');
        if (!r.ok) throw new Error('Erreur serveur');
        annuaireData = await r.json();
        annuaireLoaded = true;
        filterAnnuaire();
    } catch (err) {
        list.innerHTML = `<div class="annuaire-empty">Erreur : ${esc(err.message)}</div>`;
    }
}

function setAnnuaireSource(source) {
    annuaireSource = source || 'all';
    document.querySelectorAll('.annuaire-chip').forEach(chip => {
        chip.classList.toggle('active', chip.dataset.source === annuaireSource);
    });
    filterAnnuaire();
}

function filterAnnuaire() {
    const query = (document.getElementById('annuaireSearch')?.value || '').toLowerCase().trim();
    annuaireFiltered = annuaireData.filter(c => {
        if (annuaireSource !== 'all' && !(c.sources || []).includes(annuaireSource)) return false;
        if (!query) return true;
        return (c.name || '').toLowerCase().includes(query) || (c.email || '').toLowerCase().includes(query);
    });
    renderAnnuaireList();
}

function renderAnnuaireList() {
    const list = document.getElementById('annuaireList');
    const count = document.getElementById('annuaireCount');
    if (!list) return;
    if (count) count.textContent = `${annuaireFiltered.length} contact${annuaireFiltered.length !== 1 ? 's' : ''}`;

    if (!annuaireFiltered.length) {
        list.innerHTML = '<div class="annuaire-empty">Aucun contact trouvé.</div>';
        return;
    }

    list.innerHTML = annuaireFiltered.map((c, i) => {
        const initials = (c.name || c.email || '?').slice(0, 2).toUpperCase();
        const sourceBadges = (c.sources || []).map(s =>
            s === 'import'
                ? '<span class="annuaire-badge annuaire-badge-import">Importé</span>'
                : '<span class="annuaire-badge annuaire-badge-mail">Mail</span>'
        ).join('');
        const mailInfo = c.mail_count ? `<span class="annuaire-mail-count">${c.mail_count} mail${c.mail_count > 1 ? 's' : ''}</span>` : '';
        return `
            <div class="annuaire-item" onclick="openAnnuaireContact(${i})">
                <div class="annuaire-avatar">${esc(initials)}</div>
                <div class="annuaire-item-info">
                    <span class="annuaire-item-name">${esc(c.name || c.email)}</span>
                    <span class="annuaire-item-email">${esc(c.email)}</span>
                </div>
                <div class="annuaire-item-meta">
                    ${sourceBadges}
                    ${mailInfo}
                </div>
            </div>`;
    }).join('');
}

function openAnnuaireContact(index) {
    const c = annuaireFiltered[index];
    if (!c) return;
    const detail = document.getElementById('annuaireDetail');
    if (!detail) return;

    document.querySelectorAll('.annuaire-item').forEach((el, i) => {
        el.classList.toggle('active', i === index);
    });

    const initials = (c.name || c.email || '?').slice(0, 2).toUpperCase();
    const sourceBadges = (c.sources || []).map(s =>
        s === 'import'
            ? '<span class="annuaire-badge annuaire-badge-import">Importé</span>'
            : '<span class="annuaire-badge annuaire-badge-mail">Mail</span>'
    ).join(' ');

    detail.innerHTML = `
        <div class="annuaire-detail-card">
            <div class="annuaire-detail-header">
                <div class="annuaire-avatar annuaire-avatar-lg">${esc(initials)}</div>
                <div class="annuaire-detail-identity">
                    <h3>${esc(c.name || 'Inconnu')}</h3>
                    <span class="annuaire-detail-email">${esc(c.email)}</span>
                    <div class="annuaire-detail-sources">${sourceBadges}</div>
                </div>
            </div>
            <div class="annuaire-detail-actions">
                <button onclick="annuaireComposeTo('${esc(c.email)}')" class="annuaire-action-btn"><i class="icon-send"></i> Écrire</button>
            </div>
            ${c.mail_count ? `<div class="annuaire-detail-stat"><i class="icon-mail"></i> ${c.mail_count} mail${c.mail_count > 1 ? 's' : ''} échangé${c.mail_count > 1 ? 's' : ''}</div>` : ''}
        </div>`;
}

function annuaireComposeTo(email) {
    switchTab('mail');
    setTimeout(() => {
        addRecipient(email);
    }, 100);
}
