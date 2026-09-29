'use client';
import {useEffect,useRef,useState} from 'react';
import {Wordmark} from './Logo';

export function Button({children,href,secondary=false,light=false,className='',...props}){const cls='ar-button'+(secondary?' secondary':'')+(light?' light':'')+(className?' '+className:'');const inner=<>{!secondary&&<i aria-hidden="true"/>}<span>{children}</span><b aria-hidden="true">→</b></>;return href?<a className={cls} href={href} {...props}>{inner}</a>:<button className={cls} {...props}>{inner}</button>}

export function Brand(){return <a href="/" className="brand" aria-label="Anyroute home"><Wordmark aria-hidden="true" title=""/></a>}

const LINKS=[['Models','/models/'],['Harness','/harness/'],['Arena','/arena/'],['Docs','/docs/'],['SEAL','/seal/'],['Case study','/case-study/'],['Roadmap','/#roadmap'],['About','/#about']];

/** Fixed header: dark over dark heroes, hides on scroll down, returns on scroll up. */
export function Header({app=false}){
  const [open,setOpen]=useState(false);const [tone,setTone]=useState('light');const [hidden,setHidden]=useState(false);const button=useRef(null);const [path,setPath]=useState('');
  useEffect(()=>{setPath(location.pathname);let last=scrollY,raf=0;const update=()=>{raf=0;const hero=document.querySelector('[data-dark-hero]');const y=scrollY;setTone(hero&&hero.getBoundingClientRect().bottom>40?'dark':'light');setHidden(y>last&&y>480);last=y};const on=()=>{if(!raf)raf=requestAnimationFrame(update)};update();addEventListener('scroll',on,{passive:true});addEventListener('resize',on);return()=>{removeEventListener('scroll',on);removeEventListener('resize',on);cancelAnimationFrame(raf)}},[]);
  useEffect(()=>{const close=e=>{if(e.key==='Escape'&&open){setOpen(false);button.current?.focus()}};document.addEventListener('keydown',close);document.documentElement.style.overflow=open?'hidden':'';return()=>{document.removeEventListener('keydown',close);document.documentElement.style.overflow=''}},[open]);
  return <><a className="skip" href="#content">Skip to content</a><header className={'site-header'+(open?' expanded':'')} data-tone={tone} data-hidden={hidden}><nav aria-label="Main navigation"><div className="nav-left"><Brand/><div className="desktop-links">{LINKS.map(([label,url])=><a key={label} href={url} aria-current={path&&url.startsWith(path)&&path!=='/'?'page':undefined}>{label}</a>)}</div></div><div className="nav-buttons"><Button href={app?'/docs/':'/dashboard/'}>{app?'Read docs':'Open dashboard'}</Button><Button href={app?'/':'/docs/'} secondary>{app?'Website':'API docs'}</Button></div><button ref={button} className="menu-toggle" aria-label={open?'Close menu':'Open menu'} aria-expanded={open} aria-controls="mobile-menu" onClick={()=>setOpen(!open)}><span/><span/></button></nav>{open&&<div className="mobile-menu" id="mobile-menu">{[['Home','/'],...LINKS].map(([label,url],i)=><a key={label} href={url} style={{'--i':i}} onClick={()=>setOpen(false)}><small>0{i+1}</small>{label}</a>)}<div className="button-row"><Button href="/dashboard/" light>Open dashboard</Button><Button href="/docs/" secondary>API docs</Button></div></div>}</header></>;
}

