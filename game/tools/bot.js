// Headless balance/soak test.
// Usage: node game/tools/bot.js <runs> <difficulties e.g. 0,1,2> <reaction jitter multiplier> [rush=1,2,3[,4,g]] [story=1]
// Requires playwright. Plays full runs with a scripted player and prints win rate, deaths and what hurt the bot.
// rush=… plays the listed Boss 挑戰 fights (picked through the title menu, like a player would) instead of the story;
// add story=1 to run both. Boss numbers that the rush menu does not offer are reported and skipped.
//
// The scripted player only presses/releases inputs; it reads game state to decide. Each frame it:
//  1. lists every threat it can foresee (enemy wind-ups and active hitboxes, projectiles, delayed ground bursts),
//     as boxes in space and time;
//  2. simulates a few candidate inputs (keep going, step left/right/stand, jump, dodge left/right, spirit)
//     over the next ~0.8 s and keeps the cheapest one that takes no damage, delaying dodges until the hit is
//     close so they land as 識破 (perfect dodge) and can be countered;
//  3. otherwise plays offence: attacks only when the stamina left still pays for a dodge and the nearby enemies
//     cannot hit before the swing can be cancelled, charges heavies in long openings, backs off to regenerate,
//     heals when nothing can reach it, and uses 定身術 / 分身術 / 精魄 when they pay off.
// Unknown enemy types (e.g. a future boss) fall back to generic rules from their state names and from the
// timings of the hits they land on the bot.
const {chromium}=require('playwright');
const path=require('path');
const argv=process.argv.slice(2);
const pos=argv.filter(a=>!a.includes('=')),kv=Object.fromEntries(argv.filter(a=>a.includes('=')).map(a=>a.split('=')));
const N=parseInt(pos[0]||'10',10),DIFFS=(pos[1]||'0,1,2').split(',').map(Number),SKILL=parseFloat(pos[2]||'1');
const RUSH=kv.rush?kv.rush.split(',').map(s=>s.trim()).filter(Boolean):null;
const STORY=RUSH?kv.story==='1':kv.story!=='0';
const GENERIC=kv.generic?kv.generic.split(','):[]; // e.g. generic=boss,wave: play that enemy / projectile kind with the unknown-type fallback (tests it)
const URL='file://'+path.resolve(__dirname,'..','index.html');

