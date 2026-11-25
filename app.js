'use strict';
/* Qibla — the first-use flow is one tap: "Show my Qibla" → the answer (bearing, compass and the green line).
   The exact turn from a landmark you can see is the optional next tap. The precise tools (picking your spot
   with the target, aiming with the target, coordinates, search, dragging pins) are all still here. */

const $=id=>document.getElementById(id);
let lang=languages[document.documentElement.lang]?document.documentElement.lang:'ar';
try{const saved=localStorage.getItem('qibla-language');if(languages[saved])lang=saved;}catch{}
// Colours of the map overlays come from the theme (style.css), so light and dark both read well.
const css=name=>getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const still=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
const phone=()=>matchMedia('(max-width: 800px)').matches;
const t=(key,params={})=>Object.entries(params).reduce((s,[k,v])=>s.replaceAll('{'+k+'}',String(v)),translations[lang]?.[key]??EN[key]??key);
const number=(n,d=0)=>new Intl.NumberFormat(lang,{maximumFractionDigits:d,minimumFractionDigits:d}).format(n);
const isIOS=/iP(hone|ad|od)/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);

/* ---------- state ---------- */
// stage 1: no spot yet · stage 2: the answer (spot known) · stage 3: the exact turn (a landmark is set)
// mode 'pick' (stage 1) and 'aim' (stage 2) use the centre target; 'idle' otherwise.
let stage=1,mode='idle',world=false;
let spot=null,accuracy=null,spotSource='',spotName='',spotMovedByHand=false;
let landmark=null,draftLandmark=null;
let notice=null; // {title, body, actions:[...]} shown on the start screen when location can't be used
let searchRequest=0,installPrompt=null,searchController=null;
let pin,landmarkPin,accuracyCircle,facingLine,qiblaLine,qiblaHalo,kaabaPin,routeArrows=[],combinedPins=false,routeCache=null,routeKey='';
let draftLine,draftArrow;
let gps={running:false,watch:null,timers:[],best:null,applied:false,request:0};

/* ---------- map ---------- */
const mapReady=typeof L!=='undefined';
const map=mapReady?L.map('map',{zoomControl:false,worldCopyJump:true,minZoom:2,maxZoom:20,maxBounds:[[-85,-540],[85,540]]}).setView([24,35],3):null;
const street=mapReady?L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxNativeZoom:19,maxZoom:20,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'}):null;
const satellite=mapReady?L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{maxNativeZoom:19,maxZoom:20,attribution:'Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics, GIS User Community'}):null;
let layer=street,failedTiles=0,tilesSeen=false,slowTimer=null;

if(map){
  // Leaflet measures #map only when asked. Keep it measuring: the container changes size with phone toolbars,
  // rotation, the sheet, and on a cold WebKit load where style.css applies after this script has started the map.
  if(typeof ResizeObserver!=='undefined')new ResizeObserver(()=>map.invalidateSize({animate:false})).observe($('map'));
  street.addTo(map);
  L.control.scale({imperial:false,position:'bottomleft'}).addTo(map);
  kaabaPin=L.marker(Geo.K,{icon:L.divIcon({className:'',html:'<div class="kaaba-pin">الكعبة · Kaaba</div>',iconSize:[104,29],iconAnchor:[52,14]})}).addTo(map);
  for(const tiles of [street,satellite]){
    tiles.on('tileerror',()=>{failedTiles++;if(failedTiles>=3)showMapProblem('mapSlow');});
    tiles.on('tileload',()=>{failedTiles=0;tilesSeen=true;hideMapProblem();});
  }
  watchForSlowTiles();
  map.on('click',e=>onMapTap([e.latlng.lat,wrap(e.latlng.lng)],e.latlng));
  map.on('move',()=>{if(mode==='aim'){const c=map.getCenter();draftLandmark=[c.lat,wrap(c.lng)];drawAim();}});
  map.on('zoomend moveend',()=>{if(spot){world=map.getZoom()<=7;drawQibla();renderGuide();}});
  map.on('zoomend',()=>{if(spot){drawPins();renderGuide();}});
}

function wrap(lng){return ((lng+540)%360)-180;}
function nearLongitude(p,ref){const out=[...p];while(out[1]-ref>180)out[1]-=360;while(out[1]-ref< -180)out[1]+=360;return out;}
function message(key,params){$('status').textContent=key?t(key,params):'';}
function mapGuard(){if(map)return true;showMapProblem('mapFailed');return false;}

/* A slow or failing map never blocks the answer: say so plainly and offer a retry. */
function showMapProblem(key){$('mapErrorText').textContent=t(key);$('mapRetry').hidden=key==='offline';$('mapError').hidden=false;}
function hideMapProblem(){$('mapError').hidden=true;}
function watchForSlowTiles(){clearTimeout(slowTimer);tilesSeen=false;slowTimer=setTimeout(()=>{if(!tilesSeen&&navigator.onLine)showMapProblem('mapSlow');},9000);}
$('mapRetry').onclick=()=>{if(!map)return;hideMapProblem();failedTiles=0;layer.redraw();watchForSlowTiles();};

/* ---------- what a tap on the map means, in each state ---------- */
function onMapTap(p,latlng){
  if(mode==='pick')return; // the target picks the spot; taps would fight it
  if(map.getZoom()<16){map.setView(latlng,Math.max(16,map.getZoom()+3));message(stage===1?'zoomFirst':'');return;}
  if(stage===1){setSpot(p,null,{source:'map',pan:false});return;}
  if(mode==='aim'){aimAt(p);return;}
  tapLandmark(p);
}
function tapLandmark(p){
  const d=Geo.distance(spot,p);
  if(d<10){message('tooCloseTap');return;}
  if(d>5000){message('tooFarTap');return;}
  setLandmark(p,false);
}

