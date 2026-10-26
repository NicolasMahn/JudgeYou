#!/usr/bin/env python3
"""Run only owned disposable containers on the existing host; never configure production."""
import datetime, hashlib, json, os, pathlib, subprocess, sys, time
D=pathlib.Path(__file__).resolve().parent
BASE=pathlib.Path('/tmp/judgeyou-h2-independent-c1Ksrvpc')
PREFIX='judgeyou-r4-'+D.name.rsplit('-',1)[-1]
ORIGIN=PREFIX+'-origin'; GEN=PREFIX+'-gen'
IMAGE=(D/'image').read_text().strip()
START=time.monotonic(); DEADLINE=START+360
OWNED=set()
def utc(): return datetime.datetime.now(datetime.timezone.utc).isoformat()
def run(args, timeout=15, check=True):
 p=subprocess.run(args,capture_output=True,text=True,timeout=timeout)
 if check and p.returncode: raise RuntimeError(str(args[:3])+': '+p.stderr[-2000:])
 return (p.stdout+(p.stderr if len(args)>1 and args[1]=='logs' else '')).strip()
def write(name,value): (D/name).write_text(json.dumps(value,indent=2)+'\n')
def docker(*args,**kw):return run(['docker',*args],**kw)
def inspect(name): return json.loads(docker('inspect',name))[0]
def cg(name):
 pid=inspect(name)['State']['Pid']
 group=pathlib.Path(f'/proc/{pid}/cgroup').read_text().split('0::',1)[1].strip()
 return pathlib.Path('/sys/fs/cgroup'+group)
def read(p,f):
 try:return (p/f).read_text().strip()
 except FileNotFoundError:return None
def fields(s):return {k:int(v) for k,v in (x.split() for x in s.splitlines())} if s else None
def sample(name,group):
 procs=[]
 for pid in (read(group,'cgroup.procs') or '').split():
  try:
   s=pathlib.Path('/proc',pid,'stat').read_text(); rest=s[s.rfind(')')+2:].split()
   status=pathlib.Path('/proc',pid,'status').read_text().splitlines()
   procs.append({'pid':int(pid),'comm':s[s.index('(')+1:s.rfind(')')],'state':rest[0], 'utimeTicks':int(rest[11]),'stimeTicks':int(rest[12]),'startTicks':int(rest[19]), 'rssBytes':int(rest[21])*os.sysconf('SC_PAGE_SIZE'),'vmHwmKiB':next((int(x.split()[1]) for x in status if x.startswith('VmHWM:')),None)})
  except (FileNotFoundError,ProcessLookupError):pass
 return {'at':utc(),'container':name,'memoryCurrent':int(read(group,'memory.current') or 0),'memoryPeak':int(read(group,'memory.peak') or 0),'memoryEvents':fields(read(group,'memory.events')),'cpu':fields(read(group,'cpu.stat')),'processes':procs}
def health():
 available=int(next(x.split()[1] for x in pathlib.Path('/proc/meminfo').read_text().splitlines() if x.startswith('MemAvailable:')))*1024
 states=[]
 for name in ['judgeyou','av-stuttgart-caddy','av-stuttgart-app']:
  x=inspect(name); states.append({'name':name,'running':x['State']['Running'],'health':x['State'].get('Health',{}).get('Status'),'restartCount':x['RestartCount'],'id':x['Id']})
 responses={}
 for domain in ['judge-you.de','acvi-stuttgart.de']:
  responses[domain]=run(['curl','-sS','--max-time','2','--resolve',domain+':443:127.0.0.1','-o','/dev/null','-w','%{http_code}', 'https://'+domain+'/'],timeout=3,check=False)
 value={'at':utc(),'availableBytes':available,'production':states,'http':responses}
 with (D/'health.jsonl').open('a') as f:f.write(json.dumps(value)+'\n')
 if available<=1073741824:raise RuntimeError('MemAvailable <= 1 GiB')
 if any(not x['running'] or x['health']=='unhealthy' for x in states) or any(x!='200' for x in responses.values()):raise RuntimeError('Production health guard failed')
 if BASELINE and states!=BASELINE:raise RuntimeError('Production container state/restart changed')
 return value
def remove(name):
 if name in OWNED:
  docker('rm','-f',name,check=False); OWNED.discard(name)
def start_origin(memory):
 OWNED.add(ORIGIN)
 docker('run','-d','--name',ORIGIN,'--user','0:0','--network','none','--cpus','1','--memory',memory,'--memory-swap',memory,'--pids-limit','256','--tmpfs','/tmp:rw,size=64m','-e','PUBLIC_DIR=/bench/source/dist','-e','HOME=/tmp','-e','XDG_DATA_HOME=/tmp/caddy-data','-e','XDG_CONFIG_HOME=/tmp/caddy-config','-v',str(D)+':/bench:ro','-w','/bench/source','--entrypoint','sh',IMAGE,'/bench/origin.sh')
 # Wait for both listeners and warm exactly one complete graph in a separate k6 process.
 docker('exec',ORIGIN,'node','--input-type=module','-e',"import https from 'node:https'; let n=0; const go=()=>https.get('https://127.0.0.1:8443/',{rejectUnauthorized:false,servername:'localhost'},r=>{r.resume();if(r.statusCode!==200)process.exit(1)}).on('error',()=>{if(++n>40){console.error('readiness failed');process.exit(1)};setTimeout(go,100)});go();",timeout=8)
 docker('run','--rm','--user','0:0','--network','container:'+ORIGIN,'--cpus','1','--memory','1g','--memory-swap','1g','--pids-limit','256','-e','CASE=probe','-e','COUNT=1','-e','NAME=probe','-e','K6_NO_USAGE_REPORT=true','-v',str(D)+':/bench','-w','/bench','--entrypoint','/bench/k6-v1.3.0-linux-arm64/k6',IMAGE,'run','--quiet','/bench/load.js',timeout=12)
