// app.js - Logique Principale du Système Cartésien

// ==========================================
// 1. ÉTATS ET VARIABLES GLOBALES
// ==========================================

const SystemState = {
    IDLE: 'IDLE',
    HOMING: 'HOMING',
    RUNNING: 'RUNNING',
    ERROR: 'ERROR'
};

let currentState = SystemState.IDLE;
let isConnected = false;
let serialPort = null;
let serialReader = null;
let serialWriter = null;
let keepReading = true;

// File d'attente d'instructions série
let txQueue = [];
let waitingForOk = false;
let _okDebounce = null;  // Timer pour absorber les doubles-OK du firmware

// Télémétrie
let isPaperConfigured = false;
let checklistDone = false;

// Géométrie
let svgPolylines = [];
let _rawSvgPolylines = [];    // polylines brutes haute résolution (avant filtre d'échelle)
let _rawHatchPolylines = [];  // hachures brutes haute résolution
let scaleFactor = 1;
let offsetX = 0;
let offsetY = 0;
let rotationAngle = 0;    // degrés, positif = sens horaire (tracé SVG)
let paperOffsetX = 0;     // mm, position du coin sup-gauche de la feuille
let paperOffsetY = 0;     // mm
let paperAngle = 0;       // degrés, rotation de la feuille
let totalSegments = 0;
let paperW = 210, paperH = 297;
let pendingPlotSimulate = false; // pour la modale hors-limites
let showTransformHandles = true; // false après Echap
let paperMagnetEnabled = true;  // magnétisme feuille (centre/coins zone travail)

// Hachures de remplissage
let hatchPolylines = [];     // lignes de hachures (tracées après les contours)
let totalHatchSegments = 0;

// Magnétisme + couleur de prévisualisation
let magnetEnabled = true;
let hatchPreviewColorKey = 'blue';
const HATCH_COLORS = {
    blue: 'rgba(21,101,192,0.60)',
    cyan: 'rgba(2,136,209,0.60)',
    teal: 'rgba(0,137,123,0.60)',
    green: 'rgba(46,125,50,0.60)',
    purple: 'rgba(106,27,154,0.60)',
    rose: 'rgba(233,30,99,0.60)',
    red: 'rgba(198,40,40,0.60)',
    brown: 'rgba(93,64,55,0.60)',
    slate: 'rgba(69,90,100,0.60)',
    amber: 'rgba(180,110,10,0.55)',
};

// SVG parsing (main-thread natif)
let currentSvgContent = null;

// Jumeau Numérique (Digital Twin)
let commandMap = [];      // Entrée par commande : { type, draws, polylineIdx, pointIdx }
let okCount = 0;          // Nb de OK reçus depuis début du tracé
let plotStartTime = null; // Timestamp démarrage tracé
let simulationTimer = null; // Timer simulation
let animFrameId = null;   // ID requestAnimationFrame (tête pulsante)

// Garde-fou stylo : état LOGIQUE du stylo (levé = false / baissé = true)
// Utilisé dans _executePlotting pour éviter les doubles up/down consécutifs.
let penIsDown = false;

// Audio Context (pour fallbacks internes sans internet)
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

// ==========================================
// 2. INITIALISATION ET UI BINDING
// ==========================================

document.addEventListener('DOMContentLoaded', () => {
    initNavigation();
    initSettingsOverrides();
    initKeyboardShortcuts();
    initNetworkMonitor();

    // Binding des boutons
    document.getElementById('btn-connect').addEventListener('click', toggleConnection);
    document.getElementById('btn-estop').addEventListener('click', () => triggerEStop('Manuel'));
    document.getElementById('btn-clear-error').addEventListener('click', clearError);
    document.getElementById('btn-clear-console').addEventListener('click', clearConsole);

    // Settings
    document.getElementById('nav-settings').addEventListener('click', () => { document.getElementById('modal-settings').classList.remove('hidden'); });
    document.getElementById('btn-close-settings').addEventListener('click', () => { document.getElementById('modal-settings').classList.add('hidden'); });
    document.getElementById('btn-save-settings').addEventListener('click', saveSettings);

    // Checklist
    document.getElementById('btn-checklist').addEventListener('click', () => { document.getElementById('modal-checklist').classList.remove('hidden'); });
    document.getElementById('btn-close-checklist').addEventListener('click', () => { document.getElementById('modal-checklist').classList.add('hidden'); });

    // Quickstart
    document.getElementById('btn-quickstart').addEventListener('click', () => {
        document.getElementById('nav-guide').click();
    });

    const chkPower = document.getElementById('chk-power');
    const chkPen = document.getElementById('chk-pen');
    const chkClear = document.getElementById('chk-clear');
    const btnValidateChecklist = document.getElementById('btn-validate-checklist');

    const validateCheck = () => {
        btnValidateChecklist.disabled = !(chkPower.checked && chkPen.checked && chkClear.checked);
    };
    [chkPower, chkPen, chkClear].forEach(el => el.addEventListener('change', validateCheck));
    btnValidateChecklist.addEventListener('click', () => {
        checklistDone = true;
        document.getElementById('modal-checklist').classList.add('hidden');
        updateUIState();
        showToast("Checklist validée.", "success");
    });

    // Auto Mode 
    document.getElementById('svg-file').addEventListener('change', handleSvgUpload);
    document.getElementById('invert-y').addEventListener('change', reparseSVG);
    document.getElementById('min-seg-length').addEventListener('change', () => {
        if (_rawSvgPolylines.length > 0) {
            applyScaleFilter();
            drawPreviewCanvas();
        } else {
            reparseSVG();
        }
    });
    document.getElementById('btn-start-auto').addEventListener('click', () => startPlotting(false));
    document.getElementById('btn-simulate').addEventListener('click', () => startPlotting(true));

    // Hachures
    document.getElementById('enable-hatch').addEventListener('change', (e) => {
        document.getElementById('hatch-options').classList.toggle('hidden', !e.target.checked);
        reparseSVG();
    });
    document.getElementById('hatch-type').addEventListener('change', reparseSVG);
    document.getElementById('hatch-spacing').addEventListener('change', reparseSVG);
    document.getElementById('hatch-preview-color').addEventListener('change', (e) => {
        hatchPreviewColorKey = e.target.value;
        drawPreviewCanvas();
    });

    // Magnétisme tracé SVG
    document.getElementById('magnet-snap').addEventListener('change', (e) => {
        magnetEnabled = e.target.checked;
    });
    // Magnétisme feuille
    document.getElementById('paper-magnet-snap').addEventListener('change', (e) => {
        paperMagnetEnabled = e.target.checked;
    });
    // Centrer la feuille
    document.getElementById('btn-center-paper').addEventListener('click', () => {
        const s = loadSettings();
        paperOffsetX = (s.xmax - paperW) / 2;
        paperOffsetY = (s.ymax - paperH) / 2;
        document.getElementById('paper-offset-x').value = paperOffsetX.toFixed(1);
        document.getElementById('paper-offset-y').value = paperOffsetY.toFixed(1);
        drawPreviewCanvas();
    });
    // Espacement min hachures
    document.getElementById('hatch-spacing-min').addEventListener('change', reparseSVG);

    // Placement Controls
    document.getElementById('paper-format').addEventListener('change', handlePaperChange);
    // Champs manuels position/angle de la feuille
    document.getElementById('paper-offset-x').addEventListener('input', (e) => { paperOffsetX = parseFloat(e.target.value) || 0; drawPreviewCanvas(); });
    document.getElementById('paper-offset-y').addEventListener('input', (e) => { paperOffsetY = parseFloat(e.target.value) || 0; drawPreviewCanvas(); });
    document.getElementById('paper-angle').addEventListener('input', (e) => { paperAngle = parseFloat(e.target.value) || 0; drawPreviewCanvas(); });
    document.getElementById('btn-paper-rot-cw').addEventListener('click', () => {
        paperAngle = ((paperAngle + 90) % 360);
        document.getElementById('paper-angle').value = paperAngle.toFixed(1);
        drawPreviewCanvas();
    });
    document.getElementById('btn-paper-rot-ccw').addEventListener('click', () => {
        paperAngle = ((paperAngle - 90 + 360) % 360);
        document.getElementById('paper-angle').value = paperAngle.toFixed(1);
        drawPreviewCanvas();
    });
    // Bouton modale prévisualisation
    document.getElementById('btn-open-preview-modal').addEventListener('click', openPreviewModal);
    document.getElementById('btn-close-preview-modal').addEventListener('click', closePreviewModal);
    document.getElementById('modal-preview').addEventListener('click', (e) => { if (e.target === document.getElementById('modal-preview')) closePreviewModal(); });
    // Echap masque les poignées
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            // Ferme d'abord les modales ouvertes
            const modals = document.querySelectorAll('.modal:not(.hidden)');
            if (modals.length > 0) { modals.forEach(m => m.classList.add('hidden')); return; }
            showTransformHandles = !showTransformHandles;
            drawPreviewCanvas();
            if (window._drawHandleOverlay && document.getElementById('modal-preview') && !document.getElementById('modal-preview').classList.contains('hidden')) {
                syncPreviewModal();
            }
        }
    });
    document.getElementById('scale-input').addEventListener('input', (e) => {
        scaleFactor = Math.max(0.01, parseFloat(e.target.value) || 1) / 100;
        if (_rawSvgPolylines.length > 0) applyScaleFilter();
        drawPreviewCanvas();
    });
    document.getElementById('rotation-input').addEventListener('input', (e) => {
        rotationAngle = parseFloat(e.target.value) || 0;
        drawPreviewCanvas();
    });
    document.getElementById('offset-x').addEventListener('input', (e) => { offsetX = parseFloat(e.target.value) || 0; drawPreviewCanvas(); });
    document.getElementById('offset-y').addEventListener('input', (e) => { offsetY = parseFloat(e.target.value) || 0; drawPreviewCanvas(); });

    // Modale hors-limites
    document.getElementById('btn-overflow-confirm').addEventListener('click', () => {
        document.getElementById('modal-overflow-confirm').classList.add('hidden');
        _executePlotting(pendingPlotSimulate);
    });
    document.getElementById('btn-overflow-cancel').addEventListener('click', () => {
        document.getElementById('modal-overflow-confirm').classList.add('hidden');
        showToast('Tracé annulé.', 'warning');
    });
    document.getElementById('btn-close-overflow').addEventListener('click', () => {
        document.getElementById('modal-overflow-confirm').classList.add('hidden');
    });

    // Transform Handles
    initTransformHandles();

    // Manual
    document.getElementById('btn-homing').addEventListener('click', () => {
        queueCommand('k');
        queueCommand('i');

    });
    document.querySelectorAll('.btn-jog').forEach(btn => {
        btn.addEventListener('click', (e) => {
            let axis = e.currentTarget.dataset.axis;
            let dir = parseInt(e.currentTarget.dataset.dir);
            let step = parseFloat(document.getElementById('jog-step').value);
            let val = dir * step;
            let rpm = loadSettings().vfast;
            queueCommand(`${axis.toLowerCase()}${val}v${rpm}`);
        });
    });

    // Suivi basique pour manuel (approximation)
    // Convention : delta Z positif = descente du stylo (vers le papier)
    //              delta Z négatif = montée du stylo (vers l'origine haute)
    let isZUp = true;
    document.getElementById('btn-z-up').addEventListener('click', () => {
        // Monter le stylo : aller vers la position zup
        let s = loadSettings();
        let ztarget = s.zup;
        let dz = ztarget - currentMachineZ; // négatif si on remonte (zup < currentMachineZ)
        if (Math.abs(dz) > 0.01) {
            queueCommand(`z${dz.toFixed(2)}v${s.vfast}`);
            currentMachineZ = ztarget; // Suivi local immédiat pour éviter les valeurs aberrantes
        }
        isZUp = true;
        queueCommand('s');
    });
    document.getElementById('btn-z-down').addEventListener('click', () => {
        // Descendre le stylo : aller vers la position zdown
        let s = loadSettings();
        let ztarget = s.zdown;
        let dz = ztarget - currentMachineZ; // positif si on descend (zdown > currentMachineZ)
        if (Math.abs(dz) > 0.01) {
            queueCommand(`z${dz.toFixed(2)}v${s.vfast}`);
            currentMachineZ = ztarget; // Suivi local immédiat
        }
        isZUp = false;
        queueCommand('s');
    });

    // Z Probing Modal
    document.getElementById('btn-z-probe').addEventListener('click', () => {
        document.getElementById('modal-z-probe').classList.remove('hidden');
        document.getElementById('probe-z-val').innerText = currentMachineZ.toFixed(2);
        queueCommand('s');
    });
    document.getElementById('btn-close-z-probe').addEventListener('click', () => { document.getElementById('modal-z-probe').classList.add('hidden'); });
    document.getElementById('btn-done-z-probe').addEventListener('click', () => { document.getElementById('modal-z-probe').classList.add('hidden'); });

    document.querySelectorAll('.btn-jog-z').forEach(btn => {
        btn.addEventListener('click', (e) => {
            let val = parseFloat(e.currentTarget.dataset.val);
            let s = loadSettings();
            let rpm = s.vfast;
            let newZ = currentMachineZ + val;
            // Clamp dans les limites
            newZ = Math.max(0, Math.min(s.zmax, newZ));
            let actualDelta = newZ - currentMachineZ;
            if (Math.abs(actualDelta) > 0.001) {
                queueCommand(`z${actualDelta.toFixed(2)}v${rpm}`);
                currentMachineZ = newZ; // Suivi local immédiat
                // Mettre à jour l'affichage Z dans la modale de probe immédiatement
                const probeZVal = document.getElementById('probe-z-val');
                if (probeZVal && !document.getElementById('modal-z-probe').classList.contains('hidden')) {
                    probeZVal.innerText = currentMachineZ.toFixed(2);
                }
            }
            queueCommand('s');
        });
    });

    document.getElementById('btn-set-z-down').addEventListener('click', () => {
        let s = loadSettings();
        s.zdown = currentMachineZ;
        localStorage.setItem('systemSettings', JSON.stringify(s));
        initSettingsOverrides();
        showToast("Z Stylo Baissé défini à " + currentMachineZ.toFixed(2) + "mm", "success");
    });

    document.getElementById('btn-set-z-up').addEventListener('click', () => {
        let s = loadSettings();
        s.zup = currentMachineZ;
        localStorage.setItem('systemSettings', JSON.stringify(s));
        initSettingsOverrides();
        showToast("Z Stylo Levé défini à " + currentMachineZ.toFixed(2) + "mm", "success");
    });

    document.getElementById('btn-go-abs').addEventListener('click', () => {
        const ax = document.getElementById('abs-x').value;
        const ay = document.getElementById('abs-y').value;
        const az = document.getElementById('abs-z').value;
        const av = document.getElementById('abs-v').value;

        const x = ax !== '' ? parseFloat(ax) : null;
        const y = ay !== '' ? parseFloat(ay) : null;
        const z = az !== '' ? parseFloat(az) : null;
        const v = av !== '' ? parseFloat(av) : loadSettings().vfast;

        if (x === null && y === null && z === null) {
            showToast("Veuillez entrer au moins une coordonnée.", "warning");
            return;
        }

        if (x !== null && (x < 0 || x > loadSettings().xmax)) { showToast("X hors limites", "error"); return; }
        if (y !== null && (y < 0 || y > loadSettings().ymax)) { showToast("Y hors limites", "error"); return; }
        if (z !== null && (z < 0 || z > loadSettings().zmax)) { showToast("Z hors limites", "error"); return; }

        pendingAbsoluteMove = { x, y, z, v };
        // Demande la position courante pour calculer le delta dans la réponse
        queueCommand('s');
    });

    updateUIState();
});

