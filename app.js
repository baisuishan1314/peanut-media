// ====== RCU LIVE DATA ENGINE ======
// 1. Render embedded data instantly (zero network)
// 2. Fetch live from RCU in background
// 3. Auto-refresh every 30min

var RCU='http://rcu-league.com',REFRESH=1800000,appData,dataSrc='embedded',timer;
var RP=30000,RK=[50,10,-10,-30];

// PT calculation (RCU official formula)
function calcPT(score,rank){
  return Math.round(((score-RP)/1000+RK[rank])*10)/10;
}

// UI helpers
var ptC=function(v){return v>0?'pos':v<0?'neg':'';};
var ptS=function(v){return v>0?'+':'';};
var scC=function(r){return r===1?'good':r===2?'ok':r===4?'bad':'';};

// Fetch JSON via CORS proxy (RCU has no CORS headers + is HTTP only)
async function rcuFetch(path){
  var url=RCU+path;
  // Skip direct fetch on HTTPS pages (mixed content blocked by browser)
  var isHTTPS=location.protocol==='https:';
  if(!isHTTPS){
    try{var r=await fetch(url);if(r.ok)return r.json();}catch(e){}
  }
  // Primary CORS proxy — URL must NOT be encoded
  try{var r=await fetch('https://proxy.cors.sh/'+url,{headers:{'x-requested-with':'XMLHttpRequest'}});if(r.ok)return r.json();}catch(e){}
  // Backup proxy 1
  try{var r=await fetch('https://corsproxy.io/?url='+encodeURIComponent(url));if(r.ok)return r.json();}catch(e){}
  // Backup proxy 2
  try{var r=await fetch('https://api.allorigins.win/raw?url='+encodeURIComponent(url));if(r.ok)return r.json();}catch(e){}
  throw Error('Failed to fetch '+path);
}

