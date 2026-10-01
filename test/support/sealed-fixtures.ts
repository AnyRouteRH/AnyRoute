import { DstackAttestationProvider } from '../../sidecar/src/attestation/dstack.ts';
// Dependency-free guest double for the root suite; the sidecar suite also uses its existing dstack provider fixture.
export function sealedDstackProvider(compose: string) {
 return new DstackAttestationProvider({endpoint:'http://dstack.test',fetchImpl:(async (input:any,init:any)=>{
  const path=new URL(String(input)).pathname, body=JSON.parse(init.body);
  if(path==='/Info')return Response.json({compose_hash:compose});
  if(path==='/GetQuote'){
   const quote=Buffer.alloc(648);quote.writeUInt16LE(4,0);quote.writeUInt32LE(0x81,4);Buffer.from(body.report_data,'hex').copy(quote,568);
   return Response.json({quote:quote.toString('hex'),event_log:JSON.stringify([{imr:3,event:'compose-hash',event_payload:compose.slice(7)}])});
  }
  return new Response('not found',{status:404});
 }) as typeof fetch});
}