// ---------------------------------------------------------------- in-page player brain
function installBot(opts){
 const g=__game,GR=g.GROUND,WORLD=3700,GEN=new Set((opts&&opts.generic)||[]);
 const ATK_HS=[.09,.10,.13,.14],ATK_HE=[.19,.21,.25,.40],ATK_DUR=[.34,.36,.42,.66],ATK_ST=[8,8,10,14];
 const HALF={boss:38,crane:42,shield:26,archer:22,brute:34,bat:24,imp:20,golem:55,wolf:38};
 const REACH={boss:270,crane:360,golem:300,brute:240,shield:220,wolf:240,imp:140,bat:220,archer:0};
 const KNOWN={wolf:1,shield:1,archer:1,bat:1,brute:1,imp:1,boss:1,crane:1,golem:1};
 const BOSSY={boss:1,crane:1,golem:1};
 const RX_REC=/recover|stagger|hurt|landed|broken|stun|tired|dizzy|roar|intro|rest|down|frozen/i;
 const RX_WIND=/wind|raise|charge|aim|prep|tell|ready|crouch|sigil|cast|gather|draw|focus|rise/i;
 const RX_ATK=/attack|slash|combo|thrust|lunge|slam|plunge|dash|swing|strike|counter|spin|cleave|stab|bite|leap|dive|smash|heavy|echo|burst/i;
 const sgn=v=>v>0?1:v<0?-1:0,clamp=(v,a,b)=>v<a?a:v>b?b:v;
 const ov=(a,b)=>a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y;
 const ag=()=>1/([1.25,1,.88][g.run?g.run.diff:1]||1);
 const isBossy=e=>!!BOSSY[e.type]||(!!g.boss&&e===g.boss);
 const halfW=e=>e.type==='golem'&&e.rolling?62:(HALF[e.type]||30);
 const reachOf=e=>REACH[e.type]!==undefined?REACH[e.type]:230;
 const alive=e=>e&&!e.dead&&e.state!=='dying'&&e.state!=='dead';
 // f===0: the enemy can still turn before the hit lands, so the box covers both sides
 const front=(e,f,near,far)=>f>0?[e.x+near,far-near]:f<0?[e.x-far,far-near]:[e.x-far,2*far];
 const owned=()=>{const r=g.run;if(!r)return[];if(r.rush||r.ng)return[1,2,3];const o=[];for(let i=1;i<Math.min(4,r.ch);i++)o.push(i);return o;};
 const curSpirit=()=>{const o=owned();if(!o.length)return 0;return o.includes(g.run.spirit)?g.run.spirit:o[o.length-1];};
 const perfWin=()=>.22+([0,0,-.03][g.run?g.run.diff:1]||0)+.04*((g.run&&g.run.up&&g.run.up.parry)||0);
 const busy=P=>{const t=P.t;
  switch(P.state){
   case 'idle':case 'run':case 'jump':return{d:0,m:0};
   case 'attack':{const c=P.combo|0;return{d:Math.max(0,ATK_HE[c]-t),m:Math.max(0,ATK_DUR[c]-t)};}
   case 'charge':return{d:0,m:.7};
   case 'heavy':{const r=Math.max(0,.62-t);return{d:r,m:r};}
   case 'counter':{const r=Math.max(0,.46-t);return{d:r,m:r};}
   case 'air':{const r=Math.max(0,.34-t);return{d:r,m:r};}
   case 'plunge':return{d:.45,m:.45};
   case 'plungeLand':{const r=Math.max(0,.42-t);return{d:r,m:r};}
   case 'hurt':{const r=Math.max(0,.34-t);return{d:r,m:r};}
   case 'heal':{const r=Math.max(0,.85-t);return{d:r,m:r};}
   case 'dodge':{const r=Math.max(0,.36-t);return{d:r,m:r};}
   case 'spirit':{const k=P.spiritKind,e=k===1?.62:k===2?.5:.85;const r=Math.max(0,e-t);return{d:r,m:r};}
   default:return{d:9,m:9};
  }};

 // ---- threats: boxes {bx,by,w,h} active for t0..t1 seconds from now, moving at vx,vy from t0
 // (NaN-safe: unknown enemies may lack fields)
 function T(list,src,bx,by,w,h,t0,t1,o){if(!(t1>=0&&t1>=t0)||!isFinite(bx+by+w+h))return;const th={src,bx,by,w,h,t0:Math.max(0,t0),t1,vx:0,vy:0,melee:false,once:false};if(o)Object.assign(th,o);list.push(th);}
 function enemyThreats(b,e,list){
  const P=g.P,s=e.spd||1,t=e.t,tw=sgn(P.x-e.x)||e.face||1,src=e.type+':'+e.state,M={melee:true,once:true};
  switch(GEN.has(e.type)?'?':e.type){
   case 'wolf':
    if(e.state==='wind'){const [x,w]=front(e,0,-10,174);T(list,src,x,e.y-55,w,50,.48-t,.8-t,M);}
    else if(e.state==='lunge'&&t<.32){const [x,w]=front(e,e.face,-10,70+104*(1-t/.32));T(list,src,x,e.y-55,w,50,0,.32-t,M);}
    break;
   case 'shield':
    if(e.state==='wind'){const [x,w]=front(e,e.face,-5,200);T(list,src,x,e.y-104,w,44,.6-t,.76-t,M);}
    else if(e.state==='thrust'&&t<.16){const [x,w]=front(e,e.face,-5,200);T(list,src,x,e.y-104,w,44,0,.16-t,M);}
    break;
   case 'brute':
    if(e.state==='raise'){const [x,w]=front(e,e.face,-20,200);T(list,src,x,e.y-110,w,110,.9-t,1.05-t,M);
     T(list,'brute>wave',e.x+e.face*150-18,GR-42,36,42,.9-t,1.7-t,{vx:e.face*380});}
    else if(e.state==='slam'&&t<.15){const [x,w]=front(e,e.face,-20,200);T(list,src,x,e.y-110,w,110,0,.15-t,M);}
    break;
   case 'bat':
    if(e.state==='swoopWind'){const tx=P.x+(P.x-e.x)*.9;T(list,src,Math.min(e.x,tx)-20,GR-100,Math.abs(tx-e.x)+40,80,.6-t,1.05-t,M);}
    else if(e.state==='swoop'&&e.tx!==undefined){T(list,src,Math.min(e.x,e.tx)-20,GR-100,Math.abs(e.tx-e.x)+40,80,Math.max(0,.15-t),.6-t,M);}
    break;
   case 'imp':
    if(e.state==='wind')T(list,'imp>burst',e.x-105,GR-80,210,80,.6-t,.72-t,{once:true});
    break;
   case 'archer':
    if(e.state==='aim')T(list,'archer>arrow',e.x+tw*34-14,e.y-68,28,8,.9-t,2.5-t,{vx:tw*640});
    break;
   case 'boss':{
    if(e.state==='slash'){const w=e.wind;
     if(t<w+.17/s){const f=t<w*.8-.03?0:e.face;const [x,ww]=front(e,f,-10,185+280*s*.22);T(list,src,x,e.y-170,ww,170,w-t,w+.17/s-t,M);}
     else if((e.combo||0)<(e.phase===2?2:1)){const t0=(w+.5/s-t)+.3/s;const [x,ww]=front(e,0,-10,185+280*s*.22);T(list,src+'+',x,e.y-170,ww,170,t0,t0+.17/s,M);}}
    else if(e.state==='dash'){
     if(!e.dashStarted)for(const ff of [-1,1])T(list,src,e.x-60,e.y-150,120,150,.55/s-t,.55/s-t+.45,{melee:true,once:true,vx:ff*760*s});
     else if(t<.45)T(list,src,e.x-60,e.y-150,120,150,0,.45-t,{melee:true,once:true,vx:e.face*760*s});}
    else if(e.state==='leap'&&!e.landed){const wind=.4/s,air=.75/s,Tl=wind+air-t,tx=e.tx!==undefined?e.tx:e.x;
     const lx=e.lx!==undefined?e.lx:e.x;
     if(t<wind)T(list,src+'>body',lx-50,GR-150,100,150,Math.max(0,.15-t),wind-t,M);
     for(let k=0;k<1;k+=.08){const a=wind+k*air-t;if(a+.08*air<0)continue;const y=GR-Math.sin((k+.04)*Math.PI)*260;T(list,src+'>body',lx+(tx-lx)*(k+.04)-50,y-150,100,150,a,a+.08*air,M);}
     T(list,src+'>burst',tx-130,GR-80,260,80,Tl,Tl+.12,{once:true});
     T(list,src+'>wave',tx+30-18,GR-42,36,42,Tl,Tl+1.7,{vx:430*s});
     T(list,src+'>wave',tx-30-18,GR-42,36,42,Tl,Tl+1.7,{vx:-430*s});}
    break;}
   case 'golem':{
    if(e.state==='slam'&&t<e.wind+.18){const f=t<e.wind*.85-.03?0:e.face;const [x,w]=front(e,f,10,190);T(list,src,x,e.y-190,w,190,e.wind-t,e.wind+.18-t,M);
     if(!e.landed)for(const ff of f?[f]:[-1,1])T(list,src+'>wave',e.x+ff*190-18,GR-42,36,42,e.wind-t,e.wind-t+1.4,{vx:ff*400*s});}
    else if(e.state==='sweep'&&t<e.wind+.26){const f=t<e.wind*.85-.03?0:e.face;const [x,w]=front(e,f,-20,250);T(list,src,x,e.y-62,w,62,e.wind-t,e.wind+.26-t,M);}
    else if(e.state==='roll'){
     if(!e.rolling)for(const ff of [-1,1])T(list,src,e.x-68,e.y-120,136,120,.7/s-t,.7/s-t+.9,{melee:true,once:true,vx:ff*640*s});
     else T(list,src,e.x-68,e.y-120,136,120,0,.9-t,{melee:true,once:true,vx:e.face*640*s});}
    else if(e.state==='geyser'&&!e.fired){const f=t<.35?tw:e.face,n=e.phase===2?6:5;
     for(let i=0;i<n;i++){const px=clamp(e.x+f*(110+i*125),g.arena?g.arena.l+40:0,g.arena?g.arena.r-40:WORLD);const t0=(.45-t)+.8+i*.2;T(list,src+'>pillar',px-32,GR-230,64,230,t0,t0+.45,{once:true});}}
    break;}
   case 'crane':{
    if(e.state==='peck'){const w=e.wind;
     if(t<w+.2){const f=t<w*.8-.03?0:e.face;const [x,ww]=front(e,f,-10,230+520*s*.18);T(list,src,x,e.y-140,ww,62,w-t,w+.2-t,M);}
     else if(e.phase===2&&(e.combo||0)<1){const t0=(w+.55/s-t)+.32/s;const [x,ww]=front(e,0,-10,230+520*s*.18);T(list,src+'+',x,e.y-140,ww,62,t0,t0+.2,M);}}
    else if(e.state==='gust'){const f=t<.5/s?tw:e.face,max=e.phase===2?5:3;
     for(let k=(e.fired||0)+1;k<=max;k++){const ts=.5/s+(k-1)*.22/s-t;const y=k%2?GR-30:GR-72;T(list,'crane>feather',e.x+f*50-10,y-6,20,12,ts,ts+1.6,{vx:f*560});}}
    else if(e.state==='diveWind'||e.state==='dive'){const dw=e.state==='diveWind',Td=dw?(.5/s-t)+.32/s:.32/s-t,tx=e.tx!==undefined?e.tx:e.x;
     const sx=dw?e.x:(e.sx!==undefined?e.sx:e.x),sy=dw?e.y-30:(e.sy!==undefined?e.sy:e.y),D=.32/s;
     for(let k=0;k<1;k+=.1){const a=Td-D+k*D;if(a+.1*D<0)continue;const kk=k+.05;T(list,src+'>body',sx+(tx-sx)*kk-45,sy+(GR-sy)*kk*kk-125,90,125,a,a+.1*D,M);}
     T(list,src+'>burst',tx-130,GR-80,260,80,Td,Td+.12,{once:true});
     if(e.phase===2)[-1,1].forEach(d=>T(list,'crane>feather',tx+d*40-10,GR-32,20,12,Td,Td+1.4,{vx:d*520}));}
    break;}
   default:{ // unknown enemy type: learned hit timings, then guesses from its state name and speed
    const hw=halfW(e),L=b.learn[e.type+':'+e.state];
    if(L){const t0=L.t-t;if(t0>-.3){const [x,w]=front(e,tw,-hw,L.d+30);T(list,src+'?',x,GR-230,w,230,Math.max(0,t0),Math.max(0,t0)+.3,M);}}
    else if(RX_WIND.test(e.state)){const t0=Math.max(.06,.45-t);const [x,w]=front(e,tw,-hw,200);T(list,src+'?',x,GR-200,w,200,t0,t0+.25,M);}
    else if(RX_ATK.test(e.state)&&t<.6&&!RX_REC.test(e.state)){const [x,w]=front(e,e.face||tw,-hw,190);T(list,src+'?',x,GR-200,w,200,0,.25,M);}
    if(Math.abs(e.vx||0)>300)T(list,src+'?',e.x-hw,GR-160,hw*2,160,0,.35,{melee:true,once:true,vx:e.vx});
   }
  }
 }
 function projThreats(b,list){
  const P=g.P,react=.08*b.SKILL;
  for(const p of g.proj){
   if(!p||typeof p.x!=='number'||!(p.life>0))continue;
   if(!b.seen.has(p))b.seen.set(p,b.clock);
   if(p.kind!=='burst'&&b.clock-b.seen.get(p)<react)continue;
   switch(GEN.has(p.kind)?'?':p.kind){
    case 'quake':break; // the player's own 裂地
    case 'wave':T(list,'wave',p.x-18,GR-42,36,42,0,p.life,{vx:p.vx||0});break;
    case 'burst':if(!p.spent){const r=p.r||130;T(list,'burst',p.x-r,GR-80,2*r,80,0,p.life+1/60,{once:true});}break;
    case 'arrow':T(list,'arrow',p.x-14,p.y-4,28,8,0,p.life,{vx:p.vx||0});break;
    case 'feather':{const vy=p.vy||0,tg=vy>0?(GR-2-p.y)/vy:p.life;T(list,'feather',p.x-10,p.y-6,20,12,0,Math.min(p.life,tg),{vx:p.vx||0,vy});break;}
    case 'pillar':if(!p.hit)T(list,'pillar',p.x-32,GR-230,64,230,p.warn-p.t,p.warn+.45-p.t,{once:true});break;
    case 'rain':if(!p.hit)T(list,'rain',p.x-22,GR-110,44,110,p.warn-p.t,p.warn+.15-p.t,{once:true});break;
    case 'blade':{let vx;if(!p.ret)vx=(p.vx||0)*.8;else{const bx=g.boss?g.boss.x:p.x;vx=sgn(bx-p.x)*Math.min(950,250+p.t*450);}
     T(list,'blade',p.x-34,p.y-22,68,44,0,.7,{vx});break;}
    default:{ // unknown projectile/zone (future content): moving box, timed zone or short-lived area
     if(p.hit||p.spent||p.friendly||p.own==='player')break;
     const r=p.r||p.w/2||40;
     if(p.vx){const y=typeof p.y==='number'?p.y:GR-20;T(list,String(p.kind),p.x-r,y-r,2*r,2*r,0,Math.min(p.life,1.5),{vx:p.vx,vy:p.vy||0});}
     else if(p.warn!==undefined&&p.t!==undefined)T(list,String(p.kind),p.x-r,GR-240,2*r,240,p.warn-p.t,p.warn-p.t+.35,{once:true});
     else T(list,String(p.kind),p.x-r,GR-120,2*r,120,0,Math.min(p.life,.4),{once:true});
    }
   }
  }
 }
 function buildThreats(b){
  const list=[],P=g.P,react=.1*b.SKILL;
  for(const e of g.enemies){
   if(!alive(e)||e.frozen>0||Math.abs(e.x-P.x)>1200)continue;
   if(e.t<react&&!/lunge|thrust|slam|dash|roll|dive|swoop/.test(e.state))continue; // takes a moment to read a new tell
   try{enemyThreats(b,e,list);}catch(err){b.errs.add('threat '+e.type+': '+err.message);}
  }
  try{projThreats(b,list);}catch(err){b.errs.add('proj: '+err.message);}
  return list;
 }
 // ---- earliest time an enemy could hurt the player in melee (for deciding whether it is safe to commit)
 function pn(b,e){
  const s=e.spd||1,t=e.t,A=ag(),st=e.state,fz=e.frozen>0?e.frozen:0;let r=1;
  switch(GEN.has(e.type)?'?':e.type){
   case 'boss':{const nx=.45/s;
    r=st==='intro'?(1.6-t)+e.cd/A+nx:st==='idle'?Math.max(0,e.cd)/A+nx:
     st==='slash'?(t<e.wind+.17/s?Math.max(0,e.wind-t):(e.wind+.5/s-t)+((e.combo||0)<(e.phase===2?2:1)?.3/s:.6/s/A+nx)):
     st==='dash'?(e.dashStarted?0:.55/s-t):st==='leap'?(e.landed?(1.85/s-t)+.5/s/A+nx:0):st==='howl'?(1.6-t)+.4/A+nx:
     st==='throw'?(e.thrown?1:.55/s-t+.4):st==='recover'?(.6/s-t)+.4/s/A+nx:st==='stagger'?(1.5-t)+.3/A+nx:st==='roar'?(1.4-t)+.4/A+nx:9;break;}
   case 'crane':{const nx=.5/s;
    r=st==='intro'?(1.6-t)+e.cd/A+nx:st==='idle'?Math.max(0,e.cd)/A+nx:
     st==='peck'?(t<e.wind+.2?Math.max(0,e.wind-t):(e.wind+.55/s-t)+(e.phase===2&&(e.combo||0)<1?.32/s:.6/s/A+nx)):
     st==='gust'?(1.8/s-t)+.5/s/A+nx:st==='landed'?(1.3/s-t)+.4/s/A+nx:st==='stagger'?(1.5-t)+.3/A+nx:st==='roar'?(1.4-t)+.4/A+nx:
     (st==='diveWind'||st==='dive')?0:1;break;}
   case 'golem':{const nx=.7/s;
    r=st==='intro'?(1.8-t)+1.6/A+nx:st==='idle'?Math.max(0,e.cd)/A+nx:
     st==='slam'?(t<e.wind+.18?Math.max(0,e.wind-t):(e.wind+.95/s-t)+.7/s/A+nx):st==='sweep'?(t<e.wind+.26?Math.max(0,e.wind-t):(e.wind+.85/s-t)+.6/s/A+nx):
     st==='geyser'?(2.4/s-t)+.6/s/A+nx:st==='meteor'?(3.1-t)+.5/s/A+nx:st==='roll'?0:st==='recover'?(.95/s-t)+.5/s/A+nx:
     st==='stagger'?(1.8-t)+.4/A+nx:st==='roar'?(1.6-t)+.5/A+nx:1;break;}
   case 'brute':r=st==='walk'?Math.max(0,e.cd)/A+.9:st==='raise'?.9-t:st==='slam'?(.3-t)+1.1+1/A+.9:st==='recover'?(1.1-t)+1/A+.9:st==='stagger'?(1.3-t)+.6/A+.9:1;break;
   case 'shield':r=st==='guard'?Math.max(0,e.cd)/A+.6:st==='wind'?.6-t:st==='thrust'?(t<.16?0:(.3-t)+.85+.8/A+.6):st==='recover'?(.85-t)+.8/A+.6:
     st==='hurt'?(e.stun-t)+.3/A+.6:st==='broken'?(1.4-t)+.5/A+.6:1;break;
   case 'wolf':r=st==='chase'?Math.max(0,.3/A-t)+.48:st==='wind'?.48-t:st==='lunge'?(t<.32?0:(.42-t)+.75/A+.48):st==='recover'?(.75/A-t)+.48:st==='hurt'?(e.stun-t)+.48:1;break;
   case 'imp':r=st==='wind'?.6-t:st==='hurt'?(e.stun-t)+.6:.6;break;
   case 'bat':r=st==='hover'?Math.max(0,e.cd)/A+.6:st==='swoopWind'?.6-t:st==='swoop'?0:st==='hurt'?(e.stun-t)+.6:1;break;
   case 'archer':r=9;break;
   default:{const L=b.learn[e.type+':'+st];r=L?Math.max(0,L.t-t):RX_REC.test(st)?.7:RX_ATK.test(st)?0:RX_WIND.test(st)?Math.max(0,.45-t):.45;}
  }
  r=Math.max(0,r)+fz;return isFinite(r)?r:.45;
 }
 // ---- simulate the player's own motion for a candidate input and report the first unavoided hit
 function sim(b,ths,plan,ctx){
  const P=g.P,HZ=.8,bz=ctx.busy,L=ctx.L,R=ctx.R,pad=plan.pad||2;
  let x=P.x,yo=Math.max(0,GR-P.y),vy=P.vy,ground=P.ground,inv=P.inv,dT=-1,dDir=P.dodgeDir||P.face;
  if(P.state==='dodge'){dT=P.t;inv=Math.max(inv,.28-P.t);}
  let started=!plan.act;const actAt=plan.act==='dodge'?Math.max(plan.at||0,bz.d):Math.max(plan.at||0,bz.m);
  let spT=-1,spK=0,hit=Infinity,contact=Infinity,src=null,dStart=-1;const spent=new Set();
  for(let tau=0,dt=1/60;tau<=HZ+1e-9;tau+=dt,dt=tau<.12?1/60:1/30){ // fine steps first: bursts last only 0.12 s
   if(!started&&tau>=actAt-1e-6){started=true;
    if(plan.act==='dodge'){dT=0;dDir=plan.dir;inv=Math.max(inv,tau+.28);dStart=tau;}
    else if(plan.act==='jump'){if(!ground)return{hit:-1,contact:-1,src:null,dStart};vy=-640;ground=false;}
    else if(plan.act==='spirit'){spT=0;spK=ctx.spirit;inv=Math.max(inv,tau+(spK===1?.62:spK===2?.5:.8));}}
   const pb={x:x-15-pad,y:GR-yo-88,w:30+2*pad,h:88};
   for(const th of ths){if(tau<th.t0||tau>th.t1||spent.has(th))continue;const k=tau-th.t0;
    if(ov(pb,{x:th.bx+th.vx*k,y:th.by+th.vy*k,w:th.w,h:th.h})){if(tau<contact)contact=tau;
     if(tau>=inv){if(tau<hit){hit=tau;src=th;}}else if(th.once)spent.add(th);}}
   if(hit<Infinity)break;
   let vx=0;
   if(dT>=0&&dT<.36){vx=dDir*560*(1-dT/.36);dT+=dt;}
   else if(spT>=0&&spT<.9){if(spK===1&&spT>=.08&&spT<.42)vx=plan.dir*1100;spT+=dt;}
   else if(tau>=bz.m){vx=plan.move*270;if(ground)vx+=ctx.drift;}
   x=clamp(x+vx*dt,L,R);
   if(!ground){vy+=1750*dt;yo-=vy*dt;if(yo<=0){yo=0;vy=0;ground=true;}}
  }
  return{hit,contact,src,dStart};
 }

 function newBrain(SKILL){
  const b={H:{},SKILL,learn:{},hits:{},errs:new Set(),seen:new WeakMap(),clock:0,
   stats:{spirit:{},spell:0,clone:0,dodge:0,perfect:0,counter:0,heal:0},
   prevHp:-1,prevP:null,prevPState:'idle',prevSt:100,prevX:0,prevY:GR,lastThreats:[],
   atkCd:0,heavyT:0,healCd:0,cycleCd:0,jit:.1,waiting:false,lastMode:''};
  b.set=(k,on)=>{if(on&&!b.H[k]){b.H[k]=1;g.press(k);}else if(!on&&b.H[k]){b.H[k]=0;g.release(k);}};
  b.tap=k=>{g.press(k);g.release(k);};
  b.releaseAll=()=>{for(const k in b.H)if(b.H[k]){b.H[k]=0;g.release(k);}};
  b.forget=()=>{b.H={};b.heavyT=0;};
  b.observe=()=>observe(b);b.tick=(dt,adv)=>tick(b,dt,adv);
  return b;
 }
 // ---- record what hurt the bot (old key format for bosses, plus |via= the actual hitbox/projectile)
 function observe(b){
  const P=g.P,m=g.mode;
  if(P&&P===b.prevP&&b.prevHp>=0&&P.hp<b.prevHp&&(m==='play'||m==='dead')){
   const pb={x:b.prevX-15,y:b.prevY-88,w:30,h:88};let via=null,best=1e9;
   for(const th of b.lastThreats){if(th.t0>1/30+1e-6)continue;const k=Math.max(0,1/60-th.t0);
    if(ov(pb,{x:th.bx+th.vx*k-6,y:th.by+th.vy*k,w:th.w+12,h:th.h})){const pr=th.t0+(th.melee?0:.001);if(pr<best){best=pr;via=th.src;}}}
   const bs=g.bossStarted&&g.boss;let key;
   if(bs){const v=via?via.replace(/^[a-z]+:[A-Za-z]+\+?>?/,'')||via.split(':')[1]||via:'?';
    key=bs.type+':'+bs.state+(bs.phase===2?'*':'')+'|ps='+b.prevPState+(b.prevSt<16?'|LOWST':'')+'|bt='+(bs.state==='slash'?(Math.round((bs.t-bs.wind)*10)/10):'-')+'|via='+v;}
   else key=via||g.enemies.filter(e=>!e.dead&&Math.abs(e.x-P.x)<260).map(e=>e.type+':'+e.state).join('/')||'?';
   b.hits[key]=(b.hits[key]||0)+1;
   if(!via||/\?$/.test(via)){ // learn the timing of unknown enemies' attacks
    let ne=null,nd=420;for(const e of g.enemies){if(!alive(e)||(KNOWN[e.type]&&!GEN.has(e.type)))continue;const d=Math.abs(e.x-b.prevX);if(d<nd){nd=d;ne=e;}}
    if(ne){const k=ne.type+':'+ne.state,L=b.learn[k];b.learn[k]={t:Math.min(L?L.t:9,Math.max(0,ne.t-.03)),d:Math.max(L?L.d:0,nd+20)};}}
  }
  if(P){b.prevHp=P.hp;b.prevP=P;}
 }
 function tick(b,dt,adv){
  const P=g.P;b.clock+=dt;
  if(g.mode!=='play'||g.shopOpen||!P||P.state==='dead'){b.releaseAll();b.lastMode=g.mode;b.prevPState=P?P.state:'';return;}
  if(b.lastMode!=='play'){b.forget();b.lastMode='play';}
  if(P.state==='spirit'&&b.prevPState!=='spirit'){const k=P.spiritKind;b.stats.spirit[k]=(b.stats.spirit[k]||0)+1;}
  if(P.state==='dodge'&&b.prevPState!=='dodge')b.stats.dodge++;
  if(P.state==='counter'&&b.prevPState!=='counter')b.stats.counter++;
  if(P.state==='heal'&&b.prevPState!=='heal')b.stats.heal++;
  b.atkCd-=dt;b.healCd-=dt;b.cycleCd-=dt;
  const ar=g.arena,L=ar?ar.l+20:30,R=ar?ar.r-20:WORLD-30;
  const E=g.enemies.filter(alive);
  let drift=0;for(const e of E)if(e.type==='crane'&&e.state==='gust'&&e.frozen<=0){const s=e.spd||1;if(e.t>.5/s&&e.t<1.4/s)drift+=e.face*150;}
  const ths=buildThreats(b);
  const ctx={busy:busy(P),L,R,spirit:curSpirit(),drift,E};
  const pl=plan(b,ctx,adv);
  const base={move:pl.move};
  const r0=sim(b,ths,base,ctx);
  let def=null,wait=false;
  if(r0.hit<Infinity){
   const opts=[],perf=perfWin(),R0=pl.reserve||16;
   for(const d of [-1,0,1])if(d!==pl.move&&ctx.busy.m<.05)opts.push({move:d,cost:d===0?.8:1});
   if(P.ground&&ctx.busy.m<.05)for(const d of [0,-1,1])opts.push({move:d,act:'jump',dir:d,cost:2+(d?.1:0)});
   if(P.st>=16&&ctx.busy.d<.17)for(const d of [-1,1])opts.push({move:0,act:'dodge',dir:d,cost:3});
   if((P.soul||0)>=100&&ctx.spirit&&P.ground&&ctx.busy.m<.05)opts.push({move:0,act:'spirit',dir:pl.dir||P.face,cost:pl.spiritOk?1.5:4});
   let bestSafe=null,bestUnsafe=null;
   for(const o of opts){const r=sim(b,ths,o,ctx);if(r.hit<0)continue;o.r=r;
    if(o.act==='dodge'){const pc=r.contact-r.dStart;if(r.hit===Infinity&&pc>=.01&&pc<perf-.015)o.cost=(r0.src&&r0.src.melee&&P.st>=R0+16)?.7:2.5;
     if(pl.tgt&&sgn(pl.tgt.x-P.x)===o.dir)o.cost-=.05;
     if((o.dir<0&&P.x-L<90)||(o.dir>0&&R-P.x<90))o.cost+=.3;}
    if(r.hit===Infinity){if(!bestSafe||o.cost<bestSafe.cost)bestSafe=o;}
    else if(!bestUnsafe||r.hit>bestUnsafe.r.hit+.02||(Math.abs(r.hit-bestUnsafe.r.hit)<=.02&&o.cost<bestUnsafe.cost))bestUnsafe=o;}
   if(bestSafe){def=bestSafe;
    if(def.act==='dodge'){ // hold the dodge until the hit is close, so it lands as 識破
     const later=sim(b,ths,{move:base.move,act:'dodge',dir:def.dir,at:Math.max(ctx.busy.d,0)+2/60},ctx);
     if(later.hit===Infinity&&r0.contact-ctx.busy.d>b.jit){def=null;wait=true;}}}
   else if(r0.hit>.25)wait=true;
   else def=bestUnsafe;
  }
  if(!def&&!wait)b.jit=clamp(.1+(Math.random()-.5)*.1*b.SKILL,.03,.2);
  b.waiting=wait;
  // ---- apply
  let move=pl.move,act=null,adir=pl.dir||P.face;
  if(def){move=def.move;act=def.act||null;if(def.act)adir=def.dir||adir;}
  else if(!wait||pl.act==='counter')act=pl.act;
  if(act&&pl.need&&act===pl.act&&!def){const rs=sim(b,ths,{move:act==='attack'||act==='heavy'?(pl.dir||0)*.25:0,pad:8},ctx);if(rs.contact<pl.need)act=null;} // swings lunge forward
  if(act==='jump'&&pl.jumpCheck&&!def&&sim(b,ths,{move:0,act:'jump',dir:0},ctx).hit!==Infinity)act=null;
  if(b.H.heavy){b.heavyT-=dt;if(b.heavyT<=0||def||(P.state!=='charge'&&P.state!=='idle'&&P.state!=='run'))b.set('heavy',false);}
  const actionable=['idle','run','jump'].includes(P.state);
  let hold=move;
  if(P.state==='attack')hold=(act==='attack'||P.queued)?adir:0;
  if(act==='dodge'||act==='spirit'||act==='attack')hold=adir;
  if(act==='jump')hold=def?def.dir:move;
  if(act==='attack'&&!actionable&&P.state!=='attack')act=null;
  if(act==='heavy'&&actionable&&P.ground){hold=0;}
  b.set('left',hold<0);b.set('right',hold>0);
  switch(act){
   case 'dodge':b.tap('dodge');break;
   case 'jump':if(actionable&&P.ground)b.tap('jump');break;
   case 'spirit':if(actionable&&P.ground)b.tap('spirit');break;
   case 'counter':b.tap('attack');b.atkCd=.1;break;
   case 'attack':if(b.atkCd<=0){b.tap('attack');b.atkCd=.1;}break;
   case 'heavy':if(actionable&&P.ground&&!b.H.heavy){b.set('heavy',true);b.heavyT=pl.charge||.3;}break;
   case 'heal':if(actionable&&P.ground){b.tap('heal');b.healCd=1;}break;
   case 'spell':if(actionable){b.tap('spell');b.stats.spell++;}break;
   case 'clone':if(actionable){b.tap('clone');b.stats.clone++;}break;
   case 'cycle':if(actionable&&P.ground){b.tap('spirit');b.cycleCd=.4;}break;
  }
  b.lastThreats=ths;b.prevPState=P.state;b.prevSt=P.st;b.prevX=P.x;b.prevY=P.y;
 }
 // ---- offence and spacing
 function plan(b,ctx,adv){
  const P=g.P,E=ctx.E,out={move:0,act:null,dir:0,tgt:null,reserve:16,need:0};
  // counter right after a perfect dodge if an enemy is on that side
  if(P.counterT>0&&P.state!=='counter'&&E.some(e=>{const d=e.x-P.x;return Math.abs(d)<60||(Math.abs(d)<230&&sgn(d)===sgn(P.lastAtkX-P.x));})){out.act='counter';}
  let tgt=null,bd=1e9;for(const e of E){const d=Math.abs(e.x-P.x)-(e.y<GR-120&&e.type!=='bat'?60:0);if(d<bd){bd=d;tgt=e;}}
  if(!tgt||Math.abs(tgt.x-P.x)>900){out.move=adv?adv():0;return out;}
  out.tgt=tgt;
  const dx=tgt.x-P.x,ad=Math.abs(dx),dir=sgn(dx)||P.face,hw=halfW(tgt),bossy=isBossy(tgt),air=tgt.y<GR-60;
  out.dir=dir;
  const reach=hw+92;
  let safe=9;for(const e of E){const d=Math.abs(e.x-P.x)-halfW(e);if(d<reachOf(e)+40)safe=Math.min(safe,pn(b,e));}
  const R=(bossy?20:16)+(tgt.phase===2?8:0)+(E.filter(e=>Math.abs(e.x-P.x)<300).length>2?8:0);out.reserve=R;
  const actionable=['idle','run','jump'].includes(P.state);
  const lowHp=P.hp<P.maxHp*.5||P.hp<42;
  // spirits
  const sp=ctx.spirit,own=owned(),soul=P.soul||0;
  const inRange=k=>{const onG=tgt.y>=GR-120;if(k===1)return ad<=340&&onG;if(k===2)return ad<=600;if(k===3)return onG&&ad<=380;return ad<=300;};
  let pref=sp;if(own.length>1){if(own.includes(2)&&air)pref=2;else if(bossy&&own.includes(1))pref=1;else if(E.filter(e=>Math.abs(e.x-P.x)<400).length>=3&&own.includes(3))pref=3;else if(own.includes(1))pref=1;}
  out.spiritOk=soul>=100&&sp&&inRange(sp);
  if(out.act)return out;
  if(out.spiritOk&&actionable&&P.ground){out.act='spirit';out.move=0;return out;}
  if(soul<100&&own.length>1&&pref!==sp&&actionable&&P.ground&&b.cycleCd<=0&&safe>.4){out.act='cycle';}
  // 定身術: knock the crane out of the sky; freeze bosses (or a brute about to slam) when there is room to exploit it
  if(P.spellCd<=0&&actionable&&!out.act){
   if(tgt.type==='crane'&&tgt.y<GR-100&&ad<500)out.act='spell';
   else if(bossy&&tgt.frozen<=0&&ad<240&&!/intro|stagger|landed|roar|dying/.test(tgt.state)&&(P.st>=45||lowHp))out.act='spell';
   else if(tgt.type==='brute'&&tgt.state==='raise'&&ad<240)out.act='spell';
  }
  if(P.cloneCd<=0&&actionable&&!out.act&&((bossy&&ad<350&&tgt.state!=='intro')||E.filter(e=>Math.abs(e.x-P.x)<350).length>=3))out.act='clone';
  if(out.act){out.move=0;return out;}
  // heal when nothing can reach in time
  if(lowHp&&P.gourd>0&&P.ground&&actionable&&b.healCd<=0&&P.hp<P.maxHp&&safe>=.95&&!b.waiting&&!g.proj.some(p=>p.kind==='rain'||p.kind==='pillar'||p.kind==='wave')){out.act='heal';out.need=.95;return out;}
  // spacing
  const low=P.exhaust||P.st<R+(bossy?10:4);
  const Lw=ctx.L,Rw=ctx.R,backRoom=dir>0?P.x-Lw:Rw-P.x;
  if((low&&safe<1.2)||(lowHp&&P.gourd>0&&safe<.95)){out.move=(ad<320&&backRoom>70)?-dir:0;if(tgt.type==='archer')out.move=dir;}
  else if(ad>reach-12)out.move=dir;
  else out.move=0;
  if(ad<18)out.move=0;
  if(tgt.type==='archer'&&ad>reach-12)out.move=dir;
  // attacks
  if(ad>reach+15||low&&!(P.state==='attack'))return out;
  if(air){ // bats (and unknown fliers): jump and swing; a crane up in the sky is left alone until it dives
   if(tgt.type==='crane'){out.move=ad<200?-dir:0;return out;}
   if(P.ground&&actionable&&ad<150&&safe>.5){out.act='jump';out.jumpCheck=true;}
   else if(!P.ground&&P.state==='jump'&&ad<150){out.act='attack';}
   return out;}
  const facingGuard=tgt.type==='shield'&&tgt.frozen<=0&&['guard','wind','idle'].includes(tgt.state)&&sgn(P.x-tgt.x)===tgt.face;
  if(P.state==='attack'){const c=P.combo|0;
   if(c<3&&!P.queued&&P.t>ATK_HS[c]*.5){const left=ATK_DUR[c]-P.t,nx=c+1;
    if(!facingGuard&&P.st-ATK_ST[nx]>=R&&safe>=left+(nx===3?.5:.27))out.act='attack';}
   return out;}
  if(!actionable||!P.ground)return out;
  const canHeavy=P.st>=14+(bossy?8:0);
  const rainy=E.some(e=>/meteor|storm|sky/.test(e.state)||(e.state==='howl'&&!e.howled))||g.proj.some(p=>p.kind==='rain'||p.kind==='pillar');
  if(facingGuard){if(canHeavy&&safe>=.85&&!rainy){out.act='heavy';out.charge=.2;out.need=.85;}return out;}
  if(P.focus>=1&&canHeavy&&safe>=.95&&!rainy){out.act='heavy';out.charge=clamp(safe-.75,.15,.45);out.need=out.charge+.65;return out;}
  if(P.st-ATK_ST[0]>=R&&safe>=(bossy?.3:.26)){out.act='attack';out.need=.3;}
  return out;
 }
 window.__bot={newBrain};
}