def case(name,memory,count,mode='burst'):
 if DEADLINE-time.monotonic() < (195 if mode=='paced' else 35):raise RuntimeError('Total six-minute experiment budget would be exceeded')
 health(); start_origin(memory)
 write(name+'.origin.inspect.json',inspect(ORIGIN)); origin_cg=cg(ORIGIN)
 write(name+'.origin.before.json',sample(ORIGIN,origin_cg))
 OWNED.add(GEN)
 docker('run','-d','--name',GEN,'--user','0:0','--network','container:'+ORIGIN,'--cpus','1','--memory','1g','--memory-swap','1g','--pids-limit','256','-e','CASE='+mode,'-e','COUNT='+str(count),'-e','NAME='+name,'-e','DURATION=180s','-e','K6_NO_USAGE_REPORT=true','-e','GOMEMLIMIT=850MiB','-v',str(D)+':/bench','-w','/bench','--entrypoint','/bench/k6-v1.3.0-linux-arm64/k6',IMAGE,'run','--quiet','--address','127.0.0.1:6565','--out','json=/bench/'+name+'.raw.jsonl','/bench/load.js')
 write(name+'.generator.inspect.json',inspect(GEN)); generator_cg=cg(GEN)
 next_health=time.monotonic(); next_running=0; running=True
 with (D/(name+'.resources.jsonl')).open('w') as f:
  while running:
   now=time.monotonic()
   if now>=DEADLINE:raise RuntimeError('Six-minute experiment deadline')
   if now>=next_health:health();next_health=now+5
   # Available-memory check at every sample; site health checks every 5 seconds.
   available=int(next(x.split()[1] for x in pathlib.Path('/proc/meminfo').read_text().splitlines() if x.startswith('MemAvailable:')))*1024
   if available<=1073741824:raise RuntimeError('MemAvailable <= 1 GiB')
   for container,group in [(ORIGIN,origin_cg),(GEN,generator_cg)]:f.write(json.dumps(sample(container,group))+'\n')
   f.flush()
   if now>=next_running:running=inspect(GEN)['State']['Running'];next_running=now+.5
   time.sleep(.2)
 write(name+'.origin.after.json',sample(ORIGIN,origin_cg))
 write(name+'.generator.state.json',inspect(GEN)['State'])
 (D/(name+'.console.txt')).write_text(docker('logs',GEN))
 remove(GEN)
 docker('stop','-t','3',ORIGIN,timeout=6)
 (D/(name+'.origin.console.jsonl')).write_text(docker('logs',ORIGIN))
 write(name+'.origin.state.json',inspect(ORIGIN)['State']);remove(ORIGIN)
 health()
 data=json.loads((D/(name+'.summary.json')).read_text())
 result={'name':name,'memory':memory,'finishedAt':utc(),'metrics':data['metrics']}
 print(json.dumps(result),flush=True)
 return result
BASELINE=[]
try:
 BASELINE=health()['production']
 write('provenance.json',{'startedAt':utc(),'sourceCommit':'d05c8b7','image':IMAGE,'originCpu':1,'generatorCpu':1,'generatorMemoryBytes':1073741824,'hostGuardAvailableBytes':1073741824,'deadlineSeconds':360,'processSampleSeconds':.2,'healthCheckSeconds':5,'procClockTicksPerSecond':os.sysconf('SC_CLK_TCK'),'originNetwork':'none','generatorNetwork':'container:origin','publishedPorts':[],'baselineProduction':BASELINE})
 case('burst-300-512m','512m',300)
 case('burst-1000-512m','512m',1000)
 result=case('burst-1000-1g','1g',1000)
 peak=json.loads((D/'burst-1000-1g.origin.after.json').read_text())['memoryPeak']
 if result['metrics']['workflow_success']['values']['rate']==1 and peak<.7*1073741824 and DEADLINE-time.monotonic()>235:
  case('burst-2000-1g','1g',2000)
 else:write('optional-2000-skipped.json',{'reason':'1000 success, origin <70% memory and time budget with soak required','originPeakBytes':peak,'remainingSeconds':DEADLINE-time.monotonic()})
 case('soak-1000pm-512m','512m',1000,'paced')
except Exception as e:
 write('ABORT.json',{'at':utc(),'error':str(e)});print('ABORT',str(e),flush=True)
finally:
 for name in list(OWNED):
  (D/('cleanup-'+name+'.console.txt')).write_text(docker('logs',name,check=False))
  remove(name)
 try:write('health-after.json',health())
 except Exception as e:write('health-after-error.json',{'error':str(e)})
 write('cleanup.json',{'at':utc(),'elapsedSeconds':time.monotonic()-START,'ownedNames':[ORIGIN,GEN],'remaining':docker('ps','-a','--filter','name='+PREFIX,'--format','{{.Names}}')})
