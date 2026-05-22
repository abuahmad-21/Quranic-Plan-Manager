/* ═══════════════════════════════════════════════════════════════
   QUANTUM QURAN COACH — server.js  (v2)
   Pure Node.js HTTP server. Termux-compatible. Zero dependencies.
   File-based JSON DB. Static files served from /public.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const url    = require('url');

const AI = require('./ai_core.js');

const PORT     = process.env.PORT || 3000;
const ROOT     = __dirname;
const PUBLIC   = path.join(ROOT, 'public');
const DB_PATH  = path.join(ROOT, 'db.json');
const ALERTS   = JSON.parse(fs.readFileSync(path.join(ROOT,'data','alerts.json')));
const SURAHS   = JSON.parse(fs.readFileSync(path.join(ROOT,'data','surahs.json')));
const TECHS    = JSON.parse(fs.readFileSync(path.join(ROOT,'data','techniques.json')));

/* ══ DB helpers (debounced write) ══ */
let DB = JSON.parse(fs.readFileSync(DB_PATH));
if(!DB.channels)  DB.channels  = {};
if(!DB.posts)     DB.posts     = [];
if(!DB.chats)     DB.chats     = {};
if(!DB.admin.sheikh_requests)    DB.admin.sheikh_requests    = {};
if(!DB.admin.memorization_plans) DB.admin.memorization_plans = [];
if(!DB.admin.ai_settings) DB.admin.ai_settings = {
  primary_provider: 'replit',
  fallback_provider: 'pollinations',
  replit_model: 'gpt-5-mini',
  custom_base_url: '',
  custom_api_key: '',
  custom_model: 'gpt-4o-mini'
};
if(!DB.admin.ai_settings.github) DB.admin.ai_settings.github = {
  token: '',
  repo_owner: 'abuahmad-21',
  repo_name: 'Quranic-Plan-Manager',
  branch: 'main'
};
if(!DB.admin.ai_settings.nvidia_nim_key) DB.admin.ai_settings.nvidia_nim_key = '';
if(!DB.admin.ai_settings.video_api_key)   DB.admin.ai_settings.video_api_key   = '';
if(!DB.admin.ai_settings.hermes_autopilot) DB.admin.ai_settings.hermes_autopilot = { enabled:false, interval_hours:6 };
let writePending = false;
function persist(){
  if (writePending) return;
  writePending = true;
  setTimeout(()=>{
    try { fs.writeFileSync(DB_PATH+'.tmp', JSON.stringify(DB,null,2)); fs.renameSync(DB_PATH+'.tmp', DB_PATH); }
    catch(e){ console.error('DB write failed', e); }
    writePending = false;
  }, 250);
}
function sha(s){ return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function uid(){ return crypto.randomBytes(8).toString('hex'); }
function now(){ return new Date().toISOString(); }
function token(){ return crypto.randomBytes(24).toString('hex'); }

/* ══ Response helpers ══ */
function send(res, code, body, headers={}){
  const isJSON = typeof body === 'object' && !(body instanceof Buffer);
  res.writeHead(code, {
    'Content-Type': isJSON ? 'application/json; charset=utf-8' : (headers['Content-Type']||'text/plain'),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-token, x-username, x-admin-password',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    ...headers
  });
  if (body === null || body === undefined) return res.end();
  res.end(isJSON ? JSON.stringify(body) : body);
}
function readBody(req){
  return new Promise((resolve,reject)=>{
    let data=''; req.on('data',c=>{ data+=c; if(data.length>5e6){ req.destroy(); reject(new Error('body too large')); }});
    req.on('end',()=>{ try{ resolve(data?JSON.parse(data):{}); }catch{ resolve({}); }});
    req.on('error',reject);
  });
}
function readLargeBody(req, maxMB=20){
  return new Promise((resolve,reject)=>{
    const chunks=[]; let total=0; const max=maxMB*1024*1024;
    req.on('data',c=>{ chunks.push(c); total+=c.length; if(total>max){ req.destroy(); reject(new Error('body too large')); }});
    req.on('end',()=>{ try{ resolve(JSON.parse(Buffer.concat(chunks).toString())); }catch{ resolve({}); }});
    req.on('error',reject);
  });
}

/* ══ Persistent sessions ══ */
if (!DB.sessions) DB.sessions = {};
const SESSIONS = new Map(); // token → username (hot cache)
// Load valid sessions from DB into memory on startup
(()=>{
  const cutoff = Date.now();
  let cleaned = 0;
  for (const [tok, s] of Object.entries(DB.sessions)) {
    if (s.expires > cutoff) { SESSIONS.set(tok, s.username); }
    else { delete DB.sessions[tok]; cleaned++; }
  }
  if (cleaned) persist();
})();
// Cleanup expired sessions every 30 min
setInterval(()=>{
  const cutoff = Date.now(); let changed = false;
  for (const [tok, s] of Object.entries(DB.sessions)) {
    if (s.expires <= cutoff) { delete DB.sessions[tok]; SESSIONS.delete(tok); changed = true; }
  }
  if (changed) persist();
}, 30 * 60 * 1000);

function createSession(username, rememberMe=false){
  const tok = token();
  const ttl = rememberMe ? 30*24*3600*1000 : 24*3600*1000;
  SESSIONS.set(tok, username);
  DB.sessions[tok] = { username, expires: Date.now()+ttl, created_at: now() };
  persist();
  return tok;
}
function deleteSession(tok){
  SESSIONS.delete(tok);
  if (tok && DB.sessions[tok]) { delete DB.sessions[tok]; persist(); }
}

/* ══ Rate limiting (in-memory) ══ */
const LOGIN_FAILS = new Map(); // username → {count, lockedUntil}
function rateLimitCheck(username){
  const e = LOGIN_FAILS.get(username);
  if (!e) return null;
  if (e.lockedUntil && Date.now() < e.lockedUntil)
    return `الحساب مقفل — انتظر ${Math.ceil((e.lockedUntil-Date.now())/60000)} دقيقة`;
  return null;
}
function recordFail(username){
  const e = LOGIN_FAILS.get(username) || {count:0, lockedUntil:0};
  e.count++;
  if (e.count >= 5){ e.lockedUntil = Date.now()+15*60*1000; e.count=0; }
  LOGIN_FAILS.set(username, e);
}
function clearFails(username){ LOGIN_FAILS.delete(username); }

/* ══ Auth helpers ══ */
function authUser(req){
  const t = req.headers['x-token'], u = req.headers['x-username'];
  if (!t || !u) return null;
  // Check session is valid and not expired
  const sess = DB.sessions[t];
  if (!sess || sess.username !== u || sess.expires <= Date.now()){ SESSIONS.delete(t); return null; }
  if (SESSIONS.get(t) !== u) return null;
  return DB.users[u] || null;
}
function isAdmin(req){
  const pw = req.headers['x-admin-password'];
  if (!pw) return false;
  return sha(pw) === DB.admin.password_hash;
}

/* ══ MIME ══ */
const MIME = {'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.ico':'image/x-icon'};
function serveStatic(req,res,pathname){
  // Strip cache-busting query params (e.g. ?v=123)
  const cleanPath = pathname.split('?')[0];
  let fp = path.join(PUBLIC, cleanPath==='/'?'/index.html':cleanPath);
  if (!fp.startsWith(PUBLIC)) return send(res,403,'forbidden');
  fs.stat(fp,(err,st)=>{
    if (err || st.isDirectory()) { fp = path.join(PUBLIC,'index.html'); }
    fs.readFile(fp,(e,buf)=>{
      if(e) return send(res,404,'not found');
      const ext = path.extname(fp);
      const headers = {
        'Content-Type': MIME[ext]||'application/octet-stream',
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      };
      send(res,200,buf,headers);
    });
  });
}

/* ══════════════════════════════════════════════
   ROUTES
══════════════════════════════════════════════ */
const ROUTES = {};
function R(method, path, fn){ ROUTES[method+' '+path] = fn; }

/* ── AUTH ── */
R('POST','/qqc/auth/register', async (req,res)=>{
  const b = await readBody(req);
  const u = String(b.username||'').toLowerCase().trim();
  const p = String(b.password||'');
  if (!/^[a-z0-9_]{3,20}$/.test(u) || p.length<4) return send(res,400,{error:'invalid_input'});
  if (DB.users[u]) return send(res,409,{error:'username_taken'});
  const rememberMe = !!b.remember_me;
  DB.users[u] = {
    username:u, password_hash:sha(p),
    display_name: b.display_name || u,
    created_at: now(), last_active: now(),
    avatar_color: '#'+((u.charCodeAt(0)*7919)%0xFFFFFF).toString(16).padStart(6,'0'),
    bio: '', is_banned: false,
    sheikh_verified: false,
    sheikh_requested: false,
    onboarding:{ completed:false },
    plan: null,
    progress:{ total_pages_memorized:0, total_sessions_completed:0, current_streak_days:0, longest_streak_days:0, last_session_date:null, juz_completed:[], current_juz:1, current_page_in_juz:1, total_absences:0, consecutive_absences:0 },
    sessions:[],
    review_system:{ active:false },
    energy:{ score:75, friction:0, afi:100, history:[75] },
    sr_state:{},
    ml_state:null,
    friends:[], friend_requests_sent:[], friend_requests_received:[],
    voice_permissions_granted:[],
    notifications:[],
    posts:[],
    login_history:[],
  };
  DB.admin.stats.total_users = Object.keys(DB.users).length;
  const tok = createSession(u, rememberMe);
  send(res,200,{ok:true, token:tok, username:u, remember_me:rememberMe});
});

R('POST','/qqc/auth/login', async (req,res)=>{
  const b = await readBody(req);
  const u = String(b.username||'').toLowerCase().trim();
  // Rate limit check
  const lockMsg = rateLimitCheck(u);
  if (lockMsg) return send(res,429,{error:'rate_limited', message:lockMsg});
  const user = DB.users[u];
  if (!user || user.password_hash !== sha(String(b.password||''))){
    recordFail(u);
    const fails = LOGIN_FAILS.get(u);
    const remaining = fails ? Math.max(0, 5 - fails.count) : 4;
    return send(res,401,{error:'bad_credentials', attempts_remaining: remaining});
  }
  if (user.is_banned) return send(res,403,{error:'banned'});
  clearFails(u);
  const rememberMe = !!b.remember_me;
  user.last_active = now();
  // Save login history (keep last 10)
  if (!user.login_history) user.login_history = [];
  user.login_history.push({ at: now(), remember_me: rememberMe });
  if (user.login_history.length > 10) user.login_history = user.login_history.slice(-10);
  const tok = createSession(u, rememberMe);
  send(res,200,{ok:true, token:tok, username:u, remember_me:rememberMe, last_login: user.login_history.slice(-2)[0]?.at || null});
});

R('POST','/qqc/auth/logout', async (req,res)=>{
  const t = req.headers['x-token']; if (t) deleteSession(t);
  send(res,200,{ok:true});
});


R('GET','/qqc/auth/check-username', async (req,res,_,q)=>{
  const u = String(q.username||'').toLowerCase().trim();
  if (!/^[a-z0-9_]{3,20}$/.test(u)) return send(res,200,{available:false,reason:'invalid'});
  if (DB.users[u]) return send(res,200,{available:false,reason:'taken'});
  send(res,200,{available:true});
});

/* ── ONBOARDING & PROFILE ── */
R('POST','/qqc/onboarding', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const b = await readBody(req);
  u.onboarding = {
    completed:true,
    daily_minutes: +b.daily_minutes||30,
    goal_months: +b.goal_months||24,
    preferred_time: b.preferred_time||'after_fajr',
    learning_style: b.learning_style||'auditory',
    current_level: b.current_level||'beginner',
    plan_type: b.plan_type||'quantum_auto',
  };
  u.plan = {
    type: u.onboarding.plan_type,
    start_date: now(),
    current_daily_pages: u.onboarding.current_level==='beginner'?0.25:u.onboarding.current_level==='intermediate'?0.5:1,
    phase:'ramp_up', phase_start_date:now(), phase_days_elapsed:0,
    manual_override:false, override_target:null, weekly_off_days:[5],
  };
  persist();
  send(res,200,{ok:true, user:safeUser(u)});
});

R('GET','/qqc/me', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  // Ensure new fields exist on old users
  if(u.sheikh_verified===undefined) u.sheikh_verified=false;
  if(u.sheikh_requested===undefined) u.sheikh_requested=false;
  send(res,200,{user:safeUser(u)});
});

R('PATCH','/qqc/me', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const b = await readBody(req);
  if (typeof b.display_name==='string') u.display_name=b.display_name.slice(0,40);
  if (typeof b.bio==='string') u.bio=b.bio.slice(0,300);
  if (typeof b.avatar_color==='string' && /^#[0-9a-f]{6}$/i.test(b.avatar_color)) u.avatar_color=b.avatar_color;
  if (typeof b.avatar_emoji==='string') u.avatar_emoji=b.avatar_emoji.slice(0,8)||null;
  if (typeof b.avatar_url==='string'){
    if (b.avatar_url==='' || b.avatar_url==='remove'){
      u.avatar_url = null;
    } else if (/^data:image\/(jpeg|png|webp|gif);base64,/.test(b.avatar_url) && b.avatar_url.length<400000){
      u.avatar_url = b.avatar_url;
    }
  }
  if (typeof b.plan_mode==='string' && ['both','memorization_only','review_only'].includes(b.plan_mode)){
    if(!u.onboarding) u.onboarding={};
    u.onboarding.plan_mode = b.plan_mode;
  }
  if (b.quran_settings && typeof b.quran_settings==='object'){
    u.quran_settings = {
      sheikh: String(b.quran_settings.sheikh||'ar.alafasy').slice(0,50),
      loop: +b.quran_settings.loop||1,
      ayah_repeat: +b.quran_settings.ayah_repeat||1,
    };
  }
  // Username change
  if (typeof b.new_username==='string'){
    const newU = b.new_username.toLowerCase().trim();
    if (/^[a-z0-9_]{3,20}$/.test(newU) && newU!==u.username){
      if (DB.users[newU]) return send(res,409,{error:'username_taken'});
      const oldU = u.username;
      DB.users[newU] = {...u, username:newU};
      delete DB.users[oldU];
      // Update references
      Object.values(DB.users).forEach(usr=>{
        if(usr.friends) usr.friends=usr.friends.map(f=>f===oldU?newU:f);
        if(usr.friend_requests_sent) usr.friend_requests_sent=usr.friend_requests_sent.map(f=>f===oldU?newU:f);
        if(usr.friend_requests_received) usr.friend_requests_received=usr.friend_requests_received.map(f=>f===oldU?newU:f);
      });
      DB.posts.forEach(p=>{ if(p.author===oldU) p.author=newU; });
      const tok = req.headers['x-token'];
      if(tok) SESSIONS.set(tok, newU);
      persist();
      return send(res,200,{ok:true, user:safeUser(DB.users[newU]), username_changed:true, new_username:newU});
    }
  }
  persist(); send(res,200,{ok:true,user:safeUser(u)});
});

R('GET','/qqc/profile/:username', async (req,res,p)=>{
  const target = DB.users[p.username];
  if (!target) return send(res,404,{error:'not_found'});
  send(res,200,{
    profile: {
      username: target.username,
      display_name: target.display_name,
      avatar_color: target.avatar_color,
      bio: target.bio,
      created_at: target.created_at,
      progress: target.progress,
      friends_count: target.friends.length,
      posts: target.posts.slice(-50),
    }
  });
});

/* ── SENSOR / DECISION ── */
R('POST','/qqc/process-state', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const sensors = await readBody(req);
  const decision = AI.decide(u, sensors, ALERTS);
  // persist energy & ml
  u.energy.score = decision.energy;
  u.energy.friction = decision.friction;
  u.energy.afi = decision.afi;
  u.energy.history = (u.energy.history||[]).concat(decision.energy).slice(-10);
  u.ml_state = decision.ml_state;
  u.last_active = now();
  persist();
  send(res,200, decision);
});

/* ── SESSIONS ── */
R('POST','/qqc/session/complete', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const b = await readBody(req);
  const today = now().slice(0,10);
  const sess = {
    date: now(),
    pages_done: +b.pages_done||0,
    difficulty: b.difficulty||'medium',
    duration_minutes: +b.duration_minutes||0,
    technique_used: b.technique_used||null,
    mood_score: +b.mood_score||5,
  };
  u.sessions = (u.sessions||[]).concat(sess).slice(-90);
  u.progress.total_sessions_completed++;
  u.progress.total_pages_memorized = +(u.progress.total_pages_memorized + sess.pages_done).toFixed(2);
  // streak
  const last = u.progress.last_session_date;
  if (last !== today) {
    const yest = new Date(Date.now()-864e5).toISOString().slice(0,10);
    u.progress.current_streak_days = (last===yest) ? u.progress.current_streak_days+1 : 1;
    if (u.progress.current_streak_days>u.progress.longest_streak_days) u.progress.longest_streak_days=u.progress.current_streak_days;
    u.progress.last_session_date = today;
    u.progress.consecutive_absences = 0;
  }
  // SR update
  const juz = u.progress.current_juz;
  u.sr_state[juz] = AI.SR.update(u.sr_state[juz], sess.difficulty);
  // plan adaptation
  const planRec = AI.PlanAdapter.recompute(u);
  if (planRec && planRec.delta!==0) {
    u.plan.current_daily_pages = planRec.target;
    u.plan.phase = planRec.reason;
    u.plan.phase_start_date = now();
  }
  DB.admin.stats.total_sessions_today = (DB.admin.stats.total_sessions_today||0)+1;
  DB.admin.stats.total_pages_memorized_alltime = +(DB.admin.stats.total_pages_memorized_alltime+sess.pages_done).toFixed(2);
  persist();
  send(res,200,{ok:true, session:sess, plan_recommendation:planRec, sr:u.sr_state[juz]});
});

R('GET','/qqc/plan', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const preview = AI.PlanAdapter.preview(u, 30);
  const rec = AI.PlanAdapter.recompute(u);
  send(res,200,{plan:u.plan, preview, recommendation:rec, sr_state:u.sr_state});
});

R('PATCH','/qqc/plan', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const b = await readBody(req);
  if (typeof b.current_daily_pages==='number') u.plan.current_daily_pages = b.current_daily_pages;
  if (typeof b.manual_override==='boolean') u.plan.manual_override = b.manual_override;
  if (Array.isArray(b.weekly_off_days)) u.plan.weekly_off_days = b.weekly_off_days;
  persist(); send(res,200,{ok:true, plan:u.plan});
});

/* ── POSTS (lightweight: text + optional small thumbnail; large media stays client) ── */
R('POST','/qqc/posts', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const b = await readBody(req);
  const text = String(b.text||'').slice(0,1000);
  const thumb = typeof b.thumb==='string' ? b.thumb.slice(0,8000) : null; // small base64 thumb only
  const local_ref = b.local_ref || null; // pointer to user's IndexedDB blob
  if (!text && !thumb && !local_ref) return send(res,400,{error:'empty'});
  const post = { id: uid(), author:u.username, text, thumb, local_ref, created_at: now(), likes: [] };
  u.posts.push(post);
  DB.posts.push(post);
  if (DB.posts.length > 5000) DB.posts = DB.posts.slice(-5000);
  persist(); send(res,200,{ok:true, post});
});

R('GET','/qqc/posts/feed', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const friends = new Set([u.username, ...(u.friends||[])]);
  const items = DB.posts.filter(p=>friends.has(p.author)).slice(-100).reverse();
  send(res,200,{posts:items});
});

R('GET','/qqc/posts', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const items = DB.posts.slice(-200).reverse();
  send(res,200,{posts:items});
});

R('POST','/qqc/posts/:id/comment', async (req,res,p)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const b = await readBody(req);
  const text = String(b.text||'').trim().slice(0,500);
  if (!text) return send(res,400,{error:'empty'});
  const post = DB.posts.find(x=>x.id===p.id); if (!post) return send(res,404,{error:'not_found'});
  if (!post.comments) post.comments=[];
  const comment = {id:uid(), from:u.username, text, created_at:now()};
  post.comments.push(comment);
  if (post.comments.length>50) post.comments=post.comments.slice(-50);
  const owner=DB.users[post.author];
  if(owner){ const op=owner.posts.find(x=>x.id===p.id); if(op){ if(!op.comments) op.comments=[]; op.comments=post.comments.slice(); } }
  persist(); send(res,200,{ok:true, comment});
});

R('POST','/qqc/posts/:id/like', async (req,res,p)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const post = DB.posts.find(x=>x.id===p.id); if (!post) return send(res,404,{error:'not_found'});
  const i = post.likes.indexOf(u.username);
  if (i<0) post.likes.push(u.username); else post.likes.splice(i,1);
  // mirror in author posts
  const owner = DB.users[post.author];
  if (owner) { const op = owner.posts.find(x=>x.id===p.id); if (op) op.likes = post.likes.slice(); }
  persist(); send(res,200,{ok:true, likes: post.likes.length});
});

R('DELETE','/qqc/posts/:id', async (req,res,p)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const idx = DB.posts.findIndex(x=>x.id===p.id);
  if (idx<0) return send(res,404,{error:'not_found'});
  if (DB.posts[idx].author !== u.username) return send(res,403,{error:'not_owner'});
  const post = DB.posts.splice(idx,1)[0];
  const owner = DB.users[post.author];
  if (owner) owner.posts = owner.posts.filter(x=>x.id!==p.id);
  persist(); send(res,200,{ok:true});
});

/* ── FRIENDS ── */
R('POST','/qqc/friends/request', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const b = await readBody(req);
  const target = DB.users[String(b.username||'').toLowerCase()];
  if (!target || target.username===u.username) return send(res,400,{error:'bad_target'});
  if (u.friends.includes(target.username)) return send(res,409,{error:'already_friends'});
  if (!target.friend_requests_received.includes(u.username)) target.friend_requests_received.push(u.username);
  if (!u.friend_requests_sent.includes(target.username)) u.friend_requests_sent.push(target.username);
  persist(); send(res,200,{ok:true});
});

R('POST','/qqc/friends/accept', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const b = await readBody(req);
  const from = DB.users[String(b.username||'').toLowerCase()];
  if (!from) return send(res,404,{error:'not_found'});
  if (!u.friend_requests_received.includes(from.username)) return send(res,400,{error:'no_request'});
  u.friend_requests_received = u.friend_requests_received.filter(x=>x!==from.username);
  from.friend_requests_sent  = from.friend_requests_sent.filter(x=>x!==u.username);
  if (!u.friends.includes(from.username))    u.friends.push(from.username);
  if (!from.friends.includes(u.username))    from.friends.push(u.username);
  addNotif(from.username,'friend_accepted',`✅ قَبِل @${u.username} طلب صداقتك`,'view-friends');
  persist(); send(res,200,{ok:true});
});

R('POST','/qqc/friends/remove', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const b = await readBody(req);
  const other = DB.users[String(b.username||'').toLowerCase()];
  if (!other) return send(res,404,{error:'not_found'});
  u.friends = u.friends.filter(x=>x!==other.username);
  other.friends = other.friends.filter(x=>x!==u.username);
  persist(); send(res,200,{ok:true});
});

R('GET','/qqc/friends', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  send(res,200,{
    friends: u.friends.map(n=>{const f=DB.users[n]; return f?{username:f.username,display_name:f.display_name,avatar_color:f.avatar_color,last_active:f.last_active}:{username:n};}),
    requests_received: u.friend_requests_received,
    requests_sent: u.friend_requests_sent,
  });
});

R('GET','/qqc/users/search', async (req,res,_,q)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const term = String(q.q||'').toLowerCase();
  if (!term) return send(res,200,{users:[]});
  const list = Object.values(DB.users)
    .filter(x=>!x.is_banned && (x.username.includes(term) || x.display_name.toLowerCase().includes(term)))
    .slice(0,20)
    .map(x=>({username:x.username,display_name:x.display_name,avatar_color:x.avatar_color}));
  send(res,200,{users:list});
});

/* ── CHAT (1:1) ── */
function chatId(a,b){ return [a,b].sort().join('_'); }

R('GET','/qqc/chat/:username', async (req,res,p)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const other = p.username; if (!DB.users[other]) return send(res,404,{error:'not_found'});
  const id = chatId(u.username, other);
  const c = DB.chats[id] || {participants:[u.username,other], messages:[], last_message_at:null};
  send(res,200,{chat:c});
});

R('POST','/qqc/chat/:username', async (req,res,p)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const other = p.username; if (!DB.users[other]) return send(res,404,{error:'not_found'});
  const b = await readBody(req);
  // voice messages require prior permission from recipient
  if (b.type==='voice') {
    const recipient = DB.users[other];
    if (!recipient.voice_permissions_granted.includes(u.username))
      return send(res,403,{error:'voice_not_permitted'});
  }
  const id = chatId(u.username, other);
  if (!DB.chats[id]) DB.chats[id] = {participants:[u.username,other], messages:[], last_message_at:null};
  const msg = {
    id: uid(), from: u.username,
    text: typeof b.text==='string' ? b.text.slice(0,2000) : '',
    type: b.type||'text',
    voice_local_ref: b.voice_local_ref || null,  // ref into sender's IndexedDB; receiver fetches via P2P-ish flow (out of scope, kept as ref)
    duration_ms: +b.duration_ms||0,
    timestamp: now(), read: false,
  };
  DB.chats[id].messages.push(msg);
  if (DB.chats[id].messages.length>1000) DB.chats[id].messages = DB.chats[id].messages.slice(-1000);
  DB.chats[id].last_message_at = msg.timestamp;
  persist();
  send(res,200,{ok:true, message:msg});
});

R('GET','/qqc/chats', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const out = [];
  for (const id in DB.chats) {
    const c = DB.chats[id];
    if (!c.participants.includes(u.username)) continue;
    const other = c.participants.find(x=>x!==u.username);
    const last = c.messages[c.messages.length-1] || null;
    out.push({chat_id:id, other, last, unread: c.messages.filter(m=>!m.read && m.from!==u.username).length});
  }
  out.sort((a,b)=>(b.last?.timestamp||'').localeCompare(a.last?.timestamp||''));
  send(res,200,{chats:out});
});

/* ── VOICE PERMISSIONS ── */
R('POST','/qqc/voice/permit', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const b = await readBody(req);
  const friend = String(b.username||'').toLowerCase();
  if (!DB.users[friend]) return send(res,404,{error:'not_found'});
  if (!u.friends.includes(friend)) return send(res,403,{error:'not_friend'});
  if (!u.voice_permissions_granted.includes(friend)) u.voice_permissions_granted.push(friend);
  persist(); send(res,200,{ok:true});
});

R('POST','/qqc/voice/revoke', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const b = await readBody(req);
  u.voice_permissions_granted = u.voice_permissions_granted.filter(x=>x!==String(b.username||'').toLowerCase());
  persist(); send(res,200,{ok:true});
});

/* ── GROUPS ── */
R('POST','/qqc/groups', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const b = await readBody(req);
  const name = String(b.name||'مجموعة').slice(0,40);
  const members = Array.isArray(b.members)?b.members.filter(x=>DB.users[x]):[];
  if (!members.includes(u.username)) members.push(u.username);
  const id = uid();
  DB.groups[id] = { id, name, created_by:u.username, created_at:now(), members, messages:[], last_message_at:null };
  persist(); send(res,200,{ok:true, group:DB.groups[id]});
});

R('GET','/qqc/groups', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const list = Object.values(DB.groups).filter(g=>g.members.includes(u.username))
    .map(g=>({id:g.id,name:g.name,members:g.members,last:g.messages[g.messages.length-1]||null}));
  send(res,200,{groups:list});
});

R('GET','/qqc/groups/:id', async (req,res,p)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const g = DB.groups[p.id];
  if (!g || !g.members.includes(u.username)) return send(res,404,{error:'not_found'});
  send(res,200,{group:g});
});

R('POST','/qqc/groups/:id/message', async (req,res,p)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const g = DB.groups[p.id];
  if (!g || !g.members.includes(u.username)) return send(res,404,{error:'not_found'});
  const b = await readBody(req);
  const msg = {id:uid(), from:u.username, text:String(b.text||'').slice(0,2000), timestamp:now()};
  g.messages.push(msg);
  if (g.messages.length>2000) g.messages = g.messages.slice(-2000);
  g.last_message_at = msg.timestamp;
  persist(); send(res,200,{ok:true, message:msg});
});

R('POST','/qqc/groups/:id/add', async (req,res,p)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const g = DB.groups[p.id];
  if (!g || g.created_by!==u.username) return send(res,403,{error:'not_owner'});
  const b = await readBody(req);
  const target = String(b.username||'').toLowerCase();
  if (!DB.users[target]) return send(res,404,{error:'not_found'});
  if (!g.members.includes(target)) g.members.push(target);
  persist(); send(res,200,{ok:true,group:g});
});

/* ── SUPPORT TICKETS (chat with admin) ── */
R('GET','/qqc/support', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const t = DB.support_tickets[u.username] || {messages:[]};
  send(res,200,{ticket:t});
});

R('POST','/qqc/support', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const b = await readBody(req);
  if (!DB.support_tickets[u.username]) DB.support_tickets[u.username] = {messages:[], opened_at:now()};
  DB.support_tickets[u.username].messages.push({from:u.username, text:String(b.text||'').slice(0,1500), timestamp:now()});
  persist(); send(res,200,{ok:true});
});

/* ── BROADCAST (read by all users) ── */
R('GET','/qqc/broadcast', async (req,res)=>{
  const active = (DB.admin.broadcast_messages||[]).filter(m=>m.active);
  send(res,200,{messages: active.slice(-3)});
});

/* ── DATA ── */
R('GET','/qqc/data/surahs',     async (_,res)=>send(res,200,{surahs:SURAHS}));
R('GET','/qqc/data/techniques', async (_,res)=>send(res,200,{techniques:TECHS}));
R('GET','/qqc/data/alerts',     async (_,res)=>send(res,200,{alerts:ALERTS}));

/* ── LEADERBOARD ── */
R('GET','/qqc/leaderboard', async (req,res)=>{
  const top = Object.values(DB.users)
    .filter(u=>!u.is_banned)
    .map(u=>({username:u.username, display_name:u.display_name, avatar_color:u.avatar_color, pages:u.progress.total_pages_memorized||0, streak:u.progress.current_streak_days||0}))
    .sort((a,b)=>b.pages-a.pages).slice(0,50);
  send(res,200,{leaderboard:top});
});

/* ══════════════════════════════════════════════
   ADMIN ROUTES
══════════════════════════════════════════════ */
R('POST','/qqc/admin/login', async (req,res)=>{
  const b = await readBody(req);
  if (sha(String(b.password||'')) !== DB.admin.password_hash) return send(res,401,{error:'bad_password'});
  send(res,200,{ok:true});
});

