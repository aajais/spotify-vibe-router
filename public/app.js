let vibes = [];
let currentTab = 'overview';
let compareState = null;
let compareLastAt = 0;
let vibeDrillRows = [];
let lowApiMode = localStorage.getItem('lowApiMode') === '1';

function showTab(name){
  currentTab = name;
  document.querySelectorAll('.tabpanel').forEach(el=>el.style.display='none');
  const el = document.getElementById('tab-'+name); if(el) el.style.display='block';
  document.querySelectorAll('[data-tab]').forEach(b=>{
    const active = b.getAttribute('data-tab')===name;
    b.style.borderColor = active ? '#2c6b4d' : '#1e3e2f';
    b.style.background = active ? 'linear-gradient(180deg,#163326,#0f1714)' : '#0f1714';
    b.style.color = active ? '#daf7e9' : '#b7dbc8';
  });
}

function toast(msg, ok=true){
  const el=document.getElementById('toast'); if(!el) return;
  el.style.color=ok?'#22c55e':'#f59e0b'; el.textContent=msg;
  setTimeout(()=>{ if(el.textContent===msg) el.textContent=''; }, 5000);
}

function updateLowApiUi(){
  const b=document.getElementById('btnToggleLowApi');
  if(!b) return;
  b.textContent='Low API: '+(lowApiMode?'ON':'OFF');
  b.style.borderColor = lowApiMode ? '#2c6b4d' : '#1e3e2f';
  b.style.background = lowApiMode ? 'linear-gradient(180deg,#163326,#0f1714)' : '#0f1714';
  b.style.color = lowApiMode ? '#daf7e9' : '#b7dbc8';
}

function toggleLowApiMode(){
  lowApiMode = !lowApiMode;
  localStorage.setItem('lowApiMode', lowApiMode ? '1' : '0');
  updateLowApiUi();
  toast('Low API mode '+(lowApiMode?'enabled':'disabled'), true);
}

function buildSelect(){
  const root=document.createElement('div');
  root.className='dd';
  const trigger=document.createElement('button');
  trigger.type='button';
  trigger.className='dd-trigger';
  trigger.innerHTML='<span data-value>Select vibes</span><span>▾</span>';

  const menu=document.createElement('div');
  menu.className='dd-menu';
  const selected=new Set();

  function refreshLabel(){
    const arr=[...selected];
    trigger.querySelector('[data-value]').textContent = arr.length ? (arr.length===1 ? arr[0] : (arr.length+' selected')) : 'Select vibes';
  }

  for(const v of vibes){
    const item=document.createElement('button');
    item.type='button';
    item.className='dd-item';
    item.innerHTML='<span style="display:flex;align-items:center;gap:8px"><input type="checkbox" /> <span>'+v+'</span></span>';
    const cb=item.querySelector('input');
    item.onclick=(e)=>{
      e.preventDefault();
      cb.checked=!cb.checked;
      if(cb.checked) selected.add(v); else selected.delete(v);
      refreshLabel();
    };
    menu.appendChild(item);
  }

  trigger.onclick=(e)=>{ e.preventDefault(); root.classList.toggle('open'); };
  document.addEventListener('click',(e)=>{ if(!root.contains(e.target)) root.classList.remove('open'); });

  root.appendChild(trigger);
  root.appendChild(menu);
  root.getValues=()=>{
    const arr=[...selected];
    return arr.length ? arr : [vibes[0]];
  };
  return root;
}

async function labelTrack(trackId, vibeKey){
  await fetch('/api/label-track?trackId='+encodeURIComponent(trackId)+'&vibeKey='+encodeURIComponent(vibeKey));
  await refreshOverview();
}

async function labelTrackMulti(trackId, vibeKeys){
  const qs = encodeURIComponent((vibeKeys||[]).join(','));
  await fetch('/api/label-track-multi?trackId='+encodeURIComponent(trackId)+'&vibeKeys='+qs);
  await refreshOverview();
}

function lineTop(items, n=3){ return (items||[]).slice(0,n).map(x=>x.key+'('+x.count+')').join(', '); }

