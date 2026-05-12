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

// Télémétrie
let isPaperConfigured = false;
let checklistDone = false;

// Géométrie
let svgPolylines = []; 
let scaleFactor = 1;
let offsetX = 0;
let offsetY = 0;
let totalSegments = 0;
let paperW = 210, paperH = 297;

// Worker
let worker = null;
let currentSvgContent = null; 

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
    initWebWorker();
    
    // Binding des boutons
    document.getElementById('btn-connect').addEventListener('click', toggleConnection);
    document.getElementById('btn-estop').addEventListener('click', triggerEStop);
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
    document.getElementById('chordal-error').addEventListener('change', reparseSVG);
    document.getElementById('btn-start-auto').addEventListener('click', startPlotting);
    
    // Placement Controls
    document.getElementById('paper-format').addEventListener('change', handlePaperChange);
    document.getElementById('scale-slider').addEventListener('input', (e) => {
        scaleFactor = e.target.value / 100;
        document.getElementById('scale-val').innerText = e.target.value + '%';
        drawPreviewCanvas();
    });
    document.getElementById('offset-x').addEventListener('input', (e) => { offsetX = parseFloat(e.target.value) || 0; drawPreviewCanvas(); });
    document.getElementById('offset-y').addEventListener('input', (e) => { offsetY = parseFloat(e.target.value) || 0; drawPreviewCanvas(); });

    // Drag Canvas
    initCanvasDrag();

    // Manual
    document.getElementById('btn-homing').addEventListener('click', () => queueCommand('i'));
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
    let isZUp = true;
    document.getElementById('btn-z-up').addEventListener('click', () => {
        let dz = isZUp ? 0 : loadSettings().zup;
        if(dz !== 0) queueCommand(`z${dz}v${loadSettings().vfast}`);
        isZUp = true;
    });
    document.getElementById('btn-z-down').addEventListener('click', () => {
        let dz = isZUp ? -loadSettings().zup : 0;
        if(dz !== 0) queueCommand(`z${dz}v${loadSettings().vfast}`);
        isZUp = false;
    });

    updateUIState();
});

