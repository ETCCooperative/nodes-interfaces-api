const axios = require('axios');
const express = require('express');
const APIError = require('../utils/apiError');
const redisClient = require('../utils/redisClient');
const { IPinfoWrapper } = require('node-ipinfo');
const config = require('../config');

const router = express.Router();

const peersNodeKey = 'peers';
const peersDebugNodeKey = 'peersDebug';

const IPINFO_API_TOKEN = process.env.IPINFO_API_TOKEN;

if (!IPINFO_API_TOKEN) {
  throw new Error('Missing IPINFO_API_TOKEN');
}

if (
  config.stalePeerRefreshThresholdInSeconds >=
  config.stalePeerDeleteThresholdInSeconds
) {
  throw new Error(
    'Check config, `stalePeerRefreshThresholdInSeconds` must be smaller than `stalePeerDeleteThresholdInSeconds`'
  );
}

const ipinfoWrapper = new IPinfoWrapper(IPINFO_API_TOKEN);

// Example node response:
//
// [
//   {
//     "enode": "enode://9e3cc690a3d3ccfd5c9229fea53107f46631a4456e55c5bd849e72e50e10b4fbffa81063e8174b57285b199ac71abb9063ef391199abfc2c86d64c6dfa001402@174.92.149.225:51650",
//     "id": "197abd552b6817a499f85e46b70c5eed9cdf7aeed977a383f18965c42e6062ec",
//     "name": "CoreGeth/ETCMCgethNode/v1.12.10-stable-4d217763/windows-amd64/go1.18.5",
//     "caps": [
//         "eth/66",
//         "eth/67",
//         "snap/1"
//     ],
//     "network": {
//         "localAddress": "159.203.56.33:30369",
//         "remoteAddress": "174.92.149.225:51650",
//         "inbound": true,
//         "trusted": false,
//         "static": false
//     },
//     "protocols": {
//         "eth": {
//             "difficulty": 7.301447234719e+21,
//             "forkId": {
//                 "hash": "0x7fd1bb25",
//                 "next": 0
//             },
//             "head": "0x4ad28ce4344bbb39c64ca36ff21c8291fb8a78044730a92052f99e5718fd2ad7",
//             "version": 67
//         },
//         "snap": {
//             "version": 1
//         }
//     },
//     "ip_info": {
//         "ip": "174.92.149.225",
//         "hostname": "bras-base-sconpq1802w-grc-04-174-92-149-225.dsl.bell.ca",
//         "city": "Saint-Constant",
//         "region": "Quebec",
//         "country": "CA",
//         "country_name": "Canada",
//         "loc": "45.3668,-73.5659",
//         "org": "AS577 Bell Canada",
//         "postal": "J5A",
//         "timezone": "America/Toronto"
//     },
//     "contact": {
//         "first": {
//             "unix": 1700640068,
//             "rfc3339": "2023-11-22T08:01:08Z"
//         },
//         "last": {
//             "unix": 1700643661,
//             "rfc3339": "2023-11-22T09:01:01Z"
//         },
//         "refresh": {
//             "unix": 1700640068,
//             "rfc3339": "2023-11-22T08:01:08Z"
//         }
//     }
//   }
// ]

// This will be used to generate unique ids for peers
let jsonRpcId = 1;

// Generate unique id for peer
const generatePeerId = () => {
  if (jsonRpcId >= Number.MAX_SAFE_INTEGER) {
    jsonRpcId = 1;
  }
  return jsonRpcId++;
};

const getEnodeFromNodeUrl = (url) => {
  return url.substring(8).split('@')[0];
};

const augmentWithIPInfo = async (ip) => {
  const redisKey = `ipInfo.${ip}`;
  let ipInfo = await redisClient.get(redisKey);
  if (ipInfo) {
    ipInfo = JSON.parse(ipInfo);
  } else {
    try {
      ipInfo = await ipinfoWrapper.lookupIp(ip);
      await redisClient.set(redisKey, JSON.stringify(ipInfo), {
        EX: 2 * 60 * 60 * 24, // 2 days
      });
    } catch (err) {
      console.error(`Error retrieving IP info:`, err);
      return {};
    }
  }
  return ipInfo;
};

const setContactToNowFor = (key, peer = {}) => {
  if (!key || !peer || !peer.contact || !peer.contact[key]) {
    return peer;
  }

  const now = new Date();
  const contactNow = {
    unix: Math.floor(now / 1000),
    rfc3339: now.toISOString(),
  };

  peer.contact[key] = contactNow;

  return peer;
};

const getInitialContactInfoForNow = () => {
  const now = new Date();
  const contactNow = {
    unix: Math.floor(now / 1000),
    rfc3339: now.toISOString(),
  };

  return {
    first: contactNow,
    last: contactNow,
    refresh: contactNow,
  };
};

// Checks if peer is stale and should be refreshed at the node
const shouldRefreshPeer = (peer) => {
  const { refresh: { unix: lastRefreshUnix = 0 } = {} } = peer.contact;
  const now = Math.floor(new Date() / 1000);
  const diff = now - lastRefreshUnix;

  return diff > config.stalePeerRefreshThresholdInSeconds;
};

