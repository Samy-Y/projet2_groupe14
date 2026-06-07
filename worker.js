// worker.js - Discrétisation SVG en Background (v3 — parser complet + hachures grayscale)

self.onmessage = function(e) {
    const { type, svgContent, chordalError, invertY, enableHatch, hatchSpacing, hatchType } = e.data;
    if (type === 'parse') {
        const ce = chordalError || 0.1;

        // 1. Chemins / contours
        const polylines = parseSVG(svgContent, invertY, ce);
        let segmentsCount = 0;
        polylines.forEach(p => segmentsCount += Math.max(0, p.length - 1));

        // 2. Hachures de remplissage (générées APRÈS les contours)
        let hatchPolylines = [];
        let hatchSegments = 0;
        if (enableHatch) {
            hatchPolylines = generateAllHatches(svgContent, invertY, hatchSpacing || 3, hatchType || 'hatch', ce);
            hatchPolylines.forEach(p => hatchSegments += Math.max(0, p.length - 1));
        }

        self.postMessage({
            type: 'done',
            polylines,
            segments: segmentsCount,
            hatchPolylines,
            hatchSegments
        });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// ENTRÉE PRINCIPALE — CONTOURS
// ─────────────────────────────────────────────────────────────────────────────
function parseSVG(svgString, invertY, chordalError) {
    let polylines = [];

    // ── 1. <path d="..."> ──────────────────────────────────────────────────
    const pathRe = /<path[^>]+>/gi;
    let pm;
    while ((pm = pathRe.exec(svgString)) !== null) {
        const tag = pm[0];
        const d = getAttr(tag, 'd');
        if (!d) continue;
        const subpaths = convertPathToPolylines(d, chordalError);
        for (const poly of subpaths) {
            if (poly.length > 1) polylines.push(poly);
        }
    }

    // ── 2. <line> ──────────────────────────────────────────────────────────
    const lineRe = /<line([^>]+)>/gi;
    let lm;
    while ((lm = lineRe.exec(svgString)) !== null) {
        const a = lm[1];
        const x1 = pf(getAttr(a, 'x1') || '0');
        const y1 = pf(getAttr(a, 'y1') || '0');
        const x2 = pf(getAttr(a, 'x2') || '0');
        const y2 = pf(getAttr(a, 'y2') || '0');
        polylines.push([{ x: x1, y: y1 }, { x: x2, y: y2 }]);
    }

    // ── 3. <rect> ──────────────────────────────────────────────────────────
    const rectRe = /<rect([^>]+)>/gi;
    let rm;
    while ((rm = rectRe.exec(svgString)) !== null) {
        const a = rm[1];
        const x = pf(getAttr(a, 'x') || '0');
        const y = pf(getAttr(a, 'y') || '0');
        const w = pf(getAttr(a, 'width') || '0');
        const h = pf(getAttr(a, 'height') || '0');
        if (w > 0 && h > 0) {
            polylines.push([
                { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }, { x, y }
            ]);
        }
    }

    // ── 4. <circle> ────────────────────────────────────────────────────────
    const circleRe = /<circle([^>]+)>/gi;
    let cm;
    while ((cm = circleRe.exec(svgString)) !== null) {
        const a = cm[1];
        const cx = pf(getAttr(a, 'cx') || '0');
        const cy = pf(getAttr(a, 'cy') || '0');
        const r  = pf(getAttr(a, 'r')  || '0');
        if (r > 0) polylines.push(discretizeArcFull(cx, cy, r, r, 0, chordalError));
    }

    // ── 5. <ellipse> ───────────────────────────────────────────────────────
    const ellipseRe = /<ellipse([^>]+)>/gi;
    let em;
    while ((em = ellipseRe.exec(svgString)) !== null) {
        const a = em[1];
        const cx = pf(getAttr(a, 'cx') || '0');
        const cy = pf(getAttr(a, 'cy') || '0');
        const rx = pf(getAttr(a, 'rx') || '0');
        const ry = pf(getAttr(a, 'ry') || '0');
        if (rx > 0 && ry > 0) polylines.push(discretizeArcFull(cx, cy, rx, ry, 0, chordalError));
    }

    // ── 6. <polygon> / <polyline> ──────────────────────────────────────────
    const polyRe = /<poly(?:gon|line)([^>]+)>/gi;
    let pp;
    while ((pp = polyRe.exec(svgString)) !== null) {
        const pts = parsePointList(getAttr(pp[1], 'points') || '');
        if (pp[0].toLowerCase().includes('polygon') && pts.length > 0) {
            pts.push({ x: pts[0].x, y: pts[0].y });
        }
        if (pts.length > 1) polylines.push(pts);
    }

    // ── Post-traitement : inversion Y ──────────────────────────────────────
    if (invertY) {
        polylines = polylines.map(poly => poly.map(pt => ({ x: pt.x, y: -pt.y })));
    }

    return optimizePathOrder(polylines);
}

// ─────────────────────────────────────────────────────────────────────────────
// PARSER DE CHEMINS SVG COMPLET
// ─────────────────────────────────────────────────────────────────────────────
function convertPathToPolylines(dString, chordalError) {
    const subpaths = [];
    let current = [];
    let cx = 0, cy = 0;
    let startX = 0, startY = 0;
    let lastCtrlX = null, lastCtrlY = null;
    let lastCmd = '';

    const tokens = tokenizePath(dString);
    let i = 0;

    const flushSubpath = () => {
        if (current.length > 1) subpaths.push(current);
        current = [];
    };

    const push = (x, y) => {
        const last = current[current.length - 1];
        if (!last || Math.abs(last.x - x) > 1e-9 || Math.abs(last.y - y) > 1e-9) {
            current.push({ x, y });
        }
        cx = x; cy = y;
    };

    while (i < tokens.length) {
        const cmd = tokens[i++];
        if (typeof cmd !== 'string') { i--; continue; }
        const isRel = cmd === cmd.toLowerCase() && cmd !== 'Z' && cmd !== 'z';
        const upper = cmd.toUpperCase();

        const num = () => { const v = tokens[i++]; return typeof v === 'number' ? v : parseFloat(v); };
        const hasNum = () => i < tokens.length && typeof tokens[i] === 'number';

        switch (upper) {
            case 'M': {
                flushSubpath();
                cx = isRel ? cx + num() : num();
                cy = isRel ? cy + num() : num();
                startX = cx; startY = cy;
                push(cx, cy);
                while (hasNum()) { cx = isRel ? cx + num() : num(); cy = isRel ? cy + num() : num(); push(cx, cy); }
                break;
            }
            case 'L': {
                while (hasNum()) { cx = isRel ? cx + num() : num(); cy = isRel ? cy + num() : num(); push(cx, cy); }
                break;
            }
            case 'H': {
                while (hasNum()) { cx = isRel ? cx + num() : num(); push(cx, cy); }
                break;
            }
            case 'V': {
                while (hasNum()) { cy = isRel ? cy + num() : num(); push(cx, cy); }
                break;
            }
            case 'C': {
                while (hasNum()) {
                    const x1 = isRel ? cx + num() : num(); const y1 = isRel ? cy + num() : num();
                    const x2 = isRel ? cx + num() : num(); const y2 = isRel ? cy + num() : num();
                    const ex = isRel ? cx + num() : num(); const ey = isRel ? cy + num() : num();
                    adaptiveCubic(cx, cy, x1, y1, x2, y2, ex, ey, chordalError, current);
                    lastCtrlX = x2; lastCtrlY = y2; cx = ex; cy = ey;
                }
                break;
            }
            case 'S': {
                while (hasNum()) {
                    let x1, y1;
                    if (lastCtrlX !== null && (lastCmd === 'C' || lastCmd === 'S')) {
                        x1 = 2 * cx - lastCtrlX; y1 = 2 * cy - lastCtrlY;
                    } else { x1 = cx; y1 = cy; }
                    const x2 = isRel ? cx + num() : num(); const y2 = isRel ? cy + num() : num();
                    const ex = isRel ? cx + num() : num(); const ey = isRel ? cy + num() : num();
                    adaptiveCubic(cx, cy, x1, y1, x2, y2, ex, ey, chordalError, current);
                    lastCtrlX = x2; lastCtrlY = y2; cx = ex; cy = ey;
                }
                break;
            }
            case 'Q': {
                while (hasNum()) {
                    const x1 = isRel ? cx + num() : num(); const y1 = isRel ? cy + num() : num();
                    const ex = isRel ? cx + num() : num(); const ey = isRel ? cy + num() : num();
                    adaptiveQuadratic(cx, cy, x1, y1, ex, ey, chordalError, current);
                    lastCtrlX = x1; lastCtrlY = y1; cx = ex; cy = ey;
                }
                break;
            }
            case 'T': {
                while (hasNum()) {
                    let x1, y1;
                    if (lastCtrlX !== null && (lastCmd === 'Q' || lastCmd === 'T')) {
                        x1 = 2 * cx - lastCtrlX; y1 = 2 * cy - lastCtrlY;
                    } else { x1 = cx; y1 = cy; }
                    const ex = isRel ? cx + num() : num(); const ey = isRel ? cy + num() : num();
                    adaptiveQuadratic(cx, cy, x1, y1, ex, ey, chordalError, current);
                    lastCtrlX = x1; lastCtrlY = y1; cx = ex; cy = ey;
                }
                break;
            }
            case 'A': {
                while (hasNum()) {
                    const rx = Math.abs(num()); const ry = Math.abs(num());
                    const xRot = num() * Math.PI / 180;
                    const large = num() !== 0; const sweep = num() !== 0;
                    const ex = isRel ? cx + num() : num(); const ey = isRel ? cy + num() : num();
                    if (rx === 0 || ry === 0) push(ex, ey);
                    else svgArcToPolyline(cx, cy, rx, ry, xRot, large, sweep, ex, ey, chordalError, current);
                    lastCtrlX = null; lastCtrlY = null; cx = ex; cy = ey;
                }
                break;
            }
            case 'Z': {
                if (current.length > 0) push(startX, startY);
                flushSubpath();
                cx = startX; cy = startY;
                lastCtrlX = null; lastCtrlY = null;
                break;
            }
        }
        lastCmd = upper;
    }

    flushSubpath();
    return subpaths;
}

// ─────────────────────────────────────────────────────────────────────────────
// TOKENIZER
// ─────────────────────────────────────────────────────────────────────────────
function tokenizePath(d) {
    const tokens = [];
    const re = /([MmLlHhVvCcSsQqTtAaZz])|([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/g;
    let m;
    while ((m = re.exec(d)) !== null) {
        if (m[1]) tokens.push(m[1]);
        else if (m[2] !== undefined) tokens.push(parseFloat(m[2]));
    }
    return tokens;
}

// ─────────────────────────────────────────────────────────────────────────────
// SUBDIVISION ADAPTATIVE — BÉZIER CUBIQUE (De Casteljau)
// ─────────────────────────────────────────────────────────────────────────────
function adaptiveCubic(x0, y0, x1, y1, x2, y2, x3, y3, tol, pts, depth = 0) {
    const mx = (x0 + x3) / 2, my = (y0 + y3) / 2;
    const qx = (x0 + 2*x1 + 2*x2 + x3) / 6, qy = (y0 + 2*y1 + 2*y2 + y3) / 6;
    const err = Math.hypot(qx - mx, qy - my);
    if (depth > 12 || err < tol) {
        const last = pts[pts.length - 1];
        if (!last || Math.abs(last.x - x3) > 1e-9 || Math.abs(last.y - y3) > 1e-9) pts.push({ x: x3, y: y3 });
        return;
    }
    const x01=(x0+x1)/2, y01=(y0+y1)/2, x12=(x1+x2)/2, y12=(y1+y2)/2, x23=(x2+x3)/2, y23=(y2+y3)/2;
    const x012=(x01+x12)/2, y012=(y01+y12)/2, x123=(x12+x23)/2, y123=(y12+y23)/2;
    const xm=(x012+x123)/2, ym=(y012+y123)/2;
    adaptiveCubic(x0,y0,x01,y01,x012,y012,xm,ym,tol,pts,depth+1);
    adaptiveCubic(xm,ym,x123,y123,x23,y23,x3,y3,tol,pts,depth+1);
}

// ─────────────────────────────────────────────────────────────────────────────
// SUBDIVISION ADAPTATIVE — BÉZIER QUADRATIQUE
// ─────────────────────────────────────────────────────────────────────────────
function adaptiveQuadratic(x0, y0, x1, y1, x2, y2, tol, pts, depth = 0) {
    const mx=(x0+x2)/2, my=(y0+y2)/2;
    const qx=(x0+2*x1+x2)/4, qy=(y0+2*y1+y2)/4;
    const err = Math.hypot(qx-mx, qy-my);
    if (depth > 12 || err < tol) {
        const last = pts[pts.length - 1];
        if (!last || Math.abs(last.x - x2) > 1e-9 || Math.abs(last.y - y2) > 1e-9) pts.push({ x: x2, y: y2 });
        return;
    }
    const x01=(x0+x1)/2, y01=(y0+y1)/2, x12=(x1+x2)/2, y12=(y1+y2)/2;
    const xm=(x01+x12)/2, ym=(y01+y12)/2;
    adaptiveQuadratic(x0,y0,x01,y01,xm,ym,tol,pts,depth+1);
    adaptiveQuadratic(xm,ym,x12,y12,x2,y2,tol,pts,depth+1);
}

// ─────────────────────────────────────────────────────────────────────────────
// ARC ELLIPTIQUE SVG → POLYLINE (W3C endpoint→center)
// ─────────────────────────────────────────────────────────────────────────────
function svgArcToPolyline(x1, y1, rx, ry, phi, largeArc, sweep, x2, y2, tol, pts) {
    const cos = Math.cos(phi), sin = Math.sin(phi);
    const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
    const x1p = cos*dx + sin*dy, y1p = -sin*dx + cos*dy;
    let rxSq = rx*rx, rySq = ry*ry;
    const x1pSq = x1p*x1p, y1pSq = y1p*y1p;
    const lambda = x1pSq/rxSq + y1pSq/rySq;
    if (lambda > 1) { const sq = Math.sqrt(lambda); rx = sq*rx; ry = sq*ry; rxSq = rx*rx; rySq = ry*ry; }
    const num = Math.max(0, rxSq*rySq - rxSq*y1pSq - rySq*x1pSq);
    const den = rxSq*y1pSq + rySq*x1pSq;
    const sq = den === 0 ? 0 : Math.sqrt(num/den);
    const sign = largeArc === sweep ? -1 : 1;
    const cxp = sign*sq*(rx*y1p)/ry, cyp = -sign*sq*(ry*x1p)/rx;
    const cX = cos*cxp - sin*cyp + (x1+x2)/2, cY = sin*cxp + cos*cyp + (y1+y2)/2;
    const ux=(x1p-cxp)/rx, uy=(y1p-cyp)/ry, vx=(-x1p-cxp)/rx, vy=(-y1p-cyp)/ry;
    let theta1 = Math.atan2(uy, ux);
    let dTheta = Math.atan2(-vy, -vx) - theta1;
    if (!sweep && dTheta > 0) dTheta -= 2*Math.PI;
    if (sweep && dTheta < 0) dTheta += 2*Math.PI;
    const maxR = Math.max(rx, ry);
    const nSegs = Math.max(4, Math.ceil(Math.abs(dTheta) / (2*Math.acos(1-tol/maxR))));
    for (let k = 1; k <= nSegs; k++) {
        const t = theta1 + (k/nSegs)*dTheta;
        const xp = cos*rx*Math.cos(t) - sin*ry*Math.sin(t) + cX;
        const yp = sin*rx*Math.cos(t) + cos*ry*Math.sin(t) + cY;
        const last = pts[pts.length - 1];
        if (!last || Math.abs(last.x-xp)>1e-9 || Math.abs(last.y-yp)>1e-9) pts.push({ x:xp, y:yp });
    }
}

function discretizeArcFull(cx, cy, rx, ry, phi, tol) {
    const maxR = Math.max(rx, ry);
    const nSegs = Math.max(8, Math.ceil(2*Math.PI / (2*Math.acos(1-tol/maxR))));
    const pts = [];
    for (let k = 0; k <= nSegs; k++) {
        const t = (k/nSegs)*2*Math.PI;
        pts.push({ x: cx + rx*Math.cos(t), y: cy + ry*Math.sin(t) });
    }
    return pts;
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILITAIRES COMMUNS
// ─────────────────────────────────────────────────────────────────────────────
function getAttr(tag, name) {
    const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
    const m = re.exec(tag);
    return m ? (m[1] !== undefined ? m[1] : m[2]) : null;
}

function pf(s) { return parseFloat(s) || 0; }

function parsePointList(s) {
    const nums = s.trim().split(/[\s,]+/).map(parseFloat).filter(n => !isNaN(n));
    const pts = [];
    for (let i = 0; i+1 < nums.length; i+=2) pts.push({ x: nums[i], y: nums[i+1] });
    return pts;
}

// ─────────────────────────────────────────────────────────────────────────────
// OPTIMISATION D'ORDRE (Nearest-Neighbour Greedy)
// ─────────────────────────────────────────────────────────────────────────────
function optimizePathOrder(polylines) {
    if (polylines.length <= 1) return polylines;
    const result = [];
    const unvisited = [...polylines];
    let cur = { x: 0, y: 0 };
    while (unvisited.length > 0) {
        let bestDist = Infinity, bestIdx = -1, bestRev = false;
        for (let i = 0; i < unvisited.length; i++) {
            const s = unvisited[i][0], e = unvisited[i][unvisited[i].length-1];
            const ds = Math.hypot(s.x-cur.x, s.y-cur.y);
            const de = Math.hypot(e.x-cur.x, e.y-cur.y);
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

// ─────────────────────────────────────────────────────────────────────────────
// HACHURES — Remplissage Grayscale
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Point d'entrée : génère toutes les lignes de hachures pour les zones remplies du SVG.
 * Les polylignes retournées s'ajoutent APRÈS les contours dans le flux de tracé.
 */
function generateAllHatches(svgString, invertY, maxSpacing, hatchType, chordalError) {
    const allHatches = [];
    const MIN_SPACING = 0.35; // mm — espacement minimum physiquement raisonnable

    const shapes = extractFilledShapes(svgString, invertY, chordalError);

    for (const shape of shapes) {
        // Blanc pur → pas de hachures
        if (shape.grayscale >= 248) continue;

        // Conversion grayscale → espacement
        // Courbe perceptuelle : t^0.55 pour mieux représenter les tons moyens
        const t = shape.grayscale / 248;          // 0 = noir, 1 = blanc
        const spacing = MIN_SPACING + (maxSpacing - MIN_SPACING) * Math.pow(t, 0.55);

        // Hachures à 45°
        const h45 = generateHatchesForShape(shape.polygon, spacing, 45);
        allHatches.push(...h45);

        // Hachures croisées à 135° (si demandé)
        if (hatchType === 'crosshatch') {
            const h135 = generateHatchesForShape(shape.polygon, spacing, 135);
            allHatches.push(...h135);
        }
    }

    return allHatches;
}

/**
 * Extrait toutes les formes avec un remplissage explicite (non-none, non-transparent, non-blanc).
 * Ne prend en compte que le fill explicitement défini (attr ou style inline).
 * La couleur est convertie en luminance grayscale.
 */
function extractFilledShapes(svgString, invertY, chordalError) {
    const shapes = [];

    function commit(polygon, fillStr) {
        if (!fillStr) return;
        const color = parseColor(fillStr);
        if (!color) return;
        const gray = toGrayscale(color);
        if (gray >= 248) return; // blanc → skip
        if (invertY) polygon = polygon.map(p => ({ x: p.x, y: -p.y }));
        if (polygon.length >= 3) shapes.push({ polygon, grayscale: gray });
    }

    // ── <rect> ───────────────────────────────────────────────────────────────
    const rectRe = /<rect([^>]+)>/gi;
    let m;
    while ((m = rectRe.exec(svgString)) !== null) {
        const a = m[1];
        const fill = getFill(a); if (!fill) continue;
        const x = pf(getAttr(a,'x')||'0'), y = pf(getAttr(a,'y')||'0');
        const w = pf(getAttr(a,'width')||'0'), h = pf(getAttr(a,'height')||'0');
        if (w <= 0 || h <= 0) continue;
        commit([{x,y},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h}], fill);
    }

    // ── <circle> ─────────────────────────────────────────────────────────────
    const circleRe = /<circle([^>]+)>/gi;
    while ((m = circleRe.exec(svgString)) !== null) {
        const a = m[1];
        const fill = getFill(a); if (!fill) continue;
        const cx = pf(getAttr(a,'cx')||'0'), cy = pf(getAttr(a,'cy')||'0');
        const r  = pf(getAttr(a,'r')||'0'); if (r <= 0) continue;
        commit(shapeToPolygon(cx, cy, r, r, chordalError), fill);
    }

    // ── <ellipse> ────────────────────────────────────────────────────────────
    const ellipseRe = /<ellipse([^>]+)>/gi;
    while ((m = ellipseRe.exec(svgString)) !== null) {
        const a = m[1];
        const fill = getFill(a); if (!fill) continue;
        const cx = pf(getAttr(a,'cx')||'0'), cy = pf(getAttr(a,'cy')||'0');
        const rx = pf(getAttr(a,'rx')||'0'), ry = pf(getAttr(a,'ry')||'0');
        if (rx <= 0 || ry <= 0) continue;
        commit(shapeToPolygon(cx, cy, rx, ry, chordalError), fill);
    }

    // ── <polygon> ────────────────────────────────────────────────────────────
    const polyRe = /<polygon([^>]+)>/gi;
    while ((m = polyRe.exec(svgString)) !== null) {
        const a = m[1];
        const fill = getFill(a); if (!fill) continue;
        const pts = parsePointList(getAttr(a,'points')||'');
        if (pts.length < 3) continue;
        commit(pts, fill);
    }

    // ── <path> : sous-chemins fermés (Z) ─────────────────────────────────────
    const pathRe = /<path([^>]+)>/gi;
    while ((m = pathRe.exec(svgString)) !== null) {
        const a = m[1];
        const fill = getFill(a); if (!fill) continue;
        const d = getAttr(a,'d'); if (!d) continue;
        const subpaths = convertPathToPolylines(d, chordalError);
        for (const poly of subpaths) {
            if (isClosedPoly(poly)) commit([...poly], fill);
        }
    }

    return shapes;
}

/**
 * Lit le fill d'un tag SVG (attr fill ou style inline).
 * Retourne null si fill="none" ou pas de fill explicite.
 */
function getFill(attrStr) {
    // Attribut direct
    const direct = getAttr(attrStr, 'fill');
    if (direct !== null) {
        const v = direct.trim().toLowerCase();
        return (v === 'none' || v === 'transparent') ? null : direct.trim();
    }
    // Style inline : fill: ...
    const style = getAttr(attrStr, 'style');
    if (style) {
        const sm = style.match(/(?:^|;)\s*fill\s*:\s*([^;]+)/i);
        if (sm) {
            const v = sm[1].trim().toLowerCase();
            return (v === 'none' || v === 'transparent') ? null : sm[1].trim();
        }
    }
    // Pas de fill explicite → ne pas hachurer
    return null;
}

/** Vérifie si une polyligne est fermée (dernier point ≈ premier point). */
function isClosedPoly(poly) {
    if (poly.length < 3) return false;
    const f = poly[0], l = poly[poly.length-1];
    return Math.hypot(f.x-l.x, f.y-l.y) < 1e-6;
}

/** Discrétise une ellipse en polygone. */
function shapeToPolygon(cx, cy, rx, ry, tol) {
    const maxR = Math.max(rx, ry);
    const n = Math.max(16, Math.ceil(2*Math.PI / (2*Math.acos(Math.max(-1, 1 - tol/maxR)))));
    const pts = [];
    for (let k = 0; k < n; k++) {
        const t = (k/n)*2*Math.PI;
        pts.push({ x: cx + rx*Math.cos(t), y: cy + ry*Math.sin(t) });
    }
    return pts;
}

// ─────────────────────────────────────────────────────────────────────────────
// PARSEUR DE COULEURS COMPLET
// ─────────────────────────────────────────────────────────────────────────────
function parseColor(str) {
    if (!str) return null;
    str = str.trim().toLowerCase();
    if (str === 'none' || str === 'transparent') return null;

    // Noms courants
    const NAMED = {
        black:'#000000', white:'#ffffff', red:'#ff0000', green:'#008000',
        blue:'#0000ff', yellow:'#ffff00', cyan:'#00ffff', magenta:'#ff00ff',
        orange:'#ffa500', purple:'#800080', pink:'#ffc0cb', brown:'#a52a2a',
        gray:'#808080', grey:'#808080', silver:'#c0c0c0', darkgray:'#a9a9a9',
        lightgray:'#d3d3d3', darkblue:'#00008b', darkgreen:'#006400',
        darkred:'#8b0000', navy:'#000080', teal:'#008080', lime:'#00ff00',
        aqua:'#00ffff', fuchsia:'#ff00ff', currentcolor:'#000000',
        maroon:'#800000', olive:'#808000',
    };
    if (NAMED[str]) str = NAMED[str];

    // #rgb, #rgba, #rrggbb, #rrggbbaa
    if (str.startsWith('#')) {
        let h = str.slice(1);
        if (h.length === 3 || h.length === 4) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
        const r = parseInt(h.slice(0,2),16), g = parseInt(h.slice(2,4),16), b = parseInt(h.slice(4,6),16);
        if (!isNaN(r) && !isNaN(g) && !isNaN(b)) return { r, g, b };
    }

    // rgb() / rgba()
    const rgbM = str.match(/rgba?\s*\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/);
    if (rgbM) return { r: +rgbM[1], g: +rgbM[2], b: +rgbM[3] };

    // hsl() / hsla()
    const hslM = str.match(/hsla?\s*\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%/);
    if (hslM) return hslToRgb(+hslM[1]/360, +hslM[2]/100, +hslM[3]/100);

    return null;
}

function hslToRgb(h, s, l) {
    if (s === 0) { const v=Math.round(l*255); return {r:v,g:v,b:v}; }
    const q = l < 0.5 ? l*(1+s) : l+s-l*s, p = 2*l-q;
    return {
        r: Math.round(hue(p,q,h+1/3)*255),
        g: Math.round(hue(p,q,h)*255),
        b: Math.round(hue(p,q,h-1/3)*255)
    };
}
function hue(p,q,t) {
    if(t<0)t+=1; if(t>1)t-=1;
    if(t<1/6) return p+(q-p)*6*t;
    if(t<1/2) return q;
    if(t<2/3) return p+(q-p)*(2/3-t)*6;
    return p;
}

/** Luminance perceptuelle → grayscale 0–255. */
function toGrayscale(c) { return 0.299*c.r + 0.587*c.g + 0.114*c.b; }

// ─────────────────────────────────────────────────────────────────────────────
// GÉNÉRATION DE HACHURES POUR UN POLYGONE
// Algorithme : rotation du plan → scanline horizontale → rotation inverse
// ─────────────────────────────────────────────────────────────────────────────
function generateHatchesForShape(polygon, spacing, angleDeg) {
    if (polygon.length < 3 || spacing <= 0) return [];

    const angle = angleDeg * Math.PI / 180;
    // Rotation pour aligner les hachures avec l'horizontale
    const cosF = Math.cos(-angle), sinF = Math.sin(-angle);
    const cosB = Math.cos(angle),  sinB = Math.sin(angle);

    const rotated = polygon.map(p => ({
        x: cosF*p.x - sinF*p.y,
        y: sinF*p.x + cosF*p.y
    }));

    let minY = Infinity, maxY = -Infinity;
    rotated.forEach(p => { if(p.y<minY) minY=p.y; if(p.y>maxY) maxY=p.y; });

    const n = rotated.length;
    const startY = Math.ceil(minY / spacing) * spacing;
    const hatches = [];

    for (let scanY = startY; scanY <= maxY + 1e-9; scanY += spacing) {
        const xs = [];
        for (let i = 0; i < n; i++) {
            const a = rotated[i], b = rotated[(i+1) % n];
            if ((a.y <= scanY && b.y > scanY) || (b.y <= scanY && a.y > scanY)) {
                const t = (scanY - a.y) / (b.y - a.y);
                xs.push(a.x + t*(b.x - a.x));
            }
        }
        xs.sort((a,b) => a-b);

        // Appariement even-odd
        for (let i = 0; i+1 < xs.length; i += 2) {
            if (xs[i+1] - xs[i] < 1e-9) continue;
            hatches.push([
                { x: cosB*xs[i]   - sinB*scanY, y: sinB*xs[i]   + cosB*scanY },
                { x: cosB*xs[i+1] - sinB*scanY, y: sinB*xs[i+1] + cosB*scanY }
            ]);
        }
    }

    return hatches;
}
