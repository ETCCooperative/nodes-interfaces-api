const cors = require('cors');
const axios = require('axios');
const express = require('express');
const { createClient } = require('redis');
const config = require('./config');

require('dotenv').config();

const gApiKey = process.env.G_API_KEY;
const gSpreadsheetId = process.env.G_SPREADSHEET_ID;
const gSheetName = process.env.G_SHEET_NAME;

if (!gApiKey || !gSpreadsheetId || !gSheetName) {
  throw new Error('Missing Google Sheets config');
}

const app = express();
const port = process.env.PORT || 3000;

const redisHost = process.env.REDIS_HOST || '127.0.0.1';
const redisPort = process.env.REDIS_PORT || 6379;

const redisClient = createClient({
  url: `redis://${redisHost}:${redisPort}`,
});

redisClient.on('error', (err) => console.log('Redis Client Error', err));

redisClient.connect();

// Enable CORS for all requests
app.use(cors({ origin: config.corsOrigin }));

const requestData = [
  {
    method: 'web3_clientVersion',
    jsonrpc: '2.0',
    params: [],
    id: Date.now(),
  },
  {
    method: 'eth_getBlockByNumber',
    jsonrpc: '2.0',
    params: ['latest', false],
    id: Date.now(),
  },
  {
    method: 'eth_syncing',
    jsonrpc: '2.0',
    params: [],
    id: Date.now(),
  },
];

const formatResponseData = (data) => {
  const [clientVersion = {}, { result: blockData = {} } = {}, syncing = {}] =
    data;
  return {
    clientVersion: clientVersion.result,
    syncing: syncing.result,
    blockNumber: blockData.number,
    blockHash: blockData.hash,
    totalDifficulty: blockData.totalDifficulty,
    timestamp: blockData.timestamp,
  };
};

const pollServers = async () => {
  try {
    const statsPromises = config.servers.map((url) =>
      axios.post(url, requestData)
    );
    const responses = await Promise.all(statsPromises);

    const res = [];
    responses.forEach(async (response, index) => {
      res.push(formatResponseData(response.data));
    });

    return res;
  } catch (error) {
    console.error('Error polling servers:', error);

    throw new Response('No data found', { status: 404 });
  }
};

const fetchGSheetData = async (env) => {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${gSpreadsheetId}/values/${gSheetName}?key=${gApiKey}`;

  const res = await fetch(url);
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

    return rows.reduce((acc, row) => {
      const category = row[categoryIndex];
      const service = row[serviceIndex];
      const url = row[urlIndex];
      const status = row[statusIndex];

      // skip records with no category or service
      if (!category || !service) {
        return acc;
      }

      if (!acc[category]) {
        acc[category] = [];
      }
      acc[category].push({
        service,
        url,
        status: Number(status),
      });
      return acc;
    }, {});
  }
};

/**
 * Serve node operator stats proxied by Google Spreadsheet
 * filled by ETC Cooperative
 */
app.get('/operators', async (req, res) => {
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

/**
 * Get stats from defined nodes, with regards
 * node version, latest block, syncing status, etc.
 */
app.get('/stats', async (req, res) => {
  const redisKey = 'nodeStats';
  let stats = {};

  try {
    const cachedResponse = await redisClient.get(redisKey);
    if (cachedResponse) {
      stats = JSON.parse(cachedResponse);
    } else {
      stats = await pollServers();

      await redisClient.set(redisKey, JSON.stringify(stats), { EX: 13 });
    }

    res.json(stats);
  } catch (err) {
    console.error(`Error retrieving stats:`, err);

    const { statusCode = 404, body = 'Something went wrong' } = err || {};
    res.status(statusCode).send(body);
    return;
  }
});

// Start the server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