// Checks if peer is stale and should be deleted from the cache
const shouldDeletePeer = (peer) => {
  const { last: { unix: lastUnix = 0 } = {} } = peer.contact;
  const now = Math.floor(new Date() / 1000);
  const diff = now - lastUnix;

  return diff > config.stalePeerDeleteThresholdInSeconds;
};

const chunkArray = (array, chunkSize) => {
  const chunks = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
};

const validateRemovePeerResponse = (response) => {
  let {
    config: { url = '', data: requestData = {} } = {},
    status,
    data: { result, error } = {},
  } = response;

  if (status !== 200 || !result || error) {
    requestData = JSON.parse(requestData);
    let { method, params: [enode = ''] = [] } = requestData;

    enode = getEnodeFromNodeUrl(enode);

    throw new Error(`Failed to "${method}" for enode "${enode}"`);
  }
};

const requestNodeToRefreshPeer = async (
  enode,
  [serverUrl, serverOpts = {}]
) => {
  try {
    const resRemovePeer = await axios.post(
      serverUrl,
      {
        method: 'admin_removePeer',
        jsonrpc: '2.0',
        params: [enode],
        id: generatePeerId(),
      },
      { ...serverOpts, timeout: config.peerRefreshRequestTimeoutInMillies }
    );

    validateRemovePeerResponse(resRemovePeer);
  } catch (err) {
    console.debug(
      `Error for "admin_removePeer", enode "${enode}" at "${serverUrl}":`,
      err.message
    );

    throw new Error(`Failed to "admin_removePeer" for enode "${enode}"`);
  }

  // Sleep for 1 second
  await new Promise((resolve) => setTimeout(resolve, 1000));

  try {
    const resAddPeer = await axios.post(
      serverUrl,
      {
        method: 'admin_addPeer',
        jsonrpc: '2.0',
        params: [enode],
        id: generatePeerId(),
      },
      { ...serverOpts, timeout: config.peerRefreshRequestTimeoutInMillies }
    );

    validateRemovePeerResponse(resAddPeer);
  } catch (err) {
    console.debug(
      `Error for "admin_addPeer", enode "${enode}" at "${serverUrl}":`,
      err.message
    );
    throw new Error(`Failed to "admin_addPeer" for enode "${enode}"`);
  }
};

