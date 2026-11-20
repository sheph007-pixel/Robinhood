# How a dollar invested at different S&P 500 drawdown levels grew over the next 3 and 5 years (used to size the
# daily-buy boosts in Buy Alerts). Usage: python3 tools/dip_forward_returns.py gspc.json  (see dip_backtest.py for the download)
import json,sys,statistics as st,datetime
j=json.load(open(sys.argv[1]))['chart']['result'][0]
T=[];P=[]
for t,c in zip(j['timestamp'],j['indicators']['quote'][0]['close']):
    if c: T.append(t);P.append(c)
n=len(P);DIV=0.02/252;TR=[P[0]]
for i in range(1,n): TR.append(TR[-1]*P[i]/P[i-1]*(1+DIV))
pk=0;DD=[]
for p in P: pk=max(pk,p);DD.append(1-p/pk)
yr=[datetime.datetime.fromtimestamp(t,datetime.UTC).year for t in T]
for start in (1928,1950):
  print('since',start)
  for H,lab in ((756,'3y'),(1260,'5y')):
    def b(lo,hi):
      r=[TR[i+H]/TR[i]-1 for i in range(n-H) if yr[i]>=start and lo<=DD[i]<hi]
      return (st.mean(r)*100,st.median(r)*100,len(r)) if r else None
    rows=[('any day',0,1),('within 10% of high',0,.10),('10-20% below',.10,.20),('20-30% below',.20,.30),('30%+ below',.30,1)]
    print(' ',lab,' | '.join(f"{nm}: avg {v[0]:.0f}% med {v[1]:.0f}%" for nm,lo,hi in rows for v in [b(lo,hi)] if v))
