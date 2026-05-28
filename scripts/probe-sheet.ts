// One-off probe: confirms the service account in .localsecrets/dh2.json
// can read the access-requests Google Sheet. Delete this file after the
// backend integration is shipped.
//
// Run: npx tsx scripts/probe-sheet.ts

import { google } from 'googleapis'
import fs from 'fs'
import path from 'path'

const KEY_PATH = path.join(process.cwd(), '.localsecrets', 'dh2.json')
const SHEET_ID = '1gDwADTRdj_EeH1wqplBUC0kHgBr-a2e5nvSc5jPow7c'

async function main() {
  const credentials = JSON.parse(fs.readFileSync(KEY_PATH, 'utf-8'))
  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  })

  const sheets = google.sheets({ version: 'v4', auth })

  console.log('Service account:', credentials.client_email)
  console.log('Sheet ID:', SHEET_ID)
  console.log('Attempting to read sheet metadata...\n')

  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID })
  console.log('Sheet title:', meta.data.properties?.title)
  console.log('Tabs:', meta.data.sheets?.map(s => s.properties?.title).join(', '))

  const firstTab = meta.data.sheets?.[0]?.properties?.title
  if (firstTab) {
    console.log(`\nReading first 5 rows from "${firstTab}"...`)
    const rows = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${firstTab}!A1:J5`,
    })
    console.log('Rows:', JSON.stringify(rows.data.values, null, 2))
  }

  console.log('\nProbe succeeded — service account has read access.')
}

main().catch(err => {
  console.error('\nProbe FAILED:')
  console.error(err.message || err)
  if (err.response?.data) console.error('API response:', JSON.stringify(err.response.data, null, 2))
  process.exit(1)
})
