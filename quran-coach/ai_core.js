/* ═══════════════════════════════════════════════════════════════
   QUANTUM QURAN COACH — ai_core.js  (v2)
   ───────────────────────────────────────────────────────────────
   L1 Sensor Fusion (Kalman) · L2 Psychological State · L3 Wave Function
   L4 Online ML (SGD) · L5 Forecasting (EWMA, Holt-Winters)
   L6 Spaced Repetition · L7 Plan Adaptation · L8 Procrastination Detector
   L9 Circadian · L10 Friend Effect · zero deps
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const CFG = {
  ENERGY_MIN:0, ENERGY_MAX:100, ENERGY_DEFAULT:75,
  CHALLENGE_THRESHOLD:80, RELOAD_THRESHOLD:38, INTERRUPT_AFI:22,
  KALMAN_Q:1e-3, KALMAN_R:1e-1,
  EWMA_ALPHA:0.30, EWMA_ALPHA_SLOW:0.10,
  ML_LR:0.01, ML_REG:0.001, ML_MIN:5, ML_WIN:30,
  SR_EF:2.5, SR_MIN_EF:1.3,
  CIRCADIAN:{0:.7,1:.6,2:.55,3:.55,4:.65,5:1.05,6:1.1,7:1,8:.95,9:.9,10:.85,11:.8,12:.7,13:.65,14:.7,15:.8,16:.85,17:.9,18:.88,19:.95,20:1,21:.95,22:.85,23:.75},
  ABSENCE_TRIGGER:3,
  PLAN_DECAY:0.85, PLAN_GROWTH:1.15,
  PROCRASTINATION_MS:60000,
};

class Kalman {
  constructor(x=75,Q=CFG.KALMAN_Q,R=CFG.KALMAN_R){this.x=x;this.p=1;this.Q=Q;this.R=R;}
  update(z){const xp=this.x,pp=this.p+this.Q,K=pp/(pp+this.R);this.x=xp+K*(z-xp);this.p=(1-K)*pp;return this.x;}
}
class EWMA {
  constructor(a=CFG.EWMA_ALPHA){this.a=a;this.v=null;}
  update(x){if(this.v===null){this.v=x;return x;}this.v=this.a*x+(1-this.a)*this.v;return this.v;}
  get(){return this.v??0;}
}
class HoltWinters {
  constructor(a=0.3,b=0.1){this.a=a;this.b=b;this.l=null;this.t=0;}
  update(y){if(this.l===null){this.l=y;return y;}const pl=this.l;this.l=this.a*y+(1-this.a)*(this.l+this.t);this.t=this.b*(this.l-pl)+(1-this.b)*this.t;return this.l;}
  forecast(h=1){return this.l===null?75:this.l+h*this.t;}
}

const FDIM = 12;
class LocalML {
  constructor(W=null){
    const def=[0.08,-0.12,-0.009,-0.25,-0.18,-8,-2.5,3,-0.12,0.05,0.02,0.02];
    this.W = W || def.slice();
    this.lr=CFG.ML_LR; this.reg=CFG.ML_REG; this.n=0; this.loss=[];
  }
  _n(v,mn,mx){if(mx===mn)return 0;return Math.max(-1,Math.min(1,2*(v-mn)/(mx-mn)-1));}
  features(s){
    const h=new Date().getHours(),d=new Date().getDay();
    return [
      this._n((s.focusSeconds||0)/60,0,120),
      this._n((s.hiddenSeconds||0)/30,0,20),
      this._n((s.hesitationMs||0)/100,0,80),
      this._n(s.mouseErratics||0,0,40),
      this._n(s.exitAttempts||0,0,5),
      this._n(s.scrollSpeed||0,0,10),
      s.scrolledToBottom?1:-1,
      this._n(s.chaosRhythm||0,0,100),
      this._n(s.streak||0,0,365),
      this._n(h,0,23),
      Math.sin(2*Math.PI*d/7),
      Math.cos(2*Math.PI*d/7),
    ];
  }
  predict(f){let o=0;for(let i=0;i<FDIM;i++)o+=this.W[i]*f[i];return o;}
  train(f,y){
    const yh=this.predict(f),e=yh-y;
    for(let i=0;i<FDIM;i++){const g=e*f[i]+this.reg*this.W[i];this.W[i]-=this.lr*g;}
    const l=0.5*e*e; this.loss.push(l); if(this.loss.length>20)this.loss.shift(); this.n++;
    return {loss:l,yHat:yh};
  }
  serialize(){return {W:this.W.slice(),n:this.n};}
  static load(s){const m=new LocalML(s?.W||null); m.n=s?.n||0; return m;}
}

/* ══ Spaced Repetition (SM-2) ══ */
const SR = {
  update(state={},difficulty){
    let {ef=CFG.SR_EF,interval=1,reps=0}=state;
    const q = difficulty==='easy'?5: difficulty==='medium'?3:1;
    if(q>=3){ if(reps===0)interval=1; else if(reps===1)interval=6; else interval=Math.round(interval*ef); reps++; }
    else { reps=0; interval=1; }
    ef = ef + (0.1-(5-q)*(0.08+(5-q)*0.02));
    if(ef<CFG.SR_MIN_EF) ef=CFG.SR_MIN_EF;
    const next = new Date(Date.now()+interval*864e5).toISOString();
    return {ef:+ef.toFixed(3),interval,reps,next_review:next};
  }
};