R('GET','/qqc/admin/overview', async (req,res)=>{
  if (!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const users = Object.values(DB.users);
  send(res,200,{
    stats: {
      total_users: users.length,
      banned: users.filter(u=>u.is_banned).length,
      total_posts: DB.posts.length,
      total_chats: Object.keys(DB.chats).length,
      total_groups: Object.keys(DB.groups).length,
      open_tickets: Object.keys(DB.support_tickets).length,
      total_sessions_today: DB.admin.stats.total_sessions_today,
      total_pages_alltime: DB.admin.stats.total_pages_memorized_alltime,
    },
    weights: DB.admin.algorithm_weights,
    recent_users: users.slice(-20).map(u=>({username:u.username,display_name:u.display_name,last_active:u.last_active,is_banned:u.is_banned,pages:u.progress.total_pages_memorized})),
  });
});

R('GET','/qqc/admin/users', async (req,res)=>{
  if (!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  send(res,200,{users: Object.values(DB.users).map(u=>({
    username:u.username, display_name:u.display_name, created_at:u.created_at,
    last_active:u.last_active, is_banned:u.is_banned,
    pages:u.progress.total_pages_memorized, streak:u.progress.current_streak_days,
    sessions:u.progress.total_sessions_completed
  }))});
});

R('POST','/qqc/admin/user/:username/ban', async (req,res,p)=>{
  if (!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const u = DB.users[p.username]; if (!u) return send(res,404,{error:'not_found'});
  u.is_banned = true; persist(); send(res,200,{ok:true});
});

R('POST','/qqc/admin/user/:username/unban', async (req,res,p)=>{
  if (!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const u = DB.users[p.username]; if (!u) return send(res,404,{error:'not_found'});
  u.is_banned = false; persist(); send(res,200,{ok:true});
});

R('DELETE','/qqc/admin/user/:username', async (req,res,p)=>{
  if (!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  if (!DB.users[p.username]) return send(res,404,{error:'not_found'});
  delete DB.users[p.username];
  DB.posts = DB.posts.filter(x=>x.author!==p.username);
  delete DB.support_tickets[p.username];
  persist(); send(res,200,{ok:true});
});

R('DELETE','/qqc/admin/post/:id', async (req,res,p)=>{
  if (!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const idx = DB.posts.findIndex(x=>x.id===p.id);
  if (idx<0) return send(res,404,{error:'not_found'});
  const post = DB.posts.splice(idx,1)[0];
  const owner = DB.users[post.author];
  if (owner) owner.posts = owner.posts.filter(x=>x.id!==p.id);
  persist(); send(res,200,{ok:true});
});

R('GET','/qqc/admin/posts', async (req,res)=>{
  if (!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  send(res,200,{posts: DB.posts.slice(-200).reverse()});
});

R('GET','/qqc/admin/chats', async (req,res)=>{
  if (!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const list = Object.entries(DB.chats).map(([id,c])=>({
    id, participants:c.participants, last:c.messages[c.messages.length-1]||null, count:c.messages.length
  })).sort((a,b)=>(b.last?.timestamp||'').localeCompare(a.last?.timestamp||''));
  send(res,200,{chats:list});
});

R('GET','/qqc/admin/chat/:id', async (req,res,p)=>{
  if (!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const c = DB.chats[p.id]; if (!c) return send(res,404,{error:'not_found'});
  send(res,200,{chat:c});
});

R('DELETE','/qqc/admin/chat/:id/message/:mid', async (req,res,p)=>{
  if (!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const c = DB.chats[p.id]; if (!c) return send(res,404,{error:'not_found'});
  c.messages = c.messages.filter(m=>m.id!==p.mid);
  persist(); send(res,200,{ok:true});
});

R('GET','/qqc/admin/tickets', async (req,res)=>{
  if (!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  send(res,200,{tickets: Object.entries(DB.support_tickets).map(([u,t])=>({user:u,messages:t.messages,opened_at:t.opened_at}))});
});

R('POST','/qqc/admin/tickets/:user/reply', async (req,res,p)=>{
  if (!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const b = await readBody(req);
  if (!DB.support_tickets[p.user]) DB.support_tickets[p.user] = {messages:[], opened_at:now()};
  DB.support_tickets[p.user].messages.push({from:'admin', text:String(b.text||'').slice(0,2000), timestamp:now()});
  addNotif(p.user,'support_reply','💬 رد من فريق الدعم: '+String(b.text||'').slice(0,60),'view-support');
  persist(); send(res,200,{ok:true});
});

R('POST','/qqc/admin/broadcast', async (req,res)=>{
  if (!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const b = await readBody(req);
  const m = {id:uid(), message:String(b.message||'').slice(0,500), sent_at:now(), sent_by:'admin', active:true};
  DB.admin.broadcast_messages.push(m);
  if (DB.admin.broadcast_messages.length>50) DB.admin.broadcast_messages = DB.admin.broadcast_messages.slice(-50);
  persist(); send(res,200,{ok:true, message:m});
});

R('PATCH','/qqc/admin/broadcast/:id', async (req,res,p)=>{
  if (!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const m = DB.admin.broadcast_messages.find(x=>x.id===p.id);
  if (!m) return send(res,404,{error:'not_found'});
  const b = await readBody(req);
  if (typeof b.active==='boolean') m.active = b.active;
  persist(); send(res,200,{ok:true});
});

R('PATCH','/qqc/admin/weights', async (req,res)=>{
  if (!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const b = await readBody(req);
  Object.assign(DB.admin.algorithm_weights, b);
  persist(); send(res,200,{ok:true, weights: DB.admin.algorithm_weights});
});

/* ── AI Settings ── */
R('GET','/qqc/admin/ai-settings', async (req,res)=>{
  if (!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const s = DB.admin.ai_settings || {};
  const replitAvailable = !!(process.env.AI_INTEGRATIONS_OPENAI_BASE_URL && process.env.AI_INTEGRATIONS_OPENAI_API_KEY);
  const nimAvailable    = !!(s.nvidia_nim_key || process.env.NVIDIA_NIM_API_KEY);
  const activeProvider  = getActiveAIProviderName();
  send(res,200,{ settings: s, replit_available: replitAvailable, nim_available: nimAvailable, active_provider: activeProvider });
});

R('POST','/qqc/admin/ai-settings', async (req,res)=>{
  if (!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const b = await readBody(req);
  const allowed = ['primary_provider','fallback_provider','replit_model','custom_base_url','custom_api_key','custom_model','nvidia_nim_key','nvidia_nim_model','video_api_key'];
  allowed.forEach(k=>{ if(b[k] !== undefined) DB.admin.ai_settings[k] = String(b[k]).slice(0,500); });
  persist(); send(res,200,{ok:true, settings: DB.admin.ai_settings});
});

R('POST','/qqc/admin/ai-test', async (req,res)=>{
  if (!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const b = await readBody(req);
  const providerName = String(b.provider || 'replit');
  // Support ad-hoc override (for Claude proxy test)
  let cfg;
  if(b.base_url && b.api_key){
    cfg = { baseUrl: String(b.base_url), apiKey: String(b.api_key), model: String(b.model||'gpt-4o-mini') };
  } else {
    cfg = getAIProviderConfig(providerName);
  }
  if(!cfg) return send(res,200,{ok:false, error:'المزوّد غير مُعدّ أو مفاتيحه مفقودة'});
  try {
    const resp = await fetch(`${cfg.baseUrl}/chat/completions`,{
      method:'POST',
      headers:{'Authorization':`Bearer ${cfg.apiKey}`,'Content-Type':'application/json'},
      body:JSON.stringify({ model:cfg.model, messages:[{role:'user',content:'قل: جاهز — كلمة واحدة فقط'}], max_tokens:20 }),
      signal: AbortSignal.timeout(15000)
    });
    const data = await resp.json();
    const reply = data.choices?.[0]?.message?.content || null;
    if(reply) send(res,200,{ok:true, reply, provider:providerName, model:cfg.model});
    else send(res,200,{ok:false, error:'لم يرد الذكاء الاصطناعي', raw:JSON.stringify(data).slice(0,200)});
  } catch(e){ send(res,200,{ok:false, error:e.message}); }
});

/* ══ GitHub Integration Routes ══ */
R('GET','/qqc/admin/github-status', async (req,res)=>{
  if (!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const gh = DB.admin.ai_settings.github || {};
  // Never return the token itself
  send(res,200,{
    connected: !!(gh.token || process.env.GITHUB_PERSONAL_ACCESS_TOKEN),
    has_env_token: !!process.env.GITHUB_PERSONAL_ACCESS_TOKEN,
    repo_owner: gh.repo_owner || '',
    repo_name: gh.repo_name || '',
    branch: gh.branch || 'main',
    token_set: !!(gh.token)
  });
});

R('POST','/qqc/admin/github-save', async (req,res)=>{
  if (!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const b = await readBody(req);
  if(!DB.admin.ai_settings.github) DB.admin.ai_settings.github = {};
  const gh = DB.admin.ai_settings.github;
  if(b.token      !== undefined) gh.token      = String(b.token).trim().slice(0,200);
  if(b.repo_owner !== undefined) gh.repo_owner = String(b.repo_owner).trim().slice(0,100);
  if(b.repo_name  !== undefined) gh.repo_name  = String(b.repo_name).trim().slice(0,100);
  if(b.branch     !== undefined) gh.branch     = String(b.branch).trim().slice(0,100) || 'main';
  persist();
  send(res,200,{ok:true, connected:!!(gh.token||process.env.GITHUB_PERSONAL_ACCESS_TOKEN)});
});

R('POST','/qqc/admin/github-test', async (req,res)=>{
  if (!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const gh = DB.admin.ai_settings.github || {};
  const token = gh.token || process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  if(!token) return send(res,200,{ok:false, error:'لا يوجد GitHub Token — أدخله أولاً'});
  const owner = gh.repo_owner;
  const repo  = gh.repo_name;
  if(!owner || !repo) return send(res,200,{ok:false, error:'أدخل اسم المالك والريبو أولاً'});
  try {
    const r = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers:{ Authorization:`token ${token}`, 'User-Agent':'HermesAgent/2.0' },
      signal: AbortSignal.timeout(8000)
    });
    const data = await r.json();
    if(r.ok) send(res,200,{ok:true, full_name:data.full_name, private:data.private, default_branch:data.default_branch, stars:data.stargazers_count});
    else send(res,200,{ok:false, error: data.message || `HTTP ${r.status}`, tip:'تحقق من صحة الـ Token وأذونات الوصول للريبو'});
  } catch(e){ send(res,200,{ok:false, error:e.message}); }
});

R('POST','/qqc/admin/quote', async (req,res)=>{
  if (!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const b = await readBody(req);
  const q = {id:uid(), text_ar:String(b.text_ar||'').slice(0,400), category:b.category||'motivation', active:true, added_at:now()};
  DB.admin.quotes.push(q); persist(); send(res,200,{ok:true,quote:q});
});

R('DELETE','/qqc/admin/quote/:id', async (req,res,p)=>{
  if (!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  DB.admin.quotes = DB.admin.quotes.filter(q=>q.id!==p.id);
  persist(); send(res,200,{ok:true});
});

R('GET','/qqc/admin/groups', async (req,res)=>{
  if (!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  send(res,200,{groups: Object.values(DB.groups)});
});

/* ── Extra Helpers ── */
function channelCode(){ return Math.random().toString(36).substr(2,6).toUpperCase(); }
function addNotif(username, type, text, ref=''){
  const u = DB.users[username]; if(!u) return;
  if(!u.notifications) u.notifications=[];
  u.notifications.push({id:uid(), type, text, ref, read:false, created_at:now()});
  if(u.notifications.length>100) u.notifications=u.notifications.slice(-100);
}
/* ══ AI Provider System ══ */
function getAIProviderConfig(providerName){
  const s = DB.admin.ai_settings || {};
  if(providerName === 'replit'){
    const baseUrl = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
    const apiKey  = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
    if(!baseUrl || !apiKey) return null;
    return { baseUrl, apiKey, model: s.replit_model || 'gpt-5-mini' };
  }
  if(providerName === 'pollinations'){
    return { baseUrl: 'https://text.pollinations.ai/openai', apiKey: 'dummy', model: 'openai' };
  }
  if(providerName === 'claude_free'){
    return { baseUrl: 'https://text.pollinations.ai/openai', apiKey: 'dummy', model: 'claude-sonnet-4-5' };
  }
  if(providerName === 'nvidia_nim'){
    const key = s.nvidia_nim_key || process.env.NVIDIA_NIM_API_KEY;
    if(!key) return null;
    const nimModel = DB.admin.ai_settings?.nvidia_nim_model || 'meta/llama-3.3-70b-instruct';
    return { baseUrl: 'https://integrate.api.nvidia.com/v1', apiKey: key, model: nimModel };
  }
  if(providerName === 'custom'){
    if(!s.custom_base_url || !s.custom_api_key) return null;
    return { baseUrl: s.custom_base_url, apiKey: s.custom_api_key, model: s.custom_model || 'gpt-4o-mini' };
  }
  return null;
}
function getActiveAIConfig(){
  const s = DB.admin.ai_settings || {};
  const primary  = s.primary_provider  || 'replit';
  const fallback = s.fallback_provider || 'pollinations';
  const list = [primary];
  if(fallback && fallback !== 'none' && fallback !== primary) list.push(fallback);
  // Always try pollinations as last resort (truly free, no key needed)
  if(!list.includes('pollinations')) list.push('pollinations');
  for(const p of list){ const cfg = getAIProviderConfig(p); if(cfg) return cfg; }
  return null;
}
function getActiveAIProviderName(){
  const s = DB.admin.ai_settings || {};
  const primary  = s.primary_provider  || 'replit';
  const fallback = s.fallback_provider || 'pollinations';
  const list = [primary];
  if(fallback && fallback !== 'none' && fallback !== primary) list.push(fallback);
  if(!list.includes('pollinations')) list.push('pollinations');
  for(const p of list){ const cfg = getAIProviderConfig(p); if(cfg) return p; }
  return null;
}
async function callAI(systemPrompt, userMsg, maxTokens=300){
  const s = DB.admin.ai_settings || {};
  const primary  = s.primary_provider  || 'replit';
  const fallback = s.fallback_provider || 'pollinations';
  const providers = [primary];
  if(fallback && fallback !== 'none' && fallback !== primary) providers.push(fallback);
  if(!providers.includes('pollinations')) providers.push('pollinations');
  for(const providerName of providers){
    const cfg = getAIProviderConfig(providerName);
    if(!cfg){ appendLog('ai_provider_errors.jsonl',{ts:Date.now(),provider:providerName,error:'no_config',hint:'مفتاح غير محفوظ أو المزوّد غير مدعوم'}); continue; }
    try {
      const resp = await fetch(`${cfg.baseUrl}/chat/completions`,{
        method:'POST',
        headers:{'Authorization':`Bearer ${cfg.apiKey}`,'Content-Type':'application/json'},
        body:JSON.stringify({ model:cfg.model, messages:[{role:'system',content:systemPrompt},{role:'user',content:userMsg}], max_tokens:maxTokens }),
        signal:AbortSignal.timeout(25000)
      });
      if(!resp.ok){
        const errText = await resp.text().catch(()=>'');
        appendLog('ai_provider_errors.jsonl',{ts:Date.now(),provider:providerName,model:cfg.model,error:`HTTP ${resp.status}`,hint:errText.slice(0,300)});
        continue;
      }
      const data = await resp.json();
      const result = data.choices?.[0]?.message?.content || null;
      if(result) return result;
      appendLog('ai_provider_errors.jsonl',{ts:Date.now(),provider:providerName,model:cfg.model,error:'no_content',hint:JSON.stringify(data).slice(0,200)});
    } catch(e){
      console.error(`AI error (${providerName})`,e.message);
      appendLog('ai_provider_errors.jsonl',{ts:Date.now(),provider:providerName,error:e.message,type:'exception'});
    }
  }
  return null;
}

/* ── SHEIKH REQUESTS ── */
R('POST','/qqc/sheikh-request', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  if(u.sheikh_verified) return send(res,409,{error:'already_sheikh'});
  const b = await readBody(req);
  const phone = String(b.phone||'').slice(0,50);
  const bio   = String(b.bio||'').slice(0,500);
  const time_pref = String(b.time_pref||'').slice(0,100);
  if(!phone && !bio) return send(res,400,{error:'info_required'});
  DB.admin.sheikh_requests[u.username] = {
    username: u.username, display_name: u.display_name,
    phone, bio, time_pref,
    submitted_at: now(), status: 'pending',
    pages: u.progress?.total_pages_memorized||0,
    sessions: u.progress?.total_sessions_completed||0,
  };
  u.sheikh_requested = true;
  persist();
  send(res,200,{ok:true});
});

R('GET','/qqc/sheikh-request/status', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const req2 = DB.admin.sheikh_requests[u.username]||null;
  send(res,200,{verified:u.sheikh_verified, requested:u.sheikh_requested, request:req2});
});

R('GET','/qqc/admin/sheikh-requests', async (req,res)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  send(res,200,{requests: Object.values(DB.admin.sheikh_requests)});
});

R('POST','/qqc/admin/sheikh-requests/:username/approve', async (req,res,p)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const u = DB.users[p.username]; if(!u) return send(res,404,{error:'not_found'});
  u.sheikh_verified = true;
  u.sheikh_requested = false;
  if(DB.admin.sheikh_requests[p.username]) DB.admin.sheikh_requests[p.username].status='approved';
  addNotif(p.username,'sheikh_approved','🏅 تهانينا! تمت الموافقة على طلبك وأصبحت شيخاً مُعتمداً. يمكنك الآن إنشاء شُعبتك.','view-channels');
  persist(); send(res,200,{ok:true});
});

R('POST','/qqc/admin/sheikh-requests/:username/reject', async (req,res,p)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const b = await readBody(req);
  const u = DB.users[p.username];
  if(u){ u.sheikh_requested = false; }
  if(DB.admin.sheikh_requests[p.username]) DB.admin.sheikh_requests[p.username].status='rejected';
  addNotif(p.username,'sheikh_rejected','❌ عذراً، لم تُوافَق على طلب الشيخ في هذه المرة. '+(b.reason||''),'view-support');
  persist(); send(res,200,{ok:true});
});

/* ── MEMORIZATION PLANS (admin-created, public) ── */
R('GET','/qqc/plans', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  send(res,200,{plans: (DB.admin.memorization_plans||[])});
});

R('POST','/qqc/admin/plans', async (req,res)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const b = await readBody(req);
  const name = String(b.name||'').slice(0,80); if(!name) return send(res,400,{error:'name_required'});
  const plan = {
    id: uid(),
    name,
    daily_pages: Math.max(0.25, Math.min(+b.daily_pages||0.5, 10)),
    mode: ['both','memorization_only','review_only'].includes(b.mode)?b.mode:'both',
    description: String(b.description||'').slice(0,500),
    target_level: String(b.target_level||'all').slice(0,20),
    created_at: now(),
  };
  if(!DB.admin.memorization_plans) DB.admin.memorization_plans=[];
  DB.admin.memorization_plans.push(plan);
  persist(); send(res,200,{ok:true,plan});
});

R('DELETE','/qqc/admin/plans/:id', async (req,res,p)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  DB.admin.memorization_plans=(DB.admin.memorization_plans||[]).filter(x=>x.id!==p.id);
  persist(); send(res,200,{ok:true});
});

/* ── AI PLAN GENERATOR ── */
R('POST','/qqc/plan/generate', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const b = await readBody(req);
  const total_pages = Math.max(1, Math.min(+b.total_pages||20, 604));
  const duration_days = Math.max(7, Math.min(+b.duration_days||30, 3650));
  const from_page = Math.max(1, Math.min(+b.from_page||1, 604));
  const daily_available_min = Math.max(5, +b.daily_minutes||30);

  // Rule-based intelligent plan generation
  // Step 1: raw daily target
  const rawDaily = total_pages / duration_days;
  // Step 2: round to nearest 0.25
  const round025 = v => Math.round(v * 4) / 4;
  const daily_mem = Math.max(0.25, round025(rawDaily));

  // Step 3: Adjusted duration (accounting for review days)
  // Every 10 pages memorized, add a 2-day review block
  const review_blocks = Math.floor(total_pages / 10);
  const effective_days = duration_days - (review_blocks * 2);
  const daily_mem_adj = Math.max(0.25, round025(total_pages / Math.max(effective_days, duration_days * 0.7)));

  // Step 4: Review plan — spaced repetition: review pages memorized in last 30 days daily
  const daily_review = Math.max(0, round025(daily_available_min / 20 - daily_mem_adj));

  // Step 5: Build 30-day preview
  const preview = [];
  let pagesMemorized = u.progress?.total_pages_memorized || 0;
  let reviewBuffer = 0;
  for(let day = 1; day <= 30; day++){
    const isReviewDay = reviewBuffer >= 10;
    if(isReviewDay){ preview.push({day, type:'مراجعة', pages: daily_review||0.5, cumulative: pagesMemorized}); reviewBuffer = 0; }
    else { preview.push({day, type:'حفظ', pages: daily_mem_adj, cumulative: +(pagesMemorized + daily_mem_adj).toFixed(2)}); pagesMemorized = +(pagesMemorized + daily_mem_adj).toFixed(2); reviewBuffer += daily_mem_adj; }
  }

  // Determine mode
  const mode = +b.review_also ? 'both' : 'memorization_only';

  // Try AI enhancement
  const aiNote = await callAI(
    `أنت مخطط حفظ قرآني خبير. بناءً على بيانات المستخدم قدِّم ملاحظة تشجيعية واحدة (جملة واحدة) للخطة المُنشأة.`,
    `المستخدم يريد حفظ ${total_pages} صفحة من الصفحة ${from_page} في ${duration_days} يوماً. الهدف اليومي: ${daily_mem_adj} صفحة.`
  );

  const generated = {
    from_page, to_page: from_page + total_pages - 1,
    total_pages, duration_days,
    daily_memorization_pages: daily_mem_adj,
    daily_review_pages: mode==='both' ? daily_review : 0,
    review_days_every: 10,
    mode, preview,
    ai_note: aiNote || `خطة دقيقة ومتوازنة: ${daily_mem_adj} صفحة يومياً تُوصلك لهدفك في ${duration_days} يوماً بإذن الله.`,
    generated_at: now(),
  };

  // Auto-apply to user plan if requested
  if(b.apply){
    if(!u.plan) u.plan = {};
    u.plan.current_daily_pages = daily_mem_adj;
    u.plan.manual_override = true;
    u.plan.override_target = daily_mem_adj;
    u.plan.generated_plan = generated;
    if(mode) { if(!u.onboarding) u.onboarding={}; u.onboarding.plan_mode = mode; }
    persist();
  }
  send(res,200,{ok:true, plan: generated});
});

/* ── CHANNELS (شعبة) ── */
R('POST','/qqc/channels', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  if(!u.sheikh_verified) return send(res,403,{error:'not_verified_sheikh'});
  const b = await readBody(req);
  const name = String(b.name||'').trim().slice(0,50); if(!name) return send(res,400,{error:'name_required'});
  const id = uid();
  DB.channels[id] = {
    id, name,
    description: String(b.description||'').slice(0,300),
    sheikh_username: u.username,
    join_code: channelCode(),
    max_members: Math.min(+b.max_members||200, 1000),
    is_public: b.is_public !== false,
    members: [u.username],
    announcements: [],
    messages: [],
    plan_override: null,
    plan_template: null,
    invite_tokens: [],
    review_sessions: [],
    created_at: now(),
    last_message_at: null,
  };
  persist();
  send(res,200,{ok:true, channel:DB.channels[id]});
});

R('GET','/qqc/channels', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const list = Object.values(DB.channels).filter(c=>c.members.includes(u.username));
  send(res,200,{channels: list.map(c=>({
    id:c.id, name:c.name, description:c.description,
    sheikh_username:c.sheikh_username, member_count:c.members.length,
    max_members:c.max_members, is_sheikh:c.sheikh_username===u.username,
    last_message_at:c.last_message_at,
    last:c.messages[c.messages.length-1]||null,
    join_code:c.sheikh_username===u.username?c.join_code:undefined,
  }))});
});

R('GET','/qqc/channels/discover', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const open = Object.values(DB.channels)
    .filter(c=>c.is_public && !c.members.includes(u.username) && c.members.length < c.max_members)
    .slice(0,50)
    .map(c=>({id:c.id,name:c.name,description:c.description,member_count:c.members.length,max_members:c.max_members,sheikh_username:c.sheikh_username}));
  send(res,200,{channels:open});
});

R('POST','/qqc/channels/join', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const b = await readBody(req);
  const code = String(b.code||'').toUpperCase().trim();
  // Check regular join_code first
  let ch = Object.values(DB.channels).find(c=>c.join_code===code);
  let inviteTok = null;
  if(!ch){
    // Check personal invite tokens
    for(const c of Object.values(DB.channels)){
      const tok = (c.invite_tokens||[]).find(t=>t.token===code && !t.used_by);
      if(tok){ ch=c; inviteTok=tok; break; }
    }
  }
  if(!ch) return send(res,404,{error:'invalid_code'});
  if(ch.members.includes(u.username)) return send(res,409,{error:'already_member'});
  if(ch.members.length>=ch.max_members) return send(res,403,{error:'channel_full'});
  if(inviteTok){
    if(inviteTok.target_username && inviteTok.target_username!==u.username) return send(res,403,{error:'invite_not_for_you'});
    inviteTok.used_by=u.username; inviteTok.used_at=now();
  }
  ch.members.push(u.username);
  addNotif(ch.sheikh_username,'channel_join',`انضمّ @${u.username} إلى شُعبة ${ch.name}`,ch.id);
  persist();
  send(res,200,{ok:true, channel:{id:ch.id,name:ch.name}});
});

R('GET','/qqc/channels/:id', async (req,res,p)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const ch = DB.channels[p.id];
  if(!ch || !ch.members.includes(u.username)) return send(res,404,{error:'not_found'});
  const isS = ch.sheikh_username===u.username;
  const memberDetails = ch.members.map(m=>{
    const mu=DB.users[m];
    return mu?{username:mu.username,display_name:mu.display_name,avatar_color:mu.avatar_color,
      pages:mu.progress?.total_pages_memorized||0,streak:mu.progress?.current_streak_days||0,
      is_sheikh:m===ch.sheikh_username}:{username:m,is_sheikh:m===ch.sheikh_username};
  });
  send(res,200,{channel:{
    id:ch.id,name:ch.name,description:ch.description,
    sheikh_username:ch.sheikh_username,max_members:ch.max_members,
    is_sheikh:isS,join_code:isS?ch.join_code:undefined,
    members:memberDetails,member_count:ch.members.length,
    announcements:ch.announcements.slice(-20),
    messages:ch.messages.slice(-100),
    plan_override:ch.plan_override,
    plan_template:ch.plan_template||null,
    pending_invites:isS?(ch.invite_tokens||[]).filter(t=>!t.used_by).length:undefined,
    active_review_session:(ch.review_sessions||[]).find(s=>s.is_active)||null,
  }});
});

R('POST','/qqc/channels/:id/message', async (req,res,p)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const ch = DB.channels[p.id];
  if(!ch || !ch.members.includes(u.username)) return send(res,404,{error:'not_found'});
  const b = await readBody(req);
  const msg = {id:uid(),from:u.username,text:String(b.text||'').slice(0,2000),timestamp:now()};
  ch.messages.push(msg);
  if(ch.messages.length>2000) ch.messages=ch.messages.slice(-2000);
  ch.last_message_at=msg.timestamp;
  persist(); send(res,200,{ok:true,message:msg});
});

R('POST','/qqc/channels/:id/announce', async (req,res,p)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const ch = DB.channels[p.id];
  if(!ch || ch.sheikh_username!==u.username) return send(res,403,{error:'not_sheikh'});
  const b = await readBody(req);
  const ann = {id:uid(),text:String(b.text||'').slice(0,2000),from:u.username,timestamp:now()};
  ch.announcements.push(ann);
  if(ch.announcements.length>200) ch.announcements=ch.announcements.slice(-200);
  ch.members.filter(m=>m!==u.username).forEach(m=>
    addNotif(m,'channel_announcement',`📢 ${ch.name}: ${ann.text.slice(0,60)}`,ch.id)
  );
  persist(); send(res,200,{ok:true,announcement:ann});
});

R('PATCH','/qqc/channels/:id', async (req,res,p)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const ch = DB.channels[p.id];
  if(!ch || ch.sheikh_username!==u.username) return send(res,403,{error:'not_sheikh'});
  const b = await readBody(req);
  if(typeof b.name==='string') ch.name=b.name.slice(0,50);
  if(typeof b.description==='string') ch.description=b.description.slice(0,300);
  if(typeof b.max_members==='number') ch.max_members=Math.min(b.max_members,1000);
  if(typeof b.is_public==='boolean') ch.is_public=b.is_public;
  if(b.plan_override!==undefined) ch.plan_override=b.plan_override;
  if(b.refresh_code) ch.join_code=channelCode();
  persist(); send(res,200,{ok:true,channel:ch});
});

R('DELETE','/qqc/channels/:id/member/:username', async (req,res,p)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const ch = DB.channels[p.id];
  if(!ch || ch.sheikh_username!==u.username) return send(res,403,{error:'not_sheikh'});
  if(p.username===u.username) return send(res,400,{error:'cannot_remove_self'});
  ch.members=ch.members.filter(m=>m!==p.username);
  persist(); send(res,200,{ok:true});
});

R('POST','/qqc/channels/:id/invite-token', async (req,res,p)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const ch = DB.channels[p.id];
  if(!ch || ch.sheikh_username!==u.username) return send(res,403,{error:'not_sheikh'});
  const b = await readBody(req);
  const target = typeof b.target_username==='string'?b.target_username.trim().toLowerCase():null;
  if(target && !DB.users[target]) return send(res,404,{error:'user_not_found'});
  if(target && ch.members.includes(target)) return send(res,409,{error:'already_member'});
  if(!ch.invite_tokens) ch.invite_tokens=[];
  const token = channelCode();
  ch.invite_tokens.push({token, target_username:target||null, created_at:now(), used_by:null, used_at:null});
  if(target){
    addNotif(target,'channel_invite',`📨 دعاك الشيخ @${u.username} للانضمام إلى شُعبة "${ch.name}" — رمز الدعوة: ${token}`,p.id);
  }
  persist(); send(res,200,{ok:true, token});
});

R('GET','/qqc/channels/:id/invites', async (req,res,p)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const ch = DB.channels[p.id];
  if(!ch || ch.sheikh_username!==u.username) return send(res,403,{error:'not_sheikh'});
  send(res,200,{invites:(ch.invite_tokens||[]).slice().reverse()});
});

R('DELETE','/qqc/channels/:id/invite/:token', async (req,res,p)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const ch = DB.channels[p.id];
  if(!ch || ch.sheikh_username!==u.username) return send(res,403,{error:'not_sheikh'});
  ch.invite_tokens=(ch.invite_tokens||[]).filter(t=>t.token!==p.token);
  persist(); send(res,200,{ok:true});
});

R('POST','/qqc/channels/:id/plan-template', async (req,res,p)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const ch = DB.channels[p.id];
  if(!ch || ch.sheikh_username!==u.username) return send(res,403,{error:'not_sheikh'});
  const b = await readBody(req);
  ch.plan_template = {
    name: String(b.name||'').slice(0,100),
    daily_pages: Math.max(0.25, Math.min(+b.daily_pages||0.5, 10)),
    description: String(b.description||'').slice(0,500),
    updated_at: now(),
  };
  persist(); send(res,200,{ok:true});
});

/* ── REVIEW SESSIONS ── */
R('POST','/qqc/channels/:id/review-session', async (req,res,p)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const ch = DB.channels[p.id];
  if(!ch || ch.sheikh_username!==u.username) return send(res,403,{error:'not_sheikh'});
  const b = await readBody(req);
  const title = String(b.title||'').slice(0,100); if(!title) return send(res,400,{error:'title_required'});
  // Close any previous active session
  if(!ch.review_sessions) ch.review_sessions=[];
  ch.review_sessions.forEach(s=>{ if(s.is_active) s.is_active=false; });
  const sid = uid();
  const session = {
    id: sid,
    title,
    from_page: Math.max(1, Math.min(+b.from_page||1, 604)),
    to_page:   Math.max(1, Math.min(+b.to_page||10, 604)),
    deadline:  String(b.deadline||'').slice(0,10)||null,
    created_at: now(),
    created_by: u.username,
    is_active: true,
    completions: {},
  };
  ch.review_sessions.push(session);
  // Notify all members
  ch.members.filter(m=>m!==u.username).forEach(m=>{
    addNotif(m,'review_session',`📖 جلسة مراجعة جديدة في شُعبة "${ch.name}": ${title} (ص ${session.from_page}–${session.to_page})`,p.id);
  });
  persist(); send(res,200,{ok:true, session});
});

R('POST','/qqc/channels/:id/review-session/:sid/log', async (req,res,p)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const ch = DB.channels[p.id];
  if(!ch || !ch.members.includes(u.username)) return send(res,404,{error:'not_found'});
  const session = (ch.review_sessions||[]).find(s=>s.id===p.sid && s.is_active);
  if(!session) return send(res,404,{error:'session_not_found'});
  const b = await readBody(req);
  session.completions[u.username] = {
    pages_done: Math.max(0, +b.pages_done||0),
    notes: String(b.notes||'').slice(0,300),
    completed_at: now(),
  };
  // Notify sheikh
  addNotif(ch.sheikh_username,'review_log',`✅ @${u.username} سجّل إنجازه في جلسة "${session.title}"`,p.id);
  persist(); send(res,200,{ok:true});
});

R('DELETE','/qqc/channels/:id/review-session/:sid', async (req,res,p)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const ch = DB.channels[p.id];
  if(!ch || ch.sheikh_username!==u.username) return send(res,403,{error:'not_sheikh'});
  const s = (ch.review_sessions||[]).find(x=>x.id===p.sid);
  if(s) s.is_active=false;
  persist(); send(res,200,{ok:true});
});

R('POST','/qqc/channels/:id/leave', async (req,res,p)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const ch = DB.channels[p.id];
  if(!ch || !ch.members.includes(u.username)) return send(res,404,{error:'not_found'});
  if(ch.sheikh_username===u.username) return send(res,400,{error:'sheikh_cannot_leave'});
  ch.members=ch.members.filter(m=>m!==u.username);
  persist(); send(res,200,{ok:true});
});

/* ── NOTIFICATIONS ── */
R('GET','/qqc/notifications', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  if(!u.notifications) u.notifications=[];
  const notifs = u.notifications.slice().reverse().slice(0,50);
  send(res,200,{notifications:notifs, unread:u.notifications.filter(n=>!n.read).length});
});

R('POST','/qqc/notifications/read-all', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  (u.notifications||[]).forEach(n=>n.read=true);
  persist(); send(res,200,{ok:true});
});

/* ── AI COACH ── */
R('POST','/qqc/ai-coach', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const b = await readBody(req);
  const userMsg = String(b.message||'').slice(0,500);
  if(!userMsg) return send(res,400,{error:'empty'});
  const planMode = u.onboarding?.plan_mode||'both';
  const modeLabel = {both:'حفظ ومراجعة',memorization_only:'حفظ فقط',review_only:'مراجعة فقط'}[planMode]||'حفظ ومراجعة';
  const sysPrompt = `أنت مدرب حفظ القرآن الكريم الذكي "كوتش كوانتوم". تساعد المستخدمين في حفظ القرآن ومراجعته.\nمعلومات المستخدم:\n- الاسم: ${u.display_name}\n- المستوى: ${u.onboarding?.current_level||'مبتدئ'}\n- الصفحات المحفوظة: ${u.progress?.total_pages_memorized||0}\n- سلسلة الأيام: ${u.progress?.current_streak_days||0} يوم\n- الهدف اليومي: ${u.plan?.current_daily_pages||0.25} صفحة\n- نوع الخطة: ${modeLabel}\n- عدد الجلسات: ${u.progress?.total_sessions_completed||0}\nأجب دائماً بالعربية، مختصر ومشجع وعملي (3 أسطر كحد أقصى).`;
  const reply = await callAI(sysPrompt, userMsg);
  if(reply) return send(res,200,{reply, source:'ai'});
  const tips=['استمر في طريقك، أنت تبني شيئاً عظيماً يبقى معك للأبد!','الاستمرارية أهم من الكمية. حتى ربع صفحة يومياً تُفرّق.','راجع ما حفظت قبل أن تبدأ حفظاً جديداً — التثبيت أهم.','اقرأ بصوت عالٍ وكرر 20 مرة — يُثبّت الحفظ أكثر.','بعد الفجر أفضل وقت للحفظ والمراجعة علمياً وشرعاً.','اجعل لكل جلسة هدفاً محدداً صغيراً — ربع صفحة أو آيتين.'];
  send(res,200,{reply:tips[Math.floor(Math.random()*tips.length)], source:'local'});
});

/* ── AI RECITATION EVALUATION ── */
R('POST','/qqc/ai/evaluate-recitation', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const b = await readBody(req);
  const transcript  = String(b.transcript||'').slice(0,1000);
  const targetVerse = String(b.target_verse||'').slice(0,500);
  const surahName   = String(b.surah_name||'').slice(0,100);
  const ayahNum     = +b.ayah_num || 0;
  if (!transcript || !targetVerse) return send(res,400,{error:'missing fields'});

  // Quick word-match score (fallback if AI unavailable)
  const norm = s=>s.replace(/[\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED]/g,'').replace(/\s+/g,' ').trim();
  const wa = norm(transcript).split(' ');
  const wb = norm(targetVerse).split(' ');
  let hits=0; wa.forEach(w=>{ if(wb.some(bw=>bw===w||bw.includes(w)||w.includes(bw))) hits++; });
  const quickScore = Math.round(Math.min(1, hits/Math.max(wa.length,wb.length))*100);

  const sysPrompt = `أنت محكّم متخصص في تقييم تلاوة القرآن الكريم وأحكام التجويد. مهمتك مقارنة ما قاله المتدرب بالآية الأصلية وتقديم تقييم تفصيلي.

قواعد الإجابة:
1. ابدأ بنسبة التطابق (مثال: التطابق: 87%)
2. اذكر الكلمات الصحيحة والخاطئة
3. قدّم نصيحة تجويدية مختصرة (مخارج، مد، غنة)
4. الإجابة بالعربية فقط، لا تتجاوز 5 أسطر`;

  const userMsg = `السورة: ${surahName}، الآية: ${ayahNum}
الآية الأصلية: ${targetVerse}
ما قاله المتدرب: ${transcript}
قيّم التلاوة وحدّد نسبة الصحة من 0 إلى 100.`;

  try {
    const reply = await callAI(sysPrompt, userMsg);
    if (!reply) throw new Error('no reply');
    // Extract score from reply if present
    const scoreMatch = reply.match(/(\d{1,3})\s*%/);
    const aiScore = scoreMatch ? Math.min(100, +scoreMatch[1]) : quickScore;
    // Save as training data
    if (!u.studio_history) u.studio_history = [];
    u.studio_history.push({
      surah_name:surahName, ayah_num:ayahNum,
      transcript, target_verse:targetVerse,
      ai_score:aiScore, timestamp:now()
    });
    if (u.studio_history.length > 200) u.studio_history = u.studio_history.slice(-200);
    persist();
    return send(res,200,{ evaluation:reply, score:aiScore, source:'ai' });
  } catch(e){
    return send(res,200,{
      evaluation:`التطابق التقريبي: ${quickScore}%\nاستمر في التدريب والاستماع للشيخ لتحسين نطقك.`,
      score: quickScore, source:'local'
    });
  }
});

