# Forward S&P 500 returns by drawdown band and VIX level since 1990 (used for the Buy Alert fear boost).
# Usage: download ^GSPC (see dip_backtest.py) and ^VIX the same way, then: python3 tools/vix_drawdown_returns.py gspc.json vix.json
import json,sys,statistics as st,datetime
def load(f):
    j=json.load(open(f))['chart']['result'][0];return {datetime.datetime.fromtimestamp(t,datetime.UTC).date():c for t,c in zip(j['timestamp'],j['indicators']['quote'][0]['close']) if c}
S=load(sys.argv[1]);V=load(sys.argv[2])
days=sorted(S);P=[S[d] for d in days];n=len(P);DIV=0.02/252;TR=[P[0]]
for i in range(1,n):TR.append(TR[-1]*P[i]/P[i-1]*(1+DIV))
pk=0;DD=[]
for p in P:pk=max(pk,p);DD.append(1-p/pk)
for H,lab in((252,'1y'),(756,'3y')):
  print('\n== forward',lab,'median % (count) since 1990')
  print(f"{'drop band':16s}{'VIX<20':>16s}{'VIX 20-30':>16s}{'VIX 30+':>16s}")
  for lo,hi,nm in((0,.10,'<10% below'),(.10,.15,'10-15%'),(.15,.20,'15-20%'),(.20,.30,'20-30%'),(.30,1,'30%+')):
    row=nm.ljust(16)
    for vl,vh in((0,20),(20,30),(30,999)):
      r=[TR[i+H]/TR[i]-1 for i in range(n-H) if days[i] in V and lo<=DD[i]<hi and vl<=V[days[i]]<vh]
      row+=(f"{st.median(r)*100:6.0f}% ({len(r):4d})" if len(r)>=40 else '      -     ').rjust(16)
    print(row)
