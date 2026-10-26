import http from 'k6/http';
import { Counter, Rate, Trend } from 'k6/metrics';
import { SharedArray } from 'k6/data';
const assets = new SharedArray('assets', () => JSON.parse(open('./source/dist/build-manifest.json')).initialAssets);
const duration = new Trend('workflow_ms', true);
const successfulDuration = new Trend('successful_workflow_ms', true);
const success = new Rate('workflow_success');
const started = new Counter('workflows_started');
const finished = new Counter('workflows_finished');
const ok200 = new Counter('response_200');
const bad = new Counter('response_failure');
const h2 = new Rate('response_h2');
const deadlineFailures = new Counter('workflow_deadline_failure');
const requestCount = new Counter('workflow_requests');
const mode = __ENV.CASE || 'burst';
const count = Number(__ENV.COUNT || 1000);
export const options = {
  insecureSkipTLSVerify: true, noVUConnectionReuse: true,
  discardResponseBodies: true, batch: 6, batchPerHost: 6,
  summaryTrendStats: ['avg','min','med','max','p(90)','p(95)','p(99)'],
  systemTags: ['status','proto','error_code','scenario','expected_response'],
  scenarios: mode === 'paced' ? {page:{executor:'constant-arrival-rate',rate:1000,timeUnit:'60s',duration:'60s',preAllocatedVUs:100,maxVUs:1000,gracefulStop:'20s'}} : {page:{executor:'per-vu-iterations',vus:count,iterations:1,maxDuration:'60s',gracefulStop:'20s'}},
};
function record(r) {
  requestCount.add(1);
  const ok = r.status === 200 && !r.error;
  if(ok) ok200.add(1); else bad.add(1,{status:String(r.status),error_code:String(r.error_code || 0)});
  h2.add(r.proto === 'HTTP/2.0');
  return ok;
}
export default function () {
  const began = Date.now(), end = began + 15000;
  started.add(1);
  let valid = true, received = 0;
  const params = () => ({headers:{'Accept-Encoding':'br, gzip'},timeout:Math.max(1,end-Date.now())+'ms',redirects:0});
  const first = http.get('https://localhost:8443/', params());
  valid = record(first) && valid; received++;
  if(mode === 'probe') console.log(JSON.stringify({status:first.status,proto:first.proto,tls:first.tls_version,encoding:first.headers['Content-Encoding'],assets:assets.length}));
  for(let i=0;i<assets.length && Date.now()<end;i+=6) {
    const p=params();
    const responses = http.batch(assets.slice(i,i+6).map(path=>({method:'GET',url:'https://localhost:8443'+path,params:p})));
    for(const r of responses) { valid=record(r)&&valid; received++; }
  }
  const elapsed = Date.now()-began;
  valid = valid && received === assets.length+1 && elapsed <=15000;
  if(elapsed>=15000 || received!==assets.length+1) deadlineFailures.add(1);
  duration.add(elapsed); success.add(valid); finished.add(1);
  if(valid) successfulDuration.add(elapsed);
}
export function handleSummary(data) {return {['/bench/'+mode+'.summary.json']:JSON.stringify(data,null,2)};}