async function runOnce(){
  const r = await fetch('/run-once').then(x=>x.json()).catch(()=>({ok:false,error:'request failed'}));
  if(!r.ok){ toast('Run failed: '+(r.error||'unknown'), false); return; }
  if((r.processed||0)===0) toast('Run complete: 0 new songs found', false);
  else toast('Run complete: processed '+r.processed+' / added '+r.added, true);
  await refreshAll();
}

async function diagnose(){
  const r = await fetch('/diagnose-audio-features').then(x=>x.json()).catch(()=>({ok:false,error:'request failed'}));
  if(r && typeof r.status !== 'undefined') toast('Audio diagnose status: '+r.status, r.status===200);
  else toast('Audio diagnose failed', false);
}

async function calibrate(){
  const r = await fetch('/api/calibrate-thresholds').then(x=>x.json()).catch(()=>({ok:false,error:'request failed'}));
  if(r.ok) toast('Calibrated '+Object.keys(r.thresholds||{}).length+' vibe thresholds', true);
  else toast('Calibration failed', false);
  await refreshSystem();
}

async function refreshOverview(){
  const [a,q,sys] = await Promise.all([
    fetch('/api/analytics').then(x=>x.json()),
    fetch('/api/low-confidence').then(x=>x.json()),
    fetch('/api/system-info').then(x=>x.json())
  ]);
  const s=a.summary||{};
  const cb=s.confidenceBands||{};
  const rs=sys.spotifyRateState||{};
  const ps=sys.pollState||{};
  const kpis='Polls: '+(s.totalPolls||0)+' | Classified: '+(s.totalClassified||0)+' | Conf(H/M/L): '+(cb.high||0)+'/'+(cb.medium||0)+'/'+(cb.low||0)+' | 429s: '+(rs.rate429||0)+' | Retries: '+(rs.retries||0)+' | Poll: '+(ps.running?'running':'idle')+' | Labeled: '+((a.quality&&a.quality.labeledCount)||0)+' | Top1(labeled): '+(((a.quality&&a.quality.top1AccuracyOnLabeled)==null)?'n/a':(a.quality.top1AccuracyOnLabeled*100).toFixed(1)+'%');
  const limitedRecently = rs.lastRateLimitAtMs && (Date.now() - rs.lastRateLimitAtMs < 5*60*1000);
  const recovering = limitedRecently && !ps.running;
  const badge = limitedRecently ? (recovering ? '<span class="chip" style="border-color:#2c6b4d;background:#13231b">Status: Recovering</span>' : '<span class="chip" style="border-color:#2c6b4d;background:#183026">Status: Rate Limited</span>') : '<span class="chip">Status: Healthy</span>';
  const k=document.getElementById('kpis'); if(k) k.innerHTML='<div style="display:flex;flex-wrap:wrap;gap:8px">'+badge+kpis.split(' | ').map(x=>'<span class="chip">'+x+'</span>').join('')+'</div>';

  const vc=s.vibeCounts||{};
  const ordered=vibes.map(v=>[v, vc[v]||0]);
  const extras=Object.entries(vc).filter(([k])=>!vibes.includes(k));
  const entries=[...ordered, ...extras].sort((x,y)=>y[1]-x[1]);
  const max=Math.max(1,...entries.map(e=>e[1]));
  const bars=entries.map(([k,v])=>{
    const w=Math.max(2,Math.round((v/max)*100));
    return '<div class="row"><div>'+k+'</div><div class="track"><div class="fill" style="width:'+w+'%"></div></div><div>'+v+'</div></div>';
  }).join('') || '<div class="tiny">No data</div>';
  const b=document.getElementById('bars'); if(b) b.innerHTML='<div class="bars">'+bars+'</div>';

  const tracks=(a.tracks||[]).slice(-500);
  const bands={high:0,medium:0,low:0};
  const margins=[0,0,0,0,0];
  for(const t of tracks){
    if(t.confidenceBand && bands[t.confidenceBand]!==undefined) bands[t.confidenceBand]++;
    const m=Number(t.margin||0);
    if(m<0.1) margins[0]++; else if(m<0.2) margins[1]++; else if(m<0.3) margins[2]++; else if(m<0.4) margins[3]++; else margins[4]++;
  }
  const maxBand=Math.max(1,bands.high,bands.medium,bands.low);
  const cd=document.getElementById('confDistOverview'); if(cd){
    cd.innerHTML='<div class="bars">'+['high','medium','low'].map(k=>{
      const w=Math.max(2,Math.round((bands[k]/maxBand)*100));
      const color=(k==='high'?'#8DC4AA':k==='medium'?'#669A79':'#1E5E3F');
      return '<div class="row"><div>'+k+'</div><div class="track"><div class="fill" style="width:'+w+'%;background:'+color+'"></div></div><div>'+bands[k]+'</div></div>';
    }).join('')+'</div>';
  }
  const labels=['0-0.1','0.1-0.2','0.2-0.3','0.3-0.4','0.4+'];
  const maxM=Math.max(1,...margins);
  const md=document.getElementById('marginDistOverview'); if(md){
    md.innerHTML='<div class="bars">'+labels.map((lbl,i)=>{
      const w=Math.max(2,Math.round((margins[i]/maxM)*100));
      return '<div class="row"><div>'+lbl+'</div><div class="track"><div class="fill" style="width:'+w+'%;background:#1E5E3F"></div></div><div>'+margins[i]+'</div></div>';
    }).join('')+'</div>';
  }

  const ql=document.getElementById('quality'); if(ql) ql.textContent=JSON.stringify(a.quality||{}, null, 2);
  const pl=document.getElementById('polls'); if(pl) pl.textContent=(a.polls||[]).slice(-30).map(x=>new Date(x.atMs).toLocaleString()+' | new='+x.newTracksDetected+' processed='+x.processed+' added='+x.added).join('\n') || 'No polls yet';

  const qel=document.getElementById('queue'); if(qel){
    qel.innerHTML='';
    for(const t of (q.items||[]).slice(0,20)){
      const card=document.createElement('div');
      card.style.cssText='padding:10px;border:1px solid #1f3d31;border-radius:10px;margin:8px 0;background:#0a120f';
      card.innerHTML='<b>'+(t.trackName||'')+'</b> — '+(t.artist||'')+' <small>(score '+(t.topScore==null?'n/a':t.topScore)+')</small><br/>pred: '+(((t.selectedVibes||[])[0])||'?');
      const row=document.createElement('div'); row.style.cssText='margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap';
      const sel=buildSelect(); row.appendChild(sel);
      const btn=document.createElement('button'); btn.textContent='Save labels'; btn.className='btn';
      btn.onclick=()=>labelTrackMulti(t.trackId, sel.getValues());
      const done=document.createElement('button'); done.textContent='Looks good, remove'; done.className='btn';
      done.onclick=async()=>{await fetch('/api/dismiss-low-confidence?trackId='+encodeURIComponent(t.trackId)); await refreshOverview();};
      row.appendChild(btn); row.appendChild(done); card.appendChild(row); qel.appendChild(card);
    }
    if(!(q.items||[]).length) qel.textContent='No low-confidence items';
  }
}