function initNavigation() {
    const navBtns = document.querySelectorAll('.nav-btn');
    const views = document.querySelectorAll('.view');
    navBtns.forEach(btn => {
        if (btn.id === 'nav-settings') return; // Settings is a modal
        btn.addEventListener('click', () => {
            navBtns.forEach(b => b.classList.remove('active'));
            views.forEach(v => v.classList.add('hidden'));
            btn.classList.add('active');
            let targetId = 'view-' + btn.id.replace('nav-', '');
            document.getElementById(targetId).classList.remove('hidden');
            document.getElementById(targetId).classList.add('active');
        });
    });

    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabs = document.querySelectorAll('.tab-content');
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            tabBtns.forEach(b => b.classList.remove('active'));
            tabs.forEach(t => t.classList.add('hidden'));
            btn.classList.add('active');
            document.getElementById(btn.dataset.target).classList.remove('hidden');
        });
    });
}

function initTransformHandles() {
    const canvas = document.getElementById('preview-canvas');
    if (!canvas) return;

    // ── ResizeObserver : redessine quand le conteneur change de taille ───
    const wrapperEl = document.getElementById('preview-wrapper');
    if (wrapperEl && !wrapperEl._resizeObserver) {
        const ro = new ResizeObserver(() => { drawPreviewCanvas(); });
        ro.observe(wrapperEl);
        wrapperEl._resizeObserver = ro;
    }

    // ── Affichage des coordonnées du curseur en mm réels ──────────────────
    const cursorOverlay = document.createElement('div');
    cursorOverlay.id = 'canvas-cursor-overlay';
    cursorOverlay.style.cssText = `
        position:absolute; bottom:6px; left:6px; z-index:10;
        background:rgba(0,0,0,0.62); color:#fff;
        font-family:monospace; font-size:11px;
        padding:3px 8px; border-radius:5px;
        pointer-events:none; display:none;
        white-space:nowrap; letter-spacing:0.02em;
    `;
    if (wrapperEl) {
        wrapperEl.style.position = 'relative';
        wrapperEl.appendChild(cursorOverlay);
    }

    canvas.addEventListener('mousemove', (e) => {
        const rect = canvas.getBoundingClientRect();
        const s = loadSettings();
        const relX = (e.clientX - rect.left) / rect.width;   // 0..1
        const relY = (e.clientY - rect.top) / rect.height;   // 0..1
        const mmX = (relX * s.xmax).toFixed(1);
        const mmY = (relY * s.ymax).toFixed(1);
        cursorOverlay.style.display = 'block';
        cursorOverlay.textContent = `X: ${mmX} mm  Y: ${mmY} mm`;
    });
    canvas.addEventListener('mouseleave', () => {
        cursorOverlay.style.display = 'none';
    });

    // ── Helpers ────────────────────────────────────────────────────────────
    function getTransformedBBox(W, H) {
        if (svgPolylines.length === 0) return null;
        const s = loadSettings();
        const canvW = W || canvas.width;
        const canvH = H || canvas.height;
        const rotRad = rotationAngle * Math.PI / 180;
        const cos = Math.cos(rotRad), sin = Math.sin(rotRad);
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        svgPolylines.forEach(poly => {
            poly.forEach(pt => {
                const rx = cos * pt.x - sin * pt.y;
                const ry = sin * pt.x + cos * pt.y;
                const cx = ((rx * scaleFactor + offsetX) / s.xmax) * canvW;
                const cy = ((ry * scaleFactor + offsetY) / s.ymax) * canvH;
                if (cx < minX) minX = cx;
                if (cy < minY) minY = cy;
                if (cx > maxX) maxX = cx;
                if (cy > maxY) maxY = cy;
            });
        });
        if (!isFinite(minX)) return null;
        return {
            minX, minY, maxX, maxY,
            cxPx: (minX + maxX) / 2, cyPx: (minY + maxY) / 2
        };
    }

    const HR = 7;
    const ROT_OFFSET = 28;

    function getHandlePositions(bbox) {
        const { minX, minY, maxX, maxY, cxPx, cyPx } = bbox;
        return {
            nw: { x: minX, y: minY }, n: { x: cxPx, y: minY }, ne: { x: maxX, y: minY },
            e: { x: maxX, y: cyPx }, se: { x: maxX, y: maxY }, s: { x: cxPx, y: maxY },
            sw: { x: minX, y: maxY }, w: { x: minX, y: cyPx },
            rot: { x: cxPx, y: minY - ROT_OFFSET }
        };
    }

    function drawHandlesOnCtx(ctx, W, H) {
        if (!showTransformHandles) return; // Masqué par Echap
        const s = loadSettings();
        const bbox = getTransformedBBox(W, H);

        if (magnetEnabled && bbox) {
            const svgCxMm = (bbox.cxPx / W) * s.xmax;
            const svgCyMm = (bbox.cyPx / H) * s.ymax;
            const paperCxMm = paperOffsetX + paperW / 2;
            const paperCyMm = paperOffsetY + paperH / 2;
            const SNAP_THRESHOLD = 12;
            const nearX = Math.abs(svgCxMm - paperCxMm) < SNAP_THRESHOLD;
            const nearY = Math.abs(svgCyMm - paperCyMm) < SNAP_THRESHOLD;
            if (nearX || nearY) {
                const pCxPx = (paperCxMm / s.xmax) * W;
                const pCyPx = (paperCyMm / s.ymax) * H;
                ctx.save();
                ctx.setLineDash([5, 4]); ctx.lineWidth = 1.2;
                if (nearX) { ctx.strokeStyle = 'rgba(16,185,129,0.80)'; ctx.beginPath(); ctx.moveTo(pCxPx, 0); ctx.lineTo(pCxPx, H); ctx.stroke(); }
                if (nearY) { ctx.strokeStyle = 'rgba(16,185,129,0.80)'; ctx.beginPath(); ctx.moveTo(0, pCyPx); ctx.lineTo(W, pCyPx); ctx.stroke(); }
                ctx.setLineDash([]); ctx.strokeStyle = '#10b981'; ctx.lineWidth = 2;
                ctx.beginPath(); ctx.moveTo(pCxPx - 10, pCyPx); ctx.lineTo(pCxPx + 10, pCyPx); ctx.moveTo(pCxPx, pCyPx - 10); ctx.lineTo(pCxPx, pCyPx + 10); ctx.stroke();
                ctx.beginPath(); ctx.arc(pCxPx, pCyPx, 5, 0, Math.PI * 2); ctx.lineWidth = 1.5; ctx.stroke();
                ctx.restore();
            }
        }

        if (!bbox) return;
        const handles = getHandlePositions(bbox);

        ctx.save(); ctx.setLineDash([5, 4]); ctx.strokeStyle = 'rgba(0,86,179,0.65)'; ctx.lineWidth = 1.5;
        ctx.strokeRect(bbox.minX, bbox.minY, bbox.maxX - bbox.minX, bbox.maxY - bbox.minY); ctx.restore();

        ctx.beginPath(); ctx.strokeStyle = 'rgba(224,168,0,0.7)'; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]);
        ctx.moveTo(handles.n.x, handles.n.y); ctx.lineTo(handles.rot.x, handles.rot.y); ctx.stroke(); ctx.setLineDash([]);

        ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach(k => {
            const h = handles[k];
            ctx.fillStyle = '#fff'; ctx.strokeStyle = '#0056b3'; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.rect(h.x - HR, h.y - HR, HR * 2, HR * 2); ctx.fill(); ctx.stroke();
        });

        ctx.beginPath(); ctx.arc(handles.rot.x, handles.rot.y, HR + 1, 0, Math.PI * 2);
        ctx.fillStyle = '#fff'; ctx.strokeStyle = '#e0a800'; ctx.lineWidth = 2.5; ctx.fill(); ctx.stroke();
        ctx.beginPath(); ctx.arc(handles.rot.x, handles.rot.y, 4, 0, Math.PI * 2); ctx.fillStyle = '#e0a800'; ctx.fill();
    }

    // ── Coordonnées souris → pixels canvas (gérant CSS scaling) ────────────
    function canvasMouseCoords(e) {
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        return {
            x: (e.clientX - rect.left) * scaleX,
            y: (e.clientY - rect.top) * scaleY
        };
    }

    function hitTest(mx, my) {
        const bbox = getTransformedBBox();
        if (!bbox) return null;
        const handles = getHandlePositions(bbox);
        const s = loadSettings();
        const HIT = HR + 5;

        if (Math.hypot(mx - handles.rot.x, my - handles.rot.y) < HIT + 2) return 'rotate';
        for (const k of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
            if (Math.abs(mx - handles[k].x) < HIT && Math.abs(my - handles[k].y) < HIT) return 'resize-' + k;
        }

        const pX1 = (paperOffsetX / s.xmax) * canvas.width;
        const pY1 = (paperOffsetY / s.ymax) * canvas.height;
        const pX2 = ((paperOffsetX + paperW) / s.xmax) * canvas.width;
        const pY2 = ((paperOffsetY + paperH) / s.ymax) * canvas.height;

        if (mx > bbox.minX && mx < bbox.maxX && my > bbox.minY && my < bbox.maxY) return 'move';
        if (mx > pX1 && mx < pX2 && my > pY1 && my < pY2) return 'paper';
        return null;
    }

    const cursorMap = {
        'resize-nw': 'nw-resize', 'resize-ne': 'ne-resize',
        'resize-sw': 'sw-resize', 'resize-se': 'se-resize',
        'resize-n': 'n-resize', 'resize-s': 's-resize',
        'resize-e': 'e-resize', 'resize-w': 'w-resize',
        'rotate': 'crosshair', 'move': 'move', 'paper': 'grab'
    };

    let dragMode = null, dragStart = { x: 0, y: 0 }, startVals = {}, rotCenter = { x: 0, y: 0 };

    canvas.addEventListener('mousedown', (e) => {
        const { x: mx, y: my } = canvasMouseCoords(e);
        dragMode = hitTest(mx, my);
        if (!dragMode) return;
        e.preventDefault();
        dragStart = { x: mx, y: my };
        startVals = { offsetX, offsetY, scaleFactor, rotationAngle, paperOffsetX, paperOffsetY };
        const bbox = getTransformedBBox();
        if (bbox) rotCenter = { x: bbox.cxPx, y: bbox.cyPx };
        if (dragMode === 'paper') canvas.style.cursor = 'grabbing';
    });

    window.addEventListener('mousemove', (e) => {
        const { x: mx, y: my } = canvasMouseCoords(e);
        const s = loadSettings();
        const mmPerPxX = s.xmax / canvas.width;
        const mmPerPxY = s.ymax / canvas.height;

        if (!dragMode) {
            const hit = hitTest(mx, my);
            canvas.style.cursor = hit ? (cursorMap[hit] || 'default') : 'default';
            return;
        }

        const dx = mx - dragStart.x, dy = my - dragStart.y;

        if (dragMode === 'move') {
            offsetX = startVals.offsetX + dx * mmPerPxX;
            offsetY = startVals.offsetY + dy * mmPerPxY;
            document.getElementById('offset-x').value = offsetX.toFixed(1);
            document.getElementById('offset-y').value = offsetY.toFixed(1);
            if (magnetEnabled) {
                const snapBbox = getTransformedBBox();
                if (snapBbox) {
                    const svgCxMm = (snapBbox.cxPx / canvas.width) * s.xmax;
                    const svgCyMm = (snapBbox.cyPx / canvas.height) * s.ymax;
                    const paperCxMm = paperOffsetX + paperW / 2;
                    const paperCyMm = paperOffsetY + paperH / 2;
                    const SNAP_T = 12;
                    const dX = paperCxMm - svgCxMm, dY = paperCyMm - svgCyMm;
                    if (Math.abs(dX) < SNAP_T) { offsetX += dX; document.getElementById('offset-x').value = offsetX.toFixed(1); }
                    if (Math.abs(dY) < SNAP_T) { offsetY += dY; document.getElementById('offset-y').value = offsetY.toFixed(1); }
                }
            }
        } else if (dragMode === 'paper') {
            paperOffsetX = startVals.paperOffsetX + dx * mmPerPxX;
            paperOffsetY = startVals.paperOffsetY + dy * mmPerPxY;
            // Magnétisme feuille : centre et coins de la zone de travail
            if (paperMagnetEnabled) {
                const PAPER_SNAP = 10; // mm
                const pCx = paperOffsetX + paperW / 2;
                const pCy = paperOffsetY + paperH / 2;
                const wCx = s.xmax / 2, wCy = s.ymax / 2;
                // Snap centre
                if (Math.abs(pCx - wCx) < PAPER_SNAP) paperOffsetX = wCx - paperW / 2;
                if (Math.abs(pCy - wCy) < PAPER_SNAP) paperOffsetY = wCy - paperH / 2;
                // Snap coins (haut-gauche)
                if (Math.abs(paperOffsetX) < PAPER_SNAP) paperOffsetX = 0;
                if (Math.abs(paperOffsetY) < PAPER_SNAP) paperOffsetY = 0;
                // Snap coins (bas-droit)
                if (Math.abs(paperOffsetX + paperW - s.xmax) < PAPER_SNAP) paperOffsetX = s.xmax - paperW;
                if (Math.abs(paperOffsetY + paperH - s.ymax) < PAPER_SNAP) paperOffsetY = s.ymax - paperH;
            }
            // Synchronise les champs de position
            document.getElementById('paper-offset-x').value = paperOffsetX.toFixed(1);
            document.getElementById('paper-offset-y').value = paperOffsetY.toFixed(1);
        } else if (dragMode === 'rotate') {
            const a1 = Math.atan2(dragStart.y - rotCenter.y, dragStart.x - rotCenter.x);
            const a2 = Math.atan2(my - rotCenter.y, mx - rotCenter.x);
            rotationAngle = startVals.rotationAngle + (a2 - a1) * 180 / Math.PI;
            document.getElementById('rotation-input').value = rotationAngle.toFixed(1);
        } else if (dragMode && dragMode.startsWith('resize')) {
            const dist1 = Math.hypot(dragStart.x - rotCenter.x, dragStart.y - rotCenter.y);
            const dist2 = Math.hypot(mx - rotCenter.x, my - rotCenter.y);
            if (dist1 > 2) { scaleFactor = Math.max(0.001, startVals.scaleFactor * (dist2 / dist1)); document.getElementById('scale-input').value = (scaleFactor * 100).toFixed(1); }
        }
        drawPreviewCanvas();
    });

    window.addEventListener('mouseup', () => {
        if (dragMode === 'paper') canvas.style.cursor = 'grab';
        // Re-filtrer les segments si on a redimensionné
        if (dragMode && dragMode.startsWith('resize') && _rawSvgPolylines.length > 0) {
            applyScaleFilter();
            drawPreviewCanvas();
        }
        dragMode = null;
    });

    window._drawHandleOverlay = drawHandlesOnCtx;
    window._redrawHandles = drawPreviewCanvas;
    drawPreviewCanvas();
}

