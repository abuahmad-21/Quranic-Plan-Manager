/* ═══════════════════════════════════════════════════════════════
   QUANTUM QURAN COACH — app.js (v2)
   SPA · Auth · Onboarding · Dashboard · Sensors · Plan
   Friends · Chats · Groups · Posts · Profile · Library (IndexedDB)
   Voice Recording · Support · Admin
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const API = '/qqc';

/* Safe localStorage wrapper — handles iOS Safari private mode */
const LS = {
  get(k){ try{ return localStorage.getItem(k); }catch(_){ return null; } },
  set(k,v){ try{ localStorage.setItem(k,v); }catch(_){} },
  del(k){ try{ localStorage.removeItem(k); }catch(_){} },
  clear(){ try{ localStorage.clear(); }catch(_){} },
};

const S = {
  token:    LS.get('qqc_token') || null,
  username: LS.get('qqc_user')  || null,
  adminPw:  null,
  user:     null,
  mode:     'NORMAL_MODE',
  currentChat: null,
  currentGroup: null,
  chatPoll: null,
  recorder: null, recChunks: [], recTarget: null,
};

/* ════════════════════════════════════════════════════
   ERROR LOGGER — يسجّل كل أخطاء الموقع والذكاء الاصطناعي والتسميع
   ════════════════════════════════════════════════════ */
const ErrorLogger = {
  _queue: [],
  _flushing: false,

  /* تسجيل خطأ موقع أو نظام */
  logError(message, context={}, type='website'){
    const record = { type, message: String(message||''), context, url: location.href, ts: Date.now() };
    ErrorLogger._queue.push({ endpoint: '/logs/error', body: record });
    ErrorLogger._flush();
    console.warn('[ErrorLogger]', type, message, context);
  },

  /* تسجيل خطأ ذكاء اصطناعي */
  logAiError(message, context={}){
    ErrorLogger.logError(message, context, 'ai');
  },

  /* تسجيل خطأ تسميع (الأهم) */
  logRecitationError({ surah_name='', surah_number=0, ayah_number=0, from_ayah=0, to_ayah=0,
                       error_type='recitation', wrong_words=[], expected_text='', actual_text='',
                       accuracy_pct=0, ai_feedback='', method='speech_recognition', session_id='' }){
    const record = { surah_name, surah_number, ayah_number, from_ayah, to_ayah, error_type,
                     wrong_words, expected_text, actual_text, accuracy_pct: Math.round(accuracy_pct),
                     ai_feedback, method, session_id: session_id || ('s_' + Date.now()) };
    ErrorLogger._queue.push({ endpoint: '/logs/recitation', body: record });
    ErrorLogger._flush();
  },

  async _flush(){
    if (ErrorLogger._flushing || !ErrorLogger._queue.length) return;
    ErrorLogger._flushing = true;
    while (ErrorLogger._queue.length) {
      const item = ErrorLogger._queue.shift();
      try {
        await fetch(API + item.endpoint, {
          method: 'POST',
          headers: { 'Content-Type':'application/json', 'x-token': S.token||'', 'x-username': S.username||'' },
          body: JSON.stringify(item.body)
        });
      } catch(e){ /* silent fail */ }
    }
    ErrorLogger._flushing = false;
  },

  /* تثبيت معالج الأخطاء العالمي */
  init(){
    window.addEventListener('error', ev=>{
      ErrorLogger.logError(ev.message || 'JS Error', { filename: ev.filename, lineno: ev.lineno, colno: ev.colno }, 'website');
    });
    window.addEventListener('unhandledrejection', ev=>{
      ErrorLogger.logError(String(ev.reason?.message || ev.reason || 'Unhandled Promise'), {}, 'website');
    });
  }
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
    if (id==='view-quran') QuranBrowser.load();
    if (id==='view-studio') { App.showView('view-tarteel'); return; }
    if (id==='view-tarteel') TarteelMode.load();
    if (id==='view-khatma') KhatmaMode.load();
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
function fmtRel(iso){
  if(!iso) return '—';
  const d=Math.floor((Date.now()-new Date(iso).getTime())/1000);
  if(d<60) return 'الآن';
  if(d<3600) return `منذ ${Math.floor(d/60)} دق`;
  if(d<86400) return `منذ ${Math.floor(d/3600)} س`;
  if(d<604800) return `منذ ${Math.floor(d/86400)} يوم`;
  return new Date(iso).toLocaleDateString('ar');
}

/* ══ AUTH ══ */
const Auth = {
  showErr(id, msg){ const el=document.getElementById(id); if(el){el.textContent=msg;el.style.display=msg?'block':'none';} },
  init(){
    /* Tab switching */
    document.querySelectorAll('.auth-tabs .tab-btn').forEach(b=>b.addEventListener('click',()=>{
      document.querySelectorAll('.auth-tabs .tab-btn').forEach(x=>x.classList.remove('active'));
      b.classList.add('active');
      const t=b.dataset.tab;
      document.getElementById('form-login').classList.toggle('hidden', t!=='login');
      document.getElementById('form-register').classList.toggle('hidden', t!=='register');
      Auth.showErr('login-error',''); Auth.showErr('reg-error','');
    }));

    /* Remember-me default: restore saved preference */
    const savedRemember = LS.get('qqc_remember') !== 'false';
    const remCb = document.getElementById('login-remember');
    if (remCb) remCb.checked = savedRemember;

    /* Password strength meter */
    document.getElementById('reg-password')?.addEventListener('input', Auth.updateStrength);

    /* Allow Enter key in login fields */
    ['login-username','login-password'].forEach(id=>{
      document.getElementById(id)?.addEventListener('keydown', e=>{ if(e.key==='Enter') Auth.doLogin(); });
    });
    ['reg-username','reg-display','reg-password'].forEach(id=>{
      document.getElementById(id)?.addEventListener('keydown', e=>{ if(e.key==='Enter') Auth.doRegister(); });
    });

    /* Login button */
    document.getElementById('btn-do-login')?.addEventListener('click', Auth.doLogin);

    /* Register button */
    document.getElementById('btn-do-register')?.addEventListener('click', Auth.doRegister);

    /* Logout */
    document.getElementById('btn-logout')?.addEventListener('click', async ()=>{
      await Api.post('/auth/logout').catch(()=>{});
      LS.clear(); location.reload();
    });
  },

  updateStrength(){
    const pw = document.getElementById('reg-password')?.value||'';
    const bar = document.getElementById('pw-strength-bar');
    const lbl = document.getElementById('pw-strength-lbl');
    if (!bar||!lbl) return;
    let score=0;
    if (pw.length>=4) score++;
    if (pw.length>=8) score++;
    if (/[0-9]/.test(pw)) score++;
    if (/[a-zA-Z]/.test(pw)&&/[^a-zA-Z0-9]/.test(pw)) score++;
    const levels=[
      {w:'0%',c:'#ef4444',t:''},
      {w:'25%',c:'#ef4444',t:'ضعيفة'},
      {w:'50%',c:'#f59e0b',t:'مقبولة'},
      {w:'75%',c:'#3b82f6',t:'جيدة'},
      {w:'100%',c:'#10b981',t:'قوية جداً'},
    ];
    const lv=levels[score]||levels[0];
    bar.style.width=lv.w; bar.style.background=lv.c;
    lbl.textContent=lv.t; lbl.style.color=lv.c;
  },

  async doLogin(){
    const username = (document.getElementById('login-username')?.value||'').trim().toLowerCase();
    const password = document.getElementById('login-password')?.value||'';
    const rememberMe = document.getElementById('login-remember')?.checked !== false;
    Auth.showErr('login-error','');
    if (!username) return Auth.showErr('login-error','أدخل اسم المستخدم');
    if (!password) return Auth.showErr('login-error','أدخل كلمة المرور');
    LS.set('qqc_remember', rememberMe ? 'true' : 'false');
    const btn = document.getElementById('btn-do-login');
    if (btn){ btn.disabled=true; btn.textContent='⏳ جارٍ الدخول…'; }
    try {
      const r = await Api.post('/auth/login',{username, password, remember_me: rememberMe});
      if (r.error){
        const msgs = {
          bad_credentials: r.attempts_remaining!=null
            ? `كلمة المرور خاطئة — ${r.attempts_remaining} محاولات متبقية قبل الإيقاف المؤقت`
            : 'اسم المستخدم أو كلمة المرور غير صحيحة',
          banned:'هذا الحساب موقوف',
          rate_limited: r.message||'محاولات كثيرة — انتظر قليلاً',
        };
        Auth.showErr('login-error', msgs[r.error]||'خطأ: '+r.error);
      } else {
        if (r.last_login) toast(`آخر دخول: ${fmtRel(r.last_login)}`,'info',3000);
        Auth.onLogin(r, rememberMe);
      }
    } catch(e){
      Auth.showErr('login-error','تعذّر الاتصال بالخادم — تحقق من الإنترنت');
    } finally {
      if (btn){ btn.disabled=false; btn.textContent='دخول'; }
    }
  },

  async doRegister(){
    const username = (document.getElementById('reg-username')?.value||'').trim().toLowerCase();
    const display  = (document.getElementById('reg-display')?.value||'').trim();
    const password = document.getElementById('reg-password')?.value||'';
    const rememberMe = true; // new accounts always remembered
    Auth.showErr('reg-error','');
    if (!username) return Auth.showErr('reg-error','أدخل اسم المستخدم');
    if (!/^[a-z0-9_]{3,20}$/.test(username)) return Auth.showErr('reg-error','اسم المستخدم: حروف إنجليزية صغيرة وأرقام فقط، 3-20 حرف');
    if (!display)  return Auth.showErr('reg-error','أدخل الاسم الظاهر');
    if (password.length < 4) return Auth.showErr('reg-error','كلمة المرور يجب أن تكون 4 أحرف على الأقل');
    const btn = document.getElementById('btn-do-register');
    if (btn){ btn.disabled=true; btn.textContent='⏳ جارٍ الإنشاء…'; }
    try {
      const r = await Api.post('/auth/register',{username, password, display_name:display, remember_me:rememberMe});
      if (r.error){
        const msgs = {invalid_input:'اسم المستخدم غير صالح أو كلمة المرور قصيرة جداً',username_taken:'اسم المستخدم مأخوذ — اختر اسماً آخر'};
        Auth.showErr('reg-error', msgs[r.error]||'خطأ: '+r.error);
      } else {
        Auth.onLogin(r, rememberMe);
      }
    } catch(e){
      Auth.showErr('reg-error','تعذّر الاتصال بالخادم — تحقق من الإنترنت');
    } finally {
      if (btn){ btn.disabled=false; btn.textContent='إنشاء الحساب'; }
    }
  },

  onLogin(r, rememberMe=true){
    S.token=r.token; S.username=r.username;
    Library.db = null;
    LS.set('qqc_token', r.token);
    LS.set('qqc_user', r.username);
    LS.set('qqc_remember', rememberMe ? 'true' : 'false');
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
    if (av){ Profile.renderAvatar(av, S.user); }
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

    // Plan Generator
    const genBtn = document.getElementById('btn-generate-plan');
    const genResult = document.getElementById('gen-plan-result');
    if(genBtn) genBtn.onclick = async ()=>{
      const from_page  = +document.getElementById('gen-from-page')?.value||1;
      const total_pages= +document.getElementById('gen-total-pages')?.value||20;
      const duration   = +document.getElementById('gen-duration')?.value||30;
      const minutes    = +document.getElementById('gen-minutes')?.value||30;
      const review_also= document.getElementById('gen-review-also')?.checked?1:0;
      if(total_pages<1||duration<7) return toast('بيانات غير صحيحة','error');
      genBtn.disabled=true; genBtn.textContent='⏳ جاري التوليد...';
      const res2 = await Api.post('/plan/generate',{from_page,total_pages,duration_days:duration,daily_minutes:minutes,review_also});
      genBtn.disabled=false; genBtn.textContent='✨ توليد الخطة';
      if(res2.error) return toast('خطأ','error');
      const p2 = res2.plan;
      if(genResult){
        genResult.style.display='block';
        const modeLabel={both:'حفظ ومراجعة',memorization_only:'حفظ فقط',review_only:'مراجعة فقط'}[p2.mode]||'حفظ ومراجعة';
        genResult.innerHTML=`<div class="glass-card pad" style="border:1px solid rgba(99,102,241,.3)">
          <div style="font-size:.75rem;color:#a78bfa;margin-bottom:4px">✨ خطتك المخصصة</div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:10px">
            <div style="text-align:center;padding:8px;background:rgba(255,255,255,.05);border-radius:8px">
              <div class="mono" style="font-size:1.2rem;color:#34d399">${p2.daily_memorization_pages}</div>
              <div style="font-size:.7rem;color:var(--text-3)">صفحة حفظ/يوم</div>
            </div>
            ${p2.daily_review_pages?`<div style="text-align:center;padding:8px;background:rgba(255,255,255,.05);border-radius:8px">
              <div class="mono" style="font-size:1.2rem;color:#60a5fa">${p2.daily_review_pages}</div>
              <div style="font-size:.7rem;color:var(--text-3)">صفحة مراجعة/يوم</div>
            </div>`:''}
            <div style="text-align:center;padding:8px;background:rgba(255,255,255,.05);border-radius:8px">
              <div class="mono" style="font-size:1.2rem;color:#fbbf24">${p2.duration_days}</div>
              <div style="font-size:.7rem;color:var(--text-3)">يوم</div>
            </div>
          </div>
          <div style="font-size:.82rem;color:var(--text-2);margin-bottom:10px;padding:8px;background:rgba(167,139,250,.1);border-radius:8px">
            💬 ${escapeHTML(p2.ai_note||'')}
          </div>
          <div style="font-size:.75rem;color:var(--text-3);margin-bottom:8px">نوع الخطة: ${modeLabel} · صفحات ${p2.from_page}–${p2.to_page}</div>
          <button class="btn btn-primary btn-full" id="btn-apply-gen-plan">✅ تطبيق هذه الخطة</button>
        </div>`;
        document.getElementById('btn-apply-gen-plan').onclick = async ()=>{
          const res3 = await Api.post('/plan/generate',{from_page,total_pages,duration_days:duration,daily_minutes:minutes,review_also,apply:true});
          if(res3.ok){ toast('✅ تُطبَّق خطتك الجديدة!','success',4000); const me=await Api.get('/me'); S.user=me.user; Plan.load(); }
        };
      }
    };

    // Admin Plans Picker
    const adminPlansEl = document.getElementById('admin-plans-section');
    if(adminPlansEl){
      const plansResp = await Api.get('/plans');
      const plans = plansResp.plans||[];
      if(plans.length){
        const modeMap={both:'حفظ ومراجعة',memorization_only:'حفظ فقط',review_only:'مراجعة فقط'};
        adminPlansEl.innerHTML=`<div class="glass-card pad" style="border:1px solid rgba(52,211,153,.2)">
          <div style="font-size:.75rem;color:#34d399;margin-bottom:8px">📋 خطط الحفظ المتاحة (من الإدارة)</div>
          ${plans.map(pl=>`<div class="card-row" style="margin-bottom:6px;padding:8px;background:rgba(255,255,255,.04);border-radius:8px">
            <div>
              <strong style="font-size:.9rem">${escapeHTML(pl.name)}</strong>
              <div style="font-size:.75rem;color:var(--text-2);">${pl.daily_pages} صفحة/يوم · ${modeMap[pl.mode]||pl.mode}${pl.description?' · '+escapeHTML(pl.description.slice(0,60)):''}</div>
            </div>
            <button class="btn btn-sm btn-secondary" data-apply-plan='${JSON.stringify({daily_pages:pl.daily_pages,mode:pl.mode})}'>تطبيق</button>
          </div>`).join('')}
        </div>`;
        adminPlansEl.querySelectorAll('[data-apply-plan]').forEach(b=>b.onclick=async()=>{
          const pl2=JSON.parse(b.dataset.applyPlan);
          const r2=await Api.patch('/plan',{current_daily_pages:pl2.daily_pages,manual_override:true});
          if(r2.ok){
            if(pl2.mode){ await Api.patch('/me',{plan_mode:pl2.mode}); if(S.user?.onboarding) S.user.onboarding.plan_mode=pl2.mode; }
            const me=await Api.get('/me'); S.user=me.user;
            toast('✅ تم تطبيق الخطة!','success'); Plan.load();
          }
        });
      } else adminPlansEl.innerHTML='';
    }
  }
};

/* ══ PROFILE ══ */
const AVATAR_EMOJIS = ['😊','🌟','📖','🕌','🌙','⭐','🏆','💎','🦋','🌺','🌴','🦅','🌊','🔥','❤️','🙏','🤲','📿','🌹','🌸','🦁','🐉','🌈','☀️','🌙','💫','⚡','🎯','🎓','🕋'];

const Profile = {
  _selectedEmoji: null,

  renderAvatar(el, user){
    if (!el) return;
    el.style.background = user.avatar_color || '#1e3a5f';
    const imgEl = el.querySelector('img');
    // Set or clear text node (first text node in the element)
    let tn = null;
    for (const n of el.childNodes) { if (n.nodeType === 3){ tn = n; break; } }
    if (!tn){ tn = document.createTextNode(''); el.insertBefore(tn, el.firstChild); }
    if (user.avatar_url && imgEl){
      imgEl.src = user.avatar_url;
      imgEl.style.display = 'block';
      tn.textContent = '';
    } else {
      if (imgEl) imgEl.style.display = 'none';
      const label = user.avatar_emoji || (user.display_name||'?')[0].toUpperCase();
      tn.textContent = label;
      el.style.fontSize = user.avatar_emoji ? '1.6rem' : '';
    }
  },

  async load(){
    const r = await Api.get('/me'); S.user = r.user;
    const u = S.user;
    Profile._selectedEmoji = u.avatar_emoji || null;

    setText('profile-name', u.display_name);
    setText('profile-handle', '@'+u.username);
    const av = document.getElementById('profile-avatar');
    Profile.renderAvatar(av, u);

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
    const usernameEl = document.getElementById('pf-username');
    const statusEl   = document.getElementById('pf-username-status');
    if (usernameEl) usernameEl.value = u.username||'';

    document.getElementById('pf-display').value = u.display_name||'';
    document.getElementById('pf-bio').value     = u.bio||'';
    document.getElementById('pf-color').value   = u.avatar_color||'#3b82f6';

    // Emoji grid
    const emojiGrid = document.getElementById('pf-emoji-grid');
    if (emojiGrid){
      emojiGrid.innerHTML = `<button class="btn btn-sm ${!Profile._selectedEmoji?'btn-secondary':'btn-ghost'}" data-em="" style="font-size:.85rem">لا شيء</button>` +
        AVATAR_EMOJIS.map(e=>`<button class="btn btn-sm ${Profile._selectedEmoji===e?'btn-secondary':'btn-ghost'} emoji-sel-btn" data-em="${e}" style="font-size:1.2rem;padding:4px 8px">${e}</button>`).join('');
      emojiGrid.querySelectorAll('[data-em]').forEach(btn=>btn.onclick=()=>{
        Profile._selectedEmoji = btn.dataset.em || null;
        emojiGrid.querySelectorAll('[data-em]').forEach(b=>{ b.classList.remove('btn-secondary'); b.classList.add('btn-ghost'); });
        btn.classList.add('btn-secondary'); btn.classList.remove('btn-ghost');
        // Preview
        Profile.renderAvatar(av, {...u, avatar_emoji: Profile._selectedEmoji, avatar_color: document.getElementById('pf-color').value});
      });
    }

    // Photo upload handler
    const photoInput = document.getElementById('pf-photo-input');
    if (photoInput){
      photoInput.onchange = async e=>{
        const file = e.target.files[0];
        if (!file) return;
        if (file.size > 5*1024*1024) return toast('الصورة أكبر من 5MB، اختر صورة أصغر','error');
        const dataUrl = await new Promise(res=>{
          const canvas = document.createElement('canvas');
          const img = new Image();
          img.onload = ()=>{
            const MAX = 256;
            let {width:w, height:h} = img;
            if (w>h){ h=Math.round(h*MAX/w); w=MAX; } else { w=Math.round(w*MAX/h); h=MAX; }
            canvas.width=w; canvas.height=h;
            canvas.getContext('2d').drawImage(img,0,0,w,h);
            res(canvas.toDataURL('image/jpeg',0.85));
          };
          img.src = URL.createObjectURL(file);
        });
        const r2 = await Api.patch('/me', {avatar_url: dataUrl});
        if (r2.error) return toast('فشل رفع الصورة','error');
        S.user = r2.user;
        Profile.renderAvatar(av, r2.user);
        toast('تم تحديث الصورة ✅','success');
        // Also update header avatar
        const headerAv = document.getElementById('user-avatar');
        if (headerAv) Profile.renderAvatar(headerAv, r2.user);
      };
    }

    // Avatar click → emoji panel toggle (same as emoji grid in form)
    if (av) av.onclick = ()=>{ emojiGrid?.scrollIntoView({behavior:'smooth',block:'nearest'}); };

    // Live color preview
    document.getElementById('pf-color')?.addEventListener('input', e=>{
      Profile.renderAvatar(av, {...u, avatar_emoji: Profile._selectedEmoji, avatar_color: e.target.value});
    });

    // Username availability check
    let checkTimeout;
    if (usernameEl && statusEl){
      usernameEl.oninput = ()=>{
        clearTimeout(checkTimeout);
        const val = usernameEl.value.toLowerCase().trim();
        if (val === u.username){ statusEl.textContent=''; statusEl.style.color=''; return; }
        statusEl.textContent='⏳ ...'; statusEl.style.color='var(--text-3)';
        checkTimeout = setTimeout(async ()=>{
          const res = await fetch(`/qqc/auth/check-username?username=${encodeURIComponent(val)}`).then(r=>r.json()).catch(()=>({available:false}));
          if (val !== usernameEl.value.toLowerCase().trim()) return; // stale
          if (!val || !/^[a-z0-9_]{3,20}$/.test(val)){
            statusEl.textContent='⚠ اسم المستخدم يجب أن يكون 3-20 حرف (أحرف إنجليزية، أرقام، _)';
            statusEl.style.color='#f59e0b';
          } else if (res.available){
            statusEl.textContent='✅ متاح';
            statusEl.style.color='#34d399';
          } else {
            statusEl.textContent = res.reason==='invalid' ? '⚠ تنسيق غير صحيح' : '❌ محجوز بالفعل';
            statusEl.style.color='#ef4444';
          }
        }, 600);
      };
    }

    const checkBtn = document.getElementById('btn-check-username');
    if (checkBtn) checkBtn.onclick = async ()=>{
      const val = usernameEl?.value.toLowerCase().trim();
      if (!val || !statusEl) return;
      const res = await fetch(`/qqc/auth/check-username?username=${encodeURIComponent(val)}`).then(r=>r.json()).catch(()=>({available:false}));
      if (res.available){ statusEl.textContent='✅ متاح'; statusEl.style.color='#34d399'; }
      else { statusEl.textContent = res.reason==='invalid' ? '⚠ تنسيق غير صحيح' : '❌ محجوز بالفعل'; statusEl.style.color='#ef4444'; }
    };

    // Remove photo button
    document.getElementById('btn-remove-photo')?.addEventListener('click', async ()=>{
      if (!S.user?.avatar_url) return toast('لا توجد صورة شخصية','info');
      const r2 = await Api.patch('/me', {avatar_url: 'remove'});
      if (r2.error) return toast('فشل الحذف','error');
      S.user = r2.user;
      Profile.renderAvatar(av, r2.user);
      const headerAv = document.getElementById('user-avatar');
      if (headerAv) Profile.renderAvatar(headerAv, r2.user);
      toast('تم حذف الصورة الشخصية','success');
    });

    document.getElementById('btn-save-profile').onclick = async ()=>{
      const newUsername = usernameEl?.value.toLowerCase().trim();
      const payload = {
        display_name: document.getElementById('pf-display').value.trim(),
        bio: document.getElementById('pf-bio').value.trim(),
        avatar_color: document.getElementById('pf-color').value,
        avatar_emoji: Profile._selectedEmoji || '',
      };
      if (newUsername && newUsername !== u.username) payload.new_username = newUsername;
      const r2 = await Api.patch('/me', payload);
      if (r2.error) return toast(r2.error==='username_taken'?'اسم المستخدم محجوز':'خطأ في الحفظ','error');
      if (r2.username_changed){
        S.username = r2.new_username;
        LS.set('qqc_user', r2.new_username);
        toast('تم تغيير اسم المستخدم ✅','success');
      } else {
        toast('تم الحفظ ✅','success');
      }
      S.user = r2.user;
      // Update header avatar
      const headerAv = document.getElementById('user-avatar');
      if (headerAv) Profile.renderAvatar(headerAv, r2.user);
      const dn = document.getElementById('dash-display-name');
      if (dn) dn.textContent = r2.user.display_name;
      Profile.load();
    };
    document.getElementById('my-posts').innerHTML = (u.posts||[]).slice().reverse().map(p=>Feed.renderPost(p,true)).join('') || '<p style="color:var(--text-2)">لا توجد منشورات بعد.</p>';
    document.querySelectorAll('[data-like]').forEach(b=>b.onclick=async()=>{
      const res=await Api.post('/posts/'+b.dataset.like+'/like'); if(res.ok) b.querySelector('.like-cnt').textContent=res.likes;
    });
    document.querySelectorAll('[data-del-post]').forEach(b=>b.onclick=async()=>{
      if(!confirm('حذف المنشور؟'))return; const res=await Api.del('/posts/'+b.dataset.delPost);
      if(res.ok){ toast('حُذف','success'); Profile.load(); }
    });
  }
};

/* ══ FEED & POSTS ══ */
const Feed = {
  _tab: 'friends',

  async load(){
    document.getElementById('btn-publish').onclick = Feed.publish;
    // Tab switching
    document.querySelectorAll('.feed-tab').forEach(t=>t.onclick=()=>{
      document.querySelectorAll('.feed-tab').forEach(x=>{ x.classList.remove('active','btn-secondary'); x.classList.add('btn-ghost'); });
      t.classList.add('active','btn-secondary'); t.classList.remove('btn-ghost');
      Feed._tab = t.dataset.feedTab;
      Feed.loadPosts();
    });
    Feed.loadPosts();
  },

  async loadPosts(){
    const listEl = document.getElementById('feed-list');
    if (listEl) listEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-2)">⏳ جارٍ التحميل…</div>';
    const endpoint = Feed._tab === 'explore' ? '/posts' : '/posts/feed';
    const r = await Api.get(endpoint);
    const posts = r.posts || [];
    if (listEl){
      listEl.innerHTML = posts.length
        ? posts.map(p=>Feed.renderPost(p, p.author===S.username)).join('')
        : `<p style="color:var(--text-2);text-align:center;padding:20px">${Feed._tab==='friends'?'لا توجد منشورات. أضف أصدقاء للمتابعة!':'لا توجد منشورات بعد.'}</p>`;
    }
    Feed.wireActions();
  },

  wireActions(){
    document.querySelectorAll('[data-like]').forEach(b=>b.onclick=async()=>{
      const r=await Api.post('/posts/'+b.dataset.like+'/like');
      if (r.ok){ const cnt=b.querySelector('.like-cnt'); if(cnt) cnt.textContent=r.likes; }
    });
    document.querySelectorAll('[data-del-post]').forEach(b=>b.onclick=async()=>{
      if (!confirm('حذف المنشور؟')) return;
      const r=await Api.del('/posts/'+b.dataset.delPost);
      if (r.ok){ toast('حُذف','success'); Feed.loadPosts(); }
    });
    document.querySelectorAll('[data-comment-toggle]').forEach(b=>b.onclick=()=>{
      const id=b.dataset.commentToggle;
      const area=document.getElementById('comment-area-'+id);
      if(area) area.style.display=area.style.display==='none'?'block':'none';
    });
    document.querySelectorAll('[data-comment-send]').forEach(b=>b.onclick=async()=>{
      const id=b.dataset.commentSend;
      const inp=document.getElementById('comment-inp-'+id);
      if(!inp||!inp.value.trim()) return;
      const r=await Api.post('/posts/'+id+'/comment',{text:inp.value.trim()});
      if(r.ok){ inp.value=''; Feed.loadPosts(); toast('تم التعليق','success'); }
    });
  },

  renderPost(p, mine){
    const authorUser = p.author_display || p.author;
    const commentsList = (p.comments||[]).slice(-5).map(c=>`
      <div style="display:flex;gap:6px;align-items:flex-start;padding:4px 0;border-top:1px solid rgba(255,255,255,.05)">
        <div class="avatar-dot" style="width:22px;height:22px;font-size:.65rem;flex-shrink:0">${escapeHTML((c.from||'?')[0].toUpperCase())}</div>
        <div style="flex:1;min-width:0">
          <span style="font-size:.75rem;color:var(--gold);font-weight:600">@${escapeHTML(c.from)}</span>
          <span style="font-size:.82rem;color:var(--text-1);margin-right:5px">${escapeHTML(c.text)}</span>
        </div>
        <span class="mono" style="font-size:.68rem;color:var(--text-3);flex-shrink:0">${fmtTime(c.created_at)}</span>
      </div>`).join('');
    return `<div class="post glass-card" style="margin-bottom:10px">
      <div class="post-head" style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <div class="avatar-dot" style="width:36px;height:36px;font-size:.9rem;flex-shrink:0">${escapeHTML((p.author||'?')[0].toUpperCase())}</div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;font-size:.9rem">@${escapeHTML(p.author)}</div>
          <div class="mono" style="font-size:.72rem;color:var(--text-3)">${fmtTime(p.created_at)}</div>
        </div>
        ${mine?`<button class="btn btn-sm btn-danger" data-del-post="${p.id}" style="opacity:.7">حذف</button>`:''}
      </div>
      ${p.text?`<div class="post-text" style="margin-bottom:8px">${escapeHTML(p.text)}</div>`:''}
      ${p.thumb?`<img class="post-thumb" src="${p.thumb}" style="border-radius:10px;width:100%;max-height:300px;object-fit:cover;margin-bottom:8px">`:''}
      <div class="post-actions" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <button class="btn btn-sm btn-ghost" data-like="${p.id}" style="gap:4px">♥ <span class="like-cnt">${p.likes?.length||0}</span></button>
        <button class="btn btn-sm btn-ghost" data-comment-toggle="${p.id}">💬 ${(p.comments||[]).length}</button>
      </div>
      <div id="comment-area-${p.id}" style="display:none;margin-top:8px">
        ${commentsList?`<div style="margin-bottom:6px">${commentsList}</div>`:''}
        <div style="display:flex;gap:6px">
          <input id="comment-inp-${p.id}" class="field-input" style="flex:1;padding:6px 10px;font-size:.82rem" placeholder="اكتب تعليقاً...">
          <button class="btn btn-sm btn-secondary" data-comment-send="${p.id}">إرسال</button>
        </div>
      </div>
    </div>`;
  },

  async publish(){
    const text = document.getElementById('post-text').value.trim();
    const file = document.getElementById('post-image').files[0];
    let thumb = null, local_ref = null;
    if (file){
      const img = await readFileAsImage(file);
      thumb = compressImage(img, 240, 0.7);
      local_ref = await Library.saveImage(file);
    }
    if (!text && !thumb) return toast('اكتب شيئاً أو اختر صورة','error');
    const r = await Api.post('/posts',{text, thumb, local_ref});
    if (r.error) return toast('خطأ: '+r.error,'error');
    document.getElementById('post-text').value=''; document.getElementById('post-image').value='';
    toast('نُشر ✅','success'); Feed.loadPosts();
  }
};