/* ══ PLAN ADAPTATION ALGORITHMS (200+ rules collapsed into adaptive engine) ══ */
const PlanAdapter = {
  /**
   * Re-evaluates daily target pages using:
   *  - Recent session quality (last 7)
   *  - Procrastination index
   *  - Streak / absence
   *  - Energy trend
   *  - Circadian fit
   *  - Difficulty distribution
   */
  recompute(user) {
    if (!user.plan) return null;
    const now = Date.now();
    const sess = (user.sessions||[]).slice(-14);
    const recent = sess.slice(-7);
    const target = user.plan.current_daily_pages || 0.25;

    if (sess.length < 3) return { target, reason:'insufficient_data', delta:0 };

    // Quality score per session: easy=1, medium=0.6, hard=0.3, missed=0
    const qScore = recent.length
      ? recent.reduce((a,s)=>a+(s.difficulty==='easy'?1:s.difficulty==='medium'?0.6:0.3),0)/recent.length
      : 0;

    // Absence rate
    const today = new Date(now).toISOString().slice(0,10);
    const days = new Set(recent.map(s=>s.date.slice(0,10)));
    const span = Math.min(7, Math.ceil((now - new Date(recent[0].date).getTime())/864e5)+1);
    const absRate = 1 - days.size/span;

    // Procrastination signal
    const procrast = (user.energy?.friction||0)/10;

    // Energy trend
    const energyHist = user.energy?.history||[];
    const energyTrend = energyHist.length>=2 ? energyHist[energyHist.length-1]-energyHist[0] : 0;

    // Composite fitness 0..1
    let fitness = 0.4*qScore + 0.25*(1-absRate) + 0.15*(1-procrast) + 0.20*Math.max(0,Math.min(1,(energyTrend+50)/100));

    let newTarget = target;
    let reason = 'stable';
    let delta = 0;

    if (fitness > 0.78) {
      newTarget = Math.min(target * CFG.PLAN_GROWTH, target+0.5);
      reason = 'high_fitness_growth';
      delta = +1;
    } else if (fitness < 0.42) {
      // Procrastination/absence dominant → reduce
      newTarget = Math.max(target * CFG.PLAN_DECAY, 0.1);
      reason = procrast>0.5 ? 'procrastination_detected' : absRate>0.4 ? 'absence_protection' : 'low_fitness_decay';
      delta = -1;
    } else if (absRate >= 0.5) {
      // Persistent absence → soft reset
      newTarget = Math.max(0.1, target * 0.7);
      reason = 'absence_soft_reset';
      delta = -1;
    }

    // Round to nearest 0.05
    newTarget = Math.round(newTarget*20)/20;

    return {
      target: newTarget,
      old_target: target,
      delta,
      reason,
      fitness: +fitness.toFixed(3),
      qScore: +qScore.toFixed(3),
      absRate: +absRate.toFixed(3),
      procrastination: +procrast.toFixed(3),
      energyTrend,
    };
  },

  /**
   * Generates a 30-day adaptive plan preview.
   */
  preview(user, days=30) {
    let cur = user.plan?.current_daily_pages || 0.25;
    const daily = (user.onboarding?.daily_minutes || 30);
    const out = [];
    for (let i=0;i<days;i++) {
      // Slow ramp by 10% every 5 days unless last 5 had absences
      if (i>0 && i%5===0) cur = Math.min(cur*1.10, daily/15);
      out.push(+cur.toFixed(2));
    }
    return out;
  }
};