/* ── AI AUDIO TRANSCRIPTION (Whisper STT) ── */
R('POST','/qqc/ai/transcribe', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  let bodyData;
  try { bodyData = await readLargeBody(req, 20); } catch(e){ return send(res,413,{transcript:'',error:'audio too large'}); }
  const audio_base64 = String(bodyData.audio_base64||'');
  const mime_type    = String(bodyData.mime_type||'audio/webm');
  if (!audio_base64) return send(res,400,{transcript:'',error:'no audio'});
  const baseUrl = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  const apiKey  = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  if (!baseUrl||!apiKey) return send(res,503,{transcript:'',error:'ai_not_configured'});
  try {
    const buf = Buffer.from(audio_base64,'base64');
    const ext = mime_type.includes('mp4')||mime_type.includes('m4a') ? 'm4a' : mime_type.includes('ogg') ? 'ogg' : mime_type.includes('wav') ? 'wav' : 'webm';
    const formData = new FormData();
    formData.append('file', new Blob([buf],{type:mime_type}), `rec.${ext}`);
    formData.append('model','whisper-1');
    formData.append('language','ar');
    const resp = await fetch(`${baseUrl}/audio/transcriptions`,{method:'POST',headers:{'Authorization':`Bearer ${apiKey}`},body:formData});
    if (!resp.ok){ const t=await resp.text(); return send(res,200,{transcript:'',error:'whisper_error',detail:t.slice(0,300)}); }
    const data = await resp.json();
    return send(res,200,{transcript:data.text||'',ok:true});
  } catch(e){ console.error('Transcribe error:',e.message); return send(res,200,{transcript:'',error:e.message}); }
});

/* ── TEXT TO SPEECH (OpenAI TTS) ── */
R('POST','/qqc/ai/tts', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const b = await readBody(req);
  const text = String(b.text||'').slice(0,600);
  if (!text) return send(res,400,{error:'no_text'});
  const baseUrl = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  const apiKey  = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  if (!baseUrl||!apiKey) return send(res,503,{error:'ai_not_configured'});
  try {
    const resp = await fetch(`${baseUrl}/audio/speech`,{
      method:'POST',
      headers:{'Authorization':`Bearer ${apiKey}`,'Content-Type':'application/json'},
      body:JSON.stringify({model:'tts-1',input:text,voice:'alloy',speed:0.82})
    });
    if (!resp.ok){ const t=await resp.text(); return send(res,502,{error:'tts_failed',detail:t.slice(0,200)}); }
    const buf=Buffer.from(await resp.arrayBuffer());
    res.writeHead(200,{'Content-Type':'audio/mpeg','Access-Control-Allow-Origin':'*','Content-Length':buf.length});
    res.end(buf);
  } catch(e){ return send(res,500,{error:e.message}); }
});

/* ── HERMES LAB DIR ── */
const HERMES_LAB_DIR = path.join(ROOT,'hermes_lab');
if(!fs.existsSync(HERMES_LAB_DIR)) fs.mkdirSync(HERMES_LAB_DIR,{recursive:true});

/* ── AI TRAINING DATA (collect audio + text pairs for fine-tuning) ── */
const TRAINING_DIR = path.join(ROOT,'training_data');
if(!fs.existsSync(TRAINING_DIR)) fs.mkdirSync(TRAINING_DIR,{recursive:true});
if(!DB.admin.training_samples) DB.admin.training_samples=[];

R('POST','/qqc/ai/save-training', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  let body;
  try { body = await readLargeBody(req,20); } catch(e){ return send(res,413,{error:'too_large'}); }
  const audio_base64 = String(body.audio_base64||'');
  const correct_text = String(body.correct_text||'').slice(0,1000);
  if (!audio_base64||!correct_text) return send(res,400,{error:'missing_fields'});
  const id=uid();
  const mt=String(body.mime_type||'audio/webm');
  const ext=mt.includes('mp4')||mt.includes('m4a')?'m4a':mt.includes('ogg')?'ogg':'webm';
  const filename=`${id}.${ext}`;
  try { fs.writeFileSync(path.join(TRAINING_DIR,filename),Buffer.from(audio_base64,'base64')); }
  catch(e){ return send(res,500,{error:'save_failed'}); }
  DB.admin.training_samples.push({
    id, filename, correct_text,
    transcript:String(body.transcript||'').slice(0,1000),
    score:+body.score||null,
    quality:+body.score>=80?'good':+body.score>=50?'fair':'poor',
    surah_name:String(body.surah_name||'').slice(0,100),
    ayah_num:+body.ayah_num||0,
    username:u.username, timestamp:now()
  });
  if(DB.admin.training_samples.length>20000) DB.admin.training_samples=DB.admin.training_samples.slice(-20000);
  persist();
  send(res,200,{ok:true,id});
});

R('GET','/qqc/admin/training-data', async (req,res)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const samples=(DB.admin.training_samples||[]).slice().reverse();
  const good=samples.filter(s=>s.quality==='good').length;
  const fair=samples.filter(s=>s.quality==='fair').length;
  const poor=samples.filter(s=>s.quality==='poor').length;
  send(res,200,{samples:samples.slice(0,500),total:samples.length,stats:{good,fair,poor}});
});

R('GET','/qqc/admin/training-data/:id/audio', async (req,res,p)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const sample=(DB.admin.training_samples||[]).find(s=>s.id===p.id);
  if(!sample) return send(res,404,{error:'not_found'});
  const fp=path.join(TRAINING_DIR,sample.filename);
  if(!fs.existsSync(fp)) return send(res,404,{error:'file_not_found'});
  const buf=fs.readFileSync(fp);
  const ct=sample.filename.endsWith('m4a')?'audio/mp4':sample.filename.endsWith('ogg')?'audio/ogg':'audio/webm';
  res.writeHead(200,{'Content-Type':ct,'Access-Control-Allow-Origin':'*','Content-Length':buf.length,'Content-Disposition':`attachment;filename="${sample.filename}"`});
  res.end(buf);
});

/* ── STUDIO RECORDINGS (metadata + training data) ── */
R('GET','/qqc/studio/recordings', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  send(res,200,{ recordings: (u.studio_history||[]).slice().reverse().slice(0,50) });
});

R('POST','/qqc/studio/recording', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const b = await readBody(req);
  if (!u.studio_history) u.studio_history = [];
  u.studio_history.push({
    surah_name: String(b.surah_name||'').slice(0,100),
    ayah_num: +b.ayah_num||0,
    global_num: +b.global_num||0,
    transcript: String(b.transcript||'').slice(0,500),
    ai_score: +b.ai_score||null,
    ai_feedback: String(b.ai_feedback||'').slice(0,500),
    self_score: +b.self_score||null,
    timestamp: now()
  });
  if (u.studio_history.length > 200) u.studio_history = u.studio_history.slice(-200);
  persist();
  send(res,200,{ok:true});
});

/* ── STUDIO PROGRESS (chart data) ── */
R('GET','/qqc/studio/progress', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const raw = (u.studio_history||[]);
  // Normalize score field (ai_score OR score)
  const history = raw.map(h=>({
    surah_name: h.surah_name||'',
    ayah_num:   h.ayah_num||0,
    score:      h.ai_score ?? h.score ?? null,
    ai_feedback:h.ai_feedback||'',
    self_score: h.self_score||null,
    timestamp:  h.timestamp||0
  })).sort((a,b)=>a.timestamp-b.timestamp);
  send(res,200,{ history, total:history.length });
});

/* ── ADMIN CHANNELS ── */
R('GET','/qqc/admin/channels', async (req,res)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  send(res,200,{channels: Object.values(DB.channels).map(c=>({
    id:c.id,name:c.name,sheikh_username:c.sheikh_username,
    member_count:c.members.length,message_count:c.messages.length,
    announcement_count:c.announcements.length,join_code:c.join_code,
    is_public:c.is_public,max_members:c.max_members,
    created_at:c.created_at,last_message_at:c.last_message_at
  }))});
});

R('GET','/qqc/admin/channels/:id', async (req,res,p)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const ch = DB.channels[p.id];
  if(!ch) return send(res,404,{error:'not_found'});
  const memberDetails = ch.members.map(m=>{
    const mu = DB.users[m];
    return mu ? {
      username:mu.username, display_name:mu.display_name,
      avatar_color:mu.avatar_color, is_sheikh:m===ch.sheikh_username,
      pages:mu.progress?.total_pages_memorized||0,
      streak:mu.progress?.current_streak_days||0,
      sessions:mu.progress?.total_sessions_completed||0,
    } : {username:m, is_sheikh:m===ch.sheikh_username};
  });
  send(res,200,{channel:{
    id:ch.id, name:ch.name, description:ch.description,
    sheikh_username:ch.sheikh_username, join_code:ch.join_code,
    is_public:ch.is_public, max_members:ch.max_members,
    created_at:ch.created_at, last_message_at:ch.last_message_at,
    members:memberDetails,
    messages:ch.messages.slice(-200),
    announcements:ch.announcements.slice(-50),
    review_sessions:(ch.review_sessions||[]).slice(-10),
    plan_template:ch.plan_template||null,
    invite_count:(ch.invite_tokens||[]).length,
    active_review:((ch.review_sessions||[]).find(s=>s.is_active))||null,
  }});
});

R('DELETE','/qqc/admin/channels/:id', async (req,res,p)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  if(!DB.channels[p.id]) return send(res,404,{error:'not_found'});
  delete DB.channels[p.id];
  persist(); send(res,200,{ok:true});
});

R('POST','/qqc/admin/direct-message/:username', async (req,res,p)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const b = await readBody(req);
  const text = String(b.text||'').slice(0,2000);
  if(!text) return send(res,400,{error:'empty'});
  if(!DB.support_tickets[p.username]) DB.support_tickets[p.username]={messages:[],opened_at:now()};
  DB.support_tickets[p.username].messages.push({from:'admin',text,timestamp:now()});
  addNotif(p.username,'support_reply','💬 رد من فريق الدعم: '+text.slice(0,60),'view-support');
  persist(); send(res,200,{ok:true});
});

/* ══════════════════════════════════════════════
   ROUTER
══════════════════════════════════════════════ */
function safeUser(u){ const {password_hash, ...rest}=u; return rest; }

function matchRoute(method, pathname){
  // exact
  if (ROUTES[method+' '+pathname]) return {fn:ROUTES[method+' '+pathname], params:{}};
  // params
  for (const k in ROUTES) {
    const [m, pat] = k.split(' ');
    if (m!==method) continue;
    if (!pat.includes(':')) continue;
    const patParts = pat.split('/'), pthParts = pathname.split('/');
    if (patParts.length !== pthParts.length) continue;
    const params = {}; let ok = true;
    for (let i=0;i<patParts.length;i++) {
      if (patParts[i].startsWith(':')) params[patParts[i].slice(1)] = decodeURIComponent(pthParts[i]);
      else if (patParts[i] !== pthParts[i]) { ok=false; break; }
    }
    if (ok) return {fn:ROUTES[k], params};
  }
  return null;
}

const server = http.createServer(async (req,res)=>{
  if (req.method==='OPTIONS'){
    res.writeHead(204,{
      'Access-Control-Allow-Origin':'*',
      'Access-Control-Allow-Headers':'Content-Type, x-token, x-username, x-admin-password',
      'Access-Control-Allow-Methods':'GET,POST,PATCH,DELETE,OPTIONS',
      'Access-Control-Max-Age':'86400',
    });
    return res.end();
  }
  let parsedUrl;
  try { parsedUrl = new URL(req.url, 'http://localhost'); }
  catch(_){ parsedUrl = new URL('/', 'http://localhost'); }
  const pathname = parsedUrl.pathname || '/';
  const query = Object.fromEntries(parsedUrl.searchParams);

  if (pathname === '/qqc/health' || pathname === '/health') {
    return send(res,200,{ok:true, status:'running', uptime:+process.uptime().toFixed(1), port:PORT, ts:Date.now()});
  }

  if (pathname.startsWith('/qqc/')) {
    const route = matchRoute(req.method, pathname);
    if (!route) return send(res,404,{error:'route_not_found', path:pathname});
    try { await route.fn(req,res,route.params,query); }
    catch(e){ console.error('route error',e); send(res,500,{error:'internal',detail:String(e.message)}); }
    return;
  }
  serveStatic(req,res,pathname);
});

/* ══════════════════════════════════════════════════════════════════
   HERMES AGENT v2 — وكيل الذكاء الاصطناعي الخلفي الكامل
   مستوحى من NousResearch/hermes-agent
   ─────────────────────────────────────────────────────────────────
   يعمل تلقائياً كل ساعتين بحلقة tool-calling أصيلة:
   • يقرأ ملفات الأخطاء الحقيقية (JSONL)
   • يحلل بيانات التدريب والتلاوة
   • يعدّل أوزان الخوارزمية مباشرة في قاعدة البيانات
   • يعدّل نماذج ML للمستخدمين
   • يولد نصائح تحفيزية عميقة
   • يكتسب مهارات تتراكم عبر الدورات
══════════════════════════════════════════════════════════════════ */

const HERMES_MEMORY_PATH = path.join(ROOT, 'hermes_memory.json');
function readHermesMemory(){
  try { return JSON.parse(fs.readFileSync(HERMES_MEMORY_PATH,'utf8')); }
  catch { return { skills:[], insights:[], runs:[], last_run:null, cfg_patches:{}, stats:{total_runs:0, total_tool_calls:0, users_helped:0, weights_updated:0, plans_adjusted:0} }; }
}
function writeHermesMemory(m){ try { fs.writeFileSync(HERMES_MEMORY_PATH, JSON.stringify(m,null,2)); } catch(e){ console.error('[Hermes] Memory write failed',e.message); } }

/* ─── Tool definitions — 16 tools covering the full system ─── */
const HERMES_TOOLS = [
  { type:'function', function:{ name:'get_global_stats', description:'إحصائيات عامة شاملة: مستخدمون، جلسات، صفحات، طاقة متوسطة، أوزان الخوارزمية الحالية.', parameters:{ type:'object', properties:{} } } },
  { type:'function', function:{ name:'scan_users', description:'مسح المستخدمين مع تصفية متقدمة.', parameters:{ type:'object', properties:{ filter:{ type:'string', enum:['all','struggling','inactive','high_performers','new_users','low_energy','high_absences'] } }, required:['filter'] } } },
  { type:'function', function:{ name:'get_user_details', description:'تفاصيل كاملة لمستخدم: خطة، تقدم، طاقة، جلسات، نموذج ML، حالة SR.', parameters:{ type:'object', properties:{ username:{ type:'string' } }, required:['username'] } } },
  { type:'function', function:{ name:'read_error_logs', description:'قراءة ملفات الأخطاء الحقيقية من السيرفر. النوع: errors | ai_errors | recitation_errors', parameters:{ type:'object', properties:{ log_type:{ type:'string', enum:['errors','ai_errors','recitation_errors','ai_training_data'] }, limit:{ type:'number', description:'عدد السجلات (max 50)' } }, required:['log_type'] } } },
  { type:'function', function:{ name:'analyze_recitation_patterns', description:'تحليل أنماط أخطاء التلاوة من السجلات: الكلمات الأكثر خطأ، دقة المستخدمين، توصيات.', parameters:{ type:'object', properties:{} } } },
  { type:'function', function:{ name:'modify_algorithm_weights', description:'تعديل أوزان الخوارزمية مباشرة في قاعدة البيانات. هذا تغيير حقيقي يؤثر على كل المستخدمين.', parameters:{ type:'object', properties:{ weights:{ type:'object', description:'كائن JSON بالأوزان المراد تغييرها', additionalProperties:{ type:'number' } }, reason:{ type:'string' } }, required:['weights','reason'] } } },
  { type:'function', function:{ name:'update_user_ml_weights', description:'تحديث أوزان نموذج ML الخاص بمستخدم مباشرة لتحسين دقة التنبؤ.', parameters:{ type:'object', properties:{ username:{ type:'string' }, ml_weights:{ type:'array', items:{ type:'number' }, description:'مصفوفة 12 وزن للنموذج' }, reason:{ type:'string' } }, required:['username','ml_weights','reason'] } } },
  { type:'function', function:{ name:'adjust_user_plan', description:'تعديل خطة مستخدم (صفحات يومية، طور الخطة).', parameters:{ type:'object', properties:{ username:{ type:'string' }, daily_pages:{ type:'number' }, phase:{ type:'string', enum:['ramp_up','steady','challenge','recovery'] }, reason:{ type:'string' } }, required:['username','daily_pages','reason'] } } },
  { type:'function', function:{ name:'push_smart_notification', description:'إرسال إشعار شخصي ذكي لمستخدم.', parameters:{ type:'object', properties:{ username:{ type:'string' }, type:{ type:'string', enum:['motivation','warning','tip','achievement','plan_update','hermes_insight'] }, text:{ type:'string' }, ref:{ type:'string' } }, required:['username','type','text'] } } },
  { type:'function', function:{ name:'batch_notify_users', description:'إرسال إشعار لمجموعة مستخدمين دفعة واحدة (filter مثل scan_users).', parameters:{ type:'object', properties:{ filter:{ type:'string', enum:['struggling','inactive','high_performers','all'] }, notification_type:{ type:'string' }, text:{ type:'string' } }, required:['filter','notification_type','text'] } } },
  { type:'function', function:{ name:'generate_deep_coaching', description:'استدعاء GPT لتوليد تحليل عميق وخطة علاجية مخصصة لمستخدم محدد.', parameters:{ type:'object', properties:{ username:{ type:'string' }, focus:{ type:'string', enum:['motivation','plan_fix','recitation_improvement','streak_recovery','general'] } }, required:['username','focus'] } } },
  { type:'function', function:{ name:'read_hermes_memory', description:'قراءة ذاكرة Hermes: المهارات المكتسبة، الرؤى السابقة، الإحصائيات.', parameters:{ type:'object', properties:{} } } },
  { type:'function', function:{ name:'save_skill', description:'حفظ مهارة/نمط تعلّمه الوكيل لاستخدامه في الدورات القادمة.', parameters:{ type:'object', properties:{ title:{ type:'string' }, content:{ type:'string' }, tags:{ type:'array', items:{ type:'string' } }, applies_to:{ type:'string', enum:['users','algorithm','recitation','plan','general'] } }, required:['title','content'] } } },
  { type:'function', function:{ name:'log_insight', description:'تسجيل رؤية/استنتاج مهم في الذاكرة.', parameters:{ type:'object', properties:{ insight:{ type:'string' }, category:{ type:'string', enum:['user_behavior','algorithm','plan','coaching','recitation','general'] }, impact:{ type:'string', enum:['high','medium','low'] } }, required:['insight','category'] } } },
  { type:'function', function:{ name:'update_hermes_cfg', description:'تحديث إعدادات Hermes نفسه: تواتر الدورات، الحد الأقصى لاستدعاءات الأدوات، إلخ.', parameters:{ type:'object', properties:{ max_tool_calls:{ type:'number' }, focus_mode:{ type:'string', enum:['full_analysis','quick_scan','coaching_only','algorithm_only'] } }, required:[] } } },
  { type:'function', function:{ name:'done', description:'إنهاء دورة التحليل مع ملخص شامل.', parameters:{ type:'object', properties:{ summary:{ type:'string' }, actions_taken:{ type:'array', items:{ type:'string' } }, next_run_focus:{ type:'string' } }, required:['summary'] } } },
  { type:'function', function:{ name:'get_recitation_skill_data', description:'تحليل بيانات التلاوة لكل المستخدمين: أكثر الكلمات خطأً، دقة كل مستخدم، السور الأصعب، ربط بروابط صوتيات الشيوخ للمراجعة.', parameters:{ type:'object', properties:{ top_n_words:{ type:'number', description:'عدد الكلمات الأكثر خطأ (افتراضي 20)' } } } } },
  { type:'function', function:{ name:'generate_recitation_coaching', description:'توليد خطة تدريب تلاوة مخصصة لمستخدم بناءً على أخطائه + روابط صوتيات الشيوخ للكلمات الأصعب.', parameters:{ type:'object', properties:{ username:{ type:'string' }, reciter_id:{ type:'string', enum:['ar.alafasy','ar.husary','ar.minshawi','ar.sudais','ar.basfar'], description:'الشيخ المرجعي للتدريب (افتراضي ar.alafasy)' } }, required:['username'] } } },

  /* ═══ أدوات البرمجة الذاتية — Hermes يقرأ ويعدل الكود الحقيقي ═══ */
  { type:'function', function:{ name:'list_project_files', description:'قراءة قائمة ملفات المشروع مع أحجامها وتواريخها. مفيد لفهم بنية المشروع قبل التعديل.', parameters:{ type:'object', properties:{ subdir:{ type:'string', description:'مجلد فرعي (مثل public أو فارغ للجذر)' } } } } },
  { type:'function', function:{ name:'read_project_file', description:'قراءة محتوى أي ملف من ملفات المشروع الحقيقية (server.js, app.js, ai_core.js, إلخ). استخدمها لفهم الخوارزمية قبل تعديلها.', parameters:{ type:'object', properties:{ file_path:{ type:'string', description:'مسار الملف نسبة لمجلد quran-coach (مثل: public/app.js, ai_core.js, server.js)' }, start_line:{ type:'number', description:'رقم السطر للبداية (اختياري)' }, lines:{ type:'number', description:'عدد الأسطر للقراءة (افتراضي 100)' } }, required:['file_path'] } } },
  { type:'function', function:{ name:'write_project_file', description:'تعديل ملف مسموح به في المشروع. Hermes يُحسّن الخوارزمية والكود مباشرةً. الملفات المسموحة: ai_core.js, public/app.js (دوال محددة). يُحفظ نسخة احتياطية تلقائياً.', parameters:{ type:'object', properties:{ file_path:{ type:'string', description:'مسار الملف (ai_core.js أو public/app.js)' }, old_text:{ type:'string', description:'النص القديم المراد استبداله (يجب أن يكون موجوداً بالضبط في الملف)' }, new_text:{ type:'string', description:'النص الجديد البديل' }, reason:{ type:'string', description:'سبب التعديل وما الذي يُحسّنه' } }, required:['file_path','old_text','new_text','reason'] } } },
  { type:'function', function:{ name:'analyze_and_improve_algorithm', description:'يحلل Hermes الخوارزمية الحالية مع بيانات الأخطاء الحقيقية ويقترح تحسينات كودية دقيقة بالذكاء الاصطناعي. يحفظ النتائج في الذاكرة.', parameters:{ type:'object', properties:{ focus:{ type:'string', enum:['recitation_matching','ml_weights','sr_restart','word_similarity','all'], description:'ما الذي تريد تحليله' } }, required:['focus'] } } },
  { type:'function', function:{ name:'test_server_health', description:'يتحقق أن السيرفر لا يزال يعمل بشكل صحيح بعد أي تعديل. يُرجع حالة كل endpoint أساسي.', parameters:{ type:'object', properties:{} } } },
  { type:'function', function:{ name:'git_commit_changes', description:'يرفع التعديلات الأخيرة على الكود إلى GitHub تلقائياً. استخدمها بعد كل تعديل ناجح عبر write_project_file لحفظ التغييرات في ريبو GitHub.', parameters:{ type:'object', properties:{ message:{ type:'string', description:'رسالة الـ commit بالعربي أو الإنجليزي تصف التعديل' } }, required:['message'] } } },

  /* ═══ أدوات المختبر والإنترنت — Hermes يتدرب ويبحث ═══ */
  { type:'function', function:{ name:'web_search', description:'البحث في الإنترنت عن أي موضوع (مكتبات، أدوات، معلومات تقنية، بحوث). يُرجع ملخصاً من DuckDuckGo.', parameters:{ type:'object', properties:{ query:{ type:'string', description:'نص البحث' } }, required:['query'] } } },
  { type:'function', function:{ name:'fetch_url', description:'جلب محتوى أي رابط من الإنترنت — صفحة ويب، ملف JSON، وثيقة API، حزمة npm. يُرجع النص المقتطع.', parameters:{ type:'object', properties:{ url:{ type:'string', description:'الرابط الكامل' }, max_chars:{ type:'number', description:'الحد الأقصى للحروف (افتراضي 3000)' } }, required:['url'] } } },
  { type:'function', function:{ name:'generate_tts_file', description:'[معطّل] لا تستخدم هذه الأداة — توليد الصوت بالذكاء الاصطناعي معطّل تماماً. استخدم get_sheikh_audio_refs بدلاً منها للحصول على روابط صوتيات الشيوخ الحقيقية المجانية.', parameters:{ type:'object', properties:{ text:{ type:'string' } } } } },
  { type:'function', function:{ name:'get_sheikh_audio_refs', description:'الحصول على روابط صوتيات الشيوخ الحقيقية (everyayah.com + islamic.network) لآيات محددة. بدلاً من توليد صوت اصطناعي، يُرجع روابط مباشرة لتلاوات الشيوخ الأصليين.', parameters:{ type:'object', properties:{ surah_number:{ type:'number', description:'رقم السورة 1-114' }, from_ayah:{ type:'number', description:'من الآية' }, to_ayah:{ type:'number', description:'إلى الآية (افتراضي = from_ayah)' }, sheikh_id:{ type:'string', enum:['ar.alafasy','ar.husary','ar.minshawi','ar.abdulbasitmurattal','ar.mahermuaiqly'], description:'الشيخ المرجعي (افتراضي ar.alafasy)' } }, required:['surah_number','from_ayah'] } } },
  { type:'function', function:{ name:'train_on_all_data', description:'تدريب شامل: يقرأ كل بيانات التلاوة + رسائل القنوات + جلسات المستخدمين + أخطاء النظام، ويبني نموذج أخطاء محدّث في الذاكرة. يجب تشغيلها دورياً لتحسين دقة التقييم.', parameters:{ type:'object', properties:{ focus:{ type:'string', enum:['recitation','sessions','messages','errors','all'], description:'ما الذي تريد التدريب عليه (افتراضي all)' } } } } },
  { type:'function', function:{ name:'analyze_channel_messages', description:'تحليل رسائل القنوات (الشُّعب) لاكتشاف الأسئلة الأكثر تكراراً، مستوى المستخدمين، الاحتياجات التدريبية.', parameters:{ type:'object', properties:{ limit:{ type:'number', description:'عدد الرسائل للتحليل (افتراضي 200)' } } } } },
  { type:'function', function:{ name:'improve_recitation_model', description:'تحسين نموذج تقييم التلاوة بناءً على بيانات التدريب: يعدّل معايير تطابق الكلمات، يحدّد الكلمات الصعبة، ويحفظ المعايير المحسّنة في الذاكرة لاستخدامها في التقييم التلقائي.', parameters:{ type:'object', properties:{ save_to_memory:{ type:'boolean', description:'حفظ النموذج في الذاكرة (افتراضي true)' } } } } },
  { type:'function', function:{ name:'list_lab_files', description:'قائمة كل ملفات مختبر Hermes (صوتية ونصية وبيانات).', parameters:{ type:'object', properties:{} } } },
  { type:'function', function:{ name:'delete_lab_file', description:'حذف ملف من مختبر Hermes.', parameters:{ type:'object', properties:{ filename:{ type:'string', description:'اسم الملف مع امتداده' } }, required:['filename'] } } },
  { type:'function', function:{ name:'create_text_file', description:'إنشاء ملف نصي أو JSON أو Markdown في مختبر Hermes. يُستخدم لحفظ تقارير التحليل، خطط التدريب، ملاحظات المقارنة.', parameters:{ type:'object', properties:{ filename:{ type:'string', description:'اسم الملف مع امتداده (.txt .json .md)' }, content:{ type:'string', description:'محتوى الملف' } }, required:['filename','content'] } } },

  /* ═══ أدوات التسميع الذكي — Hermes يتدرب على مقاطع التلاوة ═══ */
  { type:'function', function:{ name:'search_recitation_videos', description:'البحث في YouTube عن مقاطع تلاوة قرآنية لتدريب نموذج التسميع الذكي. يعيد قائمة بالفيديوهات ومعلوماتها (الشيخ، السورة، الأسلوب) لاستخراج الأنماط وتحسين التقييم.', parameters:{ type:'object', properties:{ query:{ type:'string', description:'كلمات البحث (مثال: تلاوة سورة البقرة المنشاوي، سورة الفاتحة الحصري، تسميع القرآن)' }, max_results:{ type:'number', description:'عدد النتائج 1-20 (افتراضي 10)' } }, required:['query'] } } },
  { type:'function', function:{ name:'add_video_training', description:'حفظ فيديو تلاوة كبيانات تدريب لنموذج التسميع الذكي. هرمز يحلّل العنوان ويستخرج رؤى الشيخ والسورة وأسلوب الأداء ويحفظها في ذاكرته لتحسين تقييم المستخدمين.', parameters:{ type:'object', properties:{ video_id:{ type:'string', description:'معرّف الفيديو على YouTube' }, title:{ type:'string', description:'عنوان الفيديو' }, channel:{ type:'string', description:'اسم القناة/الشيخ' }, sheikh_name:{ type:'string', description:'اسم الشيخ إن كان معروفاً' }, surah_info:{ type:'string', description:'السورة والآيات المعنية' }, recitation_notes:{ type:'string', description:'ملاحظات هرمز عن أسلوب التلاوة والدروس المستخلصة للتسميع الذكي' } }, required:['video_id','title','recitation_notes'] } } },
  { type:'function', function:{ name:'get_video_training_data', description:'قراءة قائمة مقاطع التلاوة المحفوظة كبيانات تدريب في ذاكرة هرمز، مع الملاحظات والرؤى المستخلصة.', parameters:{ type:'object', properties:{} } } },

  /* ═══ أدوات المتصفح الذكي — Hermes يتجول في الويب ═══ */
  { type:'function', function:{ name:'browser_open',
    description:'افتح صفحة ويب كمتصفح حقيقي: يجلب المحتوى ويستخرج النص المقروء + الروابط المهمة. استخدمها للتجوّل في المواقع واستخراج المعلومات.',
    parameters:{ type:'object', properties:{
      url:{ type:'string', description:'الرابط الكامل (https://...)' },
      extract_links:{ type:'boolean', description:'استخرج الروابط من الصفحة (افتراضي true)' },
      max_chars:{ type:'number', description:'الحد الأقصى للحروف المستخرجة (افتراضي 5000)' }
    }, required:['url'] }
  } },
  { type:'function', function:{ name:'browser_search',
    description:'ابحث في الويب بمتصفح ذكي يستخدم محركات بحث متعددة (DuckDuckGo + Wikipedia + Brave). يُرجع نتائج حقيقية مع روابط قابلة للفتح.',
    parameters:{ type:'object', properties:{
      query:{ type:'string', description:'نص البحث' },
      engines:{ type:'array', items:{ type:'string', enum:['duckduckgo','wikipedia','wikipedia_ar','brave'] }, description:'محركات البحث (افتراضي كلها)' },
      open_top_results:{ type:'number', description:'فتح أفضل N نتيجة تلقائياً لجلب محتواها (0-3، افتراضي 0)' }
    }, required:['query'] }
  } },
  { type:'function', function:{ name:'save_learning_file',
    description:'احفظ ما تعلّمته كملف Markdown في مختبر هرمز ليظهر للمستخدم. استخدمها بعد كل جلسة تعلّم لتوثيق ما اكتسبته.',
    parameters:{ type:'object', properties:{
      filename:{ type:'string', description:'اسم الملف بدون امتداد (سيُضاف .md تلقائياً)' },
      title:{ type:'string', description:'عنوان المحتوى' },
      content:{ type:'string', description:'محتوى التعلّم بتنسيق Markdown' },
      skill_title:{ type:'string', description:'عنوان المهارة لحفظها في الذاكرة أيضاً' },
      skill_applies_to:{ type:'string', enum:['users','algorithm','recitation','plan','general'] }
    }, required:['filename','title','content'] }
  } },

  /* ═══ أداة التعلم الذاتي العميق — Hermes يتعلم مهارة من الإنترنت ═══ */
  { type:'function', function:{ name:'learn_skill_from_web',
    description:'تعلّم مهارة أو موضوع معين من الإنترنت: يبحث → يجلب المحتوى من أفضل المصادر → يلخّصه بالذكاء الاصطناعي → يحفظه كمهارة دائمة في الذاكرة. استخدمها عندما يطلب الأدمن: "تعلّم مهارة X" أو "ابحث وتعلّم عن Y" أو "احفظ معلومات عن Z".',
    parameters:{ type:'object', properties:{
      topic:{ type:'string', description:'الموضوع أو المهارة المراد تعلمها (مثال: spaced repetition, تحفيز حافظ القرآن, خوارزميات التذكر)' },
      search_queries:{ type:'array', items:{ type:'string' }, description:'2-4 استعلامات بحث متنوعة للحصول على معلومات شاملة' },
      applies_to:{ type:'string', enum:['users','algorithm','recitation','plan','general'], description:'مجال تطبيق المهارة في التطبيق' },
      urls_to_fetch:{ type:'array', items:{ type:'string' }, description:'روابط محددة لجلبها مباشرة بدلاً من البحث (اختياري)' },
      context:{ type:'string', description:'السياق: كيف ستطبّق هذه المهارة في تطبيق Quantum Quran Coach' }
    }, required:['topic','search_queries'] }
  } }
];