/* ---------- language: a round globe that opens in place ---------- */
function applyLanguage(next,save=true){
  if(!languages[next])return;lang=next;if(save)try{localStorage.setItem('qibla-language',lang);}catch{}
  document.documentElement.lang=lang;document.documentElement.dir=['ar','ur','fa','he'].includes(lang)?'rtl':'ltr';
  document.querySelectorAll('[data-t]').forEach(el=>{el.textContent=t(el.dataset.t);});
  document.querySelectorAll('[data-label]').forEach(el=>{el.setAttribute('aria-label',t(el.dataset.label));el.title=t(el.dataset.label);});
  document.querySelectorAll('[data-placeholder]').forEach(el=>{el.placeholder=t(el.dataset.placeholder);el.setAttribute('aria-label',t(el.dataset.placeholder));});
  $('otherLanguage').value='';renderLanguageControls();renderMode();render();renderHelp();
  if(map){setTimeout(()=>map.invalidateSize(),0);drawPins();drawQibla();if(mode==='aim')drawAim();}
  if(!navigator.onLine)showMapProblem('offline');else if(!$('mapError').hidden)$('mapErrorText').textContent=t('mapSlow');
}
for(const [code,name] of Object.entries(languages)){if(['ar','en'].includes(code))continue;const opt=document.createElement('option');opt.value=code;opt.textContent=name;$('otherLanguage').append(opt);}
document.querySelectorAll('[data-lang]').forEach(b=>b.onclick=()=>{const inGlobe=!!b.closest('#globe');if(b.dataset.lang!==lang)applyLanguage(b.dataset.lang);closeDialog('languageDialog');if(inGlobe)setTimeout(()=>setGlobe(false),still()?0:260);});
$('otherLanguage').onchange=e=>{if(e.target.value){applyLanguage(e.target.value);closeDialog('languageDialog');}};
// Its two meridians turn a quarter as the page arrives and each time it opens; nothing else moves, nothing loops.
let globeOpen=false,globePhase=0,globeFrame=0;
function turnGlobe(){
  const mers=document.querySelectorAll('#globe .mer'),R=8.4,offs=[.45,.45+Math.PI/2],from=globePhase,to=globePhase+Math.PI/2,start=performance.now();globePhase=to;
  const draw=p=>mers.forEach((m,k)=>m.setAttribute('rx',Math.max(.01,R*Math.abs(Math.sin(p+offs[k]))).toFixed(2)));
  if(still()){draw(to);return;}cancelAnimationFrame(globeFrame);
  const step=now=>{const k=Math.min(1,(now-start)/900),e=1-Math.pow(1-k,3);draw(from+(to-from)*e);if(k<1)globeFrame=requestAnimationFrame(step);};globeFrame=requestAnimationFrame(step);
}
function fitGlobe(){$('globe').style.width=globeOpen?($('globe').querySelector('.globe-row').scrollWidth+2)+'px':'';}
function setGlobe(next){if(next===globeOpen)return;globeOpen=next;$('globe').classList.toggle('open',next);$('top').classList.toggle('globe-open',next);$('languageButton').setAttribute('aria-expanded',String(next));$('globeNames').querySelectorAll('button').forEach(b=>b.tabIndex=next?0:-1);fitGlobe();if(next)turnGlobe();}
function renderLanguageControls(){
  document.querySelectorAll('[data-lang]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.lang===lang)));
  const other=!['ar','en'].includes(lang);$('moreLanguages').textContent=other?languages[lang]:t('moreShort');$('moreLanguages').setAttribute('aria-pressed',String(other));
  $('moreLanguages').setAttribute('aria-label',t('moreLanguages'));$('languageButton').setAttribute('aria-label',t('languageNow',{name:languages[lang]}));$('languageButton').title=languages[lang];fitGlobe();
}
$('languageButton').onclick=()=>setGlobe(!globeOpen);
$('moreLanguages').onclick=()=>{setGlobe(false);openDialog('languageDialog');};
document.addEventListener('click',e=>{if(globeOpen&&!$('globe').contains(e.target))setGlobe(false);});
document.addEventListener('keydown',e=>{if(globeOpen&&e.key==='Escape'){setGlobe(false);$('languageButton').focus();}});

/* ---------- light and dark: the visitor's choice is kept; until then the page follows the system ---------- */
const themeColors={light:'#fbfbf8',dark:'#141413'};
function renderMode(){const dark=document.documentElement.dataset.theme==='dark';$('modeButton').setAttribute('aria-pressed',String(dark));$('modeButton').setAttribute('aria-label',t(dark?'themeToLight':'themeToDark'));$('modeButton').title=t(dark?'themeToLight':'themeToDark');}
function setMode(next,save){
  document.documentElement.dataset.theme=next;if(save)try{localStorage.setItem('qibla-mode',next);}catch{}
  document.querySelectorAll('meta[name=theme-color]').forEach(m=>{if(save)m.removeAttribute('media');m.content=save?themeColors[next]:m.media.includes('dark')?themeColors.dark:themeColors.light;});
  renderMode();if(map){drawPins();drawQibla();if(draftLine){map.removeLayer(draftLine);draftLine=null;}if(mode==='aim')drawAim();}
}
$('modeButton').onclick=()=>setMode(document.documentElement.dataset.theme==='dark'?'light':'dark',true);
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change',e=>{let saved=null;try{saved=localStorage.getItem('qibla-mode');}catch{}if(!saved)setMode(e.matches?'dark':'light',false);});
(()=>{let saved=null;try{saved=localStorage.getItem('qibla-mode');}catch{}if(saved)document.querySelectorAll('meta[name=theme-color]').forEach(m=>{m.removeAttribute('media');m.content=themeColors[saved]||themeColors.light;});})();

/* ---------- ink: line icons draw themselves once, in answer to something. Nothing loops. ---------- */
function drawIn(el){if(!el)return;el.classList.remove('drawn');el.querySelectorAll('svg').forEach((s,i)=>s.style.setProperty('--i',String(Math.min(i,7))));void el.offsetWidth;el.classList.add('drawn');}

/* ---------- dialogs and help ---------- */
function closeDialog(id){$(id).close();if(id==='searchDialog')cancelSearch();}
function openDialog(id){$(id).showModal();drawIn($(id));}
document.querySelectorAll('.close-dialog').forEach(b=>b.onclick=()=>closeDialog(b.dataset.dialog));
$('helpButton').onclick=$('aboutMethod').onclick=()=>{renderHelp();openDialog('helpDialog');};
function renderHelp(){
  const c=$('helpContent');c.replaceChildren();
  if(!['ar','en'].includes(lang)){const note=document.createElement('p');note.textContent=t('limited');note.lang='en';c.append(note);}
  for(let i=1;i<=5;i++){const h=document.createElement('h3'),p=document.createElement('p');h.textContent=t('help'+i);p.textContent=t('help'+i+'body');c.append(h,p);}
  const ll=(spot??Geo.K).join(',');
  $('googleLink').href='https://www.google.com/maps/search/?api=1&query='+encodeURIComponent(ll);
  $('appleLink').href='https://maps.apple.com/?ll='+encodeURIComponent(ll)+'&z=18';
  $('installHelp').textContent=t(matchMedia('(display-mode: standalone)').matches?'installed':'installIOS');
}

/* ---------- rendering ---------- */
const directions=['dirN','dirNE','dirE','dirSE','dirS','dirSW','dirW','dirNW'];
const cardinal=b=>t(directions[Math.round(b/45)%8]);
function state(){return stage===1?(mode==='pick'?'pick':'start'):stage===2?(mode==='aim'?'aim':'answer'):'exact';}
let inkState='';
function render(){
  const s=state();
  if(s!==inkState){inkState=s;drawIn(document.querySelector('.panel'));}
  document.body.dataset.state=s;
  $('startPanel').hidden=s!=='start';
  $('answerPanel').hidden=s!=='answer';
  $('modePanel').hidden=s!=='pick'&&s!=='aim';
  $('resultPanel').hidden=s!=='exact';
  $('crosshair').hidden=!(s==='pick'||s==='aim');
  $('crosshair').classList.toggle('aiming',s==='aim');
  $('centerConfirm').classList.toggle('aiming',s==='aim');

  // start
  $('locateButton').querySelector('span').textContent=gps.running?(gps.best?t('findingAcc',{n:number(gps.best.accuracy)}):t('finding')):notice&&notice.retry?t('tryAgain'):t('showQibla');
  $('startPanel').querySelector('.lead-copy').hidden=!!notice;$('startPanel').querySelector('.other-ways').hidden=!!notice;$('coordinatesButton').hidden=!!notice;
  $('locateButton').classList.toggle('busy',gps.running);
  $('locateButton').setAttribute('aria-busy',String(gps.running));
  renderNotice();

  // pick / aim with the target
  if(s==='pick'||s==='aim'){
    $('modeTitle').textContent=t(s==='pick'?'pickTitle':'aimTitle');
    $('modeCopy').textContent=t(s==='pick'?'pickCopy':'aimCopy');
    $('aimGuide').hidden=s!=='aim';
    $('centerConfirm').querySelector('span').textContent=t(s==='pick'?'confirmSpot':'confirmLook');
    $('centerConfirm').disabled=s==='aim'&&!validAim();
  }
  if(s!=='aim')$('aimDetail').textContent='';else updateAimDetail();

  if(s==='answer')renderAnswer();
  if(s==='exact')renderResult();
  $('worldView').textContent=t(world?'localView':'wholeRoute');
  renderGuide();
}
function renderNotice(){
  $('notice').hidden=!notice;if(!notice)return;
  $('noticeTitle').textContent=t(notice.title);$('noticeBody').textContent=t(notice.body);
  const box=$('noticeActions');box.replaceChildren();
  for(const a of notice.actions){const b=document.createElement('button');b.type='button';b.className=a.primary?'secondary':'text-button';b.textContent=t(a.label);b.onclick=a.run;box.append(b);}
}
let compassKey='';
function renderAnswer(){
  const q=Geo.qibla(spot);
  if(!q.usable){$('answerBearing').textContent='—';$('answerWhere').textContent=t('special');$('compassArrow').style.display='none';$('answerNote').textContent='';return;}
  $('compassArrow').style.display='';
  $('answerBearing').textContent=number(q.bearing,0)+'°';
  $('answerWhere').textContent=cardinal(q.bearing)+' · '+t('toKaabaKm',{n:number(q.distance/1000)});
  // The arrow turns once from north to the Qibla when the answer first appears for this spot.
  const arrow=$('compassArrow'),key=spot.map(v=>v.toFixed(4)).join();
  if(key!==compassKey&&!still()){compassKey=key;arrow.style.transition='none';arrow.style.transform='rotate(0deg)';void arrow.getBoundingClientRect();requestAnimationFrame(()=>{arrow.style.transition='';arrow.style.transform='rotate('+q.bearing+'deg)';});}
  else arrow.style.transform='rotate('+q.bearing+'deg)';
  $('answerNote').textContent=accuracy!==null&&accuracy>30?t('approxSpot',{n:number(accuracy)}):spotSource==='search'?t('basedOn',{name:spotName}):t('dragDot');
}
function renderResult(){
  const q=Geo.qibla(spot);
  $('bearingValue').textContent=q.usable?number(q.bearing,1)+'°':'—';
  $('distanceValue').textContent=number(q.distance/1000)+' km';
  $('accuracyNote').textContent=t(!q.usable?'special':landmark&&accuracy!==null&&accuracy>Geo.distance(spot,landmark)/5?'weakBaseline':accuracy>25?'weakAccuracy':'accuracy');
  $('turnArc').setAttribute('d','');
  if(!q.usable||!landmark){$('turnTitle').textContent='—';$('turnDescription').textContent=t('special');$('directionArrow').style.display='none';return;}
  $('directionArrow').style.display='';
  const delta=Geo.turn(Geo.bearing(spot,landmark),q.bearing);
  $('turnTitle').textContent=Math.abs(delta)<1?t('aligned'):t(delta<0?'left':'right',{n:number(Math.abs(delta))});
  $('turnDescription').textContent=t('turnHint');
  turnDial(delta);
  if(Math.abs(delta)>1){const a=delta*Math.PI/180,x=80+55*Math.sin(a),y=80-55*Math.cos(a);$('turnArc').setAttribute('d',`M80 25 A55 55 0 0 ${delta>=0?1:0} ${x} ${y}`);}
}
let dialKey='';
function turnDial(delta){
  const arrow=$('directionArrow'),key=spot.join()+'|'+landmark.join(),card=document.querySelector('.result-card');
  arrow.style.transform='rotate('+delta+'deg)';if(key===dialKey)return;dialKey=key;if(still())return;
  card.classList.remove('turning');arrow.style.transition='none';arrow.style.transform='rotate(0deg)';void arrow.getBoundingClientRect();card.classList.add('turning');
  requestAnimationFrame(()=>{arrow.style.transition='';arrow.style.transform='rotate('+delta+'deg)';});
}
function updateSheetHeight(){document.querySelector('main').style.setProperty('--sheet-height',document.querySelector('.panel').getBoundingClientRect().height+'px');}
function expandGuide(){document.body.classList.remove('guide-collapsed');updateSheetHeight();}
function renderGuide(){
  const s=state();
  document.body.dataset.stage=String(stage);
  $('guideProgress').textContent=s==='start'?'':t({answer:'answerEyebrow',exact:'exactEyebrow',pick:'pickEyebrow',aim:'aimEyebrow'}[s]);
  $('guideBack').hidden=s==='start'||s==='answer';
  $('guideProgress').hidden=s==='start';$('sheetToggle').hidden=s==='start';
  $('reset').hidden=s==='start';
  $('centerConfirm').hidden=!(s==='pick'||s==='aim');$('cancelMode').hidden=!(s==='pick'||s==='aim');
  $('sheetToggle').setAttribute('aria-label',t(document.body.classList.contains('guide-collapsed')?'showDetails':'hideDetails'));
  $('routeHud').hidden=!spot||stage===1;$('viewSwitcher').hidden=!spot||stage===1;
  if(spot){
    const q=Geo.qibla(spot);$('hudBearing').textContent=q.usable?number(q.bearing,1)+'°':'—';$('hudDistance').textContent=number(q.distance/1000)+' km';
    $('detailSpot').textContent=spot.map(v=>v.toFixed(6)).join(', ');
    $('detailTarget').textContent=landmark?landmark.map(v=>v.toFixed(6)).join(', '):'—';
    $('detailSeparation').textContent=landmark?number(Geo.distance(spot,landmark))+' m':'—';
    $('detailHeading').textContent=landmark?number(Geo.bearing(spot,landmark),1)+'°':'—';
  }
  $('nearbyView').classList.toggle('active',!!map&&map.getZoom()>=16);
  $('fullRouteView').classList.toggle('active',!!map&&map.getZoom()<=7);
  $('facingView').disabled=!landmark;
  $('mapHint').textContent=s==='start'?'':s==='pick'?t('tapSpot'):s==='aim'?t('tapLandmark'):s==='answer'?t('tapToExact'):t(world?'routeCurve':'readyHint');
  if(stage===3){$('zoomNote').hidden=!combinedPins;$('zoomNote').textContent=t('combinedHint');}
  updateSheetHeight();
}

/* ---------- drawing on the map ---------- */
function icon(type){return L.divIcon({className:'',html:'<div class="'+type+'-pin"></div>',iconSize:[26,26],iconAnchor:[13,13]});}
function drawPins(){
  if(!map)return;for(const l of [pin,landmarkPin,accuracyCircle,facingLine])if(l)map.removeLayer(l);pin=landmarkPin=accuracyCircle=facingLine=null;
  if(!spot)return;
  combinedPins=false;
  if(landmark){const a=map.latLngToContainerPoint(spot),b=map.latLngToContainerPoint(nearLongitude(landmark,spot[1]));combinedPins=Math.hypot(a.x-b.x,a.y-b.y)<44;}
  const originIcon=combinedPins?L.divIcon({className:'',html:'<div class="person-pin combined"></div>',iconSize:[32,32],iconAnchor:[16,16]}):icon('person');
  // The label sits on the side away from the green line, so the line leaving the dot stays in view.
  const q=Geo.qibla(spot),below=!(q.usable&&q.bearing>100&&q.bearing<260);
  pin=L.marker(spot,{icon:originIcon,draggable:map.getZoom()>=16,zIndexOffset:1000,title:t('imHere'),keyboard:false}).addTo(map).bindTooltip(t(combinedPins?'combinedPoint':'imHere'),{permanent:true,className:'origin-label',direction:below?'bottom':'top',offset:[0,below?16:-16]});
  pin.on('click',()=>{if(combinedPins)showMyView();});
  pin.on('dragstart',()=>{spotMovedByHand=true;stopGPS();});
  pin.on('dragend',()=>{const p=pin.getLatLng();setSpot([p.lat,wrap(p.lng)],null,{source:'map',pan:false,keepLandmark:true});});
  if(accuracy&&map.getZoom()>=14)accuracyCircle=L.circle(spot,{radius:accuracy,color:css('--facing'),weight:1,fillOpacity:.07,interactive:false}).addTo(map);
  if(landmark){
    const end=nearLongitude(landmark,spot[1]);
    facingLine=L.polyline([spot,end],{color:css('--facing'),weight:4,dashArray:'7 8',interactive:false}).addTo(map);
    if(!combinedPins){
      const a=map.latLngToContainerPoint(spot),b=map.latLngToContainerPoint(end),direction=b.x>=a.x?'right':'left';
      landmarkPin=L.marker(end,{icon:icon('landmark'),draggable:map.getZoom()>=16,zIndexOffset:1100,title:t('lookHere'),keyboard:false}).addTo(map).bindTooltip(t('lookHere'),{permanent:true,className:'landmark-label',direction,offset:[direction==='right'?13:-13,0]});
      landmarkPin.on('dragend',()=>{const p=landmarkPin.getLatLng();if(!setLandmark([p.lat,wrap(p.lng)],false))drawPins();});
    }
  }
  $('zoomNote').hidden=!combinedPins;$('zoomNote').textContent=t('combinedHint');
}
function clearRoute(){for(const l of [qiblaLine,qiblaHalo,...routeArrows])if(l&&map)map.removeLayer(l);qiblaLine=qiblaHalo=null;routeArrows=[];}
function drawQibla(){
  if(!map)return;clearRoute();if(!spot){kaabaPin?.setLatLng(Geo.K);return;}
  const q=Geo.qibla(spot);if(!q.usable)return;
  const key=spot.join(',');if(key!==routeKey){routeCache=Geo.route(spot);routeKey=key;}
  const path=routeCache;
  qiblaHalo=L.polyline(path,{color:css('--halo'),weight:9,opacity:.9,smoothFactor:0,interactive:false}).addTo(map);
  qiblaLine=L.polyline(path,{color:css('--qibla'),weight:5,opacity:1,smoothFactor:0,interactive:false}).addTo(map);
  kaabaPin?.setLatLng(path[path.length-1]);
  const projected=path.map(p=>{const v=map.latLngToContainerPoint(p);return [v.x,v.y];}),size=map.getSize();
  for(const a of Geo.mapArrows(projected,size.x,size.y)){
    const p=map.containerPointToLatLng([a.x,a.y]);
    routeArrows.push(L.marker(p,{interactive:false,zIndexOffset:200,icon:L.divIcon({className:'',html:'<div class="line-arrow" style="transform:rotate('+a.angle+'deg)">▲</div>',iconSize:[24,24],iconAnchor:[12,12]})}).addTo(map));
  }
}
function clearDraft(){for(const l of [draftLine,draftArrow])if(l&&map)map.removeLayer(l);draftLine=draftArrow=null;}
function validAim(){return !!spot&&!!draftLandmark&&Geo.distance(spot,draftLandmark)>=10&&Geo.distance(spot,draftLandmark)<=5000;}
function updateAimDetail(){
  const distance=spot&&draftLandmark?Geo.distance(spot,draftLandmark):0;
  $('aimDetail').textContent=distance<10?t('aimTooClose'):distance>5000?t('aimTooFar'):t('aimDistance',{n:number(distance)});
  $('centerConfirm').disabled=!validAim();
}
function drawAim(){
  if(!map||!spot||!draftLandmark||mode!=='aim')return;
  const end=nearLongitude(draftLandmark,spot[1]);
  if(!draftLine)draftLine=L.polyline([spot,end],{color:css('--facing'),weight:4,dashArray:'7 7',interactive:false}).addTo(map);else draftLine.setLatLngs([spot,end]);
  if(draftArrow)map.removeLayer(draftArrow);draftArrow=null;
  const d=Geo.distance(spot,draftLandmark),b=Geo.bearing(spot,draftLandmark);
  if(d>=10&&d<=5000){const p=Geo.destination(spot,b,d*.6);draftArrow=L.marker(nearLongitude(p,spot[1]),{interactive:false,icon:L.divIcon({className:'',html:'<div class="facing-arrow" style="transform:rotate('+b+'deg)"><svg><use href="#i-arrow"/></svg></div>',iconSize:[24,24],iconAnchor:[12,12]})}).addTo(map);}
  updateAimDetail();
}
function aimAt(p){draftLandmark=p;if(map)map.panTo(nearLongitude(p,spot[1]),{animate:false});drawAim();}

/* ---------- views ---------- */
function fitPadding(){
  const rtl=document.documentElement.dir==='rtl';
  if(phone()){const top=stage===3?110:70;return {paddingTopLeft:[rtl?100:40,top],paddingBottomRight:[rtl?40:100,84]};}
  return {paddingTopLeft:[rtl?90:430,100],paddingBottomRight:[rtl?430:90,55]};
}
function showMyView(){if(!map||!spot)return;world=false;map.invalidateSize({animate:false});if(landmark)map.fitBounds([spot,nearLongitude(landmark,spot[1])],{...fitPadding(),maxZoom:19});else map.setView(spot,18);drawPins();drawQibla();renderGuide();}
function showFullRoute(){
  if(!map||!spot)return;if(!Geo.qibla(spot).usable){message('special');return;}
  if(phone())document.body.classList.add('guide-collapsed');
  updateSheetHeight();map.invalidateSize({animate:false});world=true;drawQibla();map.fitBounds(qiblaLine.getBounds(),{...fitPadding(),maxZoom:6});drawPins();renderGuide();
}
$('sheetToggle').onclick=()=>{document.body.classList.toggle('guide-collapsed');renderGuide();};
$('nearbyView').onclick=()=>{if(!map||!spot)return;world=false;map.setView(spot,18);drawPins();drawQibla();renderGuide();};
$('facingView').onclick=showMyView;
$('fullRouteView').onclick=showFullRoute;
$('worldView').onclick=()=>{if(world)showMyView();else showFullRoute();};
if(typeof ResizeObserver!=='undefined')new ResizeObserver(updateSheetHeight).observe(document.querySelector('.panel'));

/* ---------- the flow ---------- */
function setSpot(p,acc=null,{source='',name='',pan=true,keepLandmark=false,keepGPS=false}={}){
  if(!Geo.valid(p)||Math.abs(p[0])>85)throw Error('Coordinates must be within the map limits.');
  if(!keepGPS)stopGPS();
  clearDraft();expandGuide();notice=null;mode='idle';world=false;
  spot=[...p];accuracy=acc;spotSource=source;spotName=name;
  if(!keepLandmark||!landmark||Geo.distance(spot,landmark)<10||Geo.distance(spot,landmark)>5000){landmark=null;stage=2;}else stage=3;
  message('');
  if(map){if(pan)map.setView(spot,source==='search-area'?14:18);drawPins();drawQibla();}
  render();renderHelp();
  return {position:spot,qibla:Geo.qibla(spot)};
}
function setLandmark(p,fit=false){
  if(!spot){message('noSpot');return false;}if(!Geo.valid(p))throw Error('Invalid landmark');
  const d=Geo.distance(spot,p);if(d<10){message('tooCloseTap');return false;}if(d>5000){message('tooFarTap');return false;}
  clearDraft();expandGuide();landmark=[...p];stage=3;mode='idle';world=false;message('');drawPins();drawQibla();render();
  if(map&&fit)showMyView();return true;
}
function startOver(){
  stopGPS();clearDraft();clearRoute();expandGuide();cancelSearch();
  spot=null;landmark=null;draftLandmark=null;accuracy=null;spotSource='';spotName='';spotMovedByHand=false;notice=null;
  stage=1;mode='idle';world=false;combinedPins=false;compassKey='';dialKey='';
  drawPins();drawQibla();message('');$('searchResults').hidden=true;render();renderHelp();
}
let pickBackup=null;
function startPicking(){
  if(!mapGuard())return;stopGPS();clearDraft();expandGuide();notice=null;
  // Picking replaces the current spot; keep it so Cancel can put it back.
  pickBackup=spot?{spot,accuracy,source:spotSource,name:spotName,landmark}:null;
  if(spot)map.setView(spot,Math.max(map.getZoom(),18));
  spot=null;landmark=null;stage=1;mode='pick';message(map.getZoom()<16?'zoomFirst':'');
  drawPins();drawQibla();render();
}
function startAiming(){
  if(!spot||!mapGuard())return;clearDraft();expandGuide();mode='aim';stage=2;landmark=null;
  const c=map.getCenter();draftLandmark=[c.lat,wrap(c.lng)];drawPins();drawAim();render();
}
function cancelMode(){
  if(mode==='aim'){mode='idle';clearDraft();draftLandmark=null;render();return;}
  if(mode==='pick'){
    mode='idle';const b=pickBackup;pickBackup=null;message('');
    if(b){setSpot(b.spot,b.accuracy,{source:b.source,name:b.name,pan:false});if(b.landmark)setLandmark(b.landmark,false);}else render();
  }
}
$('centerConfirm').onclick=()=>{
  if(!mapGuard())return;
  if(map.getZoom()<16){message('zoomFirst');map.setZoom(16);return;}
  const c=map.getCenter(),p=[c.lat,wrap(c.lng)];
  if(mode==='pick'){spotMovedByHand=true;pickBackup=null;setSpot(p,null,{source:'map',pan:false});}
  else if(mode==='aim'&&validAim())setLandmark(draftLandmark,true);
};
$('cancelMode').onclick=cancelMode;
$('guideBack').onclick=()=>{
  if(mode==='aim'||mode==='pick'){cancelMode();return;}
  if(stage===3){landmark=null;stage=2;dialKey='';drawPins();if(map&&spot)map.setView(spot,18);render();}
};
$('reset').onclick=startOver;
$('editLocation').onclick=startPicking;
$('manualButton').onclick=startPicking;
$('useTarget').onclick=startAiming;
$('editLandmark').onclick=()=>{landmark=null;stage=2;dialKey='';drawPins();if(map&&spot)map.setView(spot,18);render();};

/* ---------- location: show the answer as soon as the fix is good enough, then keep refining quietly ---------- */
function stopGPS(){
  gps.request++;if(gps.watch!==null&&navigator.geolocation?.clearWatch)navigator.geolocation.clearWatch(gps.watch);gps.watch=null;
  gps.timers.forEach(clearTimeout);gps.timers=[];const was=gps.running;gps.running=false;if(was)render();
}
function locationNotice(kind){
  // The big button becomes "Try again"; the note offers the other ways in.
  const search={label:'searchShort',run:openSearch},pick={label:'pickShort',run:startPicking};
  notice=kind==='denied'?{title:'deniedTitle',body:isIOS?'deniedIOS':'deniedOther',retry:true,actions:[search,pick]}
    :kind==='unsupported'?{title:'unsupportedTitle',body:'unsupportedBody',retry:false,actions:[search,pick]}
    :{title:'noFixTitle',body:'noFixBody',retry:true,actions:[search,pick]};
  render();drawIn($('notice'));
}
function startGPS(){
  if(gps.running)return; // already looking: a second tap shouldn't quietly cancel
  // Safari won't ask again on the same page after "Don't Allow", but it does after a reload: so reload and carry on.
  if(isIOS&&notice?.title==='deniedTitle'){try{sessionStorage.setItem('qibla-locate','1');}catch{}location.reload();return;}
  if(!navigator.geolocation||!window.isSecureContext){locationNotice('unsupported');return;}
  stopGPS();notice=null;gps.running=true;gps.best=null;gps.applied=false;spotMovedByHand=false;const request=gps.request,started=Date.now();render();
  const apply=()=>{if(request!==gps.request||gps.applied||!gps.best)return;gps.applied=true;setSpot(gps.best.point,gps.best.accuracy,{source:'gps',keepGPS:true});};
  const success=pos=>{
    if(request!==gps.request)return;
    const point=[pos.coords.latitude,pos.coords.longitude],acc=pos.coords.accuracy;
    if(!Geo.valid(point)||Math.abs(point[0])>85||!Number.isFinite(acc)||acc<0)return;
    const better=!gps.best||acc<gps.best.accuracy;if(better)gps.best={point,accuracy:acc};
    if(!gps.applied){if(acc<=100||Date.now()-started>5000)apply();else render();}
    else if(better&&!spotMovedByHand){ // a sharper fix moves the dot; the answer and any landmark follow
      spot=point;accuracy=acc;if(landmark&&(Geo.distance(spot,landmark)<10||Geo.distance(spot,landmark)>5000)){landmark=null;stage=2;}
      drawPins();drawQibla();render();
    }
    if(acc<=12)stopGPS();
  };
  const failure=e=>{
    if(request!==gps.request)return;
    if(gps.applied||gps.best){apply();stopGPS();return;}
    stopGPS();locationNotice(e.code===1?'denied':'nofix');
  };
  gps.timers.push(setTimeout(apply,5000)); // a rough fix after 5 s beats waiting
  gps.timers.push(setTimeout(()=>{if(request!==gps.request)return;const had=!!gps.best;apply();stopGPS();if(!had)locationNotice('nofix');},25000));
  const options={enableHighAccuracy:true,timeout:20000,maximumAge:15000};
  if(navigator.geolocation.watchPosition)gps.watch=navigator.geolocation.watchPosition(success,failure,options);
  else navigator.geolocation.getCurrentPosition(success,failure,options);
}
$('locateButton').onclick=startGPS;
window.addEventListener('pagehide',stopGPS);

/* ---------- coordinates ---------- */
$('coordinatesButton').onclick=()=>{stopGPS();$('coordinateError').textContent='';$('coordinatePaste').value='';if(spot){$('latitude').value=spot[0];$('longitude').value=spot[1];}openDialog('coordinatesDialog');};
$('coordinatePaste').oninput=()=>{const p=Places.coordinates($('coordinatePaste').value);if(p){$('latitude').value=p[0];$('longitude').value=p[1];$('coordinateError').textContent='';}};
for(const id of ['latitude','longitude'])$(id).addEventListener('input',()=>{$('coordinatePaste').value='';$('coordinateError').textContent='';});
$('coordinateForm').onsubmit=e=>{
  e.preventDefault();let p;const pasted=$('coordinatePaste').value.trim();
  if(pasted)p=Places.coordinates(pasted);else{const a=Places.digits($('latitude').value).trim(),b=Places.digits($('longitude').value).trim();if(a&&b)p=Places.coordinates(a+','+b);}
  if(!p){$('coordinateError').textContent=t('invalidCoordinates');return;}
  closeDialog('coordinatesDialog');setSpot(p,null,{source:'coords'});
};

/* ---------- map layers and tools ---------- */
function switchLayer(selected){
  if(!mapGuard())return;map.removeLayer(layer);layer=selected;failedTiles=0;hideMapProblem();layer.addTo(map);watchForSlowTiles();
  $('map').dataset.layer=layer===street?'street':'satellite';
  $('streetButton').classList.toggle('active',layer===street);$('satelliteButton').classList.toggle('active',layer===satellite);
  $('streetButton').setAttribute('aria-pressed',String(layer===street));$('satelliteButton').setAttribute('aria-pressed',String(layer===satellite));
}
$('streetButton').onclick=()=>switchLayer(street);$('satelliteButton').onclick=()=>switchLayer(satellite);
$('zoomIn').onclick=()=>map?.zoomIn();$('zoomOut').onclick=()=>map?.zoomOut();
$('recenter').onclick=()=>{if(!spot){startGPS();return;}world=false;map?.setView(spot,18);drawQibla();render();};

/* ---------- place search (Photon / OpenStreetMap) ---------- */
let searchTimer=null,lastSearch=0;const searchCache=new Map();
function cancelSearch(){if(searchTimer!==null)clearTimeout(searchTimer);searchTimer=null;searchController?.abort();searchController=null;searchRequest++;$('searchResults').setAttribute('aria-busy','false');}
function openSearch(){stopGPS();openDialog('searchDialog');$('searchStatus').textContent=t('searchStart');$('searchInput').focus();}
$('searchOpener').onclick=$('searchPlaceButton').onclick=openSearch;
$('searchCoordinates').onclick=()=>{closeDialog('searchDialog');$('coordinatesButton').onclick();};
$('searchDialog').addEventListener('close',cancelSearch);
function choosePlace(item){
  closeDialog('searchDialog');$('searchInput').blur();
  setSpot(item.point,null,{source:item.kind==='area'?'search-area':'search',name:item.name});
  if(item.kind==='area')spotSource='search';render();
}
function showPlaceResults(items){
  const box=$('searchResults');box.replaceChildren();box.hidden=false;
  if(!items.length){$('searchStatus').textContent=t('noResults');box.hidden=true;return;}
  $('searchStatus').textContent=t('resultsCount',{n:number(items.length)});
  for(const item of items){const button=document.createElement('button');button.type='button';const name=document.createElement('strong'),address=document.createElement('small'),tag=document.createElement('span');name.textContent=item.name;address.textContent=item.address;tag.className='result-tag';tag.textContent=t(item.kind);button.append(name,address,tag);button.onclick=()=>choosePlace(item);box.append(button);}
}
async function searchPlaces(){
  const query=$('searchInput').value.trim();if(query.length<2)return;
  if(searchTimer!==null)clearTimeout(searchTimer);searchTimer=null;
  searchController?.abort();const seq=++searchRequest;
  const coords=Places.coordinates(query);
  if(coords){showPlaceResults([{point:coords,name:t('coordinates'),address:coords.map(v=>v.toFixed(6)).join(', '),kind:'place'}]);return;}
  if(/^https?:\/\//i.test(query)||/^[-+\d٠-٩۰-۹]/.test(query)&&/[;,،]/.test(query)&&!/[A-Za-z]/.test(query)){$('searchResults').hidden=true;$('searchStatus').textContent=t('invalidCoordinates');return;}
  const wait=1100-(Date.now()-lastSearch);if(wait>0){searchTimer=setTimeout(searchPlaces,wait);return;}
  const focus=spot??(map&&map.getZoom()>=10?[map.getCenter().lat,wrap(map.getCenter().lng)]:null);
  const key=lang+'|'+query.toLowerCase()+'|'+(focus?focus.map(v=>v.toFixed(2)).join(','):'');
  if(searchCache.has(key)){showPlaceResults(searchCache.get(key));return;}
  const controller=new AbortController();searchController=controller;lastSearch=Date.now();
  $('searchStatus').textContent=t('searching');$('searchResults').hidden=true;$('searchResults').setAttribute('aria-busy','true');
  const timeout=setTimeout(()=>controller.abort(),12000);
  try{
    const url=new URL('https://photon.komoot.io/api/');url.searchParams.set('q',query);url.searchParams.set('limit','7');
    if(['en','de','fr'].includes(lang))url.searchParams.set('lang',lang);
    // Only an approximate position (two decimals, about 1 km) is sent to bias the results.
    if(focus){url.searchParams.set('lat',focus[0].toFixed(2));url.searchParams.set('lon',focus[1].toFixed(2));}
    const response=await fetch(url,{signal:controller.signal,credentials:'omit'});if(!response.ok)throw Error('Place search failed');
    const data=await response.json();if(seq!==searchRequest)return;const items=Places.results(data);
    if(searchCache.size>=30)searchCache.delete(searchCache.keys().next().value);searchCache.set(key,items);showPlaceResults(items);
  }catch{if(seq===searchRequest)$('searchStatus').textContent=t('searchFailed');}
  finally{clearTimeout(timeout);if(seq===searchRequest)$('searchResults').setAttribute('aria-busy','false');}
}
$('searchForm').onsubmit=e=>{e.preventDefault();searchPlaces();};
$('searchInput').addEventListener('input',()=>{cancelSearch();$('searchResults').hidden=true;$('searchStatus').textContent=t('searchStart');if($('searchInput').value.trim().length>=3)searchTimer=setTimeout(searchPlaces,850);});
$('searchInput').addEventListener('keydown',e=>{if(e.key==='ArrowDown'){const first=$('searchResults').querySelector('button');if(first){e.preventDefault();first.focus();}}});
$('searchResults').addEventListener('keydown',e=>{if(!['ArrowDown','ArrowUp'].includes(e.key))return;const buttons=[...$('searchResults').querySelectorAll('button')],i=buttons.indexOf(document.activeElement);if(i<0)return;e.preventDefault();buttons[(i+(e.key==='ArrowDown'?1:buttons.length-1))%buttons.length].focus();});

/* ---------- connection, install, service worker ---------- */
window.addEventListener('offline',()=>showMapProblem('offline'));
window.addEventListener('online',()=>{hideMapProblem();layer?.redraw();watchForSlowTiles();});
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installPrompt=e;});
$('installButton').onclick=async()=>{if(installPrompt){await installPrompt.prompt();installPrompt=null;}else{$('installHelp').textContent=t('installIOS');$('installHelp').scrollIntoView({block:'nearest'});}};
if('serviceWorker' in navigator)navigator.serviceWorker.register('sw.js').catch(()=>{});

