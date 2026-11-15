import test from 'node:test';import assert from 'node:assert/strict';
import {loadGermanStations} from './lib/european-stations.mjs';
const header='Betreiber;Breitengrad;Längengrad;Status;Ladeeinrichtungs-ID;Steckertypen1;Nennleistung Stecker1;EVSE-ID1\n';
const row=id=>'Test;48,1;10,1;In Betrieb;'+id+';DC Fahrzeugkupplung Typ Combo 2 (CCS);150;DE*TEST*'+id+'\n';
for(const valid of [true,false])test('German timeout range resume validates exact byte offset: '+valid,async()=>{
 const encoder=new TextEncoder(),body=encoder.encode(header+row('1')+row('2')),offset=encoder.encode(header+row('1')).length+8;
 let calls=0;
 const fetcher=async(url,options)=>{
  if(url.includes('DownloadundKontakt'))return new Response('<a href="https://data.bundesnetzagentur.de/Bundesnetzagentur/test.csv">CSV</a>');
  calls++;
  if(calls===1){let sent=false;return new Response(new ReadableStream({pull(c){if(!sent){sent=true;c.enqueue(body.slice(0,offset));}else c.error(new DOMException('deadline','TimeoutError'));}}),{headers:{etag:'"fixture-v1"','accept-ranges':'bytes'}});}
  assert.equal(options.headers.range,'bytes='+offset+'-');assert.equal(options.headers['if-range'],'"fixture-v1"');
  return new Response(body.slice(offset),{status:206,headers:{'content-range':'bytes '+(valid?offset:offset+1)+'-'+(body.length-1)+'/'+body.length}});
 };
 const result=await loadGermanStations({fetcher});
 assert.equal(calls,2);assert.equal(result.complete,valid);assert.equal(result.resumed,valid);
 assert.equal(result.stations.length,valid?2:1);
});
