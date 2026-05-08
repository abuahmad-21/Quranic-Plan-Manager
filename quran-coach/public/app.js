/* ═══════════════════════════════════════════════════════════════
   QUANTUM QURAN COACH — app.js (v2)
   SPA · Auth · Onboarding · Dashboard · Sensors · Plan
   Friends · Chats · Groups · Posts · Profile · Library (IndexedDB)
   Voice Recording · Support · Admin
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const API = '/api';

const S = {
  token:    localStorage.getItem('qqc_token') || null,
  username: localStorage.getItem('qqc_user')  || null,
  adminPw:  null,
  user:     null,
  mode:     'NORMAL_MODE',
  currentChat: null,
  currentGroup: null,
  chatPoll: null,
  recorder: null, recChunks: [], recTarget: null,
};

/* ══ Sensors (frontend telemetry) ══ */
const SX = {
  focusSeconds:0, hiddenSeconds:0, hesitationMs:0, mouseErratics:0, touchErratics:0,
  exitAttempts:0, scrollSpeed:0, scrolledToBottom:false, isVisible:true, hiddenAt:0,
  lastClickTime:0, lastMouseX:0, lastMouseY:0, lastMouseT:Date.now(),
  lastScrollY:0, lastScrollT:Date.now(), mouseHist:[], scrollBuf:[], entryHist:[],
  focusTick:null, syncTick:null,
};

const Sensors = {
  init(){
    try { SX.entryHist = JSON.parse(sessionStorage.getItem('qqc_eh')||'[]'); } catch(_){}
    SX.entryHist.push(Date.now()); if (SX.entryHist.length>10) SX.entryHist.shift();
    sessionStorage.setItem('qqc_eh', JSON.stringify(SX.entryHist));

    document.addEventListener('visibilitychange', ()=>{
      SX.isVisible = document.visibilityState==='visible';
      if (!SX.isVisible) { SX.hiddenAt = Date.now(); dot('s-focus', false); }
      else { SX.hiddenSeconds += (Date.now()-SX.hiddenAt)/1000; dot('s-focus', true); }
    });
    SX.focusTick = setInterval(()=>{ if (SX.isVisible) SX.focusSeconds++; }, 1000);

    document.addEventListener('mouseenter', e=>{
      if (e.target?.matches?.('.btn,.icon-btn,.option-btn')) SX.lastClickTime = Date.now();
    }, true);
    document.addEventListener('click', ()=>{
      const now=Date.now();
      if (SX.lastClickTime>0){ const d=now-SX.lastClickTime;
        if (d>400 && d<9000){ SX.hesitationMs=Math.max(SX.hesitationMs,d); dot('s-intent',true); setTimeout(()=>dot('s-intent',false),700);} }
      SX.lastClickTime = now;
    });
    document.addEventListener('mouseleave', e=>{ if (e.clientY<=5){ SX.exitAttempts++; if (SX.exitAttempts>=2) Sensors.sync('exit_intent'); }});
    document.addEventListener('mousemove', e=>{
      const now=Date.now(),dx=e.clientX-SX.lastMouseX,dy=e.clientY-SX.lastMouseY,dt=now-SX.lastMouseT;
      if (dt>0&&dt<200){ const sp=Math.sqrt(dx*dx+dy*dy)/dt; SX.mouseHist.push({dx,dy,sp}); if (SX.mouseHist.length>20)SX.mouseHist.shift();
        if (SX.mouseHist.length>=2){ const p=SX.mouseHist[SX.mouseHist.length-2];
          if ((Math.sign(dx)!==Math.sign(p.dx)||Math.sign(dy)!==Math.sign(p.dy)) && sp>1.5){ SX.mouseErratics++; dot('s-kinetic',true); setTimeout(()=>dot('s-kinetic',false),400);} }
      }
      SX.lastMouseX=e.clientX; SX.lastMouseY=e.clientY; SX.lastMouseT=now;
    });
    let lx=0,ly=0,lt=0;
    document.addEventListener('touchmove', e=>{
      const t=e.touches[0],now=Date.now(),dx=t.clientX-lx,dy=t.clientY-ly,dt=now-lt;
      if (dt>0&&dt<150&&Math.sqrt(dx*dx+dy*dy)/dt>3) SX.touchErratics++;
      lx=t.clientX; ly=t.clientY; lt=now;
    },{passive:true});
    document.addEventListener('scroll', ()=>{
      const now=Date.now(),dy=Math.abs(window.scrollY-SX.lastScrollY),dt=now-SX.lastScrollT;
      if (dt>0){ const sp=dy/dt; SX.scrollBuf.push(sp); if(SX.scrollBuf.length>10)SX.scrollBuf.shift();
        SX.scrollSpeed = SX.scrollBuf.reduce((a,b)=>a+b,0)/SX.scrollBuf.length; }
      SX.lastScrollY=window.scrollY; SX.lastScrollT=now;
      if ((window.innerHeight+window.scrollY)>=document.body.scrollHeight-80) SX.scrolledToBottom=true;
      dot('s-kinetic',true); setTimeout(()=>dot('s-kinetic',false),500);
    },{passive:true});
    SX.syncTick = setInterval(()=>Sensors.sync('auto'), 25000);
    dot('s-rhythm', SX.entryHist.length>1);
  },
  chaos(){
    if (SX.entryHist.length<2) return 0;
    const gaps=SX.entryHist.slice(1).map((v,i)=>v-SX.entryHist[i]);
    const avg=gaps.reduce((a,b)=>a+b,0)/gaps.length;
    const std=Math.sqrt(gaps.reduce((a,g)=>a+Math.pow(g-avg,2),0)/gaps.length);
    return Math.min(100,(std/(24*3600*1000))*100);
  },
  payload(trigger='auto'){
    return { trigger, timestamp:Date.now(),
      focusSeconds:SX.focusSeconds, hiddenSeconds:SX.hiddenSeconds, hesitationMs:SX.hesitationMs,
      mouseErratics:SX.mouseErratics, touchErratics:SX.touchErratics, exitAttempts:SX.exitAttempts,
      scrollSpeed:+SX.scrollSpeed.toFixed(4), scrolledToBottom:SX.scrolledToBottom,
      chaosRhythm:+Sensors.chaos().toFixed(2), lastMode:S.mode };
  },
  async sync(trigger='auto'){
    if (!S.token) return;
    try { const r = await Api.post('/process-state', Sensors.payload(trigger));
      if (r && !r.error) UI.applyDecision(r);
    } catch(_){}
  },
  reset(){ SX.hesitationMs=0; SX.exitAttempts=0; SX.mouseErratics=Math.max(0,SX.mouseErratics-5); },
};
function dot(id,on){ const el=document.getElementById(id); if(el) on?el.classList.add('active'):el.classList.remove('active'); }

/* ══ API ══ */
const Api = {
  h(){ const h={'Content-Type':'application/json'}; if (S.token) h['x-token']=S.token; if (S.username) h['x-username']=S.username; return h; },
  ah(){ return {'Content-Type':'application/json','x-admin-password':S.adminPw||''}; },
  get(p,admin){ return fetch(API+p,{headers:admin?this.ah():this.h()}).then(r=>r.json()); },
  post(p,b={},admin){ return fetch(API+p,{method:'POST',headers:admin?this.ah():this.h(),body:JSON.stringify(b)}).then(r=>r.json()); },
  patch(p,b={},admin){ return fetch(API+p,{method:'PATCH',headers:admin?this.ah():this.h(),body:JSON.stringify(b)}).then(r=>r.json()); },
  del(p,admin){ return fetch(API+p,{method:'DELETE',headers:admin?this.ah():this.h()}).then(r=>r.json()); },
};

/* ══ Toast ══ */
function toast(msg,type='info',dur=3000){
  const el=document.createElement('div'); el.className='toast toast-'+type; el.textContent=msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(()=>el.remove(),dur);
}