function readFileAsImage(file){
  return new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>{ const i=new Image(); i.onload=()=>res(i); i.onerror=rej; i.src=r.result; }; r.onerror=rej; r.readAsDataURL(file); });
}
function blobToBase64(blob){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>resolve(reader.result.split(',')[1]);
    reader.onerror=reject;
    reader.readAsDataURL(blob);
  });
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
    const emojiBtn=document.getElementById('btn-chatroom-emoji');
    if(emojiBtn) emojiBtn.onclick=()=>EmojiPicker.toggle('chatroom-input',emojiBtn);
    const callBtn=document.getElementById('btn-chatroom-call');
    if(callBtn) callBtn.onclick=()=>VideoCall.open('chat-'+[S.username,other].sort().join('-'),`محادثة مع @${other}`);
  },
  async refresh(){
    if (!S.currentChat) return;
    const r = await Api.get('/chat/'+S.currentChat);
    const box = document.getElementById('chatroom-messages');
    const wasBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    const otherUser = DB?.users?.[S.currentChat];
    box.innerHTML = (r.chat?.messages||[]).map(m=>{
      const mine = m.from===S.username;
      const cls = mine?'msg msg-mine':'msg msg-other';
      let body = escapeHTML(m.text||'');
      if(m.type==='voice') body = `<span style="display:flex;align-items:center;gap:6px">🎙️ <span>رسالة صوتية (${((m.duration_ms||0)/1000).toFixed(1)}ث)</span></span>`;
      return `<div class="${cls}">${body}<div class="msg-time">${fmtRel(m.timestamp)}</div></div>`;
    }).join('') || '<div style="text-align:center;color:var(--text-3);padding:30px 0;font-size:.85rem">لا رسائل بعد. ابدأ المحادثة!</div>';
    if(wasBottom || box.scrollTop===0) box.scrollTop = box.scrollHeight;
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
    const emojiBtn=document.getElementById('btn-grouproom-emoji');
    if(emojiBtn) emojiBtn.onclick=()=>EmojiPicker.toggle('grouproom-input',emojiBtn);
    const callBtn=document.getElementById('btn-grouproom-call');
    if(callBtn) callBtn.onclick=()=>VideoCall.open('group-'+id, r.group?.name||'مجموعة');
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
      const dbName = 'qqc_library_' + (S.username || 'guest');
      const req = indexedDB.open(dbName, 1);
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
    // Wire action buttons
    document.getElementById('btn-lib-record').onclick = Library.startRecording;
    document.getElementById('btn-lib-image').onclick = ()=>document.getElementById('lib-image-input').click();
    document.getElementById('lib-image-input').onchange = async e=>{
      const f = e.target.files[0]; if (!f) return;
      await Library.saveImage(f); toast('حُفظت الصورة','success'); Library.renderImages();
    };

    // Tab switching
    document.querySelectorAll('.lib-tab').forEach(t=>t.onclick=()=>{
      document.querySelectorAll('.lib-tab').forEach(x=>{ x.classList.remove('active','btn-secondary'); x.classList.add('btn-ghost'); });
      t.classList.add('active','btn-secondary'); t.classList.remove('btn-ghost');
      document.getElementById('lib-tab-recordings').style.display = t.dataset.lt==='recordings'?'block':'none';
      document.getElementById('lib-tab-studio').style.display     = t.dataset.lt==='studio'?'block':'none';
      document.getElementById('lib-tab-images').style.display     = t.dataset.lt==='images'?'block':'none';
    });

    // Search
    document.getElementById('lib-search').oninput = Library.renderRecordings;

    await Library.renderRecordings();
    await Library.renderStudioHistory();
    await Library.renderImages();
  },

  async renderRecordings(){
    const el = document.getElementById('lib-recordings');
    if (!el) return;
    const query = (document.getElementById('lib-search')?.value||'').toLowerCase().trim();
    const audios = await Library.listAudio();
    const filtered = query ? audios.filter(a=>(a.label||'').toLowerCase().includes(query)) : audios;
    const sorted = filtered.slice().reverse();
    if (!sorted.length){
      el.innerHTML=`<div style="text-align:center;padding:30px;color:var(--text-3)">${query?'لا نتائج للبحث':'لا تسجيلات بعد — ابدأ التسجيل!'}</div>`;
      return;
    }
    el.innerHTML = sorted.map(a=>{
      const url = URL.createObjectURL(a.blob);
      return `<div class="glass-card lib-rec-card" style="padding:10px 14px;margin-bottom:7px">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px">
          <div>
            <div style="font-size:.88rem;font-weight:600">${escapeHTML(a.label||'تسجيل')}</div>
            <div style="font-size:.72rem;color:var(--text-3)">${new Date(a.created).toLocaleString('ar')}</div>
          </div>
          <div style="display:flex;gap:5px">
            <button class="btn btn-sm btn-ghost lib-practice-btn" data-label="${escapeHTML(a.label||'')}">🎤 تدرّب</button>
            <button class="btn btn-sm btn-danger" data-da="${a.id}">✕</button>
          </div>
        </div>
        <audio controls src="${url}" style="width:100%;height:32px;border-radius:6px"></audio>
      </div>`;
    }).join('');
    el.querySelectorAll('[data-da]').forEach(b=>b.onclick=async()=>{ await Library.deleteAudio(+b.dataset.da); Library.renderRecordings(); });
    el.querySelectorAll('.lib-practice-btn').forEach(b=>b.onclick=()=>{ App.showView('view-studio'); toast('افتح الاستوديو واختر الآية للتدريب','info',2500); });
  },

  async renderStudioHistory(){
    const el = document.getElementById('lib-studio-history');
    if (!el) return;
    let history = [];
    try { const r = await Api.get('/studio/progress'); history = r.history||[]; } catch(e){}
    if (!history.length){
      el.innerHTML='<div style="text-align:center;padding:30px;color:var(--text-3)">لا سجل تجويد بعد — تدرّب على آية!</div>';
      return;
    }
    el.innerHTML = history.slice().reverse().slice(0,50).map(h=>{
      const score = h.score!=null ? h.score : h.ai_score;
      const col = score!=null ? (score>=80?'#34d399':score>=55?'#fbbf24':'#ef4444') : 'var(--text-3)';
      return `<div class="glass-card" style="padding:10px 14px;margin-bottom:7px;display:flex;gap:10px;align-items:center">
        <div style="flex:1;min-width:0">
          <div style="font-size:.85rem;font-weight:600">${escapeHTML(h.surah_name||'—')} · آية ${h.ayah_num||'—'}</div>
          <div style="font-size:.72rem;color:var(--text-3)">${new Date(h.timestamp).toLocaleString('ar')}</div>
          ${h.ai_feedback?`<div style="font-size:.72rem;color:var(--text-2);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHTML(h.ai_feedback.slice(0,60))}…</div>`:''}
        </div>
        ${score!=null?`<div style="font-size:1.4rem;font-weight:900;color:${col};min-width:44px;text-align:center">${score}%</div>`:''}
      </div>`;
    }).join('');
  },

  async renderImages(){
    const el = document.getElementById('lib-images');
    if (!el) return;
    const imgs = await Library.listImages();
    el.innerHTML = imgs.length ? imgs.map(i=>{
      const url = URL.createObjectURL(i.blob);
      return `<div style="position:relative"><img src="${url}" style="width:100%;height:100px;object-fit:cover;border-radius:8px"><button class="btn btn-sm btn-danger" data-di="${i.id}" style="position:absolute;top:4px;left:4px;padding:2px 6px;font-size:.7rem">×</button></div>`;
    }).join('') : '<p style="color:var(--text-3);text-align:center;padding:20px">لا صور</p>';
    el.querySelectorAll('[data-di]').forEach(b=>b.onclick=async()=>{ await Library.deleteImage(+b.dataset.di); Library.renderImages(); });
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
    // Sheikh status section
    const status = await Api.get('/sheikh-request/status');
    const ctaEl    = document.getElementById('become-sheikh-cta');
    const pendEl   = document.getElementById('sheikh-pending-notice');
    const verEl    = document.getElementById('sheikh-verified-badge');
    if(status.verified){
      if(ctaEl)  ctaEl.style.display='none';
      if(pendEl) pendEl.style.display='none';
      if(verEl)  verEl.style.display='block';
    } else if(status.requested){
      if(ctaEl)  ctaEl.style.display='none';
      if(pendEl) pendEl.style.display='block';
      if(verEl)  verEl.style.display='none';
    } else {
      if(ctaEl)  ctaEl.style.display='block';
      if(pendEl) pendEl.style.display='none';
      if(verEl)  verEl.style.display='none';
    }

    // Become sheikh button
    const becomeBtn = document.getElementById('btn-become-sheikh');
    const reqForm   = document.getElementById('sheikh-request-form');
    if(becomeBtn) becomeBtn.onclick = ()=>{ if(reqForm){ reqForm.style.display='block'; if(ctaEl) ctaEl.style.display='none'; }};
    const cancelBtn = document.getElementById('btn-cancel-sheikh-req');
    if(cancelBtn) cancelBtn.onclick = ()=>{ if(reqForm) reqForm.style.display='none'; if(ctaEl&&!status.requested&&!status.verified) ctaEl.style.display='block'; };

    const submitBtn = document.getElementById('btn-submit-sheikh-req');
    if(submitBtn) submitBtn.onclick = async ()=>{
      const phone    = (document.getElementById('sr-phone')?.value||'').trim();
      const bio      = (document.getElementById('sr-bio')?.value||'').trim();
      const time_pref= (document.getElementById('sr-time')?.value||'').trim();
      if(!phone && !bio) return toast('يرجى ملء الرقم أو نبذتك على الأقل','error');
      const r2 = await Api.post('/sheikh-request',{phone,bio,time_pref});
      if(r2.ok){
        toast('📨 أُرسل طلبك! سنتواصل معك قريباً','success',5000);
        if(reqForm)  reqForm.style.display='none';
        if(pendEl) pendEl.style.display='block';
      } else toast(r2.error==='already_sheikh'?'أنت شيخ معتمد فعلاً':r2.error,'error');
    };

    // Support messages
    const r = await Api.get('/support');
    const box = document.getElementById('support-messages');
    if(box){
      box.innerHTML = (r.ticket?.messages||[]).map(m=>{
        const mine = m.from===S.username;
        return `<div class="msg ${mine?'msg-mine':'msg-other'}"><strong style="font-size:.7rem">${m.from==='admin'?'الدعم':'أنت'}</strong><br>${escapeHTML(m.text)}<div class="msg-time">${fmtTime(m.timestamp)}</div></div>`;
      }).join('') || '<p style="color:var(--text-2)">لا رسائل بعد. اكتب مشكلتك وسيرد عليك فريق الدعم.</p>';
      box.scrollTop = box.scrollHeight;
    }
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
      const channels = r.channels||[];
      const el = document.getElementById('atab-channels');
      el.innerHTML = `<div class="glass-card pad" style="margin-bottom:10px">
        <h3 style="margin:0 0 10px">الشُّعب الكاملة (${channels.length})</h3>
        ${channels.length===0?'<p style="color:var(--text-2)">لا شُعب مسجّلة</p>':channels.map(c=>`
        <div class="glass-card" style="margin-bottom:8px;padding:12px">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:6px">
            <div style="flex:1;min-width:0">
              <div style="font-weight:700;font-size:.95rem">${escapeHTML(c.name)}${c.is_public?'':' 🔒'}</div>
              <div style="font-size:.75rem;color:var(--text-3);margin-top:2px">شيخ: @${escapeHTML(c.sheikh_username)} · ${c.member_count}/${c.max_members} عضو · ${c.message_count} رسالة · ${c.announcement_count} إعلان</div>
              <div style="font-size:.75rem;color:var(--gold);margin-top:2px">🔑 <strong>${escapeHTML(c.join_code)}</strong>${c.last_message_at?' · آخر نشاط: '+fmtRel(c.last_message_at):''}</div>
            </div>
            <div style="display:flex;gap:5px;flex-shrink:0">
              <button class="btn btn-sm btn-secondary" data-ch-detail="${escapeHTML(c.id)}">📂 تفاصيل</button>
              <button class="btn btn-sm btn-danger" data-ch-del="${escapeHTML(c.id)}" data-ch-name="${escapeHTML(c.name)}">🗑️</button>
            </div>
          </div>
          <div id="ch-detail-${escapeHTML(c.id)}" style="display:none;margin-top:10px"></div>
        </div>`).join('')}
      </div>`;
      // Detail toggle
      el.querySelectorAll('[data-ch-detail]').forEach(btn=>btn.onclick=async()=>{
        const id=btn.dataset.chDetail;
        const detailEl=document.getElementById('ch-detail-'+id);
        if(!detailEl) return;
        if(detailEl.style.display!=='none'){ detailEl.style.display='none'; return; }
        detailEl.innerHTML='<div style="color:var(--text-3);font-size:.8rem">جارٍ التحميل…</div>';
        detailEl.style.display='block';
        const dr=await Api.get('/admin/channels/'+id,true);
        const ch=dr.channel;
        if(!ch){ detailEl.innerHTML='<p style="color:red">خطأ في التحميل</p>'; return; }
        const members=ch.members||[];
        const messages=ch.messages||[];
        const announcements=ch.announcements||[];
        detailEl.innerHTML=`
          <!-- Members -->
          <div style="margin-bottom:10px">
            <div style="font-size:.8rem;font-weight:700;color:var(--mint);margin-bottom:6px">👥 الأعضاء (${members.length})</div>
            <div style="display:flex;flex-direction:column;gap:4px;max-height:200px;overflow-y:auto">
              ${members.map(m=>`<div style="display:flex;align-items:center;gap:8px;padding:5px 8px;background:rgba(255,255,255,.04);border-radius:7px">
                <div class="avatar-dot" style="background:${m.avatar_color||'#3b82f6'};width:28px;height:28px;font-size:.8rem;flex-shrink:0">${(m.display_name||m.username||'?')[0]}</div>
                <div style="flex:1;min-width:0">
                  <span style="font-size:.85rem;font-weight:${m.is_sheikh?'700':'400'}">${escapeHTML(m.display_name||m.username)}${m.is_sheikh?' 🏅':''}</span>
                  <span style="font-size:.7rem;color:var(--text-3);margin-right:6px">@${escapeHTML(m.username)}</span>
                </div>
                <div style="font-size:.72rem;color:var(--text-3);text-align:left">${(m.pages||0).toFixed(1)}ص · 🔥${m.streak||0} · ${m.sessions||0}جلسة</div>
              </div>`).join('')}
            </div>
          </div>
          <!-- Announcements -->
          ${announcements.length?`<div style="margin-bottom:10px">
            <div style="font-size:.8rem;font-weight:700;color:var(--gold);margin-bottom:6px">📢 الإعلانات (${announcements.length})</div>
            <div style="max-height:150px;overflow-y:auto">
              ${announcements.slice().reverse().map(a=>`<div style="padding:6px 8px;background:rgba(250,204,21,.06);border-radius:6px;margin-bottom:4px;font-size:.82rem">${escapeHTML(a.text)}<span style="color:var(--text-3);font-size:.7rem;margin-right:6px">${fmtRel(a.timestamp)}</span></div>`).join('')}
            </div>
          </div>`:''}
          <!-- Messages -->
          <div>
            <div style="font-size:.8rem;font-weight:700;color:#a78bfa;margin-bottom:6px">💬 الرسائل (${messages.length}${messages.length===200?' — آخر 200':''}) </div>
            ${messages.length===0?'<p style="font-size:.8rem;color:var(--text-3)">لا رسائل بعد</p>':
            `<div style="max-height:320px;overflow-y:auto;display:flex;flex-direction:column;gap:3px">
              ${messages.slice().reverse().map(m=>`<div style="padding:5px 8px;border-radius:7px;background:rgba(255,255,255,.04)">
                <span style="font-size:.72rem;color:#a78bfa;font-weight:600">@${escapeHTML(m.from)}</span>
                <span style="font-size:.72rem;color:var(--text-3);margin-right:4px">${fmtRel(m.timestamp)}</span>
                <div style="font-size:.85rem;margin-top:1px">${escapeHTML(m.text)}</div>
              </div>`).join('')}
            </div>`}
          </div>
          ${ch.plan_template?`<div style="margin-top:10px;padding:8px 10px;background:rgba(52,211,153,.07);border-radius:8px;border:1px solid rgba(52,211,153,.2)">
            <div style="font-size:.75rem;color:var(--mint);margin-bottom:3px">📋 خطة الشُّعبة</div>
            <div style="font-size:.85rem"><strong>${escapeHTML(ch.plan_template.name)}</strong> — ${ch.plan_template.daily_pages} ص/يوم</div>
            ${ch.plan_template.description?`<div style="font-size:.78rem;color:var(--text-2)">${escapeHTML(ch.plan_template.description)}</div>`:''}
          </div>`:''}
        `;
      });
      // Delete channel
      el.querySelectorAll('[data-ch-del]').forEach(btn=>btn.onclick=async()=>{
        const id=btn.dataset.chDel, name=btn.dataset.chName;
        if(!confirm(`حذف شُعبة "${name}" نهائياً؟ لا يمكن التراجع.`)) return;
        const dr=await Api.del('/admin/channels/'+id,true);
        if(dr.ok){ toast('🗑️ حُذفت الشُّعبة','info'); Admin.loadTab('channels'); }
        else toast('خطأ في الحذف','error');
      });
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
    if (name==='sheikh-reqs'){
      const r = await Api.get('/admin/sheikh-requests', true);
      const reqs = r.requests||[];
      const statusLabel={pending:'⏳ قيد المراجعة',approved:'✅ مُوافَق',rejected:'❌ مرفوض'};
      document.getElementById('atab-sheikh-reqs').innerHTML = reqs.length ? `<div>
        ${reqs.map(req=>`<div class="glass-card pad" style="margin-bottom:10px">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
            <div>
              <strong>@${escapeHTML(req.username)}</strong> — ${escapeHTML(req.display_name||'')}
              <span class="plan-mode-badge" style="margin-right:6px;font-size:.7rem">${statusLabel[req.status]||req.status}</span>
            </div>
            <div style="font-size:.75rem;color:var(--text-3)">${fmtTime(req.submitted_at)}</div>
          </div>
          ${req.phone?`<div style="font-size:.82rem;margin-bottom:4px">📞 ${escapeHTML(req.phone)}</div>`:''}
          ${req.bio?`<div style="font-size:.82rem;color:var(--text-2);margin-bottom:4px">${escapeHTML(req.bio)}</div>`:''}
          ${req.time_pref?`<div style="font-size:.78rem;color:var(--text-3);margin-bottom:6px">⏰ ${escapeHTML(req.time_pref)}</div>`:''}
          <div style="font-size:.75rem;color:var(--text-3);margin-bottom:8px">الصفحات: ${req.pages} · الجلسات: ${req.sessions}</div>
          ${req.status==='pending'?`<div style="display:flex;gap:6px">
            <button class="btn btn-primary" data-approve-req="${req.username}">✅ موافقة — تعيين شيخاً</button>
            <input class="field-input" id="reject-reason-${req.username}" placeholder="سبب الرفض (اختياري)" style="flex:1">
            <button class="btn btn-danger" data-reject-req="${req.username}">❌ رفض</button>
          </div>`:''}
        </div>`).join('')}
      </div>` : '<p style="color:var(--text-2);padding:20px 0;text-align:center">لا طلبات شيخ حالياً</p>';
      document.querySelectorAll('[data-approve-req]').forEach(b=>b.onclick=async()=>{
        if(!confirm(`تعيين @${b.dataset.approveReq} شيخاً معتمداً؟`)) return;
        const r2=await Api.post('/admin/sheikh-requests/'+b.dataset.approveReq+'/approve',{},true);
        if(r2.ok){ toast('✅ تم التعيين','success'); Admin.loadTab('sheikh-reqs'); } else toast('خطأ','error');
      });
      document.querySelectorAll('[data-reject-req]').forEach(b=>b.onclick=async()=>{
        const reason=(document.getElementById('reject-reason-'+b.dataset.rejectReq)?.value||'').trim();
        const r2=await Api.post('/admin/sheikh-requests/'+b.dataset.rejectReq+'/reject',{reason},true);
        if(r2.ok){ toast('تم الرفض','info'); Admin.loadTab('sheikh-reqs'); }
      });
    }
    if (name==='plans'){
      const r = await Api.get('/admin/overview', true); // to get plans we use the plans api
      const plansR = await Api.get('/plans');
      const plans = plansR.plans||[];
      const modeMap={both:'حفظ ومراجعة',memorization_only:'حفظ فقط',review_only:'مراجعة فقط'};
      document.getElementById('atab-plans').innerHTML = `<div>
        <!-- Add plan form -->
        <div class="glass-card pad" style="margin-bottom:12px">
          <h3 style="margin:0 0 10px">إضافة خطة حفظ جديدة</h3>
          <input id="ap-name" class="field-input" placeholder="اسم الخطة (مثال: خطة ربع الصفحة اليومي)" style="margin-bottom:6px">
          <div style="display:flex;gap:6px;margin-bottom:6px">
            <input id="ap-pages" class="field-input" type="number" step="0.25" min="0.25" max="10" value="0.5" placeholder="صفحات/يوم" style="flex:1">
            <select id="ap-mode" class="field-input" style="flex:1">
              <option value="both">حفظ ومراجعة</option>
              <option value="memorization_only">حفظ فقط</option>
              <option value="review_only">مراجعة فقط</option>
            </select>
          </div>
          <textarea id="ap-desc" class="field-input" rows="2" placeholder="وصف الخطة (اختياري)..." style="margin-bottom:6px"></textarea>
          <button class="btn btn-primary" id="btn-add-plan">+ إضافة</button>
        </div>
        <!-- Plans list -->
        <h3 style="margin:0 0 8px">الخطط الحالية (${plans.length})</h3>
        ${plans.length ? plans.map(pl=>`<div class="card-row glass-card" style="margin-bottom:6px">
          <div>
            <strong>${escapeHTML(pl.name)}</strong>
            <div style="font-size:.75rem;color:var(--text-2)">${pl.daily_pages} ص/يوم · ${modeMap[pl.mode]||pl.mode}${pl.description?' · '+escapeHTML(pl.description.slice(0,50)):''}</div>
          </div>
          <button class="btn btn-sm btn-danger" data-del-plan="${pl.id}">حذف</button>
        </div>`).join('') : '<p style="color:var(--text-2)">لا خطط بعد</p>'}
      </div>`;
      document.getElementById('btn-add-plan').onclick = async ()=>{
        const name=(document.getElementById('ap-name')?.value||'').trim();
        const pages=+document.getElementById('ap-pages')?.value||0.5;
        const mode=document.getElementById('ap-mode')?.value||'both';
        const desc=(document.getElementById('ap-desc')?.value||'').trim();
        if(!name) return toast('أدخل اسم الخطة','error');
        const r2=await Api.post('/admin/plans',{name,daily_pages:pages,mode,description:desc},true);
        if(r2.ok){ toast('✅ أُضيفت الخطة','success'); Admin.loadTab('plans'); } else toast('خطأ','error');
      };
      document.querySelectorAll('[data-del-plan]').forEach(b=>b.onclick=async()=>{
        if(!confirm('حذف هذه الخطة؟')) return;
        await Api.del('/admin/plans/'+b.dataset.delPlan,true); Admin.loadTab('plans');
      });
    }
    if (name==='hermes'){
      const el = document.getElementById('atab-hermes');
      el.innerHTML = `<div style="text-align:center;color:var(--text-3);padding:20px 0;font-size:.85rem">جارٍ تحميل بيانات Hermes…</div>`;
      let r;
      try { r = await Api.get('/admin/hermes/status', true); } catch(e){ el.innerHTML='<p style="color:red">خطأ في الاتصال</p>'; return; }
      const stats = r.stats||{};
      const cfg = r.cfg||{};
      const runs = r.recent_runs||[];
      const insights = r.recent_insights||[];
      const skills = r.skills||[];
      const codeEdits = r.code_edits||[];
      const colorBadge=(v,good,bad)=>v>=good?'var(--mint)':v<=bad?'var(--red)':'var(--gold)';
      el.innerHTML = `
      <!-- Header -->
      <div style="background:linear-gradient(135deg,rgba(99,102,241,.15),rgba(167,139,250,.08));border:1px solid rgba(167,139,250,.25);border-radius:12px;padding:14px;margin-bottom:12px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
          <div style="font-size:1.6rem">🤖</div>
          <div>
            <div style="font-size:1rem;font-weight:700;color:#a78bfa">Hermes Agent v2</div>
            <div style="font-size:.75rem;color:var(--text-3)">آخر دورة: ${r.last_run ? fmtTime(r.last_run) : 'لم يعمل بعد'}</div>
          </div>
          <div style="margin-right:auto;display:flex;gap:6px">
            <button class="btn btn-sm" id="btn-hermes-run" style="background:linear-gradient(135deg,#6366f1,#a78bfa);color:#fff;border:none">▶ تشغيل الآن</button>
            <button class="btn btn-sm btn-ghost" id="btn-hermes-refresh">↻ تحديث</button>
            <button class="btn btn-sm btn-danger" id="btn-hermes-reset" title="مسح ذاكرة Hermes">🗑️ مسح</button>
          </div>
        </div>
        <!-- Stats grid -->
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">
          ${[['دورات','total_runs','💫'],['استدعاءات','total_tool_calls','🔧'],['مستخدمون ساعدهم','users_helped','❤️'],['خطط عُدّلت','plans_adjusted','📋'],['أوزان حُدّثت','weights_updated','⚖️'],['مهارات مكتسبة','skills_count','🧠']].map(([label,key,ico])=>{
            const v = key==='skills_count'?skills.length:stats[key]||0;
            return `<div style="background:rgba(0,0,0,.2);border-radius:8px;padding:8px;text-align:center">
              <div style="font-size:1.1rem;font-weight:700;color:#a78bfa">${ico} ${v}</div>
              <div style="font-size:.65rem;color:var(--text-3)">${label}</div>
            </div>`;
          }).join('')}
        </div>
        ${r.next_run_focus?`<div style="margin-top:10px;padding:7px 10px;background:rgba(250,204,21,.06);border-radius:7px;border:1px solid rgba(250,204,21,.15);font-size:.78rem;color:var(--gold)">🎯 تركيز الدورة القادمة: ${escapeHTML(r.next_run_focus)}</div>`:''}
        ${cfg.focus_mode?`<div style="margin-top:6px;font-size:.72rem;color:var(--text-3)">وضع: ${cfg.focus_mode} · الحد الأقصى: ${cfg.max_tool_calls||20} استدعاء</div>`:''}
      </div>

      <!-- Tabs inside Hermes -->
      <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:10px">
        ${[['runs','الدورات 📊'],['skills','المهارات 🧠'],['insights','الرؤى 💡'],['commits','GitHub 🔗'],['chat','💬 محادثة'],['lab','🧪 المختبر']].map(([t,l])=>
          `<button class="btn btn-sm ${t==='runs'?'btn-primary':'btn-ghost'}" data-htab="${t}">${l}</button>`).join('')}
      </div>

      <!-- Runs -->
      <div id="h-runs">
        ${runs.length===0?'<p style="color:var(--text-2);text-align:center;padding:20px">لم تُنفَّذ أي دورات بعد</p>':
        runs.map(run=>`
          <div class="glass-card" style="margin-bottom:8px;padding:12px;border-right:3px solid rgba(167,139,250,.5)">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
              <div style="flex:1;min-width:0">
                <div style="font-size:.78rem;color:#a78bfa;font-weight:600">دورة #${run.id?.slice(0,8)||'—'} · ${fmtTime(run.at)}</div>
                <div style="font-size:.82rem;margin-top:4px;line-height:1.5">${escapeHTML(run.summary||'—')}</div>
                ${(run.actions||[]).length?`<div style="margin-top:6px">${run.actions.map(a=>`<div style="font-size:.7rem;color:var(--text-3);padding:2px 0;border-bottom:1px solid rgba(255,255,255,.04)">• ${escapeHTML(a)}</div>`).join('')}</div>`:''}
              </div>
              <div style="text-align:left;flex-shrink:0">
                <div style="font-size:.7rem;color:var(--text-3)">${run.tool_calls||0} أداة</div>
                <div style="font-size:.7rem;color:var(--text-3)">${run.duration_ms?((run.duration_ms/1000).toFixed(1)+'ث'):'—'}</div>
              </div>
            </div>
            ${run.next_run_focus?`<div style="margin-top:6px;font-size:.72rem;color:var(--gold)">→ التالية: ${escapeHTML(run.next_run_focus)}</div>`:''}
          </div>`).join('')}
      </div>

      <!-- Skills -->
      <div id="h-skills" style="display:none">
        ${skills.length===0?'<p style="color:var(--text-2);text-align:center;padding:20px">لا مهارات مكتسبة بعد — شغّل Hermes ليبدأ التعلم</p>':
        skills.map(sk=>`
          <div class="glass-card" style="margin-bottom:8px;padding:10px;border-right:3px solid rgba(52,211,153,.4)">
            <div style="font-size:.82rem;font-weight:700;color:var(--mint)">${escapeHTML(sk.title)}</div>
            <div style="font-size:.75rem;color:var(--text-2);margin-top:4px;line-height:1.5">${escapeHTML(sk.content)}</div>
            <div style="margin-top:5px;display:flex;gap:4px;flex-wrap:wrap">
              <span style="font-size:.65rem;padding:2px 6px;background:rgba(167,139,250,.12);border-radius:4px;color:#a78bfa">${sk.applies_to||'general'}</span>
              ${(sk.tags||[]).map(t=>`<span style="font-size:.65rem;padding:2px 6px;background:rgba(255,255,255,.06);border-radius:4px;color:var(--text-3)">${escapeHTML(t)}</span>`).join('')}
              ${sk.updated_count>1?`<span style="font-size:.65rem;padding:2px 6px;background:rgba(250,204,21,.08);border-radius:4px;color:var(--gold)">×${sk.updated_count}</span>`:''}
            </div>
          </div>`).join('')}
      </div>

      <!-- Insights -->
      <div id="h-insights" style="display:none">
        ${insights.length===0?'<p style="color:var(--text-2);text-align:center;padding:20px">لا رؤى مسجّلة بعد</p>':
        insights.map(ins=>{
          const impColor=ins.impact==='high'?'var(--red)':ins.impact==='medium'?'var(--gold)':'var(--text-3)';
          return `<div class="glass-card" style="margin-bottom:6px;padding:9px;border-right:3px solid ${impColor}40">
            <div style="display:flex;gap:6px;align-items:flex-start">
              <span style="font-size:.65rem;padding:2px 5px;background:${impColor}20;color:${impColor};border-radius:4px;flex-shrink:0;margin-top:2px">${ins.category}</span>
              <div style="flex:1;font-size:.8rem;line-height:1.5">${escapeHTML(ins.text)}</div>
              <div style="font-size:.65rem;color:var(--text-3);flex-shrink:0">${fmtTime(ins.at)}</div>
            </div>
          </div>`;
        }).join('')}
      </div>

      <!-- Chat with Hermes -->
      <div id="h-chat" style="display:none">
        <div style="display:flex;flex-direction:column;gap:8px">
          <div id="h-chat-messages" style="min-height:180px;max-height:420px;overflow-y:auto;background:rgba(0,0,0,.2);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:8px">
            <div style="text-align:center;color:var(--text-3);font-size:.8rem;padding:20px 0">
              ابدأ محادثة مع Hermes — يمكنه البحث بالإنترنت، توليد أصوات، تحليل البيانات، وتعديل الكود
            </div>
          </div>
          <div id="h-chat-status" style="font-size:.72rem;color:#a78bfa;min-height:16px;padding:0 4px"></div>
          <div style="display:flex;gap:6px">
            <input id="h-chat-input" type="text" placeholder="اكتب رسالتك لهرمس… (مثال: ابحث عن مكتبات تحليل الصوت، أو: ولّد صوت تلاوة للفاتحة)" style="flex:1;padding:9px 12px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#fff;font-size:.85rem;font-family:inherit" dir="auto" />
            <button id="h-chat-send" class="btn btn-sm" style="background:linear-gradient(135deg,#6366f1,#a78bfa);color:#fff;border:none;padding:8px 16px;white-space:nowrap">إرسال ↵</button>
          </div>
          <div style="display:flex;gap:4px;flex-wrap:wrap">
            ${['ابحث عن أفضل مكتبات تحليل الصوت العربي','ولّد ملف صوتي لـ بسم الله الرحمن الرحيم','حلّل بيانات التلاوة وأنشئ تقريراً','ما هي أخطاء المستخدمين الأكثر تكراراً؟'].map(q=>`<button class="btn btn-sm btn-ghost h-chat-quick" style="font-size:.68rem" data-q="${q}">${q}</button>`).join('')}
          </div>
        </div>
      </div>

      <!-- Lab Files -->
      <div id="h-lab" style="display:none">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <div style="font-size:.8rem;color:var(--text-3)">ملفات صنعها هرمس (صوت، نص، JSON)</div>
          <button id="h-lab-refresh" class="btn btn-sm btn-ghost" style="font-size:.72rem">↻ تحديث</button>
        </div>
        <div id="h-lab-list"><div style="text-align:center;color:var(--text-3);padding:30px;font-size:.8rem">جارٍ التحميل…</div></div>
      </div>

      <!-- GitHub Commits -->
      <div id="h-commits" style="display:none">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
          <div style="font-size:.8rem;color:var(--text-3)">كل تعديل كود يُرفع Hermes تلقائياً إلى GitHub</div>
          <a href="https://github.com/abuahmad-21/Quranic-Plan-Manager/commits/main" target="_blank"
             style="font-size:.72rem;color:#6366f1;text-decoration:none;padding:4px 10px;border:1px solid rgba(99,102,241,.3);border-radius:6px">↗ فتح GitHub</a>
        </div>
        ${codeEdits.length===0
          ? `<div style="text-align:center;padding:30px 20px;background:rgba(0,0,0,.15);border-radius:10px;border:1px dashed rgba(255,255,255,.08)">
               <div style="font-size:2rem;margin-bottom:8px">🔗</div>
               <div style="color:var(--text-2);font-size:.85rem">لم يُرفع أي commit بعد</div>
               <div style="color:var(--text-3);font-size:.75rem;margin-top:4px">Hermes سيرفع تلقائياً بعد تعديل الكود</div>
             </div>`
          : codeEdits.map(ed=>{
              const isGit = !!ed.commit;
              const borderColor = isGit ? 'rgba(34,197,94,.5)' : 'rgba(99,102,241,.4)';
              const icon = isGit ? '✅' : '📝';
              const ghUrl = isGit ? `https://github.com/abuahmad-21/Quranic-Plan-Manager/commit/${ed.commit}` : null;
              return `<div class="glass-card" style="margin-bottom:8px;padding:11px;border-right:3px solid ${borderColor}">
                <div style="display:flex;align-items:flex-start;gap:8px">
                  <span style="font-size:1rem;flex-shrink:0;margin-top:1px">${icon}</span>
                  <div style="flex:1;min-width:0">
                    <div style="font-size:.8rem;font-weight:600;color:${isGit?'#4ade80':'#a78bfa'};margin-bottom:3px">
                      ${isGit ? `<a href="${ghUrl}" target="_blank" style="color:inherit;text-decoration:none">${escapeHTML(ed.message||ed.commit)}</a>` : escapeHTML(ed.reason||ed.file||'—')}
                    </div>
                    <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center">
                      ${ed.commit ? `<code style="font-size:.68rem;background:rgba(34,197,94,.1);color:#4ade80;padding:1px 6px;border-radius:4px;border:1px solid rgba(34,197,94,.2)">${ed.commit}</code>` : ''}
                      ${ed.file ? `<span style="font-size:.68rem;color:var(--text-3);background:rgba(255,255,255,.05);padding:1px 6px;border-radius:4px">${escapeHTML(ed.file)}</span>` : ''}
                      ${ed.chars_changed ? `<span style="font-size:.68rem;color:var(--text-3)">±${ed.chars_changed} حرف</span>` : ''}
                    </div>
                  </div>
                  <div style="font-size:.65rem;color:var(--text-3);flex-shrink:0;text-align:left">${fmtTime(ed.at)}</div>
                </div>
              </div>`;
            }).join('')}
      </div>`;

      /* Tab switching inside Hermes */
      const hTabs=['runs','skills','insights','commits','chat','lab'];
      el.querySelectorAll('[data-htab]').forEach(btn=>{
        btn.onclick=()=>{
          el.querySelectorAll('[data-htab]').forEach(b=>{ b.className='btn btn-sm btn-ghost'; });
          btn.className='btn btn-sm btn-primary';
          hTabs.forEach(t=>{ const d=document.getElementById('h-'+t); if(d) d.style.display='none'; });
          const target=document.getElementById('h-'+btn.dataset.htab);
          if(target) target.style.display='block';
          if(btn.dataset.htab==='lab') HermesLab.loadFiles();
        };
      });

      /* Run now */
      document.getElementById('btn-hermes-run')?.addEventListener('click', async()=>{
        const btn=document.getElementById('btn-hermes-run');
        btn.disabled=true; btn.textContent='⏳ جارٍ التشغيل…';
        const r2=await Api.post('/admin/hermes/run-now',{},true);
        if(r2.ok){ toast('🤖 Hermes Agent يعمل الآن في الخلفية!','success'); setTimeout(()=>Admin.loadTab('hermes'),3000); }
        else toast(r2.error||'خطأ','error');
        btn.disabled=false; btn.textContent='▶ تشغيل الآن';
      });

      /* Refresh */
      document.getElementById('btn-hermes-refresh')?.addEventListener('click', ()=>Admin.loadTab('hermes'));

      /* Reset memory */
      document.getElementById('btn-hermes-reset')?.addEventListener('click', async()=>{
        if(!confirm('هل أنت متأكد؟ سيتم حذف ذاكرة Hermes (المهارات، الرؤى، الدورات) بالكامل.')) return;
        const r3=await fetch(API+'/admin/hermes/memory',{method:'DELETE',headers:{'x-admin-password':S.adminPw}}).then(r=>r.json());
        if(r3.ok){ toast('تم مسح ذاكرة Hermes','success'); Admin.loadTab('hermes'); }
      });

      /* ── Hermes Chat handlers ── */
      const chatHistory=[];
      const chatMsgs=document.getElementById('h-chat-messages');
      const chatInput=document.getElementById('h-chat-input');
      const chatStatus=document.getElementById('h-chat-status');

      function hChatAppend(role,content,extra){
        if(!chatMsgs) return;
        const isUser=role==='user';
        const isTool=role==='tool';
        const div=document.createElement('div');
        div.style.cssText=`display:flex;flex-direction:column;gap:3px;align-items:${isUser?'flex-end':'flex-start'}`;
        const bubble=document.createElement('div');
        bubble.style.cssText=`max-width:85%;padding:8px 12px;border-radius:${isUser?'12px 12px 4px 12px':'12px 12px 12px 4px'};font-size:.82rem;line-height:1.55;word-break:break-word;background:${isUser?'linear-gradient(135deg,#6366f1,#a78bfa)':isTool?'rgba(250,204,21,.08)':'rgba(255,255,255,.07)'};border:1px solid ${isTool?'rgba(250,204,21,.15)':isUser?'transparent':'rgba(255,255,255,.08)'};color:${isTool?'var(--gold)':'#fff'}`;
        bubble.textContent=content;
        div.appendChild(bubble);
        if(extra?.type==='audio'){
          const audioWrap=document.createElement('div');
          audioWrap.style.cssText='display:flex;align-items:center;gap:6px;margin-top:4px;padding:6px 10px;background:rgba(52,211,153,.08);border-radius:8px;border:1px solid rgba(52,211,153,.2)';
          audioWrap.innerHTML=`<span style="font-size:.75rem;color:var(--mint)">🔊 ${escapeHTML(extra.filename)}</span>
            <audio controls style="height:28px;flex:1;min-width:0" src="${API}${extra.url}?pw=${encodeURIComponent(S.adminPw||'')}"></audio>
            <a href="${API}${extra.url}?pw=${encodeURIComponent(S.adminPw||'')}" download="${escapeHTML(extra.filename)}" style="font-size:.7rem;color:var(--text-3);text-decoration:none;padding:2px 6px;border:1px solid rgba(255,255,255,.1);border-radius:4px">↓</a>`;
          div.appendChild(audioWrap);
        }
        if(extra?.type==='text'){
          const txtWrap=document.createElement('div');
          txtWrap.style.cssText='margin-top:4px;padding:5px 8px;background:rgba(99,102,241,.08);border-radius:6px;border:1px solid rgba(99,102,241,.2);font-size:.72rem;color:#a78bfa';
          txtWrap.innerHTML=`📄 <a href="${API}${extra.url}" target="_blank" style="color:inherit">${escapeHTML(extra.filename)}</a> (${extra.size_kb||0} KB)`;
          div.appendChild(txtWrap);
        }
        chatMsgs.appendChild(div);
        chatMsgs.scrollTop=chatMsgs.scrollHeight;
        return bubble;
      }

      async function hChatSend(){
        const msg=(chatInput?.value||'').trim();
        if(!msg||!S.adminPw) return;
        chatInput.value='';
        // إزالة الرسالة الترحيبية
        if(chatMsgs?.children.length===1&&chatMsgs.children[0].style.textAlign==='center') chatMsgs.innerHTML='';
        hChatAppend('user',msg);
        chatHistory.push({role:'user',content:msg});
        const sendBtn=document.getElementById('h-chat-send');
        if(sendBtn){ sendBtn.disabled=true; sendBtn.textContent='⏳'; }
        if(chatStatus) chatStatus.textContent='هرمس يفكر…';
        let hermesDiv=null;
        let hermesText='';
        try {
          const resp=await fetch(API+'/admin/hermes/chat',{
            method:'POST',
            headers:{'Content-Type':'application/json','x-admin-password':S.adminPw},
            body:JSON.stringify({message:msg,history:chatHistory.slice(-10)})
          });
          if(!resp.ok){ hChatAppend('hermes','❌ خطأ في الاتصال'); return; }
          const reader=resp.body.getReader();
          const decoder=new TextDecoder();
          let buf='';
          while(true){
            const {done,value}=await reader.read();
            if(done) break;
            buf+=decoder.decode(value,{stream:true});
            const lines=buf.split('\n');
            buf=lines.pop()||'';
            for(const line of lines){
              if(!line.startsWith('data: ')) continue;
              let ev;
              try{ ev=JSON.parse(line.slice(6)); }catch{ continue; }
              if(ev.type==='message'&&ev.content){
                hermesText+=ev.content;
                if(!hermesDiv){ hermesDiv=hChatAppend('hermes',hermesText); }
                else hermesDiv.textContent=hermesText;
                chatMsgs.scrollTop=chatMsgs.scrollHeight;
              } else if(ev.type==='tool_call'){
                const toolNames={'web_search':'🔍 يبحث في الإنترنت','fetch_url':'🌐 يجلب رابط','generate_tts_file':'🔊 يولّد صوت','list_lab_files':'📁 يراجع المختبر','create_text_file':'📄 يكتب ملف','delete_lab_file':'🗑️ يحذف ملف','get_global_stats':'📊 يقرأ إحصائيات','scan_users':'👥 يمسح المستخدمين','analyze_recitation_patterns':'🎙️ يحلل التلاوة','modify_algorithm_weights':'⚖️ يعدل الخوارزمية','read_project_file':'📖 يقرأ كود','write_project_file':'✏️ يعدل كود','analyze_and_improve_algorithm':'🧠 يحلل ويُحسّن'};
                if(chatStatus) chatStatus.textContent=(toolNames[ev.name]||('🔧 '+ev.name))+'…';
              } else if(ev.type==='lab_file'){
                hChatAppend('hermes',ev.type==='audio'?`✅ تم إنشاء ملف الصوت: ${ev.filename}`:`✅ تم إنشاء ملف: ${ev.filename}`,{type:ev.type||'audio',...ev});
              } else if(ev.type==='tool_result'&&ev.name==='generate_tts_file'){
                try{
                  const r2=JSON.parse(ev.result);
                  if(r2.ok&&r2.filename) hChatAppend('hermes',`✅ صوت جاهز: ${r2.filename}`,{type:'audio',filename:r2.filename,url:r2.lab_url,size_kb:r2.size_kb});
                }catch{}
              } else if(ev.type==='tool_result'&&ev.name==='create_text_file'){
                try{
                  const r2=JSON.parse(ev.result);
                  if(r2.ok&&r2.filename) hChatAppend('hermes',`📄 ملف: ${r2.filename}`,{type:'text',filename:r2.filename,url:`/qqc/admin/hermes/lab/file/${encodeURIComponent(r2.filename)}`,size_kb:r2.size_kb});
                }catch{}
              } else if(ev.type==='error'){
                hChatAppend('tool','⚠️ '+(ev.message||'خطأ غير محدد'));
              } else if(ev.type==='done'){
                if(chatStatus) chatStatus.textContent='';
              }
            }
          }
          if(hermesText) chatHistory.push({role:'assistant',content:hermesText});
        } catch(e){
          hChatAppend('hermes','❌ خطأ: '+e.message);
        } finally {
          if(sendBtn){ sendBtn.disabled=false; sendBtn.textContent='إرسال ↵'; }
          if(chatStatus) chatStatus.textContent='';
        }
      }

      document.getElementById('h-chat-send')?.addEventListener('click', hChatSend);
      document.getElementById('h-chat-input')?.addEventListener('keydown', e=>{ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); hChatSend(); } });
      el.querySelectorAll('.h-chat-quick').forEach(btn=>{ btn.onclick=()=>{ if(chatInput) chatInput.value=btn.dataset.q; hChatSend(); }; });

    }
  }
};

/* ══ HERMES LAB ══ */
const HermesLab = {
  async loadFiles(){
    const listEl=document.getElementById('h-lab-list');
    if(!listEl||!S.adminPw) return;
    listEl.innerHTML='<div style="text-align:center;color:var(--text-3);padding:20px;font-size:.8rem">جارٍ التحميل…</div>';
    try{
      const r=await fetch(API+'/admin/hermes/lab/files',{headers:{'x-admin-password':S.adminPw}}).then(x=>x.json());
      const files=r.files||[];
      if(!files.length){ listEl.innerHTML='<div style="text-align:center;padding:30px;color:var(--text-3);font-size:.85rem">🧪 المختبر فارغ<br><span style="font-size:.75rem">تحدث مع هرمس واطلب منه توليد ملفات صوتية أو تقارير</span></div>'; return; }
      listEl.innerHTML=files.map(f=>{
        const isAudio=f.type==='audio';
        const fileUrl=`${API}/admin/hermes/lab/file/${encodeURIComponent(f.filename)}`;
        const authUrl=`${fileUrl}`;
        return `<div class="glass-card" style="margin-bottom:8px;padding:10px 12px">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span style="font-size:1.1rem">${isAudio?'🔊':f.type==='json'?'📊':'📄'}</span>
            <div style="flex:1;min-width:0">
              <div style="font-size:.8rem;font-weight:600;color:${isAudio?'var(--mint)':'#a78bfa'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHTML(f.filename)}</div>
              <div style="font-size:.68rem;color:var(--text-3)">${f.size_kb} KB · ${fmtTime(f.modified)}</div>
            </div>
            <div style="display:flex;gap:4px;flex-shrink:0">
              ${isAudio?`<button class="btn btn-sm btn-ghost" style="font-size:.7rem" onclick="HermesLab.playAudio('${fileUrl}','${encodeURIComponent(f.filename)}')">▶ تشغيل</button>`:''}
              <a href="${fileUrl}" target="_blank" class="btn btn-sm btn-ghost" style="font-size:.7rem;text-decoration:none">${isAudio?'↓ تنزيل':'👁 عرض'}</a>
              <button class="btn btn-sm btn-danger" style="font-size:.7rem" onclick="HermesLab.deleteFile('${escapeHTML(f.filename)}')">🗑️</button>
            </div>
          </div>
          ${isAudio?`<audio id="lab-audio-${encodeURIComponent(f.filename)}" src="${authUrl}" style="display:none;width:100%;height:28px;margin-top:6px" controls></audio>`:''}
        </div>`;
      }).join('');
    }catch(e){ listEl.innerHTML=`<p style="color:var(--red);text-align:center">${escapeHTML(e.message)}</p>`; }
  },
  playAudio(url,encoded){
    const id='lab-audio-'+encoded;
    const el=document.getElementById(id);
    if(!el) return;
    if(el.style.display==='none'){ el.style.display='block'; el.play(); }
    else{ el.style.display='none'; el.pause(); }
  },
  async deleteFile(filename){
    if(!confirm(`حذف "${filename}"؟`)) return;
    const r=await fetch(`${API}/admin/hermes/lab/file/${encodeURIComponent(filename)}`,{method:'DELETE',headers:{'x-admin-password':S.adminPw}}).then(x=>x.json());
    if(r.ok){ toast('تم الحذف','success'); HermesLab.loadFiles(); }
    else toast(r.error||'فشل الحذف','error');
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
    // Always refresh user data so sheikh_verified is up-to-date after approval
    try { const meR = await Api.get('/me'); if(meR.user) S.user = meR.user; } catch(_){}
    const isSheikhVerified = S.user?.sheikh_verified || false;
    const createSection = document.getElementById('channel-create-section');
    const lockedNotice  = document.getElementById('channel-locked-notice');
    if(createSection) createSection.style.display = isSheikhVerified ? 'block' : 'none';
    if(lockedNotice)  lockedNotice.style.display  = isSheikhVerified ? 'none'  : 'block';

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
      if(r.error){ if(r.error==='not_verified_sheikh') return toast('يجب أن تكون شيخاً معتمداً لإنشاء شُعبة','error'); return toast('خطأ','error'); }
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

    // Sheikh admin panel visibility
    const sheikhInput = document.getElementById('channel-sheikh-input');
    const sheikhBtn   = document.getElementById('btn-sheikh-panel');
    if(sheikhBtn){
      sheikhBtn.style.display = isS?'inline-flex':'none';
      sheikhBtn.onclick = ()=>{ if(sheikhInput) sheikhInput.style.display=sheikhInput.style.display==='none'?'block':'none'; };
    }
    if(sheikhInput) sheikhInput.style.display='none';

    // Members toggle (all users)
    const membersSection = document.getElementById('channel-members-section');
    const membersBtn = document.getElementById('btn-members-toggle');
    if(membersBtn){
      membersBtn.onclick = ()=>{ if(membersSection) membersSection.style.display=membersSection.style.display==='none'?'block':'none'; };
    }
    if(membersSection) membersSection.style.display='none';

    // Plan template (visible to all)
    const planTplEl = document.getElementById('channel-plan-template');
    if(planTplEl){
      if(ch.plan_template){
        planTplEl.style.display='block';
        planTplEl.innerHTML=`<div class="glass-card pad channel-ann">
          <div style="font-size:.72rem;color:var(--mint);margin-bottom:4px">📋 خطة الشُّعبة${ch.plan_template.updated_at?` · ${fmtRel(ch.plan_template.updated_at)}`:''}
          </div>
          <strong>${escapeHTML(ch.plan_template.name)}</strong> — ${ch.plan_template.daily_pages} صفحة/يوم
          ${ch.plan_template.description?`<div style="font-size:.82rem;color:var(--text-2);margin-top:3px">${escapeHTML(ch.plan_template.description)}</div>`:''}
        </div>`;
      } else { planTplEl.style.display='none'; }
    }

    // Pre-fill sheikh plan template form
    if(isS && ch.plan_template){
      const n=document.getElementById('plan-tpl-name'); const p=document.getElementById('plan-tpl-pages'); const d=document.getElementById('plan-tpl-desc');
      if(n) n.value=ch.plan_template.name||'';
      if(p) p.value=ch.plan_template.daily_pages||0.5;
      if(d) d.value=ch.plan_template.description||'';
    }

    // ── Active Review Session ──
    ChannelRoom.renderReviewSession(ch, isS, id);

    // Sheikh: start/close review session
    if(isS){
      const startBtn = document.getElementById('btn-start-review-session');
      const closeBtn = document.getElementById('btn-close-review-session');
      const rs = ch.active_review_session;
      if(rs && closeBtn) closeBtn.style.display='inline-flex';
      if(!rs && closeBtn) closeBtn.style.display='none';
      if(startBtn) startBtn.onclick = async ()=>{
        const title=(document.getElementById('rs-title')?.value||'').trim();
        const from=+document.getElementById('rs-from')?.value||1;
        const to=+document.getElementById('rs-to')?.value||10;
        const dl=document.getElementById('rs-deadline')?.value||'';
        if(!title) return toast('أدخل عنوان الجلسة','error');
        if(to<from) return toast('الصفحة النهائية يجب أن تكون أكبر من البداية','error');
        const r2=await Api.post('/channels/'+id+'/review-session',{title,from_page:from,to_page:to,deadline:dl});
        if(r2.ok){ toast('🚀 انطلقت جلسة المراجعة!','success'); ChannelRoom.open(id); }
      };
      if(closeBtn) closeBtn.onclick = async ()=>{
        if(!ch.active_review_session) return;
        if(!confirm('إنهاء جلسة المراجعة؟')) return;
        await Api.del('/channels/'+id+'/review-session/'+ch.active_review_session.id);
        toast('تم إنهاء الجلسة','info'); ChannelRoom.open(id);
      };
    }

    // Announcements
    const annEl = document.getElementById('channel-announcements');
    if(annEl) annEl.innerHTML = (ch.announcements||[]).slice().reverse().map(a=>`
      <div class="glass-card pad channel-ann" style="margin-bottom:6px">
        <div style="font-size:.72rem;color:var(--gold)">📢 إعلان · ${fmtRel(a.timestamp)}</div>
        <div style="margin-top:4px">${escapeHTML(a.text)}</div>
      </div>`).join('');

    // Messages
    const box = document.getElementById('channelroom-messages');
    if(box){
      box.innerHTML = (ch.messages||[]).map(m=>{
        const mine=m.from===S.username;
        const member = (ch.members||[]).find(x=>x.username===m.from);
        const col = member?.avatar_color||'#3b82f6';
        return `<div class="msg ${mine?'msg-mine':'msg-other'}">
          <span style="font-size:.65rem;opacity:.65;background:${mine?'rgba(0,0,0,.2)':'rgba(255,255,255,.1)'};padding:1px 5px;border-radius:10px;margin-bottom:2px;display:inline-block">
            ${mine?'أنت':'@'+escapeHTML(m.from)}${member?.is_sheikh?' 🏅':''}</span><br>
          ${escapeHTML(m.text)}<div class="msg-time">${fmtRel(m.timestamp)}</div></div>`;
      }).join('');
      box.scrollTop = box.scrollHeight;
    }

    // Send message
    const sendBtn = document.getElementById('btn-send-channel-msg');
    const msgInput = document.getElementById('channelroom-input');
    if(sendBtn) sendBtn.onclick = async ()=>{
      const t=(msgInput?.value||'').trim(); if(!t) return;
      await Api.post('/channels/'+id+'/message',{text:t});
      if(msgInput) msgInput.value=''; ChannelRoom.open(id);
    };
    if(msgInput) msgInput.onkeydown=e=>{ if(e.key==='Enter') sendBtn?.click(); };
    const chEmojiBtn=document.getElementById('btn-channelroom-emoji');
    if(chEmojiBtn) chEmojiBtn.onclick=()=>EmojiPicker.toggle('channelroom-input',chEmojiBtn);
    const chVideoBtn=document.getElementById('btn-channelroom-video');
    if(chVideoBtn) chVideoBtn.onclick=()=>VideoCall.open('channel-'+id, ch.name||'شُعبة');

    // Sheikh: Announce
    const annBtn=document.getElementById('btn-send-announce');
    const annInput=document.getElementById('channel-announce-text');
    if(annBtn) annBtn.onclick=async()=>{
      const t=(annInput?.value||'').trim(); if(!t) return;
      const r2=await Api.post('/channels/'+id+'/announce',{text:t});
      if(r2.ok){ toast('📢 أُرسل الإعلان','success'); if(annInput) annInput.value=''; ChannelRoom.open(id); }
    };

    // Sheikh: Plan template save
    const saveTplBtn=document.getElementById('btn-save-plan-tpl');
    if(saveTplBtn) saveTplBtn.onclick=async()=>{
      const name=(document.getElementById('plan-tpl-name')?.value||'').trim();
      const pages=+document.getElementById('plan-tpl-pages')?.value||0.5;
      const desc=(document.getElementById('plan-tpl-desc')?.value||'').trim();
      if(!name) return toast('أدخل اسم الخطة','error');
      const r3=await Api.post('/channels/'+id+'/plan-template',{name,daily_pages:pages,description:desc});
      if(r3.ok){ toast('💾 تم حفظ خطة الشُّعبة','success'); ChannelRoom.open(id); }
    };

    // Sheikh: Invite token
    const genInvBtn=document.getElementById('btn-gen-invite');
    if(genInvBtn) genInvBtn.onclick=async()=>{
      const target=(document.getElementById('invite-target-user')?.value||'').trim().toLowerCase()||null;
      const r4=await Api.post('/channels/'+id+'/invite-token',{target_username:target});
      if(r4.error) return toast(r4.error==='user_not_found'?'المستخدم غير موجود':r4.error==='already_member'?'هو عضو بالفعل':r4.error,'error');
      const resEl=document.getElementById('invite-result');
      if(resEl) resEl.style.display='block';
      setText('invite-token-display', r4.token||'');
      setText('invite-for-user', target?`خاص بـ @${target}`:'مفتوح لأي شخص');
      const copyBtn=document.getElementById('btn-copy-invite');
      if(copyBtn) copyBtn.onclick=()=>{ navigator.clipboard?.writeText(r4.token); toast('تم نسخ الرمز 📋','success'); };
      await ChannelRoom.loadInvites(id);
    };
    await ChannelRoom.loadInvites(id);

    // Sheikh: Channel settings
    const codeEl=document.getElementById('ch-join-code');
    if(codeEl) codeEl.textContent=ch.join_code||'';
    const refreshCodeBtn=document.getElementById('btn-refresh-code');
    if(refreshCodeBtn) refreshCodeBtn.onclick=async()=>{
      if(!confirm('تجديد كود الانضمام العام؟')) return;
      const r5=await Api.patch('/channels/'+id,{refresh_code:true});
      if(r5.ok){ toast('تم تجديد الكود','success'); ChannelRoom.open(id); }
    };
    const maxEl=document.getElementById('ch-max-members');
    if(maxEl) maxEl.value=ch.max_members||200;
    const saveSettBtn=document.getElementById('btn-save-ch-settings');
    if(saveSettBtn) saveSettBtn.onclick=async()=>{
      const max=+maxEl?.value||200;
      const r6=await Api.patch('/channels/'+id,{max_members:max});
      if(r6.ok) toast('تم حفظ الإعدادات ✅','success');
    };

    // Members list
    const membersList=document.getElementById('channel-members-list');
    if(membersList) membersList.innerHTML=(ch.members||[]).map(m=>`
      <div class="card-row glass-card" style="margin-bottom:4px">
        <div class="card-row-left">
          <div class="avatar-dot" style="background:${m.avatar_color||'#3b82f6'};font-size:.85rem">${(m.display_name||m.username||'?')[0]}</div>
          <div>${escapeHTML(m.display_name||m.username)}${m.is_sheikh?' 🏅':''}
            <div style="font-size:.7rem;color:var(--text-3)">@${escapeHTML(m.username)} · ${(m.pages||0).toFixed(1)}ص · 🔥${m.streak||0}</div>
          </div>
        </div>
        <div style="display:flex;gap:4px">
          ${m.username!==S.username?`<button class="btn btn-sm btn-secondary" data-dm="${escapeHTML(m.username)}">📨</button>`:'<span style="font-size:.7rem;color:var(--text-3)">أنت</span>'}
          ${isS&&m.username!==S.username?`<button class="btn btn-sm btn-danger" data-kick="${escapeHTML(m.username)}">✕</button>`:''}
        </div>
      </div>`).join('');
    document.querySelectorAll('#channel-members-list [data-dm]').forEach(b=>b.onclick=()=>ChatRoom.open(b.dataset.dm));
    document.querySelectorAll('#channel-members-list [data-kick]').forEach(b=>b.onclick=async()=>{
      if(!confirm(`إزالة @${b.dataset.kick}؟`)) return;
      const r7=await Api.del('/channels/'+id+'/member/'+b.dataset.kick);
      if(r7.ok){ toast('أُزيل العضو','success'); ChannelRoom.open(id); }
    });
  },

  renderReviewSession(ch, isS, channelId){
    const el = document.getElementById('channel-review-session');
    if(!el) return;
    const rs = ch.active_review_session;
    if(!rs){ el.style.display='none'; return; }
    el.style.display='block';

    const members = ch.members||[];
    const totalMembers = members.filter(m=>m.username!==ch.sheikh_username).length || 1;
    const completions = rs.completions||{};
    const completedList = Object.entries(completions);
    const doneCount = completedList.length;
    const pct = Math.round(doneCount/totalMembers*100);
    const myCompletion = completions[S.username];
    const totalPages = rs.to_page - rs.from_page + 1;
    const daysLeft = rs.deadline ? Math.ceil((new Date(rs.deadline)-Date.now())/86400000) : null;

    // Build member completion rows for sheikh
    const memberRows = isS ? members.map(m=>{
      const c = completions[m.username];
      const done = !!c;
      const isSheikhUser = m.username===ch.sheikh_username;
      if(isSheikhUser) return '';
      return `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.06)">
        <div class="avatar-dot" style="background:${m.avatar_color||'#3b82f6'};width:30px;height:30px;font-size:.8rem;flex-shrink:0">${(m.display_name||m.username||'?')[0]}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:.82rem">${escapeHTML(m.display_name||m.username)}</div>
          ${done?`<div style="font-size:.72rem;color:#34d399">${c.pages_done} صفحة · ${fmtRel(c.completed_at)}${c.notes?` · "${escapeHTML(c.notes)}"`:''}</div>`
                :`<div style="font-size:.72rem;color:var(--text-3)">لم يُسجّل بعد</div>`}
        </div>
        <span style="font-size:1.1rem">${done?'✅':'⏳'}</span>
      </div>`;
    }).join('') : '';

    el.innerHTML = `<div class="glass-card pad" style="border:1px solid rgba(99,102,241,.3)">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
        <div>
          <div style="font-size:.72rem;color:#a78bfa;margin-bottom:2px">📖 جلسة مراجعة نشطة</div>
          <strong style="font-size:1rem">${escapeHTML(rs.title)}</strong>
          <div style="font-size:.78rem;color:var(--text-2);margin-top:2px">الصفحات: ${rs.from_page} – ${rs.to_page} (${totalPages} صفحة)${daysLeft!==null?` · ${daysLeft>0?`باقي ${daysLeft} يوم`:daysLeft===0?'آخر يوم!':'انتهى الموعد'}`:''}</div>
        </div>
        <div style="font-size:1.3rem;font-weight:700;color:${pct>=100?'#34d399':'#a78bfa'}">${pct}%</div>
      </div>
      <!-- Progress bar -->
      <div style="background:rgba(255,255,255,.08);border-radius:20px;height:8px;margin-bottom:10px;overflow:hidden">
        <div style="background:linear-gradient(90deg,#6366f1,#a78bfa);height:100%;width:${pct}%;border-radius:20px;transition:width .4s"></div>
      </div>
      <div style="font-size:.78rem;color:var(--text-3);margin-bottom:${isS?'10px':'8px'}">${doneCount} من ${totalMembers} أعضاء أكملوا</div>
      ${isS ? `<div>${memberRows}</div>` : ''}
      ${!isS ? (myCompletion
        ? `<div style="padding:8px;background:rgba(52,211,153,.1);border-radius:8px;font-size:.85rem;color:#34d399">✅ سجّلت إنجازك — ${myCompletion.pages_done} صفحة${myCompletion.notes?' · '+escapeHTML(myCompletion.notes):''}</div>`
        : `<div id="rs-log-form" style="margin-top:4px">
            <div style="display:flex;gap:6px;align-items:center">
              <input id="rs-pages-done" class="field-input" type="number" min="0" max="${totalPages}" placeholder="الصفحات المراجَعة" style="width:140px">
              <input id="rs-notes" class="field-input" placeholder="ملاحظة (اختياري)" style="flex:1">
              <button class="btn btn-primary" id="btn-log-rs">تسجيل ✅</button>
            </div>
          </div>`)
      : ''}
    </div>`;

    // Wire up member log button
    if(!isS && !myCompletion){
      const logBtn = el.querySelector('#btn-log-rs');
      if(logBtn) logBtn.onclick = async ()=>{
        const pages = +el.querySelector('#rs-pages-done')?.value||0;
        const notes = (el.querySelector('#rs-notes')?.value||'').trim();
        if(!pages) return toast('أدخل عدد الصفحات التي راجعتها','error');
        const r2 = await Api.post('/channels/'+channelId+'/review-session/'+rs.id+'/log',{pages_done:pages,notes});
        if(r2.ok){ toast('✅ تم تسجيل إنجازك!','success'); ChannelRoom.open(channelId); }
        else toast('خطأ','error');
      };
    }
  },

  async loadInvites(id){
    const listEl=document.getElementById('invites-list');
    if(!listEl) return;
    const r=await Api.get('/channels/'+id+'/invites');
    if(r.error) return;
    const active=(r.invites||[]).filter(t=>!t.used_by);
    const used=(r.invites||[]).filter(t=>t.used_by);
    listEl.innerHTML=(active.length?active.map(t=>`
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;padding:5px 8px;background:rgba(255,255,255,.04);border-radius:6px">
        <span class="mono" style="color:var(--gold)">${t.token}</span>
        ${t.target_username?`<span style="color:var(--text-2)">→ @${escapeHTML(t.target_username)}</span>`:'<span style="color:var(--text-3)">مفتوح</span>'}
        <button class="btn btn-sm btn-danger" style="margin-right:auto" data-revoke="${t.token}">إلغاء</button>
      </div>`).join(''):'<div style="color:var(--text-3);font-size:.8rem">لا توجد دعوات نشطة</div>')+
      (used.length?`<div style="font-size:.75rem;color:var(--text-3);margin-top:6px">مُستخدمة: ${used.map(t=>`${t.token} ← @${t.used_by}`).join(', ')}</div>`:'');
    listEl.querySelectorAll('[data-revoke]').forEach(b=>b.onclick=async()=>{
      await Api.del('/channels/'+id+'/invite/'+b.dataset.revoke);
      ChannelRoom.loadInvites(id);
    });
  }
};

/* ════════════════════════════════════════════════════
   AI COACH — RAG + Memory + Tool Calling
   (الحافظ الذكي — يقرأ بياناتك الحقيقية قبل كل رد)
   ════════════════════════════════════════════════════ */
const AiCoach = {
  _inited: false,
  messages: [],
  _sending: false,

  init(){
    if(AiCoach._inited){ AiCoach.render(); return; }
    AiCoach._inited = true;
    AiCoach.messages = [];
    const sendBtn = document.getElementById('btn-send-ai');
    const aiInput = document.getElementById('ai-input');
    if(sendBtn) sendBtn.onclick = AiCoach.send;
    if(aiInput) aiInput.onkeydown = e=>{ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); AiCoach.send(); } };
    document.querySelectorAll('.ai-quick').forEach(b=>b.onclick=()=>{
      const aiInp = document.getElementById('ai-input');
      if(aiInp) aiInp.value = b.dataset.q; AiCoach.send();
    });
    AiCoach.render();
  },

  async send(){
    if(AiCoach._sending) return;
    const inp = document.getElementById('ai-input');
    const text = (inp?.value||'').trim(); if(!text) return;
    if(inp) inp.value='';
    AiCoach._sending = true;
    AiCoach.messages.push({from:'user', text});
    AiCoach.render();
    // Typing indicator
    const typingId = `typing_${Date.now()}`;
    AiCoach.messages.push({from:'ai', text:'', typing:true, id:typingId});
    AiCoach.render();
    try {
      // Use new RAG endpoint — sends real user data + memory to GPT
      const r = await Api.post('/ai/coach', {question:text});
      // Remove typing indicator
      AiCoach.messages = AiCoach.messages.filter(m=>m.id!==typingId);
      const toolNote = r.tool_executed ? `\n\n✅ تم تنفيذ الإجراء: ${JSON.stringify(r.tool_executed.action)}` : '';
      AiCoach.messages.push({ from:'ai', text:(r.reply||'عذراً، لم أتمكن من الرد.') + toolNote, correctable: true });
    } catch(e){
      AiCoach.messages = AiCoach.messages.filter(m=>m.id!==typingId);
      AiCoach.messages.push({from:'ai', text:'تعذّر الاتصال. تحقق من الإنترنت وحاول مجدداً.'});
      ErrorLogger.logAiError('AiCoach.send failed: '+String(e?.message||e));
    }
    AiCoach._sending = false;
    AiCoach.render();
  },

  async correct(wrongText, idx){
    const correct = prompt('ما هو الرد الصحيح؟');
    if (!correct) return;
    await Api.post('/ai/memory/correct', { wrong: wrongText, correct }).catch(()=>{});
    toast('شكراً! تم تسجيل التصحيح لتحسين الذكاء الاصطناعي ✅','success',2000);
  },

  render(){
    const box = document.getElementById('ai-messages');
    if(!box) return;
    if(!AiCoach.messages.length){
      box.innerHTML=`<div style="color:var(--text-2);text-align:center;padding:40px 10px">
        <div style="font-size:2rem;margin-bottom:8px">🧠</div>
        <div style="font-size:.9rem;font-weight:700;color:var(--text-1);margin-bottom:6px">الحافظ الذكي</div>
        <div style="font-size:.8rem;line-height:1.6">أسألني عن خطة حفظك، أخطاء تسميعك،<br>أفضل وقت للمراجعة، أو أي شيء يخص القرآن</div>
      </div>`;
      return;
    }
    box.innerHTML = AiCoach.messages.map((m,i)=>{
      const mine = m.from==='user';
      if(m.typing) return `<div class="msg msg-other"><span class="ai-typing-dot"></span><span class="ai-typing-dot"></span><span class="ai-typing-dot"></span></div>`;
      return `<div class="msg ${mine?'msg-mine':'msg-other'}" dir="${mine?'ltr':'rtl'}">
        <div style="white-space:pre-wrap;line-height:1.7">${escapeHTML(m.text)}</div>
        ${(!mine&&m.correctable)?`<button onclick="AiCoach.correct(${JSON.stringify(m.text)},${i})" style="margin-top:6px;font-size:.7rem;color:var(--text-3);background:none;border:none;cursor:pointer;font-family:'Tajawal',sans-serif;padding:2px 6px;border-radius:6px;border:1px solid rgba(255,255,255,.08)">⚠️ تصحيح</button>`:''}
      </div>`;
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
    EmojiPicker.init();
    VideoCall.initClose();
    document.querySelectorAll('[data-go]').forEach(b=>b.addEventListener('click', ()=>App.showView(b.dataset.go)));
    UI.showApp();
    if (S.token && S.username) await Boot.afterLogin();
    else App.showView('view-auth');
    UI.setLoading(false);
    Sensors.init();
    ErrorLogger.init();
    if(S.token) Notifications.startPolling();
  },
  _tarteelLoaded: false,
  async afterLogin(){
    try {
      const r = await Api.get('/me');
      if (r.error){
        // Clear only auth tokens, not all localStorage data
        LS.del('qqc_token'); LS.del('qqc_user');
        S.token=null; S.username=null;
        App.showView('view-auth'); return;
      }
      S.user = r.user;
      if (!S.user.onboarding?.completed) App.showView('view-onboarding');
      else App.showView('view-dashboard');
    } catch(e){
      // Network error — show auth
      App.showView('view-auth');
    }
  }
};

document.addEventListener('DOMContentLoaded', Boot.start);

/* ══════════════════════════════════════════════
   EMOJI PICKER
══════════════════════════════════════════════ */
const EmojiPicker = {
  EMOJIS: ['🌙','☪️','📖','🕌','🕋','🤲','🙏','✨','⭐','💫','🌟','🔥','❤️','💚','💙','💛','🎯','📚','✅','💪','🔑','🏆','👏','🌹','💐','🎓','😊','😄','🙂','👍','🤍','💎','🌈','🌿','🦋','🎵','🎶','😌','🤗','😇','💝','🌺','🌻','⚡','🌊','🏅','🎉','🎊','🙌','👑','🌱','🌸','🥰','❄️','🌙','🎁','💬','🖊️','📝','✏️'],
  target: null,
  init(){
    const panel = document.getElementById('emoji-panel');
    if (!panel) return;
    panel.innerHTML = EmojiPicker.EMOJIS.map(e=>`<button class="emoji-btn">${e}</button>`).join('');
    panel.querySelectorAll('.emoji-btn').forEach(b=>b.onclick=ev=>{
      ev.stopPropagation();
      if (EmojiPicker.target){
        const pos = EmojiPicker.target.selectionStart ?? EmojiPicker.target.value.length;
        const v = EmojiPicker.target.value;
        EmojiPicker.target.value = v.slice(0,pos) + b.textContent + v.slice(pos);
        EmojiPicker.target.focus();
        const np = pos + b.textContent.length;
        EmojiPicker.target.selectionStart = EmojiPicker.target.selectionEnd = np;
      }
      EmojiPicker.hide();
    });
    document.addEventListener('click', ev=>{
      const panel2 = document.getElementById('emoji-panel');
      if (panel2 && panel2.style.display==='flex' && !panel2.contains(ev.target) && !ev.target.closest('[data-emoji-for]') && !ev.target.closest('[id$="-emoji"]')) EmojiPicker.hide();
    });
  },
  toggle(inputId, btnEl){
    const panel = document.getElementById('emoji-panel');
    if (!panel) return;
    if (panel.style.display === 'flex'){ EmojiPicker.hide(); return; }
    EmojiPicker.target = document.getElementById(inputId);
    const rect = btnEl.getBoundingClientRect();
    panel.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
    panel.style.right = '10px';
    panel.style.left = 'auto';
    panel.style.display = 'flex';
  },
  hide(){ const p=document.getElementById('emoji-panel'); if(p) p.style.display='none'; }
};

/* ══════════════════════════════════════════════
   VIDEO CALL  (Jitsi Meet — free, no server)
══════════════════════════════════════════════ */
const VideoCall = {
  initClose(){
    const btn = document.getElementById('btn-close-jitsi');
    if (btn) btn.onclick = VideoCall.close;
    const modal = document.getElementById('jitsi-modal');
    if (modal) modal.addEventListener('click', ev=>{ if(ev.target===modal) VideoCall.close(); });
  },
  open(roomId, title){
    const modal = document.getElementById('jitsi-modal');
    const frame = document.getElementById('jitsi-frame');
    const titleEl = document.getElementById('jitsi-title');
    if (!modal || !frame) return;
    const clean = 'qqc-' + (roomId||'room').replace(/[^a-zA-Z0-9]/g,'-').slice(0,40);
    const name = encodeURIComponent(S.user?.display_name || S.username || 'ضيف');
    frame.src = `https://meet.jit.si/${clean}#config.startWithVideoMuted=false&config.prejoinPageEnabled=false&userInfo.displayName=${name}`;
    if (titleEl) titleEl.textContent = title || 'مكالمة فيديو';
    modal.style.display = 'flex';
  },
  close(){
    const modal = document.getElementById('jitsi-modal');
    const frame = document.getElementById('jitsi-frame');
    if (modal) modal.style.display = 'none';
    if (frame) frame.src = '';
  }
};