// Compute full data from RCU sources
async function rcuCompute(){
  var start=Date.now();
  var results,players,teams,schedule;
  try{
    [results,players,teams,schedule]=await Promise.all([
      rcuFetch('/data/results.json'),
      rcuFetch('/data/players.json'),
      rcuFetch('/data/teams.json'),
      rcuFetch('/data/schedule.json')
    ]);
  }catch(e){
    console.log('[RCU] Fetch failed:',e.message);
    return null;
  }

  // Team name map
  var teamNames={};
  for(var i=0;i<(teams.teams||[]).length;i++){
    var t=teams.teams[i];teamNames[t.id]=t.name||('Team '+t.id);
  }

  // Team 4 (花生传媒) players
  var t4p={};
  for(var i=0;i<(players.teams||[]).length;i++){
    var team=players.teams[i];
    if(team.team_id===4){
      for(var j=0;j<(team.players||[]).length;j++){
        var p=team.players[j];
        t4p[p.player_id]={name:p.name,bio:p.bio||'',photo:p.photo?RCU+'/'+p.photo:''};
      }
    }
  }

  // Player stats accumulator
  var ps={};
  for(var pid in t4p){
    ps[pid]={games:0,totalPt:0,wins:0,s2:0,s3:0,s4:0};
  }

  var allResults=[],teamTotalPt=0;

  // Filter completed matches (score != null)
  var completed=(results.results||[]).filter(function(r){
    return r.first_half&&r.first_half.east&&r.first_half.east.score!=null;
  });

  for(var i=0;i<completed.length;i++){
    var r=completed[i];
    ['first_half','second_half'].forEach(function(hk){
      var half=r[hk];if(!half)return;
      var entries=[];
      ['east','south','west','north'].forEach(function(pos){
        var t=half[pos];
        if(t&&t.score!=null)entries.push({teamId:t.team_id,score:t.score,playerId:t.player_id||''});
      });
      entries.sort(function(a,b){return b.score-a.score;});

      for(var rank=0;rank<entries.length;rank++){
        if(entries[rank].teamId===4){
          var e=entries[rank],pid=e.playerId,pt=calcPT(e.score,rank);
          teamTotalPt+=pt;
          if(pid&&ps[pid]){
            ps[pid].games++;ps[pid].totalPt+=pt;
            if(rank===0)ps[pid].wins++;
            else if(rank===1)ps[pid].s2++;
            else if(rank===2)ps[pid].s3++;
            else ps[pid].s4++;
          }
          var pn=t4p[pid]?t4p[pid].name:('Player '+pid);
          allResults.push({
            date:r.date||'',round:'第'+r.round+'轮',
            half:hk==='first_half'?'H1':'H2',
            player:pn,playerId:pid,score:e.score,rank:rank+1,pt:pt
          });
          return;
        }
      }
    });
  }

  // Sort results by round + half
  allResults.sort(function(a,b){
    var ra=parseInt(a.round.replace(/[^0-9]/g,''));
    var rb=parseInt(b.round.replace(/[^0-9]/g,''));
    if(ra!==rb)return ra-rb;
    return a.half.localeCompare(b.half);
  });

  // Players array sorted by totalPt desc
  var plist=[];
  for(var pid in t4p){
    var s=ps[pid];
    plist.push({
      id:pid,name:t4p[pid].name,bio:t4p[pid].bio,photo:t4p[pid].photo,
      games:s.games,totalPt:Math.round(s.totalPt*10)/10,
      wins:s.wins,s2:s.s2,s3:s.s3,s4:s.s4
    });
  }
  plist.sort(function(a,b){return b.totalPt-a.totalPt;});

  // Completed round numbers
  var doneRounds={};
  for(var i=0;i<completed.length;i++)doneRounds[completed[i].round]=true;

  // Upcoming schedule (Team 4 only, not completed)
  var upcoming=[];
  for(var i=0;i<(schedule.schedule||[]).length;i++){
    var s=schedule.schedule[i];
    var sr=s.round||'',sn=typeof sr==='string'?parseInt(sr.replace(/[^0-9]/g,'')):parseInt(sr);
    if(doneRounds[sn])continue;

    var involved=false,opponents=[];
    function scan(list){
      for(var j=0;j<(list||[]).length;j++){
        if(list[j].team_id===4)involved=true;
        else opponents.push(teamNames[list[j].team_id]||('Team '+list[j].team_id));
      }
    }
    scan(s.teams);if(s.second_match)scan(s.second_match.teams);
    if(!involved)continue;

    // Deduplicate opponents
    var seen={},uops=[];
    for(var j=0;j<opponents.length;j++){
      if(!seen[opponents[j]]){seen[opponents[j]]=1;uops.push(opponents[j]);}
    }

    var dd=s.date_display||s.date||'';
    if(!dd&&s.date){var p=s.date.split('-');if(p.length===3)dd=parseInt(p[1])+'/'+parseInt(p[2]);}

    var now=new Date(),isToday=s.date===now.toISOString().slice(0,10);

    upcoming.push({
      round:s.round||('第'+sn+'轮'),date:dd,time:s.time||'19:00',
      weekday:s.weekday||'',today:isToday,opponents:uops
    });
  }

  // Stats
  var totalGames=plist.reduce(function(s,p){return s+p.games;},0);
  var totalWins=plist.reduce(function(s,p){return s+p.wins;},0);
  var bp=plist.length>0?plist[0]:null;

  var elapsed=Date.now()-start;
  console.log('[RCU] Data computed in '+elapsed+'ms | PT:'+teamTotalPt.toFixed(1)+' | Games:'+totalGames);

  return {
    lastUpdated:new Date().toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}),
    teamTotalPt:Math.round(teamTotalPt*10)/10,
    players:plist,results:allResults,upcoming:upcoming,
    stats:{totalGames:totalGames,totalWins:totalWins,completedRounds:completed.length,bestPlayer:bp,playerCount:plist.length}
  };
}

