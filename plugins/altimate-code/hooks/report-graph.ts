// The column graph on the lineage report page: a layered layout (one layer per hop, upstream on the
// left, the changed column in the middle, downstream on the right) drawn as plain SVG, with zoom and
// pan. Both run in the page, which stays one offline file. The layout is a pure function of the
// report data, tested here and sent to the page as its own source, so the same data always draws
// the same graph.

/**
 * `graphLayout(focus, levels, expanded)`: boxes, rows and edges with their coordinates.
 * - `focus`: one ReportFocus; `levels`: `{ up, down }` hops to show; `expanded`: layers drawn in full.
 * - A layer with more than 12 models is one box ("+N models") unless expanded.
 * - Each layer is ordered by where its edges meet the layer before it (toward the changed column),
 *   then by name, so edges cross less and the order never depends on the data's order.
 * - An edge's `label` is its derivation when the engine told it (same, renamed, calculated,
 *   aggregated), else null: an unknown one is drawn without a label.
 *
 * The page runs this function's own source (`graphLayout.toString()`), so it uses nothing from
 * outside its body but the language's built-ins.
 */
export function graphLayout(f: any, levels: { up: number; down: number }, expanded: Record<number, boolean>): any {
  var G = { boxW: 236, headH: 30, rowH: 20, pad: 8, gapX: 92, gapY: 14, maxModels: 12, maxName: 28, maxColumn: 24 }
  var layers: any = {}, order: number[] = [0], boxes: any[] = [], at: any = {}, edges: any[] = [], seen: any = {}
  function cut(s: unknown, n: number) { var t = String(s); return t.length > n ? t.slice(0, n - 1) + '…' : t }
  function r1(n: number) { return Math.round(n * 10) / 10 }
  var fk = f.key, fid = fk ? fk.slice(0, fk.lastIndexOf('|')) : f.model
  layers[0] = [{ id: fid, name: f.model, folder: '', materialized: '', contract: false, tests: 0, exposures: [], flags: [], focus: true,
    columns: fk ? [{ key: fk, column: f.column || '', glyph: f.glyph || '?', byName: !!f.byName, end: false, type: null, hop: 0 }] : [] }]
  ;((f.up && f.up.hops) || []).forEach(function (h: any) { if (h.hop >= 1 && h.hop <= levels.up) { layers[-h.hop] = h.models; order.push(-h.hop) } })
  ;((f.down && f.down.hops) || []).forEach(function (h: any) { if (h.hop >= 1 && h.hop <= levels.down) { layers[h.hop] = h.models; order.push(h.hop) } })
  // Outward from the changed column: 0, 1, 2, ... then -1, -2, ...
  order.sort(function (a, b) { return Number(a < 0) - Number(b < 0) || Math.abs(a) - Math.abs(b) })
  var inn: any = {}, out: any = {}
  ;(f.edges || []).forEach(function (e: any) { (inn[e[1]] = inn[e[1]] || []).push(e[0]); (out[e[0]] = out[e[0]] || []).push(e[1]) })
  function bary(keys: string[], L: number) {
    var ys: number[] = []
    keys.forEach(function (k) { ((L > 0 ? inn[k] : out[k]) || []).forEach(function (o: string) { if (at[o]) ys.push(at[o].y) }) })
    return ys.length ? ys.reduce(function (s, y) { return s + y }, 0) / ys.length : null
  }
  function cmp(a: any, b: any) {
    if (a.b === null && b.b !== null) return 1
    if (b.b === null && a.b !== null) return -1
    return (a.b === null ? 0 : a.b - b.b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  }
  order.forEach(function (L) {
    var models: any[] = layers[L] || [], x = L * (G.boxW + G.gapX), items: any[]
    if (L !== 0 && models.length > G.maxModels && !expanded[L]) {
      var keys: string[] = []
      models.forEach(function (m) { m.columns.forEach(function (c: any) { keys.push(c.key) }) })
      items = [{ collapsed: true, id: '+' + L, name: '+' + models.length + ' models', count: models.length, columns: keys.length, keys: keys, b: bary(keys, L) }]
    } else items = models.map(function (m) {
      var rows = m.columns.map(function (c: any) { return { c: c, b: bary([c.key], L), name: String(c.column), id: c.key } }).sort(cmp)
      return { model: m, id: m.id, name: String(m.name), rows: rows, b: bary(m.columns.map(function (c: any) { return c.key }), L) }
    }).sort(cmp)
    var hs = items.map(function (it) { return it.collapsed ? G.headH + 2 * G.rowH + G.pad : G.headH + Math.max(1, it.rows.length) * G.rowH + G.pad })
    var total = hs.reduce(function (s, h) { return s + h }, 0) + G.gapY * Math.max(0, items.length - 1), y = -total / 2
    items.forEach(function (it, j) {
      var h: number = hs[j] as number, box: any = { id: L + ':' + it.id, layer: L, x: r1(x), y: r1(y), w: G.boxW, h: h }
      if (it.collapsed) {
        box.collapsed = true; box.name = it.name; box.count = it.count; box.rows = []
        box.sub = it.columns + (it.columns === 1 ? ' column' : ' columns')
        box.title = it.count + ' models, ' + box.sub + ': click to show them'
        it.keys.forEach(function (k: string) { at[k] = { x1: r1(x), x2: r1(x + G.boxW), y: r1(y + h / 2), box: box.id, folded: true } })
      } else {
        var m = it.model
        box.name = cut(m.name, G.maxName)
        box.title = String(m.name) + (m.folder ? ' · ' + m.folder : '') + (m.materialized ? ' · ' + m.materialized : '')
        box.focus = !!m.focus; box.contract = !!m.contract; box.tests = m.tests || 0; box.exposures = (m.exposures || []).length; box.flags = (m.flags || []).length
        box.rows = it.rows.map(function (r: any, i: number) {
          var ry = r1(y + G.headH + i * G.rowH + G.rowH / 2)
          at[r.c.key] = { x1: r1(x), x2: r1(x + G.boxW), y: ry, box: box.id }
          return { key: r.c.key, column: cut(r.c.column, G.maxColumn), title: String(r.c.column) + (r.c.type ? ' · ' + r.c.type : ''), glyph: r.c.glyph, byName: !!r.c.byName, end: !!r.c.end, y: ry }
        })
      }
      boxes.push(box)
      y += h + G.gapY
    })
  })
  ;(f.edges || []).forEach(function (e: any) {
    var a = at[e[0]], b = at[e[1]]
    if (!a || !b || a.box === b.box) return
    // Edges into or out of a folded box are drawn once per pair of ends.
    var id = a.box + '>' + b.box + '|' + (a.folded ? '' : e[0]) + '|' + (b.folded ? '' : e[1])
    if (seen[id]) { seen[id].keys.push([e[0], e[1]]); return }
    var x1 = a.x2, x2 = b.x1, dx = x2 > x1 ? (x2 - x1) / 2 : G.gapX
    var known = e[2] === '=' || e[2] === '~' || e[2] === '\u0192' || e[2] === '\u03a3'
    var edge = { from: e[0], to: e[1], keys: [[e[0], e[1]]], glyph: e[2], label: known ? e[2] : null, d: 'M' + x1 + ' ' + a.y + 'C' + r1(x1 + dx) + ' ' + a.y + ' ' + r1(x2 - dx) + ' ' + b.y + ' ' + x2 + ' ' + b.y, mx: r1((x1 + x2) / 2), my: r1((a.y + b.y) / 2) }
    seen[id] = edge
    edges.push(edge)
  })
  var minX = 0, minY = 0, maxX = 0, maxY = 0
  boxes.forEach(function (b) { minX = Math.min(minX, b.x); minY = Math.min(minY, b.y); maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h) })
  var fb = boxes[0]
  return { boxes: boxes, edges: edges, bounds: { x: minX, y: minY, w: maxX - minX, h: maxY - minY }, focus: fb ? { x: fb.x + fb.w / 2, y: fb.y + fb.h / 2 } : { x: 0, y: 0 } }
}

