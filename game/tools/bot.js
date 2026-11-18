// Headless balance/soak test. Usage: node game/tools/bot.js <runs> <difficulties e.g. 0,1,2> <reaction jitter multiplier>
// Requires playwright. Plays full runs with a scripted player and prints win rate, deaths and what hurt the bot.
const {chromium}=require('playwright');
const N=parseInt(process.argv[2]||'10',10), DIFFS=(process.argv[3]||'0,1,2').split(',').map(Number), SKILL=parseFloat(process.argv[4]||'1');
(async()=>{
 const b=await chromium.launch();const pg=await b.newPage({viewport:{width:960,height:540}});
 const errs=[];pg.on('pageerror',e=>errs.push(e.message+' @'+(e.stack||'').split('\n')[1]));
 await pg.goto('file://'+require('path').resolve(__dirname,'..','index.html')+'');await pg.waitForTimeout(800);
 await pg.evaluate(()=>__game.halt());
 for(const d of DIFFS){
  const res=await pg.evaluate(({d,N,SKILL})=>{
   const g=__game,out=[];
   const PRI=[8,0,2,7,1,4,5,3,6];
   for(let r=0;r<N;r++){
    try{localStorage.clear();}catch(e){}
    g.press('start');g.newRun(d);
    const H={};const set=(k,on)=>{if(on&&!H[k]){H[k]=1;g.press(k);}else if(!on&&H[k]){H[k]=0;g.release(k);}};
    const tap=k=>{g.press(k);g.release(k);};
    const hits={};let prevHp=-1;let t=0,atkCd=0,heavyT=0,dodgeCd=0,deaths={1:0,2:0,3:0},bossDeaths={1:0,2:0,3:0},fail=null,shopped={},stuckT=0,lastX=0,healCd=0,reaction=()=>Math.random()*.08*SKILL;
    const dt=1/60;let steps=0,dmgTaken=0,lastHp=0,minHpBoss={1:999,2:999,3:999},bossTime={1:0,2:0,3:0},bossStartT={};
    while(steps<60*60*20){
     steps++;t+=dt;
     const P=g.P,m=g.mode;
     if(m==='win'){break;}
     if(m==='dead'){set('left',false);set('right',false);if(g.deadT>1.3){deaths[g.worldCh]++;if(g.bossStarted)bossDeaths[g.worldCh]++;g.press('start');g.release('start');}g.step(dt);if(deaths[1]+deaths[2]+deaths[3]>40){fail='deaths';break;}continue;}
     if(m==='clear'){g.step(dt);if(steps%30===0){g.press('start');g.release('start');}continue;}
     if(g.shopOpen){
      let bought=true;while(bought){bought=false;for(const i of PRI){const it=g.UPG[i];const lv=g.run.up[it.id]||0;const c=Math.round(it.cost*(1+lv*.8));if(lv<it.max&&g.run.ess>=c){g.buy(i);bought=true;break;}}}
      g.closeShop();for(const k in H)H[k]=0;g.step(dt);continue;}
     if(prevHp>=0&&P.hp<prevHp&&m==='play'){const bs=g.bossStarted&&g.boss;const key=bs?(bs.type+':'+bs.state+(bs.phase===2?'*':'')+'|ps='+P.state+(P.st<16?'|LOWST':'')+'|bt='+(bs.state==='slash'?(Math.round((bs.t-bs.wind)*10)/10):'-')):g.enemies.filter(e=>!e.dead&&Math.abs(e.x-P.x)<260).map(e=>e.type+':'+e.state).join('/');hits[key]=(hits[key]||0)+1;}
     prevHp=P.hp;
     const E=g.enemies.filter(e=>!e.dead&&e.state!=='dying');
     let want=0,doDodge=false,doJump=false,heavyHold=false,tryAtk=false;
     // proximity shrine shop
     if(!g.bossStarted&&Math.abs(P.x-g.SHRINE_X)<50&&!shopped[g.worldCh+'s']&&E.every(e=>Math.abs(e.x-P.x)>500)){shopped[g.worldCh+'s']=1;g.openShop(1);g.step(dt);continue;}
     // threats
     const near=E.map(e=>({e,d:Math.abs(e.x-P.x),dir:Math.sign(P.x-e.x)||1}));
     for(const {e,d} of near){
      if(e.frozen>0)continue;const s=e.spd||1,tt=e.t;
      const w=(a,bb)=>tt>a&&tt<bb;
      if(e.type==='wolf'&&e.state==='wind'&&w(.3,.5)&&d<240)doDodge=true;
      if(e.type==='shield'&&e.state==='wind'&&w(.38,.62)&&d<230)doDodge=true;
      if(e.type==='brute'&&e.state==='raise'&&w(.68,.92)&&d<300)doDodge=true;
      if(e.type==='bat'&&e.state==='swoop'&&tt<.25&&d<200)doDodge=true;
      if(e.type==='boss'){
        if(e.state==='slash'&&w(e.wind-.2,e.wind+.02)&&d<240)doDodge=true;
        if(e.state==='dash'&&!e.dashStarted&&w(.4/s,.56/s)&&d<800)doDodge=true;
        if(e.state==='leap'&&!e.landed&&w(.3/s,1.15/s)){if(Math.abs(e.tx-P.x)<190)want=Math.sign(P.x-e.tx)||1;}
        if(e.state==='leap'&&e.landed&&d<200)want=Math.sign(P.x-e.x)||1;
      }
      if(e.type==='golem'){
        if((e.state==='slam'||e.state==='sweep')&&w(e.wind-.22,e.wind+.02)&&d<330)doDodge=true;
        if(e.state==='roll'&&!e.rolling&&w(.45/s,.68/s)&&d<800)doDodge=true;
      }
      if(e.type==='imp'&&e.state==='wind'&&w(.38,.58)&&d<140)doDodge=true;
      if(e.type==='crane'){
        if(e.state==='peck'&&w(e.wind-.22,e.wind+.02)&&d<300)doDodge=true;
        if(e.state==='diveWind'){if(Math.abs(e.tx-P.x)<120)want=Math.sign(P.x-e.tx)||1;}
      }
     }
     for(const p of g.proj){
      const dx=p.x-P.x;
      if(p.kind==='arrow'||p.kind==='feather'||p.kind==='blade'){
        const approaching=(p.vx||0)*dx<0;if(approaching&&Math.abs(dx)<150&&Math.abs((p.y||g.GROUND-40)-(P.y-40))<80)doDodge=true;}
      if(p.kind==='wave'&&Math.abs(dx)<170&&(p.vx*dx<0))doJump=true;
      if((p.kind==='pillar'||p.kind==='rain')&&Math.abs(dx)<70&&p.t>p.warn-.55&&p.t<p.warn+.3){want=Math.sign(dx)||1;}
      if(p.kind==='burst'&&Math.abs(dx)<150)want=Math.sign(dx)||1;
     }
     // heal
     healCd-=dt;
     const calm=near.every(n=>n.d>260||n.e.frozen>0||['stagger','landed','broken'].includes(n.e.state));
     if(P.hp<P.maxHp*.5&&P.gourd>0&&P.ground&&calm&&healCd<=0&&['idle','run'].includes(P.state)){tap('heal');healCd=1.2;}
     // target
     let tgt=null,bd=1e9;for(const n of near){if(n.d<bd){bd=n.d;tgt=n.e;}}
     if(!tgt){ // advance
       const goal=!g.bossStarted?(shopped[g.worldCh+'s']?g.BOSS_TRIGGER+80:g.SHRINE_X):P.x;want=want||Math.sign(goal-P.x);if(Math.abs(goal-P.x)<10)want=0;
       if(!shopped[g.worldCh+'s']&&Math.abs(P.x-g.SHRINE_X)<50&&!g.bossStarted){want=0;}
     }else{
       const dx=tgt.x-P.x,ad=Math.abs(dx);
       const ty=tgt.y;const air=tgt.y<g.GROUND-60&&tgt.type!=='bat';
       if(tgt.type==='crane'&&tgt.state==='sky'&&P.spellCd<=0&&ad<500){tap('spell');}
       const range=tgt.type==='golem'?140:tgt.type==='boss'?110:tgt.type==='crane'?120:tgt.type==='brute'?120:95;
       if(!want){
         if(ad>range)want=Math.sign(dx);
         else if(ad<range*.55&&tgt.type!=='archer')want=-Math.sign(dx)*0; 
         if(tgt.type==='archer'&&ad>150)want=Math.sign(dx);
       }
       if(ad<range+25){
         if(P.face!==Math.sign(dx)&&ad>8&&!want)want=Math.sign(dx)*.5;
         if(tgt.type==='bat'||air){if(P.ground&&ad<150&&tgt.y<g.GROUND-40)doJump=true;if(!P.ground&&ad<150)tap('attack');}
         else if(tgt.type==='shield'&&['guard','wind','idle'].includes(tgt.state)&&Math.sign(dx)===tgt.face*-1){heavyHold=true;}
         else if(tgt.type==='brute'||tgt.type==='boss'&&P.focus>=1&&heavyT<=0){heavyHold=P.focus>=1||tgt.type==='brute';tryAtk=!heavyHold;}
         else tryAtk=true;
       }
     }
     if(tgt&&(tgt.type==='boss'||tgt.type==='crane'||tgt.type==='golem')){const bs=tgt;let unsafe=false;
       if(bs.type==='golem'){if((bs.state==='slam'||bs.state==='sweep')&&bs.t<bs.wind+.3)unsafe=true;if(['geyser','meteor','roll','roar','intro'].includes(bs.state))unsafe=true;}
       else if(bs.type==='boss'){if(bs.state==='slash'&&bs.t<bs.wind+.2)unsafe=true;if(['dash','leap','howl','throw','roar','intro'].includes(bs.state))unsafe=true;}
       else{if(bs.state==='peck'&&bs.t<bs.wind+.28)unsafe=true;if(['gust','rise','storm','diveWind','dive','roar','intro'].includes(bs.state))unsafe=true;}
       if(unsafe){tryAtk=false;heavyHold=false;if(!doDodge&&Math.abs(tgt.x-P.x)<200&&!want)want=Math.sign(P.x-tgt.x)||1;}}
     if(P.st<38&&!['attack'].includes(P.state)){tryAtk=false;if(P.st<28)heavyHold=false;}
     if(P.exhaust){tryAtk=false;heavyHold=false;}
     // mid-combo drift: keep facing
     if(want!==0&&want!==.5&&want!==-.5){set('left',want<0);set('right',want>0);}else{set('left',false);set('right',false);}
     if(Math.abs(want)===.5){tap(want>0?'right':'left');}
     dodgeCd-=dt;atkCd-=dt;
     if(doDodge&&dodgeCd<=0&&P.st>=16&&!['dodge','dead','hurt'].includes(P.state)){const nn=near.slice().sort((a,b)=>a.d-b.d)[0];const dir=nn?(Math.sign(P.x-nn.e.x)||1):1;set('left',dir<0);set('right',dir>0);tap('dodge');dodgeCd=.5;}
     else if(doJump&&P.ground&&['idle','run'].includes(P.state)){tap('jump');}
     else if(P.counterT>0&&atkCd<=0){tap('attack');atkCd=.1;}
     else if(heavyHold){if(!H.heavy){set('heavy',true);heavyT=.45;}}
     else if(tryAtk&&atkCd<=0){tap('attack');atkCd=.13;}
     if(H.heavy){heavyT-=dt;if(heavyT<=0||!heavyHold&&heavyT<.3)set('heavy',false);}
     if(g.bossStarted){const bs=g.boss;if(bs&&!bs.dead){bossTime[g.worldCh]+=dt;minHpBoss[g.worldCh]=Math.min(minHpBoss[g.worldCh],Math.round(bs.hp/bs.maxHp*100));}}
     // stuck watchdog
     if(steps%300===0){if(Math.abs(P.x-lastX)<5&&E.length===0&&!g.bossStarted)stuckT++;else stuckT=0;lastX=P.x;if(stuckT>6){fail='stuck@'+Math.round(P.x);break;}}
     g.step(dt);
    }
    out.push({hits,won:g.mode==='win',fail:fail||(g.mode!=='win'?'timeout':null),t:Math.round(t),deaths:deaths[1]+deaths[2]+deaths[3],d1:deaths[1],d2:deaths[2],d3:deaths[3],bd1:bossDeaths[1],bd2:bossDeaths[2],bd3:bossDeaths[3],ups:Object.values(g.run?g.run.up:{}).reduce((a,b)=>a+b,0),ess:g.run?g.run.ess:0,ch:g.worldCh});
   }
   return out;
  },{d,N,SKILL});
  const w=res.filter(r=>r.won).length,avg=k=>(res.reduce((a,r)=>a+r[k],0)/res.length).toFixed(1);
  const agg={};res.forEach(r=>Object.entries(r.hits).forEach(([k,v])=>agg[k]=(agg[k]||0)+v));console.log('HITS',JSON.stringify(Object.entries(agg).sort((a,b)=>b[1]-a[1]).slice(0,14)));
  console.log(`diff ${d}: win ${w}/${res.length}  avgTime ${avg('t')}s  deaths ${avg('deaths')} (ch1 ${avg('d1')}, ch2 ${avg('d2')}, ch3 ${avg('d3')}; boss1 ${avg('bd1')}, boss2 ${avg('bd2')}, boss3 ${avg('bd3')})  ups ${avg('ups')}  fails:`,[...new Set(res.filter(r=>r.fail).map(r=>r.fail))].join(','));
 }
 console.log('errors',errs.slice(0,5));
 await b.close();
})();