/* ─── Tool executor — كل أداة تغير البيانات الحقيقية ─── */
async function executeHermesTool(toolName, args, mem){
  if(!mem.stats) mem.stats={total_runs:0,total_tool_calls:0,users_helped:0,weights_updated:0,plans_adjusted:0};
  switch(toolName){

    case 'get_global_stats': {
      const users = Object.values(DB.users);
      const today = new Date().toISOString().slice(0,10);
      return {
        total_users: users.length,
        active_today: users.filter(u=>u.progress?.last_session_date===today).length,
        total_pages_alltime: DB.admin?.stats?.total_pages_memorized_alltime||0,
        avg_energy: users.length ? +(users.reduce((s,u)=>s+(u.energy?.score||75),0)/users.length).toFixed(1) : 0,
        avg_streak: users.length ? +(users.reduce((s,u)=>s+(u.progress?.current_streak_days||0),0)/users.length).toFixed(1) : 0,
        struggling_count: users.filter(u=>(u.progress?.consecutive_absences||0)>=2).length,
        high_performers: users.filter(u=>(u.progress?.current_streak_days||0)>=7).length,
        algorithm_weights: DB.admin?.algorithm_weights||{},
        hermes_runs: mem.stats.total_runs,
        hermes_skills: (mem.skills||[]).length,
      };
    }

    case 'scan_users': {
      const users = Object.values(DB.users);
      const today = new Date().toISOString().slice(0,10);
      let filtered;
      switch(args.filter){
        case 'struggling':      filtered=users.filter(u=>(u.progress?.consecutive_absences||0)>=2||(u.energy?.score||75)<40); break;
        case 'inactive':        filtered=users.filter(u=>{ const d=u.progress?.last_session_date; return !d||(Date.now()-new Date(d).getTime())>3*864e5; }); break;
        case 'high_performers': filtered=users.filter(u=>(u.progress?.current_streak_days||0)>=7); break;
        case 'new_users':       filtered=users.filter(u=>(Date.now()-new Date(u.created_at||0).getTime())<7*864e5); break;
        case 'low_energy':      filtered=users.filter(u=>(u.energy?.score||75)<40); break;
        case 'high_absences':   filtered=users.filter(u=>(u.progress?.consecutive_absences||0)>=3); break;
        default:                filtered=users;
      }
      return { count:filtered.length, users: filtered.slice(0,30).map(u=>({
        username:u.username, energy:u.energy?.score||75,
        streak:u.progress?.current_streak_days||0, absences:u.progress?.consecutive_absences||0,
        total_pages:+(u.progress?.total_pages_memorized||0).toFixed(2),
        last_session:u.progress?.last_session_date||null, daily_pages:u.plan?.current_daily_pages||0,
        ml_trained: u.ml_state?.n||0, has_plan:!!u.plan,
      }))};
    }

    case 'get_user_details': {
      const u=DB.users[args.username]; if(!u) return {error:'not_found'};
      return {
        username:u.username, display_name:u.display_name,
        energy:u.energy, progress:u.progress, plan:u.plan,
        onboarding:u.onboarding, sessions_last10:(u.sessions||[]).slice(-10),
        sr_state:u.sr_state, ml_state:u.ml_state,
        tarteel_history_last5:(u.tarteel_history||[]).slice(-5),
        hermes_adjustment:u.plan?.hermes_adjustment||null,
        notifications_unread:(u.notifications||[]).filter(n=>!n.read).length,
      };
    }

    case 'read_error_logs': {
      const limit = Math.min(50, +args.limit||20);
      const logType = ['errors','ai_errors','recitation_errors','ai_training_data'].includes(args.log_type) ? args.log_type : 'errors';
      const records = readLogFile(`${logType}.jsonl`, limit);
      return { log_type:logType, count:records.length, records };
    }

    case 'analyze_recitation_patterns': {
      const records = readLogFile('recitation_errors.jsonl', 200);
      if(!records.length) return { message:'لا توجد بيانات تلاوة بعد', count:0 };
      const wordErrors = {};
      let totalAcc = 0, sessionCount = 0;
      records.forEach(r=>{
        if(Array.isArray(r.wrong_words)) r.wrong_words.forEach(w=>{ wordErrors[w]=(wordErrors[w]||0)+1; });
        if(r.accuracy_pct) { totalAcc+=r.accuracy_pct; sessionCount++; }
      });
      const topErrors = Object.entries(wordErrors).sort((a,b)=>b[1]-a[1]).slice(0,15).map(([w,c])=>({word:w,count:c}));
      return {
        total_sessions: records.length, avg_accuracy: sessionCount ? +(totalAcc/sessionCount).toFixed(1) : 0,
        top_error_words: topErrors, unique_error_words: Object.keys(wordErrors).length,
      };
    }

    case 'modify_algorithm_weights': {
      if(!DB.admin) DB.admin={};
      if(!DB.admin.algorithm_weights) DB.admin.algorithm_weights={};
      const cur = DB.admin.algorithm_weights;
      const changed = {};
      for(const [k,v] of Object.entries(args.weights||{})){
        if(typeof v==='number' && isFinite(v)){
          const old = cur[k]!==undefined ? cur[k] : v;
          const maxΔ = Math.abs(old)*0.30+0.01; // Hermes يُسمح له بـ 30%
          const newV = Math.round((old+Math.max(-maxΔ,Math.min(maxΔ,v-old)))*1000)/1000;
          changed[k] = {from:old, to:newV};
          cur[k] = newV;
        }
      }
      DB.admin.hermes_weights_updated_at = now();
      mem.stats.weights_updated++;
      persist();
      return { ok:true, reason:String(args.reason||'').slice(0,200), changed };
    }

    case 'update_user_ml_weights': {
      const u=DB.users[args.username]; if(!u) return {error:'not_found'};
      if(!Array.isArray(args.ml_weights)||args.ml_weights.length!==12) return {error:'ml_weights must be array of 12 numbers'};
      if(!u.ml_state) u.ml_state={W:args.ml_weights,n:0};
      else u.ml_state.W = args.ml_weights;
      u.ml_state.hermes_updated = now();
      u.ml_state.hermes_reason = String(args.reason||'').slice(0,150);
      persist();
      return {ok:true, username:args.username};
    }

    case 'adjust_user_plan': {
      const u=DB.users[args.username]; if(!u) return {error:'not_found'};
      if(!u.plan) u.plan={current_daily_pages:0.25};
      const oldPages = u.plan.current_daily_pages||0;
      u.plan.current_daily_pages = Math.max(0.1, Math.min(10, +args.daily_pages||oldPages));
      if(args.phase) u.plan.phase = args.phase;
      u.plan.hermes_adjustment = { old:oldPages, new:u.plan.current_daily_pages, reason:String(args.reason||'').slice(0,200), at:now() };
      mem.stats.plans_adjusted++;
      persist();
      return {ok:true, username:args.username, old_pages:oldPages, new_pages:u.plan.current_daily_pages};
    }

    case 'push_smart_notification': {
      const u=DB.users[args.username]; if(!u) return {error:'not_found'};
      addNotif(u.username, args.type||'hermes_insight', String(args.text||'').slice(0,200), args.ref||'view-dashboard');
      mem.stats.users_helped++;
      persist();
      return {ok:true, sent_to:args.username};
    }

    case 'batch_notify_users': {
      const users=Object.values(DB.users);
      const today=new Date().toISOString().slice(0,10);
      let targets;
      switch(args.filter){
        case 'struggling': targets=users.filter(u=>(u.progress?.consecutive_absences||0)>=2); break;
        case 'inactive':   targets=users.filter(u=>{ const d=u.progress?.last_session_date; return !d||(Date.now()-new Date(d).getTime())>3*864e5; }); break;
        case 'high_performers': targets=users.filter(u=>(u.progress?.current_streak_days||0)>=7); break;
        default: targets=users;
      }
      let sent=0;
      targets.slice(0,50).forEach(u=>{
        addNotif(u.username, args.notification_type||'hermes_insight', String(args.text||'').slice(0,200), 'view-dashboard');
        mem.stats.users_helped++; sent++;
      });
      persist();
      return {ok:true, sent_to:sent, filter:args.filter};
    }

    case 'generate_deep_coaching': {
      const u=DB.users[args.username]; if(!u) return {error:'not_found'};
      const sysP=`أنت مدرب قرآن خبير ومتخصص. بناءً على بيانات المستخدم المرسلة إليك، قدم تحليلاً عميقاً وخطة علاجية مخصصة. الإجابة بالعربية، منظمة ومباشرة، 5-8 أسطر.`;
      const userP=`المستخدم: ${u.display_name||u.username}
الطاقة: ${u.energy?.score||75}/100 | سلسلة: ${u.progress?.current_streak_days||0} يوم | غياب: ${u.progress?.consecutive_absences||0}
صفحات محفوظة: ${u.progress?.total_pages_memorized||0} | جلسات: ${u.progress?.total_sessions_completed||0}
الخطة: ${u.plan?.current_daily_pages||0} صفحة/يوم | الطور: ${u.plan?.phase||'غير محدد'}
جلسات أخيرة: ${JSON.stringify((u.sessions||[]).slice(-5).map(s=>({d:s.difficulty,p:s.pages_done})))}
التركيز: ${args.focus||'general'}
قدّم: ١) تشخيص دقيق ٢) خطة عمل تفصيلية ٣) توصية واحدة فورية`;
      const reply = await callAI(sysP, userP);
      if(reply){
        addNotif(u.username,'hermes_insight','💡 '+reply.slice(0,200),'view-dashboard');
        persist();
      }
      return {ok:true, username:args.username, coaching:reply||'لم يتمكن الذكاء الاصطناعي من الإجابة'};
    }

    case 'read_hermes_memory': {
      return {
        skills_count:(mem.skills||[]).length,
        recent_skills:(mem.skills||[]).slice(-5),
        recent_insights:(mem.insights||[]).slice(-10),
        cfg_patches:mem.cfg_patches||{},
        stats:mem.stats,
        last_run:mem.last_run,
      };
    }

    case 'save_skill': {
      if(!mem.skills) mem.skills=[];
      const existing=mem.skills.findIndex(s=>s.title===args.title);
      const skill={ title:String(args.title||'').slice(0,100), content:String(args.content||'').slice(0,800), tags:args.tags||[], applies_to:args.applies_to||'general', created_at:now(), updated_count:1 };
      if(existing>=0){ mem.skills[existing]={...skill, updated_count:(mem.skills[existing].updated_count||0)+1}; }
      else { mem.skills.push(skill); }
      if(mem.skills.length>300) mem.skills=mem.skills.slice(-300);
      return {ok:true, total_skills:mem.skills.length, action:existing>=0?'updated':'created'};
    }

    case 'log_insight': {
      if(!mem.insights) mem.insights=[];
      mem.insights.push({ text:String(args.insight||'').slice(0,600), category:args.category||'general', impact:args.impact||'medium', at:now() });
      if(mem.insights.length>1000) mem.insights=mem.insights.slice(-1000);
      return {ok:true, total_insights:mem.insights.length};
    }

    case 'update_hermes_cfg': {
      if(!mem.cfg_patches) mem.cfg_patches={};
      if(args.max_tool_calls) mem.cfg_patches.max_tool_calls=Math.max(5,Math.min(25,+args.max_tool_calls));
      if(args.focus_mode) mem.cfg_patches.focus_mode=args.focus_mode;
      return {ok:true, cfg:mem.cfg_patches};
    }

    case 'done': {
      let _at = args.actions_taken;
      if(typeof _at === 'string'){ try{ _at=JSON.parse(_at); }catch{ _at=[]; } }
      if(!Array.isArray(_at)) _at = _at ? [String(_at)] : [];
      return {finished:true, summary:String(args.summary||'').slice(0,600), actions_taken:_at, next_run_focus:args.next_run_focus||''};
    }

    case 'get_recitation_skill_data': {
      /* قراءة سجلات التلاوة وتجميع إحصائيات الكلمات الأكثر خطأ مع روابط الشيوخ */
      const records = readLogFile('recitation_errors.jsonl', 500);
      const topN = Math.min(30, +args.top_n_words||20);
      const wordErrors = {};        // word → count
      const userStats = {};         // username → {sessions, totalAcc, wrongWords}
      const surahErrors = {};       // surah → count
      let globalAcc = 0, accCount = 0;
      records.forEach(r=>{
        if(Array.isArray(r.wrong_words)) r.wrong_words.forEach(w=>{ wordErrors[w]=(wordErrors[w]||0)+1; });
        if(r.accuracy_pct){ globalAcc+=r.accuracy_pct; accCount++; }
        if(r.username){
          if(!userStats[r.username]) userStats[r.username]={sessions:0,totalAcc:0,topErrors:{}};
          userStats[r.username].sessions++;
          userStats[r.username].totalAcc+=r.accuracy_pct||0;
          if(Array.isArray(r.wrong_words)) r.wrong_words.forEach(w=>{
            userStats[r.username].topErrors[w]=(userStats[r.username].topErrors[w]||0)+1;
          });
        }
        if(r.surah_name) surahErrors[r.surah_name]=(surahErrors[r.surah_name]||0)+1;
      });
      const topErrors = Object.entries(wordErrors).sort((a,b)=>b[1]-a[1]).slice(0,topN);
      // بناء روابط صوتيات للكلمات — Hermes يستخدمها للتدريب
      const RECITER_FOLDERS = {
        'ar.alafasy':'Alafasy_128kbps','ar.husary':'Husary_128kbps',
        'ar.minshawi':'Minshawi_128kbps','ar.sudais':'Abdurrahmaan_As-Sudais_192kbps',
        'ar.basfar':'Abdullah_Basfar_192kbps'
      };
      // احفظ بيانات التلاوة في ذاكرة Hermes
      if(!mem.recitation_data) mem.recitation_data={};
      mem.recitation_data.top_error_words = topErrors.slice(0,20).map(([w,c])=>({word:w,count:c}));
      mem.recitation_data.global_avg_accuracy = accCount ? +(globalAcc/accCount).toFixed(1) : 0;
      mem.recitation_data.total_recitation_sessions = records.length;
      mem.recitation_data.reciter_folders = RECITER_FOLDERS;
      mem.recitation_data.last_analyzed = now();
      return {
        total_sessions: records.length,
        global_avg_accuracy: mem.recitation_data.global_avg_accuracy,
        top_error_words: topErrors.map(([w,c])=>({word:w,count:c})),
        users_analyzed: Object.keys(userStats).length,
        hardest_surahs: Object.entries(surahErrors).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([s,c])=>({surah:s,errors:c})),
        per_user_summary: Object.entries(userStats).slice(0,10).map(([u,s])=>({
          username:u, sessions:s.sessions,
          avg_accuracy:s.sessions?+(s.totalAcc/s.sessions).toFixed(1):0,
          top_errors:Object.entries(s.topErrors).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([w,c])=>({word:w,count:c}))
        })),
        reciter_audio_url_pattern: 'https://everyayah.com/data/{reciter_folder}/{surahNum3digits}{ayahNum3digits}.mp3',
        available_reciters: RECITER_FOLDERS,
      };
    }

    case 'generate_recitation_coaching': {
      const u=DB.users[args.username]; if(!u) return {error:'not_found'};
      // اجمع أخطاء المستخدم من السجلات
      const userRecords = readLogFile('recitation_errors.jsonl', 200).filter(r=>r.username===args.username);
      const wordErr = {};
      userRecords.forEach(r=>{ if(Array.isArray(r.wrong_words)) r.wrong_words.forEach(w=>{ wordErr[w]=(wordErr[w]||0)+1; }); });
      const topErrWords = Object.entries(wordErr).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([w,c])=>({word:w,count:c}));
      const avgAcc = userRecords.length ? +(userRecords.reduce((s,r)=>s+(r.accuracy_pct||0),0)/userRecords.length).toFixed(1) : 0;
      const reciterId = args.reciter_id || 'ar.alafasy';
      const FOLDERS = {'ar.alafasy':'Alafasy_128kbps','ar.husary':'Husary_128kbps','ar.minshawi':'Minshawi_128kbps','ar.sudais':'Abdurrahmaan_As-Sudais_192kbps','ar.basfar':'Abdullah_Basfar_192kbps'};
      const reciterFolder = FOLDERS[reciterId] || 'Alafasy_128kbps';
      const sysP=`أنت Hermes Agent — مدرب تلاوة قرآنية متخصص يعمل بالذكاء الاصطناعي. 
لديك بيانات أخطاء حقيقية لمستخدم وأنت مرتبط بصوتيات خمسة شيوخ.
مهمتك: خطة تدريبية دقيقة ومخصصة. الرد بالعربية، منظم، 8-12 سطر.`;
      const userP=`المستخدم: ${u.display_name||u.username}
عدد جلسات التسميع: ${userRecords.length}
متوسط الدقة: ${avgAcc}%
الكلمات الأكثر خطأ: ${topErrWords.map(e=>`"${e.word}"(${e.count})`).join('، ')||'لا بيانات بعد'}
الشيخ المرجعي المختار: ${reciterId} — يمكن سماعه على: https://everyayah.com/data/${reciterFolder}/
نمط رابط الصوت: https://everyayah.com/data/${reciterFolder}/[رقم_السورة3أرقام][رقم_الآية3أرقام].mp3
مثال سورة الفاتحة آية 1: https://everyayah.com/data/${reciterFolder}/001001.mp3

قدّم:
١) تشخيص نقاط الضعف بناءً على الكلمات الخاطئة
٢) خطة تدريب أسبوعية (5 نقاط)
٣) روابط صوتية محددة للآيات التي تحتوي أكثر الكلمات خطأ
٤) تقنية الترديد مع الشيخ لكل كلمة مشكلة
٥) هدف دقة قابل للقياس للأسبوع القادم`;
      const reply = await callAI(sysP, userP);
      if(reply){
        addNotif(u.username,'hermes_insight','🎙️ خطة تدريب تلاوتك جاهزة! '+reply.slice(0,150),'view-tarteel');
        persist();
      }
      // احفظ الخطة في ذاكرة Hermes
      if(!mem.recitation_data) mem.recitation_data={};
      if(!mem.recitation_data.user_plans) mem.recitation_data.user_plans={};
      mem.recitation_data.user_plans[args.username]={ plan:reply||'', generated_at:now(), avg_accuracy:avgAcc, top_errors:topErrWords.slice(0,5), reciter:reciterId };
      mem.stats.users_helped++;
      return {ok:true, username:args.username, avg_accuracy:avgAcc, top_errors:topErrWords, coaching_plan:reply||'تعذّر توليد الخطة', reciter_used:reciterId, base_audio_url:`https://everyayah.com/data/${reciterFolder}/`};
    }

    /* ═══ أدوات البرمجة الذاتية ═══ */

    case 'list_project_files': {
      const base = ROOT; // quran-coach/
      const sub  = String(args.subdir||'').replace(/\.\./g,'').replace(/^\/+/,'');
      const dir  = sub ? path.join(base, sub) : base;
      try {
        const entries = fs.readdirSync(dir, {withFileTypes:true});
        const files = entries.map(e=>{
          try {
            const fp = path.join(dir, e.name);
            const st = fs.statSync(fp);
            return { name:e.name, type:e.isDirectory()?'dir':'file', size_kb:e.isFile()?+(st.size/1024).toFixed(1):null, modified:st.mtime.toISOString().slice(0,16) };
          } catch{ return {name:e.name,type:'?'}; }
        }).filter(e=>!e.name.startsWith('.')); // skip hidden
        return { dir: sub||'quran-coach/', count:files.length, files };
      } catch(e){ return {error:e.message}; }
    }

    case 'read_project_file': {
      const safePath = String(args.file_path||'').replace(/\.\.\//g,'').replace(/^\/+/,'');
      if (!safePath) return {error:'file_path required'};
      const fp = path.join(ROOT, safePath);
      // ضمان أن الملف داخل مجلد المشروع
      if (!fp.startsWith(ROOT)) return {error:'access_denied: outside project'};
      try {
        const content = fs.readFileSync(fp,'utf8');
        const lines   = content.split('\n');
        const start   = Math.max(0, (+args.start_line||1)-1);
        const count   = Math.min(200, +args.lines||100);
        const slice   = lines.slice(start, start+count);
        return {
          file: safePath,
          total_lines: lines.length,
          shown_from: start+1,
          shown_to:   start+slice.length,
          content: slice.join('\n'),
          size_kb: +(Buffer.byteLength(content)/1024).toFixed(1)
        };
      } catch(e){ return {error:e.message}; }
    }

    case 'write_project_file': {
      /* أي ملف داخل مجلد المشروع مسموح لـ Hermes بتعديله — بدون whitelist */
      const safePath = String(args.file_path||'').replace(/\.\.\//g,'').replace(/^\/+/,'');
      if (!safePath || safePath.includes('..')) return {error:'access_denied: invalid path'};
      const fp = path.join(ROOT, safePath);
      const oldText = String(args.old_text||'');
      const newText = String(args.new_text||'');
      const reason  = String(args.reason||'').slice(0,300);
      if (!oldText) return {error:'old_text required'};
      try {
        const content = fs.readFileSync(fp,'utf8');
        if (!content.includes(oldText)) return {error:'old_text not found in file — read the file first to get exact text'};
        // نسخة احتياطية تلقائية قبل أي تعديل
        const backupPath = fp + '.hermes_backup_' + Date.now();
        fs.writeFileSync(backupPath, content, 'utf8');
        const updated = content.replace(oldText, newText);
        // فحص أساسي: السطور لا تقل كثيراً (guard against empty writes)
        if (updated.length < content.length * 0.5) return {error:'safety_block: new content is less than 50% of original — aborting'};
        fs.writeFileSync(fp, updated, 'utf8');
        // حفظ سجل التعديلات في ذاكرة Hermes
        if (!mem.code_edits) mem.code_edits=[];
        mem.code_edits.push({ file:safePath, reason, at:now(), chars_changed: Math.abs(newText.length-oldText.length) });
        mem.code_edits = mem.code_edits.slice(-20); // آخر 20 تعديل فقط
        const editResult = { ok:true, file:safePath, reason, backup:backupPath, chars_before:oldText.length, chars_after:newText.length };
        // ══ تعلّم Hermes من التعديل (خلفي — لا يعرقل الاستجابة) ══
        setImmediate(async()=>{
          try {
            const cfg = getActiveAIConfig();
            if(!cfg) return;
            const learning = await callAI(
              'أنت Hermes Agent. استخرج درساً مكتسباً واحداً مختصراً من هذا التعديل على الكود (جملة واحدة بالعربية فقط).',
              `الملف: ${safePath}\nالسبب: ${reason}\nقبل: ${oldText.slice(0,250)}\nبعد: ${newText.slice(0,250)}`, 80
            );
            if(learning && learning.length > 5){
              const freshMem = readHermesMemory();
              if(!freshMem.skills) freshMem.skills=[];
              const existingIdx = freshMem.skills.findIndex(s=>s.applies_to==='code_edit' && s.title===safePath);
              if(existingIdx>=0){
                freshMem.skills[existingIdx] = {...freshMem.skills[existingIdx], content:learning, updated_at:now(), updated_count:(freshMem.skills[existingIdx].updated_count||1)+1};
              } else {
                freshMem.skills.push({id:uid(), title:safePath, content:learning, applies_to:'code_edit', tags:['code_change','auto_learned'], created_at:now(), updated_count:1});
              }
              freshMem.skills = freshMem.skills.slice(-40);
              writeHermesMemory(freshMem);
              console.log(`[Hermes Learning] ✅ Learned from ${safePath}: ${learning.slice(0,80)}`);
            }
          } catch(e){ console.error('[Hermes Learning]', e.message); }
        });
        return editResult;
      } catch(e){ return {error:e.message}; }
    }

    case 'analyze_and_improve_algorithm': {
      const focus = String(args.focus||'all');
      // اقرأ الكود ذي الصلة حسب الفوكس
      let codeContext = '';
      try {
        if (focus==='ml_weights'||focus==='all') {
          const ac = fs.readFileSync(path.join(ROOT,'ai_core.js'),'utf8');
          codeContext += '\n\n=== ai_core.js (ML weights section) ===\n' + ac.slice(0,3000);
        }
        if (focus==='recitation_matching'||focus==='word_similarity'||focus==='all') {
          const appJs = fs.readFileSync(path.join(ROOT,'public','app.js'),'utf8');
          // استخرج processChunk فقط
          const m = appJs.match(/processChunk[\s\S]{0,4000}/);
          if (m) codeContext += '\n\n=== app.js processChunk ===\n' + m[0].slice(0,3000);
        }
        if (focus==='sr_restart'||focus==='all') {
          const appJs = fs.readFileSync(path.join(ROOT,'public','app.js'),'utf8');
          const m = appJs.match(/makeSR[\s\S]{0,2000}/);
          if (m) codeContext += '\n\n=== app.js makeSR ===\n' + m[0].slice(0,2000);
        }
      } catch(e){ codeContext += '\n[read error: '+e.message+']'; }
      // اجمع بيانات الأخطاء الحقيقية
      const recLogs  = readLogFile('recitation_errors.jsonl', 100);
      const errLogs  = readLogFile('errors.jsonl', 50);
      const wordErr  = {};
      recLogs.forEach(r=>{ if(Array.isArray(r.wrong_words)) r.wrong_words.forEach(w=>{wordErr[w]=(wordErr[w]||0)+1;}); });
      const topWords = Object.entries(wordErr).sort((a,b)=>b[1]-a[1]).slice(0,15).map(([w,c])=>`${w}(${c})`).join('، ');
      const avgAcc   = recLogs.length ? +(recLogs.reduce((s,r)=>s+(r.accuracy_pct||0),0)/recLogs.length).toFixed(1) : 0;
      const sysP = `أنت Hermes Agent — وكيل ذكاء اصطناعي متخصص في تحليل وتحسين كود JavaScript.
مهمتك: تحليل الكود الحقيقي + بيانات الأخطاء الحقيقية وتوليد تحسينات دقيقة وقابلة للتنفيذ.
قواعد:
- كن دقيقاً: اذكر أسماء الدوال والمتغيرات الحقيقية
- اقترح تعديلات صغيرة ومحددة (old_text → new_text)
- لا تعيد كتابة كل شيء، فقط ما يحتاج تحسيناً
- اكتب الرد بالعربية مع الكود بالإنجليزية`;
      const userP = `بيانات التلاوة الحقيقية:
- جلسات مُحللة: ${recLogs.length}
- متوسط الدقة: ${avgAcc}%
- الكلمات الأكثر خطأ: ${topWords||'لا بيانات بعد'}
- عدد أخطاء السيرفر: ${errLogs.length}

كود المشروع الحالي:
${codeContext.slice(0,5000)}

Focus: ${focus}

اقترح 2-3 تحسينات محددة للكود بناءً على البيانات أعلاه. لكل تحسين: اشرح المشكلة، القيمة القديمة، القيمة الجديدة المقترحة، والسبب.`;
      const reply = await callAI(sysP, userP);
      // حفظ التحليل في ذاكرة Hermes
      if(!mem.algorithm_analyses) mem.algorithm_analyses=[];
      mem.algorithm_analyses.push({ focus, at:now(), avg_accuracy:avgAcc, top_words:topWords, analysis:reply||'', sessions_analyzed:recLogs.length });
      mem.algorithm_analyses = mem.algorithm_analyses.slice(-10);
      return { ok:true, focus, avg_accuracy:avgAcc, sessions_analyzed:recLogs.length, top_error_words:topWords, analysis:reply||'تعذّر التحليل', note:'استخدم write_project_file لتطبيق التحسينات المقترحة' };
    }

    case 'test_server_health': {
      const checks = [];
      const base = `http://localhost:${PORT}`;
      const endpoints = [
        {path:'/', method:'GET', label:'Static homepage'},
        {path:'/qqc/auth/check-username?username=test', method:'GET', label:'Auth check'},
      ];
      for (const ep of endpoints) {
        try {
          const r = await fetch(`${base}${ep.path}`, {method:ep.method, signal:AbortSignal.timeout(3000)});
          checks.push({endpoint:ep.path, status:r.status, ok:r.status<500, label:ep.label});
        } catch(e){ checks.push({endpoint:ep.path, status:'error', ok:false, error:e.message, label:ep.label}); }
      }
      const allOk = checks.every(c=>c.ok);
      return { server_healthy:allOk, port:PORT, checks, note: allOk?'السيرفر يعمل بشكل صحيح':'تحقق من السجلات' };
    }

    case 'git_commit_changes': {
      const { message } = args;
      if (!message) return { ok:false, error:'message مطلوب' };
      const gh = DB.admin.ai_settings?.github || {};
      const githubToken = gh.token || process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
      if (!githubToken) return { ok:false, error:'لم يتم ربط GitHub بعد — اذهب لإعدادات الذكاء الاصطناعي وأدخل GitHub Token' };
      const REPO_OWNER = gh.repo_owner || 'abuahmad-21';
      const REPO_NAME  = gh.repo_name  || 'Quranic-Plan-Manager';
      const BRANCH     = gh.branch     || 'main';
      const { execSync } = await import('child_process');
      try {
        const repoUrl = `https://${REPO_OWNER}:${githubToken}@github.com/${REPO_OWNER}/${REPO_NAME}.git`;
        const gitDir  = path.join(__dirname, '..');
        const status  = execSync('git status --porcelain', { cwd: gitDir, encoding:'utf8' }).trim();
        if (!status) return { ok:true, committed:false, note:'لا توجد تغييرات للرفع — الكود متزامن بالفعل مع GitHub' };
        execSync('git add -A', { cwd: gitDir });
        const safeMsg = message.replace(/"/g, "'");
        execSync(`git -c user.email="hermes@qqc.ai" -c user.name="Hermes Agent" commit -m "${safeMsg}"`, { cwd: gitDir });
        execSync(`git push ${repoUrl} ${BRANCH}`, { cwd: gitDir, stdio:'pipe' });
        const commitHash = execSync('git rev-parse --short HEAD', { cwd: gitDir, encoding:'utf8' }).trim();
        if (!mem.code_edits) mem.code_edits = [];
        mem.code_edits.push({ at: new Date().toISOString(), commit: commitHash, message });
        return { ok:true, committed:true, commit_hash:commitHash, message, repo:`github.com/${REPO_OWNER}/${REPO_NAME}`, note:'تم الرفع إلى GitHub بنجاح ✅' };
      } catch(e){
        return { ok:false, error: e.message?.slice(0,300)||'خطأ في git', note:'تأكد من صحة الـ token وأذونات الريبو' };
      }
    }

    /* ═══ أدوات المختبر والإنترنت ═══ */

    case 'web_search': {
      const query = String(args.query||'').slice(0,300);
      if(!query) return {error:'query مطلوب'};
      const UA = 'Mozilla/5.0 (compatible; HermesAgent/2.0; +https://qurancoach.app)';
      const results = [];

      // 1. DuckDuckGo Instant Answer API
      try {
        const ddgApi = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
        const r = await fetch(ddgApi, {headers:{'User-Agent':UA}, signal:AbortSignal.timeout(7000)});
        const d = await r.json();
        if(d.AbstractText) results.push({title:d.Heading||query, snippet:d.AbstractText.slice(0,500), url:d.AbstractURL||''});
        (d.RelatedTopics||[]).slice(0,5).forEach(t=>{ if(t.Text) results.push({title:t.Text.slice(0,100), snippet:t.Text.slice(0,400), url:t.FirstURL||''}); });
      } catch {}

      // 2. DuckDuckGo HTML Lite — scrape snippets
      if(results.length < 3) {
        try {
          const liteUrl = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
          const r = await fetch(liteUrl, {headers:{'User-Agent':UA,'Accept':'text/html'}, signal:AbortSignal.timeout(9000)});
          const html = await r.text();
          // Extract result links
          const linkRe = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*class="result-link"[^>]*>([^<]+)<\/a>/g;
          const snippRe = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/g;
          const links=[]; let m;
          while((m=linkRe.exec(html))!==null) links.push({url:m[1],title:m[2].trim()});
          const snippets=[]; let s;
          while((s=snippRe.exec(html))!==null) snippets.push(s[1].replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim());
          links.slice(0,8).forEach((l,i)=>{ if(snippets[i]||l.title) results.push({title:l.title, snippet:snippets[i]||'', url:l.url}); });
        } catch {}
      }

      // 3. Wikipedia fallback (English + Arabic)
      if(results.length < 2) {
        try {
          const wikiQ = encodeURIComponent(query);
          const wikiR = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${wikiQ}`, {headers:{'User-Agent':UA}, signal:AbortSignal.timeout(6000)});
          if(wikiR.ok){ const w=await wikiR.json(); if(w.extract) results.push({title:w.title, snippet:w.extract.slice(0,600), url:w.content_urls?.desktop?.page||'', source:'wikipedia'}); }
        } catch {}
        try {
          const wikiAr = await fetch(`https://ar.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`, {headers:{'User-Agent':UA}, signal:AbortSignal.timeout(6000)});
          if(wikiAr.ok){ const w=await wikiAr.json(); if(w.extract) results.push({title:w.title, snippet:w.extract.slice(0,600), url:w.content_urls?.desktop?.page||'', source:'wikipedia_ar'}); }
        } catch {}
      }

      if(!results.length) return {query, ok:false, message:'لم يُوجد نتائج. جرّب fetch_url مع رابط محدد.', tip:'مثال: fetch_url بـ https://en.wikipedia.org/wiki/Spaced_repetition'};
      return {query, ok:true, count:results.length, results};
    }

    case 'fetch_url': {
      const url = String(args.url||'');
      if(!url.startsWith('http')) return {error:'رابط غير صالح'};
      const maxChars = Math.min(8000, +args.max_chars||3000);
      try {
        const resp = await fetch(url, {headers:{'User-Agent':'HermesAgent/2.0','Accept':'text/html,application/json,*/*'}, signal:AbortSignal.timeout(10000)});
        const ct = resp.headers.get('content-type')||'';
        let text = await resp.text();
        // إزالة HTML tags للتبسيط
        if(ct.includes('html')) text = text.replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/\s{2,}/g,' ').trim();
        const truncated = text.length > maxChars;
        return {url, status:resp.status, content_type:ct.slice(0,50), chars:text.length, truncated, content:text.slice(0,maxChars)+(truncated?'\n...[مقتطع]':'')};
      } catch(e){ return {error:'فشل جلب الرابط: '+e.message, url}; }
    }

    case 'learn_skill_from_web': {
      const topic = String(args.topic||'').slice(0,200);
      if(!topic) return {error:'topic مطلوب'};
      const queries = Array.isArray(args.search_queries) ? args.search_queries.slice(0,4) : [topic];
      const appliesTo = args.applies_to || 'general';
      const context = String(args.context||'تطبيق Quantum Quran Coach لحفظ القرآن الكريم').slice(0,300);
      const UA = 'Mozilla/5.0 (compatible; HermesLearner/2.0)';
      let rawContent = [];
      const urlsToFetch = Array.isArray(args.urls_to_fetch) ? [...args.urls_to_fetch] : [];
      const seenUrls = new Set();

      // 1. بحث DuckDuckGo لكل استعلام
      for(const q of queries){
        try {
          // DuckDuckGo Instant Answer
          const r = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`,
            {headers:{'User-Agent':UA}, signal:AbortSignal.timeout(7000)});
          const d = await r.json();
          if(d.AbstractText) rawContent.push(`[DDG:${q}] ${d.AbstractText.slice(0,600)}`);
          (d.RelatedTopics||[]).slice(0,3).forEach(t=>{ if(t.Text) rawContent.push(`• ${t.Text.slice(0,200)}`); });
          if(d.AbstractURL && !seenUrls.has(d.AbstractURL)){ seenUrls.add(d.AbstractURL); urlsToFetch.push(d.AbstractURL); }
        } catch {}
        // Wikipedia
        try {
          const wkR = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(q)}`,{headers:{'User-Agent':UA}, signal:AbortSignal.timeout(6000)});
          if(wkR.ok){ const w=await wkR.json(); if(w.extract){ rawContent.push(`[Wikipedia:${w.title}] ${w.extract.slice(0,800)}`); if(w.content_urls?.desktop?.page) urlsToFetch.push(w.content_urls.desktop.page); } }
        } catch {}
        try {
          const wkAr = await fetch(`https://ar.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(q)}`,{headers:{'User-Agent':UA}, signal:AbortSignal.timeout(6000)});
          if(wkAr.ok){ const w=await wkAr.json(); if(w.extract) rawContent.push(`[ويكيبيديا:${w.title}] ${w.extract.slice(0,800)}`); }
        } catch {}
      }

      // 2. جلب محتوى أفضل 3 روابط
      const uniqueUrls = [...new Set(urlsToFetch)].filter(u=>u.startsWith('http')&&!u.includes('duckduckgo')).slice(0,3);
      for(const url of uniqueUrls){
        try {
          const r = await fetch(url, {headers:{'User-Agent':UA,'Accept':'text/html,application/json'}, signal:AbortSignal.timeout(9000)});
          const ct = r.headers.get('content-type')||'';
          let txt = await r.text();
          if(ct.includes('html')) txt = txt.replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/\s{2,}/g,' ').trim();
          if(txt.length>100) rawContent.push(`[مصدر: ${url.slice(0,60)}]\n${txt.slice(0,2500)}`);
        } catch {}
      }

      if(!rawContent.length) return {ok:false, topic, error:'لم يُعثر على محتوى — جرّب استعلامات مختلفة أو روابط مباشرة'};

      // 3. تلخيص بالذكاء الاصطناعي
      const combined = rawContent.join('\n\n').slice(0, 9000);
      const activeCfg = getActiveAIConfig();
      let summary = '';
      if(activeCfg){
        try {
          const sr = await fetch(`${activeCfg.baseUrl}/chat/completions`,{
            method:'POST', signal:AbortSignal.timeout(30000),
            headers:{'Authorization':`Bearer ${activeCfg.apiKey}`,'Content-Type':'application/json'},
            body:JSON.stringify({model:activeCfg.model, max_tokens:700, messages:[
              {role:'system', content:'أنت خبير تعليمي. استخرج المعلومات الأكثر قيمة وعملية وقابلة للتطبيق. الرد بالعربية.'},
              {role:'user', content:`لخّص هذا المحتوى عن "${topic}" في سياق "${context}".\n\nاستخرج:\n1. التعريف الجوهري\n2. المبادئ الرئيسية (3-5 نقاط)\n3. كيفية التطبيق العملي في التطبيق\n4. أرقام أو حقائق مهمة\n\nالمحتوى:\n${combined}`}
            ]})
          });
          const sd = await sr.json();
          summary = sd.choices?.[0]?.message?.content || '';
        } catch {}
      }
      if(!summary) summary = rawContent.map(c=>c.slice(0,150)).join('\n').slice(0,700);

      // 4. حفظ كمهارة دائمة
      if(!mem.skills) mem.skills=[];
      const existIdx = mem.skills.findIndex(s=>s.title.toLowerCase()===topic.toLowerCase());
      const skill = {
        id: uid(), title:topic, content:summary,
        tags:[...queries, appliesTo], applies_to:appliesTo,
        sources:uniqueUrls, learned_at:now(),
        updated_count: existIdx>=0 ? (mem.skills[existIdx].updated_count||0)+1 : 1
      };
      if(existIdx>=0) mem.skills[existIdx]=skill; else mem.skills.push(skill);
      if(mem.skills.length>300) mem.skills=mem.skills.slice(-300);

      // 5. تسجيل رؤية
      if(!mem.insights) mem.insights=[];
      mem.insights.push({text:`تعلّمت مهارة جديدة: "${topic}" — ${summary.slice(0,100)}`, category:'general', impact:'medium', at:now()});

      return {ok:true, topic, summary:summary.slice(0,400), sources_fetched:uniqueUrls.length, raw_chunks:rawContent.length, total_skills:mem.skills.length, skill_saved:true, applies_to:appliesTo};
    }

    case 'browser_open': {
      const url = String(args.url||'');
      if(!url.startsWith('http')) return {error:'رابط غير صالح — يجب أن يبدأ بـ http'};
      const maxChars = Math.min(10000, +args.max_chars||5000);
      const doLinks = args.extract_links !== false;
      const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
      try {
        const resp = await fetch(url, {
          headers:{'User-Agent':UA,'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8','Accept-Language':'ar,en;q=0.5'},
          signal:AbortSignal.timeout(12000)
        });
        const ct = resp.headers.get('content-type')||'';
        let raw = await resp.text();
        let title = (raw.match(/<title[^>]*>([^<]+)<\/title>/i)||[])[1]?.trim()||url;

        // استخراج الروابط قبل تنظيف HTML
        const links = [];
        if(doLinks){
          const linkRe = /<a[^>]+href="(https?:\/\/[^"#?]+)"[^>]*>([^<]{3,80})<\/a>/gi;
          let lm; const seen=new Set();
          while((lm=linkRe.exec(raw))!==null && links.length<15){
            if(!seen.has(lm[1])){ seen.add(lm[1]); links.push({url:lm[1], text:lm[2].replace(/<[^>]+>/g,'').trim().slice(0,80)}); }
          }
        }

        // تنظيف HTML واستخراج النص
        if(ct.includes('html')){
          raw = raw
            .replace(/<script[\s\S]*?<\/script>/gi,'')
            .replace(/<style[\s\S]*?<\/style>/gi,'')
            .replace(/<nav[\s\S]*?<\/nav>/gi,'')
            .replace(/<footer[\s\S]*?<\/footer>/gi,'')
            .replace(/<header[\s\S]*?<\/header>/gi,'')
            .replace(/<aside[\s\S]*?<\/aside>/gi,'')
            .replace(/<!--[\s\S]*?-->/g,'')
            .replace(/<[^>]+>/g,' ')
            .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&nbsp;/g,' ').replace(/&#\d+;/g,' ')
            .replace(/\s{3,}/g,' ').trim();
        }

        // سجّل في تاريخ التصفح
        if(!mem.browser_history) mem.browser_history=[];
        mem.browser_history.push({url, title:title.slice(0,100), at:now(), chars:raw.length});
        if(mem.browser_history.length>100) mem.browser_history=mem.browser_history.slice(-100);

        return {ok:true, url, title:title.slice(0,200), status:resp.status, content_type:ct.slice(0,40), chars:raw.length, truncated:raw.length>maxChars, content:raw.slice(0,maxChars)+(raw.length>maxChars?'\n…[مقتطع]':''), links};
      } catch(e){ return {error:'فشل فتح الصفحة: '+e.message, url}; }
    }

    case 'browser_search': {
      const query = String(args.query||'').slice(0,300);
      if(!query) return {error:'query مطلوب'};
      const engines = Array.isArray(args.engines) ? args.engines : ['duckduckgo','wikipedia','wikipedia_ar'];
      const openTop = Math.min(3, +args.open_top_results||0);
      const UA = 'Mozilla/5.0 (compatible; HermesBot/2.0)';
      const results = [];

      // DuckDuckGo Instant Answer
      if(engines.includes('duckduckgo')){
        try {
          const r = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`, {headers:{'User-Agent':UA}, signal:AbortSignal.timeout(8000)});
          const d = await r.json();
          if(d.AbstractText) results.push({title:d.Heading||query, snippet:d.AbstractText.slice(0,500), url:d.AbstractURL||'', source:'duckduckgo', type:'answer'});
          (d.RelatedTopics||[]).slice(0,6).forEach(t=>{ if(t.Text&&t.FirstURL) results.push({title:t.Text.slice(0,100), snippet:t.Text.slice(0,400), url:t.FirstURL, source:'duckduckgo', type:'related'}); });
        } catch {}
        // DuckDuckGo HTML Lite scrape
        try {
          const r = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, {headers:{'User-Agent':UA,'Accept':'text/html'}, signal:AbortSignal.timeout(10000)});
          const html = await r.text();
          const snippRe = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/g;
          const linkRe = /<a[^>]+class="result-link"[^>]+href="(https?:\/\/[^"]+)"[^>]*>([^<]+)<\/a>/g;
          const snips=[],lnks=[]; let sm,lm2;
          while((sm=snippRe.exec(html))!==null) snips.push(sm[1].replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim());
          while((lm2=linkRe.exec(html))!==null) lnks.push({url:lm2[1],title:lm2[2].trim()});
          lnks.slice(0,8).forEach((l,i)=>{ if(l.title) results.push({title:l.title, snippet:snips[i]||'', url:l.url, source:'duckduckgo_web', type:'web'}); });
        } catch {}
      }

      // Wikipedia English
      if(engines.includes('wikipedia')){
        try {
          const r = await fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&utf8=1&format=json&srlimit=5`, {headers:{'User-Agent':UA}, signal:AbortSignal.timeout(7000)});
          const d = await r.json();
          (d.query?.search||[]).forEach(s=>results.push({title:s.title, snippet:(s.snippet||'').replace(/<[^>]+>/g,'').slice(0,400), url:`https://en.wikipedia.org/wiki/${encodeURIComponent(s.title)}`, source:'wikipedia', type:'article'}));
        } catch {}
      }

      // Wikipedia Arabic
      if(engines.includes('wikipedia_ar')){
        try {
          const r = await fetch(`https://ar.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&utf8=1&format=json&srlimit=5`, {headers:{'User-Agent':UA}, signal:AbortSignal.timeout(7000)});
          const d = await r.json();
          (d.query?.search||[]).forEach(s=>results.push({title:s.title, snippet:(s.snippet||'').replace(/<[^>]+>/g,'').slice(0,400), url:`https://ar.wikipedia.org/wiki/${encodeURIComponent(s.title)}`, source:'wikipedia_ar', type:'article'}));
        } catch {}
      }

      // فتح أفضل النتائج تلقائياً
      const openedPages = [];
      if(openTop > 0){
        const toOpen = results.filter(r=>r.url&&r.url.startsWith('http')).slice(0,openTop);
        for(const r of toOpen){
          try {
            const pr = await fetch(r.url, {headers:{'User-Agent':UA}, signal:AbortSignal.timeout(9000)});
            let txt = await pr.text();
            txt = txt.replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/\s{3,}/g,' ').trim();
            openedPages.push({url:r.url, title:r.title, content:txt.slice(0,2000)});
          } catch {}
        }
      }

      // سجّل في تاريخ التصفح
      if(!mem.browser_history) mem.browser_history=[];
      mem.browser_history.push({url:'search:'+query, title:'بحث: '+query, at:now(), results:results.length});
      if(mem.browser_history.length>100) mem.browser_history=mem.browser_history.slice(-100);

      return {ok:true, query, results_count:results.length, results:results.slice(0,15), opened_pages:openedPages};
    }

    case 'save_learning_file': {
      const rawName = String(args.filename||'learning').replace(/[^a-zA-Z0-9_\u0600-\u06FF\s-]/g,'').trim();
      const filename = rawName.replace(/\s+/g,'_')+(rawName.endsWith('.md')?'':'.md');
      const fp = path.join(HERMES_LAB_DIR, filename);
      const title = String(args.title||'').slice(0,200);
      const body = String(args.content||'');
      const full = `# ${title}\n\n*تاريخ التعلّم: ${new Date().toLocaleDateString('ar-SA')} | هرمز*\n\n${body}`;
      fs.writeFileSync(fp, full, 'utf8');
      const sizeKb = Math.round(full.length/1024*10)/10;

      // حفظ مهارة في الذاكرة أيضاً
      if(args.skill_title){
        if(!mem.skills) mem.skills=[];
        const skill={id:uid(), title:String(args.skill_title).slice(0,100), content:body.slice(0,700), tags:[filename], applies_to:args.skill_applies_to||'general', created_at:now(), updated_count:1, source_file:filename};
        const idx=mem.skills.findIndex(s=>s.title===skill.title);
        if(idx>=0) mem.skills[idx]={...skill,updated_count:(mem.skills[idx].updated_count||0)+1}; else mem.skills.push(skill);
        if(mem.skills.length>300) mem.skills=mem.skills.slice(-300);
      }

      return {ok:true, filename, title, size_kb:sizeKb, lab_url:`/qqc/admin/hermes/lab/file/${encodeURIComponent(filename)}`, chars:body.length};
    }

    case 'generate_tts_file': {
      return { disabled:true, error:'توليد الصوت بالذكاء الاصطناعي معطّل. استخدم get_sheikh_audio_refs للحصول على روابط صوتيات الشيوخ الحقيقية المجانية بدلاً من التوليد الاصطناعي.', suggestion:'استدعِ get_sheikh_audio_refs مع رقم السورة والآية والشيخ المطلوب' };
    }

    case 'get_sheikh_audio_refs': {
      const surah = Math.max(1, Math.min(114, +args.surah_number||1));
      const fromAyah = Math.max(1, +args.from_ayah||1);
      const toAyah = Math.max(fromAyah, Math.min(fromAyah+20, +args.to_ayah||fromAyah));
      const sheikhId = args.sheikh_id||'ar.alafasy';
      const AUDIO_SOURCES = JSON.parse(fs.readFileSync(path.join(ROOT,'config','audio_sources.json'),'utf8'));
      const sheikhInfo = AUDIO_SOURCES.sheikhs[sheikhId] || AUDIO_SOURCES.sheikhs['ar.alafasy'];
      const surahPad = String(surah).padStart(3,'0');
      const refs = [];
      for(let ayah=fromAyah; ayah<=toAyah; ayah++){
        const ayahPad = String(ayah).padStart(3,'0');
        refs.push({
          ayah,
          everyayah_url: `https://everyayah.com/data/${sheikhInfo.everyayah_folder}/${surahPad}${ayahPad}.mp3`,
          islamic_network_url: `https://cdn.islamic.network/quran/audio/128/${sheikhInfo.islamic_network_id}/${surah}:${ayah}.mp3`,
          sheikh_name: sheikhInfo.name_ar,
        });
      }
      // Save to memory as training reference
      if(!mem.sheikh_audio_refs) mem.sheikh_audio_refs=[];
      mem.sheikh_audio_refs.push({ surah, fromAyah, toAyah, sheikh:sheikhId, at:now(), count:refs.length });
      mem.sheikh_audio_refs = mem.sheikh_audio_refs.slice(-50);
      return { ok:true, surah_number:surah, sheikh:sheikhInfo.name_ar, sheikh_id:sheikhId, ayah_count:refs.length, refs, note:'هذه روابط مباشرة لصوتيات الشيوخ الأصليين — مجانية بدون ذكاء اصطناعي' };
    }

    case 'train_on_all_data': {
      const focus = args.focus||'all';
      const result = { focus, trained_on:{}, insights:[] };
      // 1. Recitation errors
      if(focus==='all'||focus==='recitation'){
        const recLogs = readLogFile('recitation_errors.jsonl', 500);
        const wordErr = {};
        let totalAcc=0, count=0;
        recLogs.forEach(r=>{
          if(Array.isArray(r.wrong_words)) r.wrong_words.forEach(w=>{wordErr[w]=(wordErr[w]||0)+1;});
          if(r.accuracy_pct){ totalAcc+=r.accuracy_pct; count++; }
        });
        const topErrors = Object.entries(wordErr).sort((a,b)=>b[1]-a[1]).slice(0,30);
        if(!mem.recitation_training) mem.recitation_training={};
        mem.recitation_training.top_error_words = topErrors;
        mem.recitation_training.avg_accuracy = count ? +(totalAcc/count).toFixed(1) : 0;
        mem.recitation_training.total_sessions = recLogs.length;
        mem.recitation_training.updated_at = now();
        result.trained_on.recitation = { sessions:recLogs.length, unique_errors:Object.keys(wordErr).length, avg_accuracy:mem.recitation_training.avg_accuracy, top_3_errors:topErrors.slice(0,3).map(([w,c])=>({word:w,count:c})) };
        if(topErrors.length) result.insights.push(`أكثر الكلمات خطأً: ${topErrors.slice(0,5).map(([w,c])=>`${w}(${c})`).join('، ')}`);
      }
      // 2. User sessions
      if(focus==='all'||focus==='sessions'){
        const users = Object.values(DB.users);
        const totalSessions = users.reduce((s,u)=>s+(u.sessions||[]).length,0);
        const avgDifficulty = { easy:0, medium:0, hard:0 };
        users.forEach(u=>(u.sessions||[]).forEach(s=>{ if(avgDifficulty[s.difficulty]!==undefined) avgDifficulty[s.difficulty]++; }));
        if(!mem.session_training) mem.session_training={};
        mem.session_training.total_sessions = totalSessions;
        mem.session_training.difficulty_distribution = avgDifficulty;
        mem.session_training.avg_pages = users.length ? +(users.reduce((s,u)=>s+(u.progress?.total_pages_memorized||0),0)/users.length).toFixed(2) : 0;
        mem.session_training.updated_at = now();
        result.trained_on.sessions = mem.session_training;
      }
      // 3. Channel messages
      if(focus==='all'||focus==='messages'){
        const allMsgs = [];
        Object.values(DB.channels).forEach(ch=>(ch.messages||[]).forEach(m=>allMsgs.push(m.text)));
        const msgCount = allMsgs.length;
        const keywords = {};
        allMsgs.forEach(t=>{ t.split(/\s+/).forEach(w=>{ if(w.length>3){ keywords[w]=(keywords[w]||0)+1; } }); });
        const topKw = Object.entries(keywords).sort((a,b)=>b[1]-a[1]).slice(0,20);
        if(!mem.message_training) mem.message_training={};
        mem.message_training.total_messages = msgCount;
        mem.message_training.top_keywords = topKw;
        mem.message_training.updated_at = now();
        result.trained_on.messages = { count:msgCount, top_keywords:topKw.slice(0,5) };
      }
      // 4. Error logs
      if(focus==='all'||focus==='errors'){
        const errLogs = readLogFile('errors.jsonl', 100);
        const aiErr   = readLogFile('ai_errors.jsonl', 50);
        if(!mem.error_training) mem.error_training={};
        mem.error_training.total_errors = errLogs.length;
        mem.error_training.ai_errors = aiErr.length;
        mem.error_training.updated_at = now();
        result.trained_on.errors = { system_errors:errLogs.length, ai_errors:aiErr.length };
      }
      mem.last_training = now();
      return { ok:true, ...result, note:'تم حفظ بيانات التدريب في الذاكرة — سيُستخدم في تحسين التقييم' };
    }

    case 'analyze_channel_messages': {
      const limit = Math.min(500, +args.limit||200);
      const channels = Object.values(DB.channels);
      const allMessages = [];
      channels.forEach(ch=>{
        (ch.messages||[]).slice(-limit).forEach(m=>{
          allMessages.push({ channel:ch.name, from:m.from, text:m.text, timestamp:m.timestamp });
        });
      });
      if(!allMessages.length) return { message:'لا رسائل في القنوات بعد', count:0 };
      // Basic analysis
      const senders = {};
      const questionCount = allMessages.filter(m=>m.text.includes('؟')||m.text.includes('?')).length;
      allMessages.forEach(m=>{ senders[m.from]=(senders[m.from]||0)+1; });
      const topSenders = Object.entries(senders).sort((a,b)=>b[1]-a[1]).slice(0,10);
      const channelStats = channels.map(ch=>({
        name:ch.name, member_count:ch.members.length, message_count:(ch.messages||[]).length,
        sheikh:ch.sheikh_username, last_message:ch.last_message_at
      }));
      return {
        ok:true, total_messages:allMessages.length, total_channels:channels.length,
        questions_asked:questionCount, top_senders:topSenders,
        channel_stats:channelStats, sample_messages:allMessages.slice(-5).map(m=>({from:m.from,text:m.text.slice(0,100)}))
      };
    }

    case 'improve_recitation_model': {
      const saveToMemory = args.save_to_memory !== false;
      const recLogs = readLogFile('recitation_errors.jsonl', 300);
      const trainingData = readLogFile('ai_training_data.jsonl', 200);
      if(!recLogs.length && !trainingData.length) return { message:'لا بيانات تدريب بعد. سيتحسن النموذج تلقائياً مع جلسات التلاوة.', ok:true };
      // Build error pattern model
      const wordErrorFreq = {};
      const surahDifficulty = {};
      let totalSessions=0, totalCorrect=0, totalWrong=0;
      recLogs.forEach(r=>{
        totalSessions++;
        if(Array.isArray(r.wrong_words)) r.wrong_words.forEach(w=>{ wordErrorFreq[w]=(wordErrorFreq[w]||0)+1; totalWrong++; });
        if(r.surah_name){ surahDifficulty[r.surah_name]=(surahDifficulty[r.surah_name]||{count:0,errors:0}); surahDifficulty[r.surah_name].count++; surahDifficulty[r.surah_name].errors+=(r.wrong_words||[]).length; }
        if(r.accuracy_pct) totalCorrect+=r.accuracy_pct;
      });
      const avgAccuracy = totalSessions ? +(totalCorrect/totalSessions).toFixed(1) : 0;
      const topErrorWords = Object.entries(wordErrorFreq).sort((a,b)=>b[1]-a[1]).slice(0,50);
      const hardestSurahs = Object.entries(surahDifficulty).sort((a,b)=>(b[1].errors/b[1].count)-(a[1].errors/a[1].count)).slice(0,10);
      const model = {
        version: (((mem.recitation_model||{}).version||0)+1),
        trained_at: now(),
        sessions_analyzed: totalSessions,
        avg_accuracy: avgAccuracy,
        top_error_words: topErrorWords,
        hardest_surahs: hardestSurahs.map(([s,d])=>({surah:s, avg_errors:+(d.errors/d.count).toFixed(1), sessions:d.count})),
        model_params: {
          error_weight: Math.min(2.0, 1.0 + (topErrorWords.length/100)),
          difficulty_threshold: Math.max(40, 100 - avgAccuracy),
          correction_sensitivity: avgAccuracy < 70 ? 'high' : avgAccuracy < 85 ? 'medium' : 'low',
        }
      };
      if(saveToMemory) mem.recitation_model = model;
      return { ok:true, model_version:model.version, sessions_analyzed:totalSessions, avg_accuracy:avgAccuracy, top_error_words:topErrorWords.slice(0,10), hardest_surahs:model.hardest_surahs.slice(0,5), model_params:model.model_params, note:saveToMemory?'تم حفظ النموذج المحسّن في الذاكرة ✅':'النموذج مؤقت - لم يُحفظ' };
    }

    case 'list_lab_files': {
      try {
        const entries = fs.readdirSync(HERMES_LAB_DIR);
        const files = entries.map(name=>{
          try {
            const fp=path.join(HERMES_LAB_DIR,name);
            const st=fs.statSync(fp);
            const ext=path.extname(name).toLowerCase();
            const type=ext==='.mp3'||ext==='.wav'||ext==='.ogg'?'audio':ext==='.json'?'json':'text';
            return {filename:name, type, size_kb:+(st.size/1024).toFixed(1), modified:st.mtime.toISOString().slice(0,16), url:`/qqc/admin/hermes/lab/file/${encodeURIComponent(name)}`};
          } catch{ return null; }
        }).filter(Boolean);
        return {count:files.length, files: files.sort((a,b)=>b.modified.localeCompare(a.modified))};
      } catch(e){ return {error:e.message}; }
    }

    case 'delete_lab_file': {
      const filename = String(args.filename||'').replace(/[/\\]/g,'');
      if(!filename) return {error:'filename مطلوب'};
      const fp = path.join(HERMES_LAB_DIR, filename);
      if(!fp.startsWith(HERMES_LAB_DIR)) return {error:'مسار غير صالح'};
      try {
        if(!fs.existsSync(fp)) return {error:'الملف غير موجود'};
        fs.unlinkSync(fp);
        if(mem.lab_files) mem.lab_files = mem.lab_files.filter(f=>f.filename!==filename);
        return {ok:true, deleted:filename};
      } catch(e){ return {error:e.message}; }
    }

    case 'create_text_file': {
      const content = String(args.content||'');
      const rawName = String(args.filename||'hermes_note_'+uid());
      // السماح بامتدادات آمنة فقط
      const allowedExts = ['.txt','.json','.md','.csv','.log'];
      const ext = path.extname(rawName).toLowerCase();
      if(!allowedExts.includes(ext)) return {error:`امتداد غير مسموح — استخدم: ${allowedExts.join(', ')}`};
      const safeName = path.basename(rawName).replace(/[^a-zA-Z0-9_\-\.\u0621-\u064A]/g,'_').slice(0,80);
      const fp = path.join(HERMES_LAB_DIR, safeName);
      if(!fp.startsWith(HERMES_LAB_DIR)) return {error:'مسار غير صالح'};
      try {
        fs.writeFileSync(fp, content, 'utf8');
        if(!mem.lab_files) mem.lab_files=[];
        mem.lab_files.push({filename:safeName, type:ext==='.json'?'json':'text', created_at:now(), size_kb:+(Buffer.byteLength(content)/1024).toFixed(1)});
        mem.lab_files = mem.lab_files.slice(-100);
        return {ok:true, filename:safeName, size_kb:+(Buffer.byteLength(content)/1024).toFixed(1), url:`/qqc/admin/hermes/lab/file/${encodeURIComponent(safeName)}`};
      } catch(e){ return {error:e.message}; }
    }

    case 'search_recitation_videos': {
      const ytKey = DB.admin.ai_settings?.video_api_key || process.env.VIDEO_API_KEY;
      if(!ytKey) return {error:'لا يوجد YouTube API Key — أضفه في إعدادات الذكاء الاصطناعي ← مفتاح API الفيديو'};
      const query = String(args.query||'تلاوة قرآن كريم').slice(0,200);
      const maxResults = Math.min(20, Math.max(1, +args.max_results||10));
      try {
        const ytUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&key=${ytKey}&maxResults=${maxResults}&relevanceLanguage=ar&order=relevance`;
        const ytResp = await fetch(ytUrl, {signal:AbortSignal.timeout(12000)});
        const ytData = await ytResp.json();
        if(ytData.error) return {error:`YouTube API: ${ytData.error.message}`, code:ytData.error.code, hint:'تحقق من صحة YouTube Data API v3 Key'};
        const videos = (ytData.items||[]).map(item=>({
          id:item.id?.videoId||'',
          title:(item.snippet?.title||'').slice(0,150),
          channel:(item.snippet?.channelTitle||'').slice(0,80),
          description:(item.snippet?.description||'').slice(0,250),
          thumbnail:item.snippet?.thumbnails?.medium?.url||'',
          published:(item.snippet?.publishedAt||'').slice(0,10),
          url:`https://youtu.be/${item.id?.videoId}`
        }));
        // Store search in memory for context
        if(!mem.video_searches) mem.video_searches=[];
        mem.video_searches.push({ query, count:videos.length, at:now() });
        mem.video_searches = mem.video_searches.slice(-20);
        return {ok:true, query, videos, total:videos.length, hint:'استخدم add_video_training لحفظ الفيديوهات المفيدة كبيانات تدريب'};
      } catch(e){ return {error:e.message}; }
    }

    case 'add_video_training': {
      if(!mem.recitation_videos) mem.recitation_videos=[];
      const vId = String(args.video_id||'').trim();
      if(!vId) return {error:'video_id مطلوب'};
      const existing = mem.recitation_videos.findIndex(v=>v.id===vId);
      const entry = {
        id:vId,
        title:String(args.title||'').slice(0,200),
        channel:String(args.channel||'').slice(0,100),
        sheikh:String(args.sheikh_name||'').slice(0,100),
        surah:String(args.surah_info||'').slice(0,200),
        notes:String(args.recitation_notes||'').slice(0,1000),
        url:`https://youtu.be/${vId}`,
        added_at:now()
      };
      if(existing>=0) mem.recitation_videos[existing]={...entry};
      else mem.recitation_videos.push(entry);
      if(mem.recitation_videos.length>300) mem.recitation_videos=mem.recitation_videos.slice(-300);
      // Auto-log insight
      if(!mem.insights) mem.insights=[];
      mem.insights.push({ text:`تدريب جديد: "${entry.title}" — ${entry.notes.slice(0,100)}`, category:'recitation', impact:'medium', at:now() });
      return {ok:true, total_training:mem.recitation_videos.length, saved:entry.title, action:existing>=0?'updated':'added'};
    }

    case 'get_video_training_data': {
      const videos = mem.recitation_videos||[];
      const sheikhCounts = {};
      videos.forEach(v=>{ if(v.sheikh){ sheikhCounts[v.sheikh]=(sheikhCounts[v.sheikh]||0)+1; } });
      return { total_videos:videos.length, recent:videos.slice(-10), sheikh_coverage:sheikhCounts, searches_done:(mem.video_searches||[]).length };
    }

    default: return {error:`unknown_tool: ${toolName}`};
  }
}

