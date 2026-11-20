# Does tilting daily buys toward drops help? Rolling 20-year daily-DCA windows since 1950 (S&P, ~2%/yr dividends):
# ending value per $1 invested for several multiplier schedules vs flat buying. Usage: python3 tools/dca_tilt_backtest.py gspc.json
import json,sys,datetime,statistics as st,itertools
j=json.load(open(sys.argv[1]))['chart']['result'][0]
T=[];P=[]
for t,c in zip(j['timestamp'],j['indicators']['quote'][0]['close']):
    if c: T.append(t);P.append(c)
n=len(P);DIV=0.02/252;TR=[P[0]]
for i in range(1,n):TR.append(TR[-1]*P[i]/P[i-1]*(1+DIV))
pk=0;DD=[]
for p in P:pk=max(pk,p);DD.append((1-p/pk)*100)
Y=[datetime.datetime.fromtimestamp(t,datetime.UTC).year for t in T]
LINES=[10,15,20,30]
def band(dd,prev):
    b=0
    for i,l in enumerate(LINES,1):
        if dd>=l-(2 if i<=prev else 0): b=i
    return b
B=[];b=0
for d in DD: b=band(d,b); B.append(b)
starts=[Y.index(y) for y in range(1950,2007)]
H=252*20
def run(mult):
    out=[]
    for s in starts:
        e=min(n-1,s+H); units=0.0; paid=0.0
        for i in range(s,e):
            m=mult[B[i]]; paid+=m; units+=m/TR[i]
        out.append(units*TR[e]/paid)   # ending value per $1 invested
    return out
flat=run([1,1,1,1,1])
print('windows:',len(starts),' flat: median value per $1 = %.3f'%st.median(flat))
cands={'Current 1.25/1.5/1.75/2':[1,1.25,1.5,1.75,2],'Gentle 1.1/1.25/1.5/1.75':[1,1.1,1.25,1.5,1.75],
 'Deep-only 1/1.25/1.5/2':[1,1,1.25,1.5,2],'Strong 1.5/2/2.5/3':[1,1.5,2,2.5,3],'Very deep 1/1/2/3':[1,1,1,2,3]}
for nm,m in cands.items():
    r=run(m); gain=[a/b-1 for a,b in zip(r,flat)]
    print(f"{nm:28s} median +{st.median(gain)*100:.1f}% more per $1 over 20 yrs | worst {min(gain)*100:+.1f}% | better in {sum(g>0 for g in gain)}/{len(gain)} windows")
