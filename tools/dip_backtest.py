# Backtest of dip-buying ladders on every 10%+ S&P 500 drop since 1928 (used to size the Buy Alert steps).
# Usage: curl -s -A "Mozilla/5.0" "https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?period1=-1400000000&period2=$(date +%s)&interval=1d" -o gspc.json && python3 tools/dip_backtest.py gspc.json
import json,sys,datetime,math,statistics as stt
j=json.load(open(sys.argv[1]))['chart']['result'][0]
T=[];P=[]
for t,c in zip(j['timestamp'],j['indicators']['quote'][0]['close']):
    if c: T.append(t);P.append(c)
n=len(P); DIV=0.02/252; CASH=0.03/252
# total-return index (price + ~2%/yr dividends)
TR=[P[0]];
for i in range(1,n): TR.append(TR[-1]*P[i]/P[i-1]*(1+DIV))
# episodes: first close >=10% below running high, until a new high
eps=[];pk=P[0];i=0;inep=False
for k in range(n):
    if P[k]>=pk:
        if inep: eps[-1]['rec']=k; inep=False
        pk=P[k]; pki=k; continue
    if not inep and P[k]<=pk*0.9: eps.append({'peak':pk,'start':k,'rec':None,'pki':pki}); inep=True
for e in eps:
    end=e['rec'] or n-1; e['depth']=min(P[e['start']:end+1])/e['peak']-1
STRATS={
 'Current 5/5/10/10 at -10/15/20/30':[(10,1/6),(15,1/6),(20,1/3),(30,1/3)],
 'All at -10%':[(10,1)],
 'Half at -10, half at -20':[(10,.5),(20,.5)],
 'Thirds at -10/-20/-30':[(10,1/3),(20,1/3),(30,1/3)],
 'Front-loaded 50/25/25 at -10/20/30':[(10,.5),(20,.25),(30,.25)],
 'Wait: half at -20, half at -30':[(20,.5),(30,.5)],
}
def run(e,steps,H):
    s=e['start']; end=min(n-1,s+H); val=0.0; cash=1.0; done=set()
    # walk days; deploy cash at thresholds (measured from the episode's peak)
    for k in range(s,end+1):
        if k>s: cash*= (1+CASH)
        dd=(1-P[k]/e['peak'])*100
        for lvl,fr in steps:
            if lvl not in done and dd>=lvl and (e['rec'] is None or k<e['rec']):
                done.add(lvl); val+= fr*TR[end]/TR[k]; cash-=fr*(1+CASH)**0  # spend fraction now
    # cash left earns until 'end' (approximation: cash compounding already applied before deployment)
    unused=sum(fr for l,fr in steps if l not in done)
    return val+cash- (1-unused)*0 , unused
print('episodes:',len(eps))
for e in eps: print(' ',datetime.datetime.fromtimestamp(T[e['pki']],datetime.UTC).year, f"{e['depth']*100:.0f}%", 'recovered' if e['rec'] else 'ongoing', (datetime.datetime.fromtimestamp(T[e['rec']],datetime.UTC)-datetime.datetime.fromtimestamp(T[e['pki']],datetime.UTC)).days//30 if e['rec'] else '', 'mo')
for H,lab in [(252,'1y'),(756,'3y'),(1260,'5y')]:
    print('\n== value of $1 budget',lab,'after first -10% day (full episodes only)')
    full=[e for e in eps if e['start']+H<n]
    for name,st in STRATS.items():
        r=[run(e,st,H) for e in full]; v=[x[0] for x in r]
        print(f"{name:40s} avg {stt.mean(v):.3f}  median {stt.median(v):.3f}  worst {min(v):.3f}  best {max(v):.3f}  avg unused {stt.mean(x[1] for x in r)*100:.0f}%")
