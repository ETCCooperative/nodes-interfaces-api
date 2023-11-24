const axios = require('axios');
const express = require('express');
const redisClient = require('../utils/redisClient');
const config = require('../config');

const router = express.Router();

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
    const statsPromises = config.liveStatsServers.map((url) =>
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

/**
 * Get stats from defined nodes, with regards
 * node version, latest block, syncing status, etc.
 */
router.get('/stats', async (req, res) => {
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

module.exports = router;
