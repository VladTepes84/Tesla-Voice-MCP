export const freeToXTariffTool = {
  name:'get_free_to_x_card_tariffs',
  description:'Looks up the official public Free To X direct card/POS price list. Returns the source and retrieval time, distinguishing AC, DC, and HPC. This is not an MSP, subscription, or personal flat-rate tariff; it excludes parking surcharges and does not verify the price at an individual connector. Does not contact Tesla or start charging. If the page cannot be interpreted, it does not invent prices.',
  inputSchema:{type:'object',properties:{},additionalProperties:false},
  annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:true},
  securitySchemes:[{type:'oauth2',scopes:['battery:read']}]
};
export const FREE_TO_X_CARD_SOURCE='https://freeto-x.it/metodi-di-pagamento/pagamento-con-carta-di-credito/';

export function parseFreeToXCardTariffs(html) {
  if(typeof html!=='string'||html.length>1048576)throw Error('tariff_provider_unavailable');
  const text=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<[^>]*>/g,' ').replace(/&euro;|&#8364;|&#x20ac;/gi,'€').replace(/&nbsp;|&#160;/g,' ').replace(/\s+/g,' ');
  const start=text.indexOf('Costi di ricarica con carta alle stazioni Free To X');
  if(start<0)throw Error('tariff_provider_unavailable');
  const section=text.slice(start,start+1500).split('Quanto costa ricaricare')[0];
  const labels=[['AC','Corrente Alternata'],['DC','Corrente Continua'],['HPC','Ricarica ad Alta Potenza']];
  return labels.map(([type,label])=>{
    const matches=[...section.matchAll(new RegExp(label+'\\s*€\\s*(\\d{1,2}[,.]\\d{2})\\s*\\/\\s*kWh','g'))];
    if(matches.length!==1)throw Error('tariff_provider_unavailable');
    const rate=Number(matches[0][1].replace(',','.'));
    if(!Number.isFinite(rate)||rate<0||rate>10)throw Error('tariff_provider_unavailable');
    return {type,label:`Free To X ${type} carta/POS`,eurPerKwh:rate,fixedFeeEur:0};
  });
}

export async function getFreeToXCardTariffs({fetcher=fetch,now=Date.now}={}) {
  try {
    const response=await fetcher(FREE_TO_X_CARD_SOURCE,{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(8000),headers:{'user-agent':'TeslaVoiceMCP/1.0'}});
    if(!response.ok||Number(response.headers.get('content-length'))>1048576)throw Error('response');
    const reader=response.body.getReader(),chunks=[];let bytes=0;
    while(true){const {value,done}=await reader.read();if(done)break;bytes+=value.length;if(bytes>1048576){await reader.cancel();throw Error('response');}chunks.push(value);}
    const tariffs=parseFreeToXCardTariffs(Buffer.concat(chunks).toString('utf8'));
    return {source:'FREE_TO_X_OFFICIAL_PUBLIC_CARD_PRICE_LIST',source_url:FREE_TO_X_CARD_SOURCE,retrieved_at:new Date(now()).toISOString(),currency:'EUR',payment_method:'direct_card_POS',tariffs,station_price_verified:false,availability_verified:false,additional_parking_or_idle_fees_included:false,note:'Public price list retrieved; this is not a quote for an individual connector. MSP tariffs and personal plans are separate; check the price shown at the connector before charging.'};
  } catch {throw Error('tariff_provider_unavailable');}
}