// === RENDERING ===
function apply(){
  if(!appData)return;
  var g,h,n,s,p;

  // Players
  g=document.getElementById('playersGrid');
  if(g)g.innerHTML=appData.players.map(function(x){
    var c=x.totalPt<0?'negative':'',init=x.name?x.name.charAt(0):'?';
    var img=x.photo?'<img src="'+x.photo+'" alt="'+x.name+'" loading="lazy" onerror="this.style.display=\'none\';this.parentElement.textContent=\''+init+'\'">':init;
    return '<div class="player-card reveal"><div class="player-photo">'+img+'</div><h3>'+x.name+'</h3><div class="bio">"'+x.bio+'"</div><div class="stats-row"><div><div class="stat-val">'+x.games+'</div><div class="stat-lbl">半庄</div></div><div><div class="stat-val '+c+'">'+ptS(x.totalPt)+x.totalPt+'</div><div class="stat-lbl">总PT</div></div><div><div class="stat-val">'+x.wins+'</div><div class="stat-lbl">1位</div></div></div><div class="rank-dist">'+Array(x.wins||0).fill('<div class="rank-chip win">🥇1</div>').join('')+Array(x.s2||0).fill('<div class="rank-chip s2">🥈2</div>').join('')+Array(x.s3||0).fill('<div class="rank-chip s3">🥉3</div>').join('')+Array(x.s4||0).fill('<div class="rank-chip s4">④4</div>').join('')+'</div></div>';
  }).join('');

  // Results
  g=document.getElementById('resultsBody');
  if(g)g.innerHTML=appData.results.map(function(r){
    return '<div class="match-row reveal"><div class="m-date"><span class="m-label">日期</span>'+r.date+'</div><div class="m-round"><span class="m-label">轮次</span>'+r.round+'</div><div class="m-half"><span class="m-label">半庄</span>'+r.half+'</div><div class="m-player"><span class="m-label">选手</span>'+r.player+'</div><div class="m-score '+scC(r.rank)+'"><span class="m-label">得点</span>'+(r.score>=0?'+':'')+r.score.toLocaleString()+'</div><div><span class="m-label">排名</span><span class="rank-badge-sm r'+r.rank+'">'+r.rank+'位</span></div><div class="m-pt '+ptC(r.pt)+'"><span class="m-label">PT</span>'+ptS(r.pt)+r.pt+'</div></div>';
  }).join('');

  // Schedule
  g=document.getElementById('scheduleGrid');
  if(g)g.innerHTML=(appData.upcoming||[]).map(function(s){
    var seen={},opps=[];
    (s.opponents||[]).forEach(function(o){if(!seen[o]){seen[o]=1;opps.push(o);}});
    return '<div class="schedule-row reveal'+(s.today?' today':'')+'"><div class="s-date"><span class="m-label">日期</span>'+s.date+' · '+s.time+'</div><div class="s-round"><span class="m-label">轮次</span>'+s.round+'</div><div class="s-opponents"><span class="m-label">对阵</span><span class="op-chip us">★ 花生传媒</span>'+opps.map(function(t){return'<span class="op-chip">'+t+'</span>';}).join('')+'</div><div class="s-status"><span class="m-label">状态</span><span class="s-st '+(s.today?'live':'up')+'">'+(s.today?'🔴 今天':'即将开赛')+'</span></div><div class="s-link">'+(s.today?'<a href="https://space.bilibili.com/3362132" target="_blank" style="color:var(--blue)">📺 看直播 →</a>':'<span style="color:var(--t3)">'+(s.weekday||'')+'</span>')+'</div></div>';
  }).join('');

  // Stats
  g=document.getElementById('statsGrid');
  if(g){s=appData.stats||{};p=s.bestPlayer||{};
    g.innerHTML='<div class="stat-card reveal"><div class="icon">🀄</div><div class="val">'+(s.totalGames||0)+'</div><div class="lbl">已完成半庄</div></div><div class="stat-card reveal"><div class="icon">🏆</div><div class="val">'+(s.totalWins||0)+'</div><div class="lbl">1位次数</div></div><div class="stat-card reveal"><div class="icon">📈</div><div class="val small">'+(appData.teamTotalPt>0?'+':'')+(appData.teamTotalPt||0).toFixed(1)+'</div><div class="lbl">队伍总PT</div></div><div class="stat-card reveal"><div class="icon">⭐</div><div class="val small">'+(p.name||'--')+'</div><div class="lbl">PT王 ('+(p.totalPt>0?'+':'')+(p.totalPt||0)+')</div></div>';
  }

  // Hero
  h=document.getElementById('heroTotalPT');if(h)h.textContent=(appData.teamTotalPt>0?'+':'')+appData.teamTotalPt;
  h=document.getElementById('heroHalfGames');if(h&&appData.stats)h.textContent=appData.stats.totalGames||appData.results.length;
  h=document.getElementById('heroCompletedRounds');if(h&&appData.stats)h.textContent=appData.stats.completedRounds||0;
  h=document.getElementById('heroBadge');
  if(h&&appData.upcoming&&appData.upcoming.length){n=appData.upcoming[0];h.innerHTML='<span class="dot live"></span> RCU League 2026 · 下一场：'+n.date+(n.today?' 🔴今晚':'')+' '+n.time+' · '+n.round;}
  h=document.getElementById('lastUpdated');
  if(h)h.textContent=(dataSrc==='live'?'⏱ 实时 · RCU':(dataSrc==='rcu'?'⏱ RCU直连 · ':'📦 嵌入式缓存 · '))+(appData.lastUpdated||'');

  // Re-bind player card clicks (event delegation)
  var pg=document.getElementById('playersGrid');
  if(pg)pg.onclick=function(e){
    var card=e.target.closest('.player-card');if(!card)return;
    var name=card.querySelector('h3');
    if(name)openPlayerModal(name.textContent);
  };
}