function setAnalyticsLoading(on){
  const el=document.getElementById('analyticsLoading');
  if(el) el.style.display=on?'block':'none';
}

async function refreshAnalytics(){
  setAnalyticsLoading(true);
  try {
    const [r,a] = await Promise.all([
      fetch('/api/rewind').then(x=>x.json()),
      fetch('/api/analytics').then(x=>x.json()).catch(()=>({tracks:[]}))
    ]);
    const years=Object.entries(r.byYear||{}).sort((a,b)=>Number(a[0])-Number(b[0]));
    const yearVals=years.map(([,v])=>v.total||0);
    const maxYear=Math.max(1,...yearVals);
    const yearChart=years.map(([y,v])=>{
      const h=Math.max(8,Math.round((v.total/maxYear)*140));
      return '<div style="display:flex;flex-direction:column;align-items:center;gap:8px"><div class="tiny">'+v.total+'</div><div style="width:26px;height:'+h+'px;border-radius:10px;background:linear-gradient(180deg,#8DC4AA,#1E5E3F);animation:grow .7s ease both"></div><div class="tiny">'+y+'</div></div>';
    }).join('');
    const ry=document.getElementById('rewindYear'); if(ry) ry.innerHTML='<div style="display:flex;align-items:flex-end;gap:10px;height:190px">'+yearChart+'</div>';

    const months=Object.entries(r.byMonth||{}).sort((a,b)=>Number(a[0])-Number(b[0]));
    const mVals=months.map(([,v])=>v.total||0);
    const maxMonth=Math.max(1,...mVals);
    const monthSvgPts=months.map(([m,v],i)=>{
      const x=20+i*((320)/(Math.max(1,months.length-1))); const y=160-((v.total||0)/maxMonth)*120; return {x,y,m,total:v.total||0};
    });
    const path=monthSvgPts.map((p,i)=>(i?'L':'M')+p.x+','+p.y).join(' ');
    const dots=monthSvgPts.map(p=>'<circle cx="'+p.x+'" cy="'+p.y+'" r="4" fill="#8DC4AA"></circle><text x="'+p.x+'" y="178" text-anchor="middle" fill="#8DC4AA" font-size="10">'+p.m+'</text>').join('');
    const rm=document.getElementById('rewindMonth'); if(rm) rm.innerHTML='<svg viewBox="0 0 360 190" width="100%" height="190"><path d="'+path+'" fill="none" stroke="#8DC4AA" stroke-width="3"/><path d="'+path+' L 340,160 L 20,160 Z" fill="rgba(141,196,170,0.14)"/>'+dots+'</svg>';

    const latestYear = years.length ? years[years.length-1][0] : null;
    const latest=latestYear ? r.byYear[latestYear] : null;
    const artists=latest?.topArtists||[];
    const tracks=latest?.topTracks||[];
    const renderRows=(arr)=>{
      const mx=Math.max(1,...arr.map(x=>x.count||0));
      return '<div class="bars">'+arr.map(x=>'<div class="row"><div>'+x.key+'</div><div class="track"><div class="fill" style="width:'+Math.max(2,Math.round((x.count/mx)*100))+'%"></div></div><div>'+x.count+'</div></div>').join('')+'</div>';
    };
    const ra=document.getElementById('rewindArtists'); if(ra) ra.innerHTML=artists.length?renderRows(artists):'<div class="tiny">No data</div>';
    const rt=document.getElementById('rewindTracks'); if(rt) rt.innerHTML=tracks.length?renderRows(tracks):'<div class="tiny">No data</div>';

    const jm=document.getElementById('rewindJourney');
    if(jm){
      const milestones=(r.journey?.milestones||[]).slice(0,6);
      jm.innerHTML = milestones.length
        ? milestones.map(x=>'<div style="padding:8px 10px;margin:6px 0;border:1px solid #1f3d31;border-radius:9px;background:#0c1612"><b>'+x.title+'</b><div class="tiny">'+x.detail+'</div></div>').join('')
        : '<div class="tiny">No milestone data</div>';
    }

    const patt=document.getElementById('rewindPatterns');
    if(patt){
      const p=r.patterns||{};
      patt.innerHTML='<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px">'+
        '<div class="card"><div class="tiny">Discovery Rate</div><div style="font-size:24px">'+(((p.discoveryRate||0)*100).toFixed(1))+'%</div></div>'+
        '<div class="card"><div class="tiny">Artist Diversity</div><div style="font-size:24px">'+(p.artistDiversity||0).toFixed(2)+'</div></div>'+
        '<div class="card"><div class="tiny">Repeat Rate</div><div style="font-size:24px">'+(((p.repeatRate||0)*100).toFixed(1))+'%</div></div>'+
        '<div class="card"><div class="tiny">Peak Month</div><div style="font-size:24px">'+(p.peakMonthLabel||'n/a')+'</div></div>'+
      '</div>';
    }

    const raud=document.getElementById('rewindAudio');
    if(raud){
      const ap=r.audioProfileByYear?.[latestYear]||null;
      if(!ap){
        raud.innerHTML='<div class="tiny">Audio feature profile unavailable</div>';
      } else {
        const rows=[
          ['Energy', ap.energy],
          ['Valence', ap.valence],
          ['Danceability', ap.danceability],
          ['Acousticness', ap.acousticness],
          ['Instrumentalness', ap.instrumentalness],
          ['Speechiness', ap.speechiness],
          ['Liveness', ap.liveness]
        ];
        const bars=rows.map(([k,v])=>'<div class="row"><div>'+k+'</div><div class="track"><div class="fill" style="width:'+Math.max(2,Math.round((Number(v)||0)*100))+'%"></div></div><div>'+((Number(v)||0).toFixed(2))+'</div></div>').join('');
        raud.innerHTML='<div class="bars">'+bars+'</div><div class="tiny" style="margin-top:8px">Tempo avg: '+(ap.tempo||0).toFixed(1)+' BPM • sample '+(ap.sampleSize||0)+' tracks</div>';
      }
    }

    const vd=document.getElementById('rewindVibeDrift');
    if(vd){
      const tracks=(a.tracks||[]).filter(t=>Number.isFinite(Number(t.addedAtMs)));
      const now=new Date();
      const monthKeys=[];
      for(let i=11;i>=0;i--){
        const d=new Date(now.getFullYear(), now.getMonth()-i, 1);
        const k=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');
        monthKeys.push(k);
      }
      const buckets=Object.fromEntries(monthKeys.map(k=>[k,{}]));
      for(const t of tracks){
        const d=new Date(Number(t.addedAtMs));
        const k=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');
        if(!buckets[k]) continue;
        const v=(t.selectedVibes&&t.selectedVibes[0])||'unknown';
        buckets[k][v]=(buckets[k][v]||0)+1;
      }
      const topVibes=Object.entries((a.summary&&a.summary.vibeCounts)||{}).sort((x,y)=>y[1]-x[1]).slice(0,4).map(x=>x[0]);
      const colors=['#8DC4AA','#669A79','#3D7A5F','#1E5E3F'];
      const rows=monthKeys.map(k=>{
        const total=Object.values(buckets[k]||{}).reduce((x,y)=>x+y,0)||1;
        const seg=topVibes.map((v,idx)=>{
          const c=(buckets[k][v]||0); const w=Math.round((c/total)*100);
          return '<div title="'+v+': '+c+'" style="height:14px;width:'+w+'%;background:'+colors[idx%colors.length]+'"></div>';
        }).join('');
        return '<div data-vibe-month="'+k+'" style="display:grid;grid-template-columns:78px 1fr 46px;align-items:center;gap:8px;margin:6px 0;cursor:pointer"><div class="tiny">'+k+'</div><div style="display:flex;border:1px solid #1f3d31;border-radius:8px;overflow:hidden">'+seg+'</div><div class="tiny">'+(total===1&&Object.keys(buckets[k]||{}).length===0?0:total)+'</div></div>';
      }).join('');

      let shiftLabel='n/a';
      let shiftVal=-1;
      for(let i=1;i<monthKeys.length;i++){
        const p=buckets[monthKeys[i-1]]||{}; const c=buckets[monthKeys[i]]||{};
        const pTot=Math.max(1,Object.values(p).reduce((x,y)=>x+y,0));
        const cTot=Math.max(1,Object.values(c).reduce((x,y)=>x+y,0));
        const keys=new Set([...Object.keys(p),...Object.keys(c)]);
        let d=0;
        for(const k of keys){ d += Math.abs((p[k]||0)/pTot - (c[k]||0)/cTot); }
        if(d>shiftVal){ shiftVal=d; shiftLabel=monthKeys[i-1]+' \u2192 '+monthKeys[i]; }
      }

      vd.innerHTML='<div class="tiny" style="margin-bottom:8px">Biggest vibe shift: '+shiftLabel+' (score '+(shiftVal<0?'n/a':shiftVal.toFixed(2))+')</div>'+
        rows+
        '<div class="tiny" style="margin-top:8px">Legend: '+topVibes.map((v,i)=>'<span style="display:inline-flex;align-items:center;gap:4px;margin-right:10px"><span style="display:inline-block;width:10px;height:10px;background:'+colors[i%colors.length]+';border-radius:2px"></span>'+v+'</span>').join('')+'</div>';

      const tracksByMonth = {};
      for (const t of tracks) {
        const d = new Date(Number(t.addedAtMs));
        const mk = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');
        tracksByMonth[mk] = tracksByMonth[mk] || [];
        const trackId = t.trackId || '';
        tracksByMonth[mk].push({
          date: new Date(Number(t.addedAtMs)).toISOString().slice(0,10),
          trackName: t.trackName || '',
          artist: t.artist || '',
          vibe: (t.selectedVibes&&t.selectedVibes[0])||'unknown',
          trackId,
          url: trackId ? ('https://open.spotify.com/track/'+trackId) : ''
        });
      }

      function renderVibeDrill(monthKey){
        const box=document.getElementById('rewindVibeDrill'); if(!box) return;
        const rows=(tracksByMonth[monthKey]||[]).slice().sort((x,y)=>String(y.date).localeCompare(String(x.date)));
        vibeDrillRows=rows;
        if(!rows.length){ box.innerHTML='<div class="tiny">No tracks for '+monthKey+'</div>'; return; }
        box.innerHTML='<div class="tiny">Month: '+monthKey+' \u2022 '+rows.length+' tracks</div>'+
          '<table style="width:100%;font-size:12px;margin-top:8px"><thead><tr><th align="left">Date</th><th align="left">Track</th><th align="left">Artist</th><th align="left">Vibe</th></tr></thead><tbody>'+rows.slice(0,200).map(r=>{
            const trackCell = r.url ? ('<a href="'+r.url+'" target="_blank" rel="noopener noreferrer" style="color:#8DC4AA">'+r.trackName+'</a>') : r.trackName;
            return '<tr><td>'+r.date+'</td><td>'+trackCell+'</td><td>'+r.artist+'</td><td>'+r.vibe+'</td></tr>';
          }).join('')+'</tbody></table>';
      }

      vd.querySelectorAll('[data-vibe-month]').forEach(el=>{
        el.addEventListener('click', ()=>renderVibeDrill(el.getAttribute('data-vibe-month')));
      });
      renderVibeDrill(monthKeys[monthKeys.length-1]);
    }

    const rd=document.getElementById('rewindDetail');
    if(rd){
      const activeMonths=latest?.activeMonths||0;
      const total=latest?.total||0;
      const uniqueArtists=latest?.uniqueArtists||0;
      const repeatRate=latest?.repeatRate||0;
      rd.innerHTML='<div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px">'+
        '<div class="card"><div class="h">Data Source</div><div style="font-size:20px">'+(r.source||'spotify')+'</div><div class="tiny">Scanned '+(r.scanned||0)+' saved tracks</div></div>'+
        '<div class="card"><div class="h">Latest Year Total</div><div style="font-size:32px;line-height:1">'+total+'</div><div class="tiny">songs added</div></div>'+
        '<div class="card"><div class="h">Unique Artists</div><div style="font-size:32px;line-height:1">'+uniqueArtists+'</div><div class="tiny">in '+latestYear+'</div></div>'+
        '<div class="card"><div class="h">Repeat Rate</div><div style="font-size:32px;line-height:1">'+(repeatRate*100).toFixed(1)+'%</div><div class="tiny">repeat listens by year</div></div>'+
      '</div><div class="tiny" style="margin-top:8px">Active months in '+latestYear+': '+activeMonths+'</div>';
    }
  } finally {
    setAnalyticsLoading(false);
  }
}

