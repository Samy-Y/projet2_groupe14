// worker.js - Discrétisation SVG en Background

// Minimal SVG Path Parser et discrétiseur rudimentaire
// Pour un projet complet de production, l'injection d'une librairie tierce (comme points-on-path ou flatten-svg) via importScripts() est recommandée.
// Ici, nous implémentons un discrétiseur simple basé sur l'échantillonnage de courbes de Bézier.

self.onmessage = function(e) {
    const { type, svgContent, chordalError, invertY } = e.data;
    
    if (type === 'parse') {
        const polylines = parseSVG(svgContent, invertY);
        let segmentsCount = 0;
        polylines.forEach(p => segmentsCount += p.length - 1);
        
        self.postMessage({
            type: 'done',
            polylines: polylines,
            segments: segmentsCount
        });
    }
};

function parseSVG(svgString, invertY) {
    let polylines = [];
    
    // Helper function pour extraire les attributs
    function getAttr(tagStr, attrName) {
        let regex = new RegExp(`${attrName}="([^"]*)"`, 'i');
        let m = regex.exec(tagStr);
        return m ? m[1] : null;
    }

    // 1. Gérer les <path>
    const regexPath = /<path[^>]*d="([^"]*)"/g;
    let match;
    while ((match = regexPath.exec(svgString)) !== null) {
        let poly = convertPathToPolyline(match[1]);
        if(invertY) poly = poly.map(pt => ({ x: pt.x, y: -pt.y }));
        if(poly.length > 1) polylines.push(poly);
    }
    
    // 2. Gérer les <line>
    const regexLine = /<line([^>]+)>/g;
    while ((match = regexLine.exec(svgString)) !== null) {
        let attrs = match[1];
        let x1 = parseFloat(getAttr(attrs, 'x1')||0);
        let y1 = parseFloat(getAttr(attrs, 'y1')||0);
        let x2 = parseFloat(getAttr(attrs, 'x2')||0);
        let y2 = parseFloat(getAttr(attrs, 'y2')||0);
        if(invertY) { y1 = -y1; y2 = -y2; }
        polylines.push([{x: x1, y: y1}, {x: x2, y: y2}]);
    }

    // 3. Gérer les <rect> (Carrés/Rectangles)
    const regexRect = /<rect([^>]+)>/g;
    while ((match = regexRect.exec(svgString)) !== null) {
        let attrs = match[1];
        let x = parseFloat(getAttr(attrs, 'x')||0);
        let y = parseFloat(getAttr(attrs, 'y')||0);
        let w = parseFloat(getAttr(attrs, 'width')||0);
        let h = parseFloat(getAttr(attrs, 'height')||0);
        if(w > 0 && h > 0) {
            let ys = invertY ? -y : y;
            let he = invertY ? -h : h;
            polylines.push([
                {x: x, y: ys}, {x: x + w, y: ys}, 
                {x: x + w, y: ys + he}, {x: x, y: ys + he}, 
                {x: x, y: ys} // Fermeture
            ]);
        }
    }

    // 4. Gérer les <polygon> et <polyline>
    const regexPoly = /<poly[a-z]+[^>]*points="([^"]*)"/g;
    while ((match = regexPoly.exec(svgString)) !== null) {
        let ptsStr = match[1].trim().split(/[\s,]+/);
        let poly = [];
        for(let i=0; i<ptsStr.length; i+=2) {
            if(ptsStr[i] !== undefined && ptsStr[i+1] !== undefined) {
                let px = parseFloat(ptsStr[i]);
                let py = parseFloat(ptsStr[i+1]);
                if(invertY) py = -py;
                poly.push({x: px, y: py});
            }
        }
        if(match[0].includes("<polygon") && poly.length > 0) {
            poly.push({x: poly[0].x, y: poly[0].y}); // Fermeture si polygone
        }
        if(poly.length > 1) polylines.push(poly);
    }

    return optimizePathOrder(polylines);
}