// ---------------------------------------------------------------- run loops (in page)
function storyRuns({d,N,SKILL}){
 const g=__game,out=[];
 const PRI=[8,0,2,7,1,4,5,3,6];
 for(let r=0;r<N;r++){
  try{localStorage.clear();}catch(e){}
  g.press('start');g.release('start');g.newRun(d);
  const b=__bot.newBrain(SKILL);
  let t=0,deaths={1:0,2:0,3:0},bossDeaths={1:0,2:0,3:0},fail=null,shopped={},stuckT=0,lastX=0,steps=0;
  const dt=1/60;
  const adv=()=>{const P=g.P;const goal=!g.bossStarted?(shopped[g.worldCh+'s']?g.BOSS_TRIGGER+80:g.SHRINE_X):P.x;if(!shopped[g.worldCh+'s']&&Math.abs(P.x-g.SHRINE_X)<50&&!g.bossStarted)return 0;return Math.abs(goal-P.x)<10?0:Math.sign(goal-P.x);};
  while(steps<60*60*20){
   steps++;t+=dt;
   b.observe();
   const P=g.P,m=g.mode;
   if(m==='win')break;
   if(m==='story'){b.tick(dt);g.press('start');g.release('start');g.step(dt);continue;}
   if(m==='dead'){b.tick(dt);if(g.deadT>1.3){deaths[g.worldCh]++;if(g.bossStarted)bossDeaths[g.worldCh]++;g.press('start');g.release('start');}g.step(dt);if(deaths[1]+deaths[2]+deaths[3]>40){fail='deaths';break;}continue;}
   if(m==='clear'){b.tick(dt);g.step(dt);if(steps%30===0){g.press('start');g.release('start');}continue;}
   if(g.shopOpen){b.tick(dt);
    let bought=true;while(bought){bought=false;for(const i of PRI){const it=g.UPG[i];const lv=g.run.up[it.id]||0;const c=Math.round(it.cost*(1+lv*.8));if(lv<it.max&&g.run.ess>=c){g.buy(i);bought=true;break;}}}
    g.closeShop();b.forget();g.step(dt);continue;}
   const E=g.enemies.filter(e=>!e.dead&&e.state!=='dying');
   if(!g.bossStarted&&Math.abs(P.x-g.SHRINE_X)<50&&!shopped[g.worldCh+'s']&&E.every(e=>Math.abs(e.x-P.x)>500)&&['idle','run'].includes(P.state)){shopped[g.worldCh+'s']=1;b.releaseAll();g.openShop(1);g.step(dt);continue;}
   b.tick(dt,adv);
   if(steps%300===0){if(Math.abs(P.x-lastX)<5&&E.length===0&&!g.bossStarted)stuckT++;else stuckT=0;lastX=P.x;if(stuckT>6){fail='stuck@'+Math.round(P.x);break;}}
   g.step(dt);
  }
  b.releaseAll();
  out.push({hits:b.hits,won:g.mode==='win',fail:fail||(g.mode!=='win'?'timeout':null),t:Math.round(t),deaths:deaths[1]+deaths[2]+deaths[3],d1:deaths[1],d2:deaths[2],d3:deaths[3],bd1:bossDeaths[1],bd2:bossDeaths[2],bd3:bossDeaths[3],
   ups:Object.values(g.run?g.run.up:{}).reduce((a,c)=>a+c,0),ess:g.run?g.run.ess:0,ch:g.worldCh,stats:b.stats,errs:[...b.errs]});
 }
 return out;
}
// Pick a Boss 挑戰 entry through the title menu (fresh page: menu cursor on 開始旅程, rush cursor on the first boss, difficulty 修行).
function rushEnter({c,d}){
 const g=__game,tap=k=>{g.press(k);g.release(k);};
 if(g.mode!=='title')return{ok:false,why:'not on title ('+g.mode+')'};
 for(let i=0;i<8&&g.titleSub!=='rush';i++){if(g.titleSub!=='main')tap('dodge');tap('down');tap('start');}
 if(g.titleSub!=='rush')return{ok:false,why:'rush menu not found'};
 if(c==='g')tap('left');else for(let i=1;i<c;i++)tap('right');
 if(d===0)tap('up');else if(d===2)tap('down');
 tap('start');
 const r=g.run;
 if(g.mode!=='play'||!r||!r.rush)return{ok:false,why:'challenge did not start'};
 if(r.diff!==d)return{ok:false,why:'difficulty '+r.diff+' instead of '+d};
 if(c==='g'?!r.gauntlet:(r.gauntlet||r.ch!==c))return{ok:false,why:'menu has no boss '+c+' (got '+(r.gauntlet?'gauntlet':'boss '+r.ch)+')'};
 return{ok:true,boss:g.boss?g.boss.type:'?'};
}
function rushRuns({N,SKILL,gauntlet}){
 const g=__game,out=[],dt=1/60,LIMIT=60*60*(gauntlet?15:5);
 for(let r=0;r<N;r++){
  if(r>0){ // retry from the result screen like a player (start after the delay)
   let k=0;while(g.mode!=='play'&&k++<600){g.step(dt);if(k%20===0){g.press('start');g.release('start');}}
   if(g.mode!=='play'){out.push({err:'could not restart ('+g.mode+')'});break;}}
  const b=__bot.newBrain(SKILL);let steps=0,maxCh=g.run.ch;
  while(steps<LIMIT&&g.mode==='play'){steps++;b.observe();b.tick(dt,()=>g.boss&&!g.boss.dead?Math.sign(g.boss.x-g.P.x):0);g.step(dt);if(g.run.ch>maxCh)maxCh=g.run.ch;}
  b.observe();
  const bs=g.boss,won=g.mode==='win';
  out.push({won,fail:won?null:g.mode==='dead'?'dead':'timeout',t:Math.round((g.run.elapsed||0)*10)/10,taken:g.run.stats.taken||0,hp:g.P?Math.round(g.P.hp/g.P.maxHp*100):0,
   bossHp:bs?Math.round(Math.max(0,bs.hp)/bs.maxHp*100):-1,bossType:bs?bs.type:'?',stage:maxCh,hits:b.hits,stats:b.stats,errs:[...b.errs]});
  b.releaseAll();
  if(!won&&g.mode==='play')break; // timed out mid-fight: there is no result screen to retry from, so stop this boss here
 }
 return out;
}