function fmtPct(x){ return Number.isFinite(x) ? (x*100).toFixed(1)+'%' : 'n/a'; }
function fmtNum(x, d=2){ return Number.isFinite(x) ? Number(x).toFixed(d) : 'n/a'; }

async function refreshCompare(){
  const presetA=(document.getElementById('cmpPresetA')||{}).value||'last90';
  const presetB=(document.getElementById('cmpPresetB')||{}).value||'prev90';
  const fromA=(document.getElementById('cmpFromA')||{}).value||'';
  const toA=(document.getElementById('cmpToA')||{}).value||'';
  const fromB=(document.getElementById('cmpFromB')||{}).value||'';
  const toB=(document.getElementById('cmpToB')||{}).value||'';
  const qs=new URLSearchParams({presetA,presetB,fromA,toA,fromB,toB,limit:'200'}).toString();
  const j=await fetch('/api/rewind-compare?'+qs).then(x=>x.json()).catch(()=>({ok:false,error:'request failed'}));
  compareState=j;
  compareLastAt = Date.now();
  const cmp=document.getElementById('rewindCompare');
  if(cmp){
    if(!j.ok){ cmp.innerHTML='<div class="tiny">Compare failed: '+(j.error||'unknown')+'</div>'; }
    else {
      const a=j.summaryA||{}; const b=j.summaryB||{}; const d=j.deltas||{};
      const valFor=(obj,k)=> (k==='energy'||k==='valence'||k==='danceability'||k==='tempo') ? (obj.audio||{})[k] : obj[k];
      const card=(k,label,fmt=(x)=>fmtNum(x,2))=>{
        const av=valFor(a,k); const bv=valFor(b,k); const delta=d[k]?.abs;
        const up=Number(delta)>=0;
        return '<div class="card" data-drill="'+k+'" style="cursor:pointer"><div class="tiny">'+label+'</div><div style="font-size:20px">'+fmt(av)+' <span class="tiny">vs '+fmt(bv)+'</span></div><div style="color:'+(up?'#22c55e':'#f59e0b')+'">'+(Number.isFinite(delta)?((up?'+':'')+fmt(delta)):'n/a')+'</div></div>';
      };
      cmp.innerHTML='<div class="tiny">A: '+j.rangeA.label+' ('+j.rangeA.from+' \u2192 '+j.rangeA.to+') \u2022 B: '+j.rangeB.label+' ('+j.rangeB.from+' \u2192 '+j.rangeB.to+')</div>'+
        '<div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:8px">'+
        card('total','Total Adds',(x)=>String(Math.round(Number(x)||0)))+
        card('discoveryRate','Discovery Rate',(x)=>fmtPct(x))+
        card('repeatRate','Repeat Rate',(x)=>fmtPct(x))+
        card('artistDiversity','Artist Diversity',(x)=>fmtNum(x,3))+
        card('energy','Energy',(x)=>fmtNum(x,3))+
        card('valence','Valence',(x)=>fmtNum(x,3))+
        card('danceability','Danceability',(x)=>fmtNum(x,3))+
        card('tempo','Tempo',(x)=>fmtNum(x,1))+
        '</div>';
      cmp.querySelectorAll('[data-drill]').forEach(el=>el.addEventListener('click',()=>renderDrill(el.getAttribute('data-drill'))));
    }
  }
  renderDrill('total');
}