/**
 * The graph panel: draws `graphLayout` as SVG, and handles zoom (wheel, pinch, buttons, + and -),
 * pan (drag, arrow keys), fit (0, or the Fit button) and column clicks, which call the page's
 * `select(key)`. Uses the page's `el`, `state`, `render` and `GLYPH`.
 */
export const GRAPH_VIEW_JS = `
var SVG='http://www.w3.org/2000/svg';
function sv(tag,attrs,text){var n=document.createElementNS(SVG,tag);for(var k in attrs)if(attrs[k]!=null)n.setAttribute(k,String(attrs[k]));if(text!=null)n.textContent=String(text);return n}
function graphPanel(f,i){
  var lv=state.levels[i],ex=state.expanded[i],lay=graphLayout(f,lv,ex);
  var p=el('div','panel graph'),bar=el('div','g-bar');
  function btn(label,title,fn){var b=el('button','g-btn',label);b.type='button';b.title=title;b.setAttribute('aria-label',title);b.addEventListener('click',fn);bar.appendChild(b);return b}
  var hiddenUp=f.up.hops.filter(function(h){return h.hop>lv.up}).length,hiddenDown=f.down.hops.filter(function(h){return h.hop>lv.down}).length;
  bar.appendChild(el('span','g-title',f.column?'Column graph':'Model graph'));
  var tools=el('span','g-tools');bar.appendChild(tools);
  function more(dir,hidden,label){if(!hidden)return;var b=btn(label+' ('+hidden+')',dir==='up'?'Show one more level upstream':'Show one more level downstream',function(){state.levels[i][dir]+=1;state.views[i]=null;render()});tools.appendChild(b)}
  more('up',hiddenUp,'\\u2190 more levels');more('down',hiddenDown,'more levels \\u2192');
  tools.appendChild(btn('\\u2212','Zoom out (-)',function(){zoomBy(1/1.25)}));
  tools.appendChild(btn('+','Zoom in (+)',function(){zoomBy(1.25)}));
  tools.appendChild(btn('Fit','Fit the graph to the panel (0)',function(){fit(true)}));
  tools.appendChild(btn(state.list?'Graph':'List','Show the columns as '+(state.list?'a graph':'a list'),function(){state.list=!state.list;render()}));
  p.appendChild(bar);
  var svg=sv('svg',{'class':'g-svg',tabindex:0,role:'group','aria-label':'Column graph: drag or use the arrow keys to move, the wheel or + and - to zoom, 0 to fit'});
  var vp=sv('g',{'class':'g-vp'}),gE=sv('g',{'class':'g-edges'}),gB=sv('g',{'class':'g-boxes'});vp.appendChild(gE);vp.appendChild(gB);svg.appendChild(vp);
  lay.edges.forEach(function(e){var g=sv('g',{'class':'g-edge '+(GLYPH[e.glyph]||'unk'),'data-keys':e.keys.map(function(k){return k[0]+'>'+k[1]}).join(' ')});
    g.appendChild(sv('path',{d:e.d}));if(e.label)g.appendChild(sv('text',{x:e.mx,y:e.my-4,'class':'g-elabel','text-anchor':'middle'},e.label));gE.appendChild(g)});
  lay.boxes.forEach(function(b){
    var g=sv('g',{'class':'g-box'+(b.focus?' focus':'')+(b.collapsed?' collapsed':''),transform:'translate('+b.x+','+b.y+')','data-box':b.id});
    g.appendChild(sv('title',{},b.title));
    g.appendChild(sv('rect',{width:b.w,height:b.h,rx:8,'class':'g-rect'}));
    g.appendChild(sv('text',{x:10,y:19,'class':'g-name'},b.name));
    var badge=[];if(b.contract)badge.push('C');if(b.exposures)badge.push('\\u25a3'+b.exposures);if(b.flags)badge.push('!');
    if(badge.length)g.appendChild(sv('text',{x:b.w-10,y:19,'class':'g-badge','text-anchor':'end'},badge.join(' ')));
    if(b.collapsed){g.appendChild(sv('text',{x:10,y:48,'class':'g-more'},b.sub+' \\u00b7 click to show them'));g.setAttribute('tabindex','0');g.setAttribute('role','button');
      var open=function(){state.expanded[i][b.layer]=true;state.views[i]=null;render()};g.addEventListener('click',function(ev){if(moved)return;ev.stopPropagation();open()});g.addEventListener('keydown',function(ev){if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();open()}})}
    b.rows.forEach(function(r){
      var row=sv('g',{'class':'g-row','data-key':r.key,tabindex:0,role:'button','aria-label':r.title+': light up its path',transform:'translate(0,'+(r.y-b.y-10)+')'});
      row.appendChild(sv('title',{},r.title));
      row.appendChild(sv('rect',{x:4,y:0,width:b.w-8,height:20,rx:4,'class':'g-hit'}));
      row.appendChild(sv('text',{x:12,y:14,'class':'g-glyph '+(GLYPH[r.glyph]||'unk')+(r.byName?' byname':'')},r.glyph||'?'));
      row.appendChild(sv('text',{x:28,y:14,'class':'g-col'},r.column));
      if(r.end)row.appendChild(sv('text',{x:b.w-10,y:14,'class':'g-end','text-anchor':'end'},'end'));
      row.addEventListener('click',function(ev){if(moved)return;ev.stopPropagation();select(r.key)});
      row.addEventListener('keydown',function(ev){if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();select(r.key)}});
      g.appendChild(row)});
    gB.appendChild(g)});
  p.appendChild(svg);
  if(lay.edges.some(function(e){return!e.label}))p.appendChild(el('div','g-note','Dashed, unlabelled: the engine couldn\u2019t tell how the value changes.'));
  var hint=el('div','g-hint','Drag to move \\u00b7 wheel or pinch to zoom \\u00b7 click a column to light up its path');p.appendChild(hint);
  // Zoom and pan: one transform, kept per focus while levels change.
  var v=state.views[i],moved=false;
  function apply(){vp.setAttribute('transform','translate('+Math.round(v.x)+','+Math.round(v.y)+') scale('+Math.round(v.k*1000)/1000+')')}
  function size(){var r=svg.getBoundingClientRect();return {w:r.width||800,h:r.height||500}}
  function fit(force){var s=size(),bb=lay.bounds,k=Math.min(1,(s.w-32)/Math.max(1,bb.w),(s.h-32)/Math.max(1,bb.h));
    if(k<0.35&&!force){k=0.35;v={k:k,x:s.w/2-lay.focus.x*k,y:s.h/2-lay.focus.y*k}}
    else{k=Math.max(0.05,k);v={k:k,x:s.w/2-(bb.x+bb.w/2)*k,y:s.h/2-(bb.y+bb.h/2)*k}}
    state.views[i]=v;apply()}
  function zoomAt(k2,px,py){k2=Math.min(3,Math.max(0.05,k2));v.x=px-(px-v.x)*k2/v.k;v.y=py-(py-v.y)*k2/v.k;v.k=k2;apply()}
  function zoomBy(m){var s=size();zoomAt(v.k*m,s.w/2,s.h/2)}
  svg.addEventListener('wheel',function(ev){ev.preventDefault();var r=svg.getBoundingClientRect();zoomAt(v.k*Math.exp(-ev.deltaY*0.0015),ev.clientX-r.left,ev.clientY-r.top)},{passive:false});
  var ptrs={},start=null;
  svg.addEventListener('pointerdown',function(ev){ptrs[ev.pointerId]={x:ev.clientX,y:ev.clientY};moved=false;start={x:ev.clientX,y:ev.clientY,vx:v.x,vy:v.y};var ids=Object.keys(ptrs);if(ids.length===2){var a=ptrs[ids[0]],b=ptrs[ids[1]];start.d=Math.hypot(a.x-b.x,a.y-b.y);start.k=v.k}});
  svg.addEventListener('pointermove',function(ev){if(!ptrs[ev.pointerId]||!start)return;ptrs[ev.pointerId]={x:ev.clientX,y:ev.clientY};var ids=Object.keys(ptrs);
    if(ids.length===2&&start.d){var a=ptrs[ids[0]],b=ptrs[ids[1]],r=svg.getBoundingClientRect();moved=true;zoomAt(start.k*Math.hypot(a.x-b.x,a.y-b.y)/start.d,(a.x+b.x)/2-r.left,(a.y+b.y)/2-r.top);return}
    var dx=ev.clientX-start.x,dy=ev.clientY-start.y;if(!moved&&Math.abs(dx)+Math.abs(dy)<5)return;
    if(!moved){moved=true;try{svg.setPointerCapture(ev.pointerId)}catch(e){}}v.x=start.vx+dx;v.y=start.vy+dy;apply()});
  function up(ev){delete ptrs[ev.pointerId];if(!Object.keys(ptrs).length)start=null;setTimeout(function(){moved=false},0)}
  svg.addEventListener('pointerup',up);svg.addEventListener('pointercancel',up);
  svg.addEventListener('keydown',function(ev){var step=48;
    if(ev.key==='ArrowLeft'){v.x+=step}else if(ev.key==='ArrowRight'){v.x-=step}else if(ev.key==='ArrowUp'){v.y+=step}else if(ev.key==='ArrowDown'){v.y-=step}
    else if(ev.key==='+'||ev.key==='='){zoomBy(1.25);ev.preventDefault();return}else if(ev.key==='-'||ev.key==='_'){zoomBy(1/1.25);ev.preventDefault();return}
    else if(ev.key==='0'){fit(true);ev.preventDefault();return}else return;ev.preventDefault();apply()});
  // Drawn after the panel is in the page, when its size is known.
  p.afterMount=function(){if(v)apply();else fit(false)};
  return p;
}
`

