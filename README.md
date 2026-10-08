# Rep Account Review

Single-page tool. Upload a rep's sales pivot and Call Log export, and get regional trends plus a next-visit talking plan for every account.

All processing happens in the browser. Data is stored only when you click **Save this rep**, in Netlify Blobs behind an access code. If the save service is not set up, it is stored in that browser instead.

## Inputs
**Sales.** Load one or more files. The app identifies each one by its layout:
- **ERP Sales by Customer report.** Load this year's period and last year's matching period together to compare them. With a single file you get sales and margin, but no growth numbers. The report is company-wide, so scope it to one rep: paste the rep's account list, or leave "Only accounts in the call log" checked.
- **Account growth table.** A Customer column plus two year columns, such as "YTD 2025 (Jan-Sep)" and "YTD 2026 (Jan-Sep)". Margin % is picked up if the table has it. The Clarke Haas growth workbook is this format.
- **Monthly pivot.** Customer rows, one column per month, and a Route column, which is used for regions. Once the pivot includes last year's matching months, the comparison switches to true YTD vs prior YTD.

**Call log** (.xlsx, optional): the export from the Quote Follow-Up & Call Log app.

## Deploy (with saved reps)
1. Push this folder to a private GitHub repo, for example `aldora-rep-account-review`.
2. In Netlify, choose Add new site, then Import from Git, then pick the repo. `netlify.toml` already sets the publish folder and the functions folder. Netlify installs `@netlify/blobs` on its own.
3. In Site configuration, then Environment variables, add `ACCESS_CODE` with a code of your choosing. Redeploy.
4. Open the site. It asks for the access code once per browser.

A drag-and-drop deploy does not include the save function. The app still works, but saved reps stay in that one browser.

## Saved reps
- **Save this rep** stores the loaded sales files, call log, settings, account list, and name links under the rep's name.
- Pick a rep from **Saved reps** to reload them. The review rebuilds automatically.
- To update a rep: pick them, load the new files, click Build review, then Save this rep. That replaces the old version. New call logs and growth files replace the old ones. A Sales by Customer report replaces the old one only if the date range is the same; otherwise it is added, and the two most recent periods are compared.
- **Delete** asks for a second click.

## Files
- `index.html`: the app
- `netlify/functions/reps.mjs`: save, load, list, and delete endpoint at `/api/reps` (Netlify Blobs store `rep-reviews`)
- `netlify.toml`, `package.json`: Netlify config

## Rules the app uses
- Region: the zone code and name from the first usable route segment. NULL, Will Call, and ORL Special are skipped. Files without a route column show as a single "All accounts" group.
- Margin flag: a Tier A/B account more than 10 points below the book's weighted margin gets a pricing review note.
- Trend: Up or Down past the trend band (default ±10%). New means no prior sales. Lost means no current-year sales.
- Tier: A at $75k YTD or more, B at $25k or more, C below that. All three thresholds can be changed in the app.
- Priority 1: Tier A/B and down, $50k+ a year at risk, a billing, credit, or quality problem in the notes, or flagged for immediate attention.
- Priority 2: Tier A/B and growing, or an open follow-up or issue in the notes.
- Priority 3: everything else.
- Name matching between the call log and the sales list is fuzzy. Unmatched names can be linked manually on the Summary tab, and the links are saved in that browser.
