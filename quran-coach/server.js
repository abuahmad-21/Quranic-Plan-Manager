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

/* ══ Auth helpers ══ */
const SESSIONS = new Map(); // token → username
function authUser(req){
  const t = req.headers['x-token'], u = req.headers['x-username'];
  if (!t || !u) return null;
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
R('POST','/api/auth/register', async (req,res)=>{
  const b = await readBody(req);
  const u = String(b.username||'').toLowerCase().trim();
  const p = String(b.password||'');
  if (!/^[a-z0-9_]{3,20}$/.test(u) || p.length<4) return send(res,400,{error:'invalid_input'});
  if (DB.users[u]) return send(res,409,{error:'username_taken'});
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
    voice_permissions_granted:[], // usernames I allow to send me voice
    notifications:[],
    posts:[],   // user posts (text/image refs only — actual blobs in client)
  };
  DB.admin.stats.total_users = Object.keys(DB.users).length;
  persist();
  const tok = token(); SESSIONS.set(tok,u);
  send(res,200,{ok:true, token:tok, username:u});
});

R('POST','/api/auth/login', async (req,res)=>{
  const b = await readBody(req);
  const u = String(b.username||'').toLowerCase().trim();
  const user = DB.users[u];
  if (!user || user.password_hash !== sha(String(b.password||''))) return send(res,401,{error:'bad_credentials'});
  if (user.is_banned) return send(res,403,{error:'banned'});
  user.last_active = now(); persist();
  const tok = token(); SESSIONS.set(tok,u);
  send(res,200,{ok:true, token:tok, username:u});
});

R('POST','/api/auth/logout', async (req,res)=>{
  const t = req.headers['x-token']; if (t) SESSIONS.delete(t);
  send(res,200,{ok:true});
});

R('GET','/api/auth/check-username', async (req,res,_,q)=>{
  const u = String(q.username||'').toLowerCase().trim();
  if (!/^[a-z0-9_]{3,20}$/.test(u)) return send(res,200,{available:false,reason:'invalid'});
  if (DB.users[u]) return send(res,200,{available:false,reason:'taken'});
  send(res,200,{available:true});
});

