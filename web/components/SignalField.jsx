'use client';
import { canvasColors } from '../lib/canvas-colors.js'; // C126
import {useEffect,useRef} from 'react';

/** Footer canvas: a curtain of signal bars hanging from the top edge, swaying with time and the pointer. */
export default function SignalField(){
  const ref=useRef(null);
  useEffect(()=>{
    const canvas=ref.current,ctx=canvas.getContext('2d');const palette=canvasColors(canvas);const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
    let w=0,h=0,dpr=1,bars=[],raf=0,running=false,px=-1e4;const t0=performance.now();
    const layout=()=>{const r=canvas.getBoundingClientRect();w=r.width;h=r.height;dpr=Math.min(2,devicePixelRatio||1);canvas.width=w*dpr;canvas.height=h*dpr;const gap=w<700?5:4;bars=Array.from({length:Math.ceil(w/gap)},(_,i)=>({x:i*gap,seed:Math.random()*100,green:Math.random()<.035,thin:Math.random()<.3}))};
    const draw=now=>{const t=(now-t0)/1000;ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
      for(const b of bars){const u=b.x/w;const env=Math.max(0,(u-.38)/.62);if(env<=0&&!b.green)continue;
        const n=Math.sin(b.seed+t*.6)*.5+Math.sin(b.seed*1.7+t*1.3+u*9)*.3+Math.sin(u*23-t*.8)*.2;
        const near=Math.max(0,1-Math.abs(b.x-px)/140);
        const len=h*(Math.pow(env,1.4)*(.55+.35*n)+near*.18)*(b.green?1.08:1);
        if(len<2)continue;ctx.fillStyle=b.green?palette.alpha('signal',.95):palette.alpha('bone',.25+env*.6);ctx.fillRect(b.x,0,b.thin?1:2,len)}
    };
    const loop=now=>{draw(now);if(running)raf=requestAnimationFrame(loop)};const start=()=>{if(running||reduced)return;running=true;raf=requestAnimationFrame(loop)};const stop=()=>{running=false;cancelAnimationFrame(raf)};
    layout();draw(performance.now());
    const ro=new ResizeObserver(()=>{layout();draw(performance.now())});ro.observe(canvas);
    const io=new IntersectionObserver(([e])=>e.isIntersecting?start():stop());io.observe(canvas);
    const move=e=>{const r=canvas.getBoundingClientRect();px=e.clientX-r.left};const leave=()=>{px=-1e4};const host=canvas.parentElement;host.addEventListener('pointermove',move);host.addEventListener('pointerleave',leave);
    return()=>{stop();ro.disconnect();io.disconnect();host.removeEventListener('pointermove',move);host.removeEventListener('pointerleave',leave)};
  },[]);
  return <canvas ref={ref} className="signal-field" aria-hidden="true"/>;
}
