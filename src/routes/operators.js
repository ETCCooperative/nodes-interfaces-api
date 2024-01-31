const express = require('express');
const redisClient = require('../utils/redisClient');
const config = require('../config');

const router = express.Router();

const gApiKey = process.env.G_API_KEY;
const gSpreadsheetId = process.env.G_SPREADSHEET_ID;
const gSheetName = process.env.G_SHEET_NAME;

if (!gApiKey || !gSpreadsheetId || !gSheetName) {
  throw new Error('Missing Google Sheets config');
}

const fetchGSheetData = async (env) => {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${gSpreadsheetId}/values/${gSheetName}?key=${gApiKey}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(config.operatorsRequestTimeout) });
  if (res.status === 200) {
    return await res.json();
  }

  throw new Response('No data found', { status: 404 });
};

const convertToCanonicalObjects = (data = []) => {
  if (data && data.values) {
    let [headings, ...rows] = data.values;

    // make canonical headings
    headings = headings.map((heading) => heading.toLowerCase());

    let categoryIndex = headings.indexOf('category');
    let serviceIndex = headings.indexOf('service');
    let urlIndex = headings.indexOf('url');
    let statusIndex = headings.indexOf('status');
    let publicIndex = headings.indexOf('public');
    let twitterIndex = headings.indexOf('twitter handle');
    let telegramIndex = headings.indexOf('telegram');
    let discordIndex = headings.indexOf('discord');

    return rows.reduce((acc, row) => {
      const category = row[categoryIndex];
      const service = row[serviceIndex];
      const url = row[urlIndex];
      const status = row[statusIndex];
      const public = row[publicIndex];
      const twitter = row[twitterIndex];
      const telegram = row[telegramIndex];
      const discord = row[discordIndex];

      // skip records with no category or service
      if (!category || !service) {
        return acc;
      }

      // skip records that are not public
      if (!public || public != 1) {
        return acc;
      }

      if (!acc[category]) {
        acc[category] = [];
      }
      acc[category].push({
        service,
        url,
        status: Number(status),
        twitter,
        telegram,
        discord,
      });
      return acc;
    }, {});
  }
};

/**
 * Serve node operator stats proxied by Google Spreadsheet
 * filled by ETC Cooperative
 */
router.get('/operators', async (req, res) => {
  const redisKey = 'operators';
  let operators;

  try {
    let cachedResponse = await redisClient.get(redisKey);
    if (cachedResponse) {
      operators = JSON.parse(cachedResponse);
    } else {
      operators = await fetchGSheetData();
      operators = convertToCanonicalObjects(operators);

      await redisClient.set(redisKey, JSON.stringify(operators), { EX: 60 });
    }

    res.json(operators);
  } catch (err) {
    console.error(`Error retrieving operators:`, err);
    const { statusCode = 404, body = 'Something went wrong' } = err || {};
    res.status(statusCode).send(body);
    return;
  }
});

module.exports = router;