// ==========================================
// 3. PERSISTANCE (LOCAL STORAGE)
// ==========================================

function loadSettings() {
    // zup  = position Z stylo LEVÉ  (proche de l'origine haute, ex: 0 mm)
    // zdown = position Z stylo BAISSÉ (descendu vers la feuille, delta positif depuis l'origine, ex: 10 mm)
    // Un delta Z positif = DESCENTE du stylo (convention Arduino : fin de course en haut = origine)
    const def = { xmax: 400, ymax: 400, zmax: 100, vfast: 100, vdraw: 40, zup: 0, zdown: 10, calib: 1.0 };
    const saved = localStorage.getItem('systemSettings');
    return saved ? { ...def, ...JSON.parse(saved) } : def;
}

function initSettingsOverrides() {
    const s = loadSettings();
    document.getElementById('cfg-xmax').value = s.xmax;
    document.getElementById('cfg-ymax').value = s.ymax;
    document.getElementById('cfg-zmax').value = s.zmax;
    document.getElementById('cfg-vfast').value = s.vfast;
    document.getElementById('cfg-vdraw').value = s.vdraw;
    // zup = position stylo levé (ex: 0 = origine haute), zdown = position stylo baissé (ex: 10mm)
    document.getElementById('cfg-zup').value = s.zup;
    document.getElementById('cfg-zdown').value = s.zdown;
    document.getElementById('cfg-calib').value = s.calib;
}

function saveSettings() {
    const s = {
        xmax: parseFloat(document.getElementById('cfg-xmax').value),
        ymax: parseFloat(document.getElementById('cfg-ymax').value),
        zmax: parseFloat(document.getElementById('cfg-zmax').value),
        vfast: parseFloat(document.getElementById('cfg-vfast').value),
        vdraw: parseFloat(document.getElementById('cfg-vdraw').value),
        zup: parseFloat(document.getElementById('cfg-zup').value),
        zdown: parseFloat(document.getElementById('cfg-zdown').value),
        calib: parseFloat(document.getElementById('cfg-calib').value)
    };
    localStorage.setItem('systemSettings', JSON.stringify(s));
    document.getElementById('modal-settings').classList.add('hidden');
    showToast("Paramètres sauvegardés", "success");
}

// ==========================================
// 4. RÉSEAU ET FEEDBACK
// ==========================================

function initNetworkMonitor() {
    const updateNetStat = () => {
        const span = document.getElementById('network-status');
        if (navigator.onLine) {
            span.innerHTML = '<i class="fas fa-wifi"></i> En ligne';
            span.classList.remove('offline-mode');
        } else {
            span.innerHTML = '<i class="fas fa-plane-slash"></i> Hors-ligne';
            span.classList.add('offline-mode');
            showToast("Mode Hors-ligne activé. WebSerial opérationnel.", "warning");
        }
    };
    window.addEventListener('online', updateNetStat);
    window.addEventListener('offline', updateNetStat);
    updateNetStat();
}

function showToast(msg, type = "info") {
    const container = document.getElementById('toast-container');
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.innerText = msg;
    container.appendChild(t);
    setTimeout(() => {
        t.classList.add('out');
        setTimeout(() => t.remove(), 300);
    }, 3000);
}

function playBeep(type) {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);

    if (type === 'error') {
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(150, audioCtx.currentTime);
        gain.gain.setValueAtTime(0.5, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.5);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.5);
    } else {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(800, audioCtx.currentTime);
        gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.2);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.2);
    }
}

// ==========================================
// 5. WEBSERIAL COMM
// ==========================================