// === PLAYER MODAL ===
function closePlayerModal(){
  document.getElementById('playerModal').classList.remove('open');
}
function openPlayerModal(name){
  if(!appData||!appData.players||!appData.results)return;
  var p;
  for(var i=0;i<appData.players.length;i++){
    if(appData.players[i].name===name){p=appData.players[i];break;}
  }
  if(!p)return;

  var matches=[];
  for(var i=0;i<appData.results.length;i++){
    if(appData.results[i].player===p.name||appData.results[i].playerId===p.id){
      matches.push(appData.results[i]);
    }
  }
  matches.sort(function(a,b){return parseInt(a.round.replace(/[^0-9]/g,''))-parseInt(b.round.replace(/[^0-9]/g,''));});

  var avgPt=matches.length>0?Math.round(p.totalPt/matches.length*10)/10:0;
  var winRate=matches.length>0?Math.round(p.wins/matches.length*100):0;

  // Build rank bar
  var total=p.wins+p.s2+p.s3+p.s4||1;
  var rbar='';
  if(p.wins>0)rbar+='<div class="pm-rk-gold" style="flex:'+(p.wins/total*100)+'%">🥇'+p.wins+'</div>';
  if(p.s2>0)rbar+='<div class="pm-rk-silver" style="flex:'+(p.s2/total*100)+'%">🥈'+p.s2+'</div>';
  if(p.s3>0)rbar+='<div class="pm-rk-bronze" style="flex:'+(p.s3/total*100)+'%">🥉'+p.s3+'</div>';
  if(p.s4>0)rbar+='<div class="pm-rk-iron" style="flex:'+(p.s4/total*100)+'%">④'+p.s4+'</div>';

  // Render header
  var init=p.name?p.name.charAt(0):'?';
  var img=p.photo?'<img src="'+p.photo+'" alt="'+p.name+'" loading="lazy" onerror="this.style.display=\'none\';this.parentElement.textContent=\''+init+'\'">':init;
  document.getElementById('pmHeader').innerHTML=
    '<div class="pm-photo">'+img+'</div>'+
    '<div class="pm-name">'+p.name+'</div>'+
    '<div class="pm-bio">"'+p.bio+'"</div>'+
    '<div class="pm-summary">'+
      '<div class="pm-sum-item"><div class="v">'+p.games+'</div><div class="l">出场半庄</div></div>'+
      '<div class="pm-sum-item"><div class="v '+(p.totalPt<0?'neg':'')+'">'+(p.totalPt>0?'+':'')+p.totalPt+'</div><div class="l">累计PT</div></div>'+
      '<div class="pm-sum-item"><div class="v">'+(avgPt>0?'+':'')+avgPt+'</div><div class="l">场均PT</div></div>'+
      '<div class="pm-sum-item"><div class="v">'+winRate+'%</div><div class="l">1位率</div></div>'+
    '</div>'+
    '<div class="pm-rank-bar" style="margin-top:16px">'+rbar+'</div>';

  // Render match list
  var mhtml=matches.length?'':'<div class="pm-empty">暂无比赛记录</div>';
  for(var i=0;i<matches.length;i++){
    var m=matches[i],scCss=m.rank===1?'good':m.rank===2?'ok':m.rank===4?'bad':'';
    mhtml+='<div class="pm-match-row">'+
      '<div class="r-date">'+m.date+'</div>'+
      '<div class="r-round">'+m.round+'</div>'+
      '<div class="r-score '+scCss+'">'+(m.score>=0?'+':'')+m.score.toLocaleString()+'</div>'+
      '<div class="r-pt '+ptC(m.pt)+'">'+ptS(m.pt)+m.pt+'</div>'+
      '<div class="r-rank"><span class="rank-badge-sm r'+m.rank+'">'+m.rank+'位</span></div>'+
    '</div>';
  }
  document.getElementById('pmBody').innerHTML='<h4>个人比赛记录</h4><div class="pm-match-list">'+mhtml+'</div>';

  document.getElementById('playerModal').classList.add('open');
  document.getElementById('playerModal').onclick=function(e){if(e.target===this)closePlayerModal();};
  document.onkeydown=function(e){if(e.key==='Escape')closePlayerModal();};
}