function renderDrill(metric){
  const el=document.getElementById('rewindDrill'); if(!el) return;
  const j=compareState;
  if(!j || !j.ok){ el.innerHTML='<div class="tiny">No compare data yet</div>'; return; }
  const rowsA=(j.rowsA||[]); const rowsB=(j.rowsB||[]);
  const row=(r)=>{
    const url = r.trackId ? ('https://open.spotify.com/track/'+r.trackId) : '';
    const trackCell = url ? ('<a href="'+url+'" target="_blank" rel="noopener noreferrer" style="color:#8DC4AA">'+r.track+'</a>') : r.track;
    return '<tr><td>'+String(r.addedAt||'').slice(0,10)+'</td><td>'+trackCell+'</td><td>'+r.artist+'</td></tr>';
  };
  el.innerHTML='<div class="tiny">Drilldown metric: '+metric+' (showing recent rows)</div>'+
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:8px">'+
    '<div><div class="h">Period A ('+(rowsA.length||0)+')</div><table style="width:100%;font-size:12px"><thead><tr><th align="left">Date</th><th align="left">Track</th><th align="left">Artist</th></tr></thead><tbody>'+rowsA.slice(0,80).map(row).join('')+'</tbody></table></div>'+
    '<div><div class="h">Period B ('+(rowsB.length||0)+')</div><table style="width:100%;font-size:12px"><thead><tr><th align="left">Date</th><th align="left">Track</th><th align="left">Artist</th></tr></thead><tbody>'+rowsB.slice(0,80).map(row).join('')+'</tbody></table></div>'+
    '</div>';
}