/* ─── Main Hermes agentic loop — حلقة tool-calling الحقيقية ─── */
async function runHermesAgent(){
  const aiCfg = getActiveAIConfig();
  if(!aiCfg){ console.log('[Hermes] No AI provider configured, skipping run.'); return; }
  const { baseUrl, apiKey, model: hermesModel } = aiCfg;

  const mem = readHermesMemory();
  const runId = uid();
  const runStart = Date.now();
  const maxCalls = mem.cfg_patches?.max_tool_calls||20;
  const focusMode = mem.cfg_patches?.focus_mode||'full_analysis';
  console.log(`[Hermes] Starting run ${runId} | mode:${focusMode} | max_calls:${maxCalls}`);

  // Build context from memory
  const skillsSummary = (mem.skills||[]).slice(-8).map(s=>`• [${s.applies_to||'general'}] ${s.title}: ${s.content.slice(0,120)}`).join('\n') || 'لا توجد مهارات بعد.';
  const recentInsights = (mem.insights||[]).slice(-6).map(i=>`• [${i.impact||'med'}/${i.category}] ${i.text.slice(0,100)}`).join('\n') || 'لا توجد رؤى سابقة.';
  const nextFocus = mem.runs?.slice(-1)?.[0]?.next_run_focus || '';

  const systemPrompt = `أنت Hermes Agent v2 — وكيل ذكاء اصطناعي حقيقي يعمل في خلفية تطبيق "Quantum Quran Coach".

أنت تملك صلاحيات حقيقية وكاملة على النظام:
✅ تقرأ ملفات الأخطاء الحقيقية (JSONL logs)
✅ تعدّل أوزان الخوارزمية مباشرة في قاعدة البيانات
✅ تحدّث نماذج ML للمستخدمين
✅ تعدّل خطط الحفظ تلقائياً
✅ تولّد نصائح عميقة بالذكاء الاصطناعي
✅ تراسل المستخدمين بإشعارات مخصصة
✅ تكتسب مهارات وتتذكرها بين الدورات
✅ تقرأ ملفات الكود الحقيقية (read_project_file, list_project_files)
✅ تعدّل الكود مباشرةً (write_project_file) — ai_core.js و public/app.js
✅ تحلّل الخوارزمية وتقترح تحسينات بالذكاء الاصطناعي (analyze_and_improve_algorithm)
✅ تتحقق من صحة السيرفر بعد التعديلات (test_server_health)
✅ ترفع التعديلات تلقائياً إلى GitHub (git_commit_changes) — بعد كل تعديل ناجح على الكود

الدورة رقم: ${(mem.stats?.total_runs||0)+1}
تعديلات الكود السابقة: ${(mem.code_edits||[]).length} تعديل
مهاراتك المكتسبة:
${skillsSummary}

رؤاك السابقة:
${recentInsights}

${nextFocus ? `تركيز هذه الدورة (قررته من الدورة السابقة): ${nextFocus}` : ''}
${mem.cfg_patches?.special_instruction ? `\n⚡ مهمة خاصة لهذه الدورة (أولوية قصوى):\n${mem.cfg_patches.special_instruction}\n` : ''}
تعليمات الدورة:
1. استخدم get_global_stats أولاً لفهم الوضع الحالي
2. اقرأ السجلات (read_error_logs) لاكتشاف مشاكل حقيقية
3. حلّل أنماط التلاوة (analyze_recitation_patterns, get_recitation_skill_data)
4. امسح المستخدمين وحلّل الحالات الحرجة
5. اتخذ إجراءات حقيقية: عدّل الأوزان، الخطط، أرسل إشعارات
6. إن وجدت مشكلة في الخوارزمية: اقرأ الكود → حلّل → عدّل → تحقق من الصحة
7. احفظ ما تعلّمته وسجّل رؤاك
8. أنهِ بملخص شامل مع خطة الدورة القادمة

قواعد تعديل الكود:
- اقرأ الملف دائماً قبل التعديل (read_project_file)
- نسّخ النص بدقة تامة في old_text (مطابقة حرفية)
- تحقق من صحة السيرفر بعد كل تعديل (test_server_health)
- يمكنك تعديل أي ملف في المشروع (لا قيود على الملفات)
- ارفع كل تعديل ناجح فوراً إلى GitHub (git_commit_changes) بعد التحقق من صحة السيرفر

الحد الأقصى: ${maxCalls} استدعاء. لا تتوقف حتى تأخذ إجراءات ملموسة حقيقية. الردود بالعربية.`;

  const forceCodeAnalysis = focusMode === 'code_analysis' || !!mem.cfg_patches?.special_instruction;
  const messages = [
    { role:'system', content:systemPrompt },
    { role:'user', content: forceCodeAnalysis
        ? `ابدأ فوراً بتحليل الخوارزمية. الوقت: ${new Date().toLocaleString('ar-SA')}. أول استدعاء يجب أن يكون analyze_and_improve_algorithm ثم اقرأ الكود وعدّله وارفعه لـ GitHub.`
        : `ابدأ الدورة الآن. الوقت: ${new Date().toLocaleString('ar-SA')}. انبش في البيانات، اكتشف المشاكل، وأصلحها.`
    }
  ];

  let toolCallCount=0, finished=false, runSummary='', nextRunFocus='', actionsTaken=[];
  let isFirstCall = true;

  while(toolCallCount<maxCalls && !finished){
    // أول استدعاء في وضع code_analysis: أجبر الـ AI على analyze_and_improve_algorithm
    const forcedTool = (isFirstCall && forceCodeAnalysis)
      ? { type:'function', function:{ name:'analyze_and_improve_algorithm' } }
      : 'auto';
    let resp;
    try {
      const supportsTools = !['pollinations','claude_free'].includes(getActiveAIProviderName());
      const reqBody = { model:hermesModel||'gpt-4o-mini', messages, max_tokens:1200 };
      if(supportsTools){ reqBody.tools=HERMES_TOOLS; reqBody.tool_choice=forcedTool; }
      resp = await fetch(`${baseUrl}/chat/completions`,{
        method:'POST',
        headers:{'Authorization':`Bearer ${apiKey}`,'Content-Type':'application/json'},
        body:JSON.stringify(reqBody)
      });
    } catch(e){ console.error('[Hermes] API fetch error',e.message); break; }
    if(!resp.ok){ const errTxt=await resp.text().catch(()=>''); console.error('[Hermes] API HTTP',resp.status, errTxt.slice(0,200)); break; }
    const data = await resp.json();
    const msg = data.choices?.[0]?.message;
    if(!msg) break;
    messages.push(msg);
    if(!msg.tool_calls||!msg.tool_calls.length){ runSummary=msg.content||''; finished=true; break; }

    isFirstCall = false;
    for(const tc of msg.tool_calls){
      toolCallCount++;
      const toolName=tc.function?.name;
      let args={};
      try{ args=JSON.parse(tc.function?.arguments||'{}'); }catch{}
      console.log(`[Hermes][${toolCallCount}/${maxCalls}] ${toolName}(${JSON.stringify(args).slice(0,60)})`);
      let result;
      try{ result=await executeHermesTool(toolName,args,mem); }catch(e){ result={error:e.message}; }
      if(toolName==='done'){
        runSummary=result.summary||''; nextRunFocus=result.next_run_focus||'';
        let _rAt=result.actions_taken;
        if(typeof _rAt==='string'){try{_rAt=JSON.parse(_rAt);}catch{_rAt=[];}}
        actionsTaken=Array.isArray(_rAt)?_rAt:[]; finished=true;
      } else if(result?.ok) {
        actionsTaken.push(`${toolName}: ${JSON.stringify(result).slice(0,80)}`);
      }
      messages.push({ role:'tool', tool_call_id:tc.id, content:JSON.stringify(result) });
    }
  }

  // Persist run record + updated memory
  if(!mem.runs) mem.runs=[];
  if(!mem.stats) mem.stats={total_runs:0,total_tool_calls:0,users_helped:0,weights_updated:0,plans_adjusted:0};
  mem.stats.total_runs++;
  mem.stats.total_tool_calls+=toolCallCount;
  mem.last_run=now();
  mem.runs.push({ id:runId, at:now(), tool_calls:toolCallCount, summary:runSummary, actions:actionsTaken.slice(0,20), next_run_focus:nextRunFocus, duration_ms:Date.now()-runStart });
  if(mem.runs.length>200) mem.runs=mem.runs.slice(-200);
  // مسح special_instruction بعد تنفيذها (مهمة لمرة واحدة)
  if(mem.cfg_patches?.special_instruction){ delete mem.cfg_patches.special_instruction; delete mem.cfg_patches.focus_mode; }
  writeHermesMemory(mem);
  console.log(`[Hermes] Run ${runId} done | ${toolCallCount} tools | ${((Date.now()-runStart)/1000).toFixed(1)}s | actions: ${actionsTaken.length}`);
}