async function toggleConnection() {
    if (!isConnected) {
        if (!('serial' in navigator)) {
            showToast("WebSerial non supporté par ce navigateur.", "error"); return;
        }
        try {
            serialPort = await navigator.serial.requestPort();
            await serialPort.open({ baudRate: 115200 });
            isConnected = true;
            keepReading = true;

            serialWriter = serialPort.writable.getWriter();
            readLoop();

            document.getElementById('connection-status').innerText = 'Connecté';
            document.getElementById('connection-status').classList.remove('disconnected');
            document.getElementById('connection-status').classList.add('connected');
            document.getElementById('btn-connect').innerHTML = '<i class="fas fa-plug"></i> <span>Déconnecter <u>U</u>SB</span>';

            showToast("Connecté à la carte !", "success");
            changeState(SystemState.IDLE);
        } catch (e) {
            console.error(e);
            showToast("Erreur de connexion", "error");
        }
    } else {
        disconnect();
    }
}

async function disconnect() {
    keepReading = false;
    isConnected = false;
    if (serialReader) { await serialReader.cancel(); }
    if (serialWriter) { await serialWriter.close(); }
    if (serialPort) { await serialPort.close(); serialPort = null; }

    document.getElementById('connection-status').innerText = 'Déconnecté';
    document.getElementById('connection-status').classList.add('disconnected');
    document.getElementById('connection-status').classList.remove('connected');
    document.getElementById('btn-connect').innerHTML = '<i class="fas fa-plug"></i> <span>Connecter <u>U</u>SB</span>';
    changeState(SystemState.IDLE);
}

async function readLoop() {
    const textDecoder = new TextDecoderStream();
    const readableStreamClosed = serialPort.readable.pipeTo(textDecoder.writable);
    serialReader = textDecoder.readable.getReader();

    let buffer = "";
    try {
        while (keepReading) {
            const { value, done } = await serialReader.read();
            if (done) break;
            if (value) {
                buffer += value;
                let lines = buffer.split('\n');
                buffer = lines.pop(); // keep incomplete line
                lines.forEach(line => {
                    line = line.trim();
                    if (line.length > 0) handleHardwareResponse(line);
                });
            }
        }
    } catch (e) {
        console.error(e);
    } finally {
        serialReader.releaseLock();
    }
}

let currentMachineX = 0;
let currentMachineY = 0;
let currentMachineZ = 0;
let pendingAbsoluteMove = null;

function handleHardwareResponse(line) {
    logConsole('rx', line);

    if (line.startsWith(">> X=")) {
        // Ex: >> X=10.00mm Y=20.00mm Z=0.00mm  [0-400 / 0-100mm]
        const match = line.match(/X=([\d.-]+)mm\s+Y=([\d.-]+)mm\s+Z=([\d.-]+)mm/);
        if (match) {
            currentMachineX = parseFloat(match[1]);
            currentMachineY = parseFloat(match[2]);
            // Mise à jour Z depuis le firmware : on prend la valeur réelle du firmware
            // sauf si une commande Z est en attente dans la file (pour éviter régressions)
            const fwZ = parseFloat(match[3]);
            // On accepte la position firmware si la file est vide (aucun mouvement Z en cours)
            if (txQueue.filter(c => c && c.startsWith('z')).length === 0) {
                currentMachineZ = fwZ;
            }

            const probeZVal = document.getElementById('probe-z-val');
            if (probeZVal && !document.getElementById('modal-z-probe').classList.contains('hidden')) {
                probeZVal.innerText = currentMachineZ.toFixed(2);
            }

            if (pendingAbsoluteMove) {
                const move = pendingAbsoluteMove;
                pendingAbsoluteMove = null;

                let dx = move.x !== null ? move.x - currentMachineX : 0;
                let dy = move.y !== null ? move.y - currentMachineY : 0;
                let dz = move.z !== null ? move.z - currentMachineZ : 0;

                // On séquence d'abord XY puis Z pour éviter les collisions ou simplifier (comme le fw le fait séparément)
                // Ou alors le système permet x y z ? Non, x..y..v.. OU z..v..
                if (dx !== 0 || dy !== 0) {
                    queueCommand(`x${dx.toFixed(2)}y${dy.toFixed(2)}v${move.v}`);
                }
                if (dz !== 0) {
                    queueCommand(`z${dz.toFixed(2)}v${move.v}`);
                }
            }
        }
    }

    if (line === "OK") {
        // ── Debounce OK ──────────────────────────────────────────────────
        // Le firmware envoie DEUX "OK" pour chaque commande de mouvement
        // (un dans afficherPosition() + un sendOk() explicite).
        // On regroupe tous les OK rapprochés en un seul événement.
        if (_okDebounce) clearTimeout(_okDebounce);
        _okDebounce = setTimeout(() => {
            _okDebounce = null;
            waitingForOk = false;
            if (currentState === SystemState.RUNNING && commandMap.length > 0) {
                onOkReceived();
            }
            processQueue();
        }, 8);
    } else if (line === "ERR") {
        // ── Gestion ERR : empêcher le deadlock ──────────────────────────
        // Le firmware envoie ERR sans OK. Sans traitement, waitingForOk
        // reste true et la file se bloque définitivement.
        if (_okDebounce) { clearTimeout(_okDebounce); _okDebounce = null; }
        waitingForOk = false;
        logConsole('err', 'Commande rejetée par le firmware (ERR)');
        showToast('Commande série rejetée (ERR)', 'warning');
        if (currentState === SystemState.RUNNING && commandMap.length > 0) {
            onOkReceived(); // Avance le compteur pour garder la synchronisation
        }
        processQueue();
    } else if (line.indexOf("LIMIT") === 0) {
        triggerEStop(line);
    } else if (line.indexOf("===") === 0) {
        document.getElementById('firmware-version').innerText = line;
    } else if (line.indexOf("!!! ARRET") !== -1) {
        // Confirmation d'arrêt d'urgence par le firmware — juste loggée
    }
}

async function sendData(str) {
    if (!serialWriter) return;
    const data = new TextEncoder().encode(str + "\n");
    await serialWriter.write(data);
    logConsole('tx', str);
}

function queueCommand(cmd) {
    txQueue.push(cmd);
    processQueue();
}

function processQueue() {
    if (!isConnected) return;
    if (waitingForOk) return; // Wait for OK
    if (txQueue.length === 0) {
        if (currentState === SystemState.RUNNING) changeState(SystemState.IDLE);
        return;
    }

    let cmd = txQueue.shift();
    waitingForOk = true;
    sendData(cmd);
}

// ==========================================
// 6. SÉCURITÉ ET LOGIQUE MÉTIER
// ==========================================

function changeState(newState) {
    currentState = newState;
    const badge = document.getElementById('machine-state');
    badge.innerText = currentState;
    badge.style.background =
        currentState === 'ERROR' ? '#c65050' :
            currentState === 'RUNNING' ? '#2e8b57' :
                currentState === 'HOMING' ? '#0056b3' : '#eee';
    badge.style.color = currentState === 'IDLE' ? '#333' : '#fff';

    // Réinitialise le jumeau si on revient à IDLE/ERROR
    if (newState !== SystemState.RUNNING) {
        stopTwinAnimation();
        document.getElementById('stat-eta').classList.remove('eta-running');
        document.getElementById('progress-bar').classList.remove('running-anim');
        if (newState === SystemState.IDLE) {
            // Redessine en mode normal après fin du tracé
            setTimeout(drawPreviewCanvas, 50);
        }
    }
    updateUIState();
}

function triggerEStop(reason = 'Manuel') {
    if (typeof reason !== 'string') reason = 'Manuel';
    txQueue = []; // Purge
    waitingForOk = false;
    if (_okDebounce) { clearTimeout(_okDebounce); _okDebounce = null; }
    stopSimulation();
    stopTwinAnimation();
    penIsDown = false;  // Réinitialise l'indicateur stylo
    updatePenStateIndicator();
    sendData('a'); // Arduino stop char
    changeState(SystemState.ERROR);
    playBeep('error');
    showToast(`ARRÊT D'URGENCE (${reason})`, "error");
}

function clearError() {
    if (currentState !== SystemState.ERROR) return;
    txQueue = [];
    waitingForOk = false;
    if (_okDebounce) { clearTimeout(_okDebounce); _okDebounce = null; }
    changeState(SystemState.IDLE);
    showToast('Erreur acquittée — machine en IDLE.', 'info');
}

function updateUIState() {
    const isReady = isConnected && currentState !== 'ERROR';
    const hasSvgReady = totalSegments > 0 && checklistDone;
    const isRunning = currentState === SystemState.RUNNING;
    const isError = currentState === SystemState.ERROR;

    document.querySelectorAll('.btn-jog').forEach(b => b.disabled = !isReady || isRunning);
    document.getElementById('btn-homing').disabled = !isReady || isRunning;

    document.getElementById('btn-start-auto').disabled = !(isReady && hasSvgReady && currentState === 'IDLE');

    // Bouton simulation : actif si SVG chargé et pas déjà en cours
    const btnSim = document.getElementById('btn-simulate');
    if (btnSim) btnSim.disabled = !(totalSegments > 0 && !isRunning);

    // Affichage de la barre de statut du tracé
    const statusBar = document.getElementById('plot-status-bar');
    if (statusBar) statusBar.classList.toggle('hidden', !isRunning);

    // Bouton de récupération d'erreur
    const btnClearErr = document.getElementById('btn-clear-error');
    if (btnClearErr) btnClearErr.classList.toggle('hidden', !isError);
}

// ==========================================
// 7. TRAITEMENT SVG (PARSER NATIF DOM)
// ==========================================

/**
 * Parse un SVG en utilisant les APIs natives du navigateur :
 *  - DOMParser pour construire un vrai arbre SVG
 *  - getCTM() pour les transformations accumulées (translate, rotate, scale, matrix, …)
 *  - getPointAtLength() pour discrétiser les chemins avec précision parfaite
 * Le paramètre de contrôle est la longueur minimale des segments (mm).
 */