/* ══════════════════════════════════════════════
   QURAN BROWSER  (alquran.cloud — free, no key)
══════════════════════════════════════════════ */
const QuranBrowser = {
  surahs: [],
  currentAyahs: [],
  currentSurah: null,
  playing: false,
  paused: false,
  playQueue: [],
  playIndex: 0,
  loopRemain: 0,
  audioEl: null,
  preloadAudio: null,
  ayahMap: new Map(),
  speed: 1,
  sleepTimerEnd: null,
  sleepTimerInterval: null,

  get sheikh(){ return document.getElementById('quran-sheikh-select')?.value || 'ar.alafasy'; },

  /* 15+ Reciters — verses.quran.com (primary) + everyayah.com (fallback) */
  RECITERS: {
    'ar.alafasy':           { nameAr:'مشاري العفاسي',          qc:'Alafasy',         ev:'Alafasy_128kbps' },
    'ar.abdulbasitmurattal':{ nameAr:'عبد الباسط (مرتل)',       qc:'AbdulSamad',      ev:'Abdul_Basit_Murattal_192kbps' },
    'ar.husary':            { nameAr:'محمود خليل الحصري',      qc:'Husary',          ev:'Husary_128kbps' },
    'ar.mahermuaiqly':      { nameAr:'ماهر المعيقلي',           qc:'MaherAlMuaiqly',  ev:'Maher_AlMuaiqly_128kbps' },
    'ar.saudalshuraym':     { nameAr:'سعود الشريم',             qc:'Shuraim',         ev:'Saud_Al-Shuraim_128kbps' },
    'ar.minshawi':          { nameAr:'محمد صديق المنشاوي',     qc:'Minshawi',        ev:'Minshawi_128kbps' },
    'ar.sudais':            { nameAr:'عبد الرحمن السديس',       qc:'Sudais',          ev:'Abdurrahmaan_As-Sudais_192kbps' },
    'ar.ghamdi':            { nameAr:'سعد الغامدي',             qc:'Ghamdi',          ev:'Saad_Al-Ghamdi_128kbps' },
    'ar.tablawi':           { nameAr:'محمد الطبلاوي',           qc:'Tablawi',         ev:'Mohammad_al_Tablawi_128kbps' },
    'ar.dosari':            { nameAr:'ياسر الدوسري',            qc:'YasserAD',        ev:'Yasser_Ad-Dussary_128kbps' },
    'ar.ayyub':             { nameAr:'أيوب خاكواني',            qc:'AyubKhakwani',    ev:'' },
    'ar.khalil':            { nameAr:'وديع اليمني',             qc:'WadieAlYamani',   ev:'Wadi_Al-Yamani_128kbps' },
    'ar.shatree':           { nameAr:'أبو بكر الشاطري',         qc:'Shatree',         ev:'Abu_Bakr_Ash-Shaatree_128kbps' },
    'ar.basfar':            { nameAr:'عبد الله بصفر',           qc:'Basfar',          ev:'Abdullah_Basfar_192kbps' },
    'ar.hatem':             { nameAr:'هاتم فريد',               qc:'HatemFarid',      ev:'Hani_Rifai_192kbps' },
  },

  get loop(){ return +(document.getElementById('quran-loop-select')?.value ?? 1); },
  get ayahRepeat(){ return +(document.getElementById('quran-ayah-repeat-select')?.value ?? 1); },
  ayahRepeatRemain: 1,

  saveSettings(){
    if (!S.username) return;
    const settings = {
      sheikh: document.getElementById('quran-sheikh-select')?.value || 'ar.alafasy',
      loop:   document.getElementById('quran-loop-select')?.value   || '1',
      ayah_repeat: document.getElementById('quran-ayah-repeat-select')?.value || '1',
      speed: QuranBrowser.speed || 1,
    };
    LS.set(`qqc_quran_${S.username}`, JSON.stringify(settings));
  },

  loadSettings(){
    if (!S.username) return;
    try {
      const saved = JSON.parse(LS.get(`qqc_quran_${S.username}`) || 'null');
      if (!saved) return;
      const sheikh = document.getElementById('quran-sheikh-select');
      const loop   = document.getElementById('quran-loop-select');
      const ayahR  = document.getElementById('quran-ayah-repeat-select');
      if (sheikh && saved.sheikh) sheikh.value = saved.sheikh;
      if (loop   && saved.loop)   loop.value   = saved.loop;
      if (ayahR  && saved.ayah_repeat) ayahR.value = saved.ayah_repeat;
      if (saved.speed){ QuranBrowser.speed = +saved.speed || 1; const sb=document.getElementById('btn-quran-speed'); if(sb) sb.textContent=`${QuranBrowser.speed}×`; }
      // Update sheikh label
      const r = QuranBrowser.RECITERS[saved.sheikh];
      const lbl = document.getElementById('qpb-sheikh-label');
      if (lbl && r) lbl.textContent = r.nameAr;
    } catch(e){}
  },

  /* Speed cycle: 0.75x → 1x → 1.25x → 1.5x → 0.75x */
  cycleSpeed(){
    const speeds = [0.75, 1, 1.25, 1.5];
    const idx = speeds.indexOf(QuranBrowser.speed);
    QuranBrowser.speed = speeds[(idx+1) % speeds.length];
    if (QuranBrowser.audioEl) QuranBrowser.audioEl.playbackRate = QuranBrowser.speed;
    const btn = document.getElementById('btn-quran-speed');
    if (btn) btn.textContent = `${QuranBrowser.speed}×`;
    toast(`سرعة التشغيل: ${QuranBrowser.speed}×`, 'info', 1200);
    QuranBrowser.saveSettings();
  },

  /* Sleep timer (منبّه النوم) */
  setSleepTimer(minutes){
    if (QuranBrowser.sleepTimerInterval){ clearInterval(QuranBrowser.sleepTimerInterval); QuranBrowser.sleepTimerInterval=null; }
    QuranBrowser.sleepTimerEnd = null;
    const btn = document.getElementById('btn-quran-sleep');
    if (minutes === 0){ if (btn) btn.textContent='⏱'; return; }
    QuranBrowser.sleepTimerEnd = Date.now() + minutes*60000;
    if (btn) btn.textContent = `⏱${minutes}`;
    QuranBrowser.sleepTimerInterval = setInterval(()=>{
      if (!QuranBrowser.sleepTimerEnd) return;
      const rem = Math.max(0, QuranBrowser.sleepTimerEnd - Date.now());
      const mins = Math.ceil(rem/60000);
      if (btn) btn.textContent = mins > 0 ? `⏱${mins}` : '⏱';
      if (rem <= 0){
        clearInterval(QuranBrowser.sleepTimerInterval); QuranBrowser.sleepTimerEnd=null;
        // 3-second fade out
        if (QuranBrowser.audioEl){
          const el=QuranBrowser.audioEl; const startVol=el.volume; let step=0;
          const fade=setInterval(()=>{ step++; if(el) el.volume=Math.max(0,startVol*(1-step/30)); if(step>=30){ clearInterval(fade); QuranBrowser.stopAll(); if(btn) btn.textContent='⏱'; } },100);
        } else { QuranBrowser.stopAll(); if(btn) btn.textContent='⏱'; }
      }
    }, 10000);
    toast(`منبّه النوم: ${minutes} دقيقة ⏱`, 'success', 2000);
  },

  openSleepSheet(){
    const curr = QuranBrowser.sleepTimerEnd ? Math.ceil((QuranBrowser.sleepTimerEnd-Date.now())/60000) : 0;
    const el=document.createElement('div');
    el.style.cssText='position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,.65);display:flex;align-items:flex-end';
    el.innerHTML=`<div style="width:100%;background:#0f1729;border-radius:22px 22px 0 0;padding:20px 16px 32px;border:1px solid rgba(255,255,255,.12)">
      <div style="text-align:center;font-weight:700;color:#e5e7eb;margin-bottom:14px;font-size:1rem">⏱ منبّه النوم</div>
      <div style="display:flex;flex-direction:column;gap:8px">
        ${[15,30,60,90,120].map(m=>`<button data-sleep="${m}" style="padding:13px;border-radius:12px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.06);color:#e5e7eb;font-size:.92rem;cursor:pointer;font-family:'Tajawal',sans-serif;direction:rtl">${m} دقيقة</button>`).join('')}
        ${curr>0?`<button data-sleep="0" style="padding:13px;border-radius:12px;border:1px solid rgba(239,68,68,.4);background:rgba(239,68,68,.08);color:#ef4444;font-size:.92rem;cursor:pointer;font-family:'Tajawal',sans-serif">❌ إلغاء المنبّه (${curr} د متبقية)</button>`:''}
        <button data-sleep-close style="padding:10px;border-radius:12px;border:none;background:transparent;color:#6b7280;font-size:.88rem;cursor:pointer;font-family:'Tajawal',sans-serif">إغلاق</button>
      </div>
    </div>`;
    document.body.appendChild(el);
    el.querySelectorAll('[data-sleep]').forEach(b=>b.onclick=()=>{ QuranBrowser.setSleepTimer(+b.dataset.sleep); el.remove(); });
    el.querySelector('[data-sleep-close]').onclick=()=>el.remove();
    el.addEventListener('click',e=>{ if(e.target===el) el.remove(); });
  },

  async loadSurahs(){
    if (QuranBrowser.surahs.length) return QuranBrowser.surahs;
    try {
      const c = sessionStorage.getItem('qqc_surahs');
      if (c){ QuranBrowser.surahs = JSON.parse(c); return QuranBrowser.surahs; }
      const r = await fetch(`${API}/quran/surahs`);
      const d = await r.json();
      QuranBrowser.surahs = d.data || [];
      sessionStorage.setItem('qqc_surahs', JSON.stringify(QuranBrowser.surahs));
    } catch(e){ QuranBrowser.surahs = []; }
    return QuranBrowser.surahs;
  },

  async load(){
    const surahs = await QuranBrowser.loadSurahs();
    const sel = document.getElementById('quran-surah-select');
    if (sel && sel.options.length <= 1 && surahs.length){
      surahs.forEach(s=>{
        const o = document.createElement('option');
        o.value = s.number;
        o.textContent = `${s.number}. ${s.name} (${s.numberOfAyahs} آية)`;
        sel.appendChild(o);
      });
    }
    // Top bar: search + menu
    document.getElementById('btn-quran-search-toggle')?.addEventListener('click', ()=>{
      const sb = document.getElementById('quran-search-bar');
      if (sb) sb.style.display = sb.style.display === 'none' ? 'block' : 'none';
    });
    document.getElementById('btn-quran-menu-toggle')?.addEventListener('click', ()=>QuranBrowser.openSettingsSheet());
    document.getElementById('btn-quran-settings-toggle')?.addEventListener('click', ()=>QuranBrowser.openSettingsSheet());
    // Prev/next surah navigation
    document.getElementById('btn-quran-prev-surah')?.addEventListener('click', ()=>{
      const s2 = document.getElementById('quran-surah-select');
      if (s2 && +s2.value > 1){ s2.value = +s2.value - 1; QuranBrowser.loadSurah(); }
    });
    document.getElementById('btn-quran-next-surah')?.addEventListener('click', ()=>{
      const s2 = document.getElementById('quran-surah-select');
      if (s2 && +s2.value < 114){ s2.value = +s2.value + 1; QuranBrowser.loadSurah(); }
      else if (s2 && !s2.value && s2.options.length > 1){ s2.value = '1'; QuranBrowser.loadSurah(); }
    });
    // Player bar prev/next
    document.getElementById('btn-quran-prev-play')?.addEventListener('click', ()=>{
      if (QuranBrowser.playIndex > 0){ QuranBrowser.playIndex = Math.max(0, QuranBrowser.playIndex-2); QuranBrowser.stopCurrentAudio(); QuranBrowser.playNext(); }
    });
    document.getElementById('btn-quran-next-play')?.addEventListener('click', ()=>{
      QuranBrowser.stopCurrentAudio(); QuranBrowser.playIndex++; QuranBrowser.playNext();
    });
    // Repeat toggle
    document.getElementById('btn-quran-repeat')?.addEventListener('click', ()=>{
      const btn = document.getElementById('btn-quran-repeat');
      const loopSel = document.getElementById('quran-loop-select');
      if (!loopSel) return;
      const curr = +loopSel.value;
      if (curr===1){ loopSel.value='3'; toast('تكرار × ٣','info',1200); }
      else if (curr===3){ loopSel.value='0'; toast('تكرار مستمر ∞','info',1200); }
      else { loopSel.value='1'; toast('بدون تكرار','info',1200); }
      btn?.classList.toggle('active', loopSel.value !== '1');
      QuranBrowser.saveSettings();
    });
    // Surah select change
    sel?.addEventListener('change', ()=>{ if (sel.value) QuranBrowser.loadSurah(); });
    document.getElementById('btn-load-surah')?.addEventListener('click', QuranBrowser.loadSurah);
    // Quick surahs
    document.querySelectorAll('[data-qs]').forEach(b=>b.onclick=()=>{
      const s2 = document.getElementById('quran-surah-select');
      if (s2) s2.value = b.dataset.qs;
      const sb = document.getElementById('quran-search-bar');
      if (sb) sb.style.display = 'none';
      QuranBrowser.loadSurah();
    });
    // Sheet option buttons (loop/repeat)
    document.querySelectorAll('[data-loop]').forEach(b=>b.onclick=()=>{
      const loopSel = document.getElementById('quran-loop-select');
      if (loopSel) loopSel.value = b.dataset.loop;
      document.querySelectorAll('[data-loop]').forEach(x=>x.classList.remove('active'));
      b.classList.add('active');
      QuranBrowser.saveSettings();
    });
    document.querySelectorAll('[data-ayah-repeat]').forEach(b=>b.onclick=()=>{
      const arSel = document.getElementById('quran-ayah-repeat-select');
      if (arSel) arSel.value = b.dataset.ayahRepeat;
      document.querySelectorAll('[data-ayah-repeat]').forEach(x=>x.classList.remove('active'));
      b.classList.add('active');
      QuranBrowser.saveSettings();
    });
    // Sheikh change
    document.getElementById('quran-sheikh-select')?.addEventListener('change', ()=>{
      QuranBrowser.stopAll(); QuranBrowser.saveSettings();
      const sheikh = document.getElementById('quran-sheikh-select')?.value;
      const labels = {'ar.alafasy':'مشاري العفاسي','ar.abdulbasitmurattal':'عبد الباسط','ar.husary':'الحصري','ar.mahermuaiqly':'ماهر المعيقلي','ar.saudalshuraym':'سعود الشريم','ar.minshawi':'المنشاوي'};
      const lbl = document.getElementById('qpb-sheikh-label');
      if (lbl) lbl.textContent = labels[sheikh]||sheikh;
    });
    document.getElementById('quran-loop-select')?.addEventListener('change', ()=>QuranBrowser.saveSettings());
    document.getElementById('quran-ayah-repeat-select')?.addEventListener('change', ()=>QuranBrowser.saveSettings());
    // Playback controls — play button acts as play/pause toggle
    document.getElementById('btn-quran-play-all')?.addEventListener('click', ()=>{
      if (!QuranBrowser.playing || QuranBrowser.paused) {
        if (QuranBrowser.paused) QuranBrowser.togglePause();
        else QuranBrowser.playAll();
      } else {
        QuranBrowser.togglePause();
      }
    });
    document.getElementById('btn-quran-pause')?.addEventListener('click', QuranBrowser.togglePause);
    document.getElementById('btn-quran-stop')?.addEventListener('click', QuranBrowser.stopAll);
    // Speed control
    document.getElementById('btn-quran-speed')?.addEventListener('click', ()=>QuranBrowser.cycleSpeed());
    // Sleep timer
    document.getElementById('btn-quran-sleep')?.addEventListener('click', ()=>QuranBrowser.openSleepSheet());
    // Khatma
    QuranBrowser.loadKhatmaWidget();
    document.getElementById('btn-quran-khatma-complete')?.addEventListener('click', async()=>{
      try { await Api.post('/khatma/complete-day',{}); toast('أحسنت! سُجّل وردك اليوم ✅','success',2500); QuranBrowser.loadKhatmaWidget(); } catch(e){ toast('خطأ في تسجيل الورد','error'); }
    });
    QuranBrowser.loadSettings();
    // Init all sheets
    QuranBrowser.initSettingsSheet();
    QuranBrowser.initAyahSheet();
    QuranBrowser.initPlayToSheet();
    // Auto-load Al-Fatiha
    if (!QuranBrowser.currentAyahs.length) {
      const doAutoLoad = ()=>{
        if (sel && sel.options.length > 1 && !QuranBrowser.currentAyahs.length) {
          sel.value = '1'; QuranBrowser.loadSurah();
        }
      };
      if (sel && sel.options.length > 1) doAutoLoad();
      else setTimeout(doAutoLoad, 600);
    }
    QuranBrowser.initPracticePanel();
  },

  /* ── Sheet helpers ── */
  openSettingsSheet(){ const s=document.getElementById('quran-settings-sheet'); if(s) s.style.display='block'; },
  closeSettingsSheet(){ const s=document.getElementById('quran-settings-sheet'); if(s) s.style.display='none'; },
  initSettingsSheet(){
    document.getElementById('qsheet-backdrop')?.addEventListener('click', QuranBrowser.closeSettingsSheet);
  },

  _activeAyahGnum: null,
  initAyahSheet(){
    document.getElementById('qayah-backdrop')?.addEventListener('click', ()=>QuranBrowser.closeAyahSheet());
    document.getElementById('btn-ayah-sheet-close')?.addEventListener('click', ()=>QuranBrowser.closeAyahSheet());
    document.getElementById('btn-ayah-play')?.addEventListener('click', ()=>{
      const gn = QuranBrowser._activeAyahGnum;
      if (gn != null){ QuranBrowser.closeAyahSheet(); QuranBrowser.playAudio(gn); }
    });
    document.getElementById('btn-ayah-play-to')?.addEventListener('click', ()=>{
      QuranBrowser.closeAyahSheet();
      setTimeout(()=>QuranBrowser.openPlayToSheet(QuranBrowser._activeAyahGnum), 200);
    });
    document.getElementById('btn-ayah-copy')?.addEventListener('click', ()=>{
      const info = QuranBrowser.ayahMap.get(QuranBrowser._activeAyahGnum);
      if (info) navigator.clipboard?.writeText(info.text).then(()=>toast('تم نسخ الآية ✅','success',1500));
    });
    document.getElementById('btn-ayah-share')?.addEventListener('click', ()=>{
      const info = QuranBrowser.ayahMap.get(QuranBrowser._activeAyahGnum);
      if (info && navigator.share) navigator.share({ text: `${info.text}\n— ${info.surahName} : ${info.ayahNum}` }).catch(()=>{});
      else toast('مشاركة غير متاحة في هذا المتصفح','error');
    });
    document.getElementById('btn-ayah-practice')?.addEventListener('click', ()=>{
      const gn = QuranBrowser._activeAyahGnum;
      QuranBrowser.closeAyahSheet();
      if (gn != null) setTimeout(()=>QuranBrowser.showPracticePanel(gn), 200);
    });
    document.getElementById('btn-ayah-studio')?.addEventListener('click', ()=>{
      const info = QuranBrowser.ayahMap.get(QuranBrowser._activeAyahGnum);
      if (info) VoiceStudio.setPracticeVerse(info.surahNum, info.ayahNum, info.text, info.surahName, info.globalNum);
      QuranBrowser.closeAyahSheet();
      App.showView('view-studio');
    });
  },
  openAyahSheet(gNum){
    QuranBrowser._activeAyahGnum = gNum;
    const info = QuranBrowser.ayahMap.get(gNum);
    const ref = document.getElementById('qayah-header-ref');
    if (ref && info) ref.textContent = `${info.surahName} : ${info.ayahNum}`;
    // Update play-to tags
    const surahTag = document.getElementById('playto-surah-tag');
    if (surahTag && info) surahTag.textContent = info.surahName;
    const sheet = document.getElementById('quran-ayah-sheet');
    if (sheet) sheet.style.display = 'block';
  },
  closeAyahSheet(){ const s=document.getElementById('quran-ayah-sheet'); if(s) s.style.display='none'; },

  initPlayToSheet(){
    document.getElementById('qplayto-backdrop')?.addEventListener('click', ()=>QuranBrowser.closePlayToSheet());
    document.getElementById('playto-continuous')?.addEventListener('click', ()=>{
      const loopSel = document.getElementById('quran-loop-select');
      if (loopSel) loopSel.value = '0';
      QuranBrowser.saveSettings();
      QuranBrowser.closePlayToSheet();
      QuranBrowser.playAll();
    });
    document.getElementById('playto-page-end')?.addEventListener('click', ()=>{
      QuranBrowser.closePlayToSheet();
      QuranBrowser.playAll();
    });
    document.getElementById('playto-surah-end')?.addEventListener('click', ()=>{
      QuranBrowser.closePlayToSheet();
      const gn = QuranBrowser._activeAyahGnum;
      if (gn) {
        const idx = QuranBrowser.currentAyahs.findIndex(a=>a.number===gn);
        QuranBrowser.playQueue = QuranBrowser.currentAyahs.slice(idx>=0?idx:0).map(a=>a.number);
        QuranBrowser.loopRemain = 1; QuranBrowser.ayahRepeatRemain = QuranBrowser.ayahRepeat;
        QuranBrowser.playIndex = 0; QuranBrowser.playing = true;
        QuranBrowser.playNext();
        const pb=document.getElementById('btn-quran-pause'); if(pb) pb.disabled=false;
        const sb=document.getElementById('btn-quran-stop'); if(sb) sb.disabled=false;
      } else { QuranBrowser.playAll(); }
    });
    // Tab switching
    document.querySelectorAll('.playto-tab').forEach(t=>t.onclick=()=>{
      document.querySelectorAll('.playto-tab').forEach(x=>x.classList.remove('playto-tab-active'));
      t.classList.add('playto-tab-active');
      QuranBrowser.renderPlayToList(t.dataset.ptab);
    });
  },
  openPlayToSheet(gNum){
    QuranBrowser._activeAyahGnum = gNum || QuranBrowser._activeAyahGnum;
    QuranBrowser.renderPlayToList('ayah');
    const sheet = document.getElementById('quran-playto-sheet');
    if (sheet) sheet.style.display = 'block';
  },
  closePlayToSheet(){ const s=document.getElementById('quran-playto-sheet'); if(s) s.style.display='none'; },
  renderPlayToList(tab){
    const list = document.getElementById('playto-list');
    if (!list) return;
    const gn = QuranBrowser._activeAyahGnum;
    const info = gn ? QuranBrowser.ayahMap.get(gn) : null;
    if (tab === 'ayah' && QuranBrowser.currentAyahs.length){
      list.innerHTML = QuranBrowser.currentAyahs.map(a=>`
        <div class="playto-list-item" data-playto-ayah="${a.number}">
          <span>${a.surah?.name||info?.surahName||''}: ${a.numberInSurah}</span>
          <span class="pli-page">صفحة ${a.page||''}</span>
        </div>`).join('');
      list.querySelectorAll('[data-playto-ayah]').forEach(el=>el.onclick=()=>{
        const targetGn = +el.dataset.playtoAyah;
        QuranBrowser.closePlayToSheet();
        const idx = QuranBrowser.currentAyahs.findIndex(a=>a.number===targetGn);
        QuranBrowser.playQueue = QuranBrowser.currentAyahs.slice(idx>=0?idx:0).map(a=>a.number);
        QuranBrowser.loopRemain = 1; QuranBrowser.ayahRepeatRemain = QuranBrowser.ayahRepeat;
        QuranBrowser.playIndex=0; QuranBrowser.playing=true;
        QuranBrowser.playNext();
        const pb=document.getElementById('btn-quran-pause'); if(pb) pb.disabled=false;
        const sb=document.getElementById('btn-quran-stop'); if(sb) sb.disabled=false;
      });
    } else {
      list.innerHTML = '<div style="padding:14px;text-align:center;color:var(--text-3);font-size:.85rem">حمّل سورة أولاً</div>';
    }
  },

  async loadKhatmaWidget(){
    try {
      const r = await Api.get('/khatma');
      const k = r.khatma;
      const bar = document.getElementById('quran-khatma-bar');
      const info = document.getElementById('quran-khatma-info');
      if (!k || !bar || !info) return;
      bar.style.display = 'block';
      const pct = Math.round((k.completed_days/k.total_days)*100);
      info.textContent = `${k.completed_days} / ${k.total_days} يوم — الورد: ${k.daily_pages || '?'} صفحة يومياً — ${pct}% مكتمل`;
    } catch(e){}
  },

  loadSurah(){
    return QuranBrowser.loadContent();
  },

  async loadContent(){
    QuranBrowser.stopAll();
    await QuranBrowser.loadSurah();
  },

  async loadPage(){
    const pageNum = +(document.getElementById('quran-page-num')?.value || 1);
    const display = document.getElementById('quran-display');
    if (display) display.innerHTML = `<div style="text-align:center;padding:40px;color:var(--text-2)">⏳ جارٍ تحميل الصفحة ${pageNum}…</div>`;
    try {
      const r = await fetch(`${API}/quran/page/${pageNum}`);
      const d = await r.json();
      if (!d.data?.ayahs) throw new Error('no data');
      const ayahs = d.data.ayahs;
      QuranBrowser.currentAyahs = ayahs;
      ayahs.forEach(a=>{ QuranBrowser.ayahMap.set(a.number,{text:a.text,surahNum:a.surah.number,ayahNum:a.numberInSurah,surahName:a.surah.name,globalNum:a.number}); });

      const surahGroups = {};
      ayahs.forEach(a=>{
        const k = a.surah.number;
        if (!surahGroups[k]) surahGroups[k] = [];
        surahGroups[k].push(a);
      });

      let html = `<div class="glass-card pad" style="margin-bottom:10px;text-align:center">
        <div style="font-size:1.1rem;font-weight:700;color:var(--gold)">الصفحة ${pageNum}</div>
        <div style="font-size:.76rem;color:var(--text-3);margin-top:3px">${Object.values(surahGroups).map(g=>g[0].surah.name).join(' · ')}</div>
      </div>`;

      Object.entries(surahGroups).forEach(([sNum, grp])=>{
        const showBism = grp[0].numberInSurah === 1 && +sNum !== 1 && +sNum !== 9;
        html += `<div class="glass-card pad mushaf-surah-block">
          <div style="text-align:center;margin-bottom:12px">
            <div style="font-size:1.4rem;font-weight:900;color:var(--gold)">${grp[0].surah.name}</div>
            <div style="font-size:.76rem;color:var(--text-2)">${grp[0].surah.englishName}</div>
            ${showBism ? '<div style="font-size:.92rem;color:var(--text-3);margin-top:6px">بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ</div>' : ''}
          </div>
          <div class="mushaf-text" dir="rtl">
            ${grp.map(a=>`<span class="ayah-word" data-global="${a.number}" data-local="${a.numberInSurah}">${a.text.split(' ').map((w,wi)=>`<span class="quran-word" data-global="${a.number}" data-wi="${wi}">${escapeHTML(w)}</span>`).join(' ')}<span class="ayah-end-marker">﴿${a.numberInSurah}﴾</span></span>`).join(' ')}
          </div>
          <div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:10px">
            ${grp.map(a=>`<button class="btn btn-sm btn-ghost ayah-play-btn" data-play-ayah="${a.number}">🔊 ${a.numberInSurah}</button> <button class="btn btn-sm btn-secondary ayah-practice-btn" data-global="${a.number}" style="padding:2px 7px;font-size:.72rem">🎤</button>`).join('')}
          </div>
        </div>`;
      });

      if (display) display.innerHTML = html;
      QuranBrowser.wireButtons(ayahs, null);
      QuranBrowser.enablePlayback();
    } catch(e){
      if (display) display.innerHTML='<p style="color:#ef4444;text-align:center;padding:20px">⚠️ خطأ في التحميل</p>';
    }
  },

  async loadSurah(){
    const surahNum = +(document.getElementById('quran-surah-select')?.value || 0);
    const fromA = +(document.getElementById('quran-from-ayah')?.value || 0);
    const toA   = +(document.getElementById('quran-to-ayah')?.value || 0);
    if (!surahNum) return toast('اختر سورة أولاً','error');
    const display = document.getElementById('quran-display');
    if (display) display.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-2)">⏳ جارٍ تحميل السورة…</div>';
    try {
      const r = await fetch(`${API}/quran/surah/${surahNum}`);
      const d = await r.json();
      if (!d.data) throw new Error('no data');
      const surah = d.data;
      let ayahs = surah.ayahs;
      if (fromA) ayahs = ayahs.filter(a=>a.numberInSurah >= fromA);
      if (toA)   ayahs = ayahs.filter(a=>a.numberInSurah <= toA);
      QuranBrowser.currentSurah = surah;
      QuranBrowser.currentAyahs = ayahs;
      ayahs.forEach(a=>{ QuranBrowser.ayahMap.set(a.number,{text:a.text,surahNum,ayahNum:a.numberInSurah,surahName:surah.name,globalNum:a.number}); });

      const bism = surahNum!==1 && surahNum!==9
        ? '<div style="font-size:1.05rem;color:var(--text-3);margin-top:8px">بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ</div>' : '';
      const range = (fromA||toA) ? `<div style="font-size:.76rem;color:#34d399;margin-top:4px">آيات ${fromA||1}–${toA||surah.numberOfAyahs}</div>` : '';

      if (display) display.innerHTML = `
        <div class="glass-card pad mushaf-surah-block" style="margin-bottom:10px;text-align:center">
          <div style="font-size:1.7rem;font-weight:900;color:var(--gold)">${surah.name}</div>
          <div style="font-size:.82rem;color:var(--text-2);margin-top:4px">${surah.englishName} · ${surah.numberOfAyahs} آية · ${surah.revelationType==='Meccan'?'مكية':'مدنية'}</div>
          ${bism}${range}
        </div>
        <div class="glass-card pad mushaf-surah-block" style="margin-bottom:10px">
          <div class="mushaf-text" dir="rtl">
            ${ayahs.map(a=>`<span class="ayah-word" data-global="${a.number}" data-local="${a.numberInSurah}">${a.text.split(' ').map((w,wi)=>`<span class="quran-word" data-global="${a.number}" data-wi="${wi}">${escapeHTML(w)}</span>`).join(' ')}<span class="ayah-end-marker">﴿${a.numberInSurah}﴾</span></span>`).join(' ')}
          </div>
          <div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:10px">
            ${ayahs.map(a=>`<button class="btn btn-sm btn-ghost ayah-play-btn" data-play-ayah="${a.number}">🔊 ${a.numberInSurah}</button> <button class="btn btn-sm btn-secondary ayah-practice-btn" data-global="${a.number}" style="padding:2px 7px;font-size:.72rem">🎤</button>`).join('')}
          </div>
        </div>
        ${ayahs.map(a=>QuranBrowser.renderCard(a, surahNum, surah.name)).join('')}
        ${fromA && ayahs.length===0 ? '<p style="text-align:center;color:var(--text-2);padding:20px">لا آيات في هذا النطاق</p>' : ''}
      `;
      QuranBrowser.wireButtons(ayahs, surah);
      QuranBrowser.enablePlayback();
    } catch(e){
      if (display) display.innerHTML='<p style="color:#ef4444;text-align:center;padding:20px">⚠️ خطأ في التحميل — تحقق من الاتصال</p>';
    }
  },

  renderCard(a, surahNum, surahName){
    const words = a.text.split(' ').map((w,wi)=>
      `<span class="quran-word" data-global="${a.number}" data-wi="${wi}">${escapeHTML(w)}</span>`
    ).join(' ');
    return `<div class="ayah-card-v2" id="ayah-card-${a.number}">
      <div class="ayah-card-v2-header">
        <button class="ayah-num-badge ayah-badge-btn" data-badge-ayah="${a.number}" title="خيارات الآية">${a.numberInSurah}</button>
        <div class="ayah-card-v2-actions">
          <button class="ayah-mini-btn ayah-play-btn" data-play-ayah="${a.number}" title="تشغيل">▶</button>
          <button class="ayah-mini-btn ayah-practice-btn" data-global="${a.number}" title="تسميع">🎙️</button>
        </div>
      </div>
      <div class="ayah-card-v2-text" dir="rtl">
        <span class="ayah-word-group" data-global="${a.number}">${words}</span>
        <span class="ayah-end-badge">${a.numberInSurah}</span>
      </div>
    </div>`;
  },

  wireButtons(ayahs, surah){
    const display = document.getElementById('quran-display');
    if (!display) return;
    display.querySelectorAll('.ayah-play-btn').forEach(b=>b.onclick=()=>{
      QuranBrowser.stopAll();
      const gNum = +b.dataset.playAyah;
      const idx = QuranBrowser.currentAyahs.findIndex(a=>a.number===gNum);
      QuranBrowser.playQueue = QuranBrowser.currentAyahs.slice(idx>=0?idx:0).map(a=>a.number);
      QuranBrowser.loopRemain = QuranBrowser.loop === 0 ? Infinity : (QuranBrowser.loop || 1);
      QuranBrowser.ayahRepeatRemain = QuranBrowser.ayahRepeat;
      QuranBrowser.playIndex = 0; QuranBrowser.playing = true;
      QuranBrowser.playNext();
      const pb=document.getElementById('btn-quran-pause'); if(pb) pb.disabled=false;
      const sb=document.getElementById('btn-quran-stop'); if(sb) sb.disabled=false;
      const playBtn=document.getElementById('btn-quran-play-all'); if(playBtn) playBtn.disabled=false;
    });
    display.querySelectorAll('.ayah-practice-btn').forEach(b=>b.onclick=()=>{
      QuranBrowser.showPracticePanel(+b.dataset.global);
    });
    // Ayah badge → open action sheet
    display.querySelectorAll('.ayah-badge-btn').forEach(b=>b.onclick=()=>{
      QuranBrowser.openAyahSheet(+b.dataset.badgeAyah);
    });
  },

  enablePlayback(){
    const btn = document.getElementById('btn-quran-play-all');
    if (btn) btn.disabled = false;
  },

  playAll(){
    QuranBrowser.stopAll();
    if (!QuranBrowser.currentAyahs.length) return toast('حمّل سورة أو صفحة أولاً','error');
    QuranBrowser.playQueue = QuranBrowser.currentAyahs.map(a=>a.number);
    QuranBrowser.loopRemain = QuranBrowser.loop === 0 ? Infinity : (QuranBrowser.loop || 1);
    QuranBrowser.ayahRepeatRemain = QuranBrowser.ayahRepeat;
    QuranBrowser.playIndex = 0;
    QuranBrowser.playing = true;
    QuranBrowser.paused = false;
    QuranBrowser.playNext();
    document.getElementById('btn-quran-pause').disabled = false;
    document.getElementById('btn-quran-stop').disabled = false;
  },

  playNext(){
    if (!QuranBrowser.playing || QuranBrowser.paused) return;
    if (QuranBrowser.playIndex >= QuranBrowser.playQueue.length){
      QuranBrowser.loopRemain = QuranBrowser.loopRemain === Infinity ? Infinity : QuranBrowser.loopRemain - 1;
      if (QuranBrowser.loopRemain <= 0){
        QuranBrowser.stopAll();
        toast('✅ انتهت التلاوة','success',2500);
        return;
      }
      QuranBrowser.playIndex = 0;
      QuranBrowser.ayahRepeatRemain = QuranBrowser.ayahRepeat;
    }
    const gNum = QuranBrowser.playQueue[QuranBrowser.playIndex];
    QuranBrowser.highlightAyah(gNum);
    const loopTxt = QuranBrowser.loopRemain === Infinity ? '∞' : QuranBrowser.loopRemain > 1 ? `(×${QuranBrowser.loopRemain})` : '';
    const repTxt = QuranBrowser.ayahRepeat > 1 ? ` [${QuranBrowser.ayahRepeat - QuranBrowser.ayahRepeatRemain + 1}/${QuranBrowser.ayahRepeat}]` : '';
    const info = document.getElementById('quran-playing-info');
    if (info) info.textContent = `▶ آية ${QuranBrowser.playIndex+1}/${QuranBrowser.playQueue.length}${repTxt} ${loopTxt}`;
    // Update player bar "now playing" label
    const nowPlaying = document.getElementById('qpb-now-playing');
    if (nowPlaying){ const inf2=QuranBrowser.ayahMap.get(gNum); if(inf2) nowPlaying.textContent=`▶ ${inf2.surahName} : ${inf2.ayahNum}${repTxt} ${loopTxt}`; }
    const playBtn = document.getElementById('btn-quran-play-all');
    if (playBtn) playBtn.textContent = '⏸';
    QuranBrowser.playAudioSeq(gNum, ()=>{
      QuranBrowser.ayahRepeatRemain--;
      if (QuranBrowser.ayahRepeatRemain > 0){
        // Repeat same ayah
        setTimeout(QuranBrowser.playNext, 350);
      } else {
        // Advance to next ayah
        QuranBrowser.ayahRepeatRemain = QuranBrowser.ayahRepeat;
        QuranBrowser.playIndex++;
        setTimeout(QuranBrowser.playNext, 400);
      }
    });
  },

  highlightAyah(gNum){
    document.querySelectorAll('.ayah-word.playing').forEach(e=>e.classList.remove('playing'));
    document.querySelectorAll('.quran-ayah-card.playing,.ayah-card-v2.playing-card').forEach(e=>e.classList.remove('playing','playing-card'));
    document.querySelectorAll('.quran-word.word-playing').forEach(e=>e.classList.remove('word-playing'));
    const word = document.querySelector(`.ayah-word[data-global="${gNum}"]`);
    if (word){ word.classList.add('playing'); word.scrollIntoView({block:'nearest',behavior:'smooth'}); }
    const card = document.getElementById(`ayah-card-${gNum}`);
    if (card){ card.classList.add('playing-card'); card.scrollIntoView({block:'nearest',behavior:'smooth'}); }
    // Update top bar reference
    const info = QuranBrowser.ayahMap.get(gNum);
    if (info){
      const ref = document.getElementById('qtb-surah-name');
      const aref = document.getElementById('qtb-ayah-ref');
      if (ref) ref.textContent = info.surahName;
      if (aref) aref.textContent = `آية ${info.ayahNum}`;
    }
  },

  togglePause(){
    const playBtn = document.getElementById('btn-quran-play-all');
    const pauseIcon = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';
    const resumeIcon = '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>';
    if (!QuranBrowser.paused){
      QuranBrowser.paused = true;
      if (QuranBrowser.audioEl) QuranBrowser.audioEl.pause();
      if (playBtn) playBtn.innerHTML = resumeIcon;
      const info = document.getElementById('quran-playing-info');
      if (info) info.textContent = '⏸ متوقف مؤقتاً';
    } else {
      QuranBrowser.paused = false;
      if (playBtn) playBtn.innerHTML = pauseIcon;
      if (QuranBrowser.audioEl && QuranBrowser.audioEl.paused) QuranBrowser.audioEl.play().catch(()=>{});
      else QuranBrowser.playNext();
    }
  },

  stopCurrentAudio(){
    if (QuranBrowser.audioEl){
      QuranBrowser.audioEl.onended=null; QuranBrowser.audioEl.onerror=null;
      QuranBrowser.audioEl.pause(); QuranBrowser.audioEl.src='';
      QuranBrowser.audioEl=null;
    }
  },

  stopAll(){
    QuranBrowser.playing = false;
    QuranBrowser.paused = false;
    QuranBrowser.playQueue = [];
    QuranBrowser.playIndex = 0;
    QuranBrowser.stopCurrentAudio();
    document.querySelectorAll('.ayah-word.playing').forEach(e=>e.classList.remove('playing'));
    document.querySelectorAll('.quran-ayah-card.playing,.ayah-card-v2.playing-card').forEach(e=>e.classList.remove('playing','playing-card'));
    document.querySelectorAll('.quran-word.word-playing').forEach(e=>e.classList.remove('word-playing'));
    const pauseBtn = document.getElementById('btn-quran-pause');
    if (pauseBtn){ pauseBtn.disabled=true; }
    const stopBtn = document.getElementById('btn-quran-stop');
    if (stopBtn) stopBtn.disabled = true;
    const info = document.getElementById('quran-playing-info');
    if (info) info.textContent = '';
    const np = document.getElementById('qpb-now-playing');
    if (np) np.textContent = '';
    const playBtn = document.getElementById('btn-quran-play-all');
    if (playBtn) playBtn.textContent = '▶';
  },

  playAudioSeq(gNum, onEnd){
    // Tear down any existing audio element first
    if (QuranBrowser.audioEl){
      const old = QuranBrowser.audioEl;
      old.onended=null; old.onerror=null; old.ontimeupdate=null; old.oncanplay=null;
      old.pause(); old.src='';
      QuranBrowser.audioEl = null;
    }
    document.querySelectorAll('.quran-word.word-playing').forEach(e=>e.classList.remove('word-playing'));
    const sheikh = QuranBrowser.sheikh;
    const info = QuranBrowser.ayahMap.get(gNum);
    const reciter = QuranBrowser.RECITERS[sheikh] || { qc:'Alafasy', ev:'Alafasy_128kbps' };
    const sNum = String(info?.surahNum||1).padStart(3,'0');
    const aNum = String(info?.ayahNum||1).padStart(3,'0');
    // URL priority: verses.quran.com → everyayah.com → islamic.network
    const urls = [`https://verses.quran.com/${reciter.qc}/mp3/${sNum}${aNum}.mp3`];
    if (reciter.ev) urls.push(`https://everyayah.com/data/${reciter.ev}/${sNum}${aNum}.mp3`);
    urls.push(`https://cdn.islamic.network/quran/audio/128/${sheikh}/${gNum}.mp3`);
    urls.push(`https://cdn.islamic.network/quran/audio/64/${sheikh}/${gNum}.mp3`);

    document.querySelectorAll(`.ayah-play-btn[data-play-ayah="${gNum}"]`).forEach(b=>{ b._origText=b.textContent; b.textContent='⏳'; b.disabled=true; });
    const resetBtns = ()=>document.querySelectorAll(`.ayah-play-btn[data-play-ayah="${gNum}"]`).forEach(b=>{ b.textContent=b._origText||'▶'; b.disabled=false; });

    let urlIdx = 0;
    let done = false;
    const au = new Audio();
    au.preload = 'auto';
    au.playbackRate = QuranBrowser.speed || 1;
    QuranBrowser.audioEl = au;

    const finish = ()=>{
      if (done) return;
      done = true;
      resetBtns();
      document.querySelectorAll('.quran-word.word-playing').forEach(e=>e.classList.remove('word-playing'));
      const pb = document.getElementById('qpb-progress');
      if (pb){ pb.value=0; pb.style.opacity='0'; }
      // 300ms silence gap between ayahs (+ respect pause state)
      if (!QuranBrowser.paused && onEnd) setTimeout(onEnd, 300);
    };

    const tryNext = ()=>{
      urlIdx++;
      if (urlIdx >= urls.length){
        toast('تعذّر تحميل الصوت، تحقق من الاتصال بالإنترنت ⚠️','error',3500);
        finish(); return;
      }
      au.src = urls[urlIdx];
      au.load();
      au.play().catch(()=>{});
    };

    au.oncanplay = ()=>{
      resetBtns();
      const pb = document.getElementById('qpb-progress');
      if (pb) pb.style.opacity='1';
      // Preload next ayah while this one plays
      const nextIdx = QuranBrowser.playIndex + 1;
      if (nextIdx < QuranBrowser.playQueue.length){
        const nextGNum = QuranBrowser.playQueue[nextIdx];
        const nInfo = QuranBrowser.ayahMap.get(nextGNum);
        if (nInfo){
          const ns = String(nInfo.surahNum||1).padStart(3,'0');
          const na = String(nInfo.ayahNum||1).padStart(3,'0');
          if (!QuranBrowser.preloadAudio) QuranBrowser.preloadAudio = new Audio();
          QuranBrowser.preloadAudio.src = `https://verses.quran.com/${reciter.qc}/mp3/${ns}${na}.mp3`;
          QuranBrowser.preloadAudio.preload = 'auto';
          QuranBrowser.preloadAudio.load();
        }
      }
    };

    au.onended = finish;
    au.onerror = ()=>tryNext();

    au.ontimeupdate = ()=>{
      if (!au.duration||au.duration<=0) return;
      const prog = au.currentTime/au.duration;
      // Progress bar
      const pb = document.getElementById('qpb-progress');
      if (pb) pb.value = Math.round(prog*100);
      // Word-by-word highlight
      const words = document.querySelectorAll(`.quran-word[data-global="${gNum}"]`);
      if (!words.length) return;
      const idx = Math.min(Math.floor(prog*words.length), words.length-1);
      words.forEach((w,i)=>w.classList.toggle('word-playing', i===idx));
    };

    // Allow seeking by clicking progress bar
    const pb = document.getElementById('qpb-progress');
    if (pb){
      pb._seekHandler && pb.removeEventListener('input', pb._seekHandler);
      pb._seekHandler = ()=>{ if (au.duration) au.currentTime = (pb.value/100)*au.duration; };
      pb.addEventListener('input', pb._seekHandler);
    }

    au.src = urls[0];
    au.load();
    au.play().catch(()=>{});
  },

  playAudio(gNum){
    QuranBrowser.stopAll();
    QuranBrowser.playQueue = [gNum];
    QuranBrowser.loopRemain = QuranBrowser.loop === 0 ? Infinity : (QuranBrowser.loop || 1);
    QuranBrowser.playIndex = 0;
    QuranBrowser.playing = true;
    QuranBrowser.playNext();
    const pBtn = document.getElementById('btn-quran-pause');
    if (pBtn) pBtn.disabled = false;
    const sBtn = document.getElementById('btn-quran-stop');
    if (sBtn) sBtn.disabled = false;
  },

  /* ═══════════════════════════════════
     INLINE PRACTICE PANEL
  ═══════════════════════════════════ */
  _panelVerse: null,
  _panelRecorder: null,
  _panelChunks: [],
  _panelAudioCtx: null,
  _panelAnalyser: null,
  _panelAnimFrame: null,

  initPracticePanel(){
    document.getElementById('btn-qp-close')?.addEventListener('click', QuranBrowser.closePracticePanel);
    document.getElementById('btn-qp-studio')?.addEventListener('click', ()=>{
      const p = QuranBrowser._panelVerse;
      if (p) VoiceStudio.setPracticeVerse(p.surahNum, p.ayahNum, p.text, p.surahName, p.globalNum);
      App.showView('view-studio');
    });
    document.getElementById('btn-qp-listen')?.addEventListener('click', ()=>{
      const p = QuranBrowser._panelVerse;
      if (p) QuranBrowser.playAudio(p.globalNum);
    });
    document.getElementById('btn-qp-record')?.addEventListener('click', QuranBrowser.togglePanelRecording);
  },

  showPracticePanel(gNum){
    const info = QuranBrowser.ayahMap.get(gNum);
    if (!info) return toast('تعذّر تحميل بيانات الآية','error');
    QuranBrowser._panelVerse = info;
    const verseEl  = document.getElementById('qp-verse');
    const infoEl   = document.getElementById('qp-info');
    const resEl    = document.getElementById('qp-result');
    const spEl     = document.getElementById('qp-speech-area');
    const stEl     = document.getElementById('qp-status');
    // Set Arabic text via textContent (no entity issues)
    if (verseEl)  verseEl.textContent = info.text;
    if (infoEl)   infoEl.textContent  = `${info.surahName} — آية ${info.ayahNum}`;
    if (resEl)    resEl.innerHTML  = '';
    if (spEl)     spEl.innerHTML   = '';
    if (stEl)     stEl.textContent = '';
    // Reset record button
    const recBtn = document.getElementById('btn-qp-record');
    if (recBtn){ recBtn.textContent='🎙️ سجّل تلاوتك'; recBtn.classList.remove('recording'); }
    // Clear waveform
    const cv = document.getElementById('qp-waveform');
    if (cv){ const c=cv.getContext('2d'); cv.width=cv.offsetWidth||400; cv.height=56; c.clearRect(0,0,cv.width,56); }
    // Show panel
    const panel = document.getElementById('quran-practice-panel');
    if (panel){ panel.style.display='block'; panel.scrollIntoView({behavior:'smooth',block:'nearest'}); }
    // Quick speech check
    QuranBrowser.addPanelSpeechCheck(info);
  },

  closePracticePanel(){
    QuranBrowser.stopPanelRecording();
    const panel = document.getElementById('quran-practice-panel');
    if (panel) panel.style.display='none';
    QuranBrowser._panelVerse = null;
  },

  async togglePanelRecording(){
    if (QuranBrowser._panelRecorder && QuranBrowser._panelRecorder.state==='recording'){
      QuranBrowser._panelRecorder.stop();
      if (QuranBrowser._panelSpeechRec){ try{ QuranBrowser._panelSpeechRec.stop(); }catch(e){} QuranBrowser._panelSpeechRec=null; }
      return;
    }
    const btn = document.getElementById('btn-qp-record');
    const st  = document.getElementById('qp-status');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({audio:true});
      QuranBrowser._panelChunks = [];
      QuranBrowser._panelTranscript = '';
      // Detect best supported MIME type
      const mimeType = ['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/mp4'].find(t=>MediaRecorder.isTypeSupported(t)) || '';
      QuranBrowser._panelRecorder = new MediaRecorder(stream, mimeType ? {mimeType} : {});
      QuranBrowser._panelRecorder.ondataavailable = e=>{ if(e.data && e.data.size>0) QuranBrowser._panelChunks.push(e.data); };
      QuranBrowser._panelRecorder.onstop = async()=>{
        stream.getTracks().forEach(t=>t.stop());
        QuranBrowser.stopPanelWaveform();
        await QuranBrowser.onPanelRecordStop();
        if (btn){ btn.textContent='🎙️ سجّل مجدداً'; btn.classList.remove('recording'); }
        if (st) st.textContent='';
      };
      // Run SpeechRecognition simultaneously for auto-transcription
      QuranBrowser._panelSpeechRec = null;
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (SR && QuranBrowser._panelVerse){
        try {
          const sr = new SR();
          sr.lang='ar-SA'; sr.continuous=true; sr.interimResults=false;
          sr.onresult = ev=>{ QuranBrowser._panelTranscript += Array.from(ev.results).map(r=>r[0].transcript).join(' ') + ' '; };
          sr.onerror = ()=>{};
          sr.start();
          QuranBrowser._panelSpeechRec = sr;
        } catch(e){}
      }
      QuranBrowser.startPanelWaveform(stream);
      QuranBrowser._panelRecorder.start(100);
      if (btn){ btn.textContent='⏹ إيقاف التسجيل'; btn.classList.add('recording'); }
      if (st) st.textContent='🔴 يسجّل... اتلُ الآية بوضوح';
    } catch(e){ toast('تعذّر الوصول للميكروفون','error'); }
  },

  stopPanelRecording(){
    if (QuranBrowser._panelRecorder && QuranBrowser._panelRecorder.state==='recording') QuranBrowser._panelRecorder.stop();
    QuranBrowser.stopPanelWaveform();
  },

  startPanelWaveform(stream){
    const canvas = document.getElementById('qp-waveform');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    try {
      QuranBrowser._panelAudioCtx = new (window.AudioContext||window.webkitAudioContext)();
      QuranBrowser._panelAnalyser = QuranBrowser._panelAudioCtx.createAnalyser();
      QuranBrowser._panelAnalyser.fftSize = 512;
      const src = QuranBrowser._panelAudioCtx.createMediaStreamSource(stream);
      src.connect(QuranBrowser._panelAnalyser);
      const bufLen = QuranBrowser._panelAnalyser.frequencyBinCount;
      const dataArr = new Uint8Array(bufLen);
      const drawFrame = ()=>{
        QuranBrowser._panelAnimFrame = requestAnimationFrame(drawFrame);
        QuranBrowser._panelAnalyser.getByteFrequencyData(dataArr);
        const W=canvas.offsetWidth||400; const H=56;
        canvas.width=W; canvas.height=H;
        ctx.clearRect(0,0,W,H);
        const bw=W/bufLen*2;
        dataArr.forEach((v,i)=>{
          const h=(v/255)*H;
          const hue=160+v/2;
          ctx.fillStyle=`hsla(${hue},80%,58%,.92)`;
          ctx.fillRect(i*bw,H-h,Math.max(1,bw-1),h);
        });
      };
      drawFrame();
    } catch(e){}
  },

  stopPanelWaveform(){
    if (QuranBrowser._panelAnimFrame){ cancelAnimationFrame(QuranBrowser._panelAnimFrame); QuranBrowser._panelAnimFrame=null; }
    if (QuranBrowser._panelAudioCtx){ QuranBrowser._panelAudioCtx.close().catch(()=>{}); QuranBrowser._panelAudioCtx=null; }
    const canvas = document.getElementById('qp-waveform');
    if (canvas){ const c=canvas.getContext('2d'); c.clearRect(0,0,canvas.width,canvas.height); }
  },

  async onPanelRecordStop(){
    if (!QuranBrowser._panelChunks.length) return;
    const recMime = QuranBrowser._panelRecorder?.mimeType || 'audio/webm';
    const blob = new Blob(QuranBrowser._panelChunks, {type: recMime});
    const p = QuranBrowser._panelVerse;
    const url = URL.createObjectURL(blob);
    if (p) await Library.saveAudio(blob, `${p.surahName} · آية ${p.ayahNum}`);
    const resEl = document.getElementById('qp-result');
    if (!resEl) return;
    resEl.innerHTML=`<div style="margin-bottom:8px">
      <div style="font-size:.74rem;color:#34d399;margin-bottom:4px">✅ تسجيلك — استمع وقيّم:</div>
      <audio controls src="${url}" style="width:100%;height:36px;border-radius:8px;outline:none"></audio>
    </div>
    <div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:4px">
      ${[['5','🌟 ممتاز'],['4','✅ جيد جداً'],['3','👍 مقبول'],['2','🔄 ضعيف'],['1','↩️ أعد']].map(([sc,lb])=>`<button class="btn btn-sm btn-ghost qp-score-btn" data-s="${sc}">${lb}</button>`).join('')}
    </div>
    <div id="qp-score-fb" style="font-size:.8rem;color:#34d399;min-height:18px"></div>
    <div id="qp-auto-eval" style="margin-top:8px"><div style="font-size:.78rem;color:var(--text-3);padding:6px 0">⏳ جارٍ تحويل الصوت لنص (Whisper)...</div></div>`;
    resEl.querySelectorAll('.qp-score-btn').forEach(b=>b.onclick=()=>{
      resEl.querySelectorAll('.qp-score-btn').forEach(x=>x.classList.remove('active'));
      b.classList.add('active');
      const msgs={5:'رائع! انتقل للآية التالية 🌟',4:'جيد جداً! كرّر للتثبيت ✅',3:'جيد! ركّز على المخارج 👍',2:'استمع للنموذج ثم أعد 🔄',1:'استمع أولاً ثم ابدأ من جديد ↩️'};
      const fb=document.getElementById('qp-score-fb');
      if (fb) fb.textContent=msgs[b.dataset.s]||'';
      const sc=+b.dataset.s;
      if (p) {
        Api.post('/session/complete',{pages_done:.05,difficulty:sc>=4?'easy':sc>=2?'medium':'hard',duration_minutes:1,technique_used:'inline_practice',mood_score:Math.min(10,sc*2)}).catch(()=>{});
        Api.post('/studio/recording',{surah_name:p.surahName,ayah_num:p.ayahNum,global_num:p.globalNum,self_score:sc}).catch(()=>{});
      }
    });
    // Whisper STT transcription, then AI evaluation
    let transcript = (QuranBrowser._panelTranscript||'').trim();
    try {
      if (blob.size < 15*1024*1024){
        const audio_base64 = await blobToBase64(blob);
        const tr = await Api.post('/ai/transcribe',{audio_base64, mime_type:recMime});
        if (tr.transcript) transcript = tr.transcript;
      }
    } catch(e){}
    if (transcript && p) {
      try {
        const r = await Api.post('/ai/evaluate-recitation',{
          transcript, target_verse:p.text, surah_name:p.surahName, ayah_num:p.ayahNum
        });
        const sc = r.score ?? null;
        const col = sc!=null ? (sc>=80?'#34d399':sc>=55?'#fbbf24':'#ef4444') : '#34d399';
        const evalEl = document.getElementById('qp-auto-eval');
        if (evalEl) evalEl.innerHTML=`<div style="padding:10px 12px;background:rgba(52,211,153,.08);border:1px solid rgba(52,211,153,.22);border-radius:10px">
          <div style="font-size:.7rem;color:#34d399;margin-bottom:6px;font-weight:700;letter-spacing:.03em">🤖 تقييم Whisper + GPT تلقائي</div>
          <div style="font-size:.72rem;color:var(--text-3);margin-bottom:6px;font-style:italic">سُمع: "${escapeHTML((transcript||'').slice(0,100))}"</div>
          ${sc!=null?`<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
            <div style="flex:1;background:rgba(255,255,255,.08);border-radius:20px;height:8px;overflow:hidden">
              <div style="background:${col};height:100%;width:${sc}%;border-radius:20px;transition:width .8s ease"></div>
            </div>
            <span style="font-size:1.05rem;font-weight:900;color:${col};min-width:38px;text-align:center">${sc}%</span>
            <span style="font-size:.72rem;color:var(--text-2)">${sc>=85?'✨ ممتاز':sc>=70?'✅ جيد':sc>=50?'👍 مقبول':'🔄 كرّر'}</span>
          </div>`:''}
          <div style="font-size:.82rem;color:var(--text-1);line-height:1.7;white-space:pre-wrap">${escapeHTML(r.evaluation||r.reply||'')}</div>
        </div>`;
        Api.post('/studio/recording',{surah_name:p.surahName,ayah_num:p.ayahNum,global_num:p.globalNum,transcript,ai_score:r.score,ai_feedback:r.evaluation}).catch(()=>{});
        // Log recitation error to ErrorLogger for AI training data
        const accuracy = r.score ?? 0;
        if (accuracy < 80 && p){
          ErrorLogger.logRecitationError({
            surah_name: p.surahName||'', surah_number: p.surahNum||0,
            ayah_number: p.ayahNum||0, from_ayah: p.ayahNum||0, to_ayah: p.ayahNum||0,
            error_type: accuracy < 50 ? 'major_error' : 'minor_error',
            expected_text: p.text||'', actual_text: transcript||'',
            accuracy_pct: accuracy, ai_feedback: r.evaluation||'',
            method: 'whisper_gpt', session_id: `${p.surahNum}_${p.ayahNum}_${Date.now()}`
          });
        }
      } catch(e){
        ErrorLogger.logAiError('Evaluate recitation failed: ' + String(e?.message||e), { surah: p?.surahName, ayah: p?.ayahNum });
        const evalEl=document.getElementById('qp-auto-eval');
        if (evalEl) evalEl.innerHTML='<p style="font-size:.78rem;color:var(--text-3)">تعذّر التقييم</p>';
      }
    } else {
      const evalEl=document.getElementById('qp-auto-eval');
      if (evalEl) evalEl.innerHTML='<p style="font-size:.78rem;color:var(--text-3)">لم يُتعرَّف على الصوت — جرّب في مكان أهدأ</p>';
    }
    QuranBrowser.addPanelSpeechCheck(p);
  },

  addPanelSpeechCheck(p){
    const area = document.getElementById('qp-speech-area');
    if (!area || !p) return;
    area.innerHTML=`<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px">
      <button class="btn btn-xs btn-ghost" id="btn-qp-tts" style="font-size:.74rem;padding:3px 9px">🤖 اسمع AI</button>
      <button class="btn btn-xs btn-secondary" id="btn-qp-speech" style="font-size:.74rem;padding:3px 9px">🎤 تحقق آني</button>
    </div>
    <div id="qp-speech-result" style="margin-top:5px"></div>`;
    document.getElementById('btn-qp-tts')?.addEventListener('click', ()=>VoiceStudio._ttsSpeak(p.text,'btn-qp-tts'));
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR){ document.getElementById('btn-qp-speech')?.remove(); return; }
    document.getElementById('btn-qp-speech').onclick=()=>{
      const btn=document.getElementById('btn-qp-speech');
      const res=document.getElementById('qp-speech-result');
      const rec=new SR();
      rec.lang='ar-SA'; rec.continuous=false; rec.interimResults=false;
      btn.textContent='🔴 يستمع...'; btn.disabled=true;
      rec.onresult=ev=>{
        const t=Array.from(ev.results).map(r=>r[0].transcript).join(' ').trim();
        const pct=Math.round(VoiceStudio.similarity(t,p.text)*100);
        const col=pct>=80?'#34d399':pct>=55?'#fbbf24':'#ef4444';
        if (res) res.innerHTML=`<div style="display:flex;align-items:center;gap:8px;padding:5px 10px;background:rgba(0,0,0,.3);border-radius:8px">
          <div style="flex:1;background:rgba(255,255,255,.08);border-radius:20px;height:7px;overflow:hidden">
            <div style="background:${col};height:100%;width:${pct}%;border-radius:20px;transition:width .6s"></div>
          </div>
          <span style="font-size:1.15rem;font-weight:900;color:${col};min-width:40px">${pct}%</span>
          <span style="font-size:.72rem;color:var(--text-2)">${pct>=85?'✨ ممتاز':pct>=70?'✅ جيد':pct>=50?'👍 مقبول':'🔄 كرّر'}</span>
        </div>`;
        btn.textContent='🎤 أعد التحقق'; btn.disabled=false;
      };
      rec.onerror=()=>{ btn.textContent='❌ فشل — أعد'; btn.disabled=false; };
      rec.onend=()=>{ if(btn.disabled){ btn.textContent='🎤 تحقق آني'; btn.disabled=false; } };
      rec.start();
    };
  }
};