/* ─── Hermes Admin Endpoints ─── */
R('GET','/qqc/admin/hermes-memory', async(req,res)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const mem=readHermesMemory();
  send(res,200,{ code_edits: mem.code_edits||[], skills: mem.skills||[], insights: mem.insights||[], stats: mem.stats||{} });
});

/* ══ GitHub Live Commits Feed ══ */
R('GET','/qqc/admin/github-live-commits', async(req,res)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const gh = DB.admin.ai_settings?.github || {};
  const token = gh.token || process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  const owner = gh.repo_owner; const repo = gh.repo_name; const branch = gh.branch||'main';
  if(!token||!owner||!repo) return send(res,200,{ok:false, error:'GitHub غير مربوط — اذهب لإعدادات الذكاء الاصطناعي وأدخل PAT والريبو', commits:[]});
  try {
    const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits?sha=${branch}&per_page=20`, {
      headers:{Authorization:`token ${token}`,'User-Agent':'HermesAgent/2.0'}, signal:AbortSignal.timeout(8000)
    });
    const data = await r.json();
    if(!Array.isArray(data)) return send(res,200,{ok:false, error:data.message||'خطأ من GitHub API', commits:[]});
    const commits = data.map(c=>({
      sha:c.sha?.slice(0,7), full_sha:c.sha,
      message:c.commit?.message?.split('\n')[0].slice(0,120),
      author:c.commit?.author?.name,
      date:c.commit?.author?.date,
      url:c.html_url,
      by_hermes: !!(c.commit?.author?.email === 'hermes@qqc.ai')
    }));
    send(res,200,{ok:true, repo:`${owner}/${repo}`, branch, commits, count:commits.length});
  } catch(e){ send(res,200,{ok:false, error:e.message, commits:[]}); }
});

/* ══ Claude Free Proxy (free-claude-code) ══ */
let _claudeProxyProcess = null;

R('GET','/qqc/admin/claude-proxy/status', async(req,res)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const running = !!(_claudeProxyProcess && !_claudeProxyProcess.exitCode);
  let reachable = false;
  try { const pr = await fetch('http://localhost:8082/v1/models',{signal:AbortSignal.timeout(2000)}); reachable=pr.ok; } catch{}
  const cp = DB.admin.ai_settings?.claude_proxy||{};
  send(res,200,{ running, reachable, port:8082, provider:cp.provider||'nvidia_nim', api_key_set:!!(cp.api_key), pid:_claudeProxyProcess?.pid });
});

R('POST','/qqc/admin/claude-proxy/save-config', async(req,res)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const b = await readBody(req);
  if(!DB.admin.ai_settings.claude_proxy) DB.admin.ai_settings.claude_proxy={};
  const cp = DB.admin.ai_settings.claude_proxy;
  if(b.provider) cp.provider = String(b.provider).slice(0,50);
  if(b.api_key !== undefined) cp.api_key = String(b.api_key).trim().slice(0,300);
  persist();
  const provMap = {nvidia_nim:'NVIDIA_NIM_API_KEY', openrouter:'OPENROUTER_API_KEY', kimi:'KIMI_API_KEY', deepseek:'DEEPSEEK_API_KEY'};
  const envKey = provMap[cp.provider]||'OPENROUTER_API_KEY';
  const envContent = `# Auto-generated by Hermes Admin\nFCC_PROVIDER=${cp.provider||'nvidia_nim'}\n${envKey}=${cp.api_key||''}\n`;
  try { fs.writeFileSync(path.join(ROOT,'free-claude-code','.env'), envContent, 'utf8'); } catch{}
  send(res,200,{ok:true, provider:cp.provider, env_key:envKey});
});

R('POST','/qqc/admin/claude-proxy/start', async(req,res)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  if(_claudeProxyProcess && !_claudeProxyProcess.exitCode) return send(res,200,{ok:true, already_running:true, port:8082, note:'البروكسي يعمل بالفعل على port 8082'});
  try {
    const {spawn} = await import('child_process');
    const proxyScript = path.join(ROOT,'claude-proxy.js');
    _claudeProxyProcess = spawn('node',[proxyScript],
      {cwd:ROOT, stdio:'pipe', detached:false, env:{...process.env, PROXY_PORT:'8082'}});
    _claudeProxyProcess.stdout?.on('data',d=>console.log('[ClaudeProxy]',d.toString().trim()));
    _claudeProxyProcess.stderr?.on('data',d=>console.error('[ClaudeProxy]',d.toString().trim()));
    _claudeProxyProcess.on('exit',code=>{console.log('[ClaudeProxy] exited',code); _claudeProxyProcess=null;});
    await new Promise(r=>setTimeout(r,2500));
    send(res,200,{ok:true, pid:_claudeProxyProcess?.pid, port:8082, note:'جارٍ تشغيل Claude Proxy — انتظر بضع ثوانٍ ثم اختبر الاتصال'});
  } catch(e){ send(res,200,{ok:false, error:e.message}); }
});

R('POST','/qqc/admin/claude-proxy/stop', async(req,res)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  if(!_claudeProxyProcess) return send(res,200,{ok:true, note:'البروكسي لم يكن يعمل'});
  try { _claudeProxyProcess.kill('SIGTERM'); _claudeProxyProcess=null; send(res,200,{ok:true}); }
  catch(e){ send(res,200,{ok:false, error:e.message}); }
});

/* ══ AI Provider Errors — سجل أخطاء مزودي الذكاء الاصطناعي ══ */
R('GET','/qqc/admin/ai-provider-errors', async(req,res)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const errors = readLogFile('ai_provider_errors.jsonl', 50);
  send(res,200,{ errors: errors.reverse(), total: errors.length });
});

R('DELETE','/qqc/admin/ai-provider-errors', async(req,res)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  clearLogFile('ai_provider_errors.jsonl');
  send(res,200,{ok:true});
});

/* ══ Claude/Hermes Direct Chat — محادثة مباشرة ══ */
R('POST','/qqc/admin/ai-direct-chat', async(req,res)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const b = await readBody(req);
  const msg = String(b.message||'').slice(0,4000);
  if(!msg) return send(res,400,{error:'no_message'});
  const files = (b.files||[]).map(f=>({name:String(f.name||'file').slice(0,60), content:String(f.content||'').slice(0,8000)}));
  const fileCtx = files.length
    ? '\n\n--- الملفات المرفقة ---\n'+files.map(f=>`📄 [${f.name}]:\n${f.content}`).join('\n\n---\n')
    : '';
  const sysP = String(b.system||'أنت مساعد ذكي خبير. رد باللغة العربية بشكل مفيد ودقيق وموجز.').slice(0,1000);
  const reply = await callAI(sysP, msg+fileCtx, 1200);
  if(reply) send(res,200,{ok:true, reply});
  else send(res,200,{ok:false, error:'لم يرد الذكاء الاصطناعي — تحقق من إعدادات المزوّد وسجل الأخطاء'});
});

/* ══ NVIDIA NIM — اختبار مباشر ══ */
R('POST','/qqc/admin/nim-test', async(req,res)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const b = await readBody(req);
  const key = String(b.api_key||'').trim() || DB.admin.ai_settings?.nvidia_nim_key || process.env.NVIDIA_NIM_API_KEY;
  if(!key) return send(res,200,{ok:false, error:'أدخل NVIDIA NIM API Key أولاً'});
  // Save key if provided
  if(b.api_key) { DB.admin.ai_settings.nvidia_nim_key = key; persist(); }
  const model = DB.admin.ai_settings?.nvidia_nim_model || 'meta/llama-3.3-70b-instruct';
  try {
    const resp = await fetch('https://integrate.api.nvidia.com/v1/chat/completions',{
      method:'POST',
      headers:{'Authorization':`Bearer ${key}`,'Content-Type':'application/json'},
      body:JSON.stringify({model, messages:[{role:'user',content:'قل: جاهز (كلمة واحدة فقط)'}], max_tokens:20}),
      signal:AbortSignal.timeout(15000)
    });
    const data = await resp.json();
    const reply = data.choices?.[0]?.message?.content;
    if(reply) send(res,200,{ok:true, reply, model, note:'NVIDIA NIM يعمل بنجاح! ✅'});
    else send(res,200,{ok:false, error: data.detail||data.message||'لم يرد NIM', raw:JSON.stringify(data).slice(0,200)});
  } catch(e){ send(res,200,{ok:false, error:e.message}); }
});

/* ══ Hermes Auto-Pilot ══ */
let _autoPilotInterval = null;
let _autoPilotNextRun  = null;

function setupAutoPilot(){
  if(_autoPilotInterval){ clearInterval(_autoPilotInterval); _autoPilotInterval=null; _autoPilotNextRun=null; }
  const ap = DB.admin.ai_settings?.hermes_autopilot;
  if(!ap?.enabled || !ap?.interval_hours || ap.interval_hours < 0.5) return;
  const ms = ap.interval_hours * 60 * 60 * 1000;
  _autoPilotNextRun = new Date(Date.now() + ms).toISOString();
  console.log(`[AutoPilot] 🤖 Hermes scheduled every ${ap.interval_hours}h — next: ${_autoPilotNextRun}`);
  _autoPilotInterval = setInterval(async()=>{
    console.log('[AutoPilot] ⏰ Triggering scheduled Hermes run...');
    _autoPilotNextRun = new Date(Date.now() + ms).toISOString();
    try { await runHermesAgent(); } catch(e){ console.error('[AutoPilot] Error:', e.message); }
  }, ms);
}

R('GET','/qqc/admin/hermes/autopilot', async(req,res)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const ap = DB.admin.ai_settings?.hermes_autopilot || {};
  send(res,200,{ enabled:ap.enabled||false, interval_hours:ap.interval_hours||6, next_run:_autoPilotNextRun, active_provider:getActiveAIProviderName() });
});

R('POST','/qqc/admin/hermes/autopilot', async(req,res)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const b = await readBody(req);
  if(!DB.admin.ai_settings.hermes_autopilot) DB.admin.ai_settings.hermes_autopilot = {};
  const ap = DB.admin.ai_settings.hermes_autopilot;
  if(b.enabled !== undefined) ap.enabled = !!b.enabled;
  if(b.interval_hours) ap.interval_hours = Math.max(0.5, Math.min(48, +b.interval_hours||6));
  persist();
  setupAutoPilot();
  send(res,200,{ok:true, enabled:ap.enabled, interval_hours:ap.interval_hours, next_run:_autoPilotNextRun});
});

R('GET','/qqc/admin/hermes/status', async(req,res)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const mem=readHermesMemory();
  send(res,200,{
    status:'active', last_run:mem.last_run, stats:mem.stats,
    cfg:mem.cfg_patches||{},
    recent_runs:(mem.runs||[]).slice(-15).reverse(),
    recent_insights:(mem.insights||[]).slice(-30).reverse(),
    skills:(mem.skills||[]).slice(-20).reverse(),
    browser_history:(mem.browser_history||[]).slice(-30).reverse(),
    next_run_focus:mem.runs?.slice(-1)?.[0]?.next_run_focus||'',
    code_edits:(mem.code_edits||[]).slice().reverse(),
  });
});

R('GET','/qqc/admin/hermes/skills', async(req,res)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const mem=readHermesMemory();
  send(res,200,{ skills:(mem.skills||[]).slice().reverse(), total:(mem.skills||[]).length });
});

R('POST','/qqc/admin/hermes/run-now', async(req,res)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const mem=readHermesMemory();
  const isRunning = mem._running;
  if(isRunning) return send(res,429,{error:'already_running'});
  send(res,200,{ok:true, message:'Hermes Agent يعمل الآن في الخلفية...'});
  setImmediate(async()=>{
    const m=readHermesMemory(); m._running=true; writeHermesMemory(m);
    try{ await runHermesAgent(); }catch(e){ console.error('[Hermes] Manual run error',e.message); }
    finally{ const m2=readHermesMemory(); delete m2._running; writeHermesMemory(m2); }
  });
});

R('DELETE','/qqc/admin/hermes/memory', async(req,res)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  writeHermesMemory({ skills:[], insights:[], runs:[], last_run:null, cfg_patches:{}, stats:{total_runs:0,total_tool_calls:0,users_helped:0,weights_updated:0,plans_adjusted:0} });
  send(res,200,{ok:true});
});

/* ── Hermes Lab File API ── */
R('GET','/qqc/admin/hermes/lab/files', async(req,res)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  try {
    const entries = fs.readdirSync(HERMES_LAB_DIR);
    const files = entries.map(name=>{
      try {
        const fp=path.join(HERMES_LAB_DIR,name);
        const st=fs.statSync(fp);
        const ext=path.extname(name).toLowerCase();
        const type=ext==='.mp3'||ext==='.wav'||ext==='.ogg'?'audio':ext==='.json'?'json':'text';
        return {filename:name, type, size_kb:+(st.size/1024).toFixed(1), modified:st.mtime.toISOString()};
      } catch{ return null; }
    }).filter(Boolean).sort((a,b)=>b.modified.localeCompare(a.modified));
    send(res,200,{count:files.length, files});
  } catch(e){ send(res,500,{error:e.message}); }
});

R('GET','/qqc/admin/hermes/lab/file/:filename', async(req,res,p,query)=>{
  // يقبل الـ password من header أو query param (مطلوب للـ audio elements)
  const pw = req.headers['x-admin-password'] || String(query?.pw||'');
  const pwHash = pw ? require('crypto').createHash('sha256').update(pw).digest('hex') : '';
  if(pwHash !== DB.admin.password_hash) return send(res,401,{error:'admin_auth'});
  const filename = decodeURIComponent(p.filename).replace(/[/\\]/g,'');
  const fp = path.join(HERMES_LAB_DIR, filename);
  if(!fp.startsWith(HERMES_LAB_DIR)||!fs.existsSync(fp)) return send(res,404,{error:'not_found'});
  const ext=path.extname(filename).toLowerCase();
  const ct=ext==='.mp3'?'audio/mpeg':ext==='.wav'?'audio/wav':ext==='.ogg'?'audio/ogg':ext==='.json'?'application/json':'text/plain; charset=utf-8';
  const buf=fs.readFileSync(fp);
  res.writeHead(200,{'Content-Type':ct,'Access-Control-Allow-Origin':'*','Content-Length':buf.length,'Content-Disposition':`inline; filename="${filename}"`});
  res.end(buf);
});

R('DELETE','/qqc/admin/hermes/lab/file/:filename', async(req,res,p)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const filename = decodeURIComponent(p.filename).replace(/[/\\]/g,'');
  const fp = path.join(HERMES_LAB_DIR, filename);
  if(!fp.startsWith(HERMES_LAB_DIR)) return send(res,400,{error:'invalid_path'});
  if(!fs.existsSync(fp)) return send(res,404,{error:'not_found'});
  fs.unlinkSync(fp);
  send(res,200,{ok:true, deleted:filename});
});

/* ── Hermes Interactive Chat (Streaming SSE) — Admin only ── */
R('POST','/qqc/admin/hermes/chat', async(req,res)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const b = await readBody(req);
  const userMessage = String(b.message||'').slice(0,2000);
  if(!userMessage) return send(res,400,{error:'message مطلوب'});
  const history = Array.isArray(b.history) ? b.history.slice(-12) : [];
  const fileCtx   = b.file_context ? '\n\n'+String(b.file_context).slice(0,15000) : '';

  const activeCfg = getActiveAIConfig();
  if(!activeCfg) return send(res,503,{error:'ai_not_configured — أضف مزوّد ذكاء اصطناعي في إعدادات الذكاء الاصطناعي'});
  const chatUrl  = `${activeCfg.baseUrl}/chat/completions`;
  const chatKey  = activeCfg.apiKey;

  // SSE headers
  res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','Access-Control-Allow-Origin':'*'});
  const sse=(type,data)=>{ try{ res.write(`data: ${JSON.stringify({type,...data})}\n\n`); }catch{} };

  const mem = readHermesMemory();
  const skillsSummary = (mem.skills||[]).slice(-5).map(s=>`• ${s.title}: ${s.content.slice(0,80)}`).join('\n')||'لا مهارات بعد';
  const labFiles = fs.readdirSync(HERMES_LAB_DIR).slice(0,15).join(', ')||'لا ملفات';

  const skillsSummaryFull = (mem.skills||[]).slice(-8).map((s,i)=>`${i+1}. [${s.applies_to||'general'}] ${s.title}: ${s.content.slice(0,120)}`).join('\n')||'لا مهارات بعد';

  const systemPrompt = `أنت Hermes Agent — وكيل ذكاء اصطناعي لتطبيق Quantum Quran Coach.
أنت تتحدث مع مدير النظام (الأدمن) مباشرة.
لديك أدوات حقيقية تنفّذ المطلوب فعلياً: بحث إنترنت، تعلّم مهارات، تحليل بيانات، تعديل كود، إدارة ملفات.

━━━ ذاكرتك الحالية ━━━
مهاراتك المكتسبة (${(mem.skills||[]).length} مهارة):
${skillsSummaryFull}

ملفات المختبر: ${labFiles}
دورات منفّذة: ${mem.stats?.total_runs||0}

━━━ قواعد التعلّم والتصفح (الأهم) ━━━

🌐 لديك متصفح ذكي كامل! استخدم:
• browser_search — ابحث في الويب (DuckDuckGo + Wikipedia)
• browser_open — افتح أي صفحة واقرأ محتواها
• save_learning_file — احفظ ما تعلّمته كملف Markdown يظهر للمستخدم
• learn_skill_from_web — تعلّم موضوعاً كاملاً من البداية إلى النهاية

عندما يطلب الأدمن أي مما يلي:
• "تعلّم مهارة X" → learn_skill_from_web ثم save_learning_file
• "ابحث عن X" → browser_search ثم browser_open لأفضل النتائج
• "افتح موقع X" → browser_open مباشرة
• "احفظ ما تعلّمته" → save_learning_file
• "تجوّل في الإنترنت عن X" → browser_search → browser_open × 2-3 → save_learning_file

سير التعلّم الكامل:
1. browser_search للعثور على المصادر
2. browser_open لأفضل 2-3 روابط (اقرأ المحتوى الحقيقي)
3. learn_skill_from_web لتجميع وتلخيص الذكاء الاصطناعي
4. save_learning_file لحفظ التقرير النهائي كملف Markdown للمستخدم

━━━ قواعد المحادثة العامة ━━━
- نفّذ طلبات الأدمن فعلياً باستخدام الأدوات — لا تكتفِ بالوصف
- استخدم أدوات متعددة إن لزم (بحث → تنفيذ → حفظ)
- أجب بالعربية دائماً
- كن مختصراً ومباشراً في الرسائل النصية
- عند طلب صوت لأي آية: استخدم get_sheikh_audio_refs — توليد الصوت بالذكاء الاصطناعي معطّل تماماً
- للتدريب الشامل استخدم train_on_all_data، ولتحسين نموذج التلاوة استخدم improve_recitation_model
- بعد تعلّم أي مهارة: أخبر الأدمن بملخص ما تعلّمته وكيف ستطبّقه`;

  const chatModel = activeCfg.model || 'gpt-4o-mini';

  const messages = [
    {role:'system', content:systemPrompt},
    ...history.map(h=>({role:h.role, content:h.content})),
    {role:'user', content:userMessage + fileCtx}
  ];

  let toolCallCount = 0;
  const maxCalls = 12;

  // استخراج tool calls من النص عندما يكتبها الـ model كـ JSON (providers بدون tool support)
  function extractToolCallsFromText(text){
    if(!text) return [];
    const calls = [];
    // نمط 1: {"type":"function","name":"tool_name","parameters":{...}}
    const re1 = /\{[\s\S]*?"type"\s*:\s*"function"[\s\S]*?"name"\s*:\s*"([^"]+)"[\s\S]*?"parameters"\s*:\s*(\{[\s\S]*?\})\s*\}/g;
    let m;
    while((m=re1.exec(text))!==null){
      try{ const args=JSON.parse(m[2]); calls.push({id:'txt-'+Date.now()+'-'+calls.length, function:{name:m[1], arguments:JSON.stringify(args)}}); }catch{}
    }
    // نمط 2: {"name":"tool_name","arguments":{...}} أو {"name":"tool_name","parameters":{...}}
    if(!calls.length){
      const re2 = /\{[\s\S]*?"name"\s*:\s*"([^"]+)"[\s\S]*?(?:"arguments"|"parameters")\s*:\s*(\{[\s\S]*?\})\s*\}/g;
      while((m=re2.exec(text))!==null){
        const name=m[1]; const toolNames=HERMES_TOOLS.map(t=>t.function.name);
        if(toolNames.includes(name)){
          try{ const args=JSON.parse(m[2]); calls.push({id:'txt-'+Date.now()+'-'+calls.length, function:{name, arguments:JSON.stringify(args)}}); }catch{}
        }
      }
    }
    return calls;
  }

  try {
    while(toolCallCount < maxCalls){
      let resp;
      try {
        const supportsToolsChat = !['pollinations','claude_free'].includes(getActiveAIProviderName());
        const chatReqBody = {model:chatModel, messages, max_tokens:1800};
        if(supportsToolsChat){ chatReqBody.tools=HERMES_TOOLS; chatReqBody.tool_choice='auto'; }
        else {
          // للـ providers التي لا تدعم tools — أخبر الـ model عن الأدوات في النص
          const toolNames = HERMES_TOOLS.map(t=>`• ${t.function.name}: ${t.function.description.slice(0,80)}`).join('\n');
          chatReqBody.messages = [
            ...messages.slice(0,1),
            {role:'system', content:`${messages[0].content}\n\nللاستدعاء أداة اكتب JSON هكذا:\n{"type":"function","name":"TOOL_NAME","parameters":{...}}\n\nالأدوات المتاحة:\n${toolNames}`},
            ...messages.slice(1)
          ];
        }
        resp = await fetch(chatUrl,{
          method:'POST', signal:AbortSignal.timeout(60000),
          headers:{'Authorization':`Bearer ${chatKey}`,'Content-Type':'application/json'},
          body:JSON.stringify(chatReqBody)
        });
      } catch(e){ sse('error',{message:'خطأ في الاتصال بالذكاء الاصطناعي: '+e.message}); break; }

      if(!resp.ok){ const errTxt=await resp.text().catch(()=>''); sse('error',{message:`API error: ${resp.status} — ${errTxt.slice(0,150)}`}); break; }
      const data = await resp.json();
      const msg = data.choices?.[0]?.message;
      if(!msg) break;
      messages.push(msg);

      // استخرج tool calls — إما native أو من النص
      let toolCalls = msg.tool_calls && msg.tool_calls.length ? msg.tool_calls : extractToolCallsFromText(msg.content||'');

      // رسالة نصية من هرمس (فقط إن لم تكن tool call JSON)
      if(msg.content && !toolCalls.length) sse('message',{content:msg.content});
      else if(msg.content && toolCalls.length){
        // اعرض النص فقط إن كان هناك محتوى غير JSON
        const cleanText = (msg.content||'').replace(/\{[\s\S]*?\}/g,'').trim();
        if(cleanText.length>5) sse('message',{content:cleanText});
      }

      // لا توجد tool calls — انتهى
      if(!toolCalls.length) break;

      // تنفيذ الأدوات وبث النتائج
      for(const tc of toolCalls){
        toolCallCount++;
        const toolName=tc.function?.name;
        let args={};
        try{ args=JSON.parse(tc.function?.arguments||'{}'); }catch{}

        sse('tool_call',{name:toolName, args});

        let result;
        try{ result=await executeHermesTool(toolName,args,mem); }catch(e){ result={error:e.message}; }

        // إن كان الملف صوت — أضف رابطه للحدث
        if(result?.ok && result?.filename && result?.lab_url){
          sse('lab_file',{filename:result.filename, url:result.lab_url, size_kb:result.size_kb, type:'audio'});
        }
        // إن كان ملف نصي
        if(result?.ok && result?.filename && !result?.lab_url?.includes('.mp3')){
          const ext=path.extname(result.filename).toLowerCase();
          if(['.txt','.json','.md'].includes(ext)) sse('lab_file',{filename:result.filename, url:`/qqc/admin/hermes/lab/file/${encodeURIComponent(result.filename)}`, size_kb:result.size_kb, type:'text'});
        }

        sse('tool_result',{name:toolName, result:JSON.stringify(result).slice(0,800)});

        // push نتيجة الأداة للـ messages
        if(tc.id && !tc.id.startsWith('txt-')){
          messages.push({role:'tool', tool_call_id:tc.id, content:JSON.stringify(result)});
        } else {
          // non-native: أضف كـ user message حتى يفهم الـ model النتيجة
          messages.push({role:'user', content:`نتيجة أداة ${toolName}:\n${JSON.stringify(result).slice(0,1500)}`});
        }
      }
    }
  } catch(e){ sse('error',{message:e.message}); }

  writeHermesMemory(mem);
  sse('done',{tool_calls:toolCallCount});
  res.end();
});


server.listen(PORT, ()=>{
  console.log(`Quantum Quran Coach running on http://localhost:${PORT}`);
  console.log(`Admin password (default): admin123  →  set via ADMIN_PASSWORD or db.json`);

  /* ── Hermes Agent Background Loop ── */
  setTimeout(()=>{
    console.log('[Hermes] Agent starting first run...');
    runHermesAgent().catch(e=>console.error('[Hermes] Error',e.message));
  }, 3*60*1000); // أول تشغيل بعد 3 دقائق
  setInterval(()=>{
    runHermesAgent().catch(e=>console.error('[Hermes] Error',e.message));
  }, 2*60*60*1000); // ثم كل ساعتين

  /* ── Background AI Optimizer ──
     Runs every 4 hours, reads all user data, asks AI to suggest
     algorithm weight improvements, applies them within ±15% limit. */
  async function runAiOptimizer(){
    const users = Object.values(DB.users);
    if(!users.length || !callAI) return;
    try {
      const n = users.length;
      const avgEnergy   = users.reduce((s,u)=>s+(u.energy?.score||0),0)/n;
      const avgStreak   = users.reduce((s,u)=>s+(u.progress?.current_streak_days||0),0)/n;
      const avgPages    = users.reduce((s,u)=>s+(u.progress?.total_pages_memorized||0),0)/n;
      const totalSess   = users.reduce((s,u)=>s+(u.progress?.total_sessions_completed||0),0);
      const dropping    = users.filter(u=>(u.progress?.consecutive_absences||0)>=3).length;
      const modeDistrib = {both:0,memorization_only:0,review_only:0};
      users.forEach(u=>{ const m=u.onboarding?.plan_mode||'both'; if(modeDistrib[m]!==undefined) modeDistrib[m]++; });

      const prompt = `أنت نظام تحسين خوارزميات لتطبيق حفظ القرآن الكريم. وظيفتك تحليل بيانات المستخدمين وتحسين معاملات الخوارزمية.\n\nبيانات المستخدمين (${n} مستخدم):\n- متوسط الطاقة: ${avgEnergy.toFixed(1)}/100\n- متوسط سلسلة الأيام: ${avgStreak.toFixed(1)} يوم\n- متوسط الصفحات المحفوظة: ${avgPages.toFixed(2)}\n- إجمالي الجلسات: ${totalSess}\n- منقطعون عن التطبيق: ${dropping}\n- توزيع أنواع الخطط: ${JSON.stringify(modeDistrib)}\n\nالمعاملات الحالية:\n${JSON.stringify(DB.admin.algorithm_weights,null,2)}\n\nأعطني JSON فقط (بدون شرح) بنفس المفاتيح مع قيم محسّنة. القاعدة: لا تتجاوز تغيير 15% في أي قيمة. ابدأ مباشرة بـ {`;
      const reply = await callAI(prompt, 'حلّل البيانات وحسّن المعاملات');
      if(!reply) return;
      const jsonStart = reply.indexOf('{');
      const jsonEnd = reply.lastIndexOf('}');
      if(jsonStart === -1 || jsonEnd <= jsonStart) return;
      const suggested = JSON.parse(reply.slice(jsonStart, jsonEnd+1));
      const cur = DB.admin.algorithm_weights;
      let changed = 0;
      for(const [k,v] of Object.entries(suggested)){
        if(k in cur && typeof v==='number' && isFinite(v)){
          const maxΔ = Math.abs(cur[k])*0.15 + 0.01;
          cur[k] = Math.round((cur[k] + Math.max(-maxΔ, Math.min(maxΔ, v-cur[k])))*1000)/1000;
          changed++;
        }
      }
      if(changed){ DB.admin.ai_last_optimization=now(); DB.admin.ai_opt_user_count=n; persist(); }
      console.log(`[AI Optimizer] Ran on ${n} users, updated ${changed} weights.`);
    } catch(e){ console.error('[AI Optimizer]', e.message); }
  }
  setTimeout(runAiOptimizer, 2*60*1000);           // first run: 2 min after start
  setInterval(runAiOptimizer, 4*60*60*1000);        // then every 4 hours
});

/* ══════════════════════════════════════════════════════════════
   المصنف الذكي — TARTEEL SMART CLASSIFIER API
   ─────────────────────────────────────────────────────────────
   Receives word-by-word recitation results, feeds them into
   ai_core.js decide(), and returns the full AI decision so the
   frontend can adapt the UX in real-time.
══════════════════════════════════════════════════════════════ */

/* POST /api/tarteel/log — save session + run ai_core.decide() */
R('POST','/qqc/tarteel/log', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const b = await readBody(req);
  const score         = Math.max(0, Math.min(100, +b.score||0));
  const correctWords  = Math.max(0, +b.correct_words||0);
  const errorWords    = Math.max(0, +b.error_words||0);
  const wordCount     = Math.max(1, +b.word_count||1);
  const durationMin   = Math.max(1, +b.duration_minutes||1);
  const surahName     = String(b.surah_name||'سورة').slice(0,50);
  const fromAyah      = +b.from_ayah||1;
  const toAyah        = +b.to_ayah||1;
  const mode          = ['practice','memorize'].includes(b.mode)?b.mode:'practice';
  const transcript    = String(b.transcript||'').slice(0,500);

  // Persist tarteel history on user
  if(!u.tarteel_history) u.tarteel_history=[];
  u.tarteel_history.push({
    surah_name: surahName, from_ayah: fromAyah, to_ayah: toAyah,
    word_count: wordCount, correct_words: correctWords, error_words: errorWords,
    score, duration_minutes: durationMin, mode, transcript,
    created_at: now(),
  });
  // Keep last 100 entries
  if(u.tarteel_history.length>100) u.tarteel_history=u.tarteel_history.slice(-100);

  // Update user progress stats (recitation practice pages)
  const pagesEst = +(Math.max(wordCount,1)*0.002).toFixed(3); // ~500 words/page
  if(!u.progress) u.progress={};
  u.progress.total_pages_memorized=(u.progress.total_pages_memorized||0)+pagesEst;

  // Build sensor payload from recitation quality
  // High error rate → high hesitation/erratic signal; high accuracy → calm focus
  const errRate = errorWords/wordCount;
  const sensors = {
    trigger:          'tarteel_session',
    focusSeconds:     durationMin*60,
    hiddenSeconds:    0,
    hesitationMs:     Math.round(errRate*8000),     // errors proxy for hesitation
    mouseErratics:    Math.round(errRate*30),
    touchErratics:    0,
    exitAttempts:     score<40?2:0,
    scrollSpeed:      0,
    scrolledToBottom: true,
    chaosRhythm:      0,
    streak:           u.progress.current_streak_days||0,
    // Provide a supervised label for online ML training (0-1 normalised score)
    label:            score/100,
  };

  // Run ai_core.decide()
  const decision = AI.decide(u, sensors, ALERTS);

  // Persist updated ML weights back to user
  if(decision.ml_state) u.ml_state = decision.ml_state;

  // Update energy
  if(!u.energy) u.energy={};
  u.energy.score  = decision.energy;
  u.energy.friction = decision.friction;
  if(!u.energy.history) u.energy.history=[];
  u.energy.history.push(decision.energy);
  if(u.energy.history.length>50) u.energy.history=u.energy.history.slice(-50);

  persist();
  send(res,200,{
    ok: true,
    score,
    mode:              decision.mode,
    energy:            decision.energy,
    afi:               decision.afi,
    friction:          decision.friction,
    procrastination:   decision.procrastination,
    target_pages:      decision.target_pages,
    plan_recommendation: decision.plan_recommendation,
    alert:             decision.alert,
    intervention:      decision.intervention,
    circadian_multiplier: decision.circadian_multiplier,
  });
});

/* GET /api/tarteel/history — return user's recitation history */
R('GET','/qqc/tarteel/history', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  send(res,200,{history: (u.tarteel_history||[]).slice().reverse().slice(0,50)});
});

/* ════════════════════════════════════════════════════════════════
   QURAN LOCAL CACHE — proxy + cache alquran.cloud responses
   Caches surah text + page data locally so the app works offline
   after first use and loads instantly thereafter.
════════════════════════════════════════════════════════════════ */
const QURAN_CACHE_PATH = path.join(ROOT,'data','quran_cache.json');
let QURAN_CACHE = {};
try {
  if (fs.existsSync(QURAN_CACHE_PATH)) QURAN_CACHE = JSON.parse(fs.readFileSync(QURAN_CACHE_PATH));
} catch(e){ QURAN_CACHE = {}; }
let qCachePending = false;
function saveQCache(){
  if(qCachePending) return;
  qCachePending = true;
  setTimeout(()=>{
    try{
      fs.writeFileSync(QURAN_CACHE_PATH+'.tmp', JSON.stringify(QURAN_CACHE));
      fs.renameSync(QURAN_CACHE_PATH+'.tmp', QURAN_CACHE_PATH);
    }catch(e){ console.error('Quran cache write error',e.message); }
    qCachePending = false;
  }, 800);
}

R('GET','/qqc/quran/surahs', async(req,res)=>{
  if(QURAN_CACHE['list']) return send(res,200,QURAN_CACHE['list']);
  try{
    const r = await fetch('https://api.alquran.cloud/v1/surah');
    const d = await r.json();
    if(d.data){ QURAN_CACHE['list']=d; saveQCache(); }
    send(res,200,d);
  }catch(e){ send(res,503,{error:'unavailable'}); }
});