/* ══ Router ══ */
const App = {
  showView(id){
    document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
    const el=document.getElementById(id); if(el) el.classList.add('active');
    // Hide top-bar and broadcast on auth/onboarding views
    const noTopBar = ['view-auth','view-onboarding'];
    const topBar = document.querySelector('.top-bar');
    const broadcast = document.getElementById('broadcast');
    if (topBar) topBar.classList.toggle('hidden', noTopBar.includes(id));
    if (broadcast && noTopBar.includes(id)) broadcast.classList.add('hidden');
    if (id==='view-dashboard') Dashboard.load();
    if (id==='view-plan') Plan.load();
    if (id==='view-feed') Feed.load();
    if (id==='view-profile') Profile.load();
    if (id==='view-chats') Chats.load();
    if (id==='view-friends') Friends.load();
    if (id==='view-groups') Groups.load();
    if (id==='view-library') Library.load();
    if (id==='view-leaderboard') Leaderboard.load();
    if (id==='view-support') Support.load();
    if (id==='view-admin') Admin.load();
    if (id==='view-notifications') Notifications.load();
    if (id==='view-channels') Channels.load();
    if (id==='view-channelroom' && !S.currentChannel) App.showView('view-channels');
    // Stop chat polling when leaving chat room
    if (id!=='view-chatroom' && S.chatPoll){ clearInterval(S.chatPoll); S.chatPoll=null; }
    window.scrollTo({top:0,behavior:'smooth'});
  },
};
window.App = App;