/* ══════════════════════════════════════════════
   VOICE STUDIO  (Web Speech API + waveform canvas)
══════════════════════════════════════════════ */
const VoiceStudio = {
  practiceVerse: null,
  recorder: null,
  chunks: [],
  audioCtx: null,
  analyser: null,
  animFrame: null,
  setPracticeVerse(surahNum, ayahNum, text, surahName, globalNum){
    VoiceStudio.practiceVerse = { surahNum, ayahNum, text, surahName, globalNum: globalNum||null };
  },
  async load(){
    const surahs = await QuranBrowser.loadSurahs();
    const sel = document.getElementById('studio-surah');
    if (sel && sel.options.length <= 1 && surahs.length){
      surahs.forEach(s=>{
        const o = document.createElement('option');
        o.value = s.number; o.textContent = `${s.number}. ${s.name}`;
        sel.appendChild(o);
      });
    }
    // Populate range surah picker
    const rangeSel = document.getElementById('studio-range-surah');
    if (rangeSel && rangeSel.options.length <= 1 && surahs.length){
      surahs.forEach(s=>{
        const o = document.createElement('option');
        o.value = s.number; o.textContent = `${s.number}. ${s.name}`;
        rangeSel.appendChild(o);
      });
    }
    const loadBtn = document.getElementById('btn-studio-load');
    if (loadBtn) loadBtn.onclick = VoiceStudio.loadVerse;
    const recBtn = document.getElementById('btn-studio-record');
    if (recBtn) recBtn.onclick = VoiceStudio.toggleRecord;
    document.getElementById('btn-studio-range-load')?.addEventListener('click', VoiceStudio.loadRange);
    document.getElementById('btn-studio-range-record')?.addEventListener('click', VoiceStudio.toggleRangeRecord);
    if (VoiceStudio.practiceVerse) VoiceStudio.showVerse();
    await VoiceStudio.loadProgressChart();
    await VoiceStudio.loadRecordings();
  },
  async loadVerse(){
    const surahNum = +(document.getElementById('studio-surah')?.value||0);
    const ayahNum = +(document.getElementById('studio-ayah')?.value||1);
    if (!surahNum) return toast('اختر سورة','error');
    const st = document.getElementById('studio-rec-status');
    if (st) st.textContent='⏳ جارٍ تحميل الآية…';
    try {
      const r = await fetch(`${API}/quran/surah/${surahNum}`);
      const d = await r.json();
      const surahData = d.data;
      if (!surahData?.ayahs){ if(st) st.textContent=''; return toast('خطأ في تحميل السورة','error'); }
      const ayah = surahData.ayahs.find(a=>a.numberInSurah===ayahNum);
      if (!ayah){ if(st) st.textContent=''; return toast('رقم الآية خارج النطاق','error'); }
      const surah = QuranBrowser.surahs.find(s=>s.number===surahNum);
      VoiceStudio.practiceVerse = { surahNum, ayahNum, text:ayah.text, surahName:surah?.name||`سورة ${surahNum}`, globalNum:ayah.number };
      VoiceStudio.showVerse();
      if (st) st.textContent='';
    } catch(e){ if(st) st.textContent=''; toast('خطأ في تحميل الآية','error'); }
  },
  showVerse(){
    const p = VoiceStudio.practiceVerse;
    if (!p) return;
    const el = document.getElementById('studio-verse-display');
    const res = document.getElementById('studio-result');
    if (el){
      el.style.display='block';
      el.innerHTML=`<div class="glass-card pad" style="border:1px solid rgba(52,211,153,.35);margin-bottom:4px">
        <div style="font-size:.72rem;color:#34d399;margin-bottom:4px">🎯 الآية المستهدفة</div>
        <div style="font-size:.78rem;color:var(--text-3);margin-bottom:10px">${escapeHTML(p.surahName)} · الآية ${p.ayahNum}</div>
        <div dir="rtl" style="font-size:1.6rem;line-height:2.6;text-align:justify;color:var(--gold);font-family:'Amiri Quran','Amiri','Scheherazade New',serif">${escapeHTML(p.text)}</div>
        <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;justify-content:center">
          ${p.globalNum?`<button class="btn btn-sm btn-ghost" onclick="QuranBrowser.playAudio(${p.globalNum})">🔊 استمع للشيخ</button>`:''}
          <button class="btn btn-sm btn-ghost" id="btn-verse-tts">🤖 اسمع صوت AI</button>
        </div>
      </div>`;
      document.getElementById('btn-verse-tts')?.addEventListener('click', ()=>VoiceStudio._ttsSpeak(p.text,'btn-verse-tts'));
    }
    if (res) res.style.display='none';
    if (p.surahNum){ const s2=document.getElementById('studio-surah'); if(s2&&s2.options.length>1) s2.value=p.surahNum; }
    if (p.ayahNum){ const ai=document.getElementById('studio-ayah'); if(ai) ai.value=p.ayahNum; }
  },

  async _ttsSpeak(text, btnId){
    const btn = btnId ? document.getElementById(btnId) : null;
    if (btn){ btn._orig=btn.textContent; btn.disabled=true; btn.textContent='⏳...'; }
    try {
      const resp = await fetch('/qqc/ai/tts',{
        method:'POST',
        headers:{'Content-Type':'application/json','x-token':S.token,'x-username':S.username},
        body:JSON.stringify({text})
      });
      if (resp.ok){
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const au = new Audio(url);
        au.play();
        au.onended=()=>URL.revokeObjectURL(url);
        if (btn){ btn.disabled=false; btn.textContent='🤖 أعد الاستماع'; }
        return;
      }
    } catch(e){}
    // Fallback: browser built-in TTS
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang='ar-SA'; u.rate=0.8; u.pitch=1.05;
    window.speechSynthesis.speak(u);
    if (btn){ btn.disabled=false; btn.textContent=btn._orig||'🔊 أعد'; }
  },
  async toggleRecord(){
    if (VoiceStudio.recorder && VoiceStudio.recorder.state==='recording'){
      VoiceStudio.recorder.stop(); VoiceStudio.stopWaveform();
      if (VoiceStudio._speechRec){ try{ VoiceStudio._speechRec.stop(); }catch(e){} VoiceStudio._speechRec=null; }
      return;
    }
    if (!VoiceStudio.practiceVerse) return toast('حدّد آية للتدرب عليها أولاً','error');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({audio:true});
      VoiceStudio.chunks = [];
      VoiceStudio._speechTranscript = '';
      // Detect best supported MIME type
      const mimeType = ['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/mp4'].find(t=>MediaRecorder.isTypeSupported(t)) || '';
      VoiceStudio.recorder = new MediaRecorder(stream, mimeType ? {mimeType} : {});
      VoiceStudio.recorder.ondataavailable = e=>{ if(e.data && e.data.size>0) VoiceStudio.chunks.push(e.data); };
      VoiceStudio.recorder.onstop = async()=>{ stream.getTracks().forEach(t=>t.stop()); await VoiceStudio.onRecordStop(); };
      // Run SpeechRecognition simultaneously for auto-transcription
      VoiceStudio._speechRec = null;
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (SR && VoiceStudio.practiceVerse){
        try {
          const sr = new SR();
          sr.lang='ar-SA'; sr.continuous=true; sr.interimResults=false;
          sr.onresult = ev=>{ VoiceStudio._speechTranscript += Array.from(ev.results).map(r=>r[0].transcript).join(' ') + ' '; };
          sr.onerror = ()=>{};
          sr.start();
          VoiceStudio._speechRec = sr;
        } catch(e){}
      }
      VoiceStudio.startWaveform(stream);
      VoiceStudio.recorder.start(100);
      const btn = document.getElementById('btn-studio-record');
      if (btn){ btn.textContent='⏹️ إيقاف التسجيل'; btn.classList.add('recording'); }
      const st = document.getElementById('studio-rec-status');
      if (st) st.textContent='🔴 يسجّل... اتلُ الآية بوضوح';
    } catch(e){ toast('لا يمكن الوصول للميكروفون — تحقق الإذن','error'); }
  },
  startWaveform(stream){
    const canvas = document.getElementById('studio-waveform');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    try {
      VoiceStudio.audioCtx = new (window.AudioContext||window.webkitAudioContext)();
      VoiceStudio.analyser = VoiceStudio.audioCtx.createAnalyser();
      VoiceStudio.analyser.fftSize = 256;
      const src = VoiceStudio.audioCtx.createMediaStreamSource(stream);
      src.connect(VoiceStudio.analyser);
      const bufLen = VoiceStudio.analyser.frequencyBinCount;
      const data = new Uint8Array(bufLen);
      function draw(){
        VoiceStudio.animFrame = requestAnimationFrame(draw);
        VoiceStudio.analyser.getByteFrequencyData(data);
        const W = canvas.offsetWidth||800; const H = canvas.offsetHeight||80;
        canvas.width=W; canvas.height=H;
        ctx.clearRect(0,0,W,H);
        const bw = W / bufLen * 2.2;
        data.forEach((v,i)=>{
          const h=(v/255)*H;
          const hue = 180 + v/3;
          ctx.fillStyle=`hsla(${hue},75%,58%,.9)`;
          ctx.fillRect(i*bw, H-h, Math.max(1,bw-1), h);
        });
      }
      draw();
    } catch(e){ console.warn('Waveform unavailable',e); }
  },
  stopWaveform(){
    if (VoiceStudio.animFrame){ cancelAnimationFrame(VoiceStudio.animFrame); VoiceStudio.animFrame=null; }
    if (VoiceStudio.audioCtx){ VoiceStudio.audioCtx.close().catch(()=>{}); VoiceStudio.audioCtx=null; }
    const canvas = document.getElementById('studio-waveform');
    if (canvas){
      const c=canvas.getContext('2d');
      canvas.width=canvas.offsetWidth||800; canvas.height=canvas.offsetHeight||80;
      c.clearRect(0,0,canvas.width,canvas.height);
    }
  },
  async onRecordStop(){
    const btn = document.getElementById('btn-studio-record');
    if (btn){ btn.textContent='🎙️ ابدأ التسجيل'; btn.classList.remove('recording'); }
    const st = document.getElementById('studio-rec-status');
    if (st) st.textContent='';
    if (!VoiceStudio.chunks.length) return;
    const recMime = VoiceStudio.recorder?.mimeType || 'audio/webm';
    const blob = new Blob(VoiceStudio.chunks, {type: recMime});
    const p = VoiceStudio.practiceVerse;
    const label = p ? `${p.surahName} · آية ${p.ayahNum}` : 'تسجيل';
    await Library.saveAudio(blob, label);
    const url = URL.createObjectURL(blob);
    const res = document.getElementById('studio-result');
    if (res){
      res.style.display='block';
      res.innerHTML=`<div class="glass-card pad studio-result-card">
        <div style="font-size:.85rem;color:#34d399;margin-bottom:10px;font-weight:700">✅ تسجيلك — استمع وقيّم نفسك</div>
        <audio controls src="${url}" style="width:100%;border-radius:8px;margin-bottom:14px;outline:none"></audio>
        <div style="font-size:.82rem;color:var(--text-2);margin-bottom:8px">⭐ قيّم أداءك يدوياً:</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">
          ${[['5','ممتاز 🌟'],['4','جيد جداً ✅'],['3','جيد 👍'],['2','يحتاج تحسين 🔄'],['1','ابدأ من جديد ↩️']].map(([sc,lb])=>`<button class="btn btn-sm btn-ghost studio-self-score" data-score="${sc}">${lb}</button>`).join('')}
        </div>
        <div id="studio-feedback"></div>
        <div id="studio-auto-eval" style="margin-top:12px"><div style="font-size:.8rem;color:var(--text-3);padding:8px 0">⏳ جارٍ تحويل صوتك لنص بدقة عالية (Whisper)...</div></div>
        <div id="studio-speech-area" style="margin-top:12px"></div>
      </div>`;
      res.querySelectorAll('.studio-self-score').forEach(b=>b.onclick=async()=>{
        res.querySelectorAll('.studio-self-score').forEach(x=>x.classList.remove('active'));
        b.classList.add('active');
        const score=+b.dataset.score;
        const msgs={5:'رائع! احتفظ بهذا المستوى وانتقل للآية التالية 🌟',4:'جيد جداً! كرّر لتثبيت الحفظ ✅',3:'جيد! ركّز على مخارج الحروف 👍',2:'تحسّن — استمع للنموذج ثم أعد 🔄',1:'لا تيأس! استمع للآية مرات أولاً ↩️'};
        const fb=document.getElementById('studio-feedback');
        if (fb) fb.innerHTML=`<div style="padding:10px 12px;background:rgba(52,211,153,.1);border-radius:8px;color:#34d399;font-size:.88rem">${msgs[score]||''}</div>`;
        if (p) Api.post('/session/complete',{pages_done:.05,difficulty:score>=4?'easy':score>=2?'medium':'hard',duration_minutes:1,technique_used:'recitation_studio',mood_score:Math.min(10,score*2)}).catch(()=>{});
      });
      // Whisper STT transcription, then AI evaluation
      let transcript = (VoiceStudio._speechTranscript||'').trim();
      let audio_base64 = null;
      try {
        if (blob.size < 15*1024*1024){
          audio_base64 = await blobToBase64(blob);
          const tr = await Api.post('/ai/transcribe',{audio_base64, mime_type:recMime});
          if (tr.transcript) transcript = tr.transcript;
        }
      } catch(e){}
      if (transcript && p) {
        let aiScore = null;
        try {
          const r = await Api.post('/ai/evaluate-recitation',{
            transcript, target_verse:p.text, surah_name:p.surahName, ayah_num:p.ayahNum
          });
          aiScore = r.score ?? null;
          const sc = aiScore;
          const col = sc!=null ? (sc>=80?'#34d399':sc>=55?'#fbbf24':'#ef4444') : '#34d399';
          const autoEl = document.getElementById('studio-auto-eval');
          if (autoEl) autoEl.innerHTML=`<div style="padding:14px;background:rgba(52,211,153,.08);border:1px solid rgba(52,211,153,.22);border-radius:12px">
            <div style="font-size:.72rem;color:#34d399;margin-bottom:10px;font-weight:700;letter-spacing:.03em">🤖 تقييم ذكي تلقائي (Whisper + GPT)</div>
            <div style="font-size:.75rem;color:var(--text-3);margin-bottom:8px;font-style:italic">سُمع: "${escapeHTML((transcript||'').slice(0,120))}"</div>
            ${sc!=null?`<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
              <div style="flex:1;background:rgba(255,255,255,.08);border-radius:20px;height:10px;overflow:hidden">
                <div style="background:${col};height:100%;width:${sc}%;border-radius:20px;transition:width .9s ease"></div>
              </div>
              <span style="font-size:1.3rem;font-weight:900;color:${col};min-width:44px;text-align:center">${sc}%</span>
              <span style="font-size:.8rem;color:var(--text-2)">${sc>=85?'✨ ممتاز!':sc>=70?'✅ جيد جداً':sc>=50?'👍 مقبول':'🔄 راجع وكرر'}</span>
            </div>`:''}
            <div style="font-size:.88rem;color:var(--text-1);line-height:1.75;white-space:pre-wrap">${escapeHTML(r.evaluation||r.reply||'')}</div>
          </div>`;
          Api.post('/studio/recording',{surah_name:p.surahName,ayah_num:p.ayahNum,global_num:p.globalNum,transcript,ai_score:r.score,ai_feedback:r.evaluation}).catch(()=>{});
          // Auto-save training sample (audio + correct text + score)
          if (audio_base64) {
            Api.post('/ai/save-training',{
              audio_base64, mime_type:recMime,
              correct_text:p.text, transcript,
              score:r.score, surah_name:p.surahName, ayah_num:p.ayahNum
            }).catch(()=>{});
          }
        } catch(e){
          const autoEl=document.getElementById('studio-auto-eval');
          if (autoEl) autoEl.innerHTML='<p style="font-size:.82rem;color:var(--text-3)">تعذّر التقييم التلقائي</p>';
        }
      } else {
        const autoEl=document.getElementById('studio-auto-eval');
        if (autoEl) autoEl.innerHTML='<p style="font-size:.82rem;color:var(--text-3)">لم يُتعرَّف على الصوت — جرّب في مكان أهدأ</p>';
      }
      VoiceStudio.addSpeechCheck(p);
    }
    await VoiceStudio.loadRecordings();
  },
  addSpeechCheck(p){
    const area = document.getElementById('studio-speech-area');
    if (!area || !p) return;
    area.innerHTML = `
      <div style="border-top:1px solid var(--border);padding-top:12px;margin-top:4px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <button class="btn btn-sm btn-ghost" id="btn-studio-tts">🤖 اسمع الآية بصوت AI</button>
        <button class="btn btn-sm btn-secondary" id="btn-speech-recheck">🎤 تحقق صوتي آني</button>
      </div>
      <div id="speech-result" style="margin-top:8px"></div>`;
    document.getElementById('btn-studio-tts')?.addEventListener('click', ()=>VoiceStudio._ttsSpeak(p.text,'btn-studio-tts'));
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recheckBtn = document.getElementById('btn-speech-recheck');
    if (!SR || !recheckBtn){ recheckBtn?.remove(); return; }
    recheckBtn.onclick = ()=>{
      const btn=document.getElementById('btn-speech-recheck');
      const resultEl=document.getElementById('speech-result');
      const rec=new SR();
      rec.lang='ar-SA'; rec.continuous=false; rec.interimResults=false;
      btn.textContent='🔴 يستمع...'; btn.disabled=true;
      rec.onresult=ev=>{
        const t=Array.from(ev.results).map(r=>r[0].transcript).join(' ').trim();
        const pct=Math.round(VoiceStudio.similarity(t,p.text)*100);
        const col=pct>=80?'#34d399':pct>=55?'#fbbf24':'#ef4444';
        if(resultEl) resultEl.innerHTML=`<div style="padding:12px;background:rgba(0,0,0,.25);border-radius:10px">
          <div style="font-size:.72rem;color:var(--text-3);margin-bottom:4px">سمعت:</div>
          <div style="font-size:.82rem;color:var(--text-2);margin-bottom:8px;font-style:italic">"${escapeHTML(t)}"</div>
          <div style="background:rgba(255,255,255,.08);border-radius:20px;height:10px;overflow:hidden;margin-bottom:8px">
            <div style="background:${col};height:100%;width:${pct}%;border-radius:20px;transition:width .6s"></div>
          </div>
          <div style="display:flex;justify-content:space-between">
            <span style="font-size:1.3rem;font-weight:900;color:${col}">${pct}%</span>
            <span style="font-size:.8rem;color:var(--text-2)">${pct>=85?'✨ ممتاز!':pct>=70?'✅ جيد جداً':pct>=50?'👍 مقبول':'🔄 راجع وكرر'}</span>
          </div>
        </div>`;
        btn.textContent='🎤 أعد التحقق'; btn.disabled=false;
      };
      rec.onerror=()=>{btn.textContent='❌ فشل';btn.disabled=false;};
      rec.onend=()=>{if(btn.disabled){btn.textContent='🎤 تحقق';btn.disabled=false;}};
      rec.start();
    };
  },
  similarity(a,b){
    const norm=s=>s.replace(/[\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED]/g,'').replace(/\s+/g,' ').trim();
    a=norm(a); b=norm(b);
    if (!a||!b) return 0;
    const wa=a.split(' '); const wb=b.split(' ');
    let hits=0;
    wa.forEach(w=>{ if(wb.some(bw=>bw===w||bw.includes(w)||w.includes(bw))) hits++; });
    return Math.min(1, hits/Math.max(wa.length,wb.length));
  },
  async loadProgressChart(){
    // Fetch studio history from server
    let history = [];
    try { const r = await Api.get('/studio/progress'); history = r.history || []; } catch(e){}
    const wrap = document.getElementById('studio-progress-wrap');
    if (!history.length){ if(wrap) wrap.style.display='none'; return; }
    if (wrap) wrap.style.display='block';
    const countEl = document.getElementById('studio-progress-count');
    if (countEl) countEl.textContent = `${history.length} جلسة تدريبية`;

    // Draw chart on canvas
    const canvas = document.getElementById('studio-progress-chart');
    if (!canvas) return;
    const W = canvas.offsetWidth||400; const H = 90;
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0,0,W,H);

    // Background grid
    ctx.strokeStyle='rgba(255,255,255,.05)'; ctx.lineWidth=1;
    [0,25,50,75,100].forEach(v=>{
      const y=H-(v/100)*H*0.9-4;
      ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke();
      if(v>0){ ctx.fillStyle='rgba(255,255,255,.18)'; ctx.font='9px Tajawal,sans-serif'; ctx.fillText(`${v}%`,W-24,y-2); }
    });

    // Smooth line
    const pts = history.filter(h=>h.score!=null).slice(-40);
    if (pts.length>=2){
      const xStep = W/(pts.length-1);
      const toY = s=>H-(s/100)*H*0.9-4;
      // Gradient fill
      const grad = ctx.createLinearGradient(0,0,0,H);
      grad.addColorStop(0,'rgba(52,211,153,.35)');
      grad.addColorStop(1,'rgba(52,211,153,0)');
      ctx.beginPath();
      ctx.moveTo(0,toY(pts[0].score));
      for(let i=1;i<pts.length;i++){
        const cpx=(i-.5)*xStep;
        ctx.bezierCurveTo(cpx,toY(pts[i-1].score),(i-.5)*xStep,toY(pts[i].score),i*xStep,toY(pts[i].score));
      }
      ctx.lineTo((pts.length-1)*xStep,H); ctx.lineTo(0,H); ctx.closePath();
      ctx.fillStyle=grad; ctx.fill();
      // Line
      ctx.beginPath();
      ctx.moveTo(0,toY(pts[0].score));
      for(let i=1;i<pts.length;i++){
        const cpx=(i-.5)*xStep;
        ctx.bezierCurveTo(cpx,toY(pts[i-1].score),(i-.5)*xStep,toY(pts[i].score),i*xStep,toY(pts[i].score));
      }
      ctx.strokeStyle='#34d399'; ctx.lineWidth=2.2; ctx.stroke();
      // Dots
      pts.forEach((pt,i)=>{
        const x=i*xStep; const y=toY(pt.score);
        ctx.beginPath(); ctx.arc(x,y,3,0,Math.PI*2);
        ctx.fillStyle=pt.score>=80?'#34d399':pt.score>=55?'#fbbf24':'#ef4444'; ctx.fill();
      });
    }

    // Summary stats
    const scores = history.filter(h=>h.score!=null).map(h=>h.score);
    const avg = scores.length ? Math.round(scores.reduce((a,b)=>a+b,0)/scores.length) : 0;
    const best = scores.length ? Math.max(...scores) : 0;
    const recent = scores.slice(-5);
    const trend = recent.length>1 ? (recent[recent.length-1]-recent[0]>0?'📈 تحسّن':recent[recent.length-1]-recent[0]<0?'📉 راجع':'➡️ ثابت') : '';
    const sumEl = document.getElementById('studio-progress-summary');
    if (sumEl) sumEl.innerHTML=[
      `<div class="progress-stat"><div class="progress-stat-val">${avg}%</div><div class="progress-stat-lbl">متوسط الدقة</div></div>`,
      `<div class="progress-stat"><div class="progress-stat-val" style="color:#fbbf24">${best}%</div><div class="progress-stat-lbl">أفضل نتيجة</div></div>`,
      `<div class="progress-stat"><div class="progress-stat-val">${history.length}</div><div class="progress-stat-lbl">جلسة</div></div>`,
      trend?`<div class="progress-stat"><div class="progress-stat-val">${trend}</div><div class="progress-stat-lbl">الاتجاه</div></div>`:''
    ].join('');
  },

  // ── RANGE RECORDING (سورة/صفحة/نطاق كامل) ──
  _rangeAyahs: [],
  _rangeRecorder: null,
  _rangeChunks: [],
  _rangeSpeechRec: null,
  _rangeSpeechTranscript: '',
  _rangeAnimFrame: null,
  _rangeAudioCtx: null,

  async loadRange(){
    const surahNum = +(document.getElementById('studio-range-surah')?.value||0);
    const fromA = +(document.getElementById('studio-range-from')?.value||0);
    const toA   = +(document.getElementById('studio-range-to')?.value||0);
    if (!surahNum) return toast('اختر سورة','error');
    const st   = document.getElementById('studio-range-status');
    const disp = document.getElementById('studio-range-display');
    if (st) st.textContent='⏳ جارٍ تحميل الآيات...';
    try {
      const r = await fetch(`${API}/quran/surah/${surahNum}`);
      const d = await r.json();
      if (!d.data?.ayahs){ if(st) st.textContent=''; return toast('خطأ في التحميل','error'); }
      let ayahs = d.data.ayahs;
      if (fromA) ayahs = ayahs.filter(a=>a.numberInSurah>=fromA);
      if (toA)   ayahs = ayahs.filter(a=>a.numberInSurah<=toA);
      VoiceStudio._rangeAyahs = ayahs.map(a=>({...a, surahName:d.data.name}));
      if (disp) disp.innerHTML=`<div class="glass-card pad" style="border:1px solid rgba(52,211,153,.3);margin-bottom:8px">
        <div style="font-size:.75rem;color:#34d399;margin-bottom:6px">${d.data.name} · آيات ${ayahs[0]?.numberInSurah||1}–${ayahs[ayahs.length-1]?.numberInSurah||1} (${ayahs.length} آية)</div>
        <div dir="rtl" style="font-family:'Amiri Quran','Amiri','Scheherazade New',serif;font-size:1.4rem;line-height:2.6;text-align:justify;color:var(--gold)">
          ${ayahs.map(a=>`${escapeHTML(a.text)}<span style="font-size:.72em;color:rgba(245,158,11,.65);vertical-align:super;margin:0 4px">﴿${a.numberInSurah}﴾</span>`).join(' ')}
        </div>
      </div>`;
      const recBtn=document.getElementById('btn-studio-range-record');
      if (recBtn) recBtn.style.display='inline-flex';
      if (st) st.textContent='';
    } catch(e){ if(st) st.textContent='خطأ في التحميل'; }
  },

  async toggleRangeRecord(){
    if (VoiceStudio._rangeRecorder && VoiceStudio._rangeRecorder.state==='recording'){
      VoiceStudio._rangeRecorder.stop();
      if (VoiceStudio._rangeSpeechRec){ try{VoiceStudio._rangeSpeechRec.stop();}catch(e){} VoiceStudio._rangeSpeechRec=null; }
      return;
    }
    if (!VoiceStudio._rangeAyahs.length) return toast('حمّل آيات النطاق أولاً','error');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({audio:true});
      VoiceStudio._rangeChunks=[];
      VoiceStudio._rangeSpeechTranscript='';
      const mimeType=['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/mp4'].find(t=>MediaRecorder.isTypeSupported(t))||'';
      VoiceStudio._rangeRecorder = new MediaRecorder(stream, mimeType?{mimeType}:{});
      VoiceStudio._rangeRecorder.ondataavailable=e=>{if(e.data&&e.data.size>0)VoiceStudio._rangeChunks.push(e.data);};
      VoiceStudio._rangeRecorder.onstop=async()=>{stream.getTracks().forEach(t=>t.stop());await VoiceStudio.onRangeRecordStop();};
      const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
      if (SR){ try{const sr=new SR();sr.lang='ar-SA';sr.continuous=true;sr.interimResults=false;sr.onresult=ev=>{VoiceStudio._rangeSpeechTranscript+=Array.from(ev.results).map(r=>r[0].transcript).join(' ')+' ';};sr.onerror=()=>{};sr.start();VoiceStudio._rangeSpeechRec=sr;}catch(e){} }
      // Waveform
      const canvas=document.getElementById('studio-range-waveform');
      if (canvas){canvas.style.display='block';try{
        VoiceStudio._rangeAudioCtx=new(window.AudioContext||window.webkitAudioContext)();
        const an=VoiceStudio._rangeAudioCtx.createAnalyser();an.fftSize=256;
        VoiceStudio._rangeAudioCtx.createMediaStreamSource(stream).connect(an);
        const buf=new Uint8Array(an.frequencyBinCount);
        const ctx=canvas.getContext('2d');
        (function draw(){VoiceStudio._rangeAnimFrame=requestAnimationFrame(draw);an.getByteFrequencyData(buf);const W=canvas.offsetWidth||400,H=60;canvas.width=W;canvas.height=H;ctx.clearRect(0,0,W,H);const bw=W/buf.length*2.2;buf.forEach((v,i)=>{const h=(v/255)*H;ctx.fillStyle=`hsla(${160+v/3},75%,58%,.9)`;ctx.fillRect(i*bw,H-h,Math.max(1,bw-1),h);});})();
      }catch(e){}}
      VoiceStudio._rangeRecorder.start(100);
      const btn=document.getElementById('btn-studio-range-record');
      if(btn){btn.textContent='⏹ إيقاف التسجيل';btn.style.background='rgba(239,68,68,.2)';btn.style.borderColor='#ef4444';}
      const st=document.getElementById('studio-range-status');
      if(st) st.textContent='🔴 يسجّل... اتلُ جميع الآيات بوضوح وترتيل';
    } catch(e){ toast('لا يمكن الوصول للميكروفون','error'); }
  },

  async onRangeRecordStop(){
    const btn=document.getElementById('btn-studio-range-record');
    if(btn){btn.textContent='🎙️ سجّل النطاق كاملاً';btn.style.background='';btn.style.borderColor='';}
    if(VoiceStudio._rangeAnimFrame){cancelAnimationFrame(VoiceStudio._rangeAnimFrame);VoiceStudio._rangeAnimFrame=null;}
    if(VoiceStudio._rangeAudioCtx){VoiceStudio._rangeAudioCtx.close().catch(()=>{});VoiceStudio._rangeAudioCtx=null;}
    const st=document.getElementById('studio-range-status');
    if(st) st.textContent='';
    if (!VoiceStudio._rangeChunks.length) return;
    const recMime=VoiceStudio._rangeRecorder?.mimeType||'audio/webm';
    const blob=new Blob(VoiceStudio._rangeChunks,{type:recMime});
    const ayahs=VoiceStudio._rangeAyahs;
    const fullText=ayahs.map(a=>a.text).join(' ');
    const surahName=ayahs[0]?.surahName||'سورة';
    const fromA=ayahs[0]?.numberInSurah||1;
    const toA=ayahs[ayahs.length-1]?.numberInSurah||1;
    const label=`${surahName} آيات ${fromA}–${toA}`;
    await Library.saveAudio(blob, label);
    const url=URL.createObjectURL(blob);
    const resEl=document.getElementById('studio-range-result');
    if(resEl) resEl.innerHTML=`<div class="glass-card pad studio-result-card">
      <div style="font-size:.85rem;color:#34d399;margin-bottom:10px;font-weight:700">✅ تسجيل النطاق — ${escapeHTML(label)}</div>
      <audio controls src="${url}" style="width:100%;border-radius:8px;margin-bottom:14px;outline:none"></audio>
      <div id="range-auto-eval"><div style="font-size:.8rem;color:var(--text-3)">⏳ جارٍ تحويل الصوت لنص بدقة عالية (Whisper)...</div></div>
    </div>`;
    let transcript=(VoiceStudio._rangeSpeechTranscript||'').trim();
    try {
      if(blob.size<15*1024*1024){
        const audio_base64=await blobToBase64(blob);
        const tr=await Api.post('/ai/transcribe',{audio_base64,mime_type:recMime});
        if(tr.transcript) transcript=tr.transcript;
      }
    }catch(e){}
    const evalEl=document.getElementById('range-auto-eval');
    if (!transcript){ if(evalEl) evalEl.innerHTML='<p style="color:var(--text-3);font-size:.82rem">لم يُتعرَّف على الصوت — جرّب في مكان أهدأ</p>'; await VoiceStudio.loadRecordings(); return; }
    try {
      const r=await Api.post('/ai/evaluate-recitation',{transcript,target_verse:fullText.slice(0,1000),surah_name:surahName,ayah_num:fromA});
      const sc=r.score??null;
      const col=sc!=null?(sc>=80?'#34d399':sc>=55?'#fbbf24':'#ef4444'):'#34d399';
      if(evalEl) evalEl.innerHTML=`<div style="padding:14px;background:rgba(52,211,153,.08);border:1px solid rgba(52,211,153,.22);border-radius:12px">
        <div style="font-size:.72rem;color:#34d399;margin-bottom:10px;font-weight:700">🤖 تقييم ذكي للنطاق كاملاً (Whisper + GPT)</div>
        <div style="font-size:.75rem;color:var(--text-3);margin-bottom:8px;font-style:italic">سُمع: "${escapeHTML((transcript||'').slice(0,150))}..."</div>
        ${sc!=null?`<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
          <div style="flex:1;background:rgba(255,255,255,.08);border-radius:20px;height:10px;overflow:hidden">
            <div style="background:${col};height:100%;width:${sc}%;border-radius:20px;transition:width .9s ease"></div>
          </div>
          <span style="font-size:1.3rem;font-weight:900;color:${col}">${sc}%</span>
          <span style="font-size:.8rem;color:var(--text-2)">${sc>=85?'✨ ممتاز!':sc>=70?'✅ جيد':sc>=50?'👍 مقبول':'🔄 راجع'}</span>
        </div>`:''}
        <div style="font-size:.88rem;color:var(--text-1);line-height:1.75;white-space:pre-wrap">${escapeHTML(r.evaluation||r.reply||'')}</div>
      </div>`;
      Api.post('/studio/recording',{surah_name:surahName,ayah_num:fromA,transcript,ai_score:r.score,ai_feedback:r.evaluation}).catch(()=>{});
    }catch(e){
      if(evalEl) evalEl.innerHTML='<p style="color:#ef4444;font-size:.82rem">تعذّر التقييم، حاول مرة أخرى</p>';
    }
    await VoiceStudio.loadRecordings();
  },

  async loadRecordings(){
    const el = document.getElementById('studio-recordings-list');
    if (!el) return;
    const audios = await Library.listAudio();
    if (!audios.length){ el.innerHTML='<p style="color:var(--text-3);font-size:.85rem;padding:10px 0">لا تسجيلات تدريبية بعد — ابدأ التسجيل أعلاه!</p>'; return; }
    el.innerHTML=audios.slice().reverse().slice(0,25).map(a=>{
      const url=URL.createObjectURL(a.blob);
      return `<div class="glass-card studio-rec-item" style="padding:10px 14px;margin-bottom:6px">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px;flex-wrap:wrap;gap:4px">
          <div>
            <div style="font-size:.85rem;font-weight:600">${escapeHTML(a.label||'تسجيل')}</div>
            <div style="font-size:.72rem;color:var(--text-3)">${new Date(a.created).toLocaleString('ar')}</div>
          </div>
          <button class="btn btn-sm btn-danger" data-da="${a.id}">✕</button>
        </div>
        <audio controls src="${url}" style="width:100%;height:32px;border-radius:6px"></audio>
      </div>`;
    }).join('');
    el.querySelectorAll('[data-da]').forEach(b=>b.onclick=async()=>{ await Library.deleteAudio(+b.dataset.da); VoiceStudio.loadRecordings(); });
  }
};

