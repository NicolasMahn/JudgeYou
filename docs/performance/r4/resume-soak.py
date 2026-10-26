#!/usr/bin/env python3
"""Resume only the lower-memory soak after a host guard stops the burst sequence."""
import pathlib
runner=pathlib.Path(__file__).with_name('run.py')
exec(compile(runner.read_text().split('BASELINE=[]\ntry:')[0],str(runner),'exec'))
BASELINE=[]
try:
 BASELINE=health()['production']
 # Prior measured sequence used 40.04 s; this continuation retains a combined <=360 s cap.
 DEADLINE=START+319
 write('soak-continuation.json',{'at':utc(),'priorRunnerElapsedSeconds':40.04,'remainingBudgetSeconds':319,'higherBurstSkipped':'1 GiB origin burst aborted by host available-memory guard; no retry or 2000 burst'})
 case('soak-1000pm-512m','512m',1000,'paced')
except Exception as e:
 write('SOAK-ABORT.json',{'at':utc(),'error':str(e)});print('ABORT',str(e),flush=True)
finally:
 for name in list(OWNED):
  (D/('soak-cleanup-'+name+'.console.txt')).write_text(docker('logs',name,check=False))
  remove(name)
 try:write('soak-health-after.json',health())
 except Exception as e:write('soak-health-after-error.json',{'error':str(e)})
 write('soak-cleanup.json',{'at':utc(),'elapsedSeconds':time.monotonic()-START,'ownedNames':[ORIGIN,GEN],'remaining':docker('ps','-a','--filter','name='+PREFIX,'--format','{{.Names}}')})
