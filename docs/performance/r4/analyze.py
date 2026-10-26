#!/usr/bin/env python3
"""Reduce k6 streams and proc/cgroup samples without hiding failed requests."""
import collections, datetime, hashlib, json, pathlib, sys
D=pathlib.Path(sys.argv[1] if len(sys.argv)>1 else '.')
def get(p):return json.loads(p.read_text())
def percentile(values,p):
 if not values:return None
 v=sorted(values); n=(len(v)-1)*p; lo=int(n);return v[lo]+(v[min(lo+1,len(v)-1)]-v[lo])*(n-lo)
def iso(t):return datetime.datetime.fromisoformat(t.replace('Z','+00:00')).timestamp()
out={'remoteEvidence':str(D),'cases':[],'rawStreams':[]}
for path in sorted(D.glob('*.summary.json')):
 name=path.name[:-13]
 if name=='probe':continue
 s=get(path); metrics=s['metrics']; raw=D/(name+'.raw.jsonl')
 statuses=collections.Counter(); errors=collections.Counter(); starts=[];success_ms=[];fail_ms=[];positive_tls=0;minute=collections.defaultdict(lambda:{'requests':0,'statuses':collections.Counter(),'successfulWorkflows':0,'failedWorkflows':0})
 first=None
 for line in raw.open():
  x=json.loads(line)
  if x.get('type')!='Point':continue
  m=x['metric']; d=x['data']; v=d['value']; t=iso(d['time'])
  if m=='workflows_started':
   starts.append(t)
   if first is None:first=t
  bucket=int((t-first)//60) if first else 0
  if m=='all_http_statuses':
   statuses[d['tags']['status']]+=v;errors[d['tags'].get('error_code','0')]+=v;minute[bucket]['requests']+=v;minute[bucket]['statuses'][d['tags']['status']]+=v
  elif m=='successful_workflow_ms':success_ms.append(v);minute[bucket]['successfulWorkflows']+=1
  elif m=='failed_workflow_ms':fail_ms.append(v);minute[bucket]['failedWorkflows']+=1
  elif m=='http_req_tls_handshaking' and v>0:positive_tls+=1
 samples=[json.loads(l) for l in (D/(name+'.resources.jsonl')).open()]
 origin_name=get(D/(name+'.origin.inspect.json'))['Name'].lstrip('/')
 origin=[x for x in samples if x['container']==origin_name]; gen=[x for x in samples if x['container']!=origin_name]
 before=get(D/(name+'.origin.before.json'));after=get(D/(name+'.origin.after.json'))
 perproc={}; timeline=[]
 for role,data in [('origin',origin),('generator',gen)]:
  groups=collections.defaultdict(list)
  for sample in data:
   for proc in sample['processes']:groups[(proc['pid'],proc['comm'],proc['startTicks'])].append((sample['at'],proc))
  for (pid,comm,start),observations in groups.items():
   firstProc=observations[0][1];lastProc=observations[-1][1]
   perproc[f'{role}:{comm}:{pid}']={'samples':len(observations),'firstAt':observations[0][0],'lastAt':observations[-1][0],'sampledPeakRssBytes':max(p['rssBytes'] for _,p in observations),'observedPeakVmHwmKiB':max((p['vmHwmKiB'] or 0) for _,p in observations),'sampledCpuSecondsDelta':((lastProc['utimeTicks']+lastProc['stimeTicks'])-(firstProc['utimeTicks']+firstProc['stimeTicks']))/get(D/'provenance.json')['procClockTicksPerSecond'],'firstState':firstProc['state'],'lastState':lastProc['state']}
 prev=None
 for x in origin:
  current=(x['memoryEvents'] or {}).get('oom_kill')
  if prev is not None and current is not None and current>prev:timeline.append({'at':x['at'],'oomKill':current,'processes':x['processes']})
  prev=current
 soak=[]
 if origin:
  start=iso(origin[0]['at'])
  for minuteIndex in range(3):
   values=[x for x in origin if minuteIndex*60<=iso(x['at'])-start<(minuteIndex+1)*60]
   if values:soak.append({'minute':minuteIndex+1,'memoryFirst':values[0]['memoryCurrent'],'memoryLast':values[-1]['memoryCurrent'],'memoryMax':max(x['memoryCurrent'] for x in values),'nodeRssMax':max((p['rssBytes'] for x in values for p in x['processes'] if p['comm']=='node'),default=0),'caddyRssMax':max((p['rssBytes'] for x in values for p in x['processes'] if p['comm']=='caddy'),default=0)})
 def vals(m):return metrics.get(m,{}).get('values',{})
 result={'case':name,'generatorExitCode':get(D/(name+'.generator.state.json'))['ExitCode'],'started':vals('workflows_started').get('count',0),'finished':vals('workflows_finished').get('count',0),'successful':len(success_ms),'failed':len(fail_ms),'successfulP95Ms':percentile(success_ms,.95),'failedP95Ms':percentile(fail_ms,.95),'workflowAll':vals('workflow_ms'),'startsSpreadSeconds':max(starts)-min(starts) if starts else None,'httpStatuses':dict(statuses),'requestErrorCodes':dict(errors),'positiveTlsHandshakeSamples':positive_tls,'h2':vals('response_h2'),'droppedIterations':vals('dropped_iterations').get('count',0),'deadlineFailures':vals('workflow_deadline_failure').get('count',0),'thresholds':{m:d['thresholds'] for m,d in metrics.items() if 'thresholds' in d},'originBefore':before,'originAfter':after,'originCpuDelta':{k:after['cpu'][k]-before['cpu'][k] for k in before['cpu']} if after['cpu'] else None,'originMemoryEventsDelta':{k:after['memoryEvents'][k]-before['memoryEvents'][k] for k in before['memoryEvents']} if after['memoryEvents'] else None,'originCgroupDisappearedBeforeFinalRead':after['memoryEvents'] is None,'originLastReadableSample':next((x for x in reversed(origin) if x['memoryEvents']),None),'generatorSampledPeakMemory':max(x['memoryPeak'] for x in gen),'generatorLastMemoryEvents':gen[-1]['memoryEvents'],'processes':perproc,'oomObservedTransitions':timeline,'originMemoryByMinute':soak,'workflowResponseByMinute':dict(minute)}
 out['cases'].append(result)
 out['rawStreams'].append({'name':raw.name,'bytes':raw.stat().st_size,'sha256':hashlib.file_digest(raw.open('rb'),'sha256').hexdigest()})
out['incompleteCases']=[]
for raw in sorted(D.glob('burst*.raw.jsonl')):
 name=raw.name[:-10]
 if (D/(name+'.summary.json')).exists():continue
 counts=collections.Counter();status=collections.Counter();errors=collections.Counter();badLines=0
 for line in raw.open():
  try:x=json.loads(line)
  except json.JSONDecodeError:badLines+=1;continue
  if x.get('type')!='Point':continue
  m=x['metric'];d=x['data']
  if m in ['workflows_started','workflows_finished','workflow_requests']:counts[m]+=d['value']
  if m=='workflow_success':counts['successful' if d['value'] else 'failed']+=1
  if m=='all_http_statuses':status[d['tags']['status']]+=d['value'];errors[d['tags'].get('error_code','0')]+=d['value']
 samples=[json.loads(l) for l in (D/(name+'.resources.jsonl')).open()]
 peaks={};processPeaks={}
 for x in samples:
  peaks[x['container']]=max(peaks.get(x['container'],0),x['memoryPeak'])
  for proc in x['processes']:processPeaks[proc['comm']]=max(processPeaks.get(proc['comm'],0),proc['rssBytes'])
 out['incompleteCases'].append({'case':name,'reason':'Host MemAvailable guard <=1 GiB; containers forcibly removed before completion; no valid capacity result','rawStreamCountsLowerBounds':dict(counts),'rawStreamHttpStatusesLowerBounds':dict(status),'rawStreamRequestErrorsLowerBounds':dict(errors),'invalidTrailingJsonLines':badLines,'sampledContainerPeaks':peaks,'sampledProcessRssPeaks':processPeaks,'lastSamples':samples[-2:]})
 out['rawStreams'].append({'name':raw.name,'bytes':raw.stat().st_size,'sha256':hashlib.file_digest(raw.open('rb'),'sha256').hexdigest()})
(D/'outcome.json').write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps([{k:v for k,v in x.items() if k in ['case','started','finished','successful','failed','successfulP95Ms','failedP95Ms','httpStatuses','originMemoryEventsDelta','startsSpreadSeconds']} for x in out['cases']],indent=2))
