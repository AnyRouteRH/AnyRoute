'use client';
import {useEffect,useRef,useState} from 'react';

// $ANYR on Robinhood Chain (4663): name "Anyroute", symbol "ANYR", 18 decimals.
export const ANYR_CA='0xa4dDF89A40A35264E9D7F896a1ef01C59b1e977a';

export default function ContractAddress(){
  const [status,setStatus]=useState('');
  const value=useRef(null);
  useEffect(()=>{if(!status)return;const t=setTimeout(()=>setStatus(''),1800);return()=>clearTimeout(t)},[status]);
  const copy=async()=>{
    try{await navigator.clipboard.writeText(ANYR_CA);setStatus('Copied')}
    catch{const r=document.createRange();r.selectNodeContents(value.current);const s=getSelection();s.removeAllRanges();s.addRange(r);setStatus('Selected')}
  };
  return <div className="ca">
    <button type="button" className={'ca-field'+(status==='Copied'?' copied':'')} onClick={copy} title="Copy contract address">
      <span className="ca-label">$ANYR CA</span>
      <code className="ca-value" ref={value}>{ANYR_CA}</code>
      <code className="ca-short" aria-hidden="true">{ANYR_CA.slice(0,6)}…{ANYR_CA.slice(-4)}</code>
      <span className="ca-action" aria-hidden="true">{status||'Copy'}</span>
    </button>
    <span className="sr-only" role="status">{status==='Copied'?'Contract address copied':''}</span>
  </div>;
}