function exportCompareCsv(){
  const j=compareState; if(!j || !j.ok) return toast('No compare data to export', false);
  const out=['period,date,track,artist,spotify_url'];
  for(const r of (j.rowsA||[])) {
    const url = r.trackId ? ('https://open.spotify.com/track/'+r.trackId) : '';
    out.push(['A', String(r.addedAt||'').slice(0,10), '"'+String(r.track||'').replaceAll('"','""')+'"', '"'+String(r.artist||'').replaceAll('"','""')+'"', '"'+url+'"'].join(','));
  }
  for(const r of (j.rowsB||[])) {
    const url = r.trackId ? ('https://open.spotify.com/track/'+r.trackId) : '';
    out.push(['B', String(r.addedAt||'').slice(0,10), '"'+String(r.track||'').replaceAll('"','""')+'"', '"'+String(r.artist||'').replaceAll('"','""')+'"', '"'+url+'"'].join(','));
  }
  const blob=new Blob([out.join('\n')], {type:'text/csv;charset=utf-8;'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download='rewind-compare.csv'; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  toast('Exported rewind-compare.csv', true);
}

function exportVibeDrillCsv(){
  if(!vibeDrillRows.length) return toast('No vibe drill data to export', false);
  const out=['date,track,artist,vibe,spotify_url'];
  for(const r of vibeDrillRows){
    out.push([
      r.date || '',
      '"'+String(r.trackName||'').replaceAll('"','""')+'"',
      '"'+String(r.artist||'').replaceAll('"','""')+'"',
      '"'+String(r.vibe||'').replaceAll('"','""')+'"',
      '"'+String(r.url||'').replaceAll('"','""')+'"'
    ].join(','));
  }
  const blob=new Blob([out.join('\n')], {type:'text/csv;charset=utf-8;'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download='vibe-drift-drilldown.csv'; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  toast('Exported vibe-drift-drilldown.csv', true);
}

async function refreshLogs(){
  const j = await fetch('/api/logs').then(x=>x.json()).catch(()=>({lines:['failed to load logs']}));
  const el=document.getElementById('liveLogs'); if(el) el.textContent=(j.lines||[]).join('\n');
}

async function clearLogs(){
  const r = await fetch('/api/logs/clear').then(x=>x.json()).catch(()=>({ok:false}));
  if(r.ok) toast('Logs cleared', true); else toast('Failed to clear logs', false);
  await refreshLogs();
}

async function refreshSystem(){
  const j = await fetch('/api/system-info').then(x=>x.json()).catch(()=>({error:'failed'}));
  const el=document.getElementById('systemInfo'); if(el) el.textContent=JSON.stringify(j, null, 2);
}

async function refreshAll(){
  // Fast panels first so UI doesn't look empty while deeper analytics loads.
  await Promise.allSettled([refreshOverview(), refreshLogs(), refreshSystem()]);
  if (!lowApiMode) {
    refreshAnalytics().catch(()=>{});
    refreshCompare().catch(()=>{});
  }
}

async function init() {
  try {
    const data = await fetch('/api/vibes').then(r => r.json());
    vibes = data.vibes || [];
  } catch (e) {
    console.warn('Failed to fetch vibes:', e);
  }
  // Also fetch auth status to update UI
  try {
    const sys = await fetch('/api/system-info').then(r => r.json());
    const authed = sys.auth?.hasToken && sys.auth?.healthy;
    const needsReauth = sys.auth?.hasToken && !sys.auth?.healthy;
    const statusEl = document.getElementById('authStatus');
    if (statusEl) {
      statusEl.style.color = authed ? '#22c55e' : '#f59e0b';
      statusEl.textContent = authed ? 'authenticated' : 'not authenticated';
    }
    const reauthMsg = document.getElementById('reauthMsg');
    if (reauthMsg) reauthMsg.style.display = needsReauth ? 'block' : 'none';
    const loginBtn = document.getElementById('loginBtn');
    if (loginBtn) loginBtn.style.display = authed ? 'none' : 'inline-flex';
  } catch (e) {
    console.warn('Failed to fetch system info:', e);
  }
  showTab('overview');
  updateLowApiUi();
  refreshAll();
}
init();

setInterval(async ()=>{
  if(currentTab==='overview') await refreshOverview();
  else if(currentTab==='analytics') {
    if (lowApiMode) return;
    await refreshAnalytics();
    // Compare is expensive; auto-fetch only once until user changes filters.
    if (!compareState) {
      await refreshCompare();
      compareLastAt = Date.now();
    }
  }
  else if(currentTab==='logs') await refreshLogs();
  else if(currentTab==='system') await refreshSystem();
}, 30000);