/* ══════════════════════════════════════════════════════════════════
   المصنف الذكي — TarteelMode
   ─────────────────────────────────────────────────────────────────
   Word-by-word Arabic recitation checker with real-time feedback.
   Levenshtein-based phoneme matching · Memorization mode (fade-in) ·
   Haptic errors · Full ai_core.js integration via /qqc/tarteel/log
══════════════════════════════════════════════════════════════════ */
const TarteelMode = {
  /* ── State ── */
  ayahs: [],          // [{numberInSurah, text, globalNum, surahName}]
  words: [],          // [{raw, norm, state:'pending'|'correct'|'error', ayahIdx}]
  cursor: 0,          // next expected word index
  mode: 'practice',   // 'practice' | 'memorize'
  active: false,
  startedAt: 0,
  correct: 0,
  errors: 0,
  srec: null,
  mediaRec: null,
  mediaChunks: [],
  _stream: null,
  audioCtx: null,
  analyser: null,
  animFrame: null,
  _interimBuf: '',    // accumulated interim transcript
  _totalTranscript: '',

  /* ── Arabic normalisation (strip diacritics + tatweel) ── */
  norm(s){
    return s
      .replace(/[\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED]/g,'')
      .replace(/\u0640/g,'')                            // tatweel
      .replace(/[أإآا]/g,'ا').replace(/[ىي]/g,'ي')
      .replace(/[ةه]/g,'ه').replace(/ؤو/g,'و')
      .replace(/\s+/g,' ').trim();
  },

  /* ── Levenshtein distance (character-level) ── */
  lev(a, b){
    if (!a) return b.length; if (!b) return a.length;
    const m=a.length, n=b.length;
    const dp = Array.from({length:m+1},(_,i)=>Array.from({length:n+1},(_,j)=>i===0?j:j===0?i:0));
    for(let i=1;i<=m;i++) for(let j=1;j<=n;j++)
      dp[i][j] = a[i-1]===b[j-1] ? dp[i-1][j-1] : 1+Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    return dp[m][n];
  },

  /* ── Word similarity 0-1 ── */
  wordSim(a, b){
    a = TarteelMode.norm(a); b = TarteelMode.norm(b);
    if (!a || !b) return 0;
    if (a === b) return 1;
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 1;
    return 1 - TarteelMode.lev(a,b)/maxLen;
  },

  /* ── Build flat word list from ayahs ── */
  buildWords(){
    TarteelMode.words = [];
    TarteelMode.ayahs.forEach((ay, ai)=>{
      ay.text.split(/\s+/).filter(Boolean).forEach(w=>{
        TarteelMode.words.push({ raw:w, norm:TarteelMode.norm(w), state:'pending', ayahIdx:ai });
      });
    });
  },

  /* ── Load: populate dropdowns + tab system ── */
  async load(){
    const surahs = await QuranBrowser.loadSurahs();
    // Populate tarteel surah select
    const sel = document.getElementById('tarteel-surah');
    if (sel && sel.options.length <= 1 && surahs.length){
      surahs.forEach(s=>{
        const o = document.createElement('option');
        o.value = s.number; o.textContent = `${s.number}. ${s.name}`;
        sel.appendChild(o);
      });
    }

    /* ── Tab switching (smart / progress only) ── */
    const switchTab = (t)=>{
      document.querySelectorAll('.recitation-tab').forEach(bt=>{
        bt.classList.toggle('rtab-active', bt.dataset.rtab === t);
      });
      ['smart','progress'].forEach(name=>{
        const el = document.getElementById('rtab-'+name);
        if (el) el.style.display = name === t ? '' : 'none';
      });
      if (t==='progress') TarteelMode._loadProgressTab();
    };
    document.querySelectorAll('.recitation-tab').forEach(tab=>{
      tab.onclick = ()=> switchTab(tab.dataset.rtab);
    });

    /* ── Smart dictation wiring ── */
    document.getElementById('btn-tarteel-load')?.addEventListener('click', TarteelMode.loadAyahs);
    document.querySelectorAll('[data-tqs]').forEach(b=>b.onclick=()=>{
      const s2 = document.getElementById('tarteel-surah');
      if (s2) s2.value = b.dataset.tqs;
      TarteelMode.loadAyahs();
    });
    document.getElementById('btn-mode-practice')?.addEventListener('click', ()=>TarteelMode.setMode('practice'));
    document.getElementById('btn-mode-memorize')?.addEventListener('click', ()=>TarteelMode.setMode('memorize'));
    document.getElementById('btn-tarteel-record')?.addEventListener('click', TarteelMode.toggleRecord);
    document.getElementById('btn-tarteel-reset')?.addEventListener('click', TarteelMode.resetSession);
    document.getElementById('btn-tarteel-listen')?.addEventListener('click', TarteelMode.listenToAyah);
    document.getElementById('btn-tarteel-tts')?.addEventListener('click', ()=>{
      const text = TarteelMode.ayahs.map(a=>a.text).join(' ');
      if (text) VoiceStudio._ttsSpeak(text, 'btn-tarteel-tts');
    });
    document.getElementById('tarteel-sheikh-select')?.addEventListener('change', e=>{
      const qs = document.getElementById('quran-sheikh-select');
      if (qs) qs.value = e.target.value;
    });

    TarteelMode.loadHistory();
  },

  async _loadProgressTab(){
    await Promise.all([VoiceStudio.loadProgressChart(), TarteelMode.loadHistory()]);
  },

  setMode(m){
    TarteelMode.mode = m;
    const pBtn = document.getElementById('btn-mode-practice');
    const mBtn = document.getElementById('btn-mode-memorize');
    if (pBtn){ pBtn.classList.toggle('btn-secondary', m==='practice'); pBtn.classList.toggle('btn-ghost', m!=='practice'); }
    if (mBtn){ mBtn.classList.toggle('btn-secondary', m==='memorize'); mBtn.classList.toggle('btn-ghost', m!=='memorize'); }
    TarteelMode.renderWords(); // re-render applying hidden/visible
  },

  /* ── Fetch ayahs from alquran.cloud ── */
  async loadAyahs(){
    const surahNum = +(document.getElementById('tarteel-surah')?.value||0);
    const fromA = +(document.getElementById('tarteel-from')?.value||0);
    const toA   = +(document.getElementById('tarteel-to')?.value||0);
    if (!surahNum) return toast('اختر سورة أولاً','error');
    const btn = document.getElementById('btn-tarteel-load');
    if (btn){ btn.disabled=true; btn.textContent='⏳ جارٍ التحميل…'; }
    try {
      const r = await fetch(`${API}/quran/surah/${surahNum}`);
      const d = await r.json();
      if (!d.data) throw new Error('no data');
      const surah = d.data;
      let ayahs = surah.ayahs;
      if (fromA) ayahs = ayahs.filter(a=>a.numberInSurah>=fromA);
      if (toA)   ayahs = ayahs.filter(a=>a.numberInSurah<=toA);
      if (!ayahs.length){ toast('لا آيات في هذا النطاق','error'); return; }
      TarteelMode.ayahs = ayahs.map(a=>({
        numberInSurah: a.numberInSurah,
        text: a.text,
        globalNum: a.number,
        surahName: surah.name,
        surahNum: surah.number,
      }));
      TarteelMode.buildWords();
      TarteelMode.cursor = 0;
      TarteelMode.correct = 0;
      TarteelMode.errors  = 0;
      TarteelMode.active  = false;
      TarteelMode._totalTranscript = '';
      // Update UI
      const lbl = document.getElementById('tarteel-surah-label');
      const rng = document.getElementById('tarteel-ayah-range');
      if (lbl) lbl.textContent = surah.name;
      if (rng) rng.textContent = `آيات ${ayahs[0].numberInSurah}${ayahs.length>1?'–'+ayahs[ayahs.length-1].numberInSurah:''}`;
      document.getElementById('tarteel-verse-wrap')?.style.setProperty('display','block');
      document.getElementById('tarteel-rec-area')?.style.setProperty('display','block');
      document.getElementById('tarteel-controls')?.style.setProperty('display','block');
      document.getElementById('tarteel-result')?.style.setProperty('display','none');
      document.getElementById('tarteel-ai-feedback')?.style.setProperty('display','none');
      TarteelMode.renderWords();
      TarteelMode.updateProgress();
      toast(`تم تحميل ${ayahs.length} آية — اضغط 🎙️ للبدء`,'success',2500);
    } catch(e){ toast('خطأ في تحميل الآيات','error'); }
    finally { if (btn){ btn.disabled=false; btn.textContent='تحميل'; } }
  },

  /* ── Render the word spans ── */
  renderWords(){
    const el = document.getElementById('tarteel-text');
    if (!el) return;
    const memMode = TarteelMode.mode === 'memorize';
    let html = '';
    let prevAyah = -1;
    TarteelMode.words.forEach((w, i)=>{
      if (w.ayahIdx !== prevAyah && prevAyah !== -1){
        html += `<span class="ayah-end-marker" style="color:rgba(245,158,11,.7);font-size:.68em;margin:0 6px;opacity:.9">﴿${TarteelMode.ayahs[w.ayahIdx-1]?.numberInSurah||''}﴾</span> `;
      }
      prevAyah = w.ayahIdx;
      const isActive = (i === TarteelMode.cursor && TarteelMode.active);
      let cls = 'tarteel-word tw-' + w.state;
      if (isActive) cls += ' tw-active';
      if (w._interim) cls += ' tw-interim';
      if (memMode && w.state === 'pending' && !w._interim) cls += ' tw-hidden';
      html += `<span class="${cls}" id="tw-${i}" data-wi="${i}">${escapeHTML(w.raw)}</span> `;
    });
    if (TarteelMode.ayahs.length){
      const last = TarteelMode.ayahs[TarteelMode.ayahs.length-1];
      html += `<span class="ayah-end-marker" style="color:rgba(245,158,11,.7);font-size:.68em">﴿${last.numberInSurah}﴾</span>`;
    }
    el.innerHTML = html;
    // Auto-scroll active word into center view
    if (TarteelMode.active){
      const activeEl = document.getElementById('tw-' + TarteelMode.cursor);
      if (activeEl) activeEl.scrollIntoView({behavior:'smooth', block:'center'});
    }
  },

  updateProgress(){
    const total = TarteelMode.words.length;
    const done  = TarteelMode.words.filter(w=>w.state!=='pending').length;
    const fill  = document.getElementById('tarteel-progress-fill');
    const lbl   = document.getElementById('tarteel-progress-label');
    if (fill) fill.style.width = (total ? (done/total*100) : 0) + '%';
    if (lbl)  lbl.textContent  = `${done} / ${total}`;
  },

  resetSession(){
    TarteelMode.stopRecord();
    TarteelMode.words.forEach(w=>w.state='pending');
    TarteelMode.cursor = 0;
    TarteelMode.correct = 0;
    TarteelMode.errors  = 0;
    TarteelMode.active  = false;
    TarteelMode._totalTranscript = '';
    TarteelMode._interimBuf = '';
    document.getElementById('tarteel-result')?.style.setProperty('display','none');
    document.getElementById('tarteel-ai-feedback')?.style.setProperty('display','none');
    TarteelMode.renderWords();
    TarteelMode.updateProgress();
    const btn = document.getElementById('btn-tarteel-record');
    if (btn){ btn.textContent='🎙️ ابدأ التلاوة'; btn.classList.remove('btn-recording'); }
    const st = document.getElementById('tarteel-rec-status');
    if (st) st.textContent='';
    const live = document.getElementById('tarteel-live-transcript');
    if (live) live.style.display='none';
    toast('تمت إعادة الضبط','info',1500);
  },

  listenToAyah(){
    const ayahs = TarteelMode.ayahs;
    if (!ayahs.length) return;
    QuranBrowser.stopAll();
    const queue = ayahs.map(a=>a.globalNum).filter(Boolean);
    if (queue.length){
      QuranBrowser.playQueue = queue;
      QuranBrowser.loopRemain = 1; QuranBrowser.playIndex = 0;
      QuranBrowser.playing = true; QuranBrowser.paused = false;
      QuranBrowser.ayahRepeatRemain = 1;
      QuranBrowser.playNext();
    }
  },

  /* ── Toggle recording ── */
  async toggleRecord(){
    if (TarteelMode.active){
      TarteelMode.stopRecord();
    } else {
      await TarteelMode.startRecord();
    }
  },

  async startRecord(){
    if (!TarteelMode.words.length) return toast('اختر سورة واضغط "تحميل" أولاً','error');
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return toast('متصفحك لا يدعم التعرف على الصوت — استخدم Google Chrome','error');

    // UI: show loading state
    const btn = document.getElementById('btn-tarteel-record');
    const st  = document.getElementById('tarteel-rec-status');
    if (btn){ btn.disabled=true; btn.textContent='⏳ جارٍ الاتصال...'; }
    if (st)  st.textContent = '🔄 جارٍ طلب إذن الميكروفون...';

    TarteelMode.active = true;
    TarteelMode.startedAt = Date.now();
    TarteelMode._interimBuf = '';
    if (TarteelMode.cursor === 0) TarteelMode.words.forEach(w=>{ w.state='pending'; w._interim=false; w._errCount=0; });

    // ── Step 1: Request microphone ──
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({audio:true, video:false});
    } catch(e){
      TarteelMode.active = false;
      if (btn){ btn.disabled=false; btn.textContent='🎙️ ابدأ التلاوة'; btn.classList.remove('btn-recording'); }
      if (st) st.textContent='';
      const errMsg =
        (e.name==='NotAllowedError' || e.name==='PermissionDeniedError')
          ? 'تم رفض إذن الميكروفون — اضغط على 🔒 في شريط العنوان وامنح إذن الصوت'
        : e.name==='NotFoundError'
          ? 'لم يُعثر على ميكروفون — تأكد من توصيله بالجهاز'
        : e.name==='NotReadableError'
          ? 'الميكروفون مستخدم بتطبيق آخر — أغلقه وحاول مجدداً'
        : 'لا يمكن الوصول للميكروفون: ' + (e.message || e.name);
      toast(errMsg, 'error', 6000);
      return;
    }

    // ── Step 2: Setup MediaRecorder (for waveform + audio save) ──
    TarteelMode.mediaChunks = [];
    const mimeType = ['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/mp4']
      .find(t=>MediaRecorder.isTypeSupported(t)) || '';
    try {
      TarteelMode.mediaRec = new MediaRecorder(stream, mimeType ? {mimeType} : {});
      TarteelMode.mediaRec.ondataavailable = e=>{ if(e.data&&e.data.size>0) TarteelMode.mediaChunks.push(e.data); };
      TarteelMode.mediaRec.onstop = ()=>{ try{ stream.getTracks().forEach(t=>t.stop()); }catch(_){} };
      TarteelMode.mediaRec.start(200);
    } catch(_){}
    TarteelMode.startWaveform(stream);
    TarteelMode._stream = stream;

    // ── Step 3: SpeechRecognition ──
    /* ── SR auto-restart factory ──
       المشكلة: المتصفح يوقف SR بعد أول نتيجة نهائية أو بعد صمت.
       الحل: نُنشئ instance جديداً تماماً في كل مرة بدلاً من restart. */
    const makeSR = ()=>{
      const rec = new SR();
      rec.lang = 'ar-SA';
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 3;

      rec.onresult = ev=>{
        if (!TarteelMode.active) return;
        let interim='', final='';
        for(let i=ev.resultIndex; i<ev.results.length; i++){
          const top = ev.results[i][0].transcript;
          if (ev.results[i].isFinal) final += top + ' ';
          else interim += top;
        }
        if (final.trim()){
          TarteelMode._totalTranscript += final;
          TarteelMode.processChunk(final.trim(), false);
        }
        if (interim.trim()){
          TarteelMode.processChunk(interim.trim(), true);
        }
        const live = document.getElementById('tarteel-live-transcript');
        if (live){
          live.style.display = 'block';
          live.innerHTML = interim
            ? `<span style="color:#fcd34d">🎤 ${escapeHTML(interim)}</span>`
            : final.trim()
            ? `<span style="color:#34d399">✅ ${escapeHTML(final.trim().slice(0,100))}</span>`
            : '';
        }
      };

      rec.onerror = ev=>{
        const silentErrors = new Set(['no-speech','aborted']);
        if (silentErrors.has(ev.error)) return;
        const errMap = {
          'audio-capture': 'تعذّر التقاط الصوت — تحقق من الميكروفون',
          'not-allowed':   'تم رفض إذن الميكروفون',
          'network':       'خطأ في الشبكة — تحقق من اتصالك',
          'service-not-allowed': 'خدمة التعرف على الصوت غير مسموح بها',
        };
        console.warn('[SR] error:', ev.error);
        if (!silentErrors.has(ev.error)) toast(errMap[ev.error] || 'خطأ في التعرف على الصوت: ' + ev.error, 'error', 3500);
      };

      rec.onend = ()=>{
        /* أنشئ instance جديداً كلياً — هذا يحل مشكلة التوقف بعد أول نتيجة */
        if (!TarteelMode.active) return;
        setTimeout(()=>{
          if (!TarteelMode.active) return;
          try {
            const fresh = makeSR();
            fresh.start();
            TarteelMode.srec = fresh;
          } catch(e){ console.warn('[SR] re-create failed:', e.message); }
        }, 120);
      };

      return rec;
    };

    // ── Step 4: Start SR ──
    const sr = makeSR();
    try {
      sr.start();
    } catch(e){
      TarteelMode.active = false;
      try{ stream.getTracks().forEach(t=>t.stop()); }catch(_){}
      if (btn){ btn.disabled=false; btn.textContent='🎙️ ابدأ التلاوة'; btn.classList.remove('btn-recording'); }
      if (st) st.textContent='';
      toast('فشل تشغيل التعرف على الصوت: ' + e.message, 'error', 4000);
      return;
    }

    TarteelMode.srec = sr;

    // ── Step 5: Update UI ──
    if (btn){ btn.disabled=false; btn.textContent='⏹ إيقاف التلاوة'; btn.classList.add('btn-recording'); }
    if (st) st.textContent = '🔴 يستمع... اتلُ كلمةً كلمة بوضوح';
    TarteelMode.renderWords();
    // Scroll first word into view
    const firstEl = document.getElementById('tw-' + TarteelMode.cursor);
    if (firstEl) firstEl.scrollIntoView({behavior:'smooth', block:'center'});
  },

  stopRecord(){
    TarteelMode.active = false;
    // Stop SR first (suppress any restart attempts)
    const sr = TarteelMode.srec;
    TarteelMode.srec = null;
    if (sr){ try{ sr.abort(); }catch(e){} }
    // Stop MediaRecorder
    if (TarteelMode.mediaRec && TarteelMode.mediaRec.state === 'recording'){
      try{ TarteelMode.mediaRec.stop(); }catch(e){}
    }
    // Stop stream directly if mediaRec didn't
    if (TarteelMode._stream){
      try{ TarteelMode._stream.getTracks().forEach(t=>t.stop()); }catch(_){}
      TarteelMode._stream = null;
    }
    TarteelMode.stopWaveform();
    const btn = document.getElementById('btn-tarteel-record');
    if (btn){ btn.disabled=false; btn.textContent='🎙️ ابدأ التلاوة'; btn.classList.remove('btn-recording'); }
    const st = document.getElementById('tarteel-rec-status');
    if (st) st.textContent='';
    const live = document.getElementById('tarteel-live-transcript');
    if (live){ live.style.display='none'; live.innerHTML=''; }
    // Clear interim flags
    TarteelMode.words.forEach(w=>{ w._interim=false; });
    TarteelMode.renderWords();
    // Show results if something was attempted
    if (TarteelMode.correct + TarteelMode.errors > 0) TarteelMode.endSession();
  },

  /* ── Process a transcript chunk against expected words ──
     الإصلاح الجوهري: إضافة penalty موضعي للكلمات المكررة.
     المشكلة: كلمة "الله" مثلاً تظهر مرات كثيرة في الصفحة.
     الحل: كل خطوة للأمام تُقلل النتيجة بمعامل 0.82 تصاعدياً
     فالكلمة عند cursor=0 تكسب 1.0×sim, عند cursor+1 تكسب 0.82×sim, وهكذا.
     بهذا لا تقفز الكلمات لمواضع بعيدة إلا إن لم تُوجد في المكان الصحيح.
  */
  processChunk(transcript, isInterim=false){
    if (!transcript || !TarteelMode.active) return;
    const spokenWords = transcript.trim().split(/\s+/).filter(Boolean);
    let didAdvance = false;

    if (isInterim) TarteelMode.words.forEach(w=>{ w._interim=false; });

    spokenWords.forEach(sw=>{
      if (TarteelMode.cursor >= TarteelMode.words.length) return;

      /* ── Positional look-ahead with exponential penalty ──
         نبحث بحد أقصى 5 كلمات للأمام، لكن كل خطوة تُقلل النتيجة.
         هذا يضمن أن الكلمة الصحيحة في موضعها تكسب دائماً على
         كلمة مطابقة لكنها في موضع متقدم. */
      let bestScore = 0, bestIdx = TarteelMode.cursor;
      const ahead = Math.min(5, TarteelMode.words.length - TarteelMode.cursor);
      for (let la=0; la<ahead; la++){
        const wi = TarteelMode.cursor + la;
        if (TarteelMode.words[wi].state === 'correct') continue;
        const sim = TarteelMode.wordSim(sw, TarteelMode.words[wi].raw);
        // penalty: 18% لكل خطوة للأمام — يمنع القفز لكلمات بعيدة متطابقة
        const posScore = sim * Math.pow(0.82, la);
        if (posScore > bestScore){ bestScore=posScore; bestIdx=wi; }
      }
      // sim الحقيقي بدون penalty لمقارنة العتبة
      const trueSim = TarteelMode.wordSim(sw, TarteelMode.words[bestIdx].raw);

      if (isInterim){
        if (bestScore >= 0.78) TarteelMode.words[bestIdx]._interim = true;
      } else {
        if (trueSim >= 0.70){
          // صح: احسب الكلمات المتخطاة بين cursor و bestIdx كأخطاء
          for (let i=TarteelMode.cursor; i<bestIdx; i++){
            if (TarteelMode.words[i].state === 'pending'){
              TarteelMode.words[i].state = 'error';
              TarteelMode.errors++;
              if (navigator.vibrate) navigator.vibrate([40,20,40]);
            }
          }
          TarteelMode.words[bestIdx]._interim = false;
          TarteelMode.words[bestIdx].state = 'correct';
          TarteelMode.correct++;
          TarteelMode.cursor = bestIdx + 1;
          didAdvance = true;
          if (navigator.vibrate) navigator.vibrate(30);
          if (TarteelMode.cursor >= TarteelMode.words.length){
            setTimeout(()=>{ TarteelMode.stopRecord(); toast('🎉 أحسنت! انتهيت من جميع الآيات','success',3500); },300);
          }
        } else if (trueSim < 0.40){
          // خطأ واضح — عدّ الخطأ وتجاوز بعد محاولتين
          const w = TarteelMode.words[TarteelMode.cursor];
          if (w.state !== 'correct'){
            w._errCount = (w._errCount||0) + 1;
            w.state = 'error';
            if (w._errCount === 1) TarteelMode.errors++;
            if (navigator.vibrate) navigator.vibrate([60,30,60,30,60]);
            if (w._errCount >= 3){ TarteelMode.cursor++; didAdvance=true; }
          }
        }
        // 0.40–0.70: غامض — اترك cursor، دع المستخدم يُعيد
      }
    });

    TarteelMode.renderWords();
    TarteelMode.updateProgress();
    if (didAdvance){
      const nextEl = document.getElementById('tw-' + TarteelMode.cursor);
      if (nextEl) nextEl.scrollIntoView({behavior:'smooth', block:'center'});
    }
  },

  /* ── End session: calculate score, sync with ai_core.js ── */
  async endSession(){
    const total   = TarteelMode.words.length;
    const correct = TarteelMode.words.filter(w=>w.state==='correct').length;
    const errors  = TarteelMode.words.filter(w=>w.state==='error').length;
    const score   = total > 0 ? Math.round(correct / total * 100) : 0;
    const durationMs = Date.now() - TarteelMode.startedAt;
    const durationMin = Math.max(1, Math.round(durationMs/60000));
    const difficulty = score>=85?'easy':score>=60?'medium':'hard';
    const ayahCount  = TarteelMode.ayahs.length;
    const pagesEst   = +(ayahCount * 0.025).toFixed(3); // rough 15 ayahs per page

    // Show local result card immediately
    const col = score>=80?'#34d399':score>=55?'#fbbf24':'#ef4444';
    const resEl = document.getElementById('tarteel-result');
    if (resEl){
      resEl.style.display='block';
      resEl.innerHTML=`<div class="glass-card pad" style="border:1px solid ${col}40">
        <div style="font-size:.8rem;font-weight:700;color:${col};margin-bottom:12px">📊 نتيجة الجلسة</div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px">
          <div style="text-align:center;flex:1;min-width:70px">
            <div class="mono" style="font-size:2rem;font-weight:900;color:${col}">${score}%</div>
            <div style="font-size:.72rem;color:var(--text-3)">الدقة</div>
          </div>
          <div style="text-align:center;flex:1;min-width:70px">
            <div class="mono" style="font-size:1.6rem;font-weight:700;color:#34d399">${correct}</div>
            <div style="font-size:.72rem;color:var(--text-3)">كلمة صحيحة</div>
          </div>
          <div style="text-align:center;flex:1;min-width:70px">
            <div class="mono" style="font-size:1.6rem;font-weight:700;color:#ef4444">${errors}</div>
            <div style="font-size:.72rem;color:var(--text-3)">كلمة خطأ</div>
          </div>
          <div style="text-align:center;flex:1;min-width:70px">
            <div class="mono" style="font-size:1.6rem;font-weight:700;color:#93c5fd">${durationMin}د</div>
            <div style="font-size:.72rem;color:var(--text-3)">المدة</div>
          </div>
        </div>
        <div style="margin-bottom:10px">
          <div style="display:flex;justify-content:space-between;margin-bottom:4px">
            <span style="font-size:.72rem;color:var(--text-3)">دقة التلاوة</span>
            <span style="font-size:.72rem;color:${col}">${score}%</span>
          </div>
          <div style="background:rgba(255,255,255,.08);border-radius:20px;height:8px;overflow:hidden">
            <div style="background:${col};height:100%;width:${score}%;border-radius:20px;transition:width 1s ease"></div>
          </div>
        </div>
        <div id="tarteel-ai-result-inline" style="font-size:.82rem;color:var(--text-3)">⏳ جارٍ تحليل الأداء بالذكاء الاصطناعي...</div>
      </div>`;
    }

    /* ── Report to server → ai_core.js ── */
    try {
      const surahName = TarteelMode.ayahs[0]?.surahName || 'سورة';
      const fromA = TarteelMode.ayahs[0]?.numberInSurah || 1;
      const toA   = TarteelMode.ayahs[TarteelMode.ayahs.length-1]?.numberInSurah || 1;
      // 1. Log Tarteel session (gets ai_core decision back)
      // تجميع الكلمات الخاطئة فعلياً لإرسالها للسيرفر ولـ Hermes Agent
      const wrongWordsList = TarteelMode.words
        .filter(w=>w.state==='error')
        .map(w=>w.raw)
        .slice(0,50);
      const correctWordsList = TarteelMode.words
        .filter(w=>w.state==='correct')
        .map(w=>w.raw)
        .slice(0,50);
      const logRes = await Api.post('/tarteel/log', {
        surah_name: surahName,
        from_ayah: fromA,
        to_ayah: toA,
        word_count: total,
        correct_words: correct,
        error_words: errors,
        score,
        duration_minutes: durationMin,
        mode: TarteelMode.mode,
        transcript: TarteelMode._totalTranscript.trim().slice(0,500),
        wrong_words: wrongWordsList,
        correct_word_list: correctWordsList,
        expected_text: TarteelMode.ayahs.map(a=>a.text).join(' ').slice(0,1000),
      });
      // 2. Also record as a memorization session so ai_core trains on it
      Api.post('/session/complete',{
        pages_done: pagesEst,
        difficulty,
        duration_minutes: durationMin,
        mood_score: Math.round(score/10),
        technique_used: 'tarteel_smart_classifier',
      }).catch(()=>{});
      // 3. Show AI decision
      if (logRes && !logRes.error) TarteelMode.showAIDecision(logRes, score);
    } catch(e){
      const inl = document.getElementById('tarteel-ai-result-inline');
      if (inl) inl.textContent = 'تعذّر التواصل مع نظام الذكاء الاصطناعي.';
    }
    // Save audio + run Whisper AI check
    if (TarteelMode.mediaChunks.length){
      try {
        const recMime = TarteelMode.mediaRec?.mimeType || 'audio/webm';
        const blob = new Blob(TarteelMode.mediaChunks, {type:recMime});
        const surahName2 = TarteelMode.ayahs[0]?.surahName || 'تلاوة';
        await Library.saveAudio(blob, `🎯 ${surahName2} — ${score}% دقة`);
        // Run Whisper AI check in background
        TarteelMode.doAICheck(blob, recMime);
      } catch(e){}
    }
    TarteelMode.loadHistory();
  },

  /* ── Whisper AI check: send audio → get accurate transcript + GPT feedback ── */
  async doAICheck(blob, mimeType){
    const inl = document.getElementById('tarteel-ai-result-inline');
    const fbEl = document.getElementById('tarteel-ai-feedback');
    const expectedText = TarteelMode.ayahs.map(a=>a.text).join(' ');
    if (!expectedText || !blob) return;
    try {
      // Convert blob to base64
      const ab = await blob.arrayBuffer();
      const b64 = btoa(String.fromCharCode(...new Uint8Array(ab)));
      if (inl) inl.innerHTML = `<div style="color:var(--text-2)">🎤 Whisper يحلل تلاوتك بدقة عالية...</div>`;
      const res = await Api.post('/tarteel/ai-check', {
        audio_base64: b64,
        mime_type: mimeType || 'audio/webm',
        expected_text: expectedText,
        surah_name: TarteelMode.ayahs[0]?.surahName || '',
        from_ayah: TarteelMode.ayahs[0]?.numberInSurah || 1,
        to_ayah: TarteelMode.ayahs[TarteelMode.ayahs.length-1]?.numberInSurah || 1,
      });
      if (res.error && res.error !== 'ai_not_configured') {
        if (inl) inl.textContent = 'تعذّر تحليل الصوت: ' + res.error;
        return;
      }
      const transcript = res.transcript || '';
      const feedback   = res.feedback   || '';
      // Show Whisper transcript
      if (inl && transcript) {
        inl.innerHTML = `
          <div style="margin-bottom:8px">
            <div style="font-size:.72rem;color:#a5b4fc;margin-bottom:3px">🎤 Whisper — ما سمعه الذكاء الاصطناعي:</div>
            <div style="font-size:.88rem;color:var(--text-1);line-height:1.8;direction:rtl;padding:8px;background:rgba(99,102,241,.08);border-radius:8px">${escapeHTML(transcript)}</div>
          </div>`;
      } else if (inl) {
        inl.innerHTML = `<div style="color:var(--text-3);font-size:.82rem">لم يتمكن Whisper من التعرف على الصوت — تأكد من وضوح التلاوة.</div>`;
      }
      // Show GPT feedback in AI panel
      if (feedback && fbEl) {
        const existing = fbEl.querySelector('.glass-card');
        const whisperPanel = document.createElement('div');
        whisperPanel.className = 'glass-card pad';
        whisperPanel.style.cssText = 'border:1px solid rgba(52,211,153,.3);margin-top:8px';
        whisperPanel.innerHTML = `
          <div style="font-size:.8rem;font-weight:700;color:#34d399;margin-bottom:10px">🤖 تقييم التجويد — Whisper + GPT</div>
          <div style="font-size:.85rem;color:var(--text-2);line-height:1.8;direction:rtl">${escapeHTML(feedback)}</div>`;
        fbEl.appendChild(whisperPanel);
      }
    } catch(e) {
      console.error('Tarteel AI check error:', e.message);
    }
  },

  /* ── Render AI core decision ── */
  showAIDecision(r, score){
    const mode = r.mode || 'NORMAL_MODE';
    const energy = r.energy ?? 75;
    const afi = r.afi ?? 100;
    const alert = r.alert;
    const intervention = r.intervention;
    const plan = r.plan_recommendation;
    // Update AI bar
    const modeMap = {
      NORMAL_MODE:    {cls:'tarteel-mode-normal',    lbl:'NORMAL MODE',    icon:'🌙'},
      CHALLENGE_MODE: {cls:'tarteel-mode-challenge', lbl:'CHALLENGE MODE', icon:'⚡'},
      RELOAD_MODE:    {cls:'tarteel-mode-reload',    lbl:'RELOAD MODE',    icon:'🌿'},
      PATTERN_INTERRUPT:{cls:'tarteel-mode-interrupt',lbl:'PATTERN INTERRUPT',icon:'⚠️'},
    };
    const md = modeMap[mode] || modeMap.NORMAL_MODE;
    const badge = document.getElementById('tarteel-mode-badge');
    if (badge){ badge.className=`tarteel-ai-badge ${md.cls}`; badge.textContent=`${md.icon} ${md.lbl}`; }
    const enEl = document.getElementById('tarteel-energy-val');
    if (enEl) enEl.textContent = energy;
    const afiEl = document.getElementById('tarteel-afi-val');
    if (afiEl) afiEl.textContent = afi;
    // Inline result message
    const inl = document.getElementById('tarteel-ai-result-inline');
    const scoreMsg = score>=85
      ? 'أداء ممتاز! الذكاء الاصطناعي رصد مستوى طاقة عالياً وقد يرفع صعوبة خطتك.'
      : score>=65
      ? 'أداء جيد. واصل الجهد والخوارزمية ستضبط سرعة الحفظ.'
      : 'هناك كلمات تحتاج مراجعة. الخوارزمية خففت الهدف اليومي لمساعدتك.';
    if (inl) inl.innerHTML=`<div style="color:var(--text-2);line-height:1.7">${scoreMsg}</div>`;
    // AI feedback panel
    const fbEl = document.getElementById('tarteel-ai-feedback');
    if (!fbEl) return;
    fbEl.style.display='block';
    const alertHtml = alert
      ? `<div style="padding:10px 12px;background:rgba(99,102,241,.1);border-radius:8px;font-size:.85rem;line-height:1.7;margin-bottom:8px">${escapeHTML(alert.text_ar||alert.text||'')}</div>`
      : '';
    const interHtml = intervention
      ? `<div style="padding:10px 12px;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.25);border-radius:8px;font-size:.85rem;color:#fca5a5;margin-bottom:8px">⚠️ ${escapeHTML(intervention.message_ar||'')}</div>`
      : '';
    const planHtml = plan
      ? `<div style="font-size:.78rem;color:var(--text-3)">الهدف اليومي المُعدَّل: <span class="mono" style="color:#93c5fd">${plan.target} صفحة</span> <span style="font-size:.72rem;color:var(--text-3)">(${plan.reason})</span></div>`
      : '';
    fbEl.innerHTML=`<div class="glass-card pad" style="border:1px solid rgba(99,102,241,.3)">
      <div style="font-size:.8rem;font-weight:700;color:#a5b4fc;margin-bottom:10px">🤖 تحليل الذكاء الاصطناعي — ai_core.js</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px">
        <div style="text-align:center;flex:1;padding:8px;background:rgba(255,255,255,.04);border-radius:8px">
          <div class="mono" style="font-size:1.4rem;color:#93c5fd">${energy}</div>
          <div style="font-size:.68rem;color:var(--text-3)">الطاقة</div>
        </div>
        <div style="text-align:center;flex:1;padding:8px;background:rgba(255,255,255,.04);border-radius:8px">
          <div class="mono" style="font-size:1.4rem;color:#34d399">${afi}</div>
          <div style="font-size:.68rem;color:var(--text-3)">AFI مؤشر التكيّف</div>
        </div>
        <div style="text-align:center;flex:1;padding:8px;background:rgba(255,255,255,.04);border-radius:8px">
          <div class="tarteel-ai-badge ${md.cls}" style="justify-content:center">${md.icon} ${md.lbl}</div>
          <div style="font-size:.68rem;color:var(--text-3);margin-top:4px">الوضع المُختار</div>
        </div>
      </div>
      ${alertHtml}${interHtml}${planHtml}
    </div>`;
    // Also update main dashboard AI island energy
    UI.applyDecision(r);
  },

  /* ── listenToAyah: use tarteel-sheikh-select if present ── */
  listenToAyah(){
    const ayahs = TarteelMode.ayahs;
    if (!ayahs.length) return;
    // Sync tarteel sheikh to quran sheikh before playing
    const tSheikh = document.getElementById('tarteel-sheikh-select');
    const qSheikh = document.getElementById('quran-sheikh-select');
    if (tSheikh && qSheikh) qSheikh.value = tSheikh.value;
    QuranBrowser.stopAll();
    const queue = ayahs.map(a=>a.globalNum).filter(Boolean);
    if (queue.length){
      QuranBrowser.playQueue = queue;
      QuranBrowser.loopRemain = 1; QuranBrowser.playIndex = 0;
      QuranBrowser.playing = true; QuranBrowser.paused = false;
      QuranBrowser.ayahRepeatRemain = 1;
      QuranBrowser.playNext();
    }
  },

  /* ── Waveform helpers ── */
  startWaveform(stream){
    const canvas = document.getElementById('tarteel-waveform');
    if (!canvas) return;
    try {
      TarteelMode.audioCtx = new (window.AudioContext||window.webkitAudioContext)();
      TarteelMode.analyser = TarteelMode.audioCtx.createAnalyser();
      TarteelMode.analyser.fftSize = 256;
      TarteelMode.audioCtx.createMediaStreamSource(stream).connect(TarteelMode.analyser);
      const buf = new Uint8Array(TarteelMode.analyser.frequencyBinCount);
      const ctx = canvas.getContext('2d');
      (function draw(){
        TarteelMode.animFrame = requestAnimationFrame(draw);
        TarteelMode.analyser.getByteFrequencyData(buf);
        const W=canvas.offsetWidth||400, H=56;
        canvas.width=W; canvas.height=H;
        ctx.clearRect(0,0,W,H);
        const bw=W/buf.length*2;
        buf.forEach((v,i)=>{
          const h=(v/255)*H;
          ctx.fillStyle=`hsla(${230+v/3},75%,62%,.9)`;
          ctx.fillRect(i*bw,H-h,Math.max(1,bw-1),h);
        });
      })();
    } catch(e){}
  },
  stopWaveform(){
    if (TarteelMode.animFrame){ cancelAnimationFrame(TarteelMode.animFrame); TarteelMode.animFrame=null; }
    if (TarteelMode.audioCtx){ TarteelMode.audioCtx.close().catch(()=>{}); TarteelMode.audioCtx=null; }
    const cv = document.getElementById('tarteel-waveform');
    if (cv){ const c=cv.getContext('2d'); c.clearRect(0,0,cv.width,cv.height); }
  },

  async loadHistory(){
    try {
      const r = await Api.get('/tarteel/history');
      const list = r.history || [];
      const wrap = document.getElementById('tarteel-history-wrap');
      const el   = document.getElementById('tarteel-history-list');
      if (!list.length){ if(wrap) wrap.style.display='none'; return; }
      if (wrap) wrap.style.display='block';
      if (!el) return;
      el.innerHTML = list.slice().reverse().slice(0,15).map(h=>{
        const col=h.score>=80?'#34d399':h.score>=55?'#fbbf24':'#ef4444';
        return `<div class="glass-card" style="padding:10px 14px;margin-bottom:6px;display:flex;gap:12px;align-items:center">
          <div class="mono" style="font-size:1.4rem;font-weight:900;color:${col};min-width:52px">${h.score}%</div>
          <div style="flex:1;min-width:0">
            <div style="font-size:.85rem;font-weight:600">${escapeHTML(h.surah_name||'')}</div>
            <div style="font-size:.72rem;color:var(--text-3)">آيات ${h.from_ayah||1}–${h.to_ayah||1} · ${h.correct_words||0} صواب · ${h.error_words||0} خطأ · ${h.duration_minutes||1}د</div>
          </div>
          <div style="font-size:.68rem;color:var(--text-3);text-align:left">${fmtRel(h.created_at)}</div>
        </div>`;
      }).join('');
    } catch(e){}
  },
};