function parseSVGNative(svgContent, minSegLength, invertY, enableHatch, hatchSpacing, hatchType, hatchSpacingMin = 0.35) {
    // ── 1. Insérer le SVG dans le DOM caché ──────────────────────────────
    const container = document.createElement('div');
    container.style.cssText = 'position:fixed;left:-9999px;top:-9999px;visibility:hidden;pointer-events:none';
    container.innerHTML = svgContent;
    document.body.appendChild(container);
    const svgEl = container.querySelector('svg');
    if (!svgEl) {
        document.body.removeChild(container);
        return { polylines: [], segments: 0, hatchPolylines: [], hatchSegments: 0 };
    }
    // S'assurer que le SVG a des dimensions réelles pour que getCTM fonctionne
    svgEl.style.width = svgEl.getAttribute('width') || '800px';
    svgEl.style.height = svgEl.getAttribute('height') || '800px';

    // ── 2. Parcours de tous les éléments géométriques ─────────────────────
    const polylines = [];
    const fillShapes = []; // pour les hachures

    const geometrySelectors = 'path, line, rect, circle, ellipse, polygon, polyline';
    const elements = svgEl.querySelectorAll(geometrySelectors);

    elements.forEach(el => {
        try {
            const ctm = el.getCTM();
            if (!ctm) return;

            // ── Fonction de transformation CTM ──────────────────────────
            const applyMatrix = (x, y) => ({
                x: ctm.a * x + ctm.c * y + ctm.e,
                y: ctm.b * x + ctm.d * y + ctm.f
            });

            let pts = [];

            // ── Géométrie SVG : conversion en polyline ──────────────────
            const tag = el.tagName.toLowerCase();

            if (tag === 'line') {
                const x1 = el.x1.baseVal.value, y1 = el.y1.baseVal.value;
                const x2 = el.x2.baseVal.value, y2 = el.y2.baseVal.value;
                pts = [applyMatrix(x1, y1), applyMatrix(x2, y2)];

            } else if (tag === 'rect') {
                const x = el.x.baseVal.value, y = el.y.baseVal.value;
                const w = el.width.baseVal.value, h = el.height.baseVal.value;
                if (w > 0 && h > 0) {
                    pts = [
                        applyMatrix(x, y), applyMatrix(x + w, y),
                        applyMatrix(x + w, y + h), applyMatrix(x, y + h), applyMatrix(x, y)
                    ];
                }

            } else if (tag === 'polygon' || tag === 'polyline') {
                for (let i = 0; i < el.points.numberOfItems; i++) {
                    const p = el.points.getItem(i);
                    pts.push(applyMatrix(p.x, p.y));
                }
                if (tag === 'polygon' && pts.length > 0) pts.push({ ...pts[0] });

            } else if (el instanceof SVGGeometryElement) {
                // path, circle, ellipse — discrétisation via getPointAtLength
                const totalLen = el.getTotalLength();
                if (totalLen < 0.01) return;
                const nSteps = Math.max(2, Math.ceil(totalLen / minSegLength));
                for (let i = 0; i <= nSteps; i++) {
                    const p = el.getPointAtLength((i / nSteps) * totalLen);
                    pts.push(applyMatrix(p.x, p.y));
                }
            }

            // Dédupliquer les points consécutifs identiques
            if (pts.length > 1) {
                const deduped = [pts[0]];
                for (let i = 1; i < pts.length; i++) {
                    if (Math.abs(pts[i].x - deduped[deduped.length - 1].x) > 1e-6 ||
                        Math.abs(pts[i].y - deduped[deduped.length - 1].y) > 1e-6) {
                        deduped.push(pts[i]);
                    }
                }
                if (deduped.length > 1) polylines.push(deduped);
            }

            // ── Extraction des fills pour hachures ──────────────────────
            if (enableHatch && pts.length >= 3) {
                const fill = getFillFromElement(el);
                if (fill) {
                    const gray = toGrayscale(fill);
                    if (gray < 248) {
                        const closed = isPolyClosed(pts);
                        if (closed) fillShapes.push({ polygon: pts, grayscale: gray });
                    }
                }
            }

        } catch (err) {
            console.warn('SVG element skip:', el.tagName, err);
        }
    });

    document.body.removeChild(container);

    // ── 3. Post-traitement ────────────────────────────────────────────────
    let processed = invertY
        ? polylines.map(p => p.map(pt => ({ x: pt.x, y: -pt.y })))
        : polylines;
    processed = optimizePathOrder(processed);

    // ── 4. Hachures ──────────────────────────────────────────────────────
    let hatchPoly = [];
    if (enableHatch && fillShapes.length > 0) {
        const MIN_SPACING = hatchSpacingMin;
        for (const shape of fillShapes) {
            let poly = invertY ? shape.polygon.map(p => ({ x: p.x, y: -p.y })) : shape.polygon;
            const t = shape.grayscale / 248;
            const spacing = hatchSpacingMin + ((hatchSpacing || 3) - hatchSpacingMin) * Math.pow(t, 0.55);
            hatchPoly.push(...generateHatchesForShape(poly, spacing, 45));
            if (hatchType === 'crosshatch') {
                hatchPoly.push(...generateHatchesForShape(poly, spacing, 135));
            }
        }
    }

    let segs = 0;
    processed.forEach(p => segs += Math.max(0, p.length - 1));
    let hatchSegs = 0;
    hatchPoly.forEach(p => hatchSegs += Math.max(0, p.length - 1));

    return { polylines: processed, segments: segs, hatchPolylines: hatchPoly, hatchSegments: hatchSegs };
}

// ── Hachures : scanline pour un polygone ──────────────────────────────────
function generateHatchesForShape(polygon, spacing, angleDeg) {
    if (polygon.length < 3 || spacing <= 0) return [];
    const angle = angleDeg * Math.PI / 180;
    const cosF = Math.cos(-angle), sinF = Math.sin(-angle);
    const cosB = Math.cos(angle), sinB = Math.sin(angle);
    const rotated = polygon.map(p => ({ x: cosF * p.x - sinF * p.y, y: sinF * p.x + cosF * p.y }));
    let minY = Infinity, maxY = -Infinity;
    rotated.forEach(p => { if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; });
    const n = rotated.length;
    const startY = Math.ceil(minY / spacing) * spacing;
    const hatches = [];
    for (let scanY = startY; scanY <= maxY + 1e-9; scanY += spacing) {
        const xs = [];
        for (let i = 0; i < n; i++) {
            const a = rotated[i], b = rotated[(i + 1) % n];
            if ((a.y <= scanY && b.y > scanY) || (b.y <= scanY && a.y > scanY)) {
                xs.push(a.x + (scanY - a.y) / (b.y - a.y) * (b.x - a.x));
            }
        }
        xs.sort((a, b) => a - b);
        for (let i = 0; i + 1 < xs.length; i += 2) {
            if (xs[i + 1] - xs[i] < 1e-9) continue;
            hatches.push([
                { x: cosB * xs[i] - sinB * scanY, y: sinB * xs[i] + cosB * scanY },
                { x: cosB * xs[i + 1] - sinB * scanY, y: sinB * xs[i + 1] + cosB * scanY }
            ]);
        }
    }
    return hatches;
}

// ── Utilitaires couleur / fill ────────────────────────────────────────────
function getFillFromElement(el) {
    const style = window.getComputedStyle(el);
    const fillStr = style.fill;
    if (!fillStr || fillStr === 'none' || fillStr === 'transparent') return null;
    return parseColorString(fillStr);
}

function parseColorString(str) {
    if (!str) return null;
    str = str.trim().toLowerCase();
    if (str === 'none' || str === 'transparent') return null;
    const rgbM = str.match(/rgb[a]?\s*\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/);
    if (rgbM) return { r: +rgbM[1], g: +rgbM[2], b: +rgbM[3] };
    // Hex
    if (str.startsWith('#')) {
        let h = str.slice(1);
        if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
    }
    // Pour les couleurs nommées, utilise un canvas temporaire
    try {
        const c = document.createElement('canvas').getContext('2d');
        c.fillStyle = str;
        const hex = c.fillStyle; // retourne toujours en #rrggbb
        if (hex.startsWith('#')) return parseColorString(hex);
    } catch (e) { }
    return null;
}

function toGrayscale(c) { return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b; }
function isPolyClosed(pts) {
    if (pts.length < 3) return false;
    const f = pts[0], l = pts[pts.length - 1];
    return Math.hypot(f.x - l.x, f.y - l.y) < 1e-4;
}

// ── Optimisation d'ordre (Nearest-Neighbour) ──────────────────────────────
function optimizePathOrder(polylines) {
    if (polylines.length <= 1) return polylines;
    const result = [], unvisited = [...polylines];
    let cur = { x: 0, y: 0 };
    while (unvisited.length > 0) {
        let bestDist = Infinity, bestIdx = -1, bestRev = false;
        for (let i = 0; i < unvisited.length; i++) {
            const s = unvisited[i][0], e = unvisited[i][unvisited[i].length - 1];
            const ds = Math.hypot(s.x - cur.x, s.y - cur.y);
            const de = Math.hypot(e.x - cur.x, e.y - cur.y);
            if (ds < bestDist) { bestDist = ds; bestIdx = i; bestRev = false; }
            if (de < bestDist) { bestDist = de; bestIdx = i; bestRev = true; }
        }
        const chosen = unvisited.splice(bestIdx, 1)[0];
        if (bestRev) chosen.reverse();
        result.push(chosen);
        cur = chosen[chosen.length - 1];
    }
    return result;
}

function reparseSVG() {
    if (!currentSvgContent) return;
    const invertY = document.getElementById('invert-y').checked;
    const enableHatch = document.getElementById('enable-hatch').checked;
    const hatchSpacing = parseFloat(document.getElementById('hatch-spacing').value) || 3;
    const hatchSpacingMin = parseFloat(document.getElementById('hatch-spacing-min').value) || 0.35;
    const hatchType = document.getElementById('hatch-type').value;

    // Toujours parser à haute résolution (0.1 mm dans le repère SVG)
    const FINE_RESOLUTION = 0.1;
    const result = parseSVGNative(currentSvgContent, FINE_RESOLUTION, invertY, enableHatch, hatchSpacing, hatchType, hatchSpacingMin);

    // Stocker les polylines brutes haute résolution
    _rawSvgPolylines = result.polylines;
    _rawHatchPolylines = result.hatchPolylines;

    // Appliquer le filtre d'échelle (minSegLength en mm réels)
    applyScaleFilter();

    drawPreviewCanvas();
    updateSvgBBoxDisplay();
    showToast('SVG traité avec succès.', 'success');
    updateUIState();
}

/**
 * Calcule et affiche les coordonnées des deux coins extrémaux du SVG
 * (après transformation scale/offset/rotation) dans l'UI.
 */
function updateSvgBBoxDisplay() {
    const el = document.getElementById('svg-bbox-info');
    if (!el) return;

    if (svgPolylines.length === 0) {
        el.textContent = '';
        el.style.display = 'none';
        return;
    }

    const s = loadSettings();
    const rotRad = rotationAngle * Math.PI / 180;
    const cosR = Math.cos(rotRad), sinR = Math.sin(rotRad);

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    svgPolylines.forEach(poly => {
        poly.forEach(pt => {
            const rx = cosR * pt.x - sinR * pt.y;
            const ry = sinR * pt.x + cosR * pt.y;
            const mmX = rx * scaleFactor + offsetX;
            const mmY = ry * scaleFactor + offsetY;
            if (mmX < minX) minX = mmX;
            if (mmY < minY) minY = mmY;
            if (mmX > maxX) maxX = mmX;
            if (mmY > maxY) maxY = mmY;
        });
    });

    if (!isFinite(minX)) {
        el.textContent = '';
        el.style.display = 'none';
        return;
    }

    el.style.display = 'block';
    el.innerHTML =
        `<i class="fas fa-vector-square"></i> ` +
        `SVG : <b>(${minX.toFixed(1)}, ${minY.toFixed(1)})</b> → ` +
        `<b>(${maxX.toFixed(1)}, ${maxY.toFixed(1)})</b> mm`;
}

/**
 * Décime les polylines brutes en fusionnant les segments trop courts
 * (en dessous de minSegLength dans l'espace réel = mm après scaleFactor).
 * Appelée à chaque changement de : scaleFactor, minSegLength.
 */
function applyScaleFilter() {
    const minSeg = parseFloat(document.getElementById('min-seg-length').value) || 0.5;
    // minSeg est en mm réels. Dans le repère SVG, cela correspond à minSeg / scaleFactor.
    const effectiveMin = scaleFactor > 0 ? minSeg / scaleFactor : minSeg;

    svgPolylines = decimatePolylines(_rawSvgPolylines, effectiveMin);
    hatchPolylines = decimatePolylines(_rawHatchPolylines, effectiveMin);

    // Compter les segments
    totalSegments = 0;
    svgPolylines.forEach(p => totalSegments += Math.max(0, p.length - 1));
    totalHatchSegments = 0;
    hatchPolylines.forEach(p => totalHatchSegments += Math.max(0, p.length - 1));

    updateSegmentStats();
}