// === LIVE FETCH ===
async function tryRCU(){
  try{
    var d=await rcuCompute();
    if(d){
      // Preserve local photo paths from embedded data (RCU photos are HTTP, blocked on HTTPS)
      var embPhotos={};
      if(EMBEDDED_DATA&&EMBEDDED_DATA.players){
        EMBEDDED_DATA.players.forEach(function(p){embPhotos[p.id]=p.photo;});
      }
      d.players.forEach(function(p){if(embPhotos[p.id])p.photo=embPhotos[p.id];});
      appData=d;dataSrc='rcu';apply();return true;
    }
  }catch(e){console.log('[RCU] tryRCU failed:',e.message);}
  return false;
}

// === INIT ===
// Step 1: Render embedded data instantly
appData=EMBEDDED_DATA;dataSrc='embedded';apply();
// Step 2: Try RCU live fetch, then start auto-refresh (always, even if first fetch fails)
tryRCU().then(function(){
  timer=setInterval(tryRCU,REFRESH);
  console.log('[RCU] Auto-refresh active every '+REFRESH/1000+'s ('+REFRESH/60000+'min)');
});

// ====== VERSION SELF-CHECK (prevent stale cache) ======
(function(){
  // Extract current version from script src
  var v='?';
  var scripts=document.getElementsByTagName('script');
  for(var i=0;i<scripts.length;i++){
    var m=scripts[i].src.match(/app\.js\?v=(\w+)/);
    if(m){v=m[1];break;}
  }
  console.log('[VERSION] Current:',v);

  // Inject toast element
  var toast=document.createElement('div');
  toast.id='version-toast';
  toast.style.cssText='position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:999;background:var(--red);color:#fff;padding:10px 24px;border-radius:100px;font-size:.78rem;font-weight:700;cursor:pointer;box-shadow:0 4px 20px rgba(196,30,58,.5);display:none;transition:all .3s ease';
  toast.textContent='🔄 有新版本可用，点击刷新';
  toast.onclick=function(){location.reload(true);};
  document.body.appendChild(toast);

  // Check version.txt against current version, every 5 minutes
  function checkVersion(){
    fetch('https://raw.githubusercontent.com/baisuishan1314/peanut-media/main/version.txt?_t='+Date.now())
      .then(function(r){return r.text();})
      .then(function(latest){
        latest=latest.trim();
        if(latest&&latest!==v){
          console.log('[VERSION] Outdated: '+v+' → latest: '+latest);
          toast.style.display='block';
        }
      }).catch(function(){});
  }
  setInterval(checkVersion,300000);  // every 5 min
  // First check after 30s (let page fully load)
  setTimeout(checkVersion,30000);
})();

// Navbar, menu, scroll, reveal...
var nav=document.getElementById('navbar');
window.addEventListener('scroll',function(){nav.classList.toggle('scrolled',window.scrollY>60);});
var tgl=document.getElementById('navToggle'),lnk=document.getElementById('navLinks');
tgl.addEventListener('click',function(){tgl.classList.toggle('open');lnk.classList.toggle('open');});
lnk.querySelectorAll('a').forEach(function(a){a.addEventListener('click',function(){tgl.classList.remove('open');lnk.classList.remove('open');});});
var secs=document.querySelectorAll('section[id]'),nits=document.querySelectorAll('.nav-links a');
window.addEventListener('scroll',function(){var c='';secs.forEach(function(s){if(window.scrollY>=s.offsetTop-100)c=s.getAttribute('id');});nits.forEach(function(a){a.classList.toggle('active',a.getAttribute('href')==='#'+c);});});
document.querySelectorAll('a[href^="#"]').forEach(function(a){a.addEventListener('click',function(e){var t=document.querySelector(this.getAttribute('href'));if(t){e.preventDefault();window.scrollTo({top:t.offsetTop-70,behavior:'smooth'});}});});
var obs=new IntersectionObserver(function(e){e.forEach(function(x){if(x.isIntersecting){x.target.classList.add('visible');obs.unobserve(x.target);}});},{threshold:0.1});
document.querySelectorAll('.reveal').forEach(function(el){obs.observe(el);});