R('GET','/qqc/quran/surah/:num', async(req,res,p)=>{
  const num = +p.num;
  if(num<1||num>114) return send(res,400,{error:'invalid'});
  const key = `s${num}`;
  if(QURAN_CACHE[key]) return send(res,200,QURAN_CACHE[key]);
  try{
    const r = await fetch(`https://api.alquran.cloud/v1/surah/${num}`);
    const d = await r.json();
    if(d.data){ QURAN_CACHE[key]=d; saveQCache(); }
    send(res,200,d);
  }catch(e){ send(res,503,{error:'unavailable'}); }
});

R('GET','/qqc/quran/page/:num', async(req,res,p)=>{
  const num = +p.num;
  if(num<1||num>604) return send(res,400,{error:'invalid'});
  const key = `p${num}`;
  if(QURAN_CACHE[key]) return send(res,200,QURAN_CACHE[key]);
  try{
    const r = await fetch(`https://api.alquran.cloud/v1/page/${num}/ar.uthmani`);
    const d = await r.json();
    if(d.data){ QURAN_CACHE[key]=d; saveQCache(); }
    send(res,200,d);
  }catch(e){ send(res,503,{error:'unavailable'}); }
});

/* ════════════════════════════════════════════════════════════════
   TARTEEL AI CHECK — Whisper STT + GPT evaluation + training data
   Sends recorded audio to Whisper for high-accuracy Arabic STT,
   then asks GPT to evaluate against expected Quran text.
   Saves every transcript/expected pair as training data.
════════════════════════════════════════════════════════════════ */
R('POST','/qqc/tarteel/ai-check', async(req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  let body;
  try{ body = await readLargeBody(req,20); }catch(e){ return send(res,413,{error:'too_large'}); }
  const audio_base64  = String(body.audio_base64||'');
  const expected_text = String(body.expected_text||'').slice(0,5000);
  const surah_name    = String(body.surah_name||'');
  const from_ayah     = +body.from_ayah||1;
  const to_ayah       = +body.to_ayah||1;
  const mime_type     = String(body.mime_type||'audio/webm');
  if(!audio_base64) return send(res,400,{transcript:'',error:'no audio'});
  const activeCfgAI = getActiveAIConfig();
  const baseUrl = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || activeCfgAI?.baseUrl;
  const apiKey  = process.env.AI_INTEGRATIONS_OPENAI_API_KEY  || activeCfgAI?.apiKey;
  if(!baseUrl||!apiKey) return send(res,200,{transcript:'',feedback:null,error:'ai_not_configured'});
  try{
    // 1. Whisper STT
    const buf = Buffer.from(audio_base64,'base64');
    const ext = mime_type.includes('mp4')||mime_type.includes('m4a')?'m4a':
                mime_type.includes('ogg')?'ogg':
                mime_type.includes('wav')?'wav':'webm';
    const fd = new FormData();
    fd.append('file', new Blob([buf],{type:mime_type}), `rec.${ext}`);
    fd.append('model','whisper-1');
    fd.append('language','ar');
    const tr = await fetch(`${baseUrl}/audio/transcriptions`,{method:'POST',headers:{'Authorization':`Bearer ${apiKey}`},body:fd});
    let transcript = '';
    if(tr.ok){ const td=await tr.json(); transcript=td.text||''; }
    // 2. Save training data
    if(!DB.admin.tarteel_training) DB.admin.tarteel_training=[];
    if(transcript||expected_text){
      DB.admin.tarteel_training.push({
        id:uid(), username:u.username,
        transcript, expected_text:expected_text.slice(0,1000),
        surah_name, from_ayah, to_ayah, created_at:now()
      });
      if(DB.admin.tarteel_training.length>20000) DB.admin.tarteel_training=DB.admin.tarteel_training.slice(-20000);
    }
    // 3. GPT evaluation
    let feedback = null;
    if(transcript && expected_text){
      const sysP = `أنت محكّم متخصص في تجويد القرآن الكريم. قارن بين ما قاله المتلو والنص الصحيح وأعط تغذية راجعة تفصيلية دقيقة. أذكر الكلمات الخاطئة تحديداً. الإجابة بالعربية، 5 أسطر كحد أقصى.`;
      const userP = `النص الصحيح:\n"${expected_text.slice(0,800)}"\n\nما قاله المتلو (Whisper AI):\n"${transcript.slice(0,800)}"\n\nأعط: ١) نسبة الدقة (0-100%) ٢) الكلمات الخاطئة تحديداً ٣) نصيحة تجويدية عملية.`;
      feedback = await callAI(sysP, userP);
    }
    persist();
    send(res,200,{ok:true, transcript, feedback});
  }catch(e){
    console.error('Tarteel AI check error',e.message);
    send(res,200,{transcript:'',feedback:null,error:e.message});
  }
});

/* ════════════════════════════════════════════════════════════════
   SMART TARTEEL v2 — محرك تسميع ذكي مجاني 100% مفتوح المصدر
   • تطبيع النص العربي (إزالة التشكيل، توحيد الأحرف)
   • مقارنة كلمة بكلمة بخوارزمية Levenshtein
   • تتبع الأخطاء بـ Spaced Repetition (SM-2)
   • تحليل أحكام التجويد محلياً بدون إنترنت
   • سؤال فهم المعنى بالذكاء الاصطناعي (اختياري)
════════════════════════════════════════════════════════════════ */

function normalizeArabic(t){
  return t
    .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED]/g,'')
    .replace(/[أإآٱ]/g,'ا').replace(/ة/g,'ه').replace(/ى/g,'ي')
    .replace(/\u0640/g,'').replace(/\s+/g,' ').trim();
}

function levenshtein(a,b){
  const m=a.length,n=b.length;
  const dp=Array.from({length:m+1},(_,i)=>Array.from({length:n+1},(_,j)=>i===0?j:j===0?i:0));
  for(let i=1;i<=m;i++) for(let j=1;j<=n;j++)
    dp[i][j]=a[i-1]===b[j-1]?dp[i-1][j-1]:1+Math.min(dp[i-1][j],dp[i][j-1],dp[i-1][j-1]);
  return dp[m][n];
}

function wordSim(a,b){
  const na=normalizeArabic(a),nb=normalizeArabic(b);
  if(na===nb) return 1;
  const mx=Math.max(na.length,nb.length);
  return mx?Math.max(0,1-levenshtein(na,nb)/mx):1;
}

function compareArabicTexts(expected,actual){
  const expW=expected.split(/\s+/).filter(Boolean);
  const actW=actual.split(/\s+/).filter(Boolean);
  const words=[];
  let correct=0,close=0,wrong=0,missing=0;
  for(let i=0;i<expW.length;i++){
    const ew=expW[i],aw=actW[i]||'';
    if(!aw){words.push({expected:ew,actual:'',status:'missing',sim:0});missing++;continue;}
    const sim=wordSim(ew,aw);
    const status=sim>=0.88?'correct':sim>=0.55?'close':'wrong';
    words.push({expected:ew,actual:aw,status,sim:+sim.toFixed(2)});
    if(status==='correct')correct++;
    else if(status==='close')close++;
    else wrong++;
  }
  for(let i=expW.length;i<actW.length;i++)
    words.push({expected:'',actual:actW[i],status:'extra',sim:0});
  const total=expW.length;
  const accuracy=total>0?Math.round((correct+close*0.6)*100/total):0;
  return {words,correct,close,wrong,missing,total,accuracy};
}

const TAJWEED_DB=[
  {re:/ن[\u0652]?\s*[بم]/u,       rule:'إقلاب — النون الساكنة/التنوين مع الباء: قلبها ميماً مخفاة',          color:'#f59e0b', symbol:'🟡'},
  {re:/ن[\u0652]?\s*[يرملو ن]/u,  rule:'إدغام — النون الساكنة مع حروف (يرملون): إدغام بغنة أو بغير غنة',    color:'#34d399', symbol:'🟢'},
  {re:/ن[\u0652]?\s*[أعغحخه]/u,   rule:'إظهار حلقي — النون الساكنة مع أحرف الحلق (أعغحخه)',                 color:'#60a5fa', symbol:'🔵'},
  {re:/م[\u0652]?\s*م/u,           rule:'إدغام شفوي — الميم الساكنة مع الميم',                               color:'#818cf8', symbol:'🟣'},
  {re:/م[\u0652]?\s*ب/u,           rule:'إخفاء شفوي — الميم الساكنة مع الباء',                              color:'#fb923c', symbol:'🟠'},
  {re:/لل/u,                       rule:'لام شمسية/قمرية — تحقق من الإدغام مع الحروف الشمسية',              color:'#e879f9', symbol:'🔮'},
  {re:/ّ/u,                         rule:'شدّة (تشديد) — أتمّ مخرج الحرف المشدد كاملاً',                    color:'#f472b6', symbol:'💗'},
  {re:/[اوي]{2}/u,                  rule:'مد — تأكد من مقدار المد الطبيعي (حركتان)',                         color:'#fbbf24', symbol:'⭐'},
  {re:/ال[تثدذرزسشصضطظلن]/u,       rule:'لام شمسية — تُدغم لام التعريف مع الحروف الشمسية',                  color:'#a78bfa', symbol:'☀️'},
  {re:/قل[أيع]/u,                   rule:'قلقلة — حروف القلقلة (قطب جد): أتمّ القلقلة عند الوقف',           color:'#34d399', symbol:'✨'},
];

/* ── POST /qqc/tarteel/v2/check ── */
R('POST','/qqc/tarteel/v2/check',async(req,res)=>{
  const u=authUser(req);if(!u)return send(res,401,{error:'auth'});
  const b=await readBody(req);
  const expected=String(b.expected_text||'').slice(0,3000);
  const actual=String(b.actual_text||'').slice(0,3000);
  const surah_name=String(b.surah_name||'').slice(0,100);
  const ayah_num=+b.ayah_num||0;
  if(!expected||!actual)return send(res,400,{error:'expected_text و actual_text مطلوبان'});

  const result=compareArabicTexts(expected,actual);

  if(!u.smart_mistakes)u.smart_mistakes={};
  const wrongWords=result.words.filter(w=>w.status==='wrong'||w.status==='missing');
  wrongWords.forEach(w=>{
    const key=`${surah_name}__${normalizeArabic(w.expected)}`;
    if(!u.smart_mistakes[key])u.smart_mistakes[key]={word:w.expected,surah:surah_name,ayah:ayah_num,count:0,last_seen:null,next_review:null,ease:2.5,next_interval:1};
    const m=u.smart_mistakes[key];
    m.count++;m.last_seen=now();
    const interval=m.count===1?1:m.count===2?3:Math.round((m.next_interval||3)*m.ease);
    m.next_interval=Math.min(interval,90);
    m.next_review=new Date(Date.now()+m.next_interval*86400000).toISOString().slice(0,10);
  });

  if(!u.smart_sessions)u.smart_sessions=[];
  u.smart_sessions.push({surah_name,ayah_num,accuracy:result.accuracy,correct:result.correct,wrong:result.wrong,missing:result.missing,ts:now()});
  if(u.smart_sessions.length>1000)u.smart_sessions=u.smart_sessions.slice(-1000);

  if(result.accuracy<80&&expected&&actual){
    appendLog('recitation_errors.jsonl',{username:u.username,surah_name,ayah_num,accuracy_pct:result.accuracy,method:'smart_local',expected_text:expected.slice(0,500),actual_text:actual.slice(0,500),wrong_words:wrongWords.map(w=>w.expected).slice(0,20)});
  }
  persist();
  send(res,200,{ok:true,...result,mistakes_tracked:wrongWords.length});
});

/* ── GET /qqc/tarteel/v2/review ── */
R('GET','/qqc/tarteel/v2/review',async(req,res)=>{
  const u=authUser(req);if(!u)return send(res,401,{error:'auth'});
  const today=new Date().toISOString().slice(0,10);
  const mistakes=Object.values(u.smart_mistakes||{});
  const due=mistakes.filter(m=>!m.next_review||m.next_review<=today).sort((a,b)=>b.count-a.count).slice(0,30);
  const upcoming=mistakes.filter(m=>m.next_review&&m.next_review>today).sort((a,b)=>a.next_review.localeCompare(b.next_review)).slice(0,10);
  send(res,200,{ok:true,due_count:due.length,total_tracked:mistakes.length,due,upcoming});
});

/* ── GET /qqc/tarteel/v2/stats ── */
R('GET','/qqc/tarteel/v2/stats',async(req,res)=>{
  const u=authUser(req);if(!u)return send(res,401,{error:'auth'});
  const sessions=(u.smart_sessions||[]).slice(-100);
  const mistakes=Object.values(u.smart_mistakes||{});
  const avgAcc=sessions.length?Math.round(sessions.reduce((s,ss)=>s+ss.accuracy,0)/sessions.length):0;
  const trend=sessions.slice(-14).map(s=>({acc:s.accuracy,ts:s.ts,surah:s.surah_name}));
  const topMistakes=mistakes.sort((a,b)=>b.count-a.count).slice(0,15).map(m=>({word:m.word,surah:m.surah,ayah:m.ayah,count:m.count,next_review:m.next_review}));
  const today=new Date().toISOString().slice(0,10);
  const dueCount=mistakes.filter(m=>!m.next_review||m.next_review<=today).length;
  const bySurah={};
  sessions.forEach(s=>{if(!bySurah[s.surah_name])bySurah[s.surah_name]={count:0,sum:0};bySurah[s.surah_name].count++;bySurah[s.surah_name].sum+=s.accuracy;});
  const surahStats=Object.entries(bySurah).map(([s,v])=>({surah:s,sessions:v.count,avg:Math.round(v.sum/v.count)})).sort((a,b)=>b.sessions-a.sessions).slice(0,10);
  send(res,200,{ok:true,sessions_count:sessions.length,avg_accuracy:avgAcc,trend,top_mistakes:topMistakes,due_review:dueCount,total_mistakes_tracked:mistakes.length,recent_sessions:sessions.slice(-10).reverse(),surah_stats:surahStats});
});

/* ── DELETE /qqc/tarteel/v2/mistakes/:key ── */
R('DELETE','/qqc/tarteel/v2/mistakes/:key',async(req,res,p)=>{
  const u=authUser(req);if(!u)return send(res,401,{error:'auth'});
  const key=decodeURIComponent(p.key);
  if(u.smart_mistakes&&u.smart_mistakes[key]){delete u.smart_mistakes[key];persist();}
  send(res,200,{ok:true});
});

/* ── DELETE /qqc/tarteel/v2/mistakes (clear all) ── */
R('DELETE','/qqc/tarteel/v2/mistakes',async(req,res)=>{
  const u=authUser(req);if(!u)return send(res,401,{error:'auth'});
  u.smart_mistakes={};persist();
  send(res,200,{ok:true,cleared:true});
});

/* ── POST /qqc/tarteel/v2/comprehension ── */
R('POST','/qqc/tarteel/v2/comprehension',async(req,res)=>{
  const u=authUser(req);if(!u)return send(res,401,{error:'auth'});
  const b=await readBody(req);
  const ayah_text=String(b.ayah_text||'').slice(0,1000);
  const surah_name=String(b.surah_name||'').slice(0,100);
  const ayah_num=+b.ayah_num||0;
  if(!ayah_text)return send(res,400,{error:'ayah_text مطلوب'});
  const cfg=getActiveAIConfig();
  if(!cfg)return send(res,200,{ok:true,question:'ما المعنى العام لهذه الآية؟',answer:'الذكاء الاصطناعي غير متاح حالياً — يمكنك تفعيله من إعدادات الأدمن.',tip:'',no_ai:true});
  try{
    const sysP=`أنت معلم قرآن كريم ومفسر. عندما تُعطى آية قرآنية:
١) اطرح سؤال فهم واحداً مختصراً وواضحاً
٢) أعط الإجابة باختصار
٣) اذكر فائدة عملية من الآية (جملة واحدة)
التنسيق الإلزامي بالضبط:
س: [السؤال]
ج: [الإجابة]
ف: [الفائدة العملية]`;
    const r=await callAI(sysP,`سورة ${surah_name} آية ${ayah_num}: "${ayah_text}"`,350);
    const qm=r?.match(/س:\s*(.+)/); const am=r?.match(/ج:\s*(.+)/); const fm=r?.match(/ف:\s*(.+)/);
    send(res,200,{ok:true,question:qm?.[1]?.trim()||'',answer:am?.[1]?.trim()||'',tip:fm?.[1]?.trim()||'',raw:r||''});
  }catch(e){send(res,500,{error:e.message});}
});

/* ── POST /qqc/tarteel/v2/tajweed-hint ── */
R('POST','/qqc/tarteel/v2/tajweed-hint',async(req,res)=>{
  const u=authUser(req);if(!u)return send(res,401,{error:'auth'});
  const b=await readBody(req);
  const text=String(b.text||'').slice(0,1000);
  const hints=TAJWEED_DB.filter(r=>r.re.test(text)).map(r=>({rule:r.rule,color:r.color,symbol:r.symbol}));
  send(res,200,{ok:true,hints,count:hints.length});
});

/* ── GET /qqc/tarteel/v2/normalize ── (utility for frontend) ── */
R('POST','/qqc/tarteel/v2/normalize',async(req,res)=>{
  const b=await readBody(req);
  const text=String(b.text||'').slice(0,5000);
  send(res,200,{ok:true,normalized:normalizeArabic(text)});
});

/* ════════════════════════════════════════════════════════════════
   KHATMA — Full Quran reading plan with daily tracking
   User sets target days → gets pages/day → marks daily ward done
════════════════════════════════════════════════════════════════ */
R('GET','/qqc/khatma', async(req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const khatma = u.khatma||null;
  if(!khatma) return send(res,200,{khatma:null});
  const today = new Date().toISOString().slice(0,10);
  const msPerDay = 86400000;
  const daysPassed = Math.max(0, Math.floor((Date.now()-new Date(khatma.start_date))/msPerDay));
  const ppd = khatma.pages_per_day||1;
  const todayPageStart = Math.max(1, Math.min(604, 1+Math.floor(daysPassed*ppd)));
  const todayPageEnd   = Math.max(1, Math.min(604, Math.ceil((daysPassed+1)*ppd)));
  const todayCompleted = !!(khatma.daily_log&&khatma.daily_log[today]);
  const pagesRead = Math.min(604, khatma.total_pages_read||0);
  const percentDone = Math.round(pagesRead/604*100);
  send(res,200,{
    khatma,
    today,
    today_pages:{from:todayPageStart, to:todayPageEnd},
    today_completed:todayCompleted,
    pages_read:pagesRead,
    percent_done:percentDone,
    days_passed:daysPassed,
    days_remaining:Math.max(0,khatma.target_days-daysPassed),
    completions:khatma.completions||0,
  });
});

R('POST','/qqc/khatma/create', async(req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const b = await readBody(req);
  const target_days = Math.max(1,Math.min(3650,+(b.target_days||30)));
  const pages_per_day = 604/target_days;
  const prevCompletions = u.khatma?.completions||0;
  u.khatma = {
    id:uid(), created_at:now(),
    start_date:new Date().toISOString().slice(0,10),
    target_days, pages_per_day,
    daily_log:{}, total_pages_read:0,
    completions:prevCompletions,
  };
  persist();
  send(res,200,{ok:true, khatma:u.khatma});
});

R('POST','/qqc/khatma/complete-day', async(req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  if(!u.khatma) return send(res,400,{error:'no_khatma'});
  const today = new Date().toISOString().slice(0,10);
  if(!u.khatma.daily_log) u.khatma.daily_log={};
  if(u.khatma.daily_log[today]) return send(res,200,{ok:true,already_done:true,pages_read:u.khatma.total_pages_read});
  const pagesForToday = Math.max(1,Math.round(u.khatma.pages_per_day));
  u.khatma.daily_log[today] = {completed:true, at:now()};
  u.khatma.total_pages_read = Math.min(604,(u.khatma.total_pages_read||0)+pagesForToday);
  let khatma_complete = false;
  if(u.khatma.total_pages_read>=604){
    khatma_complete = true;
    u.khatma.completions = (u.khatma.completions||0)+1;
    u.khatma.completed_at = now();
    u.khatma.total_pages_read = 0;
    u.khatma.daily_log = {};
    u.khatma.start_date = new Date().toISOString().slice(0,10);
  }
  persist();
  send(res,200,{ok:true, pages_read:u.khatma.total_pages_read, khatma_complete, completions:u.khatma.completions||0});
});

R('DELETE','/qqc/khatma', async(req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  u.khatma = null;
  persist();
  send(res,200,{ok:true});
});

/* ════════════════════════════════════════════════════════════════
   AUDIO CONFIG — يرجع إعدادات مصادر الصوت للفرونت إند والذكاء الاصطناعي
════════════════════════════════════════════════════════════════ */
let AUDIO_CONFIG = null;
try {
  AUDIO_CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT,'..','config','audio_sources.json')));
} catch(e) { AUDIO_CONFIG = {}; }

R('GET','/qqc/config/audio', async(req,res)=>{
  send(res,200,{ config: AUDIO_CONFIG });
});

/* ════════════════════════════════════════════════════════════════
   ERROR & RECITATION LOGGING SYSTEM
   يسجّل: أخطاء الموقع | أخطاء الذكاء الاصطناعي | أخطاء التسميع
   الملفات: logs/errors.jsonl | logs/ai_errors.jsonl | logs/recitation_errors.jsonl | logs/ai_training_data.jsonl
════════════════════════════════════════════════════════════════ */
const LOGS_DIR = path.join(ROOT, 'logs');
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

function appendLog(filename, record){
  try {
    const line = JSON.stringify({ ...record, logged_at: now() }) + '\n';
    fs.appendFileSync(path.join(LOGS_DIR, filename), line, 'utf8');
  } catch(e){ console.error('Log write error:', e.message); }
}

function readLogFile(filename, limit=500){
  try {
    const fp = path.join(LOGS_DIR, filename);
    if (!fs.existsSync(fp)) return [];
    const lines = fs.readFileSync(fp,'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map(l=>{ try{ return JSON.parse(l); }catch{ return null; } }).filter(Boolean);
  } catch(e){ return []; }
}

function clearLogFile(filename){
  try { fs.writeFileSync(path.join(LOGS_DIR, filename), '', 'utf8'); } catch(e){}
}

/* ── تسجيل خطأ الموقع أو الذكاء الاصطناعي ── */
R('POST','/qqc/logs/error', async(req,res)=>{
  const b = await readBody(req);
  const type    = String(b.type||'website'); // website | ai | system
  const message = String(b.message||'').slice(0,2000);
  const context = b.context || {};
  const username = (() => { try { const u=authUser(req); return u?.username||'anonymous'; } catch{ return 'anonymous'; } })();
  const record = { type, message, context, username, url: String(b.url||'').slice(0,500), user_agent: req.headers['user-agent']?.slice(0,200)||'' };
  if (type === 'ai') {
    appendLog('ai_errors.jsonl', record);
  } else {
    appendLog('errors.jsonl', record);
  }
  send(res,200,{ok:true});
});

/* ── تسجيل خطأ التسميع (أهم شيء) ── */
R('POST','/qqc/logs/recitation', async(req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const b = await readBody(req);
  const record = {
    username: u.username,
    surah_name:   String(b.surah_name||'').slice(0,100),
    surah_number: +b.surah_number||0,
    ayah_number:  +b.ayah_number||0,
    from_ayah:    +b.from_ayah||0,
    to_ayah:      +b.to_ayah||0,
    error_type:   String(b.error_type||'recitation').slice(0,50), // recitation|tajweed|memorization|skip
    wrong_words:  Array.isArray(b.wrong_words) ? b.wrong_words.slice(0,50) : [],
    expected_text: String(b.expected_text||'').slice(0,2000),
    actual_text:   String(b.actual_text||'').slice(0,2000),
    accuracy_pct:  +b.accuracy_pct||0,
    ai_feedback:   String(b.ai_feedback||'').slice(0,1000),
    method:        String(b.method||'speech_recognition').slice(0,50), // speech_recognition | whisper | manual
    session_id:    String(b.session_id||uid()).slice(0,32),
  };
  appendLog('recitation_errors.jsonl', record);

  // حفظ كبيانات تدريب للذكاء الاصطناعي إذا كان فيه نص متوقع ونص فعلي
  if (record.expected_text && record.actual_text) {
    appendLog('ai_training_data.jsonl', {
      type: 'recitation_correction',
      input: record.actual_text,
      expected_output: record.expected_text,
      metadata: {
        surah: record.surah_name,
        ayah: record.ayah_number,
        accuracy_pct: record.accuracy_pct,
        wrong_words: record.wrong_words,
        username: u.username,
      }
    });
    // أيضاً احفظ في DB للإحصائيات
    if (!DB.admin.tarteel_training) DB.admin.tarteel_training = [];
    DB.admin.tarteel_training.push({
      id: uid(), username: u.username,
      transcript: record.actual_text,
      expected_text: record.expected_text.slice(0,1000),
      surah_name: record.surah_name,
      from_ayah: record.from_ayah, to_ayah: record.to_ayah,
      accuracy_pct: record.accuracy_pct,
      wrong_words: record.wrong_words,
      created_at: now()
    });
    if (DB.admin.tarteel_training.length > 20000) DB.admin.tarteel_training = DB.admin.tarteel_training.slice(-20000);
    persist();
  }
  send(res,200,{ok:true});
});

/* ════════════════════════════════════════════════════════════════
   AI MEMORY + RAG LAYER — الذاكرة الذكية + الاسترجاع التعزيزي
   ════════════════════════════════════════════════════════════════ */

const AI_MEMORY_PATH = path.join(ROOT, 'ai_memory.json');

function readAiMemory(){
  try { return JSON.parse(fs.readFileSync(AI_MEMORY_PATH,'utf8')); }
  catch{ return { interactions:[], corrections:[], user_notes:{}, global_notes:[], last_updated:null, version:1 }; }
}

function writeAiMemory(mem){
  try {
    mem.last_updated = now();
    fs.writeFileSync(AI_MEMORY_PATH+'.tmp', JSON.stringify(mem,null,2));
    fs.renameSync(AI_MEMORY_PATH+'.tmp', AI_MEMORY_PATH);
  } catch(e){ console.error('AI Memory write failed',e.message); }
}

function buildUserContext(u){
  if (!u) return '';
  const prog = u.progress||{};
  const recentSessions = (u.studio_history||[]).slice(-5);
  const avgScore = recentSessions.filter(s=>s.ai_score!=null).reduce((a,b)=>a+(b.ai_score||0),0) / Math.max(1,recentSessions.filter(s=>s.ai_score!=null).length);
  const khatma = u.khatma;
  const plan = u.active_plan;

  return `== بيانات المستخدم الحقيقية ==
الاسم: ${u.display_name||u.username}
الحروف المحفوظة: ${u.hifz?.memorized_juzaa?.join(', ')||'لا توجد بيانات'}
الصفحات المحفوظة: ${prog.total_pages_memorized||0}
إجمالي الجلسات: ${prog.total_sessions_completed||0}
السلسلة الحالية: ${prog.current_streak_days||0} يوم
أفضل سلسلة: ${prog.longest_streak_days||0} يوم
متوسط درجة التسميع (آخر 5): ${Math.round(avgScore)||'—'}%
${khatma ? `خطة الختمة: ${Math.round((khatma.total_pages_read/604)*100)||0}% مكتملة (${khatma.total_pages_read||0}/604 صفحة)` : 'لا توجد خطة ختمة نشطة'}
${plan ? `خطة الحفظ: ${plan.name||'غير محددة'} — الهدف: ${plan.daily_pages||'?'} صفحة/يوم` : ''}
آخر 5 جلسات تسميع: ${recentSessions.map(s=>`${s.surah_name||'?'} آية ${s.ayah_num||'?'} — ${s.ai_score!=null?s.ai_score+'%':'بدون درجة'}`).join(' | ')||'لا يوجد'}`;
}

function buildMemoryContext(mem, username){
  const userNotes = (mem.user_notes||{})[username]||[];
  const recent = (mem.interactions||[]).filter(i=>i.username===username).slice(-8);
  const corrections = (mem.corrections||[]).filter(c=>c.username===username).slice(-5);
  let ctx = '';
  if (userNotes.length) ctx += `== ملاحظاتي عن هذا المستخدم ==\n${userNotes.join('\n')}\n\n`;
  if (corrections.length) ctx += `== تصحيحات سابقة ==\n${corrections.map(c=>`❌ قلت: "${c.wrong}" ✅ الصحيح: "${c.correct}"`).join('\n')}\n\n`;
  if (recent.length) ctx += `== آخر محادثات ==\n${recent.map(i=>`س: ${i.q.slice(0,80)} | ج: ${i.a.slice(0,120)}`).join('\n')}`;
  return ctx;
}

/* ── AI Coach — RAG + Tool Calling ── */
R('POST','/qqc/ai/coach', async(req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const b = await readBody(req);
  const question = String(b.question||b.message||'').slice(0,1500);
  if (!question) return send(res,400,{error:'no_question'});

  const coachCfg = getActiveAIConfig();
  if (!coachCfg) return send(res,503,{error:'ai_not_configured', reply:'عذراً، الذكاء الاصطناعي غير متاح حالياً.'});

  const mem = readAiMemory();
  const userContext = buildUserContext(u);
  const memContext  = buildMemoryContext(mem, u.username);

  // Read recent recitation errors from JSONL log
  let recitationContext = '';
  try {
    const recLogs = readLogFile('recitation_errors.jsonl', 5);
    const userLogs = recLogs.filter(r=>r && r.method);
    if (userLogs.length){
      recitationContext = `== أحدث أخطاء التسميع ==\n${userLogs.map(r=>`${r.surah_name||''} آية ${r.ayah_number||''}: دقة ${r.accuracy_pct||0}% — ${r.error_type||''}`).join('\n')}`;
    }
  } catch{}

  const systemPrompt = `أنت "الحافظ الذكي" — مساعد شخصي متخصص في تحفيظ القرآن الكريم. 
لديك بيانات حقيقية ومحدّثة من قاعدة بيانات المستخدم. أجب دائماً بالعربية.
كن موجزاً ومحدداً وعملياً (4-8 أسطر كحد أقصى إلا إذا طُلب التفصيل).

${userContext}

${memContext}

${recitationContext}

== قدراتك ==
يمكنك اقتراح أدوات للتنفيذ. إذا أراد المستخدم تعديلاً فعلياً، أضف في نهاية ردك JSON على سطر منفصل:
TOOL:{"action":"update_plan","params":{"daily_pages":2}} 
أو TOOL:{"action":"mark_complete","params":{"note":"أكمل الفاتحة"}}
أو TOOL:{"action":"reschedule","params":{"delay_days":1,"reason":"مريض"}}
أو TOOL:{"action":"save_note","params":{"note":"المستخدم يعاني من مخرج الحاء"}}

لا تخترع معلومات غير موجودة في البيانات أعلاه.`;

  try {
    const resp = await fetch(`${coachCfg.baseUrl}/chat/completions`,{
      method:'POST',
      headers:{'Authorization':`Bearer ${coachCfg.apiKey}`,'Content-Type':'application/json'},
      body: JSON.stringify({
        model: coachCfg.model || 'gpt-4o-mini',
        messages:[{role:'system',content:systemPrompt},{role:'user',content:question}],
        max_tokens: 600,
        temperature: 0.7
      })
    });
    if (!resp.ok){
      const t=await resp.text();
      return send(res,200,{reply:'تعذّر الاتصال بالذكاء الاصطناعي. حاول لاحقاً.',error:'api_error',detail:t.slice(0,200)});
    }
    const data = await resp.json();
    let reply = data.choices?.[0]?.message?.content || 'لم يُنتج الذكاء الاصطناعي ردّاً.';

    // Extract and execute tool calls
    let toolResult = null;
    const toolMatch = reply.match(/TOOL:\s*(\{[^}]+\})/);
    if (toolMatch){
      reply = reply.replace(/TOOL:\s*\{[^}]+\}/, '').trim();
      try {
        const tool = JSON.parse(toolMatch[1]);
        toolResult = await executeAiTool(u, tool.action, tool.params||{});
        if (toolResult) persist();
      } catch(e){ console.error('Tool parse error',e.message); }
    }

    // Log interaction to memory
    if (!mem.interactions) mem.interactions=[];
    mem.interactions.push({ username:u.username, q:question.slice(0,200), a:reply.slice(0,300), ts:Date.now() });
    if (mem.interactions.length > 2000) mem.interactions = mem.interactions.slice(-2000);
    writeAiMemory(mem);

    // Also log to DB for user
    if (!u.ai_history) u.ai_history = [];
    u.ai_history.push({ q:question.slice(0,200), a:reply.slice(0,300), ts:now() });
    if (u.ai_history.length > 200) u.ai_history = u.ai_history.slice(-200);
    persist();

    send(res,200,{ reply, tool_executed: toolResult, source:'gpt-rag' });
  } catch(e){
    console.error('AI Coach error',e.message);
    send(res,500,{reply:'حدث خطأ داخلي. حاول لاحقاً.',error:e.message});
  }
});

/* Execute AI tool action */
async function executeAiTool(u, action, params){
  switch(action){
    case 'update_plan':
      if (!u.active_plan) u.active_plan={};
      if (params.daily_pages) u.active_plan.daily_pages=+params.daily_pages;
      if (params.name) u.active_plan.name=String(params.name).slice(0,100);
      u.active_plan.updated_at = now();
      return { action, status:'done', applied:params };

    case 'mark_complete':
      if (!u.progress) u.progress={};
      if (!u.ai_completions) u.ai_completions=[];
      u.ai_completions.push({ note:String(params.note||'').slice(0,200), ts:now() });
      return { action, status:'done', applied:params };

    case 'reschedule':
      if (!u.schedule_adjustments) u.schedule_adjustments=[];
      u.schedule_adjustments.push({ delay_days:+params.delay_days||1, reason:String(params.reason||'').slice(0,200), ts:now() });
      return { action, status:'done', applied:params };

    case 'save_note': {
      const mem2 = readAiMemory();
      if (!mem2.user_notes) mem2.user_notes={};
      if (!mem2.user_notes[u.username]) mem2.user_notes[u.username]=[];
      mem2.user_notes[u.username].push(String(params.note||'').slice(0,300));
      if (mem2.user_notes[u.username].length>50) mem2.user_notes[u.username]=mem2.user_notes[u.username].slice(-50);
      writeAiMemory(mem2);
      return { action, status:'done', applied:params };
    }
    default: return null;
  }
}

/* ── GET AI Memory (admin) ── */
R('GET','/qqc/admin/ai-memory', async(req,res)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const mem = readAiMemory();
  const stats = {
    total_interactions: (mem.interactions||[]).length,
    total_corrections: (mem.corrections||[]).length,
    users_with_notes: Object.keys(mem.user_notes||{}).length,
    global_notes: (mem.global_notes||[]).length,
    last_updated: mem.last_updated,
  };
  send(res,200,{ stats, recent_interactions: (mem.interactions||[]).slice(-20).reverse(), corrections: (mem.corrections||[]).slice(-20).reverse(), global_notes: mem.global_notes||[] });
});

/* ── Store correction (when AI was wrong) ── */
R('POST','/qqc/ai/memory/correct', async(req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const b = await readBody(req);
  const wrong   = String(b.wrong||'').slice(0,500);
  const correct = String(b.correct||'').slice(0,500);
  if (!wrong||!correct) return send(res,400,{error:'missing_fields'});
  const mem = readAiMemory();
  if (!mem.corrections) mem.corrections=[];
  mem.corrections.push({ username:u.username, wrong, correct, ts:Date.now() });
  if (mem.corrections.length>5000) mem.corrections=mem.corrections.slice(-5000);
  writeAiMemory(mem);
  send(res,200,{ok:true});
});