/* ══ UI Effectors ══ */
const UI = {
  applyDecision(d){
    if (!d?.mode) return;
    S.mode = d.mode;
    document.body.className = document.body.className.replace(/\bmode-\S+/g,'').trim();
    const mc = {NORMAL_MODE:'normal',CHALLENGE_MODE:'challenge',RELOAD_MODE:'reload',PATTERN_INTERRUPT:'interrupt'}[d.mode]||'normal';
    document.body.classList.add('mode-'+mc);
    const island = document.getElementById('island');
    if (island){ island.className='island'; island.classList.add({NORMAL_MODE:'island-normal',CHALLENGE_MODE:'island-challenge',RELOAD_MODE:'island-reload',PATTERN_INTERRUPT:'island-interrupt'}[d.mode]||'island-normal'); }
    UI.animNum('island-energy', d.energy);
    const labels={NORMAL_MODE:'الوضع العادي',CHALLENGE_MODE:'وضع التحدي',RELOAD_MODE:'وضع الإنعاش',PATTERN_INTERRUPT:'قاطع النمط'};
    const states={NORMAL_MODE:'مستقرة',CHALLENGE_MODE:'تدفق كامل ⚡',RELOAD_MODE:'استعادة الطاقة 🌿',PATTERN_INTERRUPT:'تدخل طارئ ⚠️'};
    setText('island-mode-label',labels[d.mode]||'');
    setText('island-state-text','الحالة النفسية: '+(states[d.mode]||''));
    setText('user-mode', d.mode);
    const badge=document.getElementById('session-mode-badge'); if (badge){badge.className='mode-badge mode-'+mc; badge.textContent=labels[d.mode]||'';}
    if (d.target_pages) setText('session-target-pages', d.target_pages);
    if (d.alert){ const ae=document.getElementById('dash-alert-text'); if (ae){ ae.style.opacity='0'; setTimeout(()=>{ ae.textContent=d.alert.text_ar||''; ae.style.transition='opacity .5s ease'; ae.style.opacity='1'; },200);} }
    if (d.intervention) toast(d.intervention.message_ar,'error',6000);
  },
  animNum(id,target){
    const el=document.getElementById(id); if(!el) return;
    const start=parseInt(el.textContent)||0, diff=target-start, steps=18; let step=0;
    const t=setInterval(()=>{ step++; el.textContent=Math.round(start+diff*(step/steps)); if (step>=steps) clearInterval(t); },28);
  },
  setLoading(show){ const l=document.getElementById('loading-screen'); if(l) l.style.display=show?'flex':'none'; },
  showApp(){ document.getElementById('app').classList.remove('hidden'); },
};
function setText(id,v){ const e=document.getElementById(id); if (e) e.textContent=v; }
function escapeHTML(s){ return String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function fmtTime(iso){ try{ return new Date(iso).toLocaleString('ar'); }catch{return iso;} }

/* ══ AUTH ══ */
const Auth = {
  init(){
    document.querySelectorAll('.auth-tabs .tab-btn').forEach(b=>b.addEventListener('click',()=>{
      document.querySelectorAll('.auth-tabs .tab-btn').forEach(x=>x.classList.remove('active'));
      b.classList.add('active');
      const t=b.dataset.tab;
      document.getElementById('form-login').classList.toggle('hidden', t!=='login');
      document.getElementById('form-register').classList.toggle('hidden', t!=='register');
    }));
    document.getElementById('form-login').addEventListener('submit', async e=>{
      e.preventDefault(); const fd=new FormData(e.target);
      const r = await Api.post('/auth/login',{username:fd.get('username'),password:fd.get('password')});
      if (r.error) return toast('خطأ: '+r.error,'error');
      Auth.onLogin(r);
    });
    document.getElementById('form-register').addEventListener('submit', async e=>{
      e.preventDefault(); const fd=new FormData(e.target);
      const r = await Api.post('/auth/register',{username:fd.get('username'),password:fd.get('password'),display_name:fd.get('display_name')});
      if (r.error) return toast('خطأ: '+r.error,'error');
      Auth.onLogin(r);
    });
    document.getElementById('btn-logout').addEventListener('click', async ()=>{
      await Api.post('/auth/logout');
      localStorage.clear(); location.reload();
    });
  },
  onLogin(r){
    S.token=r.token; S.username=r.username;
    localStorage.setItem('qqc_token',r.token); localStorage.setItem('qqc_user',r.username);
    Boot.afterLogin();
    Notifications.startPolling();
  }
};

/* ══ ONBOARDING ══ */
const Onboarding = {
  init(){
    document.querySelectorAll('#form-onboarding .option-grid').forEach(g=>{
      g.addEventListener('click', e=>{
        const b=e.target.closest('.option-btn'); if(!b) return;
        g.querySelectorAll('.option-btn').forEach(x=>x.classList.remove('active'));
        b.classList.add('active');
      });
    });
    document.getElementById('form-onboarding').addEventListener('submit', async e=>{
      e.preventDefault();
      const data={};
      document.querySelectorAll('#form-onboarding .option-grid').forEach(g=>{
        const a=g.querySelector('.active'); if (a) data[g.dataset.name]=a.dataset.v;
      });
      const r = await Api.post('/onboarding', data);
      if (r.error) return toast('خطأ','error');
      S.user = r.user;
      toast('تمت تهيئة الخطة','success');
      App.showView('view-dashboard');
    });
  }
};

/* ══ DASHBOARD ══ */
const Dashboard = {
  async load(){
    if (!S.user) { const r = await Api.get('/me'); S.user = r.user; }
    setText('user-name', S.user.display_name);
    const av=document.getElementById('user-avatar');
    if (av){ av.textContent = (S.user.display_name||'?')[0]; av.style.background = S.user.avatar_color; }
    setText('stat-pages', (S.user.progress.total_pages_memorized||0).toFixed(2));
    setText('stat-streak', S.user.progress.current_streak_days||0);
    setText('stat-sessions', S.user.progress.total_sessions_completed||0);
    Sensors.sync('view_dashboard');
    // broadcast
    const b = await Api.get('/broadcast');
    const bn = document.getElementById('broadcast');
    if (b.messages?.length){ bn.classList.remove('hidden'); bn.textContent = '📣 '+b.messages[b.messages.length-1].message; }
    else bn.classList.add('hidden');
  }
};

/* ══ SESSION ══ */
const Session = {
  init(){
    document.querySelectorAll('#view-session .option-grid').forEach(g=>{
      g.addEventListener('click',e=>{
        const b=e.target.closest('.option-btn'); if(!b) return;
        g.querySelectorAll('.option-btn').forEach(x=>x.classList.remove('active'));
        b.classList.add('active');
      });
    });
    document.getElementById('btn-complete-session').addEventListener('click', async ()=>{
      const diff = document.querySelector('#view-session .option-grid .active')?.dataset.v||'medium';
      const pages = +document.getElementById('session-pages').value||0;
      const dur   = +document.getElementById('session-duration').value||0;
      const mood  = +document.getElementById('session-mood').value||5;
      const r = await Api.post('/session/complete',{pages_done:pages,difficulty:diff,duration_minutes:dur,mood_score:mood});
      if (r.error) return toast('خطأ','error');
      toast('تم تسجيل الجلسة','success');
      Sensors.reset();
      if (r.plan_recommendation && r.plan_recommendation.delta!==0) {
        toast(`الخطة تكيّفت: ${r.plan_recommendation.old_target} → ${r.plan_recommendation.target} (${r.plan_recommendation.reason})`,'info',5000);
      }
      const me = await Api.get('/me'); S.user=me.user;
      App.showView('view-dashboard');
    });
  }
};

/* ══ PLAN ══ */
const Plan = {
  async load(){
    const r = await Api.get('/plan');
    const modeLabels = {both:'حفظ ومراجعة',memorization_only:'حفظ فقط',review_only:'مراجعة فقط'};
    const currentMode = S.user?.onboarding?.plan_mode || 'both';
    document.getElementById('plan-current').innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <div><strong>نوع الخطة:</strong> <span class="plan-mode-badge">${modeLabels[currentMode]||'حفظ ومراجعة'}</span></div>
      </div>
      <div><strong>الهدف اليومي:</strong> ${r.plan?.current_daily_pages||0} صفحة</div>
      <div><strong>المرحلة:</strong> ${r.plan?.phase||'—'}</div>
      <div><strong>تاريخ البدء:</strong> ${fmtTime(r.plan?.start_date)}</div>
      ${r.recommendation ? `<hr style="border-color:var(--border);margin:10px 0">
      <div><strong>توصية الخوارزمية:</strong> ${r.recommendation.reason}</div>
      <div>اللياقة: ${(r.recommendation.fitness*100|0)}% · الجودة: ${(r.recommendation.qScore*100|0)}% · الغياب: ${(r.recommendation.absRate*100|0)}%</div>
      ` : ''}`;

    // Plan mode selector
    const modeSelector = document.getElementById('plan-mode-selector');
    if(modeSelector){
      modeSelector.querySelectorAll('[data-pm]').forEach(b=>{
        b.classList.toggle('active', b.dataset.pm===currentMode);
        b.onclick = ()=>{
          modeSelector.querySelectorAll('[data-pm]').forEach(x=>x.classList.remove('active'));
          b.classList.add('active');
        };
      });
    }
    const saveBtn = document.getElementById('btn-save-plan-mode');
    if(saveBtn) saveBtn.onclick = async ()=>{
      const mode = modeSelector?.querySelector('.active')?.dataset.pm || 'both';
      const r2 = await Api.patch('/me', {plan_mode: mode});
      if(r2.ok){ if(S.user?.onboarding) S.user.onboarding.plan_mode=mode; toast('✅ تم تحديث نوع الخطة','success'); Plan.load(); }
      else toast('خطأ','error');
    };

    document.getElementById('plan-preview').innerHTML =
      '<div style="display:flex;gap:4px;min-width:max-content">'+
      r.preview.map((v,i)=>`<div style="text-align:center;padding:6px 8px;border:1px solid var(--border);border-radius:6px;min-width:46px"><div class="mono" style="font-size:.7rem;color:var(--text-3)">${i+1}</div><div class="mono" style="font-size:.85rem">${v}</div></div>`).join('')+
      '</div>';
    const sr = r.sr_state||{};
    const keys = Object.keys(sr);
    document.getElementById('plan-sr').innerHTML = keys.length
      ? keys.map(k=>`<div class="card-row"><div class="card-row-left">جزء ${k}</div><div class="card-row-right mono">EF ${sr[k].ef} · فاصل ${sr[k].interval}ي · التالية ${(sr[k].next_review||'').slice(0,10)}</div></div>`).join('')
      : '<p style="color:var(--text-2)">ابدأ بجلسة لتفعيل المراجعة المتباعدة.</p>';
  }
};

/* ══ PROFILE ══ */
const Profile = {
  async load(){
    const r = await Api.get('/me'); S.user = r.user;
    const u = S.user;
    setText('profile-name', u.display_name);
    setText('profile-handle', '@'+u.username);
    const av=document.getElementById('profile-avatar');
    av.textContent=(u.display_name||'?')[0]; av.style.background=u.avatar_color;

    // Bio display
    const bioEl=document.getElementById('profile-bio-display');
    if(bioEl) bioEl.textContent = u.bio||'لا توجد نبذة بعد.';

    // Badges
    const lvlMap={beginner:'مبتدئ 🌱',intermediate:'متوسط 📖',advanced:'متقدم ⭐',hafiz:'حافظ 🏆'};
    const modeMap={both:'حفظ ومراجعة',memorization_only:'حفظ فقط',review_only:'مراجعة فقط'};
    const badgesEl=document.getElementById('profile-badges');
    if(badgesEl) badgesEl.innerHTML=`
      <span class="plan-mode-badge">${lvlMap[u.onboarding?.current_level]||'مبتدئ 🌱'}</span>
      <span class="plan-mode-badge" style="background:rgba(250,204,21,.15);color:#fbbf24">${modeMap[u.onboarding?.plan_mode||'both']}</span>`;

    // Stats
    const p=u.progress||{};
    setText('pf-stat-pages', (p.total_pages_memorized||0).toFixed(1));
    setText('pf-stat-streak', p.current_streak_days||0);
    setText('pf-stat-sessions', p.total_sessions_completed||0);
    setText('pf-stat-energy', Math.round(u.energy?.score||0));
    setText('pf-stat-friends', (u.friends||[]).length);
    setText('pf-stat-longest', p.longest_streak_days||0);

    // Edit form
    document.getElementById('pf-display').value = u.display_name||'';
    document.getElementById('pf-bio').value     = u.bio||'';
    document.getElementById('pf-color').value   = u.avatar_color||'#3b82f6';
    document.getElementById('btn-save-profile').onclick = async ()=>{
      const r2 = await Api.patch('/me',{
        display_name:document.getElementById('pf-display').value,
        bio:document.getElementById('pf-bio').value,
        avatar_color:document.getElementById('pf-color').value,
      });
      if (r2.error) return toast('خطأ','error');
      S.user = r2.user; toast('تم الحفظ ✅','success');
      Profile.load();
    };
    document.getElementById('my-posts').innerHTML = (u.posts||[]).slice().reverse().map(p=>Feed.renderPost(p,true)).join('') || '<p style="color:var(--text-2)">لا توجد منشورات بعد.</p>';
  }
};

/* ══ FEED & POSTS ══ */
const Feed = {
  async load(){
    document.getElementById('btn-publish').onclick = Feed.publish;
    const r = await Api.get('/posts/feed');
    document.getElementById('feed-list').innerHTML = (r.posts||[]).map(p=>Feed.renderPost(p,false)).join('') || '<p style="color:var(--text-2)">لا توجد منشورات. أضف أصدقاء!</p>';
    document.querySelectorAll('[data-like]').forEach(b=>b.onclick=async()=>{
      const r=await Api.post('/posts/'+b.dataset.like+'/like');
      if (r.ok) b.textContent='♥ '+r.likes;
    });
    document.querySelectorAll('[data-del-post]').forEach(b=>b.onclick=async()=>{
      if (!confirm('حذف المنشور؟')) return;
      const r = await Api.del('/posts/'+b.dataset.delPost);
      if (r.ok){ toast('حُذف','success'); Feed.load(); }
    });
  },
  renderPost(p, mine){
    return `<div class="post glass-card">
      <div class="post-head"><strong>@${escapeHTML(p.author)}</strong><span class="mono">${fmtTime(p.created_at)}</span></div>
      <div class="post-text">${escapeHTML(p.text)}</div>
      ${p.thumb?`<img class="post-thumb" src="${p.thumb}">`:''}
      <div class="post-actions">
        <button class="btn btn-sm btn-ghost" data-like="${p.id}">♥ ${p.likes?.length||0}</button>
        ${mine||p.author===S.username?`<button class="btn btn-sm btn-danger" data-del-post="${p.id}">حذف</button>`:''}
      </div></div>`;
  },
  async publish(){
    const text = document.getElementById('post-text').value.trim();
    const file = document.getElementById('post-image').files[0];
    let thumb = null, local_ref = null;
    if (file){
      // generate small thumbnail (max 200px) for feed; keep full image client-side
      const img = await readFileAsImage(file);
      thumb = compressImage(img, 240, 0.7);
      local_ref = await Library.saveImage(file); // store full image locally
    }
    if (!text && !thumb) return toast('اكتب شيئاً','error');
    const r = await Api.post('/posts',{text, thumb, local_ref});
    if (r.error) return toast('خطأ: '+r.error,'error');
    document.getElementById('post-text').value=''; document.getElementById('post-image').value='';
    toast('نُشر','success'); Feed.load();
  }
};

function readFileAsImage(file){
  return new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>{ const i=new Image(); i.onload=()=>res(i); i.onerror=rej; i.src=r.result; }; r.onerror=rej; r.readAsDataURL(file); });
}
function compressImage(img, maxDim, quality=0.7){
  const ratio = Math.min(1, maxDim/Math.max(img.width,img.height));
  const w = Math.round(img.width*ratio), h = Math.round(img.height*ratio);
  const c = document.createElement('canvas'); c.width=w; c.height=h;
  c.getContext('2d').drawImage(img,0,0,w,h);
  return c.toDataURL('image/jpeg', quality);
}

/* ══ CHATS ══ */
const Chats = {
  async load(){
    const r = await Api.get('/chats');
    const list = document.getElementById('chats-list');
    list.innerHTML = (r.chats||[]).map(c=>`
      <div class="card-row glass-card" style="margin-bottom:6px;cursor:pointer" data-open="${escapeHTML(c.other)}">
        <div class="card-row-left"><div class="avatar-dot">${escapeHTML((c.other||'?')[0])}</div>
          <div><div>@${escapeHTML(c.other)}</div>
          <div style="font-size:.75rem;color:var(--text-3)">${escapeHTML(c.last?.text||c.last?.type||'—')}</div></div></div>
        <div>${c.unread?`<span class="mode-badge mode-interrupt">${c.unread}</span>`:''}</div>
      </div>`).join('') || '<p style="color:var(--text-2)">لا محادثات. ابدأ من الأصدقاء.</p>';
    list.querySelectorAll('[data-open]').forEach(el=>el.onclick=()=>ChatRoom.open(el.dataset.open));
  }
};

const ChatRoom = {
  async open(other){
    S.currentChat = other;
    setText('chatroom-title','محادثة @'+other);
    App.showView('view-chatroom');
    await ChatRoom.refresh();
    if (S.chatPoll) clearInterval(S.chatPoll);
    S.chatPoll = setInterval(ChatRoom.refresh, 4000);
    document.getElementById('btn-send-msg').onclick = ChatRoom.send;
    document.getElementById('chatroom-input').onkeydown = e=>{ if (e.key==='Enter') ChatRoom.send(); };
    document.getElementById('btn-rec-toggle').onclick = ChatRoom.toggleRec;
  },
  async refresh(){
    if (!S.currentChat) return;
    const r = await Api.get('/chat/'+S.currentChat);
    const box = document.getElementById('chatroom-messages');
    box.innerHTML = (r.chat?.messages||[]).map(m=>{
      const mine = m.from===S.username;
      const cls = mine?'msg msg-mine':'msg msg-other';
      let body = escapeHTML(m.text);
      if (m.type==='voice') body = `🎙️ رسالة صوتية (${(m.duration_ms/1000).toFixed(1)}ث) — مخزّنة على جهاز المُرسِل`;
      return `<div class="${cls}">${body}<div class="msg-time">${fmtTime(m.timestamp)}</div></div>`;
    }).join('');
    box.scrollTop = box.scrollHeight;
  },
  async send(){
    const inp = document.getElementById('chatroom-input');
    const text = inp.value.trim(); if (!text) return;
    const r = await Api.post('/chat/'+S.currentChat,{text,type:'text'});
    if (r.error) return toast(r.error==='voice_not_permitted'?'لا تسمح المستلِمة باستقبال الصوت':r.error,'error');
    inp.value=''; ChatRoom.refresh();
  },
  async toggleRec(){
    if (S.recorder && S.recorder.state==='recording'){ S.recorder.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({audio:true});
      S.recChunks=[]; S.recorder = new MediaRecorder(stream);
      S.recorder.ondataavailable = e=>S.recChunks.push(e.data);
      S.recorder.onstop = async ()=>{
        const blob = new Blob(S.recChunks,{type:'audio/webm'});
        stream.getTracks().forEach(t=>t.stop());
        document.getElementById('btn-rec-toggle').classList.remove('recording');
        document.getElementById('rec-status').textContent='';
        const ref = await Library.saveAudio(blob, S.currentChat);
        const r = await Api.post('/chat/'+S.currentChat,{type:'voice', voice_local_ref:ref, duration_ms: blob.size}); // duration approx by size
        if (r.error) return toast(r.error==='voice_not_permitted'?'لم يسمح المستخدم باستقبال صوتك':r.error,'error');
        ChatRoom.refresh();
      };
      S.recorder.start();
      document.getElementById('btn-rec-toggle').classList.add('recording');
      document.getElementById('rec-status').textContent='يسجّل... اضغط الميكروفون مجدداً للإيقاف';
    } catch(e){ toast('لا يمكن الوصول للميكروفون','error'); }
  },
};

/* ══ FRIENDS ══ */
const Friends = {
  async load(){
    document.getElementById('friend-search').oninput = debounce(async e=>{
      const q=e.target.value.trim(); if(!q){document.getElementById('search-results').innerHTML='';return;}
      const r = await Api.get('/users/search?q='+encodeURIComponent(q));
      document.getElementById('search-results').innerHTML = (r.users||[]).map(u=>`
        <div class="card-row"><div class="card-row-left">@${escapeHTML(u.username)} <span style="color:var(--text-3)">${escapeHTML(u.display_name)}</span></div>
        <div><button class="btn btn-sm btn-primary" data-req="${escapeHTML(u.username)}">طلب صداقة</button></div></div>`).join('');
      document.querySelectorAll('[data-req]').forEach(b=>b.onclick=async()=>{
        const r = await Api.post('/friends/request',{username:b.dataset.req});
        if (r.ok) toast('أُرسل الطلب','success'); else toast(r.error,'error');
      });
    },300);
    const r = await Api.get('/friends');
    document.getElementById('incoming-requests').innerHTML = (r.requests_received||[]).map(u=>`
      <div class="card-row glass-card" style="margin-bottom:6px"><div>@${escapeHTML(u)}</div>
      <div><button class="btn btn-sm btn-primary" data-acc="${escapeHTML(u)}">قبول</button></div></div>`).join('') || '<p style="color:var(--text-3);font-size:.85rem">لا طلبات</p>';
    document.querySelectorAll('[data-acc]').forEach(b=>b.onclick=async()=>{
      const r=await Api.post('/friends/accept',{username:b.dataset.acc});
      if (r.ok){ toast('قُبل','success'); Friends.load(); }
    });
    document.getElementById('friends-list').innerHTML = (r.friends||[]).map(f=>`
      <div class="card-row glass-card" style="margin-bottom:6px">
        <div class="card-row-left"><div class="avatar-dot" style="background:${f.avatar_color||'#3b82f6'}">${(f.display_name||'?')[0]}</div>
          <div>${escapeHTML(f.display_name||f.username)}<div style="font-size:.75rem;color:var(--text-3)">@${escapeHTML(f.username)}</div></div></div>
        <div class="card-row-right">
          <button class="btn btn-sm btn-secondary" data-chat="${escapeHTML(f.username)}">محادثة</button>
          <button class="btn btn-sm btn-ghost" data-permit="${escapeHTML(f.username)}">سماح صوت</button>
          <button class="btn btn-sm btn-danger" data-unfriend="${escapeHTML(f.username)}">إزالة</button>
        </div></div>`).join('') || '<p style="color:var(--text-3)">لا أصدقاء بعد</p>';
    document.querySelectorAll('[data-chat]').forEach(b=>b.onclick=()=>ChatRoom.open(b.dataset.chat));
    document.querySelectorAll('[data-permit]').forEach(b=>b.onclick=async()=>{
      const r = await Api.post('/voice/permit',{username:b.dataset.permit});
      if (r.ok) toast('سمحت لهذا الصديق بإرسال الصوت','success');
    });
    document.querySelectorAll('[data-unfriend]').forEach(b=>b.onclick=async()=>{
      if (!confirm('إزالة الصديق؟')) return;
      await Api.post('/friends/remove',{username:b.dataset.unfriend}); Friends.load();
    });
  }
};
function debounce(fn,ms){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a),ms); }; }

/* ══ GROUPS ══ */
const Groups = {
  async load(){
    const fr = await Api.get('/friends');
    const picker = document.getElementById('group-member-picker');
    picker.innerHTML = (fr.friends||[]).map(f=>`<label style="margin-left:8px"><input type="checkbox" value="${escapeHTML(f.username)}"> @${escapeHTML(f.username)}</label>`).join('') || '<i>أضف أصدقاء أولاً</i>';
    document.getElementById('btn-create-group').onclick = async ()=>{
      const name = document.getElementById('group-name').value.trim();
      const members = Array.from(picker.querySelectorAll('input:checked')).map(i=>i.value);
      if (!name) return toast('أدخل اسم المجموعة','error');
      const r = await Api.post('/groups',{name,members});
      if (r.ok){ toast('أُنشئت المجموعة','success'); Groups.load(); }
    };
    const g = await Api.get('/groups');
    document.getElementById('groups-list').innerHTML = (g.groups||[]).map(x=>`
      <div class="card-row glass-card" style="margin-bottom:6px;cursor:pointer" data-grp="${x.id}">
        <div><strong>${escapeHTML(x.name)}</strong><div style="font-size:.75rem;color:var(--text-3)">${x.members.length} أعضاء</div></div>
        <div style="font-size:.75rem;color:var(--text-3)">${escapeHTML(x.last?.text||'—')}</div></div>`).join('') || '<p style="color:var(--text-2)">لا مجموعات</p>';
    document.querySelectorAll('[data-grp]').forEach(b=>b.onclick=()=>GroupRoom.open(b.dataset.grp));
  }
};
const GroupRoom = {
  async open(id){
    S.currentGroup = id;
    App.showView('view-grouproom');
    const r = await Api.get('/groups/'+id);
    setText('grouproom-title', r.group.name);
    document.getElementById('grouproom-messages').innerHTML = (r.group.messages||[]).map(m=>{
      const mine=m.from===S.username; const cls=mine?'msg msg-mine':'msg msg-other';
      return `<div class="${cls}"><strong style="font-size:.75rem;color:${mine?'#fff':'var(--text-2)'}">@${escapeHTML(m.from)}</strong><br>${escapeHTML(m.text)}<div class="msg-time">${fmtTime(m.timestamp)}</div></div>`;
    }).join('');
    document.getElementById('btn-send-group').onclick = async ()=>{
      const t = document.getElementById('grouproom-input').value.trim(); if (!t) return;
      await Api.post('/groups/'+id+'/message',{text:t});
      document.getElementById('grouproom-input').value=''; GroupRoom.open(id);
    };
    document.getElementById('btn-add-to-group').onclick = async ()=>{
      const u = document.getElementById('group-add-user').value.trim();
      const r = await Api.post('/groups/'+id+'/add',{username:u});
      if (r.ok){ toast('أُضيف','success'); GroupRoom.open(id); }
    };
  }
};

/* ══ LIBRARY (IndexedDB — client only) ══ */
const Library = {
  db: null,
  async open(){
    if (this.db) return this.db;
    return new Promise((res,rej)=>{
      const req = indexedDB.open('qqc_library', 1);
      req.onupgradeneeded = e=>{
        const db = e.target.result;
        if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio',{keyPath:'id',autoIncrement:true});
        if (!db.objectStoreNames.contains('images')) db.createObjectStore('images',{keyPath:'id',autoIncrement:true});
      };
      req.onsuccess = ()=>{ this.db=req.result; res(this.db); };
      req.onerror = ()=>rej(req.error);
    });
  },
  async saveAudio(blob, label='memo'){
    const db = await this.open();
    return new Promise((res,rej)=>{
      const tx = db.transaction('audio','readwrite');
      const r = tx.objectStore('audio').add({blob, label, created:Date.now()});
      r.onsuccess=()=>res('local:audio:'+r.result); r.onerror=()=>rej(r.error);
    });
  },
  async saveImage(file){
    const db = await this.open();
    return new Promise((res,rej)=>{
      const tx = db.transaction('images','readwrite');
      const r = tx.objectStore('images').add({blob:file, name:file.name, created:Date.now()});
      r.onsuccess=()=>res('local:image:'+r.result); r.onerror=()=>rej(r.error);
    });
  },
  async listAudio(){
    const db = await this.open();
    return new Promise((res)=>{
      const out=[]; const tx=db.transaction('audio'); tx.objectStore('audio').openCursor().onsuccess = e=>{
        const c=e.target.result; if (c){ out.push({id:c.key, ...c.value}); c.continue(); } else res(out);
      };
    });
  },
  async listImages(){
    const db = await this.open();
    return new Promise((res)=>{
      const out=[]; const tx=db.transaction('images'); tx.objectStore('images').openCursor().onsuccess = e=>{
        const c=e.target.result; if (c){ out.push({id:c.key, ...c.value}); c.continue(); } else res(out);
      };
    });
  },
  async deleteAudio(id){
    const db=await this.open(); return new Promise(res=>{ const tx=db.transaction('audio','readwrite'); tx.objectStore('audio').delete(id); tx.oncomplete=res; });
  },
  async deleteImage(id){
    const db=await this.open(); return new Promise(res=>{ const tx=db.transaction('images','readwrite'); tx.objectStore('images').delete(id); tx.oncomplete=res; });
  },
  async load(){
    document.getElementById('btn-lib-record').onclick = Library.startRecording;
    document.getElementById('btn-lib-image').onclick = ()=>document.getElementById('lib-image-input').click();
    document.getElementById('lib-image-input').onchange = async e=>{
      const f = e.target.files[0]; if (!f) return;
      await Library.saveImage(f); toast('حُفظت الصورة على جهازك','success'); Library.load();
    };
    const audios = await Library.listAudio();
    document.getElementById('lib-recordings').innerHTML = audios.length ? audios.map(a=>{
      const url = URL.createObjectURL(a.blob);
      return `<div class="card-row glass-card" style="margin-bottom:6px">
        <div><div>${escapeHTML(a.label)}</div><div style="font-size:.75rem;color:var(--text-3)">${new Date(a.created).toLocaleString('ar')}</div></div>
        <div class="card-row-right"><audio controls src="${url}" style="height:30px"></audio>
        <button class="btn btn-sm btn-danger" data-da="${a.id}">حذف</button></div></div>`;
    }).join('') : '<p style="color:var(--text-3)">لا تسجيلات</p>';
    document.querySelectorAll('[data-da]').forEach(b=>b.onclick=async()=>{ await Library.deleteAudio(+b.dataset.da); Library.load(); });
    const imgs = await Library.listImages();
    document.getElementById('lib-images').innerHTML = imgs.length ? imgs.map(i=>{
      const url = URL.createObjectURL(i.blob);
      return `<div style="position:relative"><img src="${url}" style="width:100%;height:100px;object-fit:cover;border-radius:8px"><button class="btn btn-sm btn-danger" data-di="${i.id}" style="position:absolute;top:4px;left:4px;padding:2px 6px;font-size:.7rem">×</button></div>`;
    }).join('') : '<p style="color:var(--text-3)">لا صور</p>';
    document.querySelectorAll('[data-di]').forEach(b=>b.onclick=async()=>{ await Library.deleteImage(+b.dataset.di); Library.load(); });
  },
  async startRecording(){
    if (S.recorder && S.recorder.state==='recording'){ S.recorder.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({audio:true});
      S.recChunks=[]; S.recorder = new MediaRecorder(stream);
      S.recorder.ondataavailable=e=>S.recChunks.push(e.data);
      S.recorder.onstop = async ()=>{
        const blob = new Blob(S.recChunks,{type:'audio/webm'});
        stream.getTracks().forEach(t=>t.stop());
        const label = prompt('سمِّ التسجيل (مثلاً: البقرة آية 1)') || 'تسجيل';
        await Library.saveAudio(blob,label);
        document.getElementById('btn-lib-record').classList.remove('recording');
        document.getElementById('lib-rec-status').textContent='';
        toast('حُفظ على جهازك','success'); Library.load();
      };
      S.recorder.start();
      document.getElementById('btn-lib-record').classList.add('recording');
      document.getElementById('lib-rec-status').textContent='يسجّل... اضغط الزر مجدداً للإيقاف';
    } catch(e){ toast('لا يمكن الوصول للميكروفون','error'); }
  }
};

/* ══ LEADERBOARD ══ */
const Leaderboard = {
  async load(){
    const r = await Api.get('/leaderboard');
    document.getElementById('leaderboard-list').innerHTML = (r.leaderboard||[]).map((u,i)=>`
      <div class="card-row glass-card" style="margin-bottom:6px">
        <div class="card-row-left"><div class="mono" style="width:24px;text-align:center">${i+1}</div>
          <div class="avatar-dot" style="background:${u.avatar_color}">${(u.display_name||'?')[0]}</div>
          <div>${escapeHTML(u.display_name)}<div style="font-size:.75rem;color:var(--text-3)">@${u.username}</div></div></div>
        <div class="mono">${u.pages.toFixed(2)} ص · 🔥${u.streak}</div></div>`).join('');
  }
};

/* ══ SUPPORT ══ */
const Support = {
  async load(){
    const r = await Api.get('/support');
    const box = document.getElementById('support-messages');
    box.innerHTML = (r.ticket?.messages||[]).map(m=>{
      const mine = m.from===S.username;
      return `<div class="msg ${mine?'msg-mine':'msg-other'}"><strong style="font-size:.7rem">${m.from==='admin'?'الدعم':'أنت'}</strong><br>${escapeHTML(m.text)}<div class="msg-time">${fmtTime(m.timestamp)}</div></div>`;
    }).join('') || '<p style="color:var(--text-2)">لا رسائل بعد. اكتب مشكلتك وسيرد عليك فريق الدعم.</p>';
    box.scrollTop = box.scrollHeight;
    document.getElementById('btn-send-support').onclick = async ()=>{
      const t = document.getElementById('support-input').value.trim(); if (!t) return;
      await Api.post('/support',{text:t});
      document.getElementById('support-input').value=''; Support.load();
    };
  }
};

/* ══ ADMIN ══ */
const Admin = {
  init(){
    document.getElementById('form-admin').addEventListener('submit', async e=>{
      e.preventDefault();
      const pw = document.getElementById('admin-pw').value;
      const r = await fetch(API+'/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw})}).then(r=>r.json());
      if (r.error) return toast('كلمة مرور خاطئة','error');
      S.adminPw = pw;
      App.showView('view-admin');
    });
    document.querySelectorAll('.admin-tabs .tab-btn').forEach(b=>b.onclick=()=>{
      document.querySelectorAll('.admin-tabs .tab-btn').forEach(x=>x.classList.remove('active'));
      b.classList.add('active');
      document.querySelectorAll('.atab').forEach(t=>t.classList.add('hidden'));
      document.getElementById('atab-'+b.dataset.atab).classList.remove('hidden');
      Admin.loadTab(b.dataset.atab);
    });
  },
  load(){ Admin.loadTab('overview'); },
  async loadTab(name){
    if (name==='overview'){
      const r = await Api.get('/admin/overview', true);
      document.getElementById('atab-overview').innerHTML = `
        <div class="glass-card pad" style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px">
          ${Object.entries(r.stats||{}).map(([k,v])=>`<div><div style="color:var(--text-2);font-size:.75rem">${k}</div><div class="mono" style="font-size:1.3rem">${v}</div></div>`).join('')}
        </div>`;
    }
    if (name==='users'){
      const r = await Api.get('/admin/users', true);
      document.getElementById('atab-users').innerHTML = `<div class="glass-card pad"><table>
        <tr><th>المستخدم</th><th>صفحات</th><th>سلسلة</th><th>آخر نشاط</th><th>إجراء</th></tr>
        ${(r.users||[]).map(u=>`<tr>
          <td>@${escapeHTML(u.username)} ${u.is_banned?'<span style="color:var(--red)">(محظور)</span>':''}</td>
          <td class="mono">${(u.pages||0).toFixed(2)}</td>
          <td>${u.streak||0}</td>
          <td style="font-size:.75rem">${fmtTime(u.last_active)}</td>
          <td>
            ${u.is_banned?`<button class="btn btn-sm btn-secondary" data-unban="${u.username}">رفع الحظر</button>`:`<button class="btn btn-sm btn-ghost" data-ban="${u.username}">حظر</button>`}
            <button class="btn btn-sm btn-danger" data-deluser="${u.username}">حذف</button>
          </td></tr>`).join('')}</table></div>`;
      document.querySelectorAll('[data-ban]').forEach(b=>b.onclick=async()=>{ await Api.post('/admin/user/'+b.dataset.ban+'/ban',{},true); Admin.loadTab('users'); });
      document.querySelectorAll('[data-unban]').forEach(b=>b.onclick=async()=>{ await Api.post('/admin/user/'+b.dataset.unban+'/unban',{},true); Admin.loadTab('users'); });
      document.querySelectorAll('[data-deluser]').forEach(b=>b.onclick=async()=>{ if(!confirm('حذف نهائي؟'))return; await Api.del('/admin/user/'+b.dataset.deluser,true); Admin.loadTab('users'); });
    }
    if (name==='posts'){
      const r = await Api.get('/admin/posts', true);
      document.getElementById('atab-posts').innerHTML = (r.posts||[]).map(p=>`
        <div class="glass-card pad" style="margin-bottom:8px">
          <div style="font-size:.8rem;color:var(--text-2)">@${escapeHTML(p.author)} · ${fmtTime(p.created_at)}</div>
          <div style="margin:4px 0">${escapeHTML(p.text)}</div>
          ${p.thumb?`<img src="${p.thumb}" style="max-width:120px;border-radius:6px">`:''}
          <div style="margin-top:6px"><button class="btn btn-sm btn-danger" data-aprm="${p.id}">حذف نهائي</button></div></div>`).join('');
      document.querySelectorAll('[data-aprm]').forEach(b=>b.onclick=async()=>{ await Api.del('/admin/post/'+b.dataset.aprm,true); Admin.loadTab('posts'); });
    }
    if (name==='chats'){
      const r = await Api.get('/admin/chats', true);
      document.getElementById('atab-chats').innerHTML = '<div class="glass-card pad">'+(r.chats||[]).map(c=>`
        <div class="card-row" style="cursor:pointer" data-vc="${c.id}">
          <div>${escapeHTML(c.participants.join(' ↔ '))}</div>
          <div style="font-size:.75rem;color:var(--text-3)">${c.count} رسالة</div></div>`).join('')+'</div><div id="admin-chat-detail"></div>';
      document.querySelectorAll('[data-vc]').forEach(b=>b.onclick=async()=>{
        const r = await Api.get('/admin/chat/'+encodeURIComponent(b.dataset.vc), true);
        document.getElementById('admin-chat-detail').innerHTML = '<h3 style="margin:14px 6px">رسائل</h3><div class="glass-card pad" style="max-height:50vh;overflow-y:auto">'+
          (r.chat?.messages||[]).map(m=>`<div style="border-bottom:1px solid var(--border);padding:6px 0">
            <strong>@${escapeHTML(m.from)}</strong> <span style="color:var(--text-3);font-size:.7rem">${fmtTime(m.timestamp)}</span><br>
            ${escapeHTML(m.text||m.type)}
            <button class="btn btn-sm btn-danger" style="float:left" data-dmsg="${b.dataset.vc}|${m.id}">حذف</button></div>`).join('')+'</div>';
        document.querySelectorAll('[data-dmsg]').forEach(x=>x.onclick=async()=>{
          const [cid,mid]=x.dataset.dmsg.split('|');
          await Api.del('/admin/chat/'+encodeURIComponent(cid)+'/message/'+mid, true);
          x.closest('div').remove();
        });
      });
    }
    if (name==='tickets'){
      const r = await Api.get('/admin/tickets', true);
      document.getElementById('atab-tickets').innerHTML = (r.tickets||[]).map(t=>`
        <div class="glass-card pad" style="margin-bottom:10px">
          <strong>@${escapeHTML(t.user)}</strong>
          <div style="max-height:200px;overflow-y:auto;margin:8px 0;padding:8px;background:rgba(0,0,0,.2);border-radius:6px">
            ${(t.messages||[]).map(m=>`<div><strong>${m.from==='admin'?'الدعم':'@'+escapeHTML(t.user)}:</strong> ${escapeHTML(m.text)} <span style="color:var(--text-3);font-size:.7rem">${fmtTime(m.timestamp)}</span></div>`).join('')}
          </div>
          <div style="display:flex;gap:6px"><input class="field-input" id="rep-${t.user}" placeholder="رد...">
            <button class="btn btn-primary" data-rep="${t.user}">رد</button></div></div>`).join('') || '<p style="color:var(--text-2)">لا تذاكر مفتوحة</p>';
      document.querySelectorAll('[data-rep]').forEach(b=>b.onclick=async()=>{
        const u=b.dataset.rep, t=document.getElementById('rep-'+u).value.trim(); if(!t)return;
        await Api.post('/admin/tickets/'+u+'/reply',{text:t},true); Admin.loadTab('tickets');
      });
    }
    if (name==='broadcast'){
      const r = await Api.get('/admin/overview', true); // need broadcasts list — fetch overview first then show form
      document.getElementById('atab-broadcast').innerHTML = `
        <div class="glass-card pad">
          <textarea id="bc-text" class="field-input" rows="3" placeholder="رسالة لكل المستخدمين..."></textarea>
          <button class="btn btn-primary btn-full" id="btn-bc" style="margin-top:8px">إرسال</button>
        </div>`;
      document.getElementById('btn-bc').onclick = async ()=>{
        const t = document.getElementById('bc-text').value.trim(); if (!t) return;
        await Api.post('/admin/broadcast',{message:t},true);
        toast('أُرسل','success'); document.getElementById('bc-text').value='';
      };
    }
    if (name==='channels'){
      const r = await Api.get('/admin/channels', true);
      document.getElementById('atab-channels').innerHTML = `<div class="glass-card pad">
        <h3>الشُّعب الكاملة (${(r.channels||[]).length})</h3>
        ${(r.channels||[]).length===0?'<p style="color:var(--text-2)">لا شُعب مسجّلة</p>':(r.channels||[]).map(c=>`
        <div class="card-row glass-card" style="margin-bottom:6px">
          <div><strong>${escapeHTML(c.name)}</strong>
            <div style="font-size:.75rem;color:var(--text-3)">شيخ: @${escapeHTML(c.sheikh_username)} · ${c.member_count} عضو · ${c.message_count} رسالة · ${c.announcement_count} إعلان</div>
            <div style="font-size:.75rem;color:var(--gold)">🔑 كود الانضمام: <strong>${escapeHTML(c.join_code)}</strong></div>
          </div>
        </div>`).join('')}
        </div>`;
    }
    if (name==='weights'){
      const r = await Api.get('/admin/overview', true);
      const w = r.weights||{};
      document.getElementById('atab-weights').innerHTML = `<div class="glass-card pad">
        ${Object.entries(w).map(([k,v])=>`<div class="field-group">
          <label class="field-label">${k}</label>
          <input class="field-input" data-wkey="${k}" value="${v}"></div>`).join('')}
        <button class="btn btn-primary btn-full" id="btn-save-w" style="margin-top:10px">حفظ</button></div>`;
      document.getElementById('btn-save-w').onclick = async ()=>{
        const out={}; document.querySelectorAll('[data-wkey]').forEach(i=>{ const v=parseFloat(i.value); if (!isNaN(v)) out[i.dataset.wkey]=v; });
        await Api.patch('/admin/weights', out, true); toast('حُفظت','success');
      };
    }
  }
};

/* ══ NOTIFICATIONS ══ */
const Notifications = {
  async load(){
    const r = await Api.get('/notifications');
    const el = document.getElementById('notifications-list');
    if(!el) return;
    el.innerHTML = (r.notifications||[]).map(n=>`
      <div class="card-row glass-card" style="margin-bottom:6px;opacity:${n.read?'.75':'1'}">
        <div><div style="font-size:.9rem">${escapeHTML(n.text)}</div>
          <div style="font-size:.7rem;color:var(--text-3)">${fmtTime(n.created_at)}</div></div>
        ${n.ref&&!n.ref.includes('/')&&n.ref.startsWith('view-')?`<button class="btn btn-sm btn-ghost" data-gn="${escapeHTML(n.ref)}">فتح</button>`:''}
      </div>`).join('') || '<p style="color:var(--text-2);text-align:center;padding:24px 0">لا إشعارات</p>';
    document.querySelectorAll('[data-gn]').forEach(b=>b.onclick=()=>App.showView(b.dataset.gn));
    const ra = document.getElementById('btn-read-all-notif');
    if(ra) ra.onclick = async ()=>{ await Api.post('/notifications/read-all'); Notifications.badge(); Notifications.load(); };
  },
  async badge(){
    if(!S.token) return;
    try {
      const r = await Api.get('/notifications');
      const badge = document.getElementById('notif-badge');
      if(badge){
        if(r.unread>0){ badge.textContent=r.unread>99?'99+':r.unread; badge.classList.remove('hidden'); }
        else badge.classList.add('hidden');
      }
    } catch(_){}
  },
  startPolling(){ Notifications.badge(); setInterval(Notifications.badge, 30000); }
};

/* ══ CHANNELS (شعبة) ══ */
const Channels = {
  async load(){
    const joinBtn = document.getElementById('btn-join-channel');
    if(joinBtn) joinBtn.onclick = async ()=>{
      const code = (document.getElementById('channel-join-code').value||'').trim().toUpperCase();
      if(!code) return toast('أدخل كود الانضمام','error');
      const r = await Api.post('/channels/join',{code});
      if(r.error) return toast(r.error==='invalid_code'?'كود غير صحيح':r.error==='already_member'?'أنت عضو بالفعل':r.error==='channel_full'?'الشُّعبة ممتلئة':'خطأ','error');
      toast('انضممت بنجاح','success'); document.getElementById('channel-join-code').value=''; Channels.load();
    };
    const createBtn = document.getElementById('btn-create-channel');
    if(createBtn) createBtn.onclick = async ()=>{
      const name = (document.getElementById('channel-new-name').value||'').trim();
      const desc = (document.getElementById('channel-new-desc').value||'').trim();
      const limit = +(document.getElementById('channel-new-limit').value||200);
      if(!name) return toast('أدخل اسم الشُّعبة','error');
      const r = await Api.post('/channels',{name, description:desc, max_members:limit});
      if(r.error) return toast('خطأ','error');
      toast('أُنشئت الشُّعبة','success'); document.getElementById('channel-new-name').value=''; Channels.load();
    };
    const r = await Api.get('/channels');
    const myList = document.getElementById('my-channels-list');
    if(myList) myList.innerHTML = (r.channels||[]).map(c=>`
      <div class="card-row glass-card" style="margin-bottom:6px;cursor:pointer" data-ch="${escapeHTML(c.id)}">
        <div><strong>${escapeHTML(c.name)}</strong>${c.is_sheikh?'<span class="plan-mode-badge sheikh-badge" style="margin-right:8px;font-size:.7rem">شيخ</span>':''}
          <div style="font-size:.75rem;color:var(--text-3)">${c.member_count}/${c.max_members} عضو${c.join_code?` · 🔑 <strong>${escapeHTML(c.join_code)}</strong>`:''}</div>
        </div>
        <div style="font-size:.75rem;color:var(--text-3)">${c.last?.text?escapeHTML(c.last.text.slice(0,30)):'—'}</div>
      </div>`).join('') || '<p style="color:var(--text-2);text-align:center;padding:20px 0">لا شُعب. أنشئ شُعبة أو انضم بكود!</p>';
    document.querySelectorAll('[data-ch]').forEach(el=>el.onclick=()=>ChannelRoom.open(el.dataset.ch));
    const d = await Api.get('/channels/discover');
    const discList = document.getElementById('discover-channels-list');
    if(discList) discList.innerHTML = (d.channels||[]).map(c=>`
      <div class="card-row glass-card" style="margin-bottom:6px">
        <div><strong>${escapeHTML(c.name)}</strong>
          <div style="font-size:.75rem;color:var(--text-3)">${escapeHTML(c.description||'')} · ${c.member_count}/${c.max_members} عضو</div></div>
        <span style="font-size:.75rem;color:var(--text-3)">انضم بكود الشيخ</span>
      </div>`).join('') || '<p style="color:var(--text-2);text-align:center;padding:20px 0">لا شُعب عامة متاحة حالياً</p>';
  }
};

const ChannelRoom = {
  currentId: null,
  async open(id){
    S.currentChannel = id;
    ChannelRoom.currentId = id;
    App.showView('view-channelroom');
    const r = await Api.get('/channels/'+id);
    const ch = r.channel; if(!ch) return;
    setText('channelroom-title', ch.name);
    const isS = ch.is_sheikh;
    const sheikhInput = document.getElementById('channel-sheikh-input');
    const sheikhBtn = document.getElementById('btn-sheikh-panel');
    const membersSection = document.getElementById('channel-members-section');
    if(sheikhInput) sheikhInput.style.display = isS?'block':'none';
    if(sheikhBtn) sheikhBtn.style.display = isS?'inline-flex':'none';
    // Announcements
    const annEl = document.getElementById('channel-announcements');
    if(annEl) annEl.innerHTML = (ch.announcements||[]).slice().reverse().map(a=>`
      <div class="glass-card pad channel-ann" style="margin-bottom:6px">
        <div style="font-size:.72rem;color:var(--gold)">📢 إعلان · ${fmtTime(a.timestamp)}</div>
        <div style="margin-top:4px">${escapeHTML(a.text)}</div>
      </div>`).join('');
    // Messages
    const box = document.getElementById('channelroom-messages');
    if(box){
      box.innerHTML = (ch.messages||[]).map(m=>{
        const mine=m.from===S.username;
        return `<div class="msg ${mine?'msg-mine':'msg-other'}"><strong style="font-size:.68rem;opacity:.7">@${escapeHTML(m.from)}</strong><br>${escapeHTML(m.text)}<div class="msg-time">${fmtTime(m.timestamp)}</div></div>`;
      }).join('');
      box.scrollTop = box.scrollHeight;
    }
    // Send message
    const sendBtn = document.getElementById('btn-send-channel-msg');
    const msgInput = document.getElementById('channelroom-input');
    if(sendBtn) sendBtn.onclick = async ()=>{
      const t = (msgInput?.value||'').trim(); if(!t) return;
      await Api.post('/channels/'+id+'/message',{text:t});
      if(msgInput) msgInput.value=''; ChannelRoom.open(id);
    };
    if(msgInput) msgInput.onkeydown = e=>{ if(e.key==='Enter') sendBtn?.click(); };
    // Announce
    const annBtn = document.getElementById('btn-send-announce');
    const annInput = document.getElementById('channel-announce-text');
    if(annBtn) annBtn.onclick = async ()=>{
      const t = (annInput?.value||'').trim(); if(!t) return;
      const r2 = await Api.post('/channels/'+id+'/announce',{text:t});
      if(r2.ok){ toast('أُرسل الإعلان','success'); if(annInput) annInput.value=''; ChannelRoom.open(id); }
    };
    // Sheikh panel toggle
    if(sheikhBtn) sheikhBtn.onclick = ()=>{
      if(membersSection) membersSection.style.display = membersSection.style.display==='none'?'block':'none';
    };
    // Members list (Sheikh sees all, members see sheikh DM button)
    if(membersSection){
      membersSection.style.display = 'block';
      const membersList = document.getElementById('channel-members-list');
      if(membersList) membersList.innerHTML = (ch.members||[]).map(m=>`
        <div class="card-row glass-card" style="margin-bottom:4px">
          <div class="card-row-left">
            <div class="avatar-dot" style="background:${m.avatar_color||'#3b82f6'};font-size:.85rem">${(m.display_name||m.username||'?')[0]}</div>
            <div>${escapeHTML(m.display_name||m.username)}
              ${m.is_sheikh?'<span class="sheikh-badge" style="font-size:.65rem;margin-right:4px">شيخ</span>':''}
              <div style="font-size:.7rem;color:var(--text-3)">@${escapeHTML(m.username)} · ${(m.pages||0).toFixed(1)}ص · 🔥${m.streak||0}</div>
            </div>
          </div>
          <div style="display:flex;gap:4px;align-items:center">
            ${m.username!==S.username?`<button class="btn btn-sm btn-secondary" data-dm="${escapeHTML(m.username)}" title="مراسلة مباشرة">📨</button>`:''}
            ${isS && m.username!==S.username?`<button class="btn btn-sm btn-danger" data-kick="${escapeHTML(m.username)}">إزالة</button>`:''}
          </div>
        </div>`).join('');
      document.querySelectorAll('[data-dm]').forEach(b=>b.onclick=()=>ChatRoom.open(b.dataset.dm));
      document.querySelectorAll('[data-kick]').forEach(b=>b.onclick=async()=>{
        if(!confirm(`إزالة @${b.dataset.kick}؟`)) return;
        const r3 = await Api.del('/channels/'+id+'/member/'+b.dataset.kick);
        if(r3.ok){ toast('أُزيل العضو','success'); ChannelRoom.open(id); }
      });
    }
    // Sheikh panel toggle (only sheikh sees the announce input)
    if(sheikhBtn) sheikhBtn.style.display = isS?'inline-flex':'none';
    if(sheikhInput) sheikhInput.style.display = isS?'block':'none';
  }
};

/* ══ AI COACH ══ */
const AiCoach = {
  _inited: false,
  messages: [],
  init(){
    if(AiCoach._inited){ AiCoach.render(); return; }
    AiCoach._inited = true;
    AiCoach.messages = [];
    const sendBtn = document.getElementById('btn-send-ai');
    const aiInput = document.getElementById('ai-input');
    if(sendBtn) sendBtn.onclick = AiCoach.send;
    if(aiInput) aiInput.onkeydown = e=>{ if(e.key==='Enter') AiCoach.send(); };
    document.querySelectorAll('.ai-quick').forEach(b=>b.onclick=()=>{
      const aiInp = document.getElementById('ai-input');
      if(aiInp) aiInp.value = b.dataset.q; AiCoach.send();
    });
    AiCoach.render();
  },
  async send(){
    const inp = document.getElementById('ai-input');
    const text = (inp?.value||'').trim(); if(!text) return;
    if(inp) inp.value='';
    AiCoach.messages.push({from:'user',text});
    AiCoach.render();
    const r = await Api.post('/ai-coach',{message:text});
    AiCoach.messages.push({from:'ai',text:r.reply||'...'});
    AiCoach.render();
  },
  render(){
    const box = document.getElementById('ai-messages');
    if(!box) return;
    if(!AiCoach.messages.length){
      box.innerHTML='<div style="color:var(--text-2);text-align:center;padding:50px 0">👋 أهلاً! كيف أساعدك في رحلة حفظ القرآن اليوم؟</div>';
      return;
    }
    box.innerHTML = AiCoach.messages.map(m=>{
      const mine=m.from==='user';
      return `<div class="msg ${mine?'msg-mine':'msg-other'}">${escapeHTML(m.text)}</div>`;
    }).join('');
    box.scrollTop = box.scrollHeight;
  }
};

/* ══ Boot ══ */
const Boot = {
  async start(){
    Auth.init();
    Onboarding.init();
    Session.init();
    Admin.init();
    document.querySelectorAll('[data-go]').forEach(b=>b.addEventListener('click', ()=>App.showView(b.dataset.go)));
    UI.showApp();
    if (S.token && S.username) await Boot.afterLogin();
    else App.showView('view-auth');
    UI.setLoading(false);
    Sensors.init();
    if(S.token) Notifications.startPolling();
  },
  async afterLogin(){
    const r = await Api.get('/me');
    if (r.error){ localStorage.clear(); App.showView('view-auth'); return; }
    S.user = r.user;
    if (!S.user.onboarding?.completed) App.showView('view-onboarding');
    else App.showView('view-dashboard');
  }
};

document.addEventListener('DOMContentLoaded', Boot.start);