export const GRAPH_CSS = `
.wrap{max-width:1680px}
.page{display:grid;gap:14px;grid-template-columns:minmax(0,1fr)}
.side,.main{min-width:0}
@media (min-width:1100px){.page{grid-template-columns:minmax(320px,400px) minmax(0,1fr);align-items:start}}
.main .deep{margin:0 0 10px;padding-top:0;border-top:0}
.list-bar{border:1px solid var(--line);border-radius:10px;margin:0 0 10px;background:var(--panel)}
.graph{display:flex;flex-direction:column;min-height:480px;height:min(78vh,900px);overflow:hidden}
.g-bar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:6px 10px;padding:8px 10px;border-bottom:1px solid var(--line)}
.g-title{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:600}
.g-tools{display:flex;flex-wrap:wrap;gap:6px}
.g-btn{appearance:none;border:1px solid var(--line-strong);background:var(--panel);color:var(--ink);border-radius:6px;padding:3px 9px;font:inherit;font-size:12.5px;cursor:pointer;min-width:30px}
.g-btn:hover{border-color:var(--accent)}
.g-btn:focus-visible,.g-svg:focus-visible,.g-row:focus-visible,.g-box.collapsed:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.g-svg{flex:1;width:100%;min-height:0;display:block;cursor:grab;touch-action:none;background:var(--bg);-webkit-user-select:none;user-select:none}
.g-svg:active{cursor:grabbing}
.g-hint{font-size:12px;color:var(--faint);padding:6px 10px;border-top:1px solid var(--line)}
.g-rect{fill:var(--panel);stroke:var(--line-strong);stroke-width:1}
.g-box.focus .g-rect{fill:var(--focus);stroke:var(--focus-line);stroke-width:1.5}
.g-box.collapsed{cursor:pointer}
.g-box.collapsed .g-rect{stroke-dasharray:5 4}
.g-name{font:600 12.5px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;fill:var(--ink)}
.g-badge{font:600 11px -apple-system,"Segoe UI",Roboto,sans-serif;fill:var(--muted)}
.g-more{font-size:12px;fill:var(--muted)}
.g-row{cursor:pointer}
.g-hit{fill:transparent}
.g-row:hover .g-hit{fill:var(--accent-soft)}
.g-col{font:12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;fill:var(--ink)}
.g-end{font-size:10.5px;fill:var(--faint)}
.g-glyph{font:700 12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.g-glyph.same{fill:var(--same)}.g-glyph.ren{fill:var(--ren)}.g-glyph.calc{fill:var(--calc)}.g-glyph.agg{fill:var(--agg)}.g-glyph.unk{fill:var(--unk)}
.g-glyph.byname{opacity:.65}
.g-edge path{fill:none;stroke:var(--line-strong);stroke-width:1.4}
.g-edge.same path{stroke:var(--same)}.g-edge.ren path{stroke:var(--ren)}.g-edge.calc path{stroke:var(--calc)}.g-edge.agg path{stroke:var(--agg)}.g-edge.unk path{stroke:var(--unk);stroke-dasharray:4 3}
.g-edge path{stroke-opacity:.55}
.g-note{font-size:12px;color:var(--muted);padding:6px 12px 8px}
.g-elabel{font:700 11px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;fill:var(--muted);paint-order:stroke;stroke:var(--bg);stroke-width:3px}
body.hl .g-edge{opacity:.12}body.hl .g-edge.on{opacity:1}body.hl .g-edge.on path{stroke-opacity:1;stroke-width:2.2}
body.hl .g-row{opacity:.3}body.hl .g-row.on{opacity:1}body.hl .g-row.on .g-hit{fill:var(--accent-soft)}body.hl .g-row.sel .g-hit{fill:var(--focus)}
body.hl .g-box{opacity:.55}body.hl .g-box.has-on,body.hl .g-box.focus{opacity:1}
`