/* ── GET user AI history ── */
R('GET','/qqc/ai/history', async(req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  send(res,200,{ history: (u.ai_history||[]).slice().reverse().slice(0,50) });
});

/* ── Execute a tool directly (from frontend) ── */
R('POST','/qqc/ai/execute-tool', async(req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const b = await readBody(req);
  const action = String(b.action||'').slice(0,50);
  const params = b.params||{};
  if (!action) return send(res,400,{error:'no_action'});
  try {
    const result = await executeAiTool(u, action, params);
    if (result) persist();
    send(res,200,{ ok:!!result, result });
  } catch(e){ send(res,500,{error:e.message}); }
});

/* ── Admin: عرض السجلات ── */
R('GET','/qqc/admin/logs/:type', async(req,res,p)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const allowed = ['errors','ai_errors','recitation_errors','ai_training_data'];
  const type = p.type.replace(/[^a-z_]/g,'');
  if (!allowed.includes(type)) return send(res,400,{error:'invalid_type'});
  const records = readLogFile(`${type}.jsonl`, 1000);
  send(res,200,{ type, count: records.length, records });
});

/* ── Admin: مسح سجل معين ── */
R('DELETE','/qqc/admin/logs/:type', async(req,res,p)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const allowed = ['errors','ai_errors','recitation_errors','ai_training_data'];
  const type = p.type.replace(/[^a-z_]/g,'');
  if (!allowed.includes(type)) return send(res,400,{error:'invalid_type'});
  clearLogFile(`${type}.jsonl`);
  send(res,200,{ok:true});
});

/* ── Admin: إحصائيات السجلات ── */
R('GET','/qqc/admin/logs-stats', async(req,res)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const stats = {};
  for (const type of ['errors','ai_errors','recitation_errors','ai_training_data']) {
    const fp = path.join(LOGS_DIR, `${type}.jsonl`);
    try {
      const content = fs.existsSync(fp) ? fs.readFileSync(fp,'utf8') : '';
      stats[type] = { lines: content.trim().split('\n').filter(Boolean).length, size_kb: Math.round(Buffer.byteLength(content)/1024) };
    } catch{ stats[type] = { lines:0, size_kb:0 }; }
  }
  send(res,200,{ stats });
});

/* ══ YouTube Search + Video Training routes ══ */
R('GET','/qqc/admin/youtube-search', async(req,res)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const url = new URL(req.url, 'http://localhost');
  const q = url.searchParams.get('q')||'تلاوة قرآن';
  const maxResults = Math.min(20, Math.max(1, +(url.searchParams.get('n')||12)));
  const ytKey = DB.admin.ai_settings?.video_api_key || process.env.VIDEO_API_KEY;
  if(!ytKey) return send(res,200,{ok:false, error:'لا يوجد YouTube API Key — أضف مفتاح API الفيديو في إعدادات الذكاء الاصطناعي', needs_key:true});
  try {
    const ytUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(q)}&type=video&key=${ytKey}&maxResults=${maxResults}&relevanceLanguage=ar&order=relevance`;
    const ytResp = await fetch(ytUrl, {signal:AbortSignal.timeout(12000)});
    const ytData = await ytResp.json();
    if(ytData.error) return send(res,200,{ok:false, error:`YouTube API: ${ytData.error.message}`, code:ytData.error.code});
    const videos = (ytData.items||[]).map(item=>({
      id:item.id?.videoId||'',
      title:(item.snippet?.title||'').slice(0,150),
      channel:(item.snippet?.channelTitle||'').slice(0,80),
      description:(item.snippet?.description||'').slice(0,200),
      thumbnail:item.snippet?.thumbnails?.medium?.url||'',
      published:(item.snippet?.publishedAt||'').slice(0,10),
    }));
    send(res,200,{ok:true, videos, query:q, total:videos.length});
  } catch(e){ send(res,200,{ok:false, error:e.message}); }
});

R('GET','/qqc/admin/hermes/video-training', async(req,res)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const mem = readHermesMemory();
  const videos = mem.recitation_videos||[];
  const sheikhCounts={};
  videos.forEach(v=>{ if(v.sheikh) sheikhCounts[v.sheikh]=(sheikhCounts[v.sheikh]||0)+1; });
  send(res,200,{ videos:videos.slice().reverse(), total:videos.length, sheikh_coverage:sheikhCounts, has_yt_key:!!(DB.admin.ai_settings?.video_api_key||process.env.VIDEO_API_KEY) });
});

R('POST','/qqc/admin/hermes/video-train', async(req,res)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const b = await readBody(req);
  const vId = String(b.video_id||'').trim();
  if(!vId) return send(res,400,{error:'video_id مطلوب'});
  const mem = readHermesMemory();
  if(!mem.recitation_videos) mem.recitation_videos=[];
  const existing = mem.recitation_videos.findIndex(v=>v.id===vId);
  // Use AI to generate recitation notes based on video title
  const title = String(b.title||'').slice(0,150);
  const channel = String(b.channel||'').slice(0,80);
  let notes = String(b.notes||'').slice(0,1000);
  if(!notes && title){
    const aiNotes = await callAI(
      'أنت خبير في تجويد القرآن وتعليم التلاوة. بناءً على عنوان مقطع الفيديو، استخرج: اسم الشيخ، السورة، الآيات، أسلوب التلاوة، وما يمكن أن يتعلمه نظام التسميع الذكي منه. كن مختصراً ومحدداً.',
      `عنوان المقطع: "${title}" | القناة: "${channel}"`,
      400
    );
    if(aiNotes) notes = aiNotes;
  }
  const entry = {
    id:vId, title, channel, sheikh:String(b.sheikh||'').slice(0,100),
    surah:String(b.surah||'').slice(0,150), notes,
    url:`https://youtu.be/${vId}`, thumbnail:String(b.thumbnail||'').slice(0,300),
    added_at:now()
  };
  if(existing>=0) mem.recitation_videos[existing]={...entry};
  else mem.recitation_videos.push(entry);
  if(mem.recitation_videos.length>300) mem.recitation_videos=mem.recitation_videos.slice(-300);
  if(!mem.insights) mem.insights=[];
  mem.insights.push({text:`تدريب فيديو جديد: "${title}"${notes?` — ${notes.slice(0,80)}`:''}`, category:'recitation', impact:'medium', at:now()});
  writeHermesMemory(mem);
  send(res,200,{ok:true, total:mem.recitation_videos.length, notes, action:existing>=0?'updated':'added'});
});

R('DELETE','/qqc/admin/hermes/video-train/:id', async(req,res,p)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const mem = readHermesMemory();
  if(!mem.recitation_videos) return send(res,200,{ok:true});
  const before = mem.recitation_videos.length;
  mem.recitation_videos = mem.recitation_videos.filter(v=>v.id!==p.id);
  writeHermesMemory(mem);
  send(res,200,{ok:true, removed:before-mem.recitation_videos.length, total:mem.recitation_videos.length});
});

/* ════════════════════════════════════════════════════════════════
   MISSING ESSENTIAL FEATURES — Added in gap-analysis pass
════════════════════════════════════════════════════════════════ */

/* ── 1. Admin DB Backup Download / Restore ── */
R('GET','/qqc/admin/backup/download', async(req,res)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  try {
    const raw = fs.readFileSync(DB_PATH,'utf8');
    const ts  = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
    res.writeHead(200,{
      'Content-Type':'application/json; charset=utf-8',
      'Content-Disposition':`attachment; filename="qqc-backup-${ts}.json"`,
      'Content-Length': Buffer.byteLength(raw,'utf8'),
      'Access-Control-Allow-Origin':'*'
    });
    res.end(raw);
  } catch(e){ send(res,500,{error:e.message}); }
});

R('POST','/qqc/admin/backup/restore', async(req,res)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  try {
    const b = await readLargeBody(req, 50);
    if(!b || typeof b !== 'object') return send(res,400,{error:'invalid_json'});
    if(!b.admin || !b.users) return send(res,400,{error:'invalid_db_structure'});
    const backupPath = DB_PATH + '.restore_backup_' + Date.now();
    fs.writeFileSync(backupPath, fs.readFileSync(DB_PATH,'utf8'));
    Object.keys(DB).forEach(k=>{ delete DB[k]; });
    Object.assign(DB, b);
    persist();
    send(res,200,{ok:true, backup_saved:backupPath, note:'قاعدة البيانات استُعيدت بنجاح. النسخة القديمة محفوظة.'});
  } catch(e){ send(res,500,{error:e.message}); }
});

/* ── 2. User Password Change ── */
R('POST','/qqc/me/password', async(req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const b = await readBody(req);
  const current = String(b.current_password||'');
  const newPw   = String(b.new_password||'');
  if(!current || !newPw) return send(res,400,{error:'current_password و new_password مطلوبان'});
  if(newPw.length < 6) return send(res,400,{error:'كلمة المرور الجديدة يجب أن تكون 6 أحرف على الأقل'});
  const crypto = await import('crypto');
  const currentHash = crypto.createHash('sha256').update(current).digest('hex');
  if(currentHash !== u.password_hash) return send(res,403,{error:'كلمة المرور الحالية غير صحيحة'});
  u.password_hash = crypto.createHash('sha256').update(newPw).digest('hex');
  persist();
  send(res,200,{ok:true, message:'تم تغيير كلمة المرور بنجاح'});
});

/* ── 3. Admin Password Reset for any user ── */
R('POST','/qqc/admin/users/:username/reset-password', async(req,res,p)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const u = DB.users[p.username]; if(!u) return send(res,404,{error:'user_not_found'});
  const b = await readBody(req);
  const newPw = String(b.new_password||'').trim();
  if(!newPw || newPw.length<4) return send(res,400,{error:'new_password يجب أن يكون 4 أحرف على الأقل'});
  const crypto = await import('crypto');
  u.password_hash = crypto.createHash('sha256').update(newPw).digest('hex');
  persist();
  send(res,200,{ok:true, username:p.username, message:'تم إعادة تعيين كلمة المرور'});
});

/* ── 4. Quran Text Search ── */
R('GET','/qqc/quran/search', async(req,res,_p,query)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const q = String(query?.q||'').trim();
  if(!q || q.length<2) return send(res,400,{error:'q مطلوب (2 أحرف على الأقل)'});
  const limit = Math.min(50, +(query?.limit||20));
  const results = [];
  for(const [key,cached] of Object.entries(QURAN_CACHE)){
    if(key==='list'||!cached?.data) continue;
    const ayahs = Array.isArray(cached.data) ? cached.data : (cached.data.ayahs||[]);
    for(const ayah of ayahs){
      if(ayah.text && ayah.text.includes(q)){
        results.push({
          surah_num: ayah.surah?.number || cached.data?.number,
          surah_name: ayah.surah?.name || cached.data?.name,
          ayah_num: ayah.numberInSurah,
          text: ayah.text,
          global_num: ayah.number
        });
        if(results.length>=limit) break;
      }
    }
    if(results.length>=limit) break;
  }
  send(res,200,{ok:true, query:q, count:results.length, results, note: results.length===0?'لا نتائج في الكاش المحلي — افتح السور أولاً لتُحمَّل في الكاش':''}); 
});

/* ── 5. User Progress Report ── */
R('GET','/qqc/me/progress-report', async(req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const p   = u.progress||{};
  const plan= u.plan||{};
  const sessions = (u.sessions||[]).slice(-30);
  const avgDifficulty = sessions.length
    ? +(sessions.reduce((s,ss)=>s+(ss.difficulty||3),0)/sessions.length).toFixed(1) : 0;
  const avgPages = sessions.length
    ? +(sessions.reduce((s,ss)=>s+(ss.pages_done||0),0)/sessions.length).toFixed(2) : 0;
  const tarteel = (u.tarteel_history||[]).slice(-20);
  const avgTarteel = tarteel.length
    ? Math.round(tarteel.reduce((s,t)=>s+(t.score||0),0)/tarteel.length) : 0;
  const khatma = u.khatma||null;
  const report = {
    username: u.username,
    display_name: u.display_name||u.username,
    generated_at: now(),
    summary: {
      pages_memorized: +(p.total_pages_memorized||0).toFixed(2),
      current_streak: p.current_streak_days||0,
      longest_streak: p.longest_streak_days||0,
      total_sessions: p.total_sessions_completed||0,
      consecutive_absences: p.consecutive_absences||0,
      last_session: p.last_session_date||null,
    },
    plan: {
      phase: plan.phase||'غير محدد',
      daily_target: plan.current_daily_pages||0,
      target_surah: plan.target_surah||'',
      mode: u.plan_mode||'auto',
    },
    recitation: {
      sessions_30: tarteel.length,
      avg_accuracy_pct: avgTarteel,
      top_surah: tarteel.length ? (tarteel.slice(-5).map(t=>t.surah_name).filter(Boolean)[0]||'') : '',
    },
    sessions_30: {
      count: sessions.length,
      avg_difficulty: avgDifficulty,
      avg_pages_per_session: avgPages,
    },
    khatma: khatma ? {
      completions: khatma.completions||0,
      pages_read: khatma.total_pages_read||0,
      target_days: khatma.target_days||30,
    } : null,
    energy: u.energy?.score||75,
  };
  send(res,200,{ok:true, report});
});

/* ── 6. Hermes Special Instruction Endpoint ── */
R('POST','/qqc/admin/hermes/special-instruction', async(req,res)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const b = await readBody(req);
  const instruction = String(b.instruction||'').trim().slice(0,1000);
  if(!instruction) return send(res,400,{error:'instruction مطلوبة'});
  const mem = readHermesMemory();
  if(!mem.cfg_patches) mem.cfg_patches={};
  mem.cfg_patches.special_instruction = instruction;
  mem.cfg_patches.focus_mode = 'code_analysis';
  writeHermesMemory(mem);
  send(res,200,{ok:true, instruction, note:'سيُنفَّذ في دورة Hermes القادمة. يمكنك تشغيله الآن عبر run-now.'});
});

/* ── 7. Admin: Get Server Stats (enhanced) ── */
R('GET','/qqc/admin/server-stats', async(req,res)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const userList = Object.values(DB.users||{});
  const now7days = Date.now()-7*86400000;
  const now1day  = Date.now()-86400000;
  const active7d = userList.filter(u=>u.progress?.last_session_date && new Date(u.progress.last_session_date).getTime()>now7days).length;
  const active1d = userList.filter(u=>u.progress?.last_session_date && new Date(u.progress.last_session_date).getTime()>now1day).length;
  const hermMem  = readHermesMemory();
  const logDir   = path.join(ROOT,'logs');
  let logFiles = [];
  try { logFiles = fs.readdirSync(logDir).map(f=>{ try{ const st=fs.statSync(path.join(logDir,f)); return {name:f,size_kb:+(st.size/1024).toFixed(1)}; }catch{return null;} }).filter(Boolean); } catch{}
  send(res,200,{
    total_users: userList.length,
    active_last_24h: active1d,
    active_last_7d: active7d,
    total_sessions_all: userList.reduce((s,u)=>s+(u.progress?.total_sessions_completed||0),0),
    hermes_runs: hermMem.stats?.total_runs||0,
    hermes_last_run: hermMem.last_run||null,
    ai_provider: getActiveAIProviderName(),
    log_files: logFiles,
    uptime_s: Math.floor(process.uptime()),
    node_version: process.version,
    memory_mb: +(process.memoryUsage().rss/1048576).toFixed(1),
  });
});

/* ── 8. Admin: List all users with key stats ── */
R('GET','/qqc/admin/users-summary', async(req,res)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const list = Object.values(DB.users||{}).map(u=>({
    username: u.username,
    display_name: u.display_name||u.username,
    role: u.role||'student',
    pages: +(u.progress?.total_pages_memorized||0).toFixed(2),
    streak: u.progress?.current_streak_days||0,
    absences: u.progress?.consecutive_absences||0,
    sessions: u.progress?.total_sessions_completed||0,
    last_session: u.progress?.last_session_date||null,
    energy: u.energy?.score||75,
    plan_phase: u.plan?.phase||'',
    joined: u.created_at||'',
    khatma_completions: u.khatma?.completions||0,
  }));
  list.sort((a,b)=>b.sessions-a.sessions);
  send(res,200,{ok:true, count:list.length, users:list});
});

/* ══════════════════════════════════════════════════════════
   🤖 CLAUDE CODE — AI Coding Assistant (SSE streaming)
   ══════════════════════════════════════════════════════════ */

const CLAUDE_CODE_TOOLS = [
  { type:'function', function:{ name:'read_file', description:'اقرأ محتوى أي ملف من المشروع بالكامل',
    parameters:{ type:'object', properties:{ path:{type:'string',description:'مسار الملف النسبي من جذر المشروع'} }, required:['path'] } } },
  { type:'function', function:{ name:'write_file', description:'اكتب أو عدّل ملفاً في المشروع — يستبدل المحتوى كاملاً',
    parameters:{ type:'object', properties:{ path:{type:'string'}, content:{type:'string'}, reason:{type:'string',description:'سبب التعديل'} }, required:['path','content'] } } },
  { type:'function', function:{ name:'patch_file', description:'عدّل جزءاً محدداً من ملف — استبدل نصاً معيناً بنص جديد (أسرع من write_file للتعديلات الصغيرة)',
    parameters:{ type:'object', properties:{ path:{type:'string'}, old_text:{type:'string',description:'النص الحالي المراد استبداله (يجب أن يتطابق حرفياً)'}, new_text:{type:'string',description:'النص الجديد البديل'}, reason:{type:'string'} }, required:['path','old_text','new_text'] } } },
  { type:'function', function:{ name:'run_command', description:'نفّذ أمر shell في مجلد المشروع',
    parameters:{ type:'object', properties:{ cmd:{type:'string'}, cwd:{type:'string',description:'المجلد النسبي (اختياري)'} }, required:['cmd'] } } },
  { type:'function', function:{ name:'list_files', description:'قائمة الملفات والمجلدات في مسار معين',
    parameters:{ type:'object', properties:{ path:{type:'string',description:'المسار النسبي (اتركه فارغاً للجذر)'} }, required:[] } } },
  { type:'function', function:{ name:'search_code', description:'ابحث عن نص أو دالة في ملفات المشروع',
    parameters:{ type:'object', properties:{ query:{type:'string'}, path:{type:'string',description:'مجلد البحث (اختياري)'} }, required:['query'] } } },
  { type:'function', function:{ name:'get_server_status', description:'تحقق من حالة السيرفر — هل يعمل؟ ما الـ port؟',
    parameters:{ type:'object', properties:{}, required:[] } } },
];

async function executeClaudeCodeTool(toolName, args){
  switch(toolName){
    case 'read_file': {
      const fp = path.join(ROOT, String(args.path||'').replace(/\.\.\//g,''));
      if(!fp.startsWith(ROOT)) return {error:'forbidden'};
      if(!fs.existsSync(fp)) return {error:`الملف غير موجود: ${args.path}`};
      const content = fs.readFileSync(fp,'utf8');
      return {ok:true, path:args.path, content:content.slice(0,40000), lines:content.split('\n').length, truncated:content.length>40000};
    }
    case 'write_file': {
      const fp = path.join(ROOT, String(args.path||'').replace(/\.\.\//g,''));
      if(!fp.startsWith(ROOT)) return {error:'forbidden'};
      const dir2 = path.dirname(fp);
      if(!fs.existsSync(dir2)) fs.mkdirSync(dir2,{recursive:true});
      fs.writeFileSync(fp, String(args.content||''), 'utf8');
      return {ok:true, path:args.path, bytes:args.content.length, lines:String(args.content).split('\n').length, reason:args.reason||''};
    }
    case 'patch_file': {
      const fp = path.join(ROOT, String(args.path||'').replace(/\.\.\//g,''));
      if(!fp.startsWith(ROOT)) return {error:'forbidden'};
      if(!fs.existsSync(fp)) return {error:`الملف غير موجود: ${args.path}`};
      let content = fs.readFileSync(fp,'utf8');
      const oldTxt = String(args.old_text||'');
      const newTxt = String(args.new_text||'');
      if(!content.includes(oldTxt)) return {ok:false, error:'النص القديم غير موجود في الملف — تحقق من المطابقة الحرفية', path:args.path};
      content = content.replace(oldTxt, newTxt);
      fs.writeFileSync(fp, content, 'utf8');
      return {ok:true, path:args.path, chars_removed:oldTxt.length, chars_added:newTxt.length, reason:args.reason||''};
    }
    case 'run_command': {
      const {exec} = require('child_process');
      const cwd2 = args.cwd ? path.join(ROOT, String(args.cwd).replace(/\.\.\//g,'')) : ROOT;
      const safeDir = cwd2.startsWith(ROOT)?cwd2:ROOT;
      return new Promise(resolve=>{
        exec(String(args.cmd||''), {cwd:safeDir, timeout:20000, maxBuffer:512*1024}, (err,stdout,stderr)=>{
          resolve({ok:!err, cmd:args.cmd, stdout:stdout.slice(0,8000), stderr:stderr.slice(0,3000), exit_code:err?(err.code||1):0});
        });
      });
    }
    case 'list_files': {
      const fp = args.path ? path.join(ROOT, String(args.path).replace(/\.\.\//g,'')) : ROOT;
      if(!fp.startsWith(ROOT)) return {error:'forbidden'};
      if(!fs.existsSync(fp)) return {error:`المسار غير موجود: ${args.path}`};
      const IGNORE = new Set(['node_modules','.git','__pycache__','.DS_Store','.cache','dist','build']);
      const entries = fs.readdirSync(fp,{withFileTypes:true}).filter(e=>!IGNORE.has(e.name)&&!e.name.startsWith('.cache'));
      return {ok:true, path:args.path||'.', entries:entries.map(e=>({name:e.name, type:e.isDirectory()?'dir':'file', size:e.isFile()?fs.statSync(path.join(fp,e.name)).size:0}))};
    }
    case 'search_code': {
      const {exec} = require('child_process');
      const searchDir = args.path ? path.join(ROOT, String(args.path).replace(/\.\.\//g,'')) : ROOT;
      const q = String(args.query||'').replace(/"/g,'\\"');
      return new Promise(resolve=>{
        exec(`grep -rn "${q}" --include="*.js" --include="*.json" --include="*.html" --include="*.css" --include="*.md" -m 5`, {cwd:searchDir, timeout:10000, maxBuffer:512*1024}, (err,stdout)=>{
          const lines = stdout.split('\n').filter(Boolean).slice(0,40);
          resolve({ok:true, query:args.query, results:lines, count:lines.length});
        });
      });
    }
    case 'get_server_status': {
      const {exec} = require('child_process');
      return new Promise(resolve=>{
        exec('curl -s http://localhost:5000/qqc/health 2>&1 | head -5; echo "---"; ps aux | grep "node server" | grep -v grep | head -3', {cwd:ROOT, timeout:5000}, (err,stdout)=>{
          resolve({ok:true, output:stdout.slice(0,1000), port:5000, uptime:process.uptime().toFixed(0)+'s'});
        });
      });
    }
    default: return {error:`أداة غير معروفة: ${toolName}`};
  }
}

R('POST','/qqc/admin/claude-code/chat', async(req,res)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const b = await readBody(req);
  const userMsg = String(b.message||'').slice(0,10000);
  if(!userMsg) return send(res,400,{error:'message required'});
  const history = Array.isArray(b.history) ? b.history.slice(-24) : [];

  const activeCfg = getActiveAIConfig();
  if(!activeCfg) return send(res,503,{error:'ai_not_configured — أضف API key في إعدادات الذكاء الاصطناعي'});

  res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','Access-Control-Allow-Origin':'*'});
  const sse=(type,data)=>{ try{ res.write(`data: ${JSON.stringify({type,...data})}\n\n`); }catch{} };

  const systemPrompt = `أنت Claude Code — مساعد برمجة ذكاء اصطناعي متخصص في مشروع Quantum Quran Coach.

هيكل المشروع:
- quran-coach/server.js — الخادم الرئيسي Node.js (~4300 سطر)
- quran-coach/public/app.js — الواجهة الأمامية (~6400 سطر)
- quran-coach/public/index.html — HTML الرئيسي (~1250 سطر)
- quran-coach/db.json — قاعدة البيانات JSON
- quran-coach/hermes_memory.json — ذاكرة وكيل Hermes
- quran-coach/claude-proxy.js — Claude AI Proxy (Node.js, port 8082)

قواعد عملك:
1. اقرأ الملف أولاً (read_file) قبل أي تعديل
2. استخدم patch_file للتعديلات الصغيرة — أسرع وأأمن
3. استخدم write_file فقط للملفات الجديدة أو التغييرات الكبيرة
4. بعد كل تعديل: نفّذ أمر للتحقق من عمل السيرفر (run_command: curl http://localhost:5000/qqc/health)
5. أخبر المستخدم بما فعلته بالتفصيل بالعربية
6. إذا فشل أمر: اقرأ الخطأ وأصلحه تلقائياً
7. يمكنك تعديل أي ملف في المشروع

الرد بالعربية دائماً. كن مباشراً واعمل فعلياً — لا تكتفِ بالوصف.`;

  const messages = [
    {role:'system', content:systemPrompt},
    ...history.map(h=>({role:h.role, content:String(h.content||'').slice(0,4000)})),
    {role:'user', content:userMsg}
  ];

  let toolCallCount=0;
  const maxCalls=15;
  try {
    while(toolCallCount<maxCalls){
      let resp;
      try {
        resp = await fetch(`${activeCfg.baseUrl}/chat/completions`,{
          method:'POST', signal:AbortSignal.timeout(60000),
          headers:{'Authorization':`Bearer ${activeCfg.apiKey}`,'Content-Type':'application/json'},
          body:JSON.stringify({model:activeCfg.model, messages, tools:CLAUDE_CODE_TOOLS, tool_choice:'auto', max_tokens:2500})
        });
      } catch(e){ sse('error',{message:'خطأ في الاتصال بالذكاء الاصطناعي: '+e.message}); break; }

      if(!resp.ok){
        const et=await resp.text().catch(()=>'');
        sse('error',{message:`API error ${resp.status} — ${et.slice(0,200)}`}); break;
      }
      const data = await resp.json();
      const msg = data.choices?.[0]?.message;
      if(!msg) break;
      messages.push(msg);
      if(msg.content) sse('message',{content:msg.content});
      if(!msg.tool_calls||!msg.tool_calls.length) break;

      for(const tc of msg.tool_calls){
        toolCallCount++;
        const toolName=tc.function?.name;
        let args={};
        try{ args=JSON.parse(tc.function?.arguments||'{}'); }catch{}
        sse('tool_call',{name:toolName, args, id:tc.id});
        let result;
        try{ result=await executeClaudeCodeTool(toolName,args); }catch(e){ result={error:e.message}; }
        if(result?.ok && (toolName==='write_file'||toolName==='patch_file')){
          sse('file_changed',{path:args.path, reason:args.reason||'', bytes:result.bytes||result.chars_added||0});
        }
        sse('tool_result',{name:toolName, result:JSON.stringify(result).slice(0,3000), ok:result?.ok});
        messages.push({role:'tool', tool_call_id:tc.id, content:JSON.stringify(result).slice(0,8000)});
      }
    }
  } catch(e){ sse('error',{message:e.message}); }
  sse('done',{tool_calls:toolCallCount});
  res.end();
});

/* ══════════════════════════════════════════════════════════
   🛠️ DEVELOPER TOOLS — Terminal · Files · Logs
   ══════════════════════════════════════════════════════════ */

/* ── Terminal exec ── */
R('POST','/qqc/admin/terminal/exec', async(req,res)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const b = await readBody(req);
  const cmd = String(b.cmd||'').trim();
  if(!cmd) return send(res,400,{error:'no_command'});
  const cwd2 = path.join(ROOT, String(b.cwd||'').replace(/\.\.\//g,'').replace(/^\//,''));
  const safeDir = cwd2.startsWith(ROOT) ? cwd2 : ROOT;
  const {exec} = require('child_process');
  exec(cmd, {cwd:safeDir, timeout:20000, maxBuffer:1024*512}, (err,stdout,stderr)=>{
    send(res,200,{
      stdout: stdout.slice(0,60000),
      stderr: stderr.slice(0,10000),
      exit_code: err ? (err.code||1) : 0,
      signal: err?.signal||null,
      cwd: safeDir.replace(ROOT,'').replace(/^\//,'')||'quran-coach'
    });
  });
});

/* ── Files: list directory ── */
R('GET','/qqc/admin/files/tree', async(req,res,_,query)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const relPath = (query.path||'').replace(/\.\.\//g,'').replace(/^\//,'');
  const target = relPath ? path.join(ROOT,relPath) : ROOT;
  if(!target.startsWith(ROOT)) return send(res,403,{error:'forbidden'});
  try {
    const entries = fs.readdirSync(target,{withFileTypes:true});
    const IGNORE = new Set(['node_modules','.git','.replit','__pycache__','.DS_Store']);
    const items = entries
      .filter(e=>!IGNORE.has(e.name)&&!e.name.startsWith('.cache'))
      .map(e=>{
        let size=0;
        try{ if(e.isFile()) size=fs.statSync(path.join(target,e.name)).size; }catch{}
        return {name:e.name, type:e.isDirectory()?'dir':'file', size};
      })
      .sort((a,b)=>a.type===b.type?a.name.localeCompare(b.name):(a.type==='dir'?-1:1));
    send(res,200,{ok:true, path:relPath||'.', items});
  } catch(e){ send(res,500,{error:e.message}); }
});

/* ── Files: read file content ── */
R('GET','/qqc/admin/files/read', async(req,res,_,query)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const relPath = (query.path||'').replace(/\.\.\//g,'');
  if(!relPath) return send(res,400,{error:'no_path'});
  const target = path.join(ROOT,relPath);
  if(!target.startsWith(ROOT)) return send(res,403,{error:'forbidden'});
  try {
    const stat = fs.statSync(target);
    if(stat.size > 3*1024*1024) return send(res,413,{error:'file_too_large', size:stat.size});
    const content = fs.readFileSync(target,'utf8');
    send(res,200,{ok:true, path:relPath, content, size:stat.size, modified:stat.mtime.toISOString()});
  } catch(e){ send(res,500,{error:e.message}); }
});

/* ── Files: write file ── */
R('POST','/qqc/admin/files/write', async(req,res)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  let b;
  try{ b = await readLargeBody(req,20); }catch(e){ return send(res,413,{error:'too_large'}); }
  const relPath = String(b.path||'').replace(/\.\.\//g,'').replace(/^\//,'');
  if(!relPath) return send(res,400,{error:'no_path'});
  const target = path.join(ROOT,relPath);
  if(!target.startsWith(ROOT)) return send(res,403,{error:'forbidden'});
  try {
    fs.mkdirSync(path.dirname(target),{recursive:true});
    fs.writeFileSync(target,String(b.content||''),'utf8');
    if(target===path.join(ROOT,'server.js')||target===path.join(ROOT,'db.json')){ try{ persist(); }catch{} }
    send(res,200,{ok:true, path:relPath, size:Buffer.byteLength(String(b.content||''))});
  } catch(e){ send(res,500,{error:e.message}); }
});

/* ── Files: delete file ── */
R('DELETE','/qqc/admin/files/delete', async(req,res,_,query)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const relPath = (query.path||'').replace(/\.\.\//g,'');
  if(!relPath) return send(res,400,{error:'no_path'});
  const target = path.join(ROOT,relPath);
  if(!target.startsWith(ROOT)) return send(res,403,{error:'forbidden'});
  const PROTECTED = new Set(['server.js','db.json','hermes_memory.json','package.json']);
  if(PROTECTED.has(path.basename(relPath))) return send(res,403,{error:'protected_file'});
  try {
    const stat = fs.statSync(target);
    if(stat.isDirectory()) fs.rmdirSync(target,{recursive:true});
    else fs.unlinkSync(target);
    send(res,200,{ok:true});
  } catch(e){ send(res,500,{error:e.message}); }
});

/* ── Logs: list log files ── */
R('GET','/qqc/admin/logs/files', async(req,res)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  try {
    const dirs = [path.join(ROOT,'logs'), path.join(ROOT)];
    const result = [];
    for(const dir of dirs){
      if(!fs.existsSync(dir)) continue;
      fs.readdirSync(dir)
        .filter(f=>(f.endsWith('.jsonl')||f.endsWith('.log'))&&fs.statSync(path.join(dir,f)).isFile())
        .forEach(f=>{
          const st = fs.statSync(path.join(dir,f));
          result.push({name:f, dir:dir===ROOT?'root':'logs', size:st.size, modified:st.mtime.toISOString()});
        });
    }
    send(res,200,{ok:true, files:result});
  } catch(e){ send(res,500,{error:e.message}); }
});

/* ── Logs: read log file ── */
R('GET','/qqc/admin/logs/read', async(req,res,_,query)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const fname = path.basename(query.file||'errors.jsonl');
  const subdir = query.dir==='root' ? ROOT : path.join(ROOT,'logs');
  const target = path.join(subdir, fname);
  if(!target.startsWith(ROOT)) return send(res,403,{error:'forbidden'});
  const maxLines = Math.min(parseInt(query.lines||200),1000);
  try {
    if(!fs.existsSync(target)) return send(res,200,{ok:true, lines:[], total:0});
    const content = fs.readFileSync(target,'utf8');
    const all = content.split('\n').filter(Boolean);
    const recent = all.slice(-maxLines);
    send(res,200,{ok:true, file:fname, lines:recent, total:all.length});
  } catch(e){ send(res,500,{error:e.message}); }
});

/* ── 9. Daily Absence Notification Cron ── */
function runDailyAbsenceCron(){
  try {
    const users = Object.values(DB.users||{});
    const now3d = Date.now()-3*86400000;
    const now7d = Date.now()-7*86400000;
    let notified=0;
    users.forEach(u=>{
      const last = u.progress?.last_session_date;
      if(!last) return;
      const lastMs = new Date(last).getTime();
      const absences = u.progress?.consecutive_absences||0;
      if(lastMs < now7d && absences>=7){
        addNotif(u.username,'absence_alert','⚠️ أسبوع بدون حفظ! الانتظام مفتاح الإتقان — عُد اليوم ولو لدقائق.','view-tarteel');
        notified++;
      } else if(lastMs < now3d && absences>=3){
        addNotif(u.username,'absence_alert','🌙 لم تتدرب منذ أيام — خطتك تنتظرك. خُطوة صغيرة تُفرق كثيراً.','view-plan');
        notified++;
      }
    });
    if(notified>0){ persist(); console.log(`[DailyCron] Sent absence alerts to ${notified} users`); }
  } catch(e){ console.error('[DailyCron] Error:',e.message); }
}
const _dailyCronMs = 6*60*60*1000;
setInterval(runDailyAbsenceCron, _dailyCronMs);
setTimeout(runDailyAbsenceCron, 30000);

/* ═══════════════════════════════════════════════════════════════ */

/* ══ Boot: start auto-pilot if previously enabled ══ */
setupAutoPilot();