/**
 * Décime un tableau de polylines : fusionne les segments consécutifs dont
 * la longueur cumulée est inférieure à minLen.
 * Conserve toujours le premier et le dernier point de chaque polyline.
 */
function decimatePolylines(rawPolylines, minLen) {
    if (minLen <= 0) return rawPolylines.map(p => [...p]);
    const minLenSq = minLen * minLen; // comparaison en carré pour perf
    return rawPolylines.map(poly => {
        if (poly.length <= 2) return [...poly];
        const out = [poly[0]];
        for (let i = 1; i < poly.length - 1; i++) {
            const last = out[out.length - 1];
            const dx = poly[i].x - last.x;
            const dy = poly[i].y - last.y;
            if (dx * dx + dy * dy >= minLenSq) {
                out.push(poly[i]);
            }
        }
        // Toujours garder le dernier point
        out.push(poly[poly.length - 1]);
        return out;
    }).filter(p => p.length >= 2);
}

/**
 * Met à jour les badges de segments dans l'UI.
 */
function updateSegmentStats() {
    document.getElementById('stat-segments').innerText = totalSegments.toLocaleString();
    const hatchBadge = document.getElementById('badge-hatch-segs');
    if (hatchBadge) {
        document.getElementById('stat-hatch-segments').innerText = totalHatchSegments.toLocaleString();
        hatchBadge.style.display = totalHatchSegments > 0 ? '' : 'none';
    }
    const warnTotal = totalSegments + totalHatchSegments;
    if (warnTotal > 10000) document.getElementById('warning-segments').classList.remove('hidden');
    else document.getElementById('warning-segments').classList.add('hidden');
}

function handleSvgUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    document.getElementById('file-name').innerText = file.name;

    const reader = new FileReader();
    reader.onload = function (evt) {
        currentSvgContent = evt.target.result;
        reparseSVG();
    };
    reader.readAsText(file);
}

function handlePaperChange(e) {
    const v = e.target.value;
    // Formats standards (toujours dans le sens naturel W×H)
    const formats = {
        'A4': [210, 297],
        'B5': [176, 250],
        'A5': [148, 210],
        'B6': [125, 176],
        'A6': [105, 148],
        'B7': [88, 125],
        'A7': [74, 105],
        'A8': [52, 74],
        'CUSTOM': [loadSettings().xmax, loadSettings().ymax],
    };
    if (formats[v]) { [paperW, paperH] = formats[v]; }
    drawPreviewCanvas();
}

function drawPreviewCanvas() {
    const canvas = document.getElementById('preview-canvas');
    const ctx = canvas.getContext('2d');
    const s = loadSettings();

    // ── HiDPI : taille physique réelle du canvas CSS ──────────────────
    const dpr = window.devicePixelRatio || 1;
    const wrapper = document.getElementById('preview-wrapper');
    const cssW = wrapper ? wrapper.clientWidth || 400 : 400;
    const cssH = wrapper ? wrapper.clientHeight || cssW : cssW;
    const physW = Math.round(cssW * dpr);
    const physH = Math.round(physW); // carré

    // Ne redimensionne que si nécessaire (évite les reflows inutiles)
    if (canvas.width !== physW || canvas.height !== physH) {
        canvas.width = physW;
        canvas.height = physH;
        canvas.style.width = cssW + 'px';
        canvas.style.height = cssW + 'px';
    }

    // Toute la logique de dessin utilise physW/physH comme taille canvas
    const W = physW, H = physH;

    // On utilise la nouvelle fonction de rendu
    const isOutOfPaper = _renderPreviewToContext(ctx, W, H, 1);

    const isRunning = currentState === SystemState.RUNNING && commandMap.length > 0;

    // Bordure canvas (wrapper déjà déclaré en haut de drawPreviewCanvas)
    if (isOutOfPaper && svgPolylines.length > 0) {
        wrapper.style.borderColor = '#e74c3c';
        wrapper.style.boxShadow = '0 0 12px rgba(231,76,60,0.5)';
    } else if (isRunning) {
        wrapper.style.borderColor = '#27ae60';
        wrapper.style.boxShadow = '0 0 14px rgba(39,174,96,0.5)';
    } else {
        wrapper.style.borderColor = '#ccc';
        wrapper.style.boxShadow = 'none';
    }

    // Poignées dessinées sur le MÊME canvas (alignement pixel-perfect garanti)
    if (window._drawHandleOverlay) {
        window._drawHandleOverlay(ctx, W, H);
    }

    // Mise à jour du bounding box SVG (coins extrémaux en mm)
    updateSvgBBoxDisplay();

    // Synchronise la modale de prévisualisation si ouverte
    const previewModal = document.getElementById('modal-preview');
    if (previewModal && !previewModal.classList.contains('hidden')) {
        syncPreviewModal();
    }
}

// Fonction de rendu commune (pour le canvas principal ET la modale zoomée)
function _renderPreviewToContext(ctx, W, H, zoom = 1) {
    const s = loadSettings();
    ctx.clearRect(0, 0, W, H);

    // Fond de l'espace de travail (zone machine)
    ctx.fillStyle = '#e9ecef';
    ctx.fillRect(0, 0, W, H);

    // Grille légère
    ctx.strokeStyle = 'rgba(0,0,0,0.06)';
    ctx.lineWidth = 0.5 / zoom;
    const gridMm = 50;
    for (let gx = 0; gx <= s.xmax; gx += gridMm) {
        const px = (gx / s.xmax) * W;
        ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke();
    }
    for (let gy = 0; gy <= s.ymax; gy += gridMm) {
        const py = (gy / s.ymax) * H;
        ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(W, py); ctx.stroke();
    }

    // Limite physique de la machine (400 × 400 mm) — bord #333
    ctx.strokeStyle = '#333333';
    ctx.lineWidth = 1.5 / zoom;
    ctx.setLineDash([]);
    ctx.strokeRect(0.75, 0.75, W - 1.5, H - 1.5);

    // Feuille de papier à sa position déplaçable, avec rotation
    const pxX = (paperOffsetX / s.xmax) * W;
    const pxY = (paperOffsetY / s.ymax) * H;
    const pwPx = (paperW / s.xmax) * W;
    const phPx = (paperH / s.ymax) * H;
    const pCxPx = pxX + pwPx / 2;
    const pCyPx = pxY + phPx / 2;
    const pAngRad = paperAngle * Math.PI / 180;

    ctx.save();
    ctx.translate(pCxPx, pCyPx);
    ctx.rotate(pAngRad);
    ctx.shadowColor = 'rgba(0,0,0,0.18)';
    ctx.shadowBlur = 8 / zoom;
    ctx.shadowOffsetX = 2 / zoom;
    ctx.shadowOffsetY = 2 / zoom;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(-pwPx / 2, -phPx / 2, pwPx, phPx);
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
    ctx.strokeStyle = '#aaaaaa';
    ctx.lineWidth = 1 / zoom;
    ctx.strokeRect(-pwPx / 2, -phPx / 2, pwPx, phPx);
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    // Le texte garde sa taille proportionnelle à la feuille, donc on ne divise pas la taille de la police par zoom
    ctx.font = `bold ${Math.max(9, pwPx * 0.08)}px sans-serif`;
    ctx.fillText(`${paperW}×${paperH}mm`, -pwPx / 2 + 4, -phPx / 2 + Math.max(12, pwPx * 0.09));
    ctx.restore();

    // Transformation SVG
    const rotRad = rotationAngle * Math.PI / 180;
    const cosR = Math.cos(rotRad), sinR = Math.sin(rotRad);

    const toCanvas = (x, y) => {
        const rx = cosR * x - sinR * y;
        const ry = sinR * x + cosR * y;
        return {
            cx: ((rx * scaleFactor + offsetX) / s.xmax) * W,
            cy: ((ry * scaleFactor + offsetY) / s.ymax) * H
        };
    };

    const isRunning = currentState === SystemState.RUNNING && commandMap.length > 0;
    let isOutOfPaper = false;

    // Vérification hors-feuille
    const pCxMm = paperOffsetX + paperW / 2;
    const pCyMm = paperOffsetY + paperH / 2;
    const pAngR = -paperAngle * Math.PI / 180;
    const cosPa = Math.cos(pAngR), sinPa = Math.sin(pAngR);
    svgPolylines.forEach(poly => {
        poly.forEach(pt => {
            const rx = cosR * pt.x - sinR * pt.y;
            const ry = sinR * pt.x + cosR * pt.y;
            const mmX = rx * scaleFactor + offsetX;
            const mmY = ry * scaleFactor + offsetY;
            const dX = mmX - pCxMm, dY = mmY - pCyMm;
            const lx = cosPa * dX - sinPa * dY + paperW / 2;
            const ly = sinPa * dX + cosPa * dY + paperH / 2;
            if (lx < 0 || lx > paperW || ly < 0 || ly > paperH) isOutOfPaper = true;
        });
    });

    if (!isRunning) {
        // MODE NORMAL
        ctx.strokeStyle = '#0056b3';
        ctx.lineWidth = 1.2 / zoom;
        let lastPenX = 0, lastPenY = 0;
        let totalDrawDist = 0, totalTravelDist = 0;

        svgPolylines.forEach(poly => {
            ctx.beginPath();
            for (let i = 0; i < poly.length; i++) {
                const rotX = cosR * poly[i].x - sinR * poly[i].y;
                const rotY = sinR * poly[i].x + cosR * poly[i].y;
                const mx = rotX * scaleFactor + offsetX;
                const my = rotY * scaleFactor + offsetY;
                const { cx, cy } = toCanvas(poly[i].x, poly[i].y);
                if (i === 0) {
                    ctx.moveTo(cx, cy);
                    totalTravelDist += Math.hypot(mx - lastPenX, my - lastPenY);
                } else {
                    ctx.lineTo(cx, cy);
                    totalDrawDist += Math.hypot(mx - lastPenX, my - lastPenY);
                }
                lastPenX = mx; lastPenY = my;
            }
            ctx.stroke();
        });

        // Hachures
        if (hatchPolylines.length > 0) {
            ctx.strokeStyle = HATCH_COLORS[hatchPreviewColorKey] || HATCH_COLORS.blue;
            ctx.lineWidth = 0.85 / zoom;
            hatchPolylines.forEach(poly => {
                if (poly.length < 2) return;
                ctx.beginPath();
                const { cx: cx0, cy: cy0 } = toCanvas(poly[0].x, poly[0].y);
                ctx.moveTo(cx0, cy0);
                for (let i = 1; i < poly.length; i++) {
                    const { cx, cy } = toCanvas(poly[i].x, poly[i].y);
                    ctx.lineTo(cx, cy);
                }
                ctx.stroke();

                for (let i = 1; i < poly.length; i++) {
                    const rx0 = cosR * poly[i - 1].x - sinR * poly[i - 1].y;
                    const ry0 = sinR * poly[i - 1].x + cosR * poly[i - 1].y;
                    const rx1 = cosR * poly[i].x - sinR * poly[i].y;
                    const ry1 = sinR * poly[i].x + cosR * poly[i].y;
                    totalDrawDist += Math.hypot((rx1 - rx0) * scaleFactor, (ry1 - ry0) * scaleFactor);
                }
            });
        }

        // ETA
        const speedDraw = s.vdraw * 40, speedTravel = s.vfast * 40;
        if (speedDraw > 0 && speedTravel > 0) {
            const zTime = svgPolylines.length * 2 * (10 / (s.vfast * 40)) * 60;
            const t = (totalDrawDist / speedDraw) * 60 + (totalTravelDist / speedTravel) * 60 + zTime;
            const etaStr = `~${Math.floor(t / 60)}m ${Math.floor(t % 60)}s`;
            const etaEl = document.getElementById('stat-eta');
            if (etaEl) {
                etaEl.innerText = etaStr;
                etaEl.classList.remove('eta-running');
            }
        }
    } else {
        // JUMEAU NUMÉRIQUE
        ctx.strokeStyle = 'rgba(0, 86, 179, 0.15)';
        ctx.lineWidth = 1.5 / zoom;
        svgPolylines.forEach(poly => {
            ctx.beginPath();
            for (let i = 0; i < poly.length; i++) {
                const { cx, cy } = toCanvas(poly[i].x, poly[i].y);
                if (i === 0) ctx.moveTo(cx, cy); else ctx.lineTo(cx, cy);
            }
            ctx.stroke();
        });

        ctx.strokeStyle = '#27ae60';
        ctx.lineWidth = 2 / zoom;
        ctx.shadowColor = '#2ecc71';
        ctx.shadowBlur = 5 / zoom;
        getConfirmedSegments().forEach(seg => {
            const poly = svgPolylines[seg.polylineIdx];
            if (!poly) return;
            const from = poly[seg.fromIdx], to = poly[seg.toIdx];
            if (!from || !to) return;
            const f = toCanvas(from.x, from.y);
            const t = toCanvas(to.x, to.y);
            ctx.beginPath(); ctx.moveTo(f.cx, f.cy); ctx.lineTo(t.cx, t.cy); ctx.stroke();
        });
        ctx.shadowBlur = 0;

        let lastDrawCmd = null;
        for (let i = Math.min(okCount, commandMap.length) - 1; i >= 0; i--) {
            if (commandMap[i].draws) { lastDrawCmd = commandMap[i]; break; }
        }
        if (lastDrawCmd) {
            const poly = svgPolylines[lastDrawCmd.polylineIdx];
            const pt = poly && poly[lastDrawCmd.pointIdx];
            if (pt) {
                const { cx, cy } = toCanvas(pt.x, pt.y);
                const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 180);
                ctx.beginPath();
                ctx.arc(cx, cy, (4 + pulse * 3) / zoom, 0, Math.PI * 2);
                ctx.fillStyle = `rgba(231,76,60,${0.6 + pulse * 0.4})`;
                ctx.shadowColor = '#e74c3c';
                ctx.shadowBlur = 12 / zoom;
                ctx.fill();
                ctx.shadowBlur = 0;
            }
        }
    }

    // ── Repère machine (origine = coin supérieur droit) ───────────────────────
    // X pointe vers la gauche, Y pointe vers le bas (convention H-bot après homing)
    {
        const AXIS_LEN = Math.round(Math.min(W, H) * 0.18); // longueur des flèches (18% du canvas)
        const ARROW_HEAD = Math.round(AXIS_LEN * 0.22);       // tête de flèche
        const OX = W - 2;   // origine en pixels : coin supérieur droit
        const OY = 2;
        const LW = Math.max(1.5, 2.5 / zoom);

        ctx.save();
        ctx.lineWidth = LW;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.setLineDash([]);

        // Point d'origine
        ctx.beginPath();
        ctx.arc(OX, OY, LW * 2.2, 0, Math.PI * 2);
        ctx.fillStyle = '#c0392b';
        ctx.fill();

        // ─ Axe X (pointe vers la gauche) ─
        ctx.strokeStyle = '#c0392b';
        ctx.fillStyle = '#c0392b';
        ctx.beginPath();
        ctx.moveTo(OX, OY);
        ctx.lineTo(OX - AXIS_LEN, OY);
        ctx.stroke();
        // Tête de flèche X
        ctx.beginPath();
        ctx.moveTo(OX - AXIS_LEN, OY);
        ctx.lineTo(OX - AXIS_LEN + ARROW_HEAD, OY - ARROW_HEAD * 0.42);
        ctx.lineTo(OX - AXIS_LEN + ARROW_HEAD, OY + ARROW_HEAD * 0.42);
        ctx.closePath();
        ctx.fill();
        // Label "x"
        const fSize = Math.max(11, Math.round(AXIS_LEN * 0.2));
        ctx.font = `italic bold ${fSize}px serif`;
        ctx.fillStyle = '#c0392b';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText('x', OX - AXIS_LEN - fSize * 0.7, OY + fSize * 0.9);

        // ─ Axe Y (pointe vers le bas) ─
        ctx.strokeStyle = '#c0392b';
        ctx.fillStyle = '#c0392b';
        ctx.beginPath();
        ctx.moveTo(OX, OY);
        ctx.lineTo(OX, OY + AXIS_LEN);
        ctx.stroke();
        // Tête de flèche Y
        ctx.beginPath();
        ctx.moveTo(OX, OY + AXIS_LEN);
        ctx.lineTo(OX - ARROW_HEAD * 0.42, OY + AXIS_LEN - ARROW_HEAD);
        ctx.lineTo(OX + ARROW_HEAD * 0.42, OY + AXIS_LEN - ARROW_HEAD);
        ctx.closePath();
        ctx.fill();
        // Label "y"
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText('y', OX + fSize * 0.35, OY + AXIS_LEN + fSize * 0.7);

        ctx.restore();
    }

    return isOutOfPaper;
}


