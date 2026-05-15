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
async function callAI(systemPrompt, userMsg){
  const baseUrl = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  const apiKey  = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  if(!baseUrl || !apiKey) return null;
  try {
    const resp = await fetch(`${baseUrl}/chat/completions`,{
      method:'POST',
      headers:{'Authorization':`Bearer ${apiKey}`,'Content-Type':'application/json'},
      body:JSON.stringify({model:'gpt-5-mini', messages:[{role:'system',content:systemPrompt},{role:'user',content:userMsg}], max_completion_tokens:300})
    });
    const data = await resp.json();
    return data.choices?.[0]?.message?.content || null;
  } catch(e){ console.error('AI error',e.message); return null; }
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
   HERMES AGENT — خدمة الوكيل الذكي الخلفية
   مستوحى من NousResearch/hermes-agent
   يعمل تلقائياً كل ساعتين بحلقة tool-calling لتحليل المستخدمين
   وتوليد توصيات شخصية ودفع إشعارات ذكية وتحسين الخطط
══════════════════════════════════════════════════════════════════ */

const HERMES_MEMORY_PATH = path.join(ROOT, 'hermes_memory.json');
function readHermesMemory(){
  try { return JSON.parse(fs.readFileSync(HERMES_MEMORY_PATH,'utf8')); }
  catch { return { skills:[], insights:[], runs:[], last_run:null, stats:{total_runs:0, total_tool_calls:0, users_helped:0} }; }
}
function writeHermesMemory(m){ try { fs.writeFileSync(HERMES_MEMORY_PATH, JSON.stringify(m,null,2)); } catch(e){ console.error('[Hermes] Memory write failed',e.message); } }

/* ─── Tool definitions (OpenAI function calling format) ─── */
const HERMES_TOOLS = [
  {
    type:'function',
    function:{
      name:'scan_users',
      description:'مسح جميع المستخدمين وتحديد الحالات التي تحتاج تدخل. يُعيد قائمة بالمستخدمين مع إحصائياتهم.',
      parameters:{
        type:'object',
        properties:{
          filter:{ type:'string', enum:['all','struggling','inactive','high_performers','new_users'], description:'نوع التصفية' }
        },
        required:['filter']
      }
    }
  },
  {
    type:'function',
    function:{
      name:'get_user_details',
      description:'الحصول على تفاصيل مستخدم محدد: خطته، تقدمه، طاقته، تاريخ الجلسات.',
      parameters:{
        type:'object',
        properties:{ username:{ type:'string' } },
        required:['username']
      }
    }
  },
  {
    type:'function',
    function:{
      name:'push_smart_notification',
      description:'إرسال إشعار ذكي شخصي لمستخدم.',
      parameters:{
        type:'object',
        properties:{
          username:{ type:'string' },
          type:{ type:'string', enum:['motivation','warning','tip','achievement','plan_update'] },
          text:{ type:'string', description:'نص الإشعار بالعربية (max 200 حرف)' },
          ref:{ type:'string', description:'الصفحة المرجعية مثل view-plan أو view-session' }
        },
        required:['username','type','text']
      }
    }
  },
  {
    type:'function',
    function:{
      name:'adjust_user_plan',
      description:'تعديل خطة المستخدم تلقائياً بناءً على التحليل.',
      parameters:{
        type:'object',
        properties:{
          username:{ type:'string' },
          daily_pages:{ type:'number', description:'الصفحات اليومية الجديدة' },
          reason:{ type:'string', description:'سبب التعديل (max 150 حرف)' }
        },
        required:['username','daily_pages','reason']
      }
    }
  },
  {
    type:'function',
    function:{
      name:'save_skill',
      description:'حفظ مهارة/معرفة جديدة تعلّمها الوكيل لاستخدامها مستقبلاً.',
      parameters:{
        type:'object',
        properties:{
          title:{ type:'string' },
          content:{ type:'string', description:'محتوى المهارة (max 500 حرف)' },
          tags:{ type:'array', items:{ type:'string' } }
        },
        required:['title','content']
      }
    }
  },
  {
    type:'function',
    function:{
      name:'get_global_stats',
      description:'الحصول على إحصائيات عامة عن التطبيق: عدد المستخدمين، الجلسات، الصفحات المحفوظة.',
      parameters:{ type:'object', properties:{} }
    }
  },
  {
    type:'function',
    function:{
      name:'log_insight',
      description:'تسجيل ملاحظة أو استنتاج مهم في الذاكرة للرجوع إليه لاحقاً.',
      parameters:{
        type:'object',
        properties:{
          insight:{ type:'string' },
          category:{ type:'string', enum:['user_behavior','algorithm','plan','coaching','general'] }
        },
        required:['insight','category']
      }
    }
  },
  {
    type:'function',
    function:{
      name:'done',
      description:'إنهاء دورة التحليل الحالية.',
      parameters:{
        type:'object',
        properties:{ summary:{ type:'string', description:'ملخص ما تم تنفيذه في هذه الدورة' } },
        required:['summary']
      }
    }
  }
];

/* ─── Tool executor ─── */
async function executeHermesTool(toolName, args, mem){
  switch(toolName){
    case 'scan_users': {
      const users = Object.values(DB.users);
      let filtered;
      if(args.filter==='struggling')      filtered = users.filter(u=>(u.progress?.consecutive_absences||0)>=2 || (u.energy?.score||75)<40);
      else if(args.filter==='inactive')   filtered = users.filter(u=>{ const d=u.progress?.last_session_date; if(!d) return true; return (Date.now()-new Date(d).getTime())>3*86400000; });
      else if(args.filter==='high_performers') filtered = users.filter(u=>(u.progress?.current_streak_days||0)>=7);
      else if(args.filter==='new_users')  filtered = users.filter(u=>{ return (Date.now()-new Date(u.created_at||0).getTime())<7*86400000; });
      else                                filtered = users;
      return filtered.slice(0,30).map(u=>({
        username:u.username,
        display_name:u.display_name,
        energy:u.energy?.score||75,
        streak:u.progress?.current_streak_days||0,
        absences:u.progress?.consecutive_absences||0,
        total_pages:u.progress?.total_pages_memorized||0,
        last_session:u.progress?.last_session_date||null,
        daily_pages:u.plan?.current_daily_pages||0,
      }));
    }
    case 'get_user_details': {
      const u = DB.users[args.username]; if(!u) return {error:'not_found'};
      return {
        username:u.username, energy:u.energy, progress:u.progress,
        plan:u.plan, onboarding:u.onboarding,
        sessions_last5:(u.sessions||[]).slice(-5),
        sr_state:u.sr_state,
      };
    }
    case 'push_smart_notification': {
      const u = DB.users[args.username]; if(!u) return {error:'not_found'};
      addNotif(u.username, args.type||'tip', String(args.text||'').slice(0,200), args.ref||'view-dashboard');
      persist();
      if(!mem.stats) mem.stats={};
      mem.stats.users_helped = (mem.stats.users_helped||0)+1;
      return {ok:true, sent_to:args.username};
    }
    case 'adjust_user_plan': {
      const u = DB.users[args.username]; if(!u) return {error:'not_found'};
      if(!u.plan) u.plan={};
      const oldPages = u.plan.current_daily_pages||0;
      u.plan.current_daily_pages = Math.max(0.1, Math.min(10, +args.daily_pages||oldPages));
      u.plan.hermes_adjustment = { old:oldPages, new:u.plan.current_daily_pages, reason:String(args.reason||'').slice(0,150), at:now() };
      persist();
      return {ok:true, username:args.username, old_pages:oldPages, new_pages:u.plan.current_daily_pages};
    }
    case 'save_skill': {
      if(!mem.skills) mem.skills=[];
      mem.skills.push({ title:String(args.title||'').slice(0,100), content:String(args.content||'').slice(0,500), tags:args.tags||[], created_at:now() });
      if(mem.skills.length>200) mem.skills=mem.skills.slice(-200);
      return {ok:true, total_skills:mem.skills.length};
    }
    case 'get_global_stats': {
      const users = Object.values(DB.users);
      return {
        total_users: users.length,
        total_sessions: DB.admin?.stats?.total_sessions_today||0,
        total_pages_memorized: DB.admin?.stats?.total_pages_memorized_alltime||0,
        active_today: users.filter(u=>u.progress?.last_session_date===new Date().toISOString().slice(0,10)).length,
        avg_energy: users.length ? (users.reduce((s,u)=>s+(u.energy?.score||75),0)/users.length).toFixed(1) : 0,
      };
    }
    case 'log_insight': {
      if(!mem.insights) mem.insights=[];
      mem.insights.push({ text:String(args.insight||'').slice(0,500), category:args.category||'general', at:now() });
      if(mem.insights.length>500) mem.insights=mem.insights.slice(-500);
      return {ok:true};
    }
    case 'done': {
      return {finished:true, summary:String(args.summary||'').slice(0,500)};
    }
    default: return {error:`unknown_tool: ${toolName}`};
  }
}

/* ─── Main Hermes agentic loop ─── */
async function runHermesAgent(){
  const baseUrl = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  const apiKey  = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  if(!baseUrl || !apiKey){ console.log('[Hermes] AI not configured, skipping.'); return; }

  const mem = readHermesMemory();
  const runId = uid();
  const runStart = Date.now();
  console.log(`[Hermes] Starting agent run ${runId}...`);

  const skillsSummary = (mem.skills||[]).slice(-10).map(s=>`• ${s.title}`).join('\n') || 'لا توجد مهارات بعد';
  const recentInsights = (mem.insights||[]).slice(-5).map(i=>`• [${i.category}] ${i.text}`).join('\n') || 'لا توجد ملاحظات بعد';
  const totalUsers = Object.keys(DB.users).length;

  const systemPrompt = `أنت Hermes Agent، وكيل ذكاء اصطناعي متقدم مخصص لتطبيق "Quantum Quran Coach" لحفظ القرآن الكريم.

وظيفتك: تحليل بيانات المستخدمين بشكل دوري واتخاذ إجراءات ذكية تلقائية لمساعدتهم على الحفظ.

المهارات المكتسبة سابقاً:
${skillsSummary}

الملاحظات السابقة:
${recentInsights}

إحصائيات عامة: ${totalUsers} مستخدم في النظام.

تعليمات العمل:
1. ابدأ بمسح المستخدمين (scan_users) لتحديد من يحتاج تدخل
2. حلّل كل مستخدم مشكل بعمق (get_user_details)
3. اتخذ إجراءات ملموسة: أرسل إشعارات تحفيزية، عدّل الخطط
4. سجّل ما تعلّمته (save_skill, log_insight)
5. أنهِ بملخص واضح (done)

الحد الأقصى: 15 استدعاء أدوات لكل دورة. الردود بالعربية.`;

  const messages = [
    { role:'system', content:systemPrompt },
    { role:'user',   content:`ابدأ دورة التحليل رقم ${(mem.stats?.total_runs||0)+1}. الوقت الحالي: ${new Date().toLocaleString('ar-SA')}.` }
  ];

  let toolCallCount = 0;
  const MAX_TOOL_CALLS = 15;
  let finished = false;
  let runSummary = '';

  while(toolCallCount < MAX_TOOL_CALLS && !finished){
    let resp;
    try {
      resp = await fetch(`${baseUrl}/chat/completions`,{
        method:'POST',
        headers:{'Authorization':`Bearer ${apiKey}`,'Content-Type':'application/json'},
        body: JSON.stringify({
          model:'gpt-4o-mini',
          messages,
          tools: HERMES_TOOLS,
          tool_choice:'auto',
          max_completion_tokens:1000,
        })
      });
    } catch(e){ console.error('[Hermes] API error',e.message); break; }

    if(!resp.ok){ console.error('[Hermes] API HTTP error',resp.status); break; }
    const data = await resp.json();
    const msg = data.choices?.[0]?.message;
    if(!msg) break;

    messages.push(msg);

    if(!msg.tool_calls || msg.tool_calls.length===0){
      console.log('[Hermes] Agent finished (no tool calls).');
      runSummary = msg.content || 'تمت الدورة';
      finished = true;
      break;
    }

    /* Execute all tool calls */
    for(const tc of msg.tool_calls){
      toolCallCount++;
      const toolName = tc.function?.name;
      let args={};
      try { args = JSON.parse(tc.function?.arguments||'{}'); } catch{}
      console.log(`[Hermes] Tool call #${toolCallCount}: ${toolName}(${JSON.stringify(args).slice(0,80)})`);
      let result;
      try { result = await executeHermesTool(toolName, args, mem); } catch(e){ result={error:e.message}; }
      if(toolName==='done'){ runSummary = result.summary||''; finished=true; }
      messages.push({
        role:'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(result)
      });
    }
  }

  /* Save run record */
  if(!mem.runs) mem.runs=[];
  if(!mem.stats) mem.stats={total_runs:0,total_tool_calls:0,users_helped:0};
  mem.stats.total_runs++;
  mem.stats.total_tool_calls += toolCallCount;
  mem.last_run = now();
  mem.runs.push({ id:runId, at:now(), tool_calls:toolCallCount, summary:runSummary, duration_ms:Date.now()-runStart });
  if(mem.runs.length>100) mem.runs=mem.runs.slice(-100);
  writeHermesMemory(mem);
  console.log(`[Hermes] Run ${runId} complete. ${toolCallCount} tool calls. Duration: ${((Date.now()-runStart)/1000).toFixed(1)}s`);
}

/* ─── Hermes Admin Endpoints ─── */
R('GET','/qqc/admin/hermes/status', async(req,res)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const mem = readHermesMemory();
  send(res,200,{
    status:'active',
    last_run:mem.last_run,
    stats:mem.stats,
    recent_runs:(mem.runs||[]).slice(-10).reverse(),
    recent_insights:(mem.insights||[]).slice(-20).reverse(),
    skills_count:(mem.skills||[]).length,
  });
});