// ---------------------------------------------------------------- node side
const avgOf=(res,k)=>(res.reduce((a,r)=>a+r[k],0)/Math.max(1,res.length)).toFixed(1);
const SPN={1:'狼',2:'鶴',3:'岩'};
function spiritSummary(res){
 const tot={};let spell=0,clone=0,counter=0;
 res.forEach(r=>{Object.entries(r.stats.spirit).forEach(([k,v])=>tot[k]=(tot[k]||0)+v);spell+=r.stats.spell;clone+=r.stats.clone;counter+=r.stats.counter;});
 const n=Math.max(1,res.length),all=Object.values(tot).reduce((a,c)=>a+c,0);
 const per=Object.keys(tot).sort().map(k=>(SPN[k]||k)+' '+(tot[k]/n).toFixed(1)).join(', ');
 return `spirit ${(all/n).toFixed(1)}${per?' ('+per+')':''}  spell ${(spell/n).toFixed(1)}  clone ${(clone/n).toFixed(1)}  counters ${(counter/n).toFixed(1)}`;
}
function hitsLine(res){const agg={};res.forEach(r=>Object.entries(r.hits||{}).forEach(([k,v])=>agg[k]=(agg[k]||0)+v));return 'HITS '+JSON.stringify(Object.entries(agg).sort((a,b)=>b[1]-a[1]).slice(0,14));}
async function freshPage(b,errs){
 const pg=await b.newPage({viewport:{width:960,height:540}});
 pg.on('pageerror',e=>errs.push(e.message+' @'+(e.stack||'').split('\n')[1]));
 await pg.goto(URL);await pg.evaluate(()=>{try{localStorage.clear();localStorage.setItem('gunpo-ach',JSON.stringify({u:['journey'],c:0,s:0}));}catch(e){}}); // unlock the secret 4th rush boss
 await pg.reload();await pg.waitForTimeout(800);
 await pg.evaluate(()=>__game.halt());
 await pg.evaluate(installBot,{generic:GENERIC});
 return pg;
}
(async()=>{
 const b=await chromium.launch();const errs=[],botErrs=new Set();
 if(STORY){
  const pg=await freshPage(b,errs);
  for(const d of DIFFS){
   const res=await pg.evaluate(storyRuns,{d,N,SKILL});
   res.forEach(r=>r.errs.forEach(e=>botErrs.add(e)));
   const w=res.filter(r=>r.won).length,avg=k=>avgOf(res,k);
   console.log(hitsLine(res));
   console.log(`diff ${d}: win ${w}/${res.length}  avgTime ${avg('t')}s  deaths ${avg('deaths')} (ch1 ${avg('d1')}, ch2 ${avg('d2')}, ch3 ${avg('d3')}; boss1 ${avg('bd1')}, boss2 ${avg('bd2')}, boss3 ${avg('bd3')})  ups ${avg('ups')}  ${spiritSummary(res)}  fails:`,[...new Set(res.filter(r=>r.fail).map(r=>r.fail))].join(','));
  }
  await pg.close();
 }
 if(RUSH){
  for(const c0 of RUSH){const c=c0==='g'?'g':parseInt(c0,10);
   if(c!=='g'&&!(c>=1))continue;
   for(const d of DIFFS){
    const pg=await freshPage(b,errs);
    const ent=await pg.evaluate(rushEnter,{c,d});
    if(!ent.ok){console.log(`rush ${c0} diff ${d}: skipped — ${ent.why}`);await pg.close();continue;}
    const res=await pg.evaluate(rushRuns,{N,SKILL,gauntlet:c==='g'});
    await pg.close();
    const bad=res.filter(r=>r.err);bad.forEach(r=>console.log('  ',r.err));
    const ok=res.filter(r=>!r.err);ok.forEach(r=>r.errs.forEach(e=>botErrs.add(e)));
    const wins=ok.filter(r=>r.won),avgW=k=>wins.length?avgOf(wins,k):'-';
    const lost=ok.filter(r=>!r.won);
    console.log(hitsLine(ok));
    console.log(`rush ${c0} (${ent.boss}) diff ${d}: win ${wins.length}/${ok.length}  winTime ${avgW('t')}s  hitsTaken ${avgOf(ok,'taken')}  hpLeft ${avgW('hp')}%  bossHpOnLoss ${lost.length?avgOf(lost,'bossHp')+'%':'-'}${c==='g'?'  stage '+avgOf(ok,'stage'):''}  ${spiritSummary(ok)}  fails:`,[...new Set(ok.filter(r=>r.fail).map(r=>r.fail))].join(','));
   }
  }
 }
 console.log('errors',errs.slice(0,5));
 if(botErrs.size)console.log('bot errors',[...botErrs].slice(0,5));
 await b.close();
})();