// ==========================================
// 9. JUMEAU NUMÉRIQUE
// ==========================================

function onOkReceived() {
    okCount++;
    // Mise à jour de l'état logique du stylo (pour l'indicateur UI)
    if (okCount > 0 && commandMap.length > 0) {
        const lastCmd = commandMap[okCount - 1];
        if (lastCmd) {
            if (lastCmd.type === 'z-down' || lastCmd.type === 'hatch-down') penIsDown = true;
            else if (lastCmd.type === 'z-up' || lastCmd.type === 'hatch-up' ||
                lastCmd.type === 'homing-z') penIsDown = false;
        }
    }
    updateDigitalTwin();
    if (okCount >= commandMap.length) {
        stopSimulation();
        stopTwinAnimation();
        penIsDown = false;  // Stylo levé à la fin
        updatePenStateIndicator();
        changeState(SystemState.IDLE);
        showToast("✓ Tracé terminé !", "success");
        playBeep('ok');
    }
}

function updateDigitalTwin() {
    const total = commandMap.length;
    const progress = total > 0 ? (okCount / total) * 100 : 0;
    const bar = document.getElementById('progress-bar');
    bar.style.width = progress.toFixed(1) + '%';
    bar.classList.add('running-anim');

    const totalDraw = commandMap.filter(c => c.draws).length;
    const doneDraw = commandMap.slice(0, okCount).filter(c => c.draws).length;
    const elConfirm = document.getElementById('stat-confirmed-segs');
    if (elConfirm) elConfirm.innerText = `${doneDraw} / ${totalDraw}`;
    const elStatSegs = document.getElementById('plot-stat-segs');
    if (elStatSegs) elStatSegs.innerText = `${doneDraw} / ${totalDraw}`;

    if (plotStartTime && okCount > 3) {
        const elapsed = (Date.now() - plotStartTime) / 1000;
        const remaining = ((elapsed / okCount) * (total - okCount));
        const mins = Math.floor(remaining / 60);
        const secs = Math.floor(remaining % 60);
        const etaStr = `~${mins}m ${secs}s`;
        document.getElementById('stat-eta').innerText = etaStr;
        document.getElementById('stat-eta').classList.add('eta-running');
        const elStatEta = document.getElementById('plot-stat-eta');
        if (elStatEta) elStatEta.innerText = etaStr;
    }

    // Indicateur visuel stylo
    updatePenStateIndicator();
}

/**
 * Met à jour le badge indicateur de position du stylo (levé / baissé).
 * Visible uniquement pendant le tracé auto.
 */
function updatePenStateIndicator() {
    const badge = document.getElementById('pen-state-badge');
    if (!badge) return;
    if (penIsDown) {
        badge.className = 'pen-state-badge pen-down';
        badge.innerHTML = '<i class="fas fa-pen-nib"></i> Stylo <strong>BAISSÉ</strong>';
    } else {
        badge.className = 'pen-state-badge pen-up';
        badge.innerHTML = '<i class="fas fa-arrow-up"></i> Stylo <strong>LEVÉ</strong>';
    }
}

function getConfirmedSegments() {
    const segs = [];
    for (let i = 0; i < Math.min(okCount, commandMap.length); i++) {
        const cmd = commandMap[i];
        if (cmd.draws) segs.push({ polylineIdx: cmd.polylineIdx, fromIdx: cmd.pointIdx - 1, toIdx: cmd.pointIdx });
    }
    return segs;
}

function startTwinAnimation() {
    stopTwinAnimation();
    function loop() {
        if (currentState === SystemState.RUNNING) {
            drawPreviewCanvas();
            animFrameId = requestAnimationFrame(loop);
        }
    }
    animFrameId = requestAnimationFrame(loop);
}

function stopTwinAnimation() {
    if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
}

function startSimulation() {
    stopSimulation();
    const s = loadSettings();
    // Vitesse simulation : proportionnel à la vitesse de tracé (50ms par défaut)
    const msPerCmd = Math.max(20, Math.min(200, Math.round(1000 / (s.vdraw || 40))));
    simulationTimer = setInterval(() => {
        if (okCount >= commandMap.length || currentState !== SystemState.RUNNING) {
            stopSimulation(); return;
        }
        onOkReceived();
    }, msPerCmd);
}

function stopSimulation() {
    if (simulationTimer) { clearInterval(simulationTimer); simulationTimer = null; }
}

function startPlotting(simulate = false) {
    if (!isConnected && !simulate) { showToast('Non connecté à la carte.', 'error'); return; }
    if (totalSegments === 0) { showToast('Aucun SVG chargé.', 'error'); return; }

    // Vérification hors-limites physiques
    const s = loadSettings();
    const rotRad = rotationAngle * Math.PI / 180;
    const cosR = Math.cos(rotRad), sinR = Math.sin(rotRad);
    let outOfBounds = false;
    svgPolylines.forEach(poly => {
        poly.forEach(pt => {
            const rx = cosR * pt.x - sinR * pt.y;
            const ry = sinR * pt.x + cosR * pt.y;
            const mx = (rx * scaleFactor + offsetX) * s.calib;
            const my = (ry * scaleFactor + offsetY) * s.calib;
            if (mx < 0 || mx > s.xmax || my < 0 || my > s.ymax) outOfBounds = true;
        });
    });

    if (outOfBounds) {
        pendingPlotSimulate = simulate;
        document.getElementById('modal-overflow-confirm').classList.remove('hidden');
        return;
    }
    _executePlotting(simulate);
}