/* ---------- start ---------- */
applyLanguage(lang,false);
drawIn(document.querySelector('.top .brand'));drawIn(document.querySelector('.panel'));setTimeout(turnGlobe,250);
if(!mapReady)showMapProblem('mapFailed');else if(!navigator.onLine)showMapProblem('offline');
// Someone who already allowed location gets the answer without a tap.
// After "Try again" on iPhone the page has reloaded; Safari asks again only on a fresh tap, so say so.
let resume=false;try{resume=sessionStorage.getItem('qibla-locate')==='1';sessionStorage.removeItem('qibla-locate');}catch{}
if(resume){const lead=$('startPanel').querySelector('.lead-copy');lead.dataset.t='tapAllow';lead.textContent=t('tapAllow');lead.classList.add('emphasis');}
else navigator.permissions?.query({name:'geolocation'}).then(s=>{if(s.state==='granted'&&stage===1&&mode==='idle'&&!gps.running)startGPS();}).catch(()=>{});

/* ---------- tools for assistants (WebMCP) ---------- */
if(document.modelContext?.registerTool){
  const lifecycle=new AbortController();
  const register=tool=>{try{Promise.resolve(document.modelContext.registerTool(tool,{signal:lifecycle.signal})).catch(()=>{});}catch{}};
  register({name:'set_qibla_position',title:'Set Qibla map position',description:'Set the place where the user is standing, clear the old landmark, and display its Qibla line.',inputSchema:{type:'object',properties:{latitude:{type:'number',minimum:-85,maximum:85},longitude:{type:'number',minimum:-180,maximum:180}},required:['latitude','longitude'],additionalProperties:false},annotations:{readOnlyHint:false},execute:input=>{if(!input||!Number.isFinite(input.latitude)||!Number.isFinite(input.longitude))throw Error('Numeric coordinates required');return setSpot([input.latitude,input.longitude],null,{source:'coords'});}});
  register({name:'set_facing_landmark',title:'Set the landmark the user faces',description:'Set a visible landmark between 10 m and 5 km from the current position and show the turn toward Qibla.',inputSchema:{type:'object',properties:{latitude:{type:'number'},longitude:{type:'number'}},required:['latitude','longitude'],additionalProperties:false},annotations:{readOnlyHint:false},execute:input=>{if(!input||!Geo.valid([input.latitude,input.longitude]))throw Error('Valid coordinates required');if(!setLandmark([input.latitude,input.longitude]))throw Error('Set a position first and choose a landmark between 10 m and 5 km away');const q=Geo.qibla(spot);return {bearing:q.bearing,usable:q.usable,turnDegrees:q.usable?Geo.turn(Geo.bearing(spot,landmark),q.bearing):null};}});
  window.addEventListener('pagehide',()=>lifecycle.abort(),{once:true});
}