const updatePeers = async () => {
  let peers = {
    //[id]: {
    //   id : '123',
    //   ...peerInfo,
    //   ip_info: {},
    //   contact: {},
    // }
  };

  // Load anterior peers
  let cachedPeers = await redisClient.get(peersNodeKey);
  if (cachedPeers) {
    peers = JSON.parse(cachedPeers);
  }

  let peerDebugInfo = await redisClient.get(peersDebugNodeKey);
  if (peerDebugInfo) {
    peerDebugInfo = JSON.parse(peerDebugInfo);
  } else {
    peerDebugInfo = {
      // [enode]: {
      //   keep where we found this peer,
      //   we don't have to know all of them, just the last one is fine
      //   bootnode: 'https://...',
      // }
    };
  }

  const requestData = {
    method: 'admin_peers',
    jsonrpc: '2.0',
    params: [],
    id: generatePeerId(),
  };

  const initialContactInfo = getInitialContactInfoForNow();

  // 1. Collect all the peers from nodes
  try {
    const statsPromises = config.peerServers.map(([url, opts = {}]) =>
      axios.post(url, requestData, { ...opts, timeout: 60000 })
    );
    const responses = await Promise.allSettled(statsPromises);

    responses.forEach(async (response, idx) => {
      if (response.status !== 'fulfilled' || !response.value) {
        const {
          config: { url = '' } = {},
          message = '',
        } = response.reason;
        console.error(`Error fetching peers from "${url}": ${message}`);
        return;
      }

      const { data = {} } = response.value;
      let { result = [] } = data;

      // special handling for peers.etccore.in
      // TODO: remove this once we add proxy for rottor.fun
      if (config.peerServers[idx][0].includes('peers.etccore.in')) {
        result = data;
      }

      if (typeof result !== 'object' || !Array.isArray(result)) {
        console.log(typeof result);
        console.log(result);
      }

      console.log(
        'Fetched',
        result.length,
        'peers from',
        config.peerServers[idx][0]
      );

      // 2. Merge peers
      peers = result.reduce((acc, peerInfo) => {
        const {
          enode: nodeUrl = '',
          protocols: { eth: protoEth, snap: protoSnap } = {},
        } = peerInfo;

        // skip peers that are on handshake
        if (protoEth === 'handshake' || protoSnap === 'handshake') {
          return acc;
        }

        const peerId = getEnodeFromNodeUrl(nodeUrl);
        let peer = {
          contact: initialContactInfo, // this will be overwritten if set in cache
          ...peers[peerId],
          ...peerInfo,
        };

        peer = setContactToNowFor('last', peer);

        acc[peerId] = peer;

        // Keep some debug info
        peerDebugInfo[peerId] = {
          ...(peerDebugInfo[peerId] || {}),
          bootnode: config.peerServers[idx],
        };
        return acc;
      }, peers);
    });
  } catch (error) {
    const {
      config: { url = '' } = {},
      response: { status = 500 },
      message = '',
    } = error;
    console.error(`Error fetching peers from nodes: ${message} for ${url}`);
    throw new APIError('No data found', status);
  }

  const peersToBeRefreshed = [];

  // 3. Augment with IP and contact info
  for await (const peerId of Object.keys(peers)) {
    // 4. Augment with IP info
    if (
      typeof peers[peerId].ip_info !== 'object' ||
      Object.keys(peers[peerId].ip_info).length === 0
    ) {
      const { network: { remoteAddress = '' } = {} } = peers[peerId];
      const remoteIp = remoteAddress.split(':')[0];
      // TODO: enable on live
      // peers[peerId].ip_info = await augmentWithIPInfo(remoteIp);
      peers[peerId].ip_info = {
        ip: '174.92.149.225',
        hostname: 'bras-base-sconpq1802w-grc-04-174-92-149-225.dsl.bell.ca',
        city: 'Saint-Constant',
        region: 'Quebec',
        country: 'CA',
        country_name: 'Canada',
        loc: '45.3668,-73.5659',
        org: 'AS577 Bell Canada',
        postal: 'J5A',
        timezone: 'America/Toronto',
      };
    }

    // Ask node to refresh peer if it's stale
    // NOTE: check peerDebugInfo, as if we don't know the bootnode, we can't refresh it
    if (
      peersToBeRefreshed.length < config.maxPeersToBeRefreshed &&
      shouldRefreshPeer(peers[peerId]) &&
      peerDebugInfo[peerId] &&
      peerDebugInfo[peerId].bootnode &&
      !peerDebugInfo[peerId].bootnode[0].includes('peers.etccore.in') // TODO: remove this
    ) {
      // push to peersToBeRefreshed so as we run them on parallel
      peersToBeRefreshed.push(peerId);
    }

    // Delete peer if it's stale for longer from cache
    if (shouldDeletePeer(peers[peerId]) &&
      !peersToBeRefreshed.includes(peerId)
    ) {
      delete peers[peerId];
      delete peerDebugInfo[peerId];

      console.debug(`Deleted stale peer ${peerId}`);
    }
  }

  // 5. Update cache, before refreshing peers
  await redisClient.set(peersNodeKey, JSON.stringify(peers));
  await redisClient.set(peersDebugNodeKey, JSON.stringify(peerDebugInfo));

  // 6. Refresh peers
  if (peersToBeRefreshed.length > 0) {
    console.info(
      `Starting parallel calls for refreshing ${peersToBeRefreshed.length} peers in batches of ${config.peerRefreshBatchSize}`
    );

    const peerBatches = chunkArray(peersToBeRefreshed, config.peerRefreshBatchSize);

    let fullfilled = 0;
    let rejected = 0;

    for await (const [idx, batch] of peerBatches.entries()) {
      console.info(`Refreshing batch ${idx}`);

      const refreshPromises = batch.map((peerId) => {
        return requestNodeToRefreshPeer(
          peers[peerId].enode,
          peerDebugInfo[peerId].bootnode
        ).then(() => {
          peers[peerId] = setContactToNowFor('refresh', peers[peerId]);
        });
      });

      try {
        const responses = await Promise.allSettled(refreshPromises);

        responses.forEach((response) => {
          if (response.status === 'fulfilled') {
            fullfilled++;
          } else {
            rejected++;
          }
        });
      } catch (err) {
        console.error(`Error refreshing peers in batch ${idx}:`, err);
      }
    }

    console.log(
      `Refreshed ${fullfilled} peers, failed to refresh ${rejected} peers`
    );

    // 7. Update cache, after refreshing peers
    await redisClient.set(peersNodeKey, JSON.stringify(peers));
    await redisClient.set(peersDebugNodeKey, JSON.stringify(peerDebugInfo));
  }


  console.log(`Updated ${Object.keys(peers).length} peers`);

  return peers;
};

router.get('/peers', async (req, res) => {
  try {
    let peers;
    let cachedPeers = await redisClient.get(peersNodeKey);
    if (cachedPeers) {
      peers = JSON.parse(cachedPeers);
    } else {
      peers = await updatePeers();
    }

    res.json(Object.values(peers));
  } catch (err) {
    console.error(`Error retrieving peers:`, err);
    return res.status(500).json({});
  }
});

// Auto update peers
(async () => {
  try {
    await updatePeers();
    setInterval(
      async () => await updatePeers(),
      config.peersAutoUpdateIntervalInMillies
    );
  } catch (err) {
    if (err instanceof APIError) {
      const { message = '', statusCode } = err;
      console.error(`Error updating peers (${statusCode}): ${message}`);
      return;
    }
    console.error(`Error updating peers:`, err);
  }
})();

module.exports = router;