function _executePlotting(simulate = false) {
    changeState(SystemState.RUNNING);
    commandMap = [];
    okCount = 0;
    penIsDown = false;     // Réinitialise l'état logique du stylo
    plotStartTime = Date.now();

    const s = loadSettings();
    const rotRad = rotationAngle * Math.PI / 180;
    const cosR = Math.cos(rotRad), sinR = Math.sin(rotRad);
    let curX = 0, curY = 0, curZ = 0;

    const addCmd = (cmd, meta) => {
        commandMap.push(meta);
        if (!simulate) queueCommand(cmd);
    };

    // Helper : transforme un point SVG → coordonnées machine
    // NOTE : l'axe X de la machine est physiquement inversé par rapport à SVG
    // (après homing, X croît vers la gauche côté machine).
    // On corrige par symétrie autour de la largeur de l'espace de travail.
    const transform = (pt) => {
        const rx = cosR * pt.x - sinR * pt.y;
        const ry = sinR * pt.x + cosR * pt.y;
        return {
            x: (s.xmax - (rx * scaleFactor + offsetX)) * s.calib,
            y: (ry * scaleFactor + offsetY) * s.calib
        };
    };

    // ── Garde-fous stylo ─────────────────────────────────────────────────
    // penLogicalDown suit l'état LOGIQUE (pas le float curZ) pour éviter
    // tout double-down ou double-up consécutif, quelles que soient les
    // valeurs de zup/zdown ou les erreurs d'arrondi flottant.
    let penLogicalDown = false;  // stylo levé après homing Z

    // Vitesse minimale firmware = 150 RPM — on clamp pour éviter que
    // la carte ignore silencieusement nos vitesses trop basses.
    const vfast = Math.max(s.vfast, 150);
    const vdraw = Math.max(s.vdraw, 150);

    const penDown = (meta) => {
        if (penLogicalDown) return;  // GARDE-FOU : déjà baissé → on ignore
        const dz = s.zdown - curZ;
        if (Math.abs(dz) < 0.005) { penLogicalDown = true; return; } // delta nul
        addCmd(`z${dz.toFixed(2)}v${vfast}`, { ...meta, type: 'z-down', draws: false });
        curZ = s.zdown;
        penLogicalDown = true;
    };

    const penUp = (meta) => {
        if (!penLogicalDown) return;  // GARDE-FOU : déjà levé → on ignore
        const dz = s.zup - curZ;
        if (Math.abs(dz) < 0.005) { penLogicalDown = false; return; } // delta nul
        addCmd(`z${dz.toFixed(2)}v${vfast}`, { ...meta, type: 'z-up', draws: false });
        curZ = s.zup;
        penLogicalDown = false;
    };
    // ─────────────────────────────────────────────────────────────────────

    // Homing complet avant tout tracé : Z puis XY
    addCmd('k', { type: 'homing-z', draws: false });   // Homing Z  → stepsZ=0 (origine haute)
    addCmd('i', { type: 'homing-xy', draws: false });   // Homing XY → curX=0, curY=0
    // Après k, le stylo est physiquement à l'origine Z (stepsZ=0 sur l'Arduino).
    // curZ doit refléter cette position PHYSIQUE (0), PAS la valeur zup de l'utilisateur.
    // Les deltas de penDown/penUp seront calculés correctement :
    //   penDown: dz = s.zdown - 0 = +zdown (descente)
    //   penUp:   dz = s.zup   - s.zdown = négatif (remontée)
    curX = 0; curY = 0; curZ = 0;
    penLogicalDown = false;


    svgPolylines.forEach((poly, polyIdx) => {
        // Déplacement XY rapide vers le début de la polyline (stylo levé)
        const p0 = transform(poly[0]);
        const dx = p0.x - curX, dy = p0.y - curY;
        // Garde-fou : ne PAS envoyer si les deux deltas arrondis à 0.01mm sont nuls
        // (le firmware renvoie ERR si dx=0 ET dy=0, ce qui bloque la file)
        if (Math.abs(dx) >= 0.005 || Math.abs(dy) >= 0.005) {
            addCmd(`x${dx.toFixed(2)}y${dy.toFixed(2)}v${vfast}`,
                { type: 'travel', draws: false, polylineIdx: polyIdx });
            curX = p0.x; curY = p0.y;
        }

        // Descente du stylo (garde-fou inclus)
        penDown({ polylineIdx: polyIdx });

        for (let i = 1; i < poly.length; i++) {
            const p = transform(poly[i]);
            const ddx = p.x - curX, ddy = p.y - curY;
            // Garde-fou : sauter les segments nuls (évite ERR firmware)
            if (Math.abs(ddx) < 0.005 && Math.abs(ddy) < 0.005) continue;
            addCmd(`x${ddx.toFixed(2)}y${ddy.toFixed(2)}v${vdraw}`,
                { type: 'draw', draws: true, polylineIdx: polyIdx, pointIdx: i });
            curX = p.x; curY = p.y;
        }

        // Montée du stylo (garde-fou inclus)
        penUp({ polylineIdx: polyIdx });
    });

    // Hachures de remplissage (APRÈS tous les contours)
    hatchPolylines.forEach((poly, hIdx) => {
        if (poly.length < 2) return;
        const p0h = transform(poly[0]);
        const dxh = p0h.x - curX, dyh = p0h.y - curY;
        if (Math.abs(dxh) >= 0.005 || Math.abs(dyh) >= 0.005) {
            addCmd(`x${dxh.toFixed(2)}y${dyh.toFixed(2)}v${vfast}`,
                { type: 'hatch-travel', draws: false });
            curX = p0h.x; curY = p0h.y;
        }

        // Descente du stylo (garde-fou inclus)
        penDown({ polylineIdx: -1 });

        for (let i = 1; i < poly.length; i++) {
            const p = transform(poly[i]);
            const hddx = p.x - curX, hddy = p.y - curY;
            if (Math.abs(hddx) < 0.005 && Math.abs(hddy) < 0.005) continue;
            addCmd(`x${hddx.toFixed(2)}y${hddy.toFixed(2)}v${vdraw}`,
                { type: 'hatch-draw', draws: true, polylineIdx: -1, pointIdx: i });
            curX = p.x; curY = p.y;
        }

        // Montée du stylo (garde-fou inclus)
        penUp({ polylineIdx: -1 });
    });

    document.getElementById('progress-bar').style.width = '0%';
    updateDigitalTwin();
    startTwinAnimation();
    if (simulate) {
        showToast('Simulation démarrée !', 'info');
        startSimulation();
    }
}

// ==========================================
// 8. CONSOLE ET UTILITAIRES
// ==========================================
function logConsole(type, msg) {
    const out = document.getElementById('console-output');
    const ts = new Date().toISOString().substring(11, 23); // hh:mm:ss.ms
    const div = document.createElement('div');
    const prefix = type === 'tx' ? '➤' : type === 'rx' ? '◁' : '❗';
    div.innerHTML = `<span class="text-muted">[${ts}]</span> <span class="${type}">${prefix} ${msg}</span>`;

    const filter = document.querySelector('input[name="c-filter"]:checked').value;
    if (filter !== 'all' && filter !== type) {
        div.style.display = 'none';
    }

    out.appendChild(div);
    out.scrollTop = out.scrollHeight;
}

function clearConsole() {
    document.getElementById('console-output').innerHTML = '';
}

function initKeyboardShortcuts() {
    window.addEventListener('keydown', (e) => {
        if (e.shiftKey) {
            switch (e.key.toLowerCase()) {
                case 's': e.preventDefault(); triggerEStop(); break;
                case 'u': e.preventDefault(); toggleConnection(); break;
                case 'h': e.preventDefault(); if (isConnected) queueCommand('i'); break;
                case 'c': e.preventDefault(); document.getElementById('nav-home').click(); break;
                case 'o': e.preventDefault(); document.getElementById('nav-command').click(); break;
                case 't': e.preventDefault(); if (!document.getElementById('btn-start-auto').disabled) startPlotting(); break;
            }
        }
    });

    document.querySelectorAll('input[name="c-filter"]').forEach(r => {
        r.addEventListener('change', () => {
            const val = r.value;
            const lines = document.getElementById('console-output').children;
            for (let l of lines) {
                if (val === 'all') l.style.display = '';
                else {
                    if (l.innerHTML.includes(`class="${val}"`)) l.style.display = '';
                    else l.style.display = 'none';
                }
            }
        });
    });
}

// ==========================================
// 11. PRÉVISUALISATION MODALE (ZOOM)
// ==========================================

let _modalZoom = 1, _modalPanX = 0, _modalPanY = 0, _modalDrag = null;

function openPreviewModal() {
    const modal = document.getElementById('modal-preview');
    if (!modal) return;
    modal.classList.remove('hidden');
    _modalZoom = 1; _modalPanX = 0; _modalPanY = 0;
    syncPreviewModal();
    _initModalCanvasEvents();
}

function closePreviewModal() {
    const modal = document.getElementById('modal-preview');
    if (modal) modal.classList.add('hidden');
}

function syncPreviewModal() {
    const dst = document.getElementById('modal-canvas');
    if (!dst) return;

    // Utiliser devicePixelRatio pour la résolution
    const dpr = window.devicePixelRatio || 1;
    const cssW = dst.clientWidth || 800;
    const cssH = dst.clientHeight || 800;
    const physW = Math.round(cssW * dpr);
    const physH = Math.round(cssH * dpr);

    if (dst.width !== physW || dst.height !== physH) {
        dst.width = physW;
        dst.height = physH;
    }

    const ctx = dst.getContext('2d');
    ctx.clearRect(0, 0, physW, physH);

    ctx.save();

    // Taille logique de base du workspace
    const srcCanvas = document.getElementById('preview-canvas');
    const baseW = srcCanvas ? srcCanvas.width : 400 * dpr;
    const baseH = srcCanvas ? srcCanvas.height : 400 * dpr;

    // On applique le pan (glissement)
    ctx.translate(physW / 2 + _modalPanX * dpr, physH / 2 + _modalPanY * dpr);

    // On applique le zoom
    ctx.scale(_modalZoom, _modalZoom);

    // On centre la zone de dessin
    ctx.translate(-baseW / 2, -baseH / 2);

    // On compense l'épaisseur des traits pour qu'ils restent fins lors du zoom
    const originalLineWidth = ctx.lineWidth;

    // Rendu vectoriel parfait
    if (typeof _renderPreviewToContext === 'function') {
        // Redéfinir temporairement strokeRect, moveTo, lineTo etc si on voulait une épaisseur constante ?
        // ctx.scale() est la méthode la plus rapide.
        _renderPreviewToContext(ctx, baseW, baseH, _modalZoom);

        if (window._drawHandleOverlay && showTransformHandles) {
            window._drawHandleOverlay(ctx, baseW, baseH);
        }
    }

    ctx.restore();
}

function _initModalCanvasEvents() {
    const c = document.getElementById('modal-canvas');
    if (!c || c._modalEventsInit) return;
    c._modalEventsInit = true;

    // Zoom molette
    c.addEventListener('wheel', (e) => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
        _modalZoom = Math.max(0.3, Math.min(20, _modalZoom * factor));
        syncPreviewModal();
    }, { passive: false });

    // Pan (glisser)
    let pd = null;
    c.addEventListener('mousedown', (e) => {
        pd = { x: e.clientX - _modalPanX, y: e.clientY - _modalPanY };
    });
    window.addEventListener('mousemove', (e) => {
        if (!pd) return;
        if (document.getElementById('modal-preview').classList.contains('hidden')) { pd = null; return; }
        _modalPanX = e.clientX - pd.x;
        _modalPanY = e.clientY - pd.y;
        syncPreviewModal();
    });
    window.addEventListener('mouseup', () => { pd = null; });
}