function initNavigation() {
    const navBtns = document.querySelectorAll('.nav-btn');
    const views = document.querySelectorAll('.view');
    navBtns.forEach(btn => {
        if(btn.id === 'nav-settings') return; // Settings is a modal
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

function initCanvasDrag() {
    const canvas = document.getElementById('preview-canvas');
    let isDragging = false;
    let startMouseX = 0, startMouseY = 0;
    let startOffsetX = 0, startOffsetY = 0;

    canvas.style.cursor = 'grab';

    canvas.addEventListener('mousedown', (e) => {
        if(svgPolylines.length === 0) return;
        isDragging = true;
        canvas.style.cursor = 'grabbing';
        let rect = canvas.getBoundingClientRect();
        startMouseX = e.clientX - rect.left;
        startMouseY = e.clientY - rect.top;
        startOffsetX = offsetX;
        startOffsetY = offsetY;
    });

    window.addEventListener('mousemove', (e) => {
        if(!isDragging) return;
        let rect = canvas.getBoundingClientRect();
        let currentMouseX = e.clientX - rect.left;
        let currentMouseY = e.clientY - rect.top;

        let s = loadSettings();
        // Ratio pixel / mm physique
        let mmPerPxX = s.xmax / canvas.width;
        let mmPerPxY = s.ymax / canvas.height;

        let deltaX = (currentMouseX - startMouseX) * mmPerPxX;
        let deltaY = (currentMouseY - startMouseY) * mmPerPxY;

        offsetX = startOffsetX + deltaX;
        offsetY = startOffsetY + deltaY;

        document.getElementById('offset-x').value = offsetX.toFixed(1);
        document.getElementById('offset-y').value = offsetY.toFixed(1);

        drawPreviewCanvas();
    });

    window.addEventListener('mouseup', () => {
        isDragging = false;
        canvas.style.cursor = 'grab';
    });
}

// ==========================================
// 3. PERSISTANCE (LOCAL STORAGE)
// ==========================================

function loadSettings() {
    const def = { xmax: 400, ymax: 400, zmax: 100, vfast: 100, vdraw: 40, zup: 5, zdown: 0, calib: 1.0 };
    const saved = localStorage.getItem('systemSettings');
    return saved ? {...def, ...JSON.parse(saved)} : def;
}

function initSettingsOverrides() {
    const s = loadSettings();
    document.getElementById('cfg-xmax').value = s.xmax;
    document.getElementById('cfg-ymax').value = s.ymax;
    document.getElementById('cfg-zmax').value = s.zmax;
    document.getElementById('cfg-vfast').value = s.vfast;
    document.getElementById('cfg-vdraw').value = s.vdraw;
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
        if(navigator.onLine) {
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

function showToast(msg, type="info") {
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
    if(audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    
    if(type === 'error') {
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
    if(!isConnected) {
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
            document.getElementById('btn-connect').innerHTML = '<i class="fas fa-plug"></i> Déconnecter';
            
            showToast("Connecté à la carte !", "success");
            changeState(SystemState.IDLE);
        } catch(e) {
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
    if(serialReader) { await serialReader.cancel(); }
    if(serialWriter) { await serialWriter.close(); }
    if(serialPort) { await serialPort.close(); serialPort = null; }
    
    document.getElementById('connection-status').innerText = 'Déconnecté';
    document.getElementById('connection-status').classList.add('disconnected');
    document.getElementById('connection-status').classList.remove('connected');
    document.getElementById('btn-connect').innerHTML = '<i class="fas fa-plug"></i> Connecter <u>U</u>SB';
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
                    if(line.length > 0) handleHardwareResponse(line);
                });
            }
        }
    } catch (e) {
        console.error(e);
    } finally {
        serialReader.releaseLock();
    }
}

function handleHardwareResponse(line) {
    logConsole('rx', line);
    
    if(line === "OK") {
        waitingForOk = false;
        processQueue(); // Send next
    } else if (line.indexOf("LIMIT") === 0) {
        triggerEStop(line);
    } else if (line.indexOf("===") === 0) {
        document.getElementById('firmware-version').innerText = line;
    }
}

async function sendData(str) {
    if(!serialWriter) return;
    const data = new TextEncoder().encode(str + "\n");
    await serialWriter.write(data);
    logConsole('tx', str);
}

function queueCommand(cmd) {
    txQueue.push(cmd);
    processQueue();
}

function processQueue() {
    if(!isConnected) return;
    if(waitingForOk) return; // Wait for OK
    if(txQueue.length === 0) {
        if(currentState === SystemState.RUNNING) changeState(SystemState.IDLE);
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
    updateUIState();
}

function triggerEStop(reason = "Manuel") {
    txQueue = []; // Purge
    waitingForOk = false;
    sendData('a'); // Arduino stop char
    changeState(SystemState.ERROR);
    playBeep('error');
    showToast(`ARRÊT D'URGENCE (${reason})`, "error");
}

function updateUIState() {
    const isReady = isConnected && currentState !== 'ERROR';
    const hasSvgReady = totalSegments > 0 && checklistDone;
    
    document.querySelectorAll('.btn-jog').forEach(b => b.disabled = !isReady);
    document.getElementById('btn-homing').disabled = !isReady;
    
    document.getElementById('btn-start-auto').disabled = !(isReady && hasSvgReady && currentState === 'IDLE');
}

// ==========================================
// 7. TRAITEMENT SVG ET TRACÉ (WORKER)
// ==========================================

function initWebWorker() {
    try {
        worker = new Worker('worker.js');
        worker.onmessage = function(e) {
            if(e.data.type === 'progress') {
                // Optionnel: feedback progress
            } else if (e.data.type === 'done') {
                svgPolylines = e.data.polylines;
                totalSegments = e.data.segments;
                document.getElementById('stat-segments').innerText = totalSegments;
                if(totalSegments > 10000) document.getElementById('warning-segments').classList.remove('hidden');
                else document.getElementById('warning-segments').classList.add('hidden');
                
                drawPreviewCanvas();
                showToast("SVG traité avec succès.", "success");
                updateUIState();
            }
        };
        worker.onerror = function(e) {
            console.error("Worker initialisation error:", e);
            showToast("Le traitement avancé (Worker) nécessite un serveur local.", "warning");
        }
    } catch (err) {
        console.error("Worker catch exception:", err);
        showToast("Erreur démarrage Worker (lancez via Live Server).", "warning");
    }
}

function reparseSVG() {
    if(!currentSvgContent) return;
    const chordal = parseFloat(document.getElementById('chordal-error').value);
    const invertY = document.getElementById('invert-y').checked;
    worker.postMessage({
        type: 'parse',
        svgContent: currentSvgContent,
        chordalError: chordal,
        invertY: invertY
    });
}

function handleSvgUpload(e) {
    const file = e.target.files[0];
    if(!file) return;
    document.getElementById('file-name').innerText = file.name;
    
    const reader = new FileReader();
    reader.onload = function(evt) {
        currentSvgContent = evt.target.result;
        reparseSVG();
    };
    reader.readAsText(file);
}

function handlePaperChange(e) {
    const v = e.target.value;
    if(v === 'A4-P') { paperW = 210; paperH = 297; }
    else if(v === 'A4-L') { paperW = 297; paperH = 210; }
    else if(v === 'A3-P') { paperW = 297; paperH = 400; /* max y */ }
    else if(v === 'CUSTOM') { paperW = loadSettings().xmax; paperH = loadSettings().ymax; }
    drawPreviewCanvas();
}

function drawPreviewCanvas() {
    const canvas = document.getElementById('preview-canvas');
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0,0,canvas.width, canvas.height);
    
    const s = loadSettings();
    canvas.width = 400; canvas.height = 400; // Ref frame

    // Dessin du papier (centré ou aligné en bas à gauche de la zone 400x400 selon le besoin)
    // On dessine le papier en partant du coin haut gauche par defaut pour faire correspondre le canvas
    ctx.fillStyle = '#ffffff'; // Fond blanc du papier
    let pwPx = (paperW / s.xmax) * canvas.width;
    let phPx = (paperH / s.ymax) * canvas.height;
    ctx.fillRect(0, 0, pwPx, phPx);
    // Bord du papier
    ctx.strokeStyle = '#cccccc';
    ctx.strokeRect(0, 0, pwPx, phPx);

    ctx.strokeStyle = '#0056b3';
    ctx.lineWidth = 1;
    
    let isOutOfBounds = false;
    let totalDrawDistance = 0;
    let totalTravelDistance = 0;
    
    let lastPenX = 0, lastPenY = 0; // virtuel pour l'ETA

    svgPolylines.forEach(poly => {
        ctx.beginPath();
        for(let i=0; i<poly.length; i++) {
            let x = poly[i].x * scaleFactor + offsetX;
            let y = poly[i].y * scaleFactor + offsetY;
            
            if(x < 0 || x > paperW || y < 0 || y > paperH) isOutOfBounds = true;

            let cx = (x / s.xmax) * canvas.width;
            let cy = (y / s.ymax) * canvas.height;
            if(i===0) {
                ctx.moveTo(cx, cy);
                totalTravelDistance += Math.hypot(x - lastPenX, y - lastPenY);
            }
            else {
                ctx.lineTo(cx, cy);
                totalDrawDistance += Math.hypot(x - lastPenX, y - lastPenY);
            }
            lastPenX = x;
            lastPenY = y;
        }
        ctx.stroke();
    });

    const wrapper = document.getElementById('preview-wrapper');
    if(isOutOfBounds && svgPolylines.length > 0) {
        wrapper.style.borderColor = 'red';
        wrapper.style.boxShadow = '0 0 10px red';
    } else {
        wrapper.style.borderColor = '#ccc';
        wrapper.style.boxShadow = 'none';
    }
    
    // Calcul ETA (Heuristique basée sur la vitesse en mm/min via RPM et MM_PER_REV=40 du C++)
    // En réalité s.vdraw est un RPM. MM/min = RPM * 40.
    let speedDrawMmMin = s.vdraw * 40; 
    let speedTravelMmMin = s.vfast * 40;
    if(speedDrawMmMin > 0 && speedTravelMmMin > 0) {
        let maxZTime = svgPolylines.length * 2 * (10 / (s.vfast*40)) * 60; // Approximons 10mm voyage Z en secondes
        let timeSecs = (totalDrawDistance / speedDrawMmMin)*60 + (totalTravelDistance / speedTravelMmMin)*60 + maxZTime;
        let mins = Math.floor(timeSecs / 60);
        let secs = Math.floor(timeSecs % 60);
        document.getElementById('stat-eta').innerText = `~${mins}m ${secs}s`;
    } else {
        document.getElementById('stat-eta').innerText = "--:--";
    }
}

function startPlotting() {
    if(!isConnected) return;
    changeState(SystemState.RUNNING);
    
    const s = loadSettings();
    
    // Suivi de la position (Tête virtuelle)
    let curX = 0;
    let curY = 0;
    
    // Injection
    queueCommand('i'); // Homing initial (Ramène matériellement et virtuellement à 0,0)
    queueCommand(`z${s.zup}v${s.vfast}`); // Monte le stylo (Postulat: Z=0 après Homing Z, on monte).
    
    svgPolylines.forEach((poly, index) => {
        // Move to start of polyline
        let startX = (poly[0].x * scaleFactor + offsetX) * s.calib;
        let startY = (poly[0].y * scaleFactor + offsetY) * s.calib;
        
        // Calcul du Delta
        let dx = startX - curX;
        let dy = startY - curY;
        
        if (dx !== 0 || dy !== 0) {
            queueCommand(`x${dx.toFixed(2)}y${dy.toFixed(2)}v${s.vfast}`);
            curX = startX;
            curY = startY;
        }

        // Pen Down
        queueCommand(`z-${s.zup}v${s.vfast}`);
        
        // Draw
        for(let i=1; i<poly.length; i++) {
            let nextX = (poly[i].x * scaleFactor + offsetX) * s.calib;
            let nextY = (poly[i].y * scaleFactor + offsetY) * s.calib;
            
            let ddx = nextX - curX;
            let ddy = nextY - curY;
            
            queueCommand(`x${ddx.toFixed(2)}y${ddy.toFixed(2)}v${s.vdraw}`);
            curX = nextX;
            curY = nextY;
        }
        
        // Pen Up
        queueCommand(`z${s.zup}v${s.vfast}`);
    });
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
    if(filter !== 'all' && filter !== type) {
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
        if(e.shiftKey) {
            switch(e.key.toLowerCase()) {
                case 's': e.preventDefault(); triggerEStop(); break;
                case 'u': e.preventDefault(); toggleConnection(); break;
                case 'h': e.preventDefault(); if(isConnected) queueCommand('i'); break;
                case 'c': e.preventDefault(); document.getElementById('nav-home').click(); break;
                case 'o': e.preventDefault(); document.getElementById('nav-command').click(); break;
                case 't': e.preventDefault(); if(!document.getElementById('btn-start-auto').disabled) startPlotting(); break;
            }
        }
    });

    document.querySelectorAll('input[name="c-filter"]').forEach(r => {
        r.addEventListener('change', () => {
            const val = r.value;
            const lines = document.getElementById('console-output').children;
            for(let l of lines) {
                if(val === 'all') l.style.display = '';
                else {
                    if(l.innerHTML.includes(`class="${val}"`)) l.style.display = '';
                    else l.style.display = 'none';
                }
            }
        });
    });
}