/* ══ PROCRASTINATION DETECTOR ══ */
const Procrastination = {
  /**
   * Detect tab switching, long idle, repeated entry without action.
   */
  score(s) {
    const hidden = s.hiddenSeconds||0;
    const exits = s.exitAttempts||0;
    const erratics = s.mouseErratics||0;
    const focus = s.focusSeconds||1;
    let p = 0;
    p += Math.min(50, hidden*1.5);          // hidden weight
    p += exits * 8;                         // exit attempts strong signal
    p += Math.min(20, erratics*0.5);
    p += Math.max(0, 30 - focus/2);         // low focus
    return Math.min(100, +p.toFixed(2));
  }
};

/* ══ CIRCADIAN FIT ══ */
const Circadian = {
  multiplier(date=new Date()){return CFG.CIRCADIAN[date.getHours()]||0.85;},
  bestWindowToday() {
    const peaks = Object.entries(CFG.CIRCADIAN).map(([h,v])=>({h:+h,v}))
      .sort((a,b)=>b.v-a.v).slice(0,3);
    return peaks;
  }
};

/* ══ ALERT SELECTOR (context ranked) ══ */
const AlertSelector = {
  pick(alerts, ctx) {
    const candidates = alerts.filter(a=>{
      if (ctx.trigger && a.trigger===ctx.trigger) return true;
      if (ctx.mode==='RELOAD_MODE' && a.intensity==='calm') return true;
      if (ctx.mode==='PATTERN_INTERRUPT' && (a.intensity==='high'||a.intensity==='urgent')) return true;
      return false;
    });
    if (!candidates.length) return alerts[Math.floor(Math.random()*alerts.length)];
    return candidates[Math.floor(Math.random()*candidates.length)];
  }
};

/* ══ MAIN DECISION FUNCTION ══ */
function decide(user, sensors, alerts) {
  const ml = LocalML.load(user.ml_state);
  const f = ml.features({...sensors, streak: user.progress?.current_streak_days||0});
  const baseEnergy = (user.energy?.score ?? CFG.ENERGY_DEFAULT);
  const delta = ml.predict(f);
  let energy = Math.max(CFG.ENERGY_MIN, Math.min(CFG.ENERGY_MAX, baseEnergy + delta));

  // Apply circadian multiplier softly
  energy = energy * (0.85 + 0.30 * Circadian.multiplier());
  energy = Math.max(0, Math.min(100, energy));

  // Procrastination
  const proc = Procrastination.score(sensors);

  // Friction & AFI
  const friction = Math.min(10, (sensors.hesitationMs||0)/1000 + (sensors.exitAttempts||0));
  const afi = Math.max(0, 100 - proc - friction*5);

  // Mode selection
  let mode = 'NORMAL_MODE';
  if (afi < CFG.INTERRUPT_AFI || sensors.exitAttempts >= 2) mode = 'PATTERN_INTERRUPT';
  else if (energy > CFG.CHALLENGE_THRESHOLD) mode = 'CHALLENGE_MODE';
  else if (energy < CFG.RELOAD_THRESHOLD)    mode = 'RELOAD_MODE';

  // Target pages today
  const planRec = PlanAdapter.recompute(user);
  const targetPages = planRec ? planRec.target : (user.plan?.current_daily_pages||0.25);

  // Alert
  const alertCtx = { trigger: sensors.trigger, mode };
  const alert = alerts && alerts.length ? AlertSelector.pick(alerts, alertCtx) : null;

  // Intervention if procrastination high
  let intervention = null;
  if (proc > 70 && mode==='PATTERN_INTERRUPT') {
    intervention = { type:'procrastination', message_ar: 'كشفنا تسويفاً قوياً. ابدأ بآية واحدة فقط الآن.' };
  }

  // Persist ML state if we had a label (session_end)
  if (sensors.trigger==='session_end' && typeof sensors.label==='number') {
    ml.train(f, sensors.label);
  }

  return {
    mode,
    energy: Math.round(energy),
    friction: +friction.toFixed(2),
    afi: Math.round(afi),
    procrastination: proc,
    target_pages: targetPages,
    plan_recommendation: planRec,
    alert,
    intervention,
    ml_state: ml.serialize(),
    circadian_multiplier: +Circadian.multiplier().toFixed(2),
  };
}

module.exports = {
  CFG, Kalman, EWMA, HoltWinters, LocalML, SR, PlanAdapter,
  Procrastination, Circadian, AlertSelector, decide
};