R('GET','/qqc/admin/hermes/skills', async(req,res)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const mem = readHermesMemory();
  send(res,200,{ skills:(mem.skills||[]).slice().reverse() });
});

R('POST','/qqc/admin/hermes/run-now', async(req,res)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  send(res,200,{ok:true, message:'تشغيل Hermes Agent في الخلفية...'});
  setImmediate(()=>runHermesAgent().catch(e=>console.error('[Hermes] Manual run error',e.message)));
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
      const raw = (reply.includes('{') ? '{' : '') + reply.split('{').slice(1).join('{');
      const match = ('{'+raw).match(/\{[\s\S]*?\}/);
      if(!match) return;
      const suggested = JSON.parse(match[0]);
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
  const baseUrl = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  const apiKey  = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
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
const LOGS_DIR = path.join(ROOT, '..', 'logs');

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
أفضل سلسلة: ${prog.best_streak_days||0} يوم
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

  const baseUrl = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  const apiKey  = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  if (!baseUrl||!apiKey) return send(res,503,{error:'ai_not_configured', reply:'عذراً، الذكاء الاصطناعي غير متاح حالياً.'});

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
    const resp = await fetch(`${baseUrl}/chat/completions`,{
      method:'POST',
      headers:{'Authorization':`Bearer ${apiKey}`,'Content-Type':'application/json'},
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages:[{role:'system',content:systemPrompt},{role:'user',content:question}],
        max_completion_tokens: 600,
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