/* ══════════════════════════════════════════════════════════════
   KHATMA MODE — Full Quran reading plan tracker
   Keeps reading plan, marks daily ward, shows animated ring
══════════════════════════════════════════════════════════════ */
const KhatmaMode = {
  data: null,

  /* Called by router when entering view-khatma */
  async load(){
    await KhatmaMode.refresh();
    // Preset buttons
    document.querySelectorAll('[data-khatma-days]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const di = document.getElementById('khatma-days-input');
        if (di) di.value = btn.dataset.khatmaDays;
      });
    });
    document.getElementById('btn-khatma-start')?.addEventListener('click', KhatmaMode.start);
    document.getElementById('btn-khatma-complete')?.addEventListener('click', KhatmaMode.completeDay);
    document.getElementById('btn-khatma-delete')?.addEventListener('click', KhatmaMode.deleteKhatma);
  },

  async refresh(){
    try {
      const r = await Api.get('/khatma');
      KhatmaMode.data = r;
      KhatmaMode.render(r);
    } catch(e){ console.error('khatma refresh', e); }
  },

  render(d){
    const setup  = document.getElementById('khatma-setup-panel');
    const active = document.getElementById('khatma-active-panel');
    if (!d || !d.khatma){
      if (setup)  setup.style.display  = '';
      if (active) active.style.display = 'none';
      return;
    }
    if (setup)  setup.style.display  = 'none';
    if (active) active.style.display = '';
    const pct = d.percent_done || 0;
    // Animate SVG ring (circumference = 2π×55 ≈ 345.4)
    const ring = document.getElementById('khatma-ring-fill');
    if (ring){
      const offset = 345.4 * (1 - pct/100);
      ring.style.strokeDashoffset = offset;
    }
    const pctEl = document.getElementById('khatma-ring-pct');
    if (pctEl) pctEl.textContent = pct + '%';
    const sumEl = document.getElementById('khatma-summary');
    const ppd = d.khatma.pages_per_day || 1;
    if (sumEl) sumEl.textContent = `${d.pages_read||0} / 604 صفحة · ${ppd.toFixed(1)} صفحة/يوم`;
    const compEl = document.getElementById('khatma-completions');
    if (compEl) compEl.textContent = (d.completions||0) > 0 ? `⭐ ختمات مكتملة: ${d.completions}` : '';
    // Today's ward
    const tp = d.today_pages || {};
    const todayPagesEl = document.getElementById('khatma-today-pages');
    if (todayPagesEl) todayPagesEl.textContent = `صفحات ${tp.from||1} — ${tp.to||tp.from||1}`;
    // Done today?
    const card = document.getElementById('khatma-today-card');
    const btn  = document.getElementById('btn-khatma-complete');
    const msg  = document.getElementById('khatma-today-done-msg');
    if (d.today_completed){
      if (card) card.classList.add('done');
      if (btn)  { btn.disabled=true; btn.style.display='none'; }
      if (msg)  msg.style.display='';
    } else {
      if (card) card.classList.remove('done');
      if (btn)  { btn.disabled=false; btn.style.display=''; }
      if (msg)  msg.style.display='none';
    }
    // Stats
    const sp = document.getElementById('khatma-stat-pages');
    const sd = document.getElementById('khatma-stat-days-passed');
    const sr = document.getElementById('khatma-stat-days-remain');
    if (sp) sp.textContent = d.pages_read||0;
    if (sd) sd.textContent = d.days_passed||0;
    if (sr) sr.textContent = d.days_remaining||0;
  },

  async start(){
    const days = +(document.getElementById('khatma-days-input')?.value||30);
    if (!days||days<1){ toast('أدخل عدد الأيام','error'); return; }
    const btn = document.getElementById('btn-khatma-start');
    if (btn){ btn.disabled=true; btn.textContent='⏳ جارٍ إنشاء الختمة…'; }
    try {
      await Api.post('/khatma/create', {target_days: days});
      toast('تم إنشاء الختمة 📿','success');
      await KhatmaMode.refresh();
    } catch(e){ toast('تعذّر إنشاء الختمة','error'); }
    finally { if(btn){ btn.disabled=false; btn.textContent='ابدأ الختمة'; } }
  },

  async completeDay(){
    const btn = document.getElementById('btn-khatma-complete');
    if (btn){ btn.disabled=true; btn.textContent='⏳…'; }
    try {
      const r = await Api.post('/khatma/complete-day', {});
      if (r.khatma_complete){
        toast('مبروك! أتممت الختمة كاملة 🎉 تم تجديدها تلقائياً','success');
      } else {
        toast('بارك الله فيك — سُجّل وردك اليومي ✅','success');
      }
      await KhatmaMode.refresh();
    } catch(e){ toast('تعذّر تسجيل الورد','error'); if(btn){ btn.disabled=false; btn.textContent='✅ أتممت وردي اليوم'; } }
  },

  async deleteKhatma(){
    if (!confirm('هل أنت متأكد من إلغاء الختمة الحالية؟ سيُمحى تقدمك.')) return;
    try {
      await Api.del('/khatma');
      toast('تم إلغاء الختمة','success');
      await KhatmaMode.refresh();
    } catch(e){ toast('تعذّر إلغاء الختمة','error'); }
  },
};
