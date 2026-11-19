# My Portfolio

A simple, Betterment-style page for a VTI + VXUS + cash portfolio.

- **Holdings:** enter your VTI and VXUS share counts; live prices give the value. Enter your cash balance and its APY (change the APY any time).
- **Target mix:** pick your stocks/cash split and your US/international split.
- **Got new money?** Type an amount and it tells you how much to put in VTI, VXUS and cash to move toward your target without selling. "I did it" adds the shares and cash to your holdings.
- **Projected value:** 5, 10, 15 and 20 years out, with expected, poor-market and strong-market outcomes.

Your numbers are saved in your browser only.

## Run it

```bash
npm start
```

Then open http://localhost:3000. Needs Node 18 or newer, no packages to install. The server serves the page and `/api/quotes`, which fetches VTI and VXUS prices from Yahoo Finance (Stooq as backup), cached for 60 seconds.

Deploys as-is to Railway, Render or any Node host (`PORT` is read from the environment).

## How the projection works

Monte Carlo simulation, like Betterment and Vanguard use:

- 5,000 simulated markets, monthly steps, 20 years.
- VTI and VXUS grow at the chosen outlook's yearly return (Cautious, Moderate, Historical) with about 16% and 17% yearly volatility and 0.85 correlation. Fund fees are subtracted.
- Cash grows at your APY. Monthly additions go in at your target mix; the portfolio is rebalanced to target yearly.
- Expected is the median; poor and strong markets are the 10th and 90th percentiles.

Estimates only. Taxes not included. Not financial advice.
