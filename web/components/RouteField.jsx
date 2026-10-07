'use client';
import { canvasColors } from '../lib/canvas-colors.js'; // C126
import {useEffect,useRef} from 'react';
import {MARK_LEFT,MARK_RIGHT} from './Logo';

const MODELS=['llama-3.3-70b','qwen3-32b','deepseek-r1','mistral-small','gemma-3-27b','qwen3-235b','deepseek-v3','llama-4-scout','kimi-k2','glm-4.6','gpt-oss-120b','mixtral-8x22b','phi-4','olmo-2-32b','command-r','hermes-3-70b','nemotron-70b','qwq-32b'];
const PROVIDERS=['North Compute','Vector Inference','East Cloud'];

/**
 * Hero canvas: model endpoints orbit the router (the Anyroute mark). Each call lights the candidate
 * routes the router considered, then one winning route carries the request out and the response back.
 * onRoute receives every completed route so the page can print its receipt.
 */
export default function RouteField({onRoute}){
  const ref=useRef(null);const cb=useRef(onRoute);cb.current=onRoute;
  useEffect(()=>{
    const canvas=ref.current,ctx=canvas.getContext('2d');const palette=canvasColors(canvas);
    const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
    const markL=new Path2D(MARK_LEFT),markR=new Path2D(MARK_RIGHT);
    let w=0,h=0,dpr=1,cx=0,cy=0,radius=0,nodes=[],raf=0,running=false,t0=performance.now(),call=null,seq=1041,pointer={x:0,y:0,tx:0,ty:0};
    const rand=(a,b)=>a+Math.random()*(b-a);
    const layout=()=>{
      const r=canvas.getBoundingClientRect();w=r.width;h=r.height;dpr=Math.min(2,devicePixelRatio||1);canvas.width=w*dpr;canvas.height=h*dpr;
      const phone=w<700;const vh=Math.min(h,innerHeight);cx=phone?w*.5:w*.7;cy=phone?vh*.27:h*.44;radius=phone?Math.min(w*.34,vh*.17):Math.min(w*.3,h*.42);
      const count=phone?8:MODELS.length;
      nodes=Array.from({length:count},(_,i)=>{const a=(i/count)*Math.PI*2+rand(-.12,.12)-Math.PI/2;const rr=radius*rand(.62,1.08);return {label:MODELS[i],a,rr,phase:rand(0,6.28),speed:rand(.15,.35),heat:0,x:0,y:0}});
    };
    const pos=(n,t)=>{const wob=Math.sin(t*n.speed+n.phase)*radius*.035;const a=n.a+Math.sin(t*.05+n.phase)*.03;n.x=cx+Math.cos(a)*(n.rr+wob)+pointer.x*(n.rr/radius)*14;n.y=cy+Math.sin(a)*(n.rr+wob)*.82+pointer.y*(n.rr/radius)*14};
    const ctrl=n=>{const mx=(n.x+cx)/2,my=(n.y+cy)/2;const dx=n.y-cy,dy=cx-n.x;const len=Math.hypot(dx,dy)||1;const bend=.18*Math.hypot(n.x-cx,n.y-cy);return [mx+dx/len*bend*.5,my+dy/len*bend*.5]};
    const quad=(n,k)=>{const [qx,qy]=ctrl(n);const u=1-k;return [u*u*cx+2*u*k*qx+k*k*n.x,u*u*cy+2*u*k*qy+k*k*n.y]};
    const newCall=t=>{const candidates=[...nodes].sort(()=>Math.random()-.5).slice(0,4);const winner=candidates[0];return {t,candidates,winner,provider:PROVIDERS[(Math.random()*PROVIDERS.length)|0],latency:Math.round(rand(180,640)),tokens:Math.round(rand(40,420)),private:Math.random()<.25,id:++seq}};
    const draw=now=>{
      const t=(now-t0)/1000;pointer.x+=(pointer.tx-pointer.x)*.05;pointer.y+=(pointer.ty-pointer.y)*.05;
      ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
      nodes.forEach(n=>pos(n,t));
      // orbit rings
      ctx.strokeStyle=palette.alpha('bone',.06);ctx.lineWidth=1;[.55,.85,1.1].forEach(s=>{ctx.beginPath();ctx.ellipse(cx,cy,radius*s,radius*s*.82,0,0,Math.PI*2);ctx.stroke()});
      // call lifecycle: 0-0.7s consider candidates, 0.7-1.5s request out, 1.5-2.3s response back, then settle
      if(!call||t-call.t>3.1){call=newCall(t)}const age=t-call.t;
      if(age>2.3&&!call.done){call.done=true;call.winner.heat=1;cb.current?.({...call,model:call.winner.label})}
      nodes.forEach(n=>{
        const cand=call.candidates.includes(n)&&age<.9;const win=n===call.winner&&age<2.6;const [qx,qy]=ctrl(n);
        ctx.beginPath();ctx.moveTo(cx,cy);ctx.quadraticCurveTo(qx,qy,n.x,n.y);
        ctx.strokeStyle=win&&age>.7?palette.alpha('signal',.85):cand?palette.alpha('bone',.28):palette.alpha('bone',.05+n.heat*.3);ctx.lineWidth=win&&age>.7?1.6:1;
        if(win&&age>.7){ctx.shadowColor=palette.alpha('signal',.8);ctx.shadowBlur=12}ctx.stroke();ctx.shadowBlur=0;
        n.heat*=.985;
        const s=win?7:5;ctx.fillStyle=win?palette.value('signal'):cand?palette.alpha('bone',.9):palette.alpha('bone',.55);
        ctx.fillRect(n.x-s/2,n.y-s/2,s,s);
        if(!win){ctx.fillStyle=palette.value('night');ctx.fillRect(n.x-s/2+1.2,n.y-s/2+1.2,s-2.4,s-2.4)}
        ctx.font='500 10px "Martian Mono Variable", ui-monospace, monospace';ctx.fillStyle=win?palette.alpha('signal',1):palette.alpha('bone',cand?1:.85);
        const tw=ctx.measureText(n.label).width;let right=n.x>=cx;if(right&&n.x+12+tw>w-6)right=false;else if(!right&&n.x-12-tw<6)right=true;ctx.textAlign=right?'left':'right';ctx.fillText(n.label,n.x+(right?12:-12),n.y+3.5);
      });
      // packets on the winning route
      if(age>.7&&age<2.3){const out=age<1.5;const k=out?(age-.7)/.8:1-(age-1.5)/.8;const e=k<.5?2*k*k:1-Math.pow(-2*k+2,2)/2;
        for(let i=0;i<7;i++){const kk=Math.max(0,Math.min(1,e-(out?1:-1)*i*.025));const [px,py]=quad(call.winner,kk);ctx.fillStyle=palette.alpha('signal',1-i/7);const s=4-i*.4;ctx.fillRect(px-s/2,py-s/2,s,s)}}
      // router: the mark, a pulse ring on each call
      const pulse=Math.max(0,1-age/1.2);ctx.strokeStyle=palette.alpha('signal',pulse*.6);ctx.lineWidth=1;ctx.beginPath();ctx.arc(cx,cy,26+(1-pulse)*40,0,Math.PI*2);ctx.stroke();
      ctx.fillStyle=palette.value('night');ctx.fillRect(cx-30,cy-30,60,60);ctx.strokeStyle=palette.alpha('bone',.25);ctx.strokeRect(cx-30.5,cy-30.5,61,61);
      ctx.save();ctx.translate(cx,cy);ctx.scale(40/982,40/982);ctx.translate(-627,-618);
      const sy=940-((age%1.6)/1.6)*700;ctx.fillStyle=palette.value('signal');ctx.fillRect(616,sy,22,90);ctx.fillStyle=palette.value('bone');ctx.fill(markL);ctx.fill(markR);ctx.restore();
      ctx.font='500 9px "Martian Mono Variable", ui-monospace, monospace';ctx.textAlign='center';ctx.fillStyle=palette.alpha('bone',.85);ctx.fillText('ROUTER',cx,cy+46);
    };
    const loop=now=>{draw(now);if(running)raf=requestAnimationFrame(loop)};
    const start=()=>{if(running||reduced)return;running=true;raf=requestAnimationFrame(loop)};const stop=()=>{running=false;cancelAnimationFrame(raf)};
    layout();if(reduced){t0=performance.now()-1500;draw(performance.now())}
    const ro=new ResizeObserver(()=>{layout();if(!running)draw(performance.now())});ro.observe(canvas);
    const io=new IntersectionObserver(([e])=>e.isIntersecting&&!document.hidden?start():stop());io.observe(canvas);
    const vis=()=>document.hidden?stop():start();document.addEventListener('visibilitychange',vis);
    const move=e=>{pointer.tx=(e.clientX/innerWidth-.5)*2;pointer.ty=(e.clientY/innerHeight-.5)*2};addEventListener('pointermove',move,{passive:true});
    return()=>{stop();ro.disconnect();io.disconnect();document.removeEventListener('visibilitychange',vis);removeEventListener('pointermove',move)};
  },[]);
  return <canvas ref={ref} className="route-field" aria-hidden="true"/>;
}