/* ── ONBOARDING & PROFILE ── */
R('POST','/api/onboarding', async (req,res)=>{
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

R('GET','/api/me', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  // Ensure new fields exist on old users
  if(u.sheikh_verified===undefined) u.sheikh_verified=false;
  if(u.sheikh_requested===undefined) u.sheikh_requested=false;
  send(res,200,{user:safeUser(u)});
});

R('PATCH','/api/me', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const b = await readBody(req);
  if (typeof b.display_name==='string') u.display_name=b.display_name.slice(0,40);
  if (typeof b.bio==='string') u.bio=b.bio.slice(0,300);
  if (typeof b.avatar_color==='string' && /^#[0-9a-f]{6}$/i.test(b.avatar_color)) u.avatar_color=b.avatar_color;
  if (typeof b.avatar_emoji==='string') u.avatar_emoji=b.avatar_emoji.slice(0,8)||null;
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

R('GET','/api/profile/:username', async (req,res,p)=>{
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
R('POST','/api/process-state', async (req,res)=>{
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
R('POST','/api/session/complete', async (req,res)=>{
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

R('GET','/api/plan', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const preview = AI.PlanAdapter.preview(u, 30);
  const rec = AI.PlanAdapter.recompute(u);
  send(res,200,{plan:u.plan, preview, recommendation:rec, sr_state:u.sr_state});
});

R('PATCH','/api/plan', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const b = await readBody(req);
  if (typeof b.current_daily_pages==='number') u.plan.current_daily_pages = b.current_daily_pages;
  if (typeof b.manual_override==='boolean') u.plan.manual_override = b.manual_override;
  if (Array.isArray(b.weekly_off_days)) u.plan.weekly_off_days = b.weekly_off_days;
  persist(); send(res,200,{ok:true, plan:u.plan});
});

/* ── POSTS (lightweight: text + optional small thumbnail; large media stays client) ── */
R('POST','/api/posts', async (req,res)=>{
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

R('GET','/api/posts/feed', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const friends = new Set([u.username, ...(u.friends||[])]);
  const items = DB.posts.filter(p=>friends.has(p.author)).slice(-100).reverse();
  send(res,200,{posts:items});
});

R('GET','/api/posts', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const items = DB.posts.slice(-200).reverse();
  send(res,200,{posts:items});
});

R('POST','/api/posts/:id/comment', async (req,res,p)=>{
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

R('POST','/api/posts/:id/like', async (req,res,p)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const post = DB.posts.find(x=>x.id===p.id); if (!post) return send(res,404,{error:'not_found'});
  const i = post.likes.indexOf(u.username);
  if (i<0) post.likes.push(u.username); else post.likes.splice(i,1);
  // mirror in author posts
  const owner = DB.users[post.author];
  if (owner) { const op = owner.posts.find(x=>x.id===p.id); if (op) op.likes = post.likes.slice(); }
  persist(); send(res,200,{ok:true, likes: post.likes.length});
});

R('DELETE','/api/posts/:id', async (req,res,p)=>{
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
R('POST','/api/friends/request', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const b = await readBody(req);
  const target = DB.users[String(b.username||'').toLowerCase()];
  if (!target || target.username===u.username) return send(res,400,{error:'bad_target'});
  if (u.friends.includes(target.username)) return send(res,409,{error:'already_friends'});
  if (!target.friend_requests_received.includes(u.username)) target.friend_requests_received.push(u.username);
  if (!u.friend_requests_sent.includes(target.username)) u.friend_requests_sent.push(target.username);
  persist(); send(res,200,{ok:true});
});

R('POST','/api/friends/accept', async (req,res)=>{
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

R('POST','/api/friends/remove', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const b = await readBody(req);
  const other = DB.users[String(b.username||'').toLowerCase()];
  if (!other) return send(res,404,{error:'not_found'});
  u.friends = u.friends.filter(x=>x!==other.username);
  other.friends = other.friends.filter(x=>x!==u.username);
  persist(); send(res,200,{ok:true});
});

R('GET','/api/friends', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  send(res,200,{
    friends: u.friends.map(n=>{const f=DB.users[n]; return f?{username:f.username,display_name:f.display_name,avatar_color:f.avatar_color,last_active:f.last_active}:{username:n};}),
    requests_received: u.friend_requests_received,
    requests_sent: u.friend_requests_sent,
  });
});

R('GET','/api/users/search', async (req,res,_,q)=>{
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

R('GET','/api/chat/:username', async (req,res,p)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const other = p.username; if (!DB.users[other]) return send(res,404,{error:'not_found'});
  const id = chatId(u.username, other);
  const c = DB.chats[id] || {participants:[u.username,other], messages:[], last_message_at:null};
  send(res,200,{chat:c});
});

R('POST','/api/chat/:username', async (req,res,p)=>{
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

R('GET','/api/chats', async (req,res)=>{
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
R('POST','/api/voice/permit', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const b = await readBody(req);
  const friend = String(b.username||'').toLowerCase();
  if (!DB.users[friend]) return send(res,404,{error:'not_found'});
  if (!u.friends.includes(friend)) return send(res,403,{error:'not_friend'});
  if (!u.voice_permissions_granted.includes(friend)) u.voice_permissions_granted.push(friend);
  persist(); send(res,200,{ok:true});
});

R('POST','/api/voice/revoke', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const b = await readBody(req);
  u.voice_permissions_granted = u.voice_permissions_granted.filter(x=>x!==String(b.username||'').toLowerCase());
  persist(); send(res,200,{ok:true});
});

/* ── GROUPS ── */
R('POST','/api/groups', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const b = await readBody(req);
  const name = String(b.name||'مجموعة').slice(0,40);
  const members = Array.isArray(b.members)?b.members.filter(x=>DB.users[x]):[];
  if (!members.includes(u.username)) members.push(u.username);
  const id = uid();
  DB.groups[id] = { id, name, created_by:u.username, created_at:now(), members, messages:[], last_message_at:null };
  persist(); send(res,200,{ok:true, group:DB.groups[id]});
});

R('GET','/api/groups', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const list = Object.values(DB.groups).filter(g=>g.members.includes(u.username))
    .map(g=>({id:g.id,name:g.name,members:g.members,last:g.messages[g.messages.length-1]||null}));
  send(res,200,{groups:list});
});

R('GET','/api/groups/:id', async (req,res,p)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const g = DB.groups[p.id];
  if (!g || !g.members.includes(u.username)) return send(res,404,{error:'not_found'});
  send(res,200,{group:g});
});

R('POST','/api/groups/:id/message', async (req,res,p)=>{
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

R('POST','/api/groups/:id/add', async (req,res,p)=>{
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
R('GET','/api/support', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const t = DB.support_tickets[u.username] || {messages:[]};
  send(res,200,{ticket:t});
});

R('POST','/api/support', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const b = await readBody(req);
  if (!DB.support_tickets[u.username]) DB.support_tickets[u.username] = {messages:[], opened_at:now()};
  DB.support_tickets[u.username].messages.push({from:u.username, text:String(b.text||'').slice(0,1500), timestamp:now()});
  persist(); send(res,200,{ok:true});
});

/* ── BROADCAST (read by all users) ── */
R('GET','/api/broadcast', async (req,res)=>{
  const active = (DB.admin.broadcast_messages||[]).filter(m=>m.active);
  send(res,200,{messages: active.slice(-3)});
});

/* ── DATA ── */
R('GET','/api/data/surahs',     async (_,res)=>send(res,200,{surahs:SURAHS}));
R('GET','/api/data/techniques', async (_,res)=>send(res,200,{techniques:TECHS}));
R('GET','/api/data/alerts',     async (_,res)=>send(res,200,{alerts:ALERTS}));

/* ── LEADERBOARD ── */
R('GET','/api/leaderboard', async (req,res)=>{
  const top = Object.values(DB.users)
    .filter(u=>!u.is_banned)
    .map(u=>({username:u.username, display_name:u.display_name, avatar_color:u.avatar_color, pages:u.progress.total_pages_memorized||0, streak:u.progress.current_streak_days||0}))
    .sort((a,b)=>b.pages-a.pages).slice(0,50);
  send(res,200,{leaderboard:top});
});

/* ══════════════════════════════════════════════
   ADMIN ROUTES
══════════════════════════════════════════════ */
R('POST','/api/admin/login', async (req,res)=>{
  const b = await readBody(req);
  if (sha(String(b.password||'')) !== DB.admin.password_hash) return send(res,401,{error:'bad_password'});
  send(res,200,{ok:true});
});

R('GET','/api/admin/overview', async (req,res)=>{
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

R('GET','/api/admin/users', async (req,res)=>{
  if (!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  send(res,200,{users: Object.values(DB.users).map(u=>({
    username:u.username, display_name:u.display_name, created_at:u.created_at,
    last_active:u.last_active, is_banned:u.is_banned,
    pages:u.progress.total_pages_memorized, streak:u.progress.current_streak_days,
    sessions:u.progress.total_sessions_completed
  }))});
});

R('POST','/api/admin/user/:username/ban', async (req,res,p)=>{
  if (!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const u = DB.users[p.username]; if (!u) return send(res,404,{error:'not_found'});
  u.is_banned = true; persist(); send(res,200,{ok:true});
});

R('POST','/api/admin/user/:username/unban', async (req,res,p)=>{
  if (!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const u = DB.users[p.username]; if (!u) return send(res,404,{error:'not_found'});
  u.is_banned = false; persist(); send(res,200,{ok:true});
});

R('DELETE','/api/admin/user/:username', async (req,res,p)=>{
  if (!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  if (!DB.users[p.username]) return send(res,404,{error:'not_found'});
  delete DB.users[p.username];
  DB.posts = DB.posts.filter(x=>x.author!==p.username);
  delete DB.support_tickets[p.username];
  persist(); send(res,200,{ok:true});
});

R('DELETE','/api/admin/post/:id', async (req,res,p)=>{
  if (!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const idx = DB.posts.findIndex(x=>x.id===p.id);
  if (idx<0) return send(res,404,{error:'not_found'});
  const post = DB.posts.splice(idx,1)[0];
  const owner = DB.users[post.author];
  if (owner) owner.posts = owner.posts.filter(x=>x.id!==p.id);
  persist(); send(res,200,{ok:true});
});

R('GET','/api/admin/posts', async (req,res)=>{
  if (!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  send(res,200,{posts: DB.posts.slice(-200).reverse()});
});

R('GET','/api/admin/chats', async (req,res)=>{
  if (!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const list = Object.entries(DB.chats).map(([id,c])=>({
    id, participants:c.participants, last:c.messages[c.messages.length-1]||null, count:c.messages.length
  })).sort((a,b)=>(b.last?.timestamp||'').localeCompare(a.last?.timestamp||''));
  send(res,200,{chats:list});
});

R('GET','/api/admin/chat/:id', async (req,res,p)=>{
  if (!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const c = DB.chats[p.id]; if (!c) return send(res,404,{error:'not_found'});
  send(res,200,{chat:c});
});

R('DELETE','/api/admin/chat/:id/message/:mid', async (req,res,p)=>{
  if (!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const c = DB.chats[p.id]; if (!c) return send(res,404,{error:'not_found'});
  c.messages = c.messages.filter(m=>m.id!==p.mid);
  persist(); send(res,200,{ok:true});
});

R('GET','/api/admin/tickets', async (req,res)=>{
  if (!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  send(res,200,{tickets: Object.entries(DB.support_tickets).map(([u,t])=>({user:u,messages:t.messages,opened_at:t.opened_at}))});
});

R('POST','/api/admin/tickets/:user/reply', async (req,res,p)=>{
  if (!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const b = await readBody(req);
  if (!DB.support_tickets[p.user]) DB.support_tickets[p.user] = {messages:[], opened_at:now()};
  DB.support_tickets[p.user].messages.push({from:'admin', text:String(b.text||'').slice(0,2000), timestamp:now()});
  addNotif(p.user,'support_reply','💬 رد من فريق الدعم: '+String(b.text||'').slice(0,60),'view-support');
  persist(); send(res,200,{ok:true});
});

R('POST','/api/admin/broadcast', async (req,res)=>{
  if (!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const b = await readBody(req);
  const m = {id:uid(), message:String(b.message||'').slice(0,500), sent_at:now(), sent_by:'admin', active:true};
  DB.admin.broadcast_messages.push(m);
  if (DB.admin.broadcast_messages.length>50) DB.admin.broadcast_messages = DB.admin.broadcast_messages.slice(-50);
  persist(); send(res,200,{ok:true, message:m});
});

R('PATCH','/api/admin/broadcast/:id', async (req,res,p)=>{
  if (!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const m = DB.admin.broadcast_messages.find(x=>x.id===p.id);
  if (!m) return send(res,404,{error:'not_found'});
  const b = await readBody(req);
  if (typeof b.active==='boolean') m.active = b.active;
  persist(); send(res,200,{ok:true});
});

R('PATCH','/api/admin/weights', async (req,res)=>{
  if (!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const b = await readBody(req);
  Object.assign(DB.admin.algorithm_weights, b);
  persist(); send(res,200,{ok:true, weights: DB.admin.algorithm_weights});
});

R('POST','/api/admin/quote', async (req,res)=>{
  if (!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const b = await readBody(req);
  const q = {id:uid(), text_ar:String(b.text_ar||'').slice(0,400), category:b.category||'motivation', active:true, added_at:now()};
  DB.admin.quotes.push(q); persist(); send(res,200,{ok:true,quote:q});
});

R('DELETE','/api/admin/quote/:id', async (req,res,p)=>{
  if (!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  DB.admin.quotes = DB.admin.quotes.filter(q=>q.id!==p.id);
  persist(); send(res,200,{ok:true});
});

R('GET','/api/admin/groups', async (req,res)=>{
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
R('POST','/api/sheikh-request', async (req,res)=>{
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

R('GET','/api/sheikh-request/status', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const req2 = DB.admin.sheikh_requests[u.username]||null;
  send(res,200,{verified:u.sheikh_verified, requested:u.sheikh_requested, request:req2});
});

R('GET','/api/admin/sheikh-requests', async (req,res)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  send(res,200,{requests: Object.values(DB.admin.sheikh_requests)});
});

R('POST','/api/admin/sheikh-requests/:username/approve', async (req,res,p)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const u = DB.users[p.username]; if(!u) return send(res,404,{error:'not_found'});
  u.sheikh_verified = true;
  u.sheikh_requested = false;
  if(DB.admin.sheikh_requests[p.username]) DB.admin.sheikh_requests[p.username].status='approved';
  addNotif(p.username,'sheikh_approved','🏅 تهانينا! تمت الموافقة على طلبك وأصبحت شيخاً مُعتمداً. يمكنك الآن إنشاء شُعبتك.','view-channels');
  persist(); send(res,200,{ok:true});
});

R('POST','/api/admin/sheikh-requests/:username/reject', async (req,res,p)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const b = await readBody(req);
  const u = DB.users[p.username];
  if(u){ u.sheikh_requested = false; }
  if(DB.admin.sheikh_requests[p.username]) DB.admin.sheikh_requests[p.username].status='rejected';
  addNotif(p.username,'sheikh_rejected','❌ عذراً، لم تُوافَق على طلب الشيخ في هذه المرة. '+(b.reason||''),'view-support');
  persist(); send(res,200,{ok:true});
});

/* ── MEMORIZATION PLANS (admin-created, public) ── */
R('GET','/api/plans', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  send(res,200,{plans: (DB.admin.memorization_plans||[])});
});

R('POST','/api/admin/plans', async (req,res)=>{
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

R('DELETE','/api/admin/plans/:id', async (req,res,p)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  DB.admin.memorization_plans=(DB.admin.memorization_plans||[]).filter(x=>x.id!==p.id);
  persist(); send(res,200,{ok:true});
});

/* ── AI PLAN GENERATOR ── */
R('POST','/api/plan/generate', async (req,res)=>{
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
R('POST','/api/channels', async (req,res)=>{
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

R('GET','/api/channels', async (req,res)=>{
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

R('GET','/api/channels/discover', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const open = Object.values(DB.channels)
    .filter(c=>c.is_public && !c.members.includes(u.username) && c.members.length < c.max_members)
    .slice(0,50)
    .map(c=>({id:c.id,name:c.name,description:c.description,member_count:c.members.length,max_members:c.max_members,sheikh_username:c.sheikh_username}));
  send(res,200,{channels:open});
});

R('POST','/api/channels/join', async (req,res)=>{
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

R('GET','/api/channels/:id', async (req,res,p)=>{
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

R('POST','/api/channels/:id/message', async (req,res,p)=>{
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

R('POST','/api/channels/:id/announce', async (req,res,p)=>{
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

R('PATCH','/api/channels/:id', async (req,res,p)=>{
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

R('DELETE','/api/channels/:id/member/:username', async (req,res,p)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const ch = DB.channels[p.id];
  if(!ch || ch.sheikh_username!==u.username) return send(res,403,{error:'not_sheikh'});
  if(p.username===u.username) return send(res,400,{error:'cannot_remove_self'});
  ch.members=ch.members.filter(m=>m!==p.username);
  persist(); send(res,200,{ok:true});
});

R('POST','/api/channels/:id/invite-token', async (req,res,p)=>{
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

R('GET','/api/channels/:id/invites', async (req,res,p)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const ch = DB.channels[p.id];
  if(!ch || ch.sheikh_username!==u.username) return send(res,403,{error:'not_sheikh'});
  send(res,200,{invites:(ch.invite_tokens||[]).slice().reverse()});
});

R('DELETE','/api/channels/:id/invite/:token', async (req,res,p)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const ch = DB.channels[p.id];
  if(!ch || ch.sheikh_username!==u.username) return send(res,403,{error:'not_sheikh'});
  ch.invite_tokens=(ch.invite_tokens||[]).filter(t=>t.token!==p.token);
  persist(); send(res,200,{ok:true});
});

R('POST','/api/channels/:id/plan-template', async (req,res,p)=>{
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
R('POST','/api/channels/:id/review-session', async (req,res,p)=>{
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

R('POST','/api/channels/:id/review-session/:sid/log', async (req,res,p)=>{
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

R('DELETE','/api/channels/:id/review-session/:sid', async (req,res,p)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const ch = DB.channels[p.id];
  if(!ch || ch.sheikh_username!==u.username) return send(res,403,{error:'not_sheikh'});
  const s = (ch.review_sessions||[]).find(x=>x.id===p.sid);
  if(s) s.is_active=false;
  persist(); send(res,200,{ok:true});
});

R('POST','/api/channels/:id/leave', async (req,res,p)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  const ch = DB.channels[p.id];
  if(!ch || !ch.members.includes(u.username)) return send(res,404,{error:'not_found'});
  if(ch.sheikh_username===u.username) return send(res,400,{error:'sheikh_cannot_leave'});
  ch.members=ch.members.filter(m=>m!==u.username);
  persist(); send(res,200,{ok:true});
});

/* ── NOTIFICATIONS ── */
R('GET','/api/notifications', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  if(!u.notifications) u.notifications=[];
  const notifs = u.notifications.slice().reverse().slice(0,50);
  send(res,200,{notifications:notifs, unread:u.notifications.filter(n=>!n.read).length});
});

R('POST','/api/notifications/read-all', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  (u.notifications||[]).forEach(n=>n.read=true);
  persist(); send(res,200,{ok:true});
});

/* ── AI COACH ── */
R('POST','/api/ai-coach', async (req,res)=>{
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
R('POST','/api/ai/evaluate-recitation', async (req,res)=>{
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
R('POST','/api/ai/transcribe', async (req,res)=>{
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
R('POST','/api/ai/tts', async (req,res)=>{
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

R('POST','/api/ai/save-training', async (req,res)=>{
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

R('GET','/api/admin/training-data', async (req,res)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  const samples=(DB.admin.training_samples||[]).slice().reverse();
  const good=samples.filter(s=>s.quality==='good').length;
  const fair=samples.filter(s=>s.quality==='fair').length;
  const poor=samples.filter(s=>s.quality==='poor').length;
  send(res,200,{samples:samples.slice(0,500),total:samples.length,stats:{good,fair,poor}});
});

R('GET','/api/admin/training-data/:id/audio', async (req,res,p)=>{
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
R('GET','/api/studio/recordings', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  send(res,200,{ recordings: (u.studio_history||[]).slice().reverse().slice(0,50) });
});

R('POST','/api/studio/recording', async (req,res)=>{
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
R('GET','/api/studio/progress', async (req,res)=>{
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
R('GET','/api/admin/channels', async (req,res)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  send(res,200,{channels: Object.values(DB.channels).map(c=>({
    id:c.id,name:c.name,sheikh_username:c.sheikh_username,
    member_count:c.members.length,message_count:c.messages.length,
    announcement_count:c.announcements.length,join_code:c.join_code,
    is_public:c.is_public,max_members:c.max_members,
    created_at:c.created_at,last_message_at:c.last_message_at
  }))});
});

R('GET','/api/admin/channels/:id', async (req,res,p)=>{
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

R('DELETE','/api/admin/channels/:id', async (req,res,p)=>{
  if(!isAdmin(req)) return send(res,401,{error:'admin_auth'});
  if(!DB.channels[p.id]) return send(res,404,{error:'not_found'});
  delete DB.channels[p.id];
  persist(); send(res,200,{ok:true});
});

R('POST','/api/admin/direct-message/:username', async (req,res,p)=>{
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
  if (req.method==='OPTIONS') return send(res,204,null);
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname || '/';

  if (pathname.startsWith('/api/')) {
    const route = matchRoute(req.method, pathname);
    if (!route) return send(res,404,{error:'route_not_found', path:pathname});
    try { await route.fn(req,res,route.params,parsed.query); }
    catch(e){ console.error('route error',e); send(res,500,{error:'internal',detail:String(e.message)}); }
    return;
  }
  serveStatic(req,res,pathname);
});

server.listen(PORT, ()=>{
  console.log(`Quantum Quran Coach running on http://localhost:${PORT}`);
  console.log(`Admin password (default): admin123  →  set via ADMIN_PASSWORD or db.json`);

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
R('POST','/api/tarteel/log', async (req,res)=>{
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
R('GET','/api/tarteel/history', async (req,res)=>{
  const u = authUser(req); if(!u) return send(res,401,{error:'auth'});
  send(res,200,{history: (u.tarteel_history||[]).slice().reverse().slice(0,50)});
});
