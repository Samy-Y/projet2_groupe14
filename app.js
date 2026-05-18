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

// Jumeau Numérique (Digital Twin)
let commandMap = [];      // Entrée par commande : { type, draws, polylineIdx, pointIdx }
let okCount = 0;          // Nb de OK reçus depuis début du tracé
let plotStartTime = null; // Timestamp démarrage tracé
let simulationTimer = null; // Timer simulation
let animFrameId = null;   // ID requestAnimationFrame (tête pulsante)

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
    document.getElementById('btn-start-auto').addEventListener('click', () => startPlotting(false));
    document.getElementById('btn-simulate').addEventListener('click', () => startPlotting(true));
    
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
        let ztarget = loadSettings().zup;
        let dz = ztarget - currentMachineZ;
        if(Math.abs(dz) > 0.01) queueCommand(`z${dz.toFixed(2)}v${loadSettings().vfast}`);
        isZUp = true;
        queueCommand('s');
    });
    document.getElementById('btn-z-down').addEventListener('click', () => {
        let ztarget = loadSettings().zdown;
        let dz = ztarget - currentMachineZ;
        if(Math.abs(dz) > 0.01) queueCommand(`z${dz.toFixed(2)}v${loadSettings().vfast}`);
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
            let rpm = loadSettings().vfast;
            queueCommand(`z${val}v${rpm}`);
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

let currentMachineX = 0;
let currentMachineY = 0;
let currentMachineZ = 0;
let pendingAbsoluteMove = null;

function handleHardwareResponse(line) {
    logConsole('rx', line);
    
    if(line.startsWith(">> X=")) {
        // Ex: >> X=10.00mm Y=20.00mm Z=0.00mm  [0-400 / 0-100mm]
        const match = line.match(/X=([\d.-]+)mm\s+Y=([\d.-]+)mm\s+Z=([\d.-]+)mm/);
        if(match) {
            currentMachineX = parseFloat(match[1]);
            currentMachineY = parseFloat(match[2]);
            currentMachineZ = parseFloat(match[3]);
            
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

    if(line === "OK") {
        waitingForOk = false;
        if(currentState === SystemState.RUNNING && commandMap.length > 0) {
            onOkReceived();
        }
        processQueue();
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
        currentState === 'ERROR'   ? '#c65050' : 
        currentState === 'RUNNING' ? '#2e8b57' : 
        currentState === 'HOMING'  ? '#0056b3' : '#eee';
    badge.style.color = currentState === 'IDLE' ? '#333' : '#fff';
    
    // Réinitialise le jumeau si on revient à IDLE/ERROR
    if(newState !== SystemState.RUNNING) {
        stopTwinAnimation();
        document.getElementById('stat-eta').classList.remove('eta-running');
        document.getElementById('progress-bar').classList.remove('running-anim');
        if(newState === SystemState.IDLE) {
            // Redessine en mode normal après fin du tracé
            setTimeout(drawPreviewCanvas, 50);
        }
    }
    updateUIState();
}

function triggerEStop(reason = "Manuel") {
    txQueue = []; // Purge
    waitingForOk = false;
    stopSimulation();
    stopTwinAnimation();
    sendData('a'); // Arduino stop char
    changeState(SystemState.ERROR);
    playBeep('error');
    showToast(`ARRÊT D'URGENCE (${reason})`, "error");
}

function updateUIState() {
    const isReady = isConnected && currentState !== 'ERROR';
    const hasSvgReady = totalSegments > 0 && checklistDone;
    const isRunning = currentState === SystemState.RUNNING;
    
    document.querySelectorAll('.btn-jog').forEach(b => b.disabled = !isReady || isRunning);
    document.getElementById('btn-homing').disabled = !isReady || isRunning;
    
    document.getElementById('btn-start-auto').disabled = !(isReady && hasSvgReady && currentState === 'IDLE');
    
    // Bouton simulation : actif si SVG chargé et pas déjà en cours
    const btnSim = document.getElementById('btn-simulate');
    if(btnSim) btnSim.disabled = !(totalSegments > 0 && !isRunning);
    
    // Affichage de la barre de statut du tracé
    const statusBar = document.getElementById('plot-status-bar');
    if(statusBar) statusBar.classList.toggle('hidden', !isRunning);
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
    const s = loadSettings();
    canvas.width = 400; canvas.height = 400;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Papier
    const pwPx = (paperW / s.xmax) * canvas.width;
    const phPx = (paperH / s.ymax) * canvas.height;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, pwPx, phPx);
    ctx.strokeStyle = '#cccccc';
    ctx.lineWidth = 1;
    ctx.strokeRect(0, 0, pwPx, phPx);

    const toCanvas = (x, y) => ({
        cx: ((x * scaleFactor + offsetX) / s.xmax) * canvas.width,
        cy: ((y * scaleFactor + offsetY) / s.ymax) * canvas.height
    });

    const isRunning = currentState === SystemState.RUNNING && commandMap.length > 0;
    let isOutOfBounds = false;

    // Vérification hors-limites (toujours)
    svgPolylines.forEach(poly => {
        poly.forEach(pt => {
            const x = pt.x * scaleFactor + offsetX;
            const y = pt.y * scaleFactor + offsetY;
            if(x < 0 || x > paperW || y < 0 || y > paperH) isOutOfBounds = true;
        });
    });

    if(!isRunning) {
        // === MODE NORMAL : tracé plein bleu ===
        ctx.strokeStyle = '#0056b3';
        ctx.lineWidth = 1;
        let lastPenX = 0, lastPenY = 0;
        let totalDrawDist = 0, totalTravelDist = 0;

        svgPolylines.forEach(poly => {
            ctx.beginPath();
            for(let i = 0; i < poly.length; i++) {
                const x = poly[i].x * scaleFactor + offsetX;
                const y = poly[i].y * scaleFactor + offsetY;
                const { cx, cy } = toCanvas(poly[i].x, poly[i].y);
                if(i === 0) {
                    ctx.moveTo(cx, cy);
                    totalTravelDist += Math.hypot(x - lastPenX, y - lastPenY);
                } else {
                    ctx.lineTo(cx, cy);
                    totalDrawDist += Math.hypot(x - lastPenX, y - lastPenY);
                }
                lastPenX = x; lastPenY = y;
            }
            ctx.stroke();
        });

        // ETA statique
        const speedDraw = s.vdraw * 40, speedTravel = s.vfast * 40;
        if(speedDraw > 0 && speedTravel > 0) {
            const zTime = svgPolylines.length * 2 * (10 / (s.vfast * 40)) * 60;
            const t = (totalDrawDist / speedDraw) * 60 + (totalTravelDist / speedTravel) * 60 + zTime;
            document.getElementById('stat-eta').innerText = `~${Math.floor(t/60)}m ${Math.floor(t%60)}s`;
            document.getElementById('stat-eta').classList.remove('eta-running');
        } else {
            document.getElementById('stat-eta').innerText = '--:--';
        }
    } else {
        // === MODE JUMEAU NUMÉRIQUE ===

        // Passe 1 : Fantôme (tout le tracé, translucide)
        ctx.strokeStyle = 'rgba(0, 86, 179, 0.15)';
        ctx.lineWidth = 1.5;
        svgPolylines.forEach(poly => {
            ctx.beginPath();
            for(let i = 0; i < poly.length; i++) {
                const { cx, cy } = toCanvas(poly[i].x, poly[i].y);
                if(i === 0) ctx.moveTo(cx, cy); else ctx.lineTo(cx, cy);
            }
            ctx.stroke();
        });

        // Passe 2 : Segments confirmés (vert vif)
        ctx.strokeStyle = '#27ae60';
        ctx.lineWidth = 2;
        ctx.shadowColor = '#2ecc71';
        ctx.shadowBlur = 5;

        const confirmedSegs = getConfirmedSegments();
        confirmedSegs.forEach(seg => {
            const poly = svgPolylines[seg.polylineIdx];
            if(!poly) return;
            const from = poly[seg.fromIdx], to = poly[seg.toIdx];
            if(!from || !to) return;
            const f = toCanvas(from.x, from.y);
            const t = toCanvas(to.x, to.y);
            ctx.beginPath();
            ctx.moveTo(f.cx, f.cy);
            ctx.lineTo(t.cx, t.cy);
            ctx.stroke();
        });
        ctx.shadowBlur = 0;

        // Tête courante (cercle pulsant)
        let lastDrawCmd = null;
        for(let i = Math.min(okCount, commandMap.length) - 1; i >= 0; i--) {
            if(commandMap[i].draws) { lastDrawCmd = commandMap[i]; break; }
        }
        if(lastDrawCmd) {
            const poly = svgPolylines[lastDrawCmd.polylineIdx];
            const pt = poly && poly[lastDrawCmd.pointIdx];
            if(pt) {
                const { cx, cy } = toCanvas(pt.x, pt.y);
                const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 180);
                const r = 4 + pulse * 3;
                ctx.beginPath();
                ctx.arc(cx, cy, r, 0, Math.PI * 2);
                ctx.fillStyle = `rgba(231, 76, 60, ${0.6 + pulse * 0.4})`;
                ctx.shadowColor = '#e74c3c';
                ctx.shadowBlur = 12;
                ctx.fill();
                ctx.shadowBlur = 0;
            }
        }
    }

    // Bordure canvas
    const wrapper = document.getElementById('preview-wrapper');
    if(isOutOfBounds && svgPolylines.length > 0) {
        wrapper.style.borderColor = '#e74c3c';
        wrapper.style.boxShadow = '0 0 12px rgba(231,76,60,0.6)';
    } else if(isRunning) {
        wrapper.style.borderColor = '#27ae60';
        wrapper.style.boxShadow = '0 0 14px rgba(39,174,96,0.5)';
    } else {
        wrapper.style.borderColor = '#ccc';
        wrapper.style.boxShadow = 'none';
    }
}

// ==========================================
// 9. JUMEAU NUMÉRIQUE
// ==========================================

function onOkReceived() {
    okCount++;
    updateDigitalTwin();
    if(okCount >= commandMap.length) {
        stopSimulation();
        stopTwinAnimation();
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
    const doneDraw  = commandMap.slice(0, okCount).filter(c => c.draws).length;
    const elConfirm = document.getElementById('stat-confirmed-segs');
    if(elConfirm) elConfirm.innerText = `${doneDraw} / ${totalDraw}`;
    const elStatSegs = document.getElementById('plot-stat-segs');
    if(elStatSegs) elStatSegs.innerText = `${doneDraw} / ${totalDraw}`;

    if(plotStartTime && okCount > 3) {
        const elapsed  = (Date.now() - plotStartTime) / 1000;
        const remaining = ((elapsed / okCount) * (total - okCount));
        const mins = Math.floor(remaining / 60);
        const secs = Math.floor(remaining % 60);
        const etaStr = `~${mins}m ${secs}s`;
        document.getElementById('stat-eta').innerText = etaStr;
        document.getElementById('stat-eta').classList.add('eta-running');
        const elStatEta = document.getElementById('plot-stat-eta');
        if(elStatEta) elStatEta.innerText = etaStr;
    }
}

function getConfirmedSegments() {
    const segs = [];
    for(let i = 0; i < Math.min(okCount, commandMap.length); i++) {
        const cmd = commandMap[i];
        if(cmd.draws) segs.push({ polylineIdx: cmd.polylineIdx, fromIdx: cmd.pointIdx - 1, toIdx: cmd.pointIdx });
    }
    return segs;
}

function startTwinAnimation() {
    stopTwinAnimation();
    function loop() {
        if(currentState === SystemState.RUNNING) {
            drawPreviewCanvas();
            animFrameId = requestAnimationFrame(loop);
        }
    }
    animFrameId = requestAnimationFrame(loop);
}

function stopTwinAnimation() {
    if(animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
}

function startSimulation() {
    stopSimulation();
    const s = loadSettings();
    // Vitesse simulation : proportionnel à la vitesse de tracé (50ms par défaut)
    const msPerCmd = Math.max(20, Math.min(200, Math.round(1000 / (s.vdraw || 40))));
    simulationTimer = setInterval(() => {
        if(okCount >= commandMap.length || currentState !== SystemState.RUNNING) {
            stopSimulation(); return;
        }
        onOkReceived();
    }, msPerCmd);
}

function stopSimulation() {
    if(simulationTimer) { clearInterval(simulationTimer); simulationTimer = null; }
}

function startPlotting(simulate = false) {
    if(!isConnected && !simulate) { showToast("Non connecté à la carte.", "error"); return; }
    if(totalSegments === 0) { showToast("Aucun SVG chargé.", "error"); return; }

    changeState(SystemState.RUNNING);
    commandMap = [];
    okCount = 0;
    plotStartTime = Date.now();

    const s = loadSettings();
    let curX = 0, curY = 0;

    const addCmd = (cmd, meta) => {
        commandMap.push(meta);
        if(!simulate) queueCommand(cmd);
    };

    addCmd('i', { type: 'homing', draws: false });
    addCmd(`z${s.zup}v${s.vfast}`, { type: 'z-up', draws: false });

    svgPolylines.forEach((poly, polyIdx) => {
        let startX = (poly[0].x * scaleFactor + offsetX) * s.calib;
        let startY = (poly[0].y * scaleFactor + offsetY) * s.calib;
        let dx = startX - curX, dy = startY - curY;

        if(dx !== 0 || dy !== 0) {
            addCmd(`x${dx.toFixed(2)}y${dy.toFixed(2)}v${s.vfast}`,
                { type: 'travel', draws: false, polylineIdx: polyIdx });
            curX = startX; curY = startY;
        }

        addCmd(`z-${s.zup}v${s.vfast}`, { type: 'z-down', draws: false, polylineIdx: polyIdx });

        for(let i = 1; i < poly.length; i++) {
            let nextX = (poly[i].x * scaleFactor + offsetX) * s.calib;
            let nextY = (poly[i].y * scaleFactor + offsetY) * s.calib;
            addCmd(`x${(nextX-curX).toFixed(2)}y${(nextY-curY).toFixed(2)}v${s.vdraw}`,
                { type: 'draw', draws: true, polylineIdx: polyIdx, pointIdx: i });
            curX = nextX; curY = nextY;
        }

        addCmd(`z${s.zup}v${s.vfast}`, { type: 'z-up', draws: false, polylineIdx: polyIdx });
    });

    document.getElementById('progress-bar').style.width = '0%';
    updateDigitalTwin();
    startTwinAnimation();
    if(simulate) {
        showToast("Simulation démarrée !", "info");
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