function convertPathToPolyline(dString) {
    let pts = [];
    // Un vrai parser SVG est complexe, mais nous utilisons une approche simplifiée 
    // qui éclate la chaîne sur les commandes et gère l'interpolation de courbes de Bézier.
    let commandsRegex = /([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g;
    let match;
    let currX = 0, currY = 0;
    
    // Discretisation resolution
    const numSegments = 10; 
    
    while ((match = commandsRegex.exec(dString)) !== null) {
        let type = match[1];
        let argsStr = match[2].trim();
        // Extract all numbers correctly (handling negatives without spaces e.g. "10-20")
        let args = argsStr.match(/-?[0-9]*\.?[0-9]+/g);
        if(args) args = args.map(parseFloat);
        else args = [];

        switch(type) {
            case 'M':
                currX = args[0]; currY = args[1];
                pts.push({x: currX, y: currY});
                for(let i=2; i<args.length; i+=2) { // subsequent pairs form L
                    currX = args[i]; currY = args[i+1];
                    pts.push({x: currX, y: currY});
                }
                break;
            case 'm':
                currX += args[0]; currY += args[1];
                pts.push({x: currX, y: currY});
                for(let i=2; i<args.length; i+=2) {
                    currX += args[i]; currY += args[i+1];
                    pts.push({x: currX, y: currY});
                }
                break;
            case 'L':
                for(let i=0; i<args.length; i+=2) {
                    currX = args[i]; currY = args[i+1];
                    pts.push({x: currX, y: currY});
                }
                break;
            case 'l':
                for(let i=0; i<args.length; i+=2) {
                    currX += args[i]; currY += args[i+1];
                    pts.push({x: currX, y: currY});
                }
                break;
            case 'C': // Cubic Bézier (x1, y1, x2, y2, x, y)
                for(let i=0; i<args.length; i+=6) {
                    let cx1 = args[i], cy1 = args[i+1], cx2 = args[i+2], cy2 = args[i+3], x = args[i+4], y = args[i+5];
                    for(let t=1; t<=numSegments; t++) {
                        let f = t/numSegments;
                        let mt = 1-f;
                        let px = mt*mt*mt*currX + 3*mt*mt*f*cx1 + 3*mt*f*f*cx2 + f*f*f*x;
                        let py = mt*mt*mt*currY + 3*mt*mt*f*cy1 + 3*mt*f*f*cy2 + f*f*f*y;
                        pts.push({x: px, y: py});
                    }
                    currX = x; currY = y;
                }
                break;
            case 'c': // Cubic Bézier relative
                for(let i=0; i<args.length; i+=6) {
                    let cx1 = currX + args[i], cy1 = currY + args[i+1], cx2 = currX + args[i+2], cy2 = currY + args[i+3], x = currX + args[i+4], y = currY + args[i+5];
                    for(let t=1; t<=numSegments; t++) {
                        let f = t/numSegments;
                        let mt = 1-f;
                        let px = mt*mt*mt*currX + 3*mt*mt*f*cx1 + 3*mt*f*f*cx2 + f*f*f*x;
                        let py = mt*mt*mt*currY + 3*mt*mt*f*cy1 + 3*mt*f*f*cy2 + f*f*f*y;
                        pts.push({x: px, y: py});
                    }
                    currX = x; currY = y;
                }
                break;
            case 'Z':
            case 'z':
                if(pts.length > 0) {
                    pts.push({x: pts[0].x, y: pts[0].y});
                }
                break;
            // D'autres types de courbes (Q, A) seraient à implémenter ici selon le même principe paramétrique.
        }
    }
    
    return pts;
}

function optimizePathOrder(polylines) {
    if (polylines.length <= 1) return polylines;
    
    let result = [];
    let unvisited = [...polylines];
    
    // Commence au point 0,0
    let currentPoint = {x: 0, y: 0};
    
    while(unvisited.length > 0) {
        let bestDist = Infinity;
        let bestIdx = -1;
        let reverseBest = false;
        
        for(let i=0; i<unvisited.length; i++) {
            let start = unvisited[i][0];
            let end = unvisited[i][unvisited[i].length - 1];
            
            let distToStart = Math.hypot(start.x - currentPoint.x, start.y - currentPoint.y);
            let distToEnd = Math.hypot(end.x - currentPoint.x, end.y - currentPoint.y);
            
            if(distToStart < bestDist) {
                bestDist = distToStart;
                bestIdx = i;
                reverseBest = false;
            }
            if(distToEnd < bestDist) {
                bestDist = distToEnd;
                bestIdx = i;
                reverseBest = true;
            }
        }
        
        let chosen = unvisited.splice(bestIdx, 1)[0];
        if(reverseBest) {
            chosen.reverse();
        }
        
        result.push(chosen);
        currentPoint = chosen[chosen.length - 1];
    }
    
    return result;
}