/** Page-wide motion: scroll reveals, count-ups, cursor spotlights and scroll progress. Respects reduced motion. */
export function MotionManager(){
  useEffect(()=>{
    const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
    document.querySelectorAll('[data-stagger]').forEach(parent=>[...parent.children].forEach((child,i)=>child.style.setProperty('--i',i)));
    const count=el=>{const target=Number(el.dataset.count);const decimals=Number(el.dataset.decimals||0);const fmt=v=>v.toLocaleString('en-US',{minimumFractionDigits:decimals,maximumFractionDigits:decimals});if(reduced){el.textContent=fmt(target);return}const start=performance.now(),dur=1600;const step=t=>{const p=Math.min(1,(t-start)/dur);el.textContent=fmt(target*(1-Math.pow(1-p,4)));if(p<1)requestAnimationFrame(step)};requestAnimationFrame(step)};
    const io=new IntersectionObserver(entries=>entries.forEach(({target,isIntersecting})=>{if(!isIntersecting)return;target.classList.add('is-in');target.querySelectorAll('[data-count]').forEach(count);if(target.dataset.count)count(target);io.unobserve(target)}),{threshold:.14,rootMargin:'0px 0px -6% 0px'});
    const watch=root=>{if(root.nodeType!==1)return;if(root.matches('[data-reveal],[data-inview]')&&!root.classList.contains('is-in'))io.observe(root);root.querySelectorAll('[data-reveal]:not(.is-in),[data-inview]:not(.is-in)').forEach(el=>io.observe(el));root.querySelectorAll('[data-stagger]').forEach(parent=>[...parent.children].forEach((child,i)=>child.style.setProperty('--i',i)))};
    watch(document.body);const mo=new MutationObserver(list=>list.forEach(m=>m.addedNodes.forEach(watch)));mo.observe(document.body,{childList:true,subtree:true});
    const spots=[...document.querySelectorAll('[data-spot]')];const move=e=>{const el=e.currentTarget;const r=el.getBoundingClientRect();el.style.setProperty('--mx',`${e.clientX-r.left}px`);el.style.setProperty('--my',`${e.clientY-r.top}px`)};spots.forEach(el=>el.addEventListener('pointermove',move));
    const bars=[...document.querySelectorAll('[data-progress]')];let raf=0;const progress=()=>{raf=0;const vh=innerHeight;bars.forEach(el=>{const r=el.getBoundingClientRect();const p=Math.min(1,Math.max(0,(vh*.85-r.top)/(r.height+vh*.25)));el.style.setProperty('--p',reduced?1:p.toFixed(3));el.dispatchEvent(new CustomEvent('progress',{detail:p}))})};const onScroll=()=>{if(!raf)raf=requestAnimationFrame(progress)};if(bars.length){progress();addEventListener('scroll',onScroll,{passive:true});addEventListener('resize',onScroll)}
    return()=>{io.disconnect();mo.disconnect();spots.forEach(el=>el.removeEventListener('pointermove',move));removeEventListener('scroll',onScroll);removeEventListener('resize',onScroll);cancelAnimationFrame(raf)};
  },[]);
  return null;
}

/** Text that decodes from noise into its value whenever the value changes. */
export function Scramble({text,className=''}){
  const [out,setOut]=useState(text);
  useEffect(()=>{if(matchMedia('(prefers-reduced-motion: reduce)').matches){setOut(text);return}const glyphs='0123456789abcdef#%/<>_';let frame=0,raf;const total=18;const tick=()=>{frame++;setOut([...text].map((c,i)=>c===' '||i<(frame/total)*text.length?c:glyphs[(Math.random()*glyphs.length)|0]).join(''));if(frame<total)raf=requestAnimationFrame(tick);else setOut(text)};raf=requestAnimationFrame(tick);return()=>cancelAnimationFrame(raf)},[text]);
  return <span className={'scramble '+className}>{out}</span>;
}

export function CopyButton({text,label='Copy'}){const [status,setStatus]=useState('');useEffect(()=>{if(!status)return;const t=setTimeout(()=>setStatus(''),1800);return()=>clearTimeout(t)},[status]);return <button className="text-button" onClick={async()=>{try{await navigator.clipboard.writeText(text);setStatus('Copied')}catch{setStatus('Select and copy below')}}}>{status||label}</button>}

const TOKEN=/(\/\/[^\n]*)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`[^`]*`)|\b(const|let|await|new|import|from|export|default|async|function|return|true|false|null)\b|\b(\d[\d_.]*)\b/g;
/** Minimal JS/JSON highlighter for code samples. */
export function highlight(src){const out=[];let last=0,m,k=0;TOKEN.lastIndex=0;while((m=TOKEN.exec(src))){if(m.index>last)out.push(src.slice(last,m.index));const cls=m[1]?'tok-c':m[2]?'tok-s':m[3]?'tok-k':'tok-n';out.push(<span key={k++} className={cls}>{m[0]}</span>);last=m.index+m[0].length}if(last<src.length)out.push(src.slice(last));return out}

export function Code({children,label='Example request'}){return <div className="code-panel"><div className="code-bar"><span>{label}</span><CopyButton text={children}/></div><pre><code>{highlight(children)}</code></pre></div>}

export function Modal({title,children,onClose}){const ref=useRef(null);useEffect(()=>{const dlg=ref.current;dlg.showModal();return()=>dlg.close()},[]);return <dialog ref={ref} className="modal" onCancel={onClose} onClick={e=>{if(e.target===e.currentTarget)onClose()}} aria-labelledby="modal-title"><div className="modal-head"><h2 id="modal-title">{title}</h2><button aria-label="Close dialog" className="icon-button" onClick={onClose}>×</button></div>{children}</dialog>}
