'use client';
import {useEffect,useState} from 'react';
import {API_BASE} from '../lib/api';

// The router's onion address, read from GET /api/v1/status (data.onion.address). The docs page is static, so the address
// cannot be baked in at build time; it is whatever the router this page is served by (or NEXT_PUBLIC_ANYROUTE_API_URL) says.
const ONION=/^[a-z2-7]{56}\.onion$/;

export default function OnionAddress(){
  const [state,setState]=useState({phase:'loading',address:''});
  useEffect(()=>{
    const ac=new AbortController();
    fetch(API_BASE+'/api/v1/status',{signal:ac.signal,headers:{accept:'application/json'}})
      .then(async res=>{
        if(!res.ok)throw new Error('status '+res.status);
        const address=(await res.json())?.data?.onion?.address;
        setState(ONION.test(address||'')?{phase:'ready',address}:{phase:'none',address:''});
      })
      .catch(e=>{if(e?.name!=='AbortError')setState({phase:'error',address:''})});
    return()=>ac.abort();
  },[]);
  return <div className="note" role="status">
    {state.phase==='loading'&&'Reading this router’s status…'}
    {state.phase==='ready'&&<>This router’s onion address: <code className="mono">{state.address}</code> (use it as http://{state.address}, with /api/v1 after it).</>}
    {state.phase==='none'&&'This router does not publish an onion address.'}
    {state.phase==='error'&&'The router’s status could not be read, so its onion address is not shown. GET /api/v1/status carries it as onion.address when there is one.'}
  </div>;
}
